package io.github.irelandsamantha.keycloakmcp.equivalence.compare;

import io.github.irelandsamantha.keycloakmcp.equivalence.ledger.EquivalenceLedger.Check;
import io.github.irelandsamantha.keycloakmcp.equivalence.ledger.Verdict;

import java.util.List;
import java.util.Map;
import java.util.SortedMap;
import java.util.SortedSet;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.function.Predicate;
import java.util.stream.Collectors;

/**
 * Turns the comparisons of one read into F1's ledger outcomes.
 *
 * <p>keycloak-mcp against raw HTTP ({@link #mcp}): {@code EQUIVALENT}; {@code ROUTED_ONLY} when the server itself
 * refuses the read in a way {@code divergences.json} documents as a {@value #GATE} (a feature or provider the
 * running server lacks); otherwise a failure named after its cause, {@value #CATALOG_MISSING} first among them.
 *
 * <p>The admin client against raw HTTP ({@link #adapter}): {@code EQUIVALENT}, or {@code DIVERGENT_DOCUMENTED} when
 * every difference is a dated {@link KnownLag} entry.
 */
public final class ReadJudge {

    /** Divergence kind of a read the server refuses for lack of a feature or provider. */
    public static final String GATE = "read-gate";
    public static final String CATALOG_MISSING = "CATALOG_MISSING";
    public static final String MCP_REFUSED = "MCP_REFUSED";
    public static final String UNSTABLE = "UNSTABLE";
    public static final String DIVERGENT = "DIVERGENT";
    public static final String UNEXERCISED = "UNEXERCISED";
    public static final String NOT_IN_ADAPTER = "NOT_IN_ADAPTER";

    private static final int EXCERPT = 200;

    private final DocumentedDivergences gates;
    private final KnownLag lag;

    public ReadJudge(DocumentedDivergences gates, KnownLag lag) {
        this.gates = gates;
        this.lag = lag;
    }

    /**
     * @param key       name-free operation key
     * @param template  the operation's path template, for documentation entries
     * @param catalogued whether keycloak-mcp's catalog lists the operation
     */
    public Check mcp(String key, String template, boolean catalogued, ReadComparison c) {
        Observation raw = c.reference();
        Observation mcp = c.subject();
        if (mcp.status() == 0) {
            return fail(catalogued ? MCP_REFUSED : CATALOG_MISSING, "keycloak-mcp: " + mcp.error() + "; raw HTTP: " + describe(raw));
        }
        if (!c.referenceStable()) {
            return fail(UNSTABLE, unstable(c));
        }
        if (!c.sameStatus()) {
            return fail(DIVERGENT, "raw HTTP " + describe(raw) + ", keycloak-mcp " + mcp.status() + ": " + mcp.error());
        }
        if (!raw.success()) {
            return gate(key, template, raw);
        }
        if (!c.differences().isEmpty()) {
            return fail(DIVERGENT, "keycloak-mcp differs from raw HTTP (" + describe(raw) + "): " + c.differences());
        }
        return new Check(Verdict.Outcome.EQUIVALENT.name(), true, describe(raw) + attempts(c));
    }

    /**
     * @param binding          the admin-client chain that was called
     * @param unorderedInModel whether the adapter's model holds the array at a path in a {@code Set}; its order
     *                         then says nothing about the server's
     */
    public Check adapter(String key, String binding, ReadComparison c, Predicate<String> unorderedInModel) {
        if (!c.referenceStable()) {
            return fail(UNSTABLE, unstable(c));
        }
        List<JsonDiff.Diff> differences = c.differences().stream()
                .filter(d -> !(d.kind() == JsonDiff.Kind.ARRAY_ORDER && unorderedInModel.test(d.path()))).toList();
        String unordered = differences.size() == c.differences().size() ? ""
                : "; order not comparable at " + c.differences().stream().filter(d -> !differences.contains(d))
                        .map(JsonDiff.Diff::path).toList() + " (a Set in the adapter's model)";
        if (differences.isEmpty()) {
            return new Check(Verdict.Outcome.EQUIVALENT.name(), true, describe(c.reference()) + " via " + binding + unordered + attempts(c));
        }
        KnownLag.Assessment a = lag.assess(key, differences);
        if (a.undocumented().isEmpty()) {
            return new Check(Verdict.Outcome.DIVERGENT_DOCUMENTED.name(), true, a.documented().values().stream()
                    .map(KnownLag.Entry::ref).distinct().collect(Collectors.joining("; ")) + " via " + binding + unordered);
        }
        return fail(DIVERGENT, "admin client (" + binding + ") differs from raw HTTP (" + describe(c.reference())
                + ") beyond admin-client-known-lag.json: " + a.undocumented());
    }

    /** The divergence a server refusal is documented as, when it is one. */
    private static Divergence gateObservation(String key, String template, Observation raw) {
        SortedMap<String, SortedSet<String>> observed = new TreeMap<>();
        observed.put("server", new TreeSet<>(List.of(raw.status() + " " + excerpt(raw))));
        return new Divergence(key, template, GATE, "server", observed);
    }

    private Check gate(String key, String template, Observation raw) {
        Divergence d = gateObservation(key, template, raw);
        Map<Divergence, DocumentedDivergences.Entry> documented = gates.assess(List.of(d), e -> false).documented();
        DocumentedDivergences.Entry entry = documented.get(d);
        if (entry == null) {
            return fail(UNEXERCISED, "both answered " + raw.status() + " " + excerpt(raw) + ", which no " + GATE
                    + " entry documents: seed what the read needs or document the gate:\n" + DocumentedDivergences.skeleton(d));
        }
        return new Check(Verdict.Outcome.ROUTED_ONLY.name(), true, raw.status() + " " + entry.reason() + " [" + entry.ref() + "]");
    }

    private static Check fail(String outcome, String detail) {
        return new Check(outcome, false, detail);
    }

    private static String unstable(ReadComparison c) {
        return "the server answered identical reads differently " + c.attempts() + " times in a row: " + c.instability()
                + "; if legitimate, document the values in read-volatility.json";
    }

    private static String attempts(ReadComparison c) {
        return c.attempts() == 1 ? "" : " (reference stable on read " + c.attempts() + ")";
    }

    private static String describe(Observation o) {
        return o.success() ? o.status() + " " + o.contentClass() : o.status() + " " + excerpt(o);
    }

    private static String excerpt(Observation o) {
        String text = o.error() != null ? o.error() : o.value().isTextual() ? o.value().asText() : o.value().toString();
        return text.length() > EXCERPT ? text.substring(0, EXCERPT) + "..." : text;
    }
}
