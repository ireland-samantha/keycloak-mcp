package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import io.github.irelandsamantha.keycloakmcp.equivalence.fixtures.DisposableRealm;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.EquivalenceEnvironment;

/** A fresh realm holding a family's seed and a case's setup: one twin. Closing it deletes the realm. */
final class CaseRealm implements AutoCloseable {

    private final DisposableRealm realm;
    private final CaseContext context;

    private CaseRealm(DisposableRealm realm, CaseContext context) {
        this.realm = realm;
        this.context = context;
    }

    static CaseRealm create(EquivalenceEnvironment env, String name, MutationFamily family, MutationCase mutation) {
        DisposableRealm realm = DisposableRealm.create(env.adminClient(), name, representation -> {
        });
        try {
            CaseContext context = CaseContext.of(name, env.http(), env.systems());
            family.seed(context);
            mutation.setup().accept(context);
            return new CaseRealm(realm, context);
        } catch (RuntimeException e) {
            realm.close();
            throw e;
        }
    }

    String name() {
        return realm.name();
    }

    CaseContext context() {
        return context;
    }

    @Override
    public void close() {
        realm.close();
    }
}
