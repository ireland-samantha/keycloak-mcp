package io.github.irelandsamantha.keycloakmcp.equivalence.fixtures;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.PathTemplates;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.UnaryOperator;
import java.util.stream.Collectors;

/**
 * One read as both keycloak-mcp and the raw oracle send it: path values by position, query parameters, an optional
 * entity and the {@code Accept} media type. An operation read with several entities (a keystore download per format)
 * has one request per entity, each named by its {@code variant}.
 *
 * @param template   the operation's path template (variable names do not matter)
 * @param pathValues raw value per variable, in path order
 * @param body       {@code null} for none
 * @param accept     {@code null} to let each client send its default, which for keycloak-mcp's {@code fetch} and
 *                   for the raw oracle is {@code *}{@code /*}
 * @param variant    what sets this request apart from the operation's other requests; {@code null} for the only one
 * @param view       how every side's answer is read before the comparison, e.g. a keystore by its content; the
 *                   identity for most reads
 */
public record ReadRequest(String method, String template, List<String> pathValues, Map<String, String> query,
                          ReadBody body, String accept, String variant, UnaryOperator<JsonNode> view) {

    /** keycloak-mcp's pinned realm fills this variable; a request may not set it. */
    public static final String REALM_VARIABLE = "realm";

    public static final String ANY = "*/*";

    /** Encoded path and query below the server root. */
    public String rawPathAndQuery() {
        String path = PathTemplates.expand(template, (position, v) -> encode(pathValues.get(position)).replace("+", "%20"));
        return query.isEmpty() ? path : path + "?" + query.entrySet().stream()
                .map(e -> encode(e.getKey()) + "=" + encode(e.getValue()))
                .collect(Collectors.joining("&"));
    }

    public Map<String, String> rawHeaders() {
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Accept", accept == null ? ANY : accept);
        if (body != null) {
            headers.put("Content-Type", body.rawContentType());
        }
        return headers;
    }

    public byte[] rawBody() {
        return body == null ? null : body.rawBytes();
    }

    /**
     * {@code keycloak_read} arguments; path values are named after {@code catalogTemplate}'s variables, the one
     * that keycloak-mcp pins excepted.
     */
    public ObjectNode mcpArguments(String catalogTemplate) {
        ObjectNode args = JsonNodeFactory.instance.objectNode();
        ObjectNode path = args.putObject("path");
        List<String> names = PathTemplates.variableNames(catalogTemplate);
        for (int i = 0; i < names.size(); i++) {
            if (!names.get(i).equals(REALM_VARIABLE)) {
                path.put(names.get(i), pathValues.get(i));
            }
        }
        if (!query.isEmpty()) {
            ObjectNode q = args.putObject("query");
            query.forEach(q::put);
        }
        if (body != null) {
            args.set("body", body.mcpValue());
            args.put("contentType", body.mediaType());
        }
        if (accept != null) {
            args.put("accept", accept);
        }
        return args;
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }
}
