package io.github.irelandsamantha.keycloakmcp.equivalence.surface.model;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;
import java.util.stream.Stream;

/**
 * A terminal admin-client method together with the locator chain that reaches it, i.e. one callable
 * (HTTP method, path) binding exposed by the Java adapter.
 *
 * @param root           root interface (class-level {@code @Path}) the chain starts from
 * @param httpMethod     GET, POST, ... (from an annotation meta-annotated with {@code @HttpMethod})
 * @param pathTemplate   full template as the client proxy builds it, regex constraints stripped
 *                       ({@code /admin/realms/{realm}/group-by-path/{path}})
 * @param normalizedPath template with every parameter name erased ({@code /admin/realms/{}/group-by-path/{}})
 * @param pathParams     template variable names in path order
 * @param chain          locators followed by the terminal method
 * @param consumes       effective {@code @Consumes} (method-level, else declaring interface)
 * @param produces       effective {@code @Produces} (method-level, else declaring interface)
 * @param returnType     generic return type of the terminal method
 * @param returnKind     how the proxy surfaces the HTTP response
 */
public record Endpoint(
        String root,
        String httpMethod,
        String pathTemplate,
        String normalizedPath,
        List<String> pathParams,
        List<ChainStep> chain,
        List<String> consumes,
        List<String> produces,
        String returnType,
        ReturnKind returnKind) {

    public enum ReturnKind {
        /** {@code void}: non-2xx raises {@code WebApplicationException}; body discarded. */
        VOID,
        /** {@code jakarta.ws.rs.core.Response}: never throws on status; caller must close it. */
        RESPONSE,
        /** Any other type: body deserialised, non-2xx raises {@code WebApplicationException}. */
        TYPED
    }

    /** Operation identity used for cross-catalog joins: {@code "GET /admin/realms/{}/users"}. */
    @JsonProperty
    public String key() {
        return httpMethod + " " + normalizedPath;
    }

    @JsonIgnore
    public ChainStep terminal() {
        return chain.getLast();
    }

    /** {@code Resource#method(Types)} of the terminal method, e.g. {@code UsersResource#search(String,Boolean)}. */
    @JsonProperty
    public String javaMethod() {
        ChainStep t = terminal();
        return simpleName(t.resource()) + "#" + t.signature();
    }

    /** {@code realms().realm(String).users().search(String,Boolean)} */
    @JsonProperty
    public String javaChain() {
        return String.join(".", chain.stream().map(ChainStep::signature).toList());
    }

    @JsonProperty
    public boolean deprecated() {
        return chain.stream().anyMatch(ChainStep::deprecated);
    }

    /** Parameters of the given source that actually reach the wire, across the whole chain, in chain order. */
    public List<ParamSpec> params(ParamSpec.Source source) {
        return allParams().filter(p -> p.source() == source && p.sent()).toList();
    }

    private Stream<ParamSpec> allParams() {
        return chain.stream().flatMap(s -> s.params().stream());
    }

    private static String simpleName(String fqcn) {
        return fqcn.substring(fqcn.lastIndexOf('.') + 1);
    }
}
