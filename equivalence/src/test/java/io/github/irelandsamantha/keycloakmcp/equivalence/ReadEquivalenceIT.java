package io.github.irelandsamantha.keycloakmcp.equivalence;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.compare.DocumentedDivergences;
import io.github.irelandsamantha.keycloakmcp.equivalence.compare.KnownLag;
import io.github.irelandsamantha.keycloakmcp.equivalence.compare.Observation;
import io.github.irelandsamantha.keycloakmcp.equivalence.compare.ReadComparison;
import io.github.irelandsamantha.keycloakmcp.equivalence.compare.ReadJudge;
import io.github.irelandsamantha.keycloakmcp.equivalence.compare.Volatility;
import io.github.irelandsamantha.keycloakmcp.equivalence.fixtures.PathValues;
import io.github.irelandsamantha.keycloakmcp.equivalence.fixtures.ReadRequest;
import io.github.irelandsamantha.keycloakmcp.equivalence.fixtures.ReadRequests;
import io.github.irelandsamantha.keycloakmcp.equivalence.fixtures.SeededRealm;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.EquivalenceEnvironment;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpPair;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpReads;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpReads.Classification;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.RawHttp;
import io.github.irelandsamantha.keycloakmcp.equivalence.ledger.EquivalenceLedger.Check;
import io.github.irelandsamantha.keycloakmcp.equivalence.ledger.Verdict;
import io.github.irelandsamantha.keycloakmcp.equivalence.oracle.AdminClientOracle;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.OpView;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.PathTemplates;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.ReferenceSurface;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.Endpoint;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.ParamSpec;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;
import org.junit.jupiter.api.extension.ExtendWith;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import java.util.function.UnaryOperator;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;
import static org.junit.jupiter.api.DynamicTest.dynamicTest;

/**
 * F1 read equivalence: every read of the reference surface (HEAD OpenAPI ∪ admin client) — every GET, and every
 * other operation keycloak-mcp itself classifies as read-only — gives the same answer through keycloak-mcp's
 * {@code keycloak_read} (sensitive reads allowed) as over raw HTTP with the same service-account token and
 * {@code Accept}: status, content class and value, with only key order tolerated. Where the admin client has the
 * operation, its typed result must match raw HTTP too, modulo the dated {@code admin-client-known-lag.json}.
 *
 * <p>Every read is sent raw to the live server, so what counts as a read fails closed. A GET or HEAD the catalog
 * lacks is a read by its method. A catalog operation is what keycloak-mcp's dry run says it is
 * ({@link KeycloakMcpReads#classify}): a read, or a mutation, recorded as out of scope for F2. Any other answer fails
 * the operation's test as {@value #CLASSIFICATION_UNKNOWN} without sending anything, and the factory sends nothing
 * at all unless a known mutation and a known read still classify as such. keycloak-mcp refuses every operation without
 * {@code {realm}} unless realm administration is on, so those alone are classified and read by a second process
 * that has it ({@link KeycloakMcpPair}).
 *
 * <p>Reads run in one seeded realm. A read the server refuses there is {@code ROUTED_ONLY} only when
 * {@code divergences.json} documents the refusal as a feature or provider gate. Every verdict lands in the ledger.
 */
@ExtendWith(EquivalenceExtension.class)
class ReadEquivalenceIT {

    /** Sandwiches read before giving up on an unstable reference. */
    private static final int ATTEMPTS = 3;

    /** F1 outcome of a catalog operation keycloak-mcp neither accepts as a read nor refuses as a mutation. */
    private static final String CLASSIFICATION_UNKNOWN = "CLASSIFICATION_UNKNOWN";

    /**
     * One operation as F1 reads it: its reference definition, the catalog's when keycloak-mcp lists it, and the
     * request every side sends.
     */
    private record Read(String key, OpView reference, JsonNode catalog, ReadRequest request) {
        String template() {
            return reference.path();
        }

        String named() {
            return reference.method() + " " + reference.path();
        }

        /** The operation as keycloak-mcp names it. */
        String operation() {
            return catalog != null ? catalog.path("key").asText() : named();
        }

        /** The operation's path as keycloak-mcp names it. */
        String catalogPath() {
            return catalog != null ? catalog.path("path").asText() : template();
        }

        JsonNode mcpArguments() {
            return request.mcpArguments(catalogPath());
        }
    }

    private static EquivalenceEnvironment env;
    private static ReferenceSurface reference;
    private static Map<String, JsonNode> catalog;
    private static Map<String, List<Endpoint>> adapterBindings;
    private static SeededRealm realm;
    private static PathValues values;
    private static KeycloakMcpPair mcp;
    private static AdminClientOracle adapter;
    private static Volatility volatility;
    private static KnownLag knownLag;
    private static ReadJudge judge;

    @BeforeAll
    static void start(EquivalenceEnvironment environment) throws Exception {
        env = environment;
        reference = env.reference();
        catalog = env.catalog().operations().stream().collect(Collectors.toMap(
                op -> PathTemplates.operationKey(op.path("method").asText(), op.path("path").asText()), op -> op, (a, b) -> a));
        adapterBindings = env.adminClientSurface().endpoints().stream().collect(Collectors.groupingBy(Endpoint::key));
        volatility = Volatility.load();
        knownLag = KnownLag.load();
        judge = new ReadJudge(DocumentedDivergences.load(), knownLag);
        realm = env.seeder().seed("equivalence-f1-" + System.currentTimeMillis());
        values = new PathValues(realm);
        mcp = KeycloakMcpPair.start(env, realm.name(), Map.of());
        adapter = new AdminClientOracle(env.serverUrl(), env.serviceAccount());
        System.out.printf("F1: seeded %s; seeding failures: %s%n", realm.name(), realm.log());
    }

    @AfterAll
    static void stop() throws Exception {
        try {
            summarize();
            if (mcp != null) {
                mcp.close();
            }
        } finally {
            if (adapter != null) {
                adapter.close();
            }
            if (realm != null) {
                realm.close();
            }
            env.writeLedger();
        }
    }

    @TestFactory
    Stream<DynamicTest> everyReadMatchesTheLiveServer() throws Exception {
        requireClassificationSignals();
        List<DynamicTest> tests = new ArrayList<>();
        for (String key : reference.keys()) {
            testOf(key).ifPresent(tests::add);
        }
        tests.add(dynamicTest("allowlists hold no stale entries", ReadEquivalenceIT::noStaleEntries));
        return tests.stream();
    }

    /**
     * Refuses to run F1 unless keycloak-mcp's dry run still gives the two answers {@link KeycloakMcpReads} relies on:
     * a changed refusal text, check order or argument validation must stop the run, not turn mutations into reads.
     */
    private static void requireClassificationSignals() throws Exception {
        KeycloakMcpReads.brokenSignals(mcp.pinned()).ifPresent(answers -> fail("keycloak-mcp's dry run no longer tells a"
                + " mutation from a read the way KeycloakMcpReads expects, so F1 sends nothing. " + answers));
    }

    /**
     * The F1 test of one reference operation, or none for one F1 leaves to F2 (recorded as out of scope with the
     * reason).
     */
    private static Optional<DynamicTest> testOf(String key) throws Exception {
        OpView op = reference.primary(key);
        JsonNode listed = catalog.get(key);
        if (listed == null && !op.method().equals("GET") && !op.method().equals("HEAD")) {
            outOfScope(key, "absent from catalog '" + env.catalog().version() + "', so keycloak-mcp's classification of this "
                    + op.method() + " cannot be observed");
            return Optional.empty();
        }
        Read read = new Read(key, op, listed, ReadRequests.forOperation(op.method(), op.path(),
                values.valuesFor(op.path()), accept(op, listed), realm));
        if (listed == null) {
            return Optional.of(dynamicTest(read.named(), () -> check(read)));
        }
        Classification classification = mcp.classify(read.operation(), read.catalogPath(), read.mcpArguments());
        return switch (classification.kind()) {
            case READ -> Optional.of(dynamicTest(read.named(), () -> check(read)));
            case MUTATION -> {
                outOfScope(key, "keycloak-mcp classifies it as a mutation (a dry-run keycloak_workflow answers '"
                        + KeycloakMcpReads.WRITES_DISABLED + "')");
                yield Optional.empty();
            }
            case UNKNOWN, REALM_ADMINISTRATION_DISABLED ->
                    Optional.of(dynamicTest(read.named(), () -> unclassified(read, classification)));
        };
    }

    private static void outOfScope(String key, String reason) {
        env.ledger().record(key, Verdict.F1_READ, Verdict.OUT_OF_SCOPE, true, reason + "; F2 covers it");
    }

    private static void unclassified(Read read, Classification classification) {
        String detail = "keycloak-mcp's dry run neither accepted it as a read ('" + KeycloakMcpReads.PREFLIGHT_OK
                + "') nor refused it as a mutation ('" + KeycloakMcpReads.WRITES_DISABLED + "'), so nothing was sent;"
                + " it answered: " + classification.answer();
        env.ledger().record(read.key(), Verdict.F1_READ, CLASSIFICATION_UNKNOWN, false, detail);
        fail(read.named() + " " + CLASSIFICATION_UNKNOWN + ": " + detail);
    }

    private static void check(Read read) throws Exception {
        Check viaMcp;
        Check viaAdapter;
        try {
            ReadRequest request = read.request();
            UnaryOperator<JsonNode> mask = v -> volatility.mask(read.key(), v);
            viaMcp = judge.mcp(read.key(), read.template(), read.catalog() != null,
                    ReadComparison.run(() -> raw(request), () -> throughMcp(read), mask, ATTEMPTS));
            viaAdapter = throughAdapter(read, request, mask);
        } catch (Exception | AssertionError e) {
            env.ledger().record(read.key(), Verdict.F1_READ, "ERROR", false, e.toString());
            throw e;
        }
        env.ledger().record(read.key(), Verdict.F1_READ, viaMcp.outcome(), viaMcp.accepted(), viaMcp.detail());
        env.ledger().record(read.key(), Verdict.F1_ADAPTER, viaAdapter.outcome(), viaAdapter.accepted(), viaAdapter.detail());
        // The operation leads the message: Failsafe reports dynamic tests by index, not by display name.
        assertTrue(viaMcp.accepted() && viaAdapter.accepted(), () -> read.named() + " "
                + (viaMcp.accepted() ? "" : viaMcp.outcome() + ": " + viaMcp.detail() + "\n")
                + (viaAdapter.accepted() ? "" : "admin client " + viaAdapter.outcome() + ": " + viaAdapter.detail()));
    }

    /**
     * The media type both sides ask for: JSON when the operation offers it, else its first response type. With
     * none declared, both send their default (see {@link ReadRequest#accept()}).
     */
    private static String accept(OpView op, JsonNode listed) {
        Collection<String> offered = listed != null ? Json.texts(listed.path("responseTypes")) : op.produces();
        return offered.contains("application/json") ? "application/json" : offered.stream().findFirst().orElse(null);
    }

    private static Observation raw(ReadRequest request) throws Exception {
        RawHttp.Response r = env.http().send(request.method(), request.rawPathAndQuery(), request.rawHeaders(), request.rawBody());
        return Observation.ofHttp(r.status(), r.header("Content-Type"), r.body());
    }

    private static Observation throughMcp(Read read) throws Exception {
        return KeycloakMcpReads.read(mcp.forPath(read.catalogPath()), read.operation(), read.mcpArguments());
    }

    private static Check throughAdapter(Read read, ReadRequest request, UnaryOperator<JsonNode> mask) throws Exception {
        List<Endpoint> bindings = adapterBindings.get(read.key());
        if (bindings == null) {
            return new Check(ReadJudge.NOT_IN_ADAPTER, true, "the admin client has no binding for it");
        }
        Optional<Endpoint> binding = AdminClientOracle.binding(bindings, request.query().keySet());
        if (binding.isEmpty()) {
            return new Check(ReadJudge.NOT_IN_ADAPTER, true, "no admin-client binding sends query " + request.query().keySet());
        }
        Endpoint e = binding.get();
        Object body = request.body() == null ? null : request.body().adapterValue(
                e.params(ParamSpec.Source.BODY).getFirst().javaType());
        AdminClientOracle.Answer first = adapter.call(e, request.pathValues(), request.query(), body);
        if (first.request() == null) {
            return new Check(ReadJudge.DIVERGENT, false, "the admin client sent no request: " + first.observation().error());
        }
        AdminClientOracle.Request sent = first.request();
        return judge.adapter(read.key(), e.javaChain(), ReadComparison.run(
                () -> replay(sent, request.rawBody()),
                () -> adapter.call(e, request.pathValues(), request.query(), body).observation(), mask, ATTEMPTS),
                path -> AdminClientOracle.unorderedInModel(e, path));
    }

    /** Raw HTTP repeating exactly what the admin client sent: its query, encoding and headers. */
    private static Observation replay(AdminClientOracle.Request sent, byte[] body) throws Exception {
        Map<String, String> headers = new LinkedHashMap<>();
        Optional.ofNullable(sent.accept()).ifPresent(a -> headers.put("Accept", a));
        Optional.ofNullable(sent.contentType()).ifPresent(c -> headers.put("Content-Type", c));
        RawHttp.Response r = env.http().send(sent.method(), sent.pathAndQuery(), headers, sent.contentType() == null ? null : body);
        return Observation.ofHttp(r.status(), r.header("Content-Type"), r.body());
    }

    private static void noStaleEntries() {
        assertTrue(knownLag.unused().isEmpty() && volatility.unused().isEmpty(), () -> "Entries that explained nothing in a full run"
                + " are stale; remove them (the adapter caught up, or the value stopped changing):\n"
                + "admin-client-known-lag.json: " + knownLag.unused().stream().map(KnownLag.Entry::ref).toList() + "\n"
                + "read-volatility.json: " + volatility.unused().stream().map(v -> v.key() + " " + v.path()).toList());
    }

    private static void summarize() {
        Map<String, Map<String, Long>> byCheck = new TreeMap<>();
        env.ledger().rows().values().forEach(row -> row.checks().forEach((name, c) -> {
            if (name.startsWith("F1:")) {
                byCheck.computeIfAbsent(name, n -> new TreeMap<>()).merge(c.outcome(), 1L, Long::sum);
            }
        }));
        System.out.printf("F1 outcomes: %s%n", byCheck);
    }
}
