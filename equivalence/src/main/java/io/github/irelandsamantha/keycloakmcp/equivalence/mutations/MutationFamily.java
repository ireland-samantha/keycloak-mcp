package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import java.util.List;

/**
 * The mutation cases of one area of the admin API (groups, realm roles, ...), with the state every twin realm of
 * the family starts from. See {@code equivalence/README.md} for how to add one.
 */
public interface MutationFamily {

    /** Short, realm-name-safe name, e.g. {@code groups}. */
    String name();

    /** Creates the family's baseline in a fresh realm; runs identically in every twin before a case's own setup. */
    void seed(CaseContext realm);

    List<MutationCase> cases();
}
