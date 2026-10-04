package io.github.irelandsamantha.keycloakmcp.equivalence.surface.model;

import com.fasterxml.jackson.annotation.JsonIgnore;

import java.lang.reflect.Method;
import java.util.List;

/**
 * One hop in the call chain that reaches an endpoint: zero or more sub-resource locators followed by exactly one
 * terminal (HTTP-method-annotated) method.
 *
 * @param resource      interface that declares the method
 * @param method        Java method name
 * @param signature     human-readable signature, e.g. {@code users()} or {@code get(String)}
 * @param path          the method's raw {@code @Path} value ("" when absent)
 * @param locator       {@code true} for a sub-resource locator, {@code false} for the terminal method
 * @param deprecated    {@code @Deprecated} on the method
 * @param params        classified parameters
 * @param javaMethod    reflective handle used by {@link io.github.irelandsamantha.keycloakmcp.equivalence.oracle.ReflectiveInvoker}; not serialised
 */
public record ChainStep(
        String resource,
        String method,
        String signature,
        String path,
        boolean locator,
        boolean deprecated,
        List<ParamSpec> params,
        @JsonIgnore Method javaMethod) {
}
