package io.github.irelandsamantha.keycloakmcp.equivalence.ledger;

import io.github.irelandsamantha.keycloakmcp.equivalence.Json;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.PathTemplates;

import java.io.IOException;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.SortedMap;
import java.util.SortedSet;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * One row per reference operation (admin client ∪ HEAD OpenAPI) collecting the verdict of every check that ran on
 * it, the {@link Verdict} they add up to, and the provenance of the run. Written to
 * {@code target/equivalence-ledger.json}; the completeness check reads it to prove no operation went unaccounted.
 */
public final class EquivalenceLedger {

    /**
     * One check's verdict for one operation.
     *
     * @param accepted whether the check accepts this outcome; a single unaccepted check makes the operation
     *                 {@link Verdict.Outcome#UNACCOUNTED}
     */
    public record Check(String outcome, boolean accepted, String detail) {
    }

    /**
     * @param key     operation key with the reference names, e.g. {@code GET /admin/realms/{realm}/users}
     * @param origins which oracles define the operation: {@code openapi}, {@code admin-client}
     */
    public record Row(String key, SortedSet<String> origins, SortedMap<String, Check> checks) {
    }

    private record WrittenRow(String key, SortedSet<String> origins, Verdict verdict, SortedMap<String, Check> checks) {
    }

    private record Document(Provenance provenance, Map<Verdict.Outcome, Long> verdicts, List<WrittenRow> operations,
                            List<String> catalogOnly) {
    }

    private final Map<String, Row> rows = new TreeMap<>();
    private final Set<String> catalogOnly = new TreeSet<>();

    /** Registers a reference operation; repeated calls add origins. */
    public synchronized void reference(String method, String path, String origin) {
        rows.computeIfAbsent(PathTemplates.operationKey(method, path),
                k -> new Row(method + " " + path, new TreeSet<>(), new TreeMap<>())).origins().add(origin);
    }

    /** Records a check verdict for an operation already registered with {@link #reference}. */
    public synchronized void record(String operationKey, String check, String outcome, boolean accepted, String detail) {
        Row row = rows.get(operationKey);
        if (row == null) {
            throw new IllegalArgumentException("Not a reference operation: " + operationKey);
        }
        row.checks().put(check, new Check(outcome, accepted, detail));
    }

    public synchronized boolean isReference(String operationKey) {
        return rows.containsKey(operationKey);
    }

    /** A keycloak-mcp catalog operation that no oracle defines. */
    public synchronized void catalogOnly(String key) {
        catalogOnly.add(key);
    }

    /** Snapshot of every row by name-free operation key. */
    public synchronized Map<String, Row> rows() {
        Map<String, Row> copy = new LinkedHashMap<>();
        rows.forEach((k, r) -> copy.put(k, new Row(r.key(), new TreeSet<>(r.origins()), new TreeMap<>(r.checks()))));
        return copy;
    }

    /** Functional checks ({@link Verdict#FUNCTIONAL}) that recorded anything in this run. */
    public synchronized Set<String> functionalChecksRun() {
        Set<String> run = new TreeSet<>();
        rows.values().forEach(r -> r.checks().keySet().stream().filter(Verdict.FUNCTIONAL::contains).forEach(run::add));
        return run;
    }

    /** Each operation's verdict as of now, by name-free operation key. */
    public synchronized Map<String, Verdict> verdicts() {
        Set<String> run = functionalChecksRun();
        Map<String, Verdict> out = new LinkedHashMap<>();
        rows.forEach((k, r) -> out.put(k, Verdict.of(r.checks(), run)));
        return out;
    }

    public synchronized void write(Path file, Provenance provenance) throws IOException {
        Map<String, Verdict> verdicts = verdicts();
        List<WrittenRow> written = rows.entrySet().stream().map(e -> new WrittenRow(e.getValue().key(),
                e.getValue().origins(), verdicts.get(e.getKey()), e.getValue().checks())).toList();
        Json.write(file, new Document(provenance, Verdict.histogram(verdicts), written, List.copyOf(catalogOnly)));
    }
}
