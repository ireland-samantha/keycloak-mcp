package io.github.irelandsamantha.keycloakmcp.equivalence.surface;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.URISyntaxException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;
import java.util.stream.Stream;

/**
 * Enumerates the classes of one package inside the code source (jar or classes directory) that also holds an
 * anchor class. Scoping to the anchor's code source keeps the walk tied to one concrete artifact, so the report
 * can name exactly which jar was analysed.
 */
public final class ResourceScanner {

    private ResourceScanner() {
    }

    /** Location of the jar/directory the anchor class was loaded from. */
    public static Path codeSource(Class<?> anchor) {
        try {
            return Path.of(anchor.getProtectionDomain().getCodeSource().getLocation().toURI());
        } catch (URISyntaxException e) {
            throw new IllegalStateException(e);
        }
    }

    /** All top-level and nested classes in {@code packageName} (non-recursive) from the anchor's code source. */
    public static List<Class<?>> classesInPackage(Class<?> anchor, String packageName) {
        Path source = codeSource(anchor);
        String prefix = packageName.replace('.', '/') + '/';
        List<String> names = Files.isDirectory(source) ? namesInDirectory(source, prefix) : namesInJar(source, prefix);
        ClassLoader loader = anchor.getClassLoader();
        List<Class<?>> classes = new ArrayList<>();
        for (String name : names) {
            try {
                classes.add(Class.forName(name, false, loader));
            } catch (ClassNotFoundException | LinkageError e) {
                throw new IllegalStateException("Cannot load " + name + " from " + source, e);
            }
        }
        classes.sort(Comparator.comparing(Class::getName));
        return classes;
    }

    private static List<String> namesInJar(Path jar, String prefix) {
        try (JarFile jf = new JarFile(jar.toFile())) {
            return jf.stream()
                    .map(JarEntry::getName)
                    .filter(n -> n.startsWith(prefix) && n.endsWith(".class"))
                    .filter(n -> n.indexOf('/', prefix.length()) < 0)
                    .map(ResourceScanner::toClassName)
                    .toList();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static List<String> namesInDirectory(Path root, String prefix) {
        Path dir = root.resolve(prefix);
        if (!Files.isDirectory(dir)) {
            return List.of();
        }
        try (Stream<Path> files = Files.list(dir)) {
            return files.map(p -> root.relativize(p).toString().replace('\\', '/'))
                    .filter(n -> n.endsWith(".class"))
                    .map(ResourceScanner::toClassName)
                    .toList();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static String toClassName(String entry) {
        return entry.substring(0, entry.length() - ".class".length()).replace('/', '.');
    }
}
