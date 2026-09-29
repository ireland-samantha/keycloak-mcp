package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.function.Consumer;
import java.util.function.Function;

/**
 * One mutation, performed the same way in twin realms: through keycloak-mcp in one, through the reference in the
 * other. Everything that addresses an entity takes the {@link CaseContext} of the realm at hand, because generated
 * ids differ between the twins.
 *
 * @param operation            reference key with variable names, e.g. {@code PUT /admin/realms/{realm}/groups/{group-id}}
 * @param name                 what this case does with the operation; one operation can have several cases
 * @param setup                state the case needs on top of its family's seed, applied to every twin
 * @param args                 the mutation's arguments in a realm
 * @param compensation         the undo a client would offer for it, resolved before the mutation; may use
 *                             {@code $step.locationId} or {@code $step.responseId}; {@code null} for none, which
 *                             only an irreversible case may leave out, and then its refusal proves nothing
 * @param readbacks            reads that observe the state the mutation changes
 * @param volatileFields       readback values that legitimately differ between the twins
 * @param expectedIrreversible whether keycloak-mcp must refuse the operation without the irreversible override
 * @param expectation          why, citing the server source
 * @param requires             fixes this case needs before keycloak-mcp passes it (finding ids); empty when none
 */
public record MutationCase(String operation, String name, Consumer<CaseContext> setup,
                           Function<CaseContext, CaseArgs> args, Function<CaseContext, CaseRequest> compensation,
                           List<Readback> readbacks, List<VolatileField> volatileFields, boolean expectedIrreversible,
                           String expectation, List<String> requires) {

    public MutationCase {
        readbacks = List.copyOf(readbacks);
        volatileFields = List.copyOf(volatileFields);
        requires = List.copyOf(requires);
    }

    public static Builder of(String operation, String name) {
        return new Builder(operation, name);
    }

    /** Name-free key, as the ledger and every surface join on. */
    public String operationKey() {
        return new CaseRequest(operation, CaseArgs.path()).operationKey();
    }

    public String displayName() {
        return operation + " | " + name + (requires.isEmpty() ? "" : " [requires " + String.join(", ", requires) + "]");
    }

    CaseRequest request(CaseContext realm) {
        return new CaseRequest(operation, args.apply(realm));
    }

    public static final class Builder {
        private final String operation;
        private final String name;
        private Consumer<CaseContext> setup = realm -> {
        };
        private Function<CaseContext, CaseArgs> args;
        private Function<CaseContext, CaseRequest> compensation;
        private final List<Readback> readbacks = new ArrayList<>();
        private final List<VolatileField> volatileFields = new ArrayList<>();
        private Boolean expectedIrreversible;
        private String expectation;
        private final List<String> requires = new ArrayList<>();

        private Builder(String operation, String name) {
            this.operation = operation;
            this.name = name;
        }

        public Builder setup(Consumer<CaseContext> value) {
            setup = value;
            return this;
        }

        public Builder args(Function<CaseContext, CaseArgs> value) {
            args = value;
            return this;
        }

        /**
         * The undo a client would offer. For an irreversible case it is what keycloak-mcp must refuse without the
         * override while accepting it with the override; without one, the case can only end
         * {@link CaseOutcome#AMBIGUOUS_REFUSAL}.
         */
        public Builder compensatedBy(Function<CaseContext, CaseRequest> value) {
            compensation = value;
            return this;
        }

        public Builder readback(Readback value) {
            readbacks.add(value);
            return this;
        }

        public Builder volatileField(String readback, String path, String reason) {
            volatileFields.add(new VolatileField(readback, path, reason));
            return this;
        }

        /** keycloak-mcp may treat the operation as reversible; {@code why} names the undo that restores the state. */
        public Builder reversible(String why) {
            return expect(false, why);
        }

        /** keycloak-mcp must refuse the operation without the irreversible override; {@code why} says what cannot be undone. */
        public Builder irreversible(String why) {
            return expect(true, why);
        }

        /** Fixes keycloak-mcp needs before it passes this case, by finding id. */
        public Builder requires(String... findings) {
            requires.addAll(List.of(findings));
            return this;
        }

        public MutationCase build() {
            Objects.requireNonNull(args, () -> operation + " | " + name + ": no args");
            Objects.requireNonNull(expectedIrreversible, () -> operation + " | " + name + ": reversible or irreversible?");
            if (readbacks.isEmpty()) {
                throw new IllegalStateException(operation + " | " + name + ": no readback observes the change");
            }
            if (!expectedIrreversible && compensation == null) {
                throw new IllegalStateException(operation + " | " + name + ": a reversible case names its compensation");
            }
            return new MutationCase(operation, name, setup, args, compensation, readbacks, volatileFields,
                    expectedIrreversible, expectation, requires);
        }

        private Builder expect(boolean irreversible, String why) {
            expectedIrreversible = irreversible;
            expectation = why;
            return this;
        }
    }
}
