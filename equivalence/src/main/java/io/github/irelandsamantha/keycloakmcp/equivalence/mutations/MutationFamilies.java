package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import java.util.List;

/** Every family F2 and F3 run; a new family is added here. */
public final class MutationFamilies {

    private MutationFamilies() {
    }

    public static List<MutationFamily> all() {
        return List.of(new GroupsFamily(), new RealmRolesFamily());
    }
}
