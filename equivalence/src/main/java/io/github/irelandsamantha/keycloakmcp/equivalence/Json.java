package io.github.irelandsamantha.keycloakmcp.equivalence;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.util.DefaultIndenter;
import com.fasterxml.jackson.core.util.DefaultPrettyPrinter;
import com.fasterxml.jackson.core.util.Separators;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.ObjectWriter;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;

/** The suite's one Jackson configuration plus the few tree helpers every reader needs. */
public final class Json {

    public static final ObjectMapper MAPPER = new ObjectMapper();

    /** Two-space, {@code "key": value}, one array element per line, LF only: stable diffs next to JS-written files. */
    private static final ObjectWriter PRETTY = MAPPER.writer(new DefaultPrettyPrinter(Separators.createDefaultInstance()
            .withObjectFieldValueSpacing(Separators.Spacing.AFTER)
            .withObjectEmptySeparator("")
            .withArrayEmptySeparator(""))
            .withObjectIndenter(new DefaultIndenter("  ", "\n"))
            .withArrayIndenter(new DefaultIndenter("  ", "\n")));

    private Json() {
    }

    public static JsonNode read(byte[] bytes) {
        try {
            return MAPPER.readTree(bytes);
        } catch (IOException e) {
            throw new IllegalArgumentException("Not JSON: " + e.getMessage(), e);
        }
    }

    /** Parses JSON text, e.g. a request body written as a text block. */
    public static JsonNode read(String text) {
        try {
            return MAPPER.readTree(text);
        } catch (IOException e) {
            throw new IllegalArgumentException("Not JSON: " + e.getMessage(), e);
        }
    }

    public static String pretty(Object value) {
        try {
            return PRETTY.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** Writes pretty-printed JSON with a trailing newline, creating parent directories. */
    public static void write(Path file, Object value) throws IOException {
        Files.createDirectories(file.toAbsolutePath().getParent());
        Files.writeString(file, pretty(value) + "\n");
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
