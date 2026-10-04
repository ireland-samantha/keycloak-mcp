package io.github.irelandsamantha.keycloakmcp.equivalence.surface.model;

/**
 * One Java parameter of a JAX-RS method (locator or terminal), classified by how RESTEasy's client proxy
 * transmits it.
 *
 * @param index        zero-based position in the Java method signature
 * @param source       how the value reaches the server
 * @param name         {@code @PathParam}/{@code @QueryParam}/... name; {@code null} for {@link Source#BODY}
 * @param javaType     generic Java type, e.g. {@code java.util.List<java.lang.String>}
 * @param defaultValue {@code @DefaultValue} if present (client proxies ignore it; recorded for contract checks)
 * @param primitive    {@code true} for primitive types: the proxy can never omit such a parameter
 * @param sent         {@code false} when the client proxy silently drops the value (anything but
 *                     {@code @PathParam}/{@code @MatrixParam} on a sub-resource locator)
 */
public record ParamSpec(int index, Source source, String name, String javaType, String defaultValue, boolean primitive,
                        boolean sent) {

    public enum Source { PATH, QUERY, FORM, HEADER, COOKIE, MATRIX, BEAN, CONTEXT, BODY }

    public ParamSpec dropped() {
        return new ParamSpec(index, source, name, javaType, defaultValue, primitive, false);
    }
}
