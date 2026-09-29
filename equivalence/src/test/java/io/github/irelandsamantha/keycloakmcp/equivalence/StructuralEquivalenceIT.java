package io.github.irelandsamantha.keycloakmcp.equivalence;

import io.github.irelandsamantha.keycloakmcp.equivalence.compare.Divergence;
import io.github.irelandsamantha.keycloakmcp.equivalence.compare.DocumentedDivergences;
import io.github.irelandsamantha.keycloakmcp.equivalence.fixtures.PathValues;
import io.github.irelandsamantha.keycloakmcp.equivalence.fixtures.ProbeBodies;
import io.github.irelandsamantha.keycloakmcp.equivalence.fixtures.RealmSeeder;
import io.github.irelandsamantha.keycloakmcp.equivalence.fixtures.SeededRealm;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.EquivalenceEnvironment;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.McpCatalogSnapshot;
import io.github.irelandsamantha.keycloakmcp.equivalence.oracle.RouteProbe;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.McpCatalog;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.OpView;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.ReferenceSurface;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.SurfaceDiff;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.CatalogOp;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.junit.jupiter.api.extension.ExtendWith;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.SortedMap;
import java.util.SortedSet;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Structural equivalence of keycloak-mcp with Keycloak HEAD.
 * <ul>
 *   <li><b>S1</b> keycloak-mcp's catalog, read through its own MCP tools, lists exactly the reference operations
 *       (HEAD OpenAPI ∪ admin client) and describes each one as its source does (the catalog is a digest; only
 *       documented corrections may differ).</li>
 *   <li><b>S2</b> the catalog declares every path variable exactly once, and the two structural oracles agree on
 *       query parameters, form fields and media types, modulo documented divergences. With S1 this makes catalog,
 *       OpenAPI and adapter agree transitively.</li>
 *   <li><b>S3</b> the live server routes every operation of the catalog and the reference surface in a seeded realm
 *       (a specific error counts only if the same request one segment deeper does not get it too, see
 *       {@link RouteProbe}), or the operation is documented as provider/feature-gated.</li>
 * </ul>
 * Drift fails with the precise difference; every verdict lands in the ledger.
 */
@ExtendWith(EquivalenceExtension.class)
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class StructuralEquivalenceIT {

    private static final String REGENERATE = "npm run catalog:update && mvn -f equivalence/pom.xml -Psupplement";
    private static final String CATALOG = "catalog";

    private static EquivalenceEnvironment env;
    private static ReferenceSurface reference;
    private static McpCatalogSnapshot snapshot;
    private static Map<String, OpView> catalog;
    private static List<CatalogOp> catalogOps;
    private static DocumentedDivergences divergences;

    @BeforeAll
    static void load(EquivalenceEnvironment environment) throws Exception {
        env = environment;
        reference = env.reference();
        snapshot = env.catalog();
        catalogOps = McpCatalog.parse(snapshot.operations());
        catalog = OpView.fromCatalog(catalogOps);
        divergences = DocumentedDivergences.load();
        System.out.printf("reference: %d operations (HEAD OpenAPI %d from %s, admin client %d); catalog '%s': %d operations from %s%n",
                reference.keys().size(), reference.openApi().size(), env.headOpenApi().source(),
                reference.adminClient().size(), snapshot.version(), catalog.size(), snapshot.source());
    }

    @AfterAll
    static void writeLedger() throws Exception {
        env.writeLedger();
    }

    @Test
    @Order(1)
    void s1CatalogListsExactlyTheReferenceOperations() {
        SortedSet<String> missing = new TreeSet<>(reference.keys());
        missing.removeAll(catalog.keySet());
        SortedSet<String> extra = new TreeSet<>(catalog.keySet());
        extra.removeAll(reference.keys());
        for (String key : reference.keys()) {
            boolean listed = catalog.containsKey(key);
            env.ledger().record(key, "S1:listed", listed ? "LISTED" : "MISSING", listed, null);
        }
        extra.forEach(key -> env.ledger().catalogOnly(named(catalog.get(key))));

        List<String> missingDocumented = missing.stream().filter(k -> reference.openApi().containsKey(k)).map(this::namedReference).toList();
        List<String> missingAdminClientOnly = missing.stream().filter(k -> !reference.openApi().containsKey(k)).map(this::namedReference).toList();
        assertTrue(missing.isEmpty() && extra.isEmpty(), () -> "S1 catalog drift: keycloak-mcp catalog '" + snapshot.version()
                + "' (" + snapshot.source() + ", sha256 " + snapshot.sourceSha256() + ") vs reference surface (HEAD OpenAPI "
                + env.headOpenApi().sha256() + " + admin client):\n"
                + section("missing HEAD OpenAPI operations", missingDocumented)
                + section("missing admin-client-only operations (belong in data/admin-client-supplement-nightly.json)", missingAdminClientOnly)
                + section("catalog operations no oracle defines", extra.stream().map(k -> named(catalog.get(k))).toList())
                + "Regenerate: " + REGENERATE);
    }

    @Test
    @Order(2)
    void s1CatalogDescribesEachOperationAsItsSourceDoes() {
        Map<String, OpView> documented = subset(catalog, reference.openApi().keySet());
        Map<String, OpView> adminClientOnly = subset(catalog, reference.keys().stream()
                .filter(k -> !reference.openApi().containsKey(k)).collect(Collectors.toSet()));
        SurfaceDiff.Result vsOpenApi = SurfaceDiff.compare(CATALOG, documented, ReferenceSurface.OPENAPI,
                subset(reference.openApi(), documented.keySet()));
        SurfaceDiff.Result vsAdminClient = SurfaceDiff.compare(CATALOG, adminClientOnly, ReferenceSurface.ADMIN_CLIENT,
                subset(reference.adminClient(), adminClientOnly.keySet()));
        List<Divergence> observed = new ArrayList<>(Divergence.fromDiff(vsOpenApi, documented));
        observed.addAll(Divergence.namesFromDiff(vsOpenApi, documented));
        observed.addAll(Divergence.fromDiff(vsAdminClient, adminClientOnly));

        DocumentedDivergences.Assessment a = divergences.assess(observed, e -> e.sources().startsWith(CATALOG + "~"));
        recordPerOperation("S1:described", catalog.keySet(), a, "AS_SOURCE");
        assertTrue(a.clean(), () -> "S1 catalog description drift (catalog '" + snapshot.version() + "' vs its sources):\n"
                + assessmentReport(a) + "Regenerate: " + REGENERATE
                + "; a deliberate catalog correction needs a divergences.json entry instead");
    }

    @Test
    @Order(3)
    void s2CatalogDeclaresEachPathVariableOnce() {
        DocumentedDivergences.Assessment a = divergences.assess(Divergence.pathDeclarations(CATALOG, catalogOps),
                e -> e.sources().equals(CATALOG));
        recordPerOperation("S2:declared", catalog.keySet(), a, "CONSISTENT");
        assertTrue(a.clean(), () -> "S2 catalog path-parameter declarations disagree with their templates:\n" + assessmentReport(a));
    }

    @Test
    @Order(4)
    void s2OraclesAgreeOnParametersAndMediaTypes() {
        SurfaceDiff.Result diff = SurfaceDiff.compare(ReferenceSurface.OPENAPI, reference.openApi(),
                ReferenceSurface.ADMIN_CLIENT, reference.adminClient());
        DocumentedDivergences.Assessment a = divergences.assess(Divergence.fromDiff(diff, reference.openApi()),
                e -> e.sources().equals(ReferenceSurface.OPENAPI + "~" + ReferenceSurface.ADMIN_CLIENT));
        Set<String> both = new TreeSet<>(reference.openApi().keySet());
        both.retainAll(reference.adminClient().keySet());
        recordPerOperation("S2:agreed", both, a, "AGREE");
        System.out.printf("S2: %d operations in both oracles, %d documented divergences, %d path-variable name differences (names are not compared)%n",
                both.size(), a.documented().size(), diff.pathParamNameDiffs().size());
        assertTrue(a.clean(), () -> "S2 oracle disagreement (HEAD OpenAPI vs admin client):\n" + assessmentReport(a));
    }

    @Test
    @Order(5)
    void s3LiveServerRoutesEveryOperation() throws Exception {
        List<RouteProbe.Target> targets = new ArrayList<>();
        Set<String> keys = new TreeSet<>(reference.keys());
        keys.addAll(catalog.keySet());
        for (String key : keys) {
            OpView shown = Optional.ofNullable(catalog.get(key)).orElseGet(() -> reference.primary(key));
            Set<String> consumes = new TreeSet<>();
            for (Map<String, OpView> source : List.of(catalog, reference.openApi(), reference.adminClient())) {
                Optional.ofNullable(source.get(key)).ifPresent(op -> consumes.addAll(op.consumes()));
            }
            targets.add(new RouteProbe.Target(key, shown.method(), shown.path(), consumes));
        }
        List<RouteProbe.Result> results;
        List<String> seedingLog;
        try (SeededRealm realm = new RealmSeeder(env.adminClient()).seed("equivalence-s3-" + System.currentTimeMillis())) {
            seedingLog = realm.log();
            results = new RouteProbe(env.http()::send, new PathValues(realm)::valuesFor, ProbeBodies.forRealm(realm))
                    .probe(targets);
        }

        List<Divergence> unrouted = new ArrayList<>();
        Map<String, RouteProbe.Result> byKey = new LinkedHashMap<>();
        for (RouteProbe.Result r : results) {
            byKey.put(r.key(), r);
            if (r.verdict() != RouteProbe.Verdict.ROUTED) {
                SortedMap<String, SortedSet<String>> seen = new TreeMap<>();
                seen.put("server", new TreeSet<>(List.of(r.verdict() + " " + r.status() + " " + r.response())));
                unrouted.add(new Divergence(r.key(), r.template(), "route", "server", seen));
            }
        }
        // Route entries are never stale: enabling a feature legitimately lifts a gate.
        DocumentedDivergences.Assessment a = divergences.assess(unrouted, e -> e.kind().equals("route"));
        for (RouteProbe.Result r : results) {
            if (env.ledger().isReference(r.key())) {
                Optional<DocumentedDivergences.Entry> gate = a.documented().entrySet().stream()
                        .filter(e -> e.getKey().key().equals(r.key())).map(Map.Entry::getValue).findFirst();
                String outcome = r.verdict() == RouteProbe.Verdict.ROUTED ? "ROUTED"
                        : gate.map(e -> "GATED_DOCUMENTED").orElse("NOT_ROUTED_" + r.verdict());
                env.ledger().record(r.key(), "S3:routed", outcome, r.verdict() == RouteProbe.Verdict.ROUTED || gate.isPresent(),
                        r.status() + " " + gate.map(DocumentedDivergences.Entry::ref)
                                .orElse(r.sent() + (r.control() == null ? "" : "; control " + r.control())));
            }
        }
        System.out.printf("S3: %d operations probed in a seeded realm: %s; seeding failures: %s; documented gates now routed: %s%n",
                results.size(), results.stream().collect(Collectors.groupingBy(
                        r -> r.verdict() + (r.verdict() == RouteProbe.Verdict.ROUTED ? "" : "(" + r.status() + ")"),
                        TreeMap::new, Collectors.counting())), seedingLog,
                a.stale().stream().map(DocumentedDivergences.Entry::key).toList());
        assertTrue(a.undocumented().isEmpty(), () -> "S3 operations without proof of routing: the generic JAX-RS miss "
                + RouteProbe.GENERIC_MISS_BODY + ", 405 or an auth failure, or INCONCLUSIVE (the same request one segment"
                + " deeper, .../" + RouteProbe.CONTROL_SEGMENT + ", got the same answer, so a locator on the path answered:"
                + " seed the entity it looks up or document the gate), and no divergences.json entry explains:\n"
                + a.undocumented().stream().map(d -> "  " + d.namedKey() + " values=" + byKey.get(d.key()).pathValues()
                        + " -> " + d.observed().get("server").first()).collect(Collectors.joining("\n"))
                + "\nSeeding failures: " + seedingLog + "\n" + skeletons(a.undocumented()));
    }

    private static void recordPerOperation(String check, Collection<String> keys, DocumentedDivergences.Assessment a, String clean) {
        Map<String, List<String>> documented = new TreeMap<>();
        a.documented().forEach((d, e) -> documented.computeIfAbsent(d.key(), k -> new ArrayList<>()).add(e.ref()));
        Set<String> undocumented = a.undocumented().stream().map(Divergence::key).collect(Collectors.toSet());
        for (String key : keys) {
            if (!env.ledger().isReference(key)) {
                continue;
            }
            String outcome = undocumented.contains(key) ? "UNDOCUMENTED_DIVERGENCE"
                    : documented.containsKey(key) ? "DIVERGENT_DOCUMENTED" : clean;
            env.ledger().record(key, check, outcome, !undocumented.contains(key),
                    documented.containsKey(key) ? String.join("; ", documented.get(key)) : null);
        }
    }

    private static String assessmentReport(DocumentedDivergences.Assessment a) {
        return section("undocumented", a.undocumented().stream().map(Divergence::toString).toList())
                + section("stale divergences.json entries (no longer observed; remove or update)",
                a.stale().stream().map(DocumentedDivergences.Entry::ref).toList())
                + skeletons(a.undocumented());
    }

    private static String skeletons(List<Divergence> undocumented) {
        return undocumented.isEmpty() ? "" : "If legitimate, document in src/test/resources/divergences.json:\n"
                + undocumented.stream().map(DocumentedDivergences::skeleton).collect(Collectors.joining(",\n")) + "\n";
    }

    private static String section(String title, List<String> lines) {
        return lines.isEmpty() ? "" : "  " + title + " (" + lines.size() + "):\n"
                + lines.stream().map(l -> "    " + l).collect(Collectors.joining("\n")) + "\n";
    }

    private static Map<String, OpView> subset(Map<String, OpView> ops, Set<String> keys) {
        Map<String, OpView> out = new TreeMap<>();
        ops.forEach((k, v) -> {
            if (keys.contains(k)) {
                out.put(k, v);
            }
        });
        return out;
    }

    private String namedReference(String key) {
        return named(reference.primary(key));
    }

    private static String named(OpView op) {
        return op.method() + " " + op.path();
    }
}
