package io.github.irelandsamantha.keycloakmcp.equivalence;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.compare.Observation;
import io.github.irelandsamantha.keycloakmcp.equivalence.compare.ReadComparison;
import io.github.irelandsamantha.keycloakmcp.equivalence.fixtures.DisposableRealm;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.AdminEvents;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.EquivalenceEnvironment;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpProcess;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpReads;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpWorkflow;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpWorkflow.Result;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpWorkflow.Step;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpWorkflow.StepRun;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.McpStdioClient;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.McpStdioClient.ToolResult;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.RawHttp;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.RecordingProxy;
import io.github.irelandsamantha.keycloakmcp.equivalence.mutations.CaseContext;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Named;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

import java.io.IOException;
import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.function.UnaryOperator;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static io.github.irelandsamantha.keycloakmcp.equivalence.harness.KeycloakMcpProcess.ALLOW_SENSITIVE_READS;
import static org.junit.jupiter.api.Assertions.assertAll;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * F4 safety semantics (DESIGN §1): keycloak-mcp's own guarantees, driven over MCP stdio against the live server.
 * keycloak-mcp reaches the server through a {@link RecordingProxy}, so each check sees exactly what it sent; the
 * pinned realm's admin events and readbacks show what the server changed. A check of behavior that needs a
 * DESIGN §6 fix carries {@link RequiresNodeFixes} and fails until that fix is in the keycloak-mcp under test.
 */
@ExtendWith(EquivalenceExtension.class)
class SafetySemanticsIT {

    private static final String ALLOW_WRITE = "KEYCLOAK_MCP_ALLOW_WRITE";
    private static final String SINGLE_WRITER = "KEYCLOAK_MCP_SINGLE_WRITER";
    private static final String ALLOW_IRREVERSIBLE = "KEYCLOAK_MCP_ALLOW_IRREVERSIBLE";
    private static final Map<String, String> WRITER = Map.of(ALLOW_WRITE, "true", SINGLE_WRITER, "true");
    private static final Map<String, String> OVERRIDABLE = Map.of(ALLOW_WRITE, "true", SINGLE_WRITER, "true",
            ALLOW_IRREVERSIBLE, "true");
    /** Redaction as keycloak-mcp ships it: the sensitive-reads switch left unset. */
    private static final Map<String, String> SHIPPED_REDACTION = Collections.singletonMap(ALLOW_SENSITIVE_READS, null);
    /** Redaction as an operator sets it explicitly. */
    private static final Map<String, String> REDACTED = Map.of(ALLOW_SENSITIVE_READS, "false");

    private static final String READ_REALMS = "GET /admin/realms";
    private static final String READ_REALM = "GET /admin/realms/{realm}";
    private static final String READ_GROUPS = "GET /admin/realms/{realm}/groups";
    private static final String READ_GROUP = "GET /admin/realms/{realm}/groups/{group-id}";
    private static final String READ_GROUP_BY_PATH = "GET /admin/realms/{realm}/group-by-path/{path}";
    private static final String CREATE_GROUP = "POST /admin/realms/{realm}/groups";
    private static final String UPDATE_GROUP = "PUT /admin/realms/{realm}/groups/{group-id}";
    private static final String DELETE_GROUP = "DELETE /admin/realms/{realm}/groups/{group-id}";
    private static final String READ_CLIENT = "GET /admin/realms/{realm}/clients/{client-uuid}";
    private static final String READ_CLIENT_SECRET = "GET /admin/realms/{realm}/clients/{client-uuid}/client-secret";
    private static final String UPDATE_CLIENT = "PUT /admin/realms/{realm}/clients/{client-uuid}";
    private static final String UPDATE_USER = "PUT /admin/realms/{realm}/users/{user-id}";
    private static final String CREATE_SCOPE = "POST /admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/scope";
    private static final String DELETE_SCOPE =
            "DELETE /admin/realms/{realm}/clients/{client-uuid}/authz/resource-server/scope/{scope-id}";

    /** A group id nothing has: reading it is a step that fails without writing. */
    private static final String ABSENT = "equivalence-absent";
    private static final String TAKEN_GROUP = "f4-taken";

    private static final SecureRandom RANDOM = new SecureRandom();

    private static EquivalenceEnvironment env;
    private static DisposableRealm pinnedRealm;
    private static DisposableRealm otherRealm;
    /** The realm keycloak-mcp is pinned to. */
    private static CaseContext pinned;
    private static CaseContext other;
    private static String otherGroup;
    private static String authzClient;

    @BeforeAll
    static void seed(EquivalenceEnvironment environment) {
        env = environment;
        String name = "equivalence-f4-" + System.currentTimeMillis();
        pinnedRealm = DisposableRealm.create(env.adminClient(), name, realm -> {
            realm.setAdminEventsEnabled(true);
            realm.setAdminEventsDetailsEnabled(true);
            realm.setSmtpServer(Map.of("host", "smtp.invalid", "port", "25", "from", "f4@smtp.invalid", "auth", "true",
                    "user", "f4", "password", secret()));
        });
        otherRealm = DisposableRealm.create(env.adminClient(), name + "-other", realm -> realm.setAdminEventsEnabled(true));
        pinned = CaseContext.of(pinnedRealm.name(), env.http());
        other = CaseContext.of(otherRealm.name(), env.http());
        otherGroup = other.create("groups", Json.read("""
                {"name": "f4-other-group"}"""));
        pinned.create("groups", Json.read("""
                {"name": "%s"}""".formatted(TAKEN_GROUP)));
        authzClient = pinned.create("clients", Json.read("""
                {"clientId": "f4-authz", "publicClient": false, "serviceAccountsEnabled": true,
                 "authorizationServicesEnabled": true, "standardFlowEnabled": false}"""));
        pinned.send("POST", "clients/" + authzClient + "/authz/resource-server/scope", Json.read("""
                {"name": "f4-existing-scope"}"""));
    }

    @AfterAll
    static void remove() {
        if (otherRealm != null) {
            otherRealm.close();
        }
        if (pinnedRealm != null) {
            pinnedRealm.close();
        }
    }

    // --- realm pinning ------------------------------------------------------------------------------------------

    @Test
    void aRealmOtherThanThePinnedOneIsRefused() throws Exception {
        try (RecordingProxy proxy = RecordingProxy.start(env.serverUrl()); KeycloakMcpProcess mcp = start(proxy, WRITER)) {
            int otherEvents = AdminEvents.of(env.http(), other.realm()).size();
            JsonNode otherBefore = other.get("groups/" + otherGroup);
            ToolResult read = read(mcp, READ_GROUPS, args(Map.of("realm", other.realm()), null));
            Map<String, String> target = Map.of("realm", other.realm(), "group-id", otherGroup);
            Result write = run(mcp, true, Step.of(UPDATE_GROUP, args(target, Json.read("""
                    {"name": "hijacked"}"""))).compensatedBy(Step.of(UPDATE_GROUP, args(target, otherBefore))));
            assertAll(
                    () -> assertTrue(read.isError(), () -> "path.realm override read: " + read.text()),
                    () -> assertTrue(write.refused(), () -> "path.realm override write: " + write.text()),
                    () -> assertEquals(List.of(), proxy.requests(), "a refused call sends nothing"),
                    () -> assertEquals(otherEvents, AdminEvents.of(env.http(), other.realm()).size(),
                            "admin events of the other realm"),
                    () -> assertEquals(otherBefore, other.get("groups/" + otherGroup)));
        }
    }

    @Test
    void encodedTraversalNeverLeavesThePinnedRealm() throws Exception {
        String o = other.realm();
        List<String> ids = List.of("..", ".", "../" + o, "../../" + o, "..%2F..%2F" + o, "%2e%2e", "%2e%2e%2f%2e%2e%2f" + o,
                "..\\..\\" + o, "..;/..;/" + o, "%252e%252e%252f" + o);
        List<String> paths = List.of("../../" + o + "/groups", "f4-taken/../../../" + o, "%2e%2e/%2e%2e/" + o, "/../" + o);
        try (RecordingProxy proxy = RecordingProxy.start(env.serverUrl()); KeycloakMcpProcess mcp = start(proxy, Map.of())) {
            List<String> escaped = new ArrayList<>();
            for (String id : ids) {
                answeredInsidePinnedRealm(read(mcp, READ_GROUP, args(Map.of("group-id", id), null)), id, escaped);
            }
            for (String path : paths) {
                answeredInsidePinnedRealm(read(mcp, READ_GROUP_BY_PATH, args(Map.of("path", path), null)), path, escaped);
            }
            assertAll(
                    () -> assertEquals(List.of(), escaped, "attempts that were answered, or answered with the other realm's data"),
                    () -> assertEquals(List.of(), outsidePinnedRealm(proxy), "requests outside the pinned realm"));
        }
    }

    @Test
    @RequiresNodeFixes({"SEC-5", "MCPLIVE-11"})
    void readsWithoutARealmNeedRealmAdministration() throws Exception {
        try (RecordingProxy proxy = RecordingProxy.start(env.serverUrl()); KeycloakMcpProcess mcp = start(proxy, Map.of())) {
            ToolResult realms = read(mcp, READ_REALMS, JsonNodeFactory.instance.objectNode());
            assertAll(
                    () -> assertTrue(realms.isError(), () -> "GET /admin/realms without realm administration answered: "
                            + preview(realms.text())),
                    () -> assertFalse(realms.text().contains(other.realm()), "the answer names another realm"),
                    () -> assertEquals(List.of(), outsidePinnedRealm(proxy), "requests outside the pinned realm"));
        }
    }

    // --- write and irreversible gating --------------------------------------------------------------------------

    @Test
    void withWritesDisabledNothingIsSentOrChanged() throws Exception {
        String group = pinned.create("groups", Json.read("""
                {"name": "f4-read-only"}"""));
        try (RecordingProxy proxy = RecordingProxy.start(env.serverUrl()); KeycloakMcpProcess mcp = start(proxy, Map.of())) {
            State before = state();
            List<Result> refused = List.of(
                    run(mcp, true, createGroup("f4-never")),
                    run(mcp, true, renameGroup(group, "f4-renamed")),
                    run(mcp, true, Step.of(DELETE_GROUP, groupArgs(group)).markedIrreversible()));
            ToolResult direct = read(mcp, UPDATE_GROUP, args(Map.of("group-id", group), Json.read("""
                    {"name": "f4-renamed"}""")));
            assertAll(
                    () -> assertTrue(refused.stream().allMatch(Result::refused), () -> "workflows: " + refused),
                    () -> assertTrue(direct.isError(), () -> "keycloak_read of a mutation: " + direct.text()),
                    () -> assertEquals(List.of(), proxy.requests(), "refused calls send nothing"),
                    () -> assertEquals(before, state()));
        }
    }

    @Test
    void aDryRunSendsNothing() throws Exception {
        String group = pinned.create("groups", Json.read("""
                {"name": "f4-planned"}"""));
        try (RecordingProxy proxy = RecordingProxy.start(env.serverUrl()); KeycloakMcpProcess mcp = start(proxy, OVERRIDABLE)) {
            State before = state();
            Result plan = run(mcp, false, createGroup("f4-never"), renameGroup(group, "f4-renamed"),
                    Step.of(DELETE_GROUP, groupArgs(group)).markedIrreversible());
            assertAll(
                    () -> assertEquals(KeycloakMcpWorkflow.PREFLIGHT_OK, plan.status(), plan::text),
                    () -> assertEquals(List.of(), proxy.requests(), "a dry run sends nothing"),
                    () -> assertEquals(before, state()));
        }
    }

    @Test
    void irreversibleStepsRunOnlyWithTheOperatorsOverride() throws Exception {
        String doomed = pinned.create("groups", Json.read("""
                {"name": "f4-doomed"}"""));
        Step delete = Step.of(DELETE_GROUP, groupArgs(doomed));
        try (RecordingProxy proxy = RecordingProxy.start(env.serverUrl()); KeycloakMcpProcess mcp = start(proxy, WRITER)) {
            State before = state();
            Result unmarked = run(mcp, true, delete);
            Result marked = run(mcp, true, delete.markedIrreversible());
            assertAll("without KEYCLOAK_MCP_ALLOW_IRREVERSIBLE",
                    () -> assertTrue(unmarked.refused(), unmarked::text),
                    () -> assertTrue(marked.refused(), marked::text),
                    () -> assertEquals(List.of(), proxy.requests(), "refused calls send nothing"),
                    () -> assertEquals(before, state()));
        }
        try (RecordingProxy proxy = RecordingProxy.start(env.serverUrl()); KeycloakMcpProcess mcp = start(proxy, OVERRIDABLE)) {
            Result unmarked = run(mcp, true, delete);
            List<JsonNode> eventsBefore = events();
            Result marked = run(mcp, true, delete.markedIrreversible());
            assertAll("with KEYCLOAK_MCP_ALLOW_IRREVERSIBLE",
                    () -> assertTrue(unmarked.refused(), () -> "a step without irreversible:true: " + unmarked.text()),
                    () -> assertEquals(KeycloakMcpWorkflow.COMPLETED, marked.status(), marked::text),
                    () -> assertEquals(List.of("DELETE groups/" + doomed), newEvents(eventsBefore)),
                    () -> assertEquals(404, status("groups/" + doomed)));
        }
    }

    @Test
    @RequiresNodeFixes("SEC-2")
    void secretsSetThroughARepresentationPutNeedTheOverride() throws Exception {
        String user = pinned.create("users", Json.read("""
                {"username": "f4-user", "enabled": true,
                 "credentials": [{"type": "password", "value": "%s", "temporary": false}]}""".formatted(secret())));
        String client = confidentialClient("f4-secret-put", secret());
        JsonNode userBefore = pinned.get("users/" + user);
        JsonNode clientBefore = pinned.get("clients/" + client);
        JsonNode credentialsBefore = pinned.get("users/" + user + "/credentials");
        JsonNode secretBefore = pinned.get("clients/" + client + "/client-secret");
        ObjectNode password = ((ObjectNode) userBefore.deepCopy());
        password.set("credentials", Json.read("""
                [{"type": "password", "value": "%s", "temporary": false}]""".formatted(secret())));
        ObjectNode newSecret = ((ObjectNode) clientBefore.deepCopy()).put("secret", secret());
        try (RecordingProxy proxy = RecordingProxy.start(env.serverUrl()); KeycloakMcpProcess mcp = start(proxy, WRITER)) {
            int events = events().size();
            Map<String, String> userPath = Map.of("user-id", user);
            Map<String, String> clientPath = Map.of("client-uuid", client);
            Result passwordPut = run(mcp, true, Step.of(UPDATE_USER, args(userPath, password))
                    .compensatedBy(Step.of(UPDATE_USER, args(userPath, userBefore))));
            Result secretPut = run(mcp, true, Step.of(UPDATE_CLIENT, args(clientPath, newSecret))
                    .compensatedBy(Step.of(UPDATE_CLIENT, args(clientPath, clientBefore))));
            assertAll(
                    () -> assertTrue(passwordPut.refused(), () -> "a user PUT that sets a password: " + passwordPut.text()),
                    () -> assertTrue(secretPut.refused(), () -> "a client PUT that sets the secret: " + secretPut.text()),
                    () -> assertEquals(credentialsBefore, pinned.get("users/" + user + "/credentials"), "stored credentials"),
                    () -> assertEquals(secretBefore, pinned.get("clients/" + client + "/client-secret"), "stored client secret"),
                    () -> assertEquals(events, events().size(), "admin events"));
        }
    }

    // --- redaction ----------------------------------------------------------------------------------------------

    @Test
    void withRedactionOffReadsEqualTheServer() throws Exception {
        String client = confidentialClient("f4-unredacted", secret());
        try (RecordingProxy proxy = RecordingProxy.start(env.serverUrl()); KeycloakMcpProcess mcp = start(proxy, Map.of())) {
            Map<String, String> path = Map.of("client-uuid", client);
            ReadComparison representation = compareRead(mcp, READ_CLIENT, path, "clients/" + client);
            ReadComparison secret = compareRead(mcp, READ_CLIENT_SECRET, path, "clients/" + client + "/client-secret");
            ReadComparison realm = compareRead(mcp, READ_REALM, Map.of(), "");
            assertAll(
                    () -> assertTrue(representation.equivalent(), () -> "client: " + describe(representation)),
                    () -> assertTrue(secret.equivalent(), () -> "client secret: " + describe(secret)),
                    () -> assertTrue(realm.equivalent(), () -> "realm: " + describe(realm)));
        }
    }

    /** Redaction on: as keycloak-mcp ships it, and as an operator sets it. */
    static Stream<Named<Map<String, String>>> redactionOn() {
        return Stream.of(Named.of("switch unset (shipped default)", SHIPPED_REDACTION),
                Named.of("switch set to false", REDACTED));
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("redactionOn")
    void withRedactionOnNoSecretIsShown(Map<String, String> redaction) throws Exception {
        String secret = secret();
        String client = confidentialClient(unique("f4-redacted"), secret);
        try (RecordingProxy proxy = RecordingProxy.start(env.serverUrl()); KeycloakMcpProcess mcp = start(proxy, redaction)) {
            JsonNode args = args(Map.of("client-uuid", client), null);
            ToolResult representation = read(mcp, READ_CLIENT, args);
            ToolResult secretEndpoint = read(mcp, READ_CLIENT_SECRET, args);
            assertAll(
                    () -> assertFalse(representation.isError(), representation::text),
                    () -> assertTrue(representation.json().path("value").path("secret").isTextual(), "the secret keeps its type"),
                    () -> assertFalse(representation.text().contains(secret), "the client representation shows the secret"),
                    () -> assertFalse(secretEndpoint.text().contains(secret), "the client-secret endpoint shows the secret"));
        }
    }

    @Test
    @RequiresNodeFixes({"BC-02", "SEC-8", "MCPLIVE-02"})
    void withRedactionOnOnlySecretsAreHidden() throws Exception {
        String client = confidentialClient("f4-precise", secret());
        try (RecordingProxy proxy = RecordingProxy.start(env.serverUrl());
             KeycloakMcpProcess mcp = start(proxy, SHIPPED_REDACTION)) {
            ReadComparison representation = compareRead(mcp, READ_CLIENT, Map.of("client-uuid", client), "clients/" + client);
            // The server masks the SMTP password itself (RealmAdminResource.java:431, ModelToRepresentation.java:692-694,
            // StripSecretsUtils.java:189-193), so nothing in the realm representation is left for keycloak-mcp to hide.
            ReadComparison realm = compareRead(mcp, READ_REALM, Map.of(), "");
            assertAll(
                    () -> assertTrue(representation.referenceStable() && realm.referenceStable(),
                            "the server's answers held still"),
                    () -> assertEquals(List.of("VALUE $.secret"), changedPaths(representation),
                            "fields a redacted client read changes"),
                    () -> assertEquals(List.of(), changedPaths(realm), "fields a redacted realm read changes"));
        }
    }

    @Test
    @RequiresNodeFixes({"BC-01", "SEC-1"})
    void aRedactedValueNeverReplacesTheSecret() throws Exception {
        String secret = secret();
        String client = confidentialClient("f4-round-trip", secret);
        Map<String, String> switches = Map.of(ALLOW_WRITE, "true", SINGLE_WRITER, "true", ALLOW_SENSITIVE_READS, "false");
        try (RecordingProxy proxy = RecordingProxy.start(env.serverUrl()); KeycloakMcpProcess mcp = start(proxy, switches)) {
            Map<String, String> path = Map.of("client-uuid", client);
            JsonNode asRead = value(mcp, READ_CLIENT, path);
            ObjectNode edited = ((ObjectNode) asRead.deepCopy()).put("description", "edited through a redacted read");
            Result roundTrip = run(mcp, true, Step.of(UPDATE_CLIENT, args(path, edited))
                    .compensatedBy(Step.of(UPDATE_CLIENT, args(path, asRead))));
            assertAll(
                    () -> assertEquals(secret, pinned.get("clients/" + client + "/client-secret").path("value").asText(),
                            () -> "stored secret after the round trip (" + roundTrip.text() + ")"),
                    () -> assertEquals(200, clientCredentialsGrant("f4-round-trip", secret), "a grant with the real secret"));
        }
    }

    // --- workflow execution ---------------------------------------------------------------------------------------

    @Test
    void aFailedMutationIsInDoubtAndEarlierStepsAreCompensated() throws Exception {
        String group = pinned.create("groups", Json.read("""
                {"name": "f4-compensated", "attributes": {"origin": ["seed"]}}"""));
        JsonNode groupBefore = pinned.get("groups/" + group);
        try (RecordingProxy proxy = RecordingProxy.start(env.serverUrl()); KeycloakMcpProcess mcp = start(proxy, WRITER)) {
            State before = state();
            List<JsonNode> eventsBefore = events();
            Result run = run(mcp, true, createGroup("f4-created-then-undone"),
                    Step.of(UPDATE_GROUP, groupArgs(group, Json.read("""
                            {"name": "f4-compensated", "attributes": {"origin": ["changed"]}}""")))
                            .compensatedBy(Step.of(UPDATE_GROUP, groupArgs(group, groupBefore))),
                    createGroup(TAKEN_GROUP));
            JsonNode report = run.report();
            assertAll(
                    () -> assertEquals(KeycloakMcpWorkflow.IN_DOUBT, run.status(), run::text),
                    () -> assertEquals(CREATE_GROUP, report.path("failedOperation").asText()),
                    () -> assertEquals(409, run.failureStatus(), "the failed step's status"),
                    // A failed mutation response does not prove the server skipped the write.
                    () -> assertTrue(report.path("failedStepMayHaveCommitted").asBoolean(false), "failedStepMayHaveCommitted"),
                    () -> assertTrue(report.path("priorStepsCompensated").asBoolean(false), "priorStepsCompensated"),
                    () -> assertEquals(List.of(UPDATE_GROUP + " COMPENSATED", DELETE_GROUP + " COMPENSATED"), rollback(report)),
                    () -> assertEquals(List.of(new StepRun(CREATE_GROUP, 201), new StepRun(UPDATE_GROUP, 204)), run.completed()),
                    () -> assertEquals(before.groups(), state().groups(), "groups after compensation"),
                    () -> assertEquals(groupBefore, pinned.get("groups/" + group), "the updated group after compensation"),
                    () -> assertEquals(List.of("CREATE", "UPDATE", "UPDATE", "DELETE"),
                            newEvents(eventsBefore).stream().map(e -> e.split(" ")[0]).toList(), "admin events, oldest first"));
        }
    }

    @Test
    void aFailedReadIsInDoubtButNotCommitted() throws Exception {
        String group = pinned.create("groups", Json.read("""
                {"name": "f4-read-failure"}"""));
        JsonNode groupBefore = pinned.get("groups/" + group);
        try (RecordingProxy proxy = RecordingProxy.start(env.serverUrl()); KeycloakMcpProcess mcp = start(proxy, WRITER)) {
            Result run = run(mcp, true, renameGroup(group, "f4-read-failure-renamed"), failingRead());
            JsonNode report = run.report();
            assertAll(
                    () -> assertEquals(KeycloakMcpWorkflow.IN_DOUBT, run.status(), run::text),
                    () -> assertEquals(READ_GROUP, report.path("failedOperation").asText()),
                    () -> assertFalse(report.path("failedStepMayHaveCommitted").asBoolean(true), "a read cannot have committed"),
                    () -> assertTrue(report.path("priorStepsCompensated").asBoolean(false), "priorStepsCompensated"),
                    () -> assertEquals(List.of(UPDATE_GROUP + " COMPENSATED"), rollback(report)),
                    () -> assertEquals(groupBefore, pinned.get("groups/" + group), "the group after compensation"));
        }
    }

    @Test
    void locationIdBindsTheResourceTheServerCreated() throws Exception {
        try (RecordingProxy proxy = RecordingProxy.start(env.serverUrl()); KeycloakMcpProcess mcp = start(proxy, WRITER)) {
            State before = state();
            List<JsonNode> eventsBefore = events();
            Result run = run(mcp, true, createGroup("f4-located"), failingRead());
            String created = createdGroup(eventsBefore);
            JsonNode undo = run.report().path("rollback").path(0);
            assertAll(
                    () -> assertEquals(KeycloakMcpWorkflow.COMPENSATED, undo.path("outcome").asText(), run::text),
                    () -> assertEquals(List.of(created), pathValues(undo), "the compensation's path values"),
                    () -> assertEquals(404, status("groups/" + created), "the created group after compensation"),
                    () -> assertEquals(before.groups(), state().groups(), "groups after compensation"));
        }
    }

    @Test
    void responseIdBindsTheResourceTheServerCreated() throws Exception {
        String scopes = "clients/" + authzClient + "/authz/resource-server/scope";
        try (RecordingProxy proxy = RecordingProxy.start(env.serverUrl()); KeycloakMcpProcess mcp = start(proxy, WRITER)) {
            JsonNode before = pinned.get(scopes);
            Result run = run(mcp, true, createScope("f4-new-scope"), failingRead());
            JsonNode undo = run.report().path("rollback").path(0);
            assertAll(
                    () -> assertEquals(KeycloakMcpWorkflow.COMPENSATED, undo.path("outcome").asText(), run::text),
                    () -> assertTrue(pathValues(undo).stream().noneMatch(ids(before)::contains),
                            () -> "the compensation targeted a scope that existed before: " + undo),
                    () -> assertEquals(before, pinned.get(scopes), "scopes after compensation"));
        }
    }

    @Test
    @RequiresNodeFixes("WF-01")
    void responseIdNeverBindsAResourceThatExistedBefore() throws Exception {
        String scopes = "clients/" + authzClient + "/authz/resource-server/scope";
        try (RecordingProxy proxy = RecordingProxy.start(env.serverUrl()); KeycloakMcpProcess mcp = start(proxy, WRITER)) {
            JsonNode before = pinned.get(scopes);
            // Creating a scope whose name is taken answers 201 with the existing scope (RepresentationToModel.java:1789-1807).
            Result run = run(mcp, true, createScope("f4-existing-scope"), failingRead());
            assertEquals(before, pinned.get(scopes), () -> "scopes after the run (" + run.text() + ")");
        }
    }

    @Test
    @RequiresNodeFixes("MCPLIVE-12")
    void aCompletedRunNamesTheResourcesItCreated() throws Exception {
        try (RecordingProxy proxy = RecordingProxy.start(env.serverUrl()); KeycloakMcpProcess mcp = start(proxy, WRITER)) {
            List<JsonNode> eventsBefore = events();
            Result run = run(mcp, true, createGroup("f4-named"));
            String created = createdGroup(eventsBefore);
            assertAll(
                    () -> assertEquals(KeycloakMcpWorkflow.COMPLETED, run.status(), run::text),
                    () -> assertTrue(run.report().path("completed").path(0).toString().contains(created),
                            () -> "the completed step does not name the created group " + created + ": " + run.text()));
        }
    }

    @Test
    void everyRunLeavesAPrivateReceipt() throws Exception {
        String group = pinned.create("groups", Json.read("""
                {"name": "f4-receipts"}"""));
        String canary = "f4-canary-" + secret();
        JsonNode original = pinned.get("groups/" + group);
        Step update = Step.of(UPDATE_GROUP, groupArgs(group, Json.read("""
                {"name": "f4-receipts", "attributes": {"canary": ["%s"]}}""".formatted(canary))))
                .compensatedBy(Step.of(UPDATE_GROUP, groupArgs(group, original)));
        try (RecordingProxy proxy = RecordingProxy.start(env.serverUrl()); KeycloakMcpProcess mcp = start(proxy, WRITER)) {
            Result completed = run(mcp, true, update);
            Result inDoubt = run(mcp, true, update, failingRead());
            Path journal = mcp.journalDir();
            Map<String, JsonNode> receipts = receipts(journal);
            JsonNode first = receipts.get(completed.report().path("runId").asText() + ".json");
            JsonNode second = receipts.get(inDoubt.report().path("runId").asText() + ".json");
            String everything = receipts.values().stream().map(JsonNode::toString).collect(Collectors.joining());
            assertAll(
                    () -> assertEquals("rwx------", permissions(journal), "journal directory"),
                    () -> assertEquals(2, receipts.size(), () -> "one receipt per run, nothing else: " + receipts.keySet()),
                    () -> assertTrue(receipts.keySet().stream().allMatch(f -> permissions(journal.resolve(f)).equals("rw-------")),
                            "every receipt is private (0600)"),
                    () -> assertReceipt(first, completed, KeycloakMcpWorkflow.COMPLETED),
                    () -> assertReceipt(second, inDoubt, KeycloakMcpWorkflow.IN_DOUBT),
                    () -> assertEquals(List.of(UPDATE_GROUP + " COMPENSATED"), rollback(second)),
                    () -> assertFalse(everything.contains(canary), "a receipt holds a request body value"),
                    () -> assertFalse(everything.contains(env.serviceAccount().clientSecret()),
                            "a receipt holds the client secret"));
        }
    }

    @Test
    @RequiresNodeFixes("MCPLIVE-01")
    void closingStdinEndsTheServerCleanly() throws Exception {
        try (KeycloakMcpProcess mcp = env.startKeycloakMcp(pinned.realm(), Map.of())) {
            ToolResult search = mcp.client().callTool("keycloak_search_operations",
                    McpStdioClient.JSON.createObjectNode().put("limit", 1));
            int exit = mcp.client().shutdown(Duration.ofSeconds(10));
            assertAll(
                    () -> assertFalse(search.isError(), search::text),
                    () -> assertEquals(0, exit, () -> "exit code; stderr: " + mcp.client().stderr()));
        }
    }

    // --- helpers ------------------------------------------------------------------------------------------------

    /** What a refusal must leave as it was: the realm's admin events and its groups. */
    private record State(int adminEvents, JsonNode groups) {
    }

    private static State state() throws Exception {
        return new State(events().size(), pinned.get("groups?briefRepresentation=false&first=0&max=1000"));
    }

    private static KeycloakMcpProcess start(RecordingProxy proxy, Map<String, String> switches) throws Exception {
        return env.startKeycloakMcp(pinned.realm(), switches, proxy.baseUrl());
    }

    private static ToolResult read(KeycloakMcpProcess mcp, String operation, JsonNode args) throws Exception {
        ObjectNode call = McpStdioClient.JSON.createObjectNode().put("operation", operation);
        call.set("args", args);
        return mcp.client().callTool("keycloak_read", call);
    }

    /** The value of a successful {@code keycloak_read}. */
    private static JsonNode value(KeycloakMcpProcess mcp, String operation, Map<String, String> path) throws Exception {
        ToolResult result = read(mcp, operation, args(path, null));
        if (result.isError()) {
            throw new AssertionError(operation + " failed: " + result.text());
        }
        return result.json().path("value");
    }

    private static Result run(KeycloakMcpProcess mcp, boolean execute, Step... steps) throws Exception {
        return KeycloakMcpWorkflow.call(mcp.client(), List.of(steps), execute);
    }

    /** Step arguments; the pinned realm is left to keycloak-mcp unless {@code path} names one. */
    private static ObjectNode args(Map<String, String> path, JsonNode body) {
        ObjectNode args = JsonNodeFactory.instance.objectNode();
        ObjectNode named = args.putObject("path");
        path.forEach(named::put);
        if (body != null) {
            args.set("body", body);
        }
        return args;
    }

    private static ObjectNode groupArgs(String group) {
        return args(Map.of("group-id", group), null);
    }

    private static ObjectNode groupArgs(String group, JsonNode body) {
        return args(Map.of("group-id", group), body);
    }

    private static Step createGroup(String name) {
        return Step.of(CREATE_GROUP, args(Map.of(), Json.read("""
                {"name": "%s"}""".formatted(name))))
                .compensatedBy(Step.of(DELETE_GROUP, groupArgs(KeycloakMcpWorkflow.LOCATION_ID)));
    }

    private static Step renameGroup(String group, String name) {
        JsonNode before = pinned.get("groups/" + group);
        return Step.of(UPDATE_GROUP, groupArgs(group, ((ObjectNode) before.deepCopy()).put("name", name)))
                .compensatedBy(Step.of(UPDATE_GROUP, groupArgs(group, before)));
    }

    private static Step createScope(String name) {
        return Step.of(CREATE_SCOPE, args(Map.of("client-uuid", authzClient), Json.read("""
                {"name": "%s"}""".formatted(name))))
                .compensatedBy(Step.of(DELETE_SCOPE, args(Map.of("client-uuid", authzClient,
                        "scope-id", KeycloakMcpWorkflow.RESPONSE_ID), null)));
    }

    /** A step that fails without writing: a read of a group nothing has. */
    private static Step failingRead() {
        return Step.of(READ_GROUP, groupArgs(ABSENT));
    }

    private static String confidentialClient(String clientId, String secret) {
        return pinned.create("clients", Json.read("""
                {"clientId": "%s", "publicClient": false, "secret": "%s", "serviceAccountsEnabled": true,
                 "standardFlowEnabled": false}""".formatted(clientId, secret)));
    }

    private static List<JsonNode> events() throws Exception {
        return AdminEvents.of(env.http(), pinned.realm());
    }

    /** Admin events recorded since {@code before} was read, oldest first, as {@code OPERATION resourcePath}. */
    private static List<String> newEvents(List<JsonNode> before) throws Exception {
        List<JsonNode> all = events();
        List<String> added = new ArrayList<>(AdminEvents.summary(all.subList(0, all.size() - before.size())));
        Collections.reverse(added);
        return added;
    }

    /** The id of the one group created since {@code before}, from its CREATE admin event. */
    private static String createdGroup(List<JsonNode> before) throws Exception {
        List<String> created = newEvents(before).stream().filter(e -> e.startsWith("CREATE groups/"))
                .map(e -> e.substring("CREATE groups/".length())).toList();
        assertEquals(1, created.size(), () -> "group creations: " + created);
        return created.getFirst();
    }

    private static int status(String path) throws Exception {
        String url = "/admin/realms/" + pinned.realm() + "/" + path;
        return env.http().send("GET", url, Map.of("Accept", "application/json"), null).status();
    }

    /**
     * keycloak-mcp's read against the server's own answer to {@code GET /admin/realms/{realm}/<below>}, judged only
     * against a server answer that held still (the server orders some lists differently from one read to the next).
     */
    private static ReadComparison compareRead(KeycloakMcpProcess mcp, String operation, Map<String, String> path,
                                              String below) throws Exception {
        String url = "/admin/realms/" + pinned.realm() + (below.isEmpty() ? "" : "/" + below);
        return ReadComparison.run(() -> {
            RawHttp.Response r = env.http().send("GET", url, Map.of("Accept", "application/json"), null);
            return Observation.ofHttp(r.status(), r.header("Content-Type"), r.body());
        }, () -> KeycloakMcpReads.read(mcp.client(), operation, args(path, null)), UnaryOperator.identity(), 3);
    }

    /** Where keycloak-mcp's answer differs from the server's, as {@code KIND path}. */
    private static List<String> changedPaths(ReadComparison comparison) {
        return comparison.differences().stream().map(d -> d.kind() + " " + d.path()).toList();
    }

    private static String describe(ReadComparison comparison) {
        return "server " + comparison.reference() + ", keycloak-mcp " + comparison.subject() + ", differences "
                + comparison.differences() + ", server instability " + comparison.instability();
    }

    /** {@code operation outcome} of each compensation in a run's rollback. */
    private static List<String> rollback(JsonNode report) {
        List<String> out = new ArrayList<>();
        report.path("rollback").forEach(r -> out.add(r.path("operation").asText() + " " + r.path("outcome").asText()));
        return out;
    }

    /** The path values a rollback entry's compensation was sent with. */
    private static List<String> pathValues(JsonNode rollbackEntry) {
        List<String> out = new ArrayList<>();
        rollbackEntry.path("path").forEach(v -> out.add(v.asText()));
        return out;
    }

    private static List<String> ids(JsonNode representations) {
        List<String> out = new ArrayList<>();
        representations.forEach(r -> out.add(r.path("id").asText()));
        return out;
    }

    /** Requests that do not address the pinned realm, or that carry a dot segment once decoded. */
    private static List<String> outsidePinnedRealm(RecordingProxy proxy) {
        String prefix = "/admin/realms/" + pinned.realm();
        return proxy.adminRequests().stream()
                .filter(r -> !(r.rawPath().equals(prefix) || r.rawPath().startsWith(prefix + "/")) || hasDotSegment(r.rawPath()))
                .map(RecordingProxy.Request::toString).toList();
    }

    private static boolean hasDotSegment(String rawPath) {
        return Stream.of(rawPath.split("/")).map(SafetySemanticsIT::decode).anyMatch(s -> s.equals(".") || s.equals(".."));
    }

    private static void answeredInsidePinnedRealm(ToolResult result, String attempt, List<String> escaped) {
        if (!result.isError() || result.text().contains(otherGroup) || result.text().contains("f4-other-group")) {
            escaped.add(attempt + " -> " + preview(result.text()));
        }
    }

    private static String decode(String segment) {
        return URLDecoder.decode(segment.replace("+", "%2B"), StandardCharsets.UTF_8);
    }

    private static int clientCredentialsGrant(String clientId, String secret) throws IOException, InterruptedException {
        String form = "grant_type=client_credentials&client_id=" + URLEncoder.encode(clientId, StandardCharsets.UTF_8)
                + "&client_secret=" + URLEncoder.encode(secret, StandardCharsets.UTF_8);
        HttpRequest request = HttpRequest.newBuilder(URI.create(env.serverUrl() + "/realms/" + pinned.realm()
                        + "/protocol/openid-connect/token"))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(form)).build();
        try (HttpClient http = HttpClient.newHttpClient()) {
            return http.send(request, HttpResponse.BodyHandlers.discarding()).statusCode();
        }
    }

    private static Map<String, JsonNode> receipts(Path journal) throws IOException {
        Map<String, JsonNode> out = new HashMap<>();
        try (Stream<Path> files = Files.list(journal)) {
            for (Path f : files.toList()) {
                out.put(f.getFileName().toString(), Json.read(Files.readString(f)));
            }
        }
        return out;
    }

    private static void assertReceipt(JsonNode receipt, Result run, String status) {
        assertAll("receipt of " + run.report().path("runId").asText(),
                () -> assertEquals(status, receipt.path("status").asText()),
                () -> assertEquals(run.report().path("runId"), receipt.path("runId")),
                () -> assertEquals(pinned.realm(), receipt.path("realm").asText()),
                () -> assertEquals(UPDATE_GROUP, receipt.path("plan").path(0).path("operation").asText()),
                () -> assertEquals(UPDATE_GROUP, receipt.path("plan").path(0).path("compensation").asText()),
                () -> assertEquals(204, receipt.path("completed").path(0).path("status").asInt()));
    }

    private static String permissions(Path path) {
        try {
            return PosixFilePermissions.toString(Files.getPosixFilePermissions(path));
        } catch (IOException e) {
            throw new AssertionError("Cannot read the permissions of " + path, e);
        }
    }

    /** {@code prefix} made unique within the pinned realm, for a check that runs more than once. */
    private static String unique(String prefix) {
        return prefix + "-" + secret().substring(0, 8);
    }

    private static String secret() {
        byte[] b = new byte[16];
        RANDOM.nextBytes(b);
        return HexFormat.of().formatHex(b);
    }

    private static String preview(String text) {
        return text.length() > 200 ? text.substring(0, 197) + "..." : text;
    }
}
