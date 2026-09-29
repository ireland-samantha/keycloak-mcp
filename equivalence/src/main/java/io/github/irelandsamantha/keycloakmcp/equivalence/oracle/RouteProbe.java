package io.github.irelandsamantha.keycloakmcp.equivalence.oracle;

import io.github.irelandsamantha.keycloakmcp.equivalence.fixtures.PathValues;
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

/**
 * Asks the live server whether it routes an operation at all, with fixture values bound by position.
 *
 * <p>"Not routed" is the generic JAX-RS miss, {@code 404 {"error":"HTTP 404 Not Found"}} (the default message of a
 * message-less {@code NotFoundException}, rendered by {@code KeycloakErrorHandler.java:80-96,155-156}), or
 * {@code 405}. Any other answer, including 4xx/5xx with a specific error, proves the method was matched. Keycloak
 * itself throws message-less {@code NotFoundException}s for some missing entities (authorization policies,
 * {@code PolicyResourceService.java:68-69}; organization members, {@code OrganizationMemberResource.java:430-435}),
 * so the verdict is only meaningful with seeded values, and the constructor's {@code jsonBodies} supply real bodies
 * where the server reads the raw entity.
 *
 * <p>Requests declaring JSON get a malformed JSON body: reading the entity or parsing it inside the method fails,
 * and the error handler rolls the transaction back ({@code KeycloakErrorHandler.java:67}), so nothing changes. Other
 * mutations do run; they are ordered so the fixtures they destroy are not needed afterwards: reads and malformed
 * bodies first, then other POST/PUT, then DELETEs deepest path first, leaving {@code DELETE /admin/realms/{realm}}
 * for last.
 */
public final class RouteProbe {

    public enum Verdict { ROUTED, GENERIC_MISS, UNAUTHORIZED }

    /**
     * @param consumes request media types any source declares; decides how a body is (mis)formed
     */
    public record Target(String key, String method, String template, Set<String> consumes) {
    }

    /**
     * @param sent     what the probe sent as entity ("none", "malformed JSON", ...)
     * @param response excerpt of the response body
     */
    public record Result(String key, String method, String template, List<String> pathValues, String sent, int status,
                         String response, Verdict verdict) {
    }

    public static final String GENERIC_MISS_BODY = "{\"error\":\"HTTP 404 Not Found\"}";

    private static final int EXCERPT = 200;
    private static final String MULTIPART_BOUNDARY = "equivalence-probe";

    private final RawHttp http;
    private final PathValues values;
    private final Map<String, String> jsonBodies;

    /** @param jsonBodies real JSON bodies by operation key, for operations a malformed body cannot probe */
    public RouteProbe(RawHttp http, PathValues values, Map<String, String> jsonBodies) {
        this.http = http;
        this.values = values;
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
        List<String> pathValues = values.valuesFor(t.template());
        String path = PathTemplates.expand(t.template(), (position, v) -> RawHttp.segment(pathValues.get(position)));
        Body body = body(t);
        Map<String, String> headers = body.contentType() == null ? Map.of("Accept", "*/*")
                : Map.of("Accept", "*/*", "Content-Type", body.contentType());
        RawHttp.Response response = http.send(t.method(), path, headers, body.bytes());
        String text = response.text().strip();
        return new Result(t.key(), t.method(), t.template(), pathValues, body.description(), response.status(),
                text.length() > EXCERPT ? text.substring(0, EXCERPT) + "..." : text, verdict(response.status(), text));
    }

    static Verdict verdict(int status, String body) {
        if (status == 405 || (status == 404 && GENERIC_MISS_BODY.equals(body))) {
            return Verdict.GENERIC_MISS;
        }
        return status == 401 || status == 403 ? Verdict.UNAUTHORIZED : Verdict.ROUTED;
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
