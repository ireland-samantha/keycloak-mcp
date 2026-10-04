package io.github.irelandsamantha.keycloakmcp.equivalence.oracle;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.ChainStep;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.Endpoint;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.ParamSpec;

import java.lang.reflect.Constructor;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Builds a {@link ReflectiveInvoker.Call} that sets every declared parameter to a recognisable non-null value,
 * so a captured request reveals exactly which names/segments the proxy emitted.
 */
final class SyntheticValues {

    private static final ObjectMapper JSON = new ObjectMapper();

    private SyntheticValues() {
    }

    /** Positional marker for the i-th template variable; the probe maps it back to {name} by position. */
    static String pathMarker(int position) {
        return "__" + position + "__";
    }

    static ReflectiveInvoker.Call forEndpoint(Endpoint e) {
        List<Object> path = new ArrayList<>();
        for (int i = 0; i < e.pathParams().size(); i++) {
            path.add(pathMarker(i));
        }
        Map<String, Object> query = new LinkedHashMap<>();
        Map<String, Object> form = new LinkedHashMap<>();
        Object body = null;
        for (ChainStep step : e.chain()) {
            Class<?>[] types = step.javaMethod().getParameterTypes();
            for (ParamSpec p : step.params()) {
                Class<?> raw = types[p.index()];
                switch (p.source()) {
                    case QUERY -> query.put(p.name(), scalar(raw));
                    case FORM -> form.put(p.name(), scalar(raw));
                    case BODY -> body = entity(raw);
                    default -> { }
                }
            }
        }
        return new ReflectiveInvoker.Call(path, query, form, body);
    }

    private static Object scalar(Class<?> raw) {
        if (raw == boolean.class || raw == Boolean.class) {
            return true;
        }
        if (raw == int.class || raw == Integer.class) {
            return 7;
        }
        if (raw == long.class || raw == Long.class) {
            return 7L;
        }
        if (raw.isEnum()) {
            return raw.getEnumConstants()[0];
        }
        return Collection.class.isAssignableFrom(raw) ? List.of("v") : "v";
    }

    /** A non-null entity so the proxy sets Content-Type; aborted before serialisation, so emptiness is fine. */
    private static Object entity(Class<?> raw) {
        if (raw == String.class || raw == Object.class) {
            return "{}";
        }
        if (List.class.isAssignableFrom(raw) || raw == Collection.class) {
            return new ArrayList<>();
        }
        if (Set.class.isAssignableFrom(raw)) {
            return new HashSet<>();
        }
        if (Map.class.isAssignableFrom(raw)) {
            return new HashMap<>();
        }
        if (raw == Boolean.class || raw == boolean.class) {
            return true;
        }
        if (raw == Integer.class || raw == int.class) {
            return 1;
        }
        try {
            return raw.getDeclaredConstructor().newInstance();
        } catch (ReflectiveOperationException noDefaultConstructor) {
            try {
                return JSON.convertValue(Map.of(), raw); // @JsonCreator
            } catch (IllegalArgumentException noCreator) {
                return singleScalarConstructor(raw); // e.g. ManagementPermissionRepresentation(boolean)
            }
        }
    }

    private static Object singleScalarConstructor(Class<?> raw) {
        for (Constructor<?> c : raw.getConstructors()) {
            if (c.getParameterCount() == 1) {
                try {
                    return c.newInstance(scalar(c.getParameterTypes()[0]));
                } catch (ReflectiveOperationException | IllegalArgumentException ignored) {
                    // try the next constructor
                }
            }
        }
        return null;
    }
}
