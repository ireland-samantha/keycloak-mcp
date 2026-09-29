package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import io.github.irelandsamantha.keycloakmcp.equivalence.Json;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

class StateTest {

    private static State state(boolean unordered, int status, String json) {
        return new State(List.of(new State.Entry("GET /r", unordered, status, Json.read(json))));
    }

    @Test
    void keyOrderIsNotState() {
        assertEquals(List.of(), state(false, 200, "{\"a\": 1, \"b\": 2}").differences(state(false, 200, "{\"b\": 2, \"a\": 1}")));
    }

    @Test
    void orderIsStateUnlessTheReadbackIsASet() {
        assertEquals(1, state(false, 200, "[1, 2]").differences(state(false, 200, "[2, 1]")).size());
        assertEquals(List.of(), state(true, 200, "[1, 2]").differences(state(true, 200, "[2, 1]")));
        assertEquals(1, state(true, 200, "[{\"k\": [1, 2]}]").differences(state(true, 200, "[{\"k\": [2, 1]}]")).size(),
                "only the top level of an unordered readback is a set");
    }

    @Test
    void aStatusDifferenceIsReportedAlone() {
        assertEquals(List.of("GET /r: HTTP 200 vs 404"), state(false, 200, "{}").differences(state(false, 404, "null")));
    }
}
