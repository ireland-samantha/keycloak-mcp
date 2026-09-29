package io.github.irelandsamantha.keycloakmcp.equivalence.surface.model;

import java.util.List;

/**
 * Output of {@link io.github.irelandsamantha.keycloakmcp.equivalence.surface.JaxRsSurfaceWalker}.
 *
 * @param roots                 interfaces carrying a class-level {@code @Path}
 * @param endpoints             every terminal method reachable from a root, one entry per distinct chain
 * @param reachableResources    interfaces visited from at least one root
 * @param unreachableResources  JAX-RS-annotated interfaces in scope that no root reaches
 * @param conveniences          methods with no JAX-RS annotation (e.g. {@code default} helpers delegating to
 *                              annotated overloads); not endpoints by themselves
 * @param cycles                locators whose target interface is already on the current chain (walk cut there)
 * @param anomalies             structural oddities worth a human look (unresolved templates, stray params, ...)
 */
public record WalkResult(
        List<String> roots,
        List<Endpoint> endpoints,
        List<String> reachableResources,
        List<String> unreachableResources,
        List<String> conveniences,
        List<String> cycles,
        List<String> anomalies) {
}
