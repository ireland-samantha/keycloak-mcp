package io.github.irelandsamantha.keycloakmcp.equivalence.oracle;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JavaType;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.introspect.BeanPropertyDefinition;
import io.github.irelandsamantha.keycloakmcp.equivalence.compare.Observation;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.ServiceAccount;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.Endpoint;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.ParamSpec;
import jakarta.ws.rs.WebApplicationException;
import jakarta.ws.rs.client.Client;
import jakarta.ws.rs.client.ClientRequestContext;
import jakarta.ws.rs.client.ClientRequestFilter;
import jakarta.ws.rs.client.ClientResponseContext;
import jakarta.ws.rs.client.ClientResponseFilter;
import jakarta.ws.rs.core.HttpHeaders;
import jakarta.ws.rs.core.Response;
import org.keycloak.OAuth2Constants;
import org.keycloak.admin.client.Keycloak;
import org.keycloak.admin.client.KeycloakBuilder;

import java.net.URI;
import java.util.Collection;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * The secondary functional oracle: the Maven-published admin client, driven reflectively through the binding the
 * walker found, with path values bound by position. Its typed result is serialised back to JSON the way the
 * adapter serialises representations it sends ({@code JacksonProvider}: non-null properties), so it can be diffed
 * with the raw answer. Every request it sends is recorded, so the raw oracle can replay exactly that request
 * (the adapter's own query parameters, encoding and {@code Accept}).
 */
public final class AdminClientOracle implements AutoCloseable {

    /** What the adapter put on the wire for one call. */
    public record Request(String method, String pathAndQuery, String accept, String contentType) {
    }

    /** The adapter's reading of one call's answer and the request it sent; {@code request} is null if none was sent. */
    public record Answer(Observation observation, Request request) {
    }

    private static final ObjectMapper TYPED_VIEW = new ObjectMapper().setDefaultPropertyInclusion(JsonInclude.Include.NON_NULL);
    /** One step of a {@code JsonDiff} path: {@code .field} or {@code [index]}. */
    private static final Pattern PATH_STEP = Pattern.compile("\\.([^.\\[]+)|\\[\\d+]");

    private final URI server;
    private final Recorder recorder = new Recorder();
    private final Keycloak keycloak;
    private final ReflectiveInvoker invoker;

    /** Authenticates as {@code account}, the same service account keycloak-mcp and the raw oracle use. */
    public AdminClientOracle(String serverUrl, ServiceAccount account) {
        this.server = URI.create(serverUrl);
        Client client = Keycloak.getClientProvider().newRestEasyClient(null, null, false);
        client.register(recorder);
        this.keycloak = KeycloakBuilder.builder().serverUrl(serverUrl).realm(ServiceAccount.AUTH_REALM)
                .grantType(OAuth2Constants.CLIENT_CREDENTIALS).clientId(account.clientId())
                .clientSecret(account.clientSecret()).resteasyClient(client).build();
        this.invoker = new ReflectiveInvoker(iface -> keycloak.proxy(iface, server), Observation.EXACT);
    }

    /**
     * The binding to call for one operation: it must be able to send every query parameter the read uses; among
     * those, a non-deprecated, typed binding that sends the fewest parameters nobody asked for (primitive query
     * parameters are always sent) wins.
     */
    public static Optional<Endpoint> binding(Collection<Endpoint> endpoints, Set<String> queryNames) {
        return endpoints.stream()
                .filter(e -> queryNames(e).containsAll(queryNames))
                .min(Comparator.comparing(Endpoint::deprecated)
                        .thenComparing(e -> e.returnKind() != Endpoint.ReturnKind.TYPED)
                        .thenComparingLong(e -> e.params(ParamSpec.Source.QUERY).stream()
                                .filter(p -> p.primitive() && !queryNames.contains(p.name())).count())
                        .thenComparingInt(e -> e.params(ParamSpec.Source.QUERY).size())
                        .thenComparing(Endpoint::javaChain));
    }

    /**
     * Whether the array at {@code jsonPath} of the endpoint's typed result is a {@link Set} in the adapter's model:
     * Jackson reads it into a hash set, so the adapter cannot report the server's order.
     */
    public static boolean unorderedInModel(Endpoint endpoint, String jsonPath) {
        JavaType type = TYPED_VIEW.constructType(endpoint.terminal().javaMethod().getGenericReturnType());
        Matcher step = PATH_STEP.matcher(jsonPath.substring(1));
        while (type != null && step.find()) {
            String field = step.group(1);
            if (field == null || type.isMapLikeType()) {
                type = type.getContentType();
            } else {
                type = TYPED_VIEW.getSerializationConfig().introspect(type).findProperties().stream()
                        .filter(p -> p.getName().equals(field)).map(BeanPropertyDefinition::getPrimaryType)
                        .findFirst().orElse(null);
            }
        }
        return type != null && type.isCollectionLikeType() && Set.class.isAssignableFrom(type.getRawClass());
    }

    /** Calls the binding with these values; a read or a mutation alike, recording what was sent and answered. */
    public Answer call(Endpoint endpoint, List<String> pathValues, Map<String, String> query, Object body) {
        recorder.reset();
        Observation observation;
        try {
            Object result = invoker.invoke(endpoint, new ReflectiveInvoker.Call(pathValues, query, Map.of(), body));
            observation = observe(result);
        } catch (WebApplicationException e) {
            try (Response response = e.getResponse()) {
                observation = Observation.failure(response.getStatus(), e.getMessage());
            }
        } catch (Error e) {
            throw e;
        } catch (Throwable t) {
            observation = Observation.failure(recorder.status, "adapter could not read the answer: " + t);
        }
        return new Answer(observation, recorder.request);
    }

    @Override
    public void close() {
        keycloak.close();
    }

    private Observation observe(Object result) {
        if (result instanceof Response response) {
            try (response) {
                byte[] body = response.hasEntity() ? response.readEntity(byte[].class) : new byte[0];
                return Observation.ofHttp(response.getStatus(), response.getHeaderString(HttpHeaders.CONTENT_TYPE), body);
            }
        }
        // A byte[] return type is the entity itself (a keystore download), not a representation to serialise.
        if (result instanceof byte[] entity) {
            return Observation.ofHttp(recorder.status, recorder.contentType, entity);
        }
        return new Observation(recorder.status, TYPED_VIEW.valueToTree(result), null);
    }

    private static Set<String> queryNames(Endpoint e) {
        return e.params(ParamSpec.Source.QUERY).stream().map(ParamSpec::name).collect(Collectors.toSet());
    }

    /** Records the last admin request and the status and media type it got; token requests are not of interest. */
    private static final class Recorder implements ClientRequestFilter, ClientResponseFilter {
        private volatile Request request;
        private volatile int status;
        private volatile String contentType;

        void reset() {
            request = null;
            status = 0;
            contentType = null;
        }

        @Override
        public void filter(ClientRequestContext ctx) {
            if (isAdmin(ctx)) {
                URI uri = ctx.getUri();
                request = new Request(ctx.getMethod(), uri.getRawPath() + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery()),
                        ctx.getHeaderString(HttpHeaders.ACCEPT), ctx.getHeaderString(HttpHeaders.CONTENT_TYPE));
            }
        }

        @Override
        public void filter(ClientRequestContext ctx, ClientResponseContext response) {
            if (isAdmin(ctx)) {
                status = response.getStatus();
                contentType = response.getHeaderString(HttpHeaders.CONTENT_TYPE);
            }
        }

        private static boolean isAdmin(ClientRequestContext ctx) {
            return ctx.getUri().getRawPath().startsWith("/admin/");
        }
    }
}
