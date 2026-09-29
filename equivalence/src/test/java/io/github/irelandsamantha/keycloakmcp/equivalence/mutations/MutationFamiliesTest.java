package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import org.junit.jupiter.api.Test;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** What can be checked of the families without a server: names, keys and readbacks. */
class MutationFamiliesTest {

    @Test
    void familyNamesCanBePartOfARealmName() {
        MutationFamilies.all().forEach(f -> assertTrue(f.name().matches("[a-z0-9-]+"), f.name()));
    }

    @Test
    void everyCaseHasADistinctNameAndReadsBackWithGets() {
        Set<String> names = new HashSet<>();
        for (MutationFamily family : MutationFamilies.all()) {
            for (MutationCase c : family.cases()) {
                assertTrue(names.add(c.displayName()), () -> "duplicate case " + c.displayName());
                assertTrue(c.readbacks().stream().allMatch(r -> r.operation().startsWith("GET ")), c::displayName);
                assertTrue(c.expectation() != null && !c.expectation().isBlank(), () -> c.displayName() + " gives no reason");
            }
        }
    }

    @Test
    void volatileFieldsNameOneOfTheCasesReadbacks() {
        for (MutationFamily family : MutationFamilies.all()) {
            for (MutationCase c : family.cases()) {
                List<String> readbacks = c.readbacks().stream().map(Readback::operation).toList();
                c.volatileFields().forEach(v -> assertTrue(readbacks.contains(v.readback()), c.displayName() + ": " + v));
            }
        }
    }

    @Test
    void operationKeysAreNameFree() {
        MutationCase c = new GroupsFamily().cases().getFirst();
        assertEquals("POST /admin/realms/{}/groups", c.operationKey());
    }

    @Test
    void anEmptySelectionRunsEveryFamily() {
        assertEquals(names(MutationFamilies.all()), names(MutationFamilies.select(List.of())));
    }

    @Test
    void aSelectionRunsTheNamedFamiliesInTheirUsualOrder() {
        assertEquals(List.of("groups", "realm-roles"), names(MutationFamilies.select(List.of("realm-roles", "groups"))));
        assertEquals(List.of("realm-roles"), names(MutationFamilies.select(List.of("realm-roles"))));
    }

    @Test
    void aNameNoFamilyHasIsRefusedRatherThanRunningNothing() {
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> MutationFamilies.select(List.of("groups", "group")));
        assertTrue(e.getMessage().contains("[group]") && e.getMessage().contains("realm-roles"), e.getMessage());
    }

    private static List<String> names(List<MutationFamily> families) {
        return families.stream().map(MutationFamily::name).toList();
    }
}
