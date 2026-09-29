package io.github.irelandsamantha.keycloakmcp.equivalence.surface;

import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.WalkResult;
import org.keycloak.admin.client.resource.RealmsResource;

import java.nio.file.Path;

/** The JAX-RS surface of the {@code keycloak-admin-client} jar on the class path. */
public final class AdminClientSurface {

    public static final String RESOURCE_PACKAGE = "org.keycloak.admin.client.resource";

    private AdminClientSurface() {
    }

    /** The jar (or classes directory) the admin-client resource interfaces were loaded from. */
    public static Path jar() {
        return ResourceScanner.codeSource(RealmsResource.class);
    }

    public static WalkResult walk() {
        return new JaxRsSurfaceWalker().walk(ResourceScanner.classesInPackage(RealmsResource.class, RESOURCE_PACKAGE));
    }
}
