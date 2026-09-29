package io.github.irelandsamantha.keycloakmcp.equivalence.oracle;

import io.github.irelandsamantha.keycloakmcp.equivalence.harness.RawHttp;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.PathTemplates;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;

/**
 * Asks the live server whether it routes an operation at all, with fixture values bound by position.
 *
 * <p>"Not routed" is the generic JAX-RS miss, {@code 404 {"error":"HTTP 404 Not Found"}} (the default message of a
 * message-less {@code NotFoundException}, rendered by {@code KeycloakErrorHandler.java:80-96,155-156}), or
 * {@code 405}. A 2xx proves the resource method was matched. A specific error does not on its own: a sub-resource
 * locator validates its path variable before any sub-path, HTTP method or entity reader is matched
 * ({@code WorkflowsResource.java:96-114}, {@code OrganizationGroupsResource.java:257-270}), so every request below
 * an unknown id gets the locator's answer, whether or not the operation exists. The probe therefore repeats a
 * request that got a specific error one segment deeper ({@link #CONTROL_SEGMENT}, same method and body): if that
 * control gets the same answer verbatim, the answer came from the shared prefix and the verdict is
 * {@link Verdict#INCONCLUSIVE}; the operation needs a seeded value or a documented reason.
 *
 * <p>Keycloak itself throws message-less {@code NotFoundException}s for some missing entities (authorization
 * policies, {@code PolicyResourceService.java:68-69}; organization members, {@code OrganizationMemberResource.java:430-435}),
 * so the verdict is only meaningful with seeded values, and the constructor's {@code jsonBodies} supply real bodies
 * where the server reads the raw entity.
 *
 * <p>Requests declaring JSON get a malformed JSON body: reading the entity or parsing it inside the method fails,
 * and the error handler rolls the transaction back ({@code KeycloakErrorHandler.java:67}), so nothing changes. Other
 * mutations do run; they are ordered so the fixtures they destroy are not needed afterwards: reads and malformed
 * bodies first, then other POST/PUT, then DELETEs deepest path first, leaving {@code DELETE /admin/realms/{realm}}
 * for last. A control request ends in a name nothing in the realm has, so it finds nothing to change.
 */
public final class RouteProbe {

    public enum Verdict {
        /** The server matched the operation: a 2xx, or a specific error the control request did not get. */
        ROUTED,
        /** The generic JAX-RS miss or 405. */
        GENERIC_MISS,
        /** 401 or 403: the service account was refused. */
        UNAUTHORIZED,
        /** A specific error the control request got verbatim: a locator on the path answered, not the operation. */
        INCONCLUSIVE
    }

    /** Sends one request below the server root; {@code RawHttp::send} against the live server. */
    @FunctionalInterface
    public interface Transport {
        RawHttp.Response send(String method, String path, Map<String, String> headers, byte[] body)
                throws IOException, InterruptedException;
    }

    /**
     * @param consumes request media types any source declares; decides how a body is (mis)formed
     */
    public record Target(String key, String method, String template, Set<String> consumes) {
    }

    /**
     * @param sent     what the probe sent as entity ("none", "malformed JSON", ...)
     * @param response excerpt of the response body
     * @param control  status and body excerpt of the control request, {@code null} when the answer needed none
     */
    public record Result(String key, String method, String template, List<String> pathValues, String sent, int status,
                         String response, String control, Verdict verdict) {
    }

    public static final String GENERIC_MISS_BODY = "{\"error\":\"HTTP 404 Not Found\"}";

    /** Last path segment of a control request; names nothing the seeded realm holds. */
    public static final String CONTROL_SEGMENT = "equivalence-probe-control";

    private static final int EXCERPT = 200;
    private static final String MULTIPART_BOUNDARY = "equivalence-probe";

    private final Transport http;
    private final Function<String, List<String>> pathValues;
    private final Map<String, String> jsonBodies;

    /**
     * @param pathValues raw value for each variable of a template, in path order
     * @param jsonBodies real JSON bodies by operation key, for operations a malformed body cannot probe
     */
    public RouteProbe(Transport http, Function<String, List<String>> pathValues, Map<String, String> jsonBodies) {
        this.http = http;
        this.pathValues = pathValues;
        this.jsonBodies = jsonBodies;
    }

    /** Probes every target in a side-effect-safe order; results are sorted by key. */
    public List<Result> probe(Collection<Target> targets) throws IOException, InterruptedException {
        List<Target> ordered = targets.stream().sorted(Comparator.comparingInt(this::phase)
                .thenComparing(Comparator.comparingInt((Target t) -> t.method().equals("DELETE") ? -segments(t) : 0))
                .thenComparing(Target::key)).toList();
        List<Result> results = new ArrayList<>(ordered.size());
        for (Target t : ordered) {
            results.add(probe(t));
        }
        return results.stream().sorted(Comparator.comparing(Result::key)).toList();
    }

    private Result probe(Target t) throws IOException, InterruptedException {
        List<String> values = pathValues.apply(t.template());
        String path = PathTemplates.expand(t.template(), (position, v) -> RawHttp.segment(values.get(position)));
        Body body = body(t);
        Answer answer = send(t.method(), path, body);
        Verdict verdict = verdict(answer.status(), answer.body());
        Answer control = null;
        if (verdict == Verdict.ROUTED && answer.status() / 100 != 2) {
            control = send(t.method(), path + "/" + CONTROL_SEGMENT, body);
            verdict = answer.equals(control) ? Verdict.INCONCLUSIVE : Verdict.ROUTED;
        }
        return new Result(t.key(), t.method(), t.template(), values, body.description(), answer.status(),
                answer.excerpt(), control == null ? null : control.status() + " " + control.excerpt(), verdict);
    }

    /** Classifies one answer on its own; a specific error still needs the control request to count as routed. */
    static Verdict verdict(int status, String body) {
        if (status == 405 || (status == 404 && GENERIC_MISS_BODY.equals(body))) {
            return Verdict.GENERIC_MISS;
        }
        return status == 401 || status == 403 ? Verdict.UNAUTHORIZED : Verdict.ROUTED;
    }

    private Answer send(String method, String path, Body body) throws IOException, InterruptedException {
        Map<String, String> headers = body.contentType() == null ? Map.of("Accept", "*/*")
                : Map.of("Accept", "*/*", "Content-Type", body.contentType());
        RawHttp.Response response = http.send(method, path, headers, body.bytes());
        return new Answer(response.status(), response.text().strip());
    }

    /** 0: reads and malformed bodies (no effect), 1: other POST/PUT, 2: other DELETE. */
    private int phase(Target t) {
        if (t.method().equals("GET") || t.method().equals("HEAD") || body(t).inert()) {
            return 0;
        }
        return t.method().equals("DELETE") ? 2 : 1;
    }

    private Body body(Target t) {
        String json = jsonBodies.get(t.key());
        return json != null ? new Body("fixture JSON", "application/json", json.getBytes(StandardCharsets.UTF_8), false)
                : Body.forConsumes(t.method(), t.consumes());
    }

    private static int segments(Target t) {
        return t.template().split("/").length;
    }

    /** Status and complete (stripped) body of one response. */
    private record Answer(int status, String body) {
        String excerpt() {
            return body.length() > EXCERPT ? body.substring(0, EXCERPT) + "..." : body;
        }
    }

    /** What the probe sends as entity for an operation. */
    private record Body(String description, String contentType, byte[] bytes, boolean inert) {

        static Body forConsumes(String method, Set<String> consumes) {
            if (method.equals("GET") || method.equals("HEAD")) {
                return new Body("none", null, null, false);
            }
            if (consumes.contains("application/json")) {
                return new Body("malformed JSON", "application/json", "{".getBytes(StandardCharsets.UTF_8), true);
            }
            if (method.equals("DELETE")) {
                return new Body("none", null, null, false);
            }
            if (consumes.contains("multipart/form-data")) {
                return new Body("empty multipart", "multipart/form-data; boundary=" + MULTIPART_BOUNDARY,
                        ("--" + MULTIPART_BOUNDARY + "--\r\n").getBytes(StandardCharsets.UTF_8), false);
            }
            if (consumes.contains("application/x-www-form-urlencoded")) {
                return new Body("empty form", "application/x-www-form-urlencoded", new byte[0], false);
            }
            if (consumes.contains("text/plain")) {
                return new Body("text", "text/plain", "equivalence".getBytes(StandardCharsets.UTF_8), false);
            }
            return new Body("none", null, null, false);
        }
    }
}
