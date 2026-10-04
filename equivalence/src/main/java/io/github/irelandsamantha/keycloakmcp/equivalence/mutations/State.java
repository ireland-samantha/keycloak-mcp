package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.compare.JsonDiff;

import java.util.ArrayList;
import java.util.List;

/** The normalized readbacks of one realm at one moment. */
record State(List<Entry> entries) {

    /**
     * @param readback  operation key of the readback
     * @param unordered whether array order at the top level of the answer is not state
     */
    record Entry(String readback, boolean unordered, int status, JsonNode value) {
    }

    State {
        entries = List.copyOf(entries);
    }

    /**
     * Every difference from {@code other}, read with the same readbacks: a status, or a JSON difference other than
     * key order (and other than top-level order of an unordered readback).
     */
    List<String> differences(State other) {
        List<String> out = new ArrayList<>();
        for (int i = 0; i < entries.size(); i++) {
            Entry mine = entries.get(i);
            Entry theirs = other.entries().get(i);
            if (mine.status() != theirs.status()) {
                out.add(mine.readback() + ": HTTP " + mine.status() + " vs " + theirs.status());
                continue;
            }
            JsonDiff.diff(mine.value(), theirs.value()).stream()
                    .filter(d -> d.kind() != JsonDiff.Kind.KEY_ORDER)
                    .filter(d -> !(mine.unordered() && d.kind() == JsonDiff.Kind.ARRAY_ORDER && d.path().equals("$")))
                    .forEach(d -> out.add(mine.readback() + ": " + d));
        }
        return out;
    }
}
