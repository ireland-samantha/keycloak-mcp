package io.github.irelandsamantha.keycloakmcp.equivalence;

import io.github.irelandsamantha.keycloakmcp.equivalence.harness.EquivalenceEnvironment;
import io.github.irelandsamantha.keycloakmcp.equivalence.harness.Settings;
import org.junit.jupiter.api.extension.ExtensionContext;
import org.junit.jupiter.api.extension.ParameterContext;
import org.junit.jupiter.api.extension.ParameterResolver;

/**
 * Injects the run's single {@link EquivalenceEnvironment}. It lives in the root store, so every IT class shares one
 * Keycloak and one service account, and JUnit closes it (stopping the container) after the last test.
 */
public final class EquivalenceExtension implements ParameterResolver {

    private static final ExtensionContext.Namespace NAMESPACE = ExtensionContext.Namespace.create(EquivalenceExtension.class);

    @Override
    public boolean supportsParameter(ParameterContext parameter, ExtensionContext context) {
        return parameter.getParameter().getType() == EquivalenceEnvironment.class;
    }

    @Override
    public Object resolveParameter(ParameterContext parameter, ExtensionContext context) {
        return context.getRoot().getStore(NAMESPACE).computeIfAbsent(EquivalenceEnvironment.class,
                type -> EquivalenceEnvironment.start(Settings.fromSystemProperties()), EquivalenceEnvironment.class);
    }
}
