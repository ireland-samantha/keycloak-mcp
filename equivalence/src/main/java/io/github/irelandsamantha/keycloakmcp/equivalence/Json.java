package io.github.irelandsamantha.keycloakmcp.equivalence;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;

/** The suite's one Jackson configuration plus the few tree helpers every reader needs. */
public final class Json {

    public static final ObjectMapper MAPPER = new ObjectMapper()
            .enable(SerializationFeature.INDENT_OUTPUT)
            .enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS);

    private Json() {
    }

    public static JsonNode read(byte[] bytes) {
        try {
            return MAPPER.readTree(bytes);
        } catch (IOException e) {
            throw new IllegalArgumentException("Not JSON: " + e.getMessage(), e);
        }
    }

    public static JsonNode read(String text) {
        return read(text.getBytes(StandardCharsets.UTF_8));
    }

    /** Writes pretty-printed JSON with a trailing newline, creating parent directories. */
    public static void write(Path file, Object value) throws IOException {
        Files.createDirectories(file.toAbsolutePath().getParent());
        Files.writeString(file, MAPPER.writeValueAsString(value) + "\n");
    }

    /** Text values of an array node, in order. */
    public static List<String> texts(JsonNode array) {
        List<String> out = new ArrayList<>();
        array.forEach(n -> out.add(n.asText()));
        return List.copyOf(out);
    }

    /** Field names of an object node, sorted. */
    public static Set<String> fieldNames(JsonNode object) {
        Set<String> out = new TreeSet<>();
        object.fieldNames().forEachRemaining(out::add);
        return out;
    }
}
