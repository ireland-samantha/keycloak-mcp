package io.github.irelandsamantha.keycloakmcp.equivalence;

import org.junit.jupiter.api.Tag;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Marks a check of behavior that keycloak-mcp gets right only once the named findings (DESIGN §6) are fixed.
 * It still runs everywhere, failing until then; the {@value #TAG} tag lets a run select or exclude these checks.
 */
@Target({ElementType.METHOD, ElementType.TYPE})
@Retention(RetentionPolicy.RUNTIME)
@Tag(RequiresNodeFixes.TAG)
public @interface RequiresNodeFixes {

    String TAG = "requires-node-fixes";

    /** The findings whose fixes the check needs, e.g. {@code SEC-1}. */
    String[] value();
}
