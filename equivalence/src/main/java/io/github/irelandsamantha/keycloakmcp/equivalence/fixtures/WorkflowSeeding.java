package io.github.irelandsamantha.keycloakmcp.equivalence.fixtures;

import org.keycloak.representations.workflows.WorkflowRepresentation;
import org.keycloak.representations.workflows.WorkflowStepRepresentation;

import java.time.Duration;

/** A workflow, activated for the seeded user so that user has a scheduled step. */
final class WorkflowSeeding {

    private WorkflowSeeding() {
    }

    static void seed(Seeding s) {
        s.step(SeededRealm.WORKFLOW_ID, () -> Seeding.created(s.realm.workflows().create(workflow())));
        s.run("workflow activation", () -> s.realm.workflows().workflow(s.id(SeededRealm.WORKFLOW_ID))
                .activate("USERS", s.id(SeededRealm.USER_ID)));
    }

    /**
     * A workflow needs a step: the steps decide the resource type it applies to, and none leaves it ambiguous
     * ({@code Workflow.java:170-194}). Activating it only schedules the step, far enough out that it never runs
     * during a suite.
     */
    private static WorkflowRepresentation workflow() {
        return WorkflowRepresentation.withName(RealmSeeder.WORKFLOW)
                .withSteps(WorkflowStepRepresentation.create().of("set-user-attribute")
                        .after(Duration.ofDays(3650)).withConfig("equivalence", "seeded").build())
                .build();
    }
}
