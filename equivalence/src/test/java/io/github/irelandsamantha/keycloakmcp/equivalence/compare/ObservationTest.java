package io.github.irelandsamantha.keycloakmcp.equivalence.compare;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ObservationTest {

    @Test
    void jsonKeepsNumbersExactlyAsSent() {
        Observation o = Observation.ofHttp(200, "application/json;charset=UTF-8", bytes("{\"n\":1.0,\"big\":9007199254740993}"));
        assertEquals(Observation.ContentClass.JSON, o.contentClass());
        assertEquals("1.0", o.value().get("n").asText());
        assertEquals("9007199254740993", o.value().get("big").asText());
    }

    @Test
    void textXmlAndYamlAreStrings() {
        assertEquals(Observation.ContentClass.TEXT, Observation.ofHttp(200, "text/plain", bytes("hi")).contentClass());
        assertEquals(Observation.ContentClass.TEXT, Observation.ofHttp(200, "application/xml", bytes("<a/>")).contentClass());
        assertEquals(Observation.ContentClass.TEXT, Observation.ofHttp(200, "application/yaml", bytes("a: 1")).contentClass());
    }

    @Test
    void otherMediaIsBase64WithItsType() {
        Observation o = Observation.ofHttp(200, "application/octet-stream", new byte[]{1, 2});
        assertEquals(Observation.ContentClass.BINARY, o.contentClass());
        assertEquals("AQI=", o.value().get("base64").asText());
        assertEquals("application/octet-stream", o.value().get("contentType").asText());
    }

    @Test
    void anEmptyBodyIsEmptyWhateverItsType() {
        assertEquals(Observation.ContentClass.EMPTY, Observation.ofHttp(204, "application/json", new byte[0]).contentClass());
        assertTrue(Observation.ofHttp(204, null, null).success());
    }

    @Test
    void aFailureIsNotASuccessEvenWithA2xxStatus() {
        assertFalse(Observation.failure(200, "unreadable").success());
        assertFalse(Observation.ofHttp(404, "application/json", bytes("{}")).success());
    }

    private static byte[] bytes(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }
}
