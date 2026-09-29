package io.github.irelandsamantha.keycloakmcp.equivalence.compare;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.McpStdioClient;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

class JsonDiffTest {

    private static JsonNode json(String text) throws Exception {
        return McpStdioClient.JSON.readTree(text);
    }

    private static List<JsonDiff.Kind> kinds(String left, String right) throws Exception {
        return JsonDiff.diff(json(left), json(right)).stream().map(JsonDiff.Diff::kind).toList();
    }

    @Test
    void identicalDocumentsHaveNoDifferences() throws Exception {
        assertEquals(List.of(), kinds("{\"a\":[1,{\"b\":null}]}", "{\"a\":[1,{\"b\":null}]}"));
    }

    @Test
    void keyOrderIsReportedButNothingElse() throws Exception {
        assertEquals(List.of(JsonDiff.Kind.KEY_ORDER), kinds("{\"a\":1,\"b\":2}", "{\"b\":2,\"a\":1}"));
    }

    @Test
    void javaScriptNumberRoundTripIsPrecisionLossNotAnotherValue() throws Exception {
        assertEquals(List.of(JsonDiff.Kind.NUMBER_PRECISION), kinds("{\"n\":9007199254740993}", "{\"n\":9007199254740992}"));
        assertEquals(List.of(JsonDiff.Kind.VALUE), kinds("{\"n\":1}", "{\"n\":2}"));
        assertEquals(List.of(JsonDiff.Kind.NUMBER_FORMAT), kinds("{\"n\":1}", "{\"n\":1.0}"));
    }

    @Test
    void permutedArraysAreOneOrderDifference() throws Exception {
        assertEquals(List.of(JsonDiff.Kind.ARRAY_ORDER), kinds("[{\"a\":1,\"b\":2},3]", "[3,{\"b\":2,\"a\":1}]"));
        assertEquals(List.of(JsonDiff.Kind.ARRAY_LENGTH, JsonDiff.Kind.VALUE), kinds("[1,2]", "[1,3,4]"));
    }

    @Test
    void missingKeysAndTypeChangesArePlaced() throws Exception {
        List<JsonDiff.Diff> diffs = JsonDiff.diff(json("{\"a\":{\"x\":1},\"t\":\"1\"}"), json("{\"a\":{},\"t\":1,\"z\":true}"));
        assertEquals(List.of("MISSING_RIGHT $.a.x", "TYPE $.t", "MISSING_LEFT $.z"),
                diffs.stream().map(d -> d.kind() + " " + d.path()).toList());
    }
}
