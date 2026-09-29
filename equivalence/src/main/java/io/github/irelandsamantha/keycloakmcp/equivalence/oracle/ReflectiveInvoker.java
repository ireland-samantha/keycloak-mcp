package io.github.irelandsamantha.keycloakmcp.equivalence.oracle;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.PathTemplates;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.ChainStep;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.Endpoint;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.ParamSpec;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Type;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

/**
 * Drives any walked {@link Endpoint} through a real admin-client proxy from plain values, the way an equivalence
 * harness needs to.
 *
 * <p>Path values are <b>positional</b> (same order as {@link Endpoint#pathParams()}), because variable names
 * repeat inside one chain, e.g. {@code /clients/{id}/authz/resource-server/policy/{id}}: each locator resolves
 * its own {@code {id}} before the next segment is appended, so by-name binding would be ambiguous.
 *
 * <p>Limits inherent to typed proxies: a query parameter can only be sent if the chosen overload declares it;
 * primitive query parameters are always sent; {@code TYPED}/{@code VOID} methods throw
 * {@code WebApplicationException} on non-2xx while {@code RESPONSE} methods return the status for the caller to
 * inspect (and close).
 */
public final class ReflectiveInvoker {

    /** Plain-value request. Missing entries become {@code null} (primitives: their zero value). */
    public record Call(List<?> path, Map<String, ?> query, Map<String, ?> form, Object body) {
        public Call {
            path = path == null ? List.of() : path;
            query = query == null ? Map.of() : query;
            form = form == null ? Map.of() : form;
        }
    }

    private static final Map<Class<?>, Object> ZERO = Map.of(
            boolean.class, false, char.class, '\0', byte.class, (byte) 0, short.class, (short) 0,
            int.class, 0, long.class, 0L, float.class, 0f, double.class, 0d);

    private final Function<Class<?>, Object> rootProxies;
    private final ObjectMapper mapper;

    /** @param rootProxies creates a proxy for a root interface, e.g. {@code keycloak::proxy} */
    public ReflectiveInvoker(Function<Class<?>, Object> rootProxies, ObjectMapper mapper) {
        this.rootProxies = rootProxies;
        this.mapper = mapper;
    }

    public Object invoke(Endpoint endpoint, Call call) throws Throwable {
        if (call.path().size() != endpoint.pathParams().size()) {
            throw new IllegalArgumentException(endpoint.pathTemplate() + " needs " + endpoint.pathParams().size()
                    + " path values, got " + call.path().size());
        }
        // Resolve the root through the loader that defined the chain, so side-by-side builds stay separate.
        ClassLoader loader = endpoint.terminal().javaMethod().getDeclaringClass().getClassLoader();
        Object target = rootProxies.apply(Class.forName(endpoint.root(), false, loader));
        int declared = endpoint.chain().stream().mapToInt(s -> PathTemplates.variableNames(s.path()).size()).sum();
        if (declared != endpoint.pathParams().size()) {
            // Variables in class-level @Path values would need their own binding rule; none exist today.
            throw new IllegalStateException("Template variables outside method @Path values: " + endpoint.pathTemplate());
        }
        int cursor = 0;
        for (ChainStep step : endpoint.chain()) {
            List<String> vars = PathTemplates.variableNames(step.path());
            Object[] args = arguments(step, call, call.path().subList(cursor, cursor + vars.size()), vars);
            cursor += vars.size();
            try {
                target = step.javaMethod().invoke(target, args);
            } catch (InvocationTargetException e) {
                throw e.getCause();
            }
        }
        return target;
    }

    private Object[] arguments(ChainStep step, Call call, List<?> stepPathValues, List<String> stepVars) {
        Method m = step.javaMethod();
        Type[] generic = m.getGenericParameterTypes();
        Class<?>[] raw = m.getParameterTypes();
        Object[] args = new Object[raw.length];
        for (ParamSpec p : step.params()) {
            Object value = switch (p.source()) {
                case PATH -> stepPathValues.get(stepVars.indexOf(p.name()));
                case QUERY -> call.query().get(p.name());
                case FORM -> call.form().get(p.name());
                case BODY -> call.body();
                default -> null;
            };
            args[p.index()] = convert(value, raw[p.index()], generic[p.index()]);
        }
        return args;
    }

    /** Pass through values of the right type; let Jackson coerce the rest (strings to numbers, maps to beans). */
    private Object convert(Object value, Class<?> raw, Type generic) {
        if (value == null) {
            return raw.isPrimitive() ? ZERO.get(raw) : null;
        }
        boolean container = value instanceof Collection<?> || value instanceof Map<?, ?>;
        if (raw == Object.class || (raw.isInstance(value) && !container)) {
            return value;
        }
        return mapper.convertValue(value, mapper.getTypeFactory().constructType(generic));
    }
}
