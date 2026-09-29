package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import java.util.Collection;
import java.util.List;

/** Every family F2 and F3 run; a new family is added here. */
public final class MutationFamilies {

    private MutationFamilies() {
    }

    public static List<MutationFamily> all() {
        return List.of(new GroupsFamily(), new RealmRolesFamily());
    }

    /**
     * The families {@code names} lists by {@link MutationFamily#name()}, in {@link #all()}'s order; every family when
     * it lists none.
     *
     * @throws IllegalArgumentException for a name no family has, so a misspelt selection cannot run nothing
     */
    public static List<MutationFamily> select(Collection<String> names) {
        List<MutationFamily> all = all();
        if (names.isEmpty()) {
            return all;
        }
        List<String> known = all.stream().map(MutationFamily::name).toList();
        List<String> unknown = names.stream().filter(name -> !known.contains(name)).toList();
        if (!unknown.isEmpty()) {
            throw new IllegalArgumentException("No mutation family is named " + unknown + " (equivalence.families);"
                    + " the families are " + known);
        }
        return all.stream().filter(family -> names.contains(family.name())).toList();
    }
}
