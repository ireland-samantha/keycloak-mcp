package io.github.irelandsamantha.keycloakmcp.equivalence.surface;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class PathTemplatesTest {

    @Test
    void joinBehavesLikeWebTargetPath() {
        assertEquals("/admin/realms/{realm}", PathTemplates.join("/admin/realms/", "/{realm}"));
        assertEquals("/a/b", PathTemplates.join("", "a", "", "/b/"));
        assertEquals("/", PathTemplates.join("", "/"));
    }

    @Test
    void regexConstraintsAreStrippedIncludingNestedBraces() {
        assertEquals("/g/{path}", PathTemplates.stripRegex("/g/{path: .*}"));
        assertEquals("/x/{id}/y", PathTemplates.stripRegex("/x/{ id : [a-z]{2} }/y"));
        assertEquals(List.of("id", "path"), PathTemplates.variableNames("/{id: [0-9]{1,3}}/{path: .*}"));
    }

    @Test
    void normalizeErasesNamesAndTrailingSlash() {
        assertEquals("/a/{}/c", PathTemplates.normalize("/a/{b: .*}/c/"));
        assertEquals(PathTemplates.normalize("/clients/{id}/roles/{role-name}"),
                PathTemplates.normalize("/clients/{client-uuid}/roles/{roleName}"));
        assertEquals("/a/{}", PathTemplates.normalize("//a//{x}"));
    }

    @Test
    void unbalancedBraceIsRejected() {
        assertThrows(IllegalArgumentException.class, () -> PathTemplates.parse("/a/{b"));
    }
}
