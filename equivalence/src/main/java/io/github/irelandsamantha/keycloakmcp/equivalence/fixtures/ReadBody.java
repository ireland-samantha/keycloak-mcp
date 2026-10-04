package io.github.irelandsamantha.keycloakmcp.equivalence.fixtures;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.Json;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Map;

/** The entity of a read that takes one, in the three forms the three callers need. */
public sealed interface ReadBody {

    /** The media type keycloak-mcp is asked to send ({@code args.contentType}). */
    String mediaType();

    /** {@code args.body} for {@code keycloak_read}. */
    JsonNode mcpValue();

    /** {@code Content-Type} of the raw request (a multipart one names its boundary). */
    String rawContentType();

    byte[] rawBytes();

    /** The Java argument for an admin-client binding whose entity parameter has {@code javaType}. */
    Object adapterValue(String javaType);

    /** A JSON entity. */
    record JsonEntity(JsonNode value) implements ReadBody {
        @Override
        public String mediaType() {
            return "application/json";
        }

        @Override
        public JsonNode mcpValue() {
            return value;
        }

        @Override
        public String rawContentType() {
            return mediaType();
        }

        @Override
        public byte[] rawBytes() {
            return value.toString().getBytes(StandardCharsets.UTF_8);
        }

        @Override
        public Object adapterValue(String javaType) {
            return javaType.equals(String.class.getName()) ? value.toString() : value;
        }
    }

    /**
     * A {@code multipart/form-data} entity of text fields and files; keycloak-mcp takes files as
     * {@code {filename, contentType, base64}}.
     *
     * @param fields field name to a {@link String} or a {@link File}
     */
    record Multipart(Map<String, Object> fields) implements ReadBody {

        private static final String BOUNDARY = "equivalence-read";

        public record File(String filename, String contentType, byte[] content) {
        }

        @Override
        public String mediaType() {
            return "multipart/form-data";
        }

        @Override
        public JsonNode mcpValue() {
            ObjectNode out = JsonNodeFactory.instance.objectNode();
            fields.forEach((name, value) -> {
                if (value instanceof File f) {
                    out.putObject(name).put("filename", f.filename()).put("contentType", f.contentType())
                            .put("base64", Base64.getEncoder().encodeToString(f.content()));
                } else {
                    out.put(name, (String) value);
                }
            });
            return out;
        }

        @Override
        public String rawContentType() {
            return mediaType() + "; boundary=" + BOUNDARY;
        }

        @Override
        public byte[] rawBytes() {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            fields.forEach((name, value) -> {
                String disposition = "Content-Disposition: form-data; name=\"" + name + "\"";
                if (value instanceof File f) {
                    ascii(out, "--" + BOUNDARY + "\r\n" + disposition + "; filename=\"" + f.filename() + "\"\r\n"
                            + "Content-Type: " + f.contentType() + "\r\n\r\n");
                    out.writeBytes(f.content());
                } else {
                    ascii(out, "--" + BOUNDARY + "\r\n" + disposition + "\r\n\r\n");
                    out.writeBytes(((String) value).getBytes(StandardCharsets.UTF_8));
                }
                ascii(out, "\r\n");
            });
            ascii(out, "--" + BOUNDARY + "--\r\n");
            return out.toByteArray();
        }

        @Override
        public Object adapterValue(String javaType) {
            throw new UnsupportedOperationException("no admin-client binding reads a multipart entity");
        }

        private static void ascii(ByteArrayOutputStream out, String text) {
            out.writeBytes(text.getBytes(StandardCharsets.US_ASCII));
        }

        @Override
        public String toString() {
            return "Multipart" + fields.keySet();
        }
    }

    static ReadBody json(Object value) {
        return new JsonEntity(Json.MAPPER.valueToTree(value));
    }
}
