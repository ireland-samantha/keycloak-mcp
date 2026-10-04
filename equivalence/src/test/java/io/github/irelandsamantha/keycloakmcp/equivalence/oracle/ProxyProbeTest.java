package io.github.irelandsamantha.keycloakmcp.equivalence.oracle;

import io.github.irelandsamantha.keycloakmcp.equivalence.surface.JaxRsSurfaceWalker;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.fixture.Fixtures;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class ProxyProbeTest {

    @Test
    void realRestEasyProxiesAgreeWithTheStaticWalk() {
        ProxyProbe.Summary s = new ProxyProbe().run(new JaxRsSurfaceWalker().walk(Fixtures.ALL).endpoints());
        assertEquals(s.probed(), s.matched(), s.nonMatching().toString());
    }
}
