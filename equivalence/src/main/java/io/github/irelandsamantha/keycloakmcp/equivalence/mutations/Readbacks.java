package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import io.github.irelandsamantha.keycloakmcp.equivalence.compare.Normalization;
import io.github.irelandsamantha.keycloakmcp.equivalence.compare.Observation;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.RawHttp;

import java.util.List;
import java.util.Map;

/**
 * A case's readbacks in one realm, resolved once before the mutation, so the same requests are read before and after
 * it even when the mutation removes what the arguments were looked up from.
 */
final class Readbacks {

    private record Resolved(Readback readback, CaseRequest request, List<String> volatilePaths) {
    }

    private final CaseContext realm;
    private final List<Resolved> resolved;

    private Readbacks(CaseContext realm, List<Resolved> resolved) {
        this.realm = realm;
        this.resolved = resolved;
    }

    static Readbacks resolve(MutationCase mutation, CaseContext realm) {
        return new Readbacks(realm, mutation.readbacks().stream().map(r -> new Resolved(r, r.resolve(realm),
                mutation.volatileFields().stream().filter(v -> v.readback().equals(r.operation())).map(VolatileField::path)
                        .toList())).toList());
    }

    /** Reads every readback now, normalized with the ids the realm holds now. */
    State read() {
        Map<String, String> ids = NaturalKeys.index(realm.http(), realm.realm());
        return new State(resolved.stream().map(r -> {
            RawHttp.Response answer = ServerCalls.send(realm.http(), "GET",
                    r.request().args().rawPathAndQuery(r.request().template()), null);
            Observation observed = Observation.ofHttp(answer.status(), answer.header("Content-Type"), answer.body());
            Normalization normalization = new Normalization(realm.realm(), ids, r.volatilePaths());
            return new State.Entry(r.readback().operation(), r.readback().unorderedBecause() != null, observed.status(),
                    normalization.apply(observed.value()));
        }).toList());
    }
}
