package io.github.irelandsamantha.keycloakmcp.equivalence.compare;

import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.CatalogOp;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;

class DivergenceTest {

    private static CatalogOp op(String path, String... declared) {
        return new CatalogOp("GET", path, List.of(declared), List.of(), Set.of(), Set.of(), null, Set.of(), Set.of());
    }

    @Test
    void everyTemplateVariableMustBeDeclaredExactlyOnce() {
        List<Divergence> found = Divergence.pathDeclarations("catalog", List.of(
                op("/r/{realm}/u/{id}", "realm", "id"),
                op("/r/{realm}/u/{id}", "id", "realm"),
                op("/r/{realm}/u/{id}", "realm"),
                op("/r/{id}/p/{id}", "id", "id")));
        assertEquals(List.of("/r/{realm}/u/{id} {declared=[realm], template=[realm,id]}",
                        "/r/{id}/p/{id} {declared=[id,id], template=[id,id]}"),
                found.stream().map(d -> d.path() + " " + d.observed()).toList());
    }
}
