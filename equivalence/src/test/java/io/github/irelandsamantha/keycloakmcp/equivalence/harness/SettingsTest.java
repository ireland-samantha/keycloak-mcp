package io.github.irelandsamantha.keycloakmcp.equivalence.harness;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

class SettingsTest {

    @Test
    void aCommaListKeepsItsNonBlankItemsOnce() {
        assertEquals(List.of(), Settings.commaList(""));
        assertEquals(List.of(), Settings.commaList(" , ,"));
        assertEquals(List.of("groups", "realm-roles"), Settings.commaList(" groups,realm-roles , groups"));
    }
}
