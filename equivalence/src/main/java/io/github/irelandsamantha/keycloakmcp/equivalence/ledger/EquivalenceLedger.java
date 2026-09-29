package io.github.irelandsamantha.keycloakmcp.equivalence.ledger;

import io.github.irelandsamantha.keycloakmcp.equivalence.Json;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.PathTemplates;

import java.io.IOException;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.SortedMap;
import java.util.SortedSet;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * One row per reference operation (admin client ∪ HEAD OpenAPI) collecting the verdict of every check that ran on
 * it, plus the provenance of the run. Written to {@code target/equivalence-ledger.json}; the completeness check
 * reads it to prove no operation went unaccounted.
 */
public final class EquivalenceLedger {

    /** One check's verdict for one operation. */
    public record Check(String outcome, String detail) {
    }

    /**
     * @param key     operation key with the reference names, e.g. {@code GET /admin/realms/{realm}/users}
     * @param origins which oracles define the operation: {@code openapi}, {@code admin-client}
     */
    public record Row(String key, SortedSet<String> origins, SortedMap<String, Check> checks) {
    }

    private record Document(Provenance provenance, List<Row> operations, List<String> catalogOnly) {
    }

    private final Map<String, Row> rows = new TreeMap<>();
    private final Set<String> catalogOnly = new TreeSet<>();

    /** Registers a reference operation; repeated calls add origins. */
    public synchronized void reference(String method, String path, String origin) {
        rows.computeIfAbsent(PathTemplates.operationKey(method, path),
                k -> new Row(method + " " + path, new TreeSet<>(), new TreeMap<>())).origins().add(origin);
    }

    /** Records a check verdict for an operation already registered with {@link #reference}. */
    public synchronized void record(String operationKey, String check, String outcome, String detail) {
        Row row = rows.get(operationKey);
        if (row == null) {
            throw new IllegalArgumentException("Not a reference operation: " + operationKey);
        }
        row.checks().put(check, new Check(outcome, detail));
    }

    public synchronized boolean isReference(String operationKey) {
        return rows.containsKey(operationKey);
    }

    /** A keycloak-mcp catalog operation that no oracle defines. */
    public synchronized void catalogOnly(String key) {
        catalogOnly.add(key);
    }

    public synchronized void write(Path file, Provenance provenance) throws IOException {
        Json.write(file, new Document(provenance, List.copyOf(rows.values()), List.copyOf(catalogOnly)));
    }
}
