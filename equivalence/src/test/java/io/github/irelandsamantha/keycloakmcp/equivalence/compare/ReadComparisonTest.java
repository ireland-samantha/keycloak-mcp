package io.github.irelandsamantha.keycloakmcp.equivalence.compare;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.List;
import java.util.function.UnaryOperator;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ReadComparisonTest {

    @Test
    void onlyKeyOrderMayDiffer() throws Exception {
        ReadComparison c = run(List.of(json("{\"a\":1,\"b\":2}"), json("{\"a\":1,\"b\":2}")), json("{\"b\":2,\"a\":1}"));
        assertTrue(c.equivalent(), c.toString());
    }

    @Test
    void numbersMustMatchExactly() throws Exception {
        ReadComparison c = run(List.of(json("{\"n\":1.0}"), json("{\"n\":1.0}")), json("{\"n\":1}"));
        assertEquals(List.of(JsonDiff.Kind.NUMBER_FORMAT), c.differences().stream().map(JsonDiff.Diff::kind).toList());
    }

    @Test
    void anUnstableReferenceIsReadAgain() throws Exception {
        ReadComparison c = run(List.of(json("[1]"), json("[1,2]"), json("[1,2]"), json("[1,2]")), json("[1,2]"));
        assertEquals(2, c.attempts());
        assertTrue(c.equivalent(), c.toString());
    }

    @Test
    void aReferenceThatNeverSettlesIsReportedAsSuch() throws Exception {
        ReadComparison c = run(List.of(json("[1]"), json("[2]"), json("[3]"), json("[4]")), json("[1]"));
        assertFalse(c.referenceStable());
        assertFalse(c.equivalent());
    }

    @Test
    void errorsCompareByStatusOnly() throws Exception {
        Observation raw = Observation.ofHttp(501, "application/json", bytes("{\"error\":\"Feature not enabled\"}"));
        assertTrue(run(List.of(raw, raw), Observation.failure(501, "HTTP 501")).equivalent());
        assertFalse(run(List.of(raw, raw), Observation.failure(404, "HTTP 404")).equivalent());
    }

    @Test
    void aSubjectThatCannotReadA2xxBodyDiffers() throws Exception {
        ReadComparison c = run(List.of(json("{}"), json("{}")), Observation.failure(200, "cannot deserialize"));
        assertEquals(List.of("$"), c.differences().stream().map(JsonDiff.Diff::path).toList());
    }

    @Test
    void contentClassesMustAgree() throws Exception {
        Observation text = Observation.ofHttp(200, "text/plain", bytes("{}"));
        ReadComparison c = run(List.of(text, text), json("{}"));
        assertEquals(List.of("content-class"), c.differences().stream().map(JsonDiff.Diff::path).toList());
    }

    private static ReadComparison run(List<Observation> references, Observation subject) throws Exception {
        Iterator<Observation> reads = references.iterator();
        return ReadComparison.run(reads::next, () -> subject, UnaryOperator.identity(), 2);
    }

    private static Observation json(String body) {
        return Observation.ofHttp(200, "application/json", bytes(body));
    }

    private static byte[] bytes(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }
}
