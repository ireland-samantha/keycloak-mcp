package io.github.irelandsamantha.keycloakmcp.equivalence.supplement;

import com.fasterxml.jackson.databind.BeanDescription;
import com.fasterxml.jackson.databind.JavaType;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.introspect.BeanPropertyDefinition;
import jakarta.ws.rs.core.Response;

import java.lang.reflect.Type;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.net.URI;
import java.net.URL;
import java.util.Arrays;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.SortedMap;
import java.util.TreeMap;
import java.util.UUID;

/**
 * OpenAPI-style schemas for Java admin-client types. A representation the HEAD OpenAPI already defines is referenced
 * as {@code #/components/schemas/<SimpleName>}; any other is generated from its Jackson serialization properties
 * into {@link #generated()} under the same reference form, so keycloak-mcp can resolve every name in OpenAPI
 * components first and in the supplement second.
 */
final class JsonSchemas {

    private static final String REF = "#/components/schemas/";

    private final Set<String> openApiComponents;
    private final ObjectMapper mapper = new ObjectMapper();
    private final SortedMap<String, Object> generated = new TreeMap<>();
    private final Map<String, Class<?>> generatedFrom = new HashMap<>();

    JsonSchemas(Set<String> openApiComponents) {
        this.openApiComponents = openApiComponents;
    }

    /** Schema of a request or response entity; {@code null} when the type carries no JSON body. */
    Map<String, Object> entity(Type type) {
        Class<?> raw = mapper.constructType(type).getRawClass();
        return raw == void.class || raw == Void.class || raw == Response.class ? null : schema(mapper.constructType(type));
    }

    /** Schema of a form field or query parameter. */
    Map<String, Object> scalar(Type type) {
        return schema(mapper.constructType(type));
    }

    /** Schemas of representations absent from the OpenAPI components, by simple class name. */
    SortedMap<String, Object> generated() {
        return generated;
    }

    private Map<String, Object> schema(JavaType t) {
        Class<?> raw = t.getRawClass();
        if (t.isArrayType() || t.isCollectionLikeType()) {
            Map<String, Object> array = typed("array");
            array.put("items", schema(t.getContentType()));
            if (Set.class.isAssignableFrom(raw)) {
                array.put("uniqueItems", true);
            }
            return array;
        }
        if (t.isMapLikeType()) {
            Map<String, Object> map = typed("object");
            map.put("additionalProperties", schema(t.getContentType()));
            return map;
        }
        Map<String, Object> simple = simple(raw);
        return simple != null ? simple : reference(t);
    }

    private Map<String, Object> simple(Class<?> raw) {
        if (raw == String.class || raw == char.class || raw == Character.class || raw == UUID.class
                || raw == URI.class || raw == URL.class) {
            return typed("string");
        }
        if (raw == boolean.class || raw == Boolean.class) {
            return typed("boolean");
        }
        if (raw == int.class || raw == Integer.class || raw == short.class || raw == Short.class || raw == byte.class
                || raw == Byte.class) {
            return formatted("integer", "int32");
        }
        if (raw == long.class || raw == Long.class || raw == BigInteger.class) {
            return formatted("integer", "int64");
        }
        if (raw == float.class || raw == Float.class) {
            return formatted("number", "float");
        }
        if (raw == double.class || raw == Double.class || raw == BigDecimal.class) {
            return formatted("number", "double");
        }
        if (raw.isEnum()) {
            Map<String, Object> e = typed("string");
            e.put("enum", Arrays.stream(raw.getEnumConstants()).map(c -> mapper.convertValue(c, String.class)).toList());
            return e;
        }
        if (raw == Object.class || JsonNode.class.isAssignableFrom(raw)) {
            return new LinkedHashMap<>();
        }
        return null;
    }

    private Map<String, Object> reference(JavaType t) {
        Class<?> raw = t.getRawClass();
        String name = raw.getSimpleName();
        if (!openApiComponents.contains(name)) {
            Class<?> previous = generatedFrom.putIfAbsent(name, raw);
            if (previous == null) {
                generated.put(name, bean(t));
            } else if (previous != raw) {
                throw new IllegalStateException("Schema name " + name + " would describe both " + previous + " and " + raw);
            }
        }
        return new LinkedHashMap<>(Map.of("$ref", REF + name));
    }

    private Map<String, Object> bean(JavaType t) {
        BeanDescription description = mapper.getSerializationConfig().introspect(t);
        SortedMap<String, Object> properties = new TreeMap<>();
        for (BeanPropertyDefinition p : description.findProperties()) {
            if (p.couldSerialize()) {
                properties.put(p.getName(), schema(p.getPrimaryType()));
            }
        }
        Map<String, Object> object = typed("object");
        object.put("properties", properties);
        return object;
    }

    private static Map<String, Object> typed(String type) {
        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", type);
        return schema;
    }

    private static Map<String, Object> formatted(String type, String format) {
        Map<String, Object> schema = typed(type);
        schema.put("format", format);
        return schema;
    }

    /** JSON type of a query parameter as keycloak-mcp's catalog records it. */
    static String parameterType(Class<?> raw) {
        if (raw.isArray() || Collection.class.isAssignableFrom(raw)) {
            return "array";
        }
        if (raw == boolean.class || raw == Boolean.class) {
            return "boolean";
        }
        if (raw == int.class || raw == Integer.class || raw == long.class || raw == Long.class) {
            return "integer";
        }
        return raw == float.class || raw == Float.class || raw == double.class || raw == Double.class ? "number" : "string";
    }
}
