package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.EquivalenceEnvironment;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpProcess;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpWorkflow;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpWorkflow.Result;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpWorkflow.Step;
import io.github.irelandsamantha.keycloakmcp.equivalence.ledger.EquivalenceLedger.Check;
import io.github.irelandsamantha.keycloakmcp.equivalence.oracle.AdminClientOracle;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.Endpoint;

import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Runs one {@link MutationCase} against the live server (DESIGN §1, F2 and F3).
 *
 * <ol>
 *   <li>Twin realms A and B get the family's seed and the case's setup.</li>
 *   <li>A dry run in A shows whether keycloak-mcp accepts the operation as reversible with the case's
 *       compensation.</li>
 *   <li>F3: if it does, a third twin C runs the operation followed by a step that always fails; keycloak-mcp must
 *       compensate, and C's readbacks must equal those taken before ({@link ForcedFailureFrame} says when a frame
 *       proves that). A case that expects the operation to be irreversible makes that acceptance a
 *       misclassification, and the frame its counterexample.</li>
 *   <li>F2: keycloak-mcp runs the operation in A (with the compensation it accepts, else with the irreversible
 *       override); the reference performs it in B. Both must answer in the same status class, and A's and B's
 *       readbacks must be equal once generated ids are replaced by natural keys. Only a case both sides performed
 *       (2xx) shows the mutation equivalent; one both sides rejected alike is accepted without showing it.</li>
 * </ol>
 */
public final class MutationRunner {

    /** keycloak-mcp as the mutation checks drive it: writes allowed, one writer, the irreversible override available. */
    private static final Map<String, String> WRITER = Map.of("KEYCLOAK_MCP_ALLOW_WRITE", "true",
            "KEYCLOAK_MCP_SINGLE_WRITER", "true", "KEYCLOAK_MCP_ALLOW_IRREVERSIBLE", "true");

    /** A step that fails without writing anything: a read of a group that does not exist. */
    private static final String FORCED_FAILURE = "GET /admin/realms/{realm}/groups/{group-id}";
    private static final String ABSENT_GROUP = "equivalence-forced-failure";

    private final EquivalenceEnvironment env;
    private final McpSteps steps;
    private final ReferenceCall reference;
    private final String run = String.valueOf(System.currentTimeMillis());
    private final AtomicInteger cases = new AtomicInteger();

    /**
     * @param catalog         keycloak-mcp's describe results by name-free operation key
     * @param adapterBindings admin-client endpoints by name-free operation key
     */
    public MutationRunner(EquivalenceEnvironment env, Map<String, JsonNode> catalog,
                          Map<String, List<Endpoint>> adapterBindings, AdminClientOracle adapter) {
        this.env = env;
        this.steps = new McpSteps(catalog);
        this.reference = new ReferenceCall(adapterBindings, adapter, env.http());
    }

    public CaseOutcome run(MutationFamily family, MutationCase mutation) {
        String realms = "equivalence-f2-" + family.name() + "-" + run + "-" + cases.incrementAndGet();
        try (CaseRealm a = CaseRealm.create(env, realms + "-a", family, mutation);
             CaseRealm b = CaseRealm.create(env, realms + "-b", family, mutation);
             KeycloakMcpProcess mcp = env.startKeycloakMcp(a.name(), WRITER)) {
            Step reversible = reversibleStep(mutation, a.context());
            Result plan = KeycloakMcpWorkflow.call(mcp.client(), List.of(reversible), false);
            boolean acceptedAsReversible = KeycloakMcpWorkflow.PREFLIGHT_OK.equals(plan.status());
            Check compensation = compensation(family, mutation, plan, realms + "-c");
            Step step = acceptedAsReversible ? reversible : steps.step(mutation.request(a.context())).markedIrreversible();
            return new CaseOutcome(mutation, compensation, equivalence(mutation, a, b, mcp, step));
        } catch (McpSteps.NotInCatalog e) {
            return CaseOutcome.failed(mutation, CaseOutcome.CATALOG_MISSING, e.getMessage());
        } catch (Exception e) {
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            return CaseOutcome.failed(mutation, CaseOutcome.ERROR, e.toString());
        }
    }

    /** The operation with the case's compensation and no override: what keycloak-mcp must judge reversible or not. */
    private Step reversibleStep(MutationCase mutation, CaseContext realm) {
        Step step = steps.step(mutation.request(realm));
        return mutation.compensation() == null ? step : step.compensatedBy(steps.step(mutation.compensation().apply(realm)));
    }

    private Check compensation(MutationFamily family, MutationCase mutation, Result plan, String realm) throws Exception {
        if (!plan.refused() && !KeycloakMcpWorkflow.PREFLIGHT_OK.equals(plan.status())) {
            return new Check(CaseOutcome.ERROR, false, "keycloak-mcp's dry run neither accepted nor refused it: " + plan.text());
        }
        if (plan.refused()) {
            return mutation.expectedIrreversible()
                    ? new Check(CaseOutcome.IRREVERSIBLE, true, "keycloak-mcp refuses it without the override: " + plan.text())
                    : new Check(CaseOutcome.NOT_COMPENSABLE, true, "keycloak-mcp accepts no compensation for it ("
                    + plan.text() + "), so F2 runs it with the irreversible override");
        }
        Check frame = forcedFailure(family, mutation, realm);
        if (mutation.expectedIrreversible()) {
            return new Check(CaseOutcome.MISCLASSIFIED, false, "keycloak-mcp accepts it as reversible, but "
                    + mutation.expectation() + ". Forced-failure frame, " + frame.outcome() + ": " + frame.detail());
        }
        return frame;
    }

    /** Runs the operation and then a failing step in a fresh twin; keycloak-mcp must restore the pre-state. */
    private Check forcedFailure(MutationFamily family, MutationCase mutation, String name) throws Exception {
        try (CaseRealm c = CaseRealm.create(env, name, family, mutation);
             KeycloakMcpProcess mcp = env.startKeycloakMcp(c.name(), WRITER)) {
            Readbacks readbacks = Readbacks.resolve(mutation, c.context());
            Step operation = reversibleStep(mutation, c.context());
            Step failing = steps.step(new CaseRequest(FORCED_FAILURE, CaseArgs.path(c.name(), ABSENT_GROUP)));
            State before = readbacks.read();
            Result run = KeycloakMcpWorkflow.call(mcp.client(), List.of(operation, failing), true);
            return ForcedFailureFrame.judge(operation, failing, run, before, readbacks.read());
        }
    }

    private Check equivalence(MutationCase mutation, CaseRealm a, CaseRealm b, KeycloakMcpProcess mcp, Step step) throws Exception {
        Readbacks subject = Readbacks.resolve(mutation, a.context());
        Readbacks twin = Readbacks.resolve(mutation, b.context());
        CaseRequest referenceRequest = mutation.request(b.context());
        Result run = KeycloakMcpWorkflow.call(mcp.client(), List.of(step), true);
        if (run.refused()) {
            return new Check(CaseOutcome.REFUSED, mutation.expectedIrreversible(),
                    "keycloak-mcp refuses it even with the irreversible override: " + run.text());
        }
        boolean completed = KeycloakMcpWorkflow.COMPLETED.equals(run.status());
        int status = completed ? run.completed().getFirst().status() : run.failureStatus();
        ReferenceCall.Answer answer = reference.perform(referenceRequest);
        List<String> differences = subject.read().differences(twin.read());
        boolean equivalent = status / 100 == answer.status() / 100 && differences.isEmpty();
        String detail = "keycloak-mcp " + run.status() + " HTTP " + status
                + (completed ? "" : " (" + run.report().path("error").asText() + ")")
                + ", reference HTTP " + answer.status() + " via " + answer.via()
                + (differences.isEmpty() ? "; readbacks agree" : "; readbacks differ: " + differences);
        String outcome = !equivalent ? CaseOutcome.DIVERGENT
                : status / 100 == 2 ? CaseOutcome.EQUIVALENT : CaseOutcome.REJECTED_ALIKE;
        return new Check(outcome, equivalent, detail);
    }
}
