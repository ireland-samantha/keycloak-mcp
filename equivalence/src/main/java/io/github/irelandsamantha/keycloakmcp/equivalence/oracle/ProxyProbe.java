package io.github.irelandsamantha.keycloakmcp.equivalence.oracle;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.Endpoint;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.ParamSpec;
import jakarta.ws.rs.client.Client;
import jakarta.ws.rs.client.ClientRequestContext;
import jakarta.ws.rs.client.ClientRequestFilter;
import jakarta.ws.rs.core.Form;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import org.keycloak.admin.client.Keycloak;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Verifies the static walk against the real RESTEasy client proxy, without a server: every endpoint is invoked
 * through {@link ReflectiveInvoker} with synthetic values, a {@link ClientRequestFilter} records the outgoing
 * request and aborts it. The recorded method, path, query names, form fields, Content-Type and Accept are
 * compared with what the walker predicted.
 */
public final class ProxyProbe {

    public record Captured(String method, String rawPath, String path, Set<String> queryNames, Set<String> formNames,
                           String contentType, List<String> accept, String entityType) {
    }

    public record Result(String key, String javaChain, List<String> problems, List<String> notes, Captured captured,
                         String error) {
        boolean clean() {
            return problems.isEmpty() && error == null;
        }
    }

    public record Summary(int probed, int matched, int mismatched, int errors, Map<String, Long> problemKinds,
                          Map<String, Long> noteKinds, List<Result> nonMatching, List<Result> withNotes) {
    }

    private static final URI BASE = URI.create("http://proxy-probe.invalid");

    public Summary run(List<Endpoint> endpoints) {
        if (endpoints.isEmpty()) {
            return summarise(List.of());
        }
        CaptureFilter capture = new CaptureFilter();
        Client client = Keycloak.getClientProvider().newRestEasyClient(null, null, false);
        client.register(capture);
        // RESTEasy's ProxyBuilder defines java.lang.reflect.Proxy classes with the thread context class loader;
        // it must see the interfaces being probed (matters when they come from an isolated loader).
        Thread thread = Thread.currentThread();
        ClassLoader previous = thread.getContextClassLoader();
        thread.setContextClassLoader(endpoints.getFirst().terminal().javaMethod().getDeclaringClass().getClassLoader());
        try {
            ReflectiveInvoker invoker = new ReflectiveInvoker(
                    iface -> Keycloak.getClientProvider().targetProxy(client.target(BASE), iface), new ObjectMapper());
            List<Result> results = endpoints.stream().map(e -> probe(invoker, capture, e)).toList();
            return summarise(results);
        } finally {
            thread.setContextClassLoader(previous);
            client.close();
        }
    }

    private Result probe(ReflectiveInvoker invoker, CaptureFilter capture, Endpoint e) {
        capture.last = null;
        String error = null;
        List<String> notes = new ArrayList<>();
        try {
            invoker.invoke(e, SyntheticValues.forEndpoint(e));
        } catch (Throwable t) {
            if (capture.last == null) {
                error = t.getClass().getSimpleName() + ": " + t.getMessage();
            } else {
                notes.add("post-capture " + t.getClass().getSimpleName() + " (aborted 204 vs " + e.returnKind() + ")");
            }
        }
        Captured c = capture.last;
        List<String> problems = c == null ? List.of() : compare(e, c, notes);
        return new Result(e.key(), e.javaChain(), problems, notes, c, error);
    }

    private static List<String> compare(Endpoint e, Captured c, List<String> notes) {
        List<String> problems = new ArrayList<>();
        if (!e.httpMethod().equals(c.method())) {
            problems.add("method: walked " + e.httpMethod() + ", proxy sent " + c.method());
        }
        String sentTemplate = c.path();
        for (int i = 0; i < e.pathParams().size(); i++) {
            sentTemplate = sentTemplate.replace(SyntheticValues.pathMarker(i), "{" + e.pathParams().get(i) + "}");
        }
        if (!e.pathTemplate().equals(sentTemplate)) {
            problems.add("path: walked " + e.pathTemplate() + ", proxy sent " + sentTemplate);
        }
        if (c.rawPath().contains("%")) {
            notes.add("percent-encoded raw path: " + c.rawPath());
        }
        Set<String> walkedQuery = names(e, ParamSpec.Source.QUERY);
        if (!walkedQuery.equals(c.queryNames())) {
            problems.add("query: walked " + walkedQuery + ", proxy sent " + c.queryNames());
        }
        Set<String> walkedForm = names(e, ParamSpec.Source.FORM);
        if (!walkedForm.isEmpty() && !walkedForm.equals(c.formNames())) {
            problems.add("form: walked " + walkedForm + ", proxy sent " + c.formNames());
        }
        boolean sendsEntity = c.entityType() != null;
        if (sendsEntity) {
            if (e.consumes().isEmpty()) {
                notes.add("no @Consumes; proxy sent Content-Type " + c.contentType());
            } else if (!sameMedia(e.consumes().getFirst(), c.contentType())) {
                problems.add("content-type: walked " + e.consumes() + ", proxy sent " + c.contentType());
            } else if (e.consumes().size() > 1) {
                notes.add("multiple @Consumes " + e.consumes() + "; proxy picked " + c.contentType());
            }
        } else if (!e.params(ParamSpec.Source.BODY).isEmpty()) {
            notes.add("entity parameter present but proxy sent no entity");
        }
        List<String> walkedAccept = e.produces().stream().map(ProxyProbe::bare).toList();
        List<String> sentAccept = c.accept().stream().map(ProxyProbe::bare).toList();
        if (!walkedAccept.equals(sentAccept) && !(walkedAccept.isEmpty() && sentAccept.equals(List.of("*/*")))) {
            problems.add("accept: walked " + walkedAccept + ", proxy sent " + sentAccept);
        }
        if (walkedAccept.isEmpty()) {
            notes.add("no @Produces; proxy Accept " + sentAccept);
        }
        return problems;
    }

    private static Summary summarise(List<Result> results) {
        List<Result> bad = results.stream().filter(r -> !r.clean()).toList();
        List<Result> noted = results.stream().filter(r -> r.clean() && !r.notes().isEmpty()).toList();
        long errors = results.stream().filter(r -> r.error() != null).count();
        return new Summary(results.size(), results.size() - bad.size(), (int) (bad.size() - errors), (int) errors,
                countKinds(results.stream().flatMap(r -> r.problems().stream())),
                countKinds(results.stream().flatMap(r -> r.notes().stream())),
                bad, noted);
    }

    private static Map<String, Long> countKinds(Stream<String> messages) {
        return messages.map(ProxyProbe::kind).collect(Collectors.groupingBy(k -> k, TreeMap::new, Collectors.counting()));
    }

    /** Message prefix up to the first ':' or ';' with list payloads elided, for histogramming. */
    private static String kind(String message) {
        return message.replaceAll("\\[[^]]*]", "[..]").replaceAll("(Content-Type|Accept|sent|picked) .*", "$1 ..");
    }

    private static Set<String> names(Endpoint e, ParamSpec.Source s) {
        return e.params(s).stream().map(ParamSpec::name).collect(Collectors.toCollection(TreeSet::new));
    }

    private static boolean sameMedia(String a, String b) {
        return b != null && bare(a).equals(bare(b));
    }

    private static String bare(String media) {
        return media.split(";", 2)[0].strip().toLowerCase(Locale.ROOT);
    }

    /** Records the last outgoing request and aborts it with 204 so no network I/O happens. */
    static final class CaptureFilter implements ClientRequestFilter {
        volatile Captured last;

        @Override
        public void filter(ClientRequestContext ctx) {
            URI uri = ctx.getUri();
            String rawPath = uri.getRawPath();
            String path = decode(rawPath);
            Object entity = ctx.hasEntity() ? ctx.getEntity() : null;
            MediaType mt = ctx.getMediaType();
            last = new Captured(
                    ctx.getMethod(),
                    rawPath,
                    path,
                    queryNames(uri.getRawQuery()),
                    entity instanceof Form f ? new TreeSet<>(f.asMap().keySet()) : Set.of(),
                    mt == null ? null : mt.toString(),
                    ctx.getAcceptableMediaTypes().stream().map(MediaType::toString).toList(),
                    entity == null ? null : entity.getClass().getName());
            ctx.abortWith(Response.noContent().build());
        }

        private static Set<String> queryNames(String rawQuery) {
            Set<String> names = new TreeSet<>();
            if (rawQuery != null && !rawQuery.isEmpty()) {
                for (String pair : rawQuery.split("&")) {
                    names.add(decode(pair.split("=", 2)[0]));
                }
            }
            return names;
        }

        private static String decode(String s) {
            return URLDecoder.decode(s.replace("+", "%2B"), StandardCharsets.UTF_8);
        }
    }
}
