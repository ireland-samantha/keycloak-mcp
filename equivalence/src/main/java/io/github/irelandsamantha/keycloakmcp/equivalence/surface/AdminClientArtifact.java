package io.github.irelandsamantha.keycloakmcp.equivalence.surface;

import io.github.irelandsamantha.keycloakmcp.equivalence.Digests;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.jar.JarFile;
import java.util.jar.Manifest;
import java.util.stream.Stream;

/**
 * Identity of the admin-client jar that served as oracle. {@code 999.0.0-SNAPSHOT} floats, so the resolved
 * timestamped version, the jar digest and the keycloak-client commit it was built from are what make a run
 * reproducible.
 *
 * @param resolvedVersion e.g. {@code 999.0.0-20260928.023246-474}
 * @param scmRevision     {@code Scm-Revision} of the jar manifest (a keycloak/keycloak-client commit)
 */
public record AdminClientArtifact(Path jar, String resolvedVersion, String sha256, String scmRevision) {

    private static final String ARTIFACT = "keycloak-admin-client-";

    public static AdminClientArtifact inspect(Path jar) {
        try {
            String sha256 = Digests.sha256(jar);
            return new AdminClientArtifact(jar, resolvedVersion(jar, sha256), sha256, scmRevision(jar));
        } catch (IOException e) {
            throw new UncheckedIOException("Cannot inspect " + jar, e);
        }
    }

    /**
     * Maven stores a resolved snapshot twice in the local repository, as {@code -SNAPSHOT.jar} and under its
     * timestamped name; the byte-identical sibling names the build that was actually used.
     */
    private static String resolvedVersion(Path jar, String sha256) throws IOException {
        String declared = version(jar);
        if (!declared.endsWith("-SNAPSHOT")) {
            return declared;
        }
        try (Stream<Path> siblings = Files.list(jar.getParent())) {
            for (Path sibling : siblings.filter(p -> p.getFileName().toString().matches("keycloak-admin-client-[^-]+-\\d{8}\\.\\d{6}-\\d+\\.jar")).toList()) {
                if (Digests.sha256(sibling).equals(sha256)) {
                    return version(sibling);
                }
            }
        }
        return declared;
    }

    private static String version(Path jar) {
        String name = jar.getFileName().toString();
        return name.startsWith(ARTIFACT) && name.endsWith(".jar")
                ? name.substring(ARTIFACT.length(), name.length() - ".jar".length()) : name;
    }

    private static String scmRevision(Path jar) throws IOException {
        try (JarFile jf = new JarFile(jar.toFile())) {
            Manifest mf = jf.getManifest();
            return mf == null ? null : mf.getMainAttributes().getValue("Scm-Revision");
        }
    }
}
