package io.github.irelandsamantha.keycloakmcp.equivalence.oracle;

import io.github.irelandsamantha.keycloakmcp.equivalence.surface.AdminClientSurface;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.Endpoint;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.ParamSpec;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AdminClientOracleTest {

    private static Map<String, List<Endpoint>> bindings;

    @BeforeAll
    static void walk() {
        bindings = AdminClientSurface.walk().endpoints().stream().collect(Collectors.groupingBy(Endpoint::key));
    }

    @Test
    void prefersATypedBindingThatSendsNothingUnasked() {
        Endpoint users = AdminClientOracle.binding(bindings.get("GET /admin/realms/{}/users"), Set.of()).orElseThrow();
        assertEquals(Endpoint.ReturnKind.TYPED, users.returnKind());
        assertFalse(users.deprecated());
        assertTrue(users.params(ParamSpec.Source.QUERY).stream().noneMatch(ParamSpec::primitive), users.javaChain());
    }

    @Test
    void aBindingMustBeAbleToSendTheQueryTheReadUses() {
        List<Endpoint> search = bindings.get("GET /admin/realms/{}/clients/{}/authz/resource-server/policy/search");
        assertTrue(AdminClientOracle.binding(search, Set.of("name")).isPresent());
        assertTrue(AdminClientOracle.binding(search, Set.of("no-such-parameter")).isEmpty());
    }

    @Test
    void knowsWhichArraysTheAdapterHoldsInASet() {
        Endpoint composites = bindings.get("GET /admin/realms/{}/roles-by-id/{}/composites").getFirst();
        assertTrue(AdminClientOracle.unorderedInModel(composites, "$"));
        Endpoint roles = AdminClientOracle.binding(bindings.get("GET /admin/realms/{}/roles"), Set.of()).orElseThrow();
        assertFalse(AdminClientOracle.unorderedInModel(roles, "$"));
        Endpoint resource = bindings.get("GET /admin/realms/{}/clients/{}/authz/resource-server/resource/{}").getFirst();
        assertTrue(AdminClientOracle.unorderedInModel(resource, "$.uris"), resource.returnType());
        assertFalse(AdminClientOracle.unorderedInModel(resource, "$.name"));
    }
}
