package io.github.irelandsamantha.keycloakmcp.equivalence.compare;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.cfg.JsonNodeFeature;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.TextNode;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Locale;

/**
 * One answer to a read, reduced to what an MCP client can observe of keycloak-mcp's: the HTTP status and the body
 * as a JSON value. A body is parsed JSON, a string for text, XML and YAML, {@code {base64, contentType}} for any
 * other media type, or {@code null} when empty.
 *
 * @param error set when the side did not produce a body to compare (a non-2xx through keycloak-mcp or the adapter,
 *              or no HTTP answer at all, then with status 0)
 */
public record Observation(int status, JsonNode value, String error) {

    /** How a body was decoded; the class of both sides must agree before their values are compared. */
    public enum ContentClass { EMPTY, JSON, TEXT, BINARY }

    /** Exact numbers: floats as BigDecimal, trailing zeros kept, so {@code 1.0} and {@code 1} stay distinguishable. */
    public static final ObjectMapper EXACT = new ObjectMapper()
            .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS)
            .configure(JsonNodeFeature.STRIP_TRAILING_BIGDECIMAL_ZEROES, false);

    /** Decodes an HTTP answer by its {@code Content-Type}. */
    public static Observation ofHttp(int status, String contentType, byte[] body) {
        return new Observation(status, decode(contentType, body), null);
    }

    /** A side that answered {@code status} without a body to compare. */
    public static Observation failure(int status, String message) {
        return new Observation(status, NullNode.getInstance(), message);
    }

    public boolean success() {
        return status / 100 == 2 && error == null;
    }

    public ContentClass contentClass() {
        if (value == null || value.isNull()) {
            return ContentClass.EMPTY;
        }
        if (value.isTextual()) {
            return ContentClass.TEXT;
        }
        boolean binary = value.isObject() && value.size() == 2 && value.has("base64") && value.has("contentType");
        return binary ? ContentClass.BINARY : ContentClass.JSON;
    }

    static JsonNode decode(String contentType, byte[] body) {
        if (body == null || body.length == 0) {
            return NullNode.getInstance();
        }
        String media = contentType == null ? "" : contentType.split(";", 2)[0].strip().toLowerCase(Locale.ROOT);
        if (media.equals("application/json") || media.endsWith("+json")) {
            try {
                return EXACT.readTree(body);
            } catch (IOException malformed) {
                return new TextNode(new String(body, StandardCharsets.UTF_8));
            }
        }
        if (media.startsWith("text/") || media.endsWith("/xml") || media.endsWith("+xml") || media.contains("yaml")) {
            return new TextNode(new String(body, StandardCharsets.UTF_8));
        }
        return JsonNodeFactory.instance.objectNode()
                .put("base64", Base64.getEncoder().encodeToString(body))
                .put("contentType", media);
    }

    @Override
    public String toString() {
        return status + " " + (error != null ? "error: " + error : contentClass());
    }
}
