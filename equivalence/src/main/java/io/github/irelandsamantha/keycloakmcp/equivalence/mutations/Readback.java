package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import java.util.function.Function;

/**
 * A read that observes the state a case changes, sent raw to the server before and after the mutation.
 *
 * @param operation         reference key of a GET, with variable names
 * @param args              its arguments in a given realm, resolved before the mutation so the same request is read
 *                          before and after it
 * @param unorderedBecause  when set, the answer is a set and array order at its top level is not state; the reason
 *                          cites the server source that leaves it unordered
 */
public record Readback(String operation, Function<CaseContext, CaseArgs> args, String unorderedBecause) {

    public static Readback of(String operation, Function<CaseContext, CaseArgs> args) {
        return new Readback(operation, args, null);
    }

    public static Readback unordered(String operation, Function<CaseContext, CaseArgs> args, String because) {
        return new Readback(operation, args, because);
    }

    CaseRequest resolve(CaseContext realm) {
        return new CaseRequest(operation, args.apply(realm));
    }
}
