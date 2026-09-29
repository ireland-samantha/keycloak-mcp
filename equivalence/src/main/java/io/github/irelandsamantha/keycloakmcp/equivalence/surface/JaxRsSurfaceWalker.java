package io.github.irelandsamantha.keycloakmcp.equivalence.surface;

import jakarta.ws.rs.BeanParam;
import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.CookieParam;
import jakarta.ws.rs.DefaultValue;
import jakarta.ws.rs.FormParam;
import jakarta.ws.rs.HeaderParam;
import jakarta.ws.rs.HttpMethod;
import jakarta.ws.rs.MatrixParam;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.QueryParam;
import jakarta.ws.rs.core.Context;
import jakarta.ws.rs.core.Response;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.ChainStep;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.Endpoint;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.ParamSpec;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.ParamSpec.Source;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.WalkResult;

import java.lang.annotation.Annotation;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.Type;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Collectors;

/**
 * Statically walks a JAX-RS client interface graph the way RESTEasy's client proxy
 * ({@code org.jboss.resteasy.client.jaxrs.internal.proxy.ProxyBuilderImpl}) resolves it:
 * <ul>
 *   <li>every proxy creation, root or sub-resource, appends the interface's class-level {@code @Path};</li>
 *   <li>a method with {@code @Path}, no HTTP-method annotation and an interface return type is a sub-resource
 *       locator; the proxy honours only its {@code @PathParam}/{@code @MatrixParam} arguments;</li>
 *   <li>a method with exactly one HTTP-method annotation is terminal; {@code default} methods without
 *       annotations are executed locally and are not endpoints.</li>
 * </ul>
 * Anything that would make RESTEasy fail at proxy creation, or silently drop data, is reported as an anomaly.
 */
public final class JaxRsSurfaceWalker {

    public WalkResult walk(Collection<Class<?>> scope) {
        List<Class<?>> interfaces = scope.stream()
                .filter(Class::isInterface)
                .filter(c -> !c.isAnnotation())
                .sorted(Comparator.comparing(Class::getName))
                .toList();
        Walk walk = new Walk();
        List<Class<?>> roots = interfaces.stream().filter(c -> c.isAnnotationPresent(Path.class)).toList();
        for (Class<?> root : roots) {
            Set<Class<?>> stack = new LinkedHashSet<>();
            stack.add(root);
            walk.visit(root, root, classPath(root), List.of(), stack);
        }
        List<String> unreachable = interfaces.stream()
                .filter(JaxRsSurfaceWalker::isJaxRsResource)
                .map(Class::getName)
                .filter(n -> !walk.reachable.contains(n))
                .toList();
        walk.endpoints.sort(Comparator.comparing(Endpoint::key).thenComparing(Endpoint::javaChain));
        return new WalkResult(
                roots.stream().map(Class::getName).toList(),
                List.copyOf(walk.endpoints),
                List.copyOf(walk.reachable),
                unreachable,
                List.copyOf(walk.conveniences),
                List.copyOf(walk.cycles),
                List.copyOf(walk.anomalies));
    }

    /** Mutable accumulator for one walk; kept separate so the walker itself is stateless and reusable. */
    private static final class Walk {
        final List<Endpoint> endpoints = new ArrayList<>();
        final Set<String> reachable = new TreeSet<>();
        final Set<String> conveniences = new TreeSet<>();
        final Set<String> cycles = new TreeSet<>();
        final Set<String> anomalies = new TreeSet<>();

        void visit(Class<?> root, Class<?> resource, String prefix, List<ChainStep> chain, Set<Class<?>> stack) {
            reachable.add(resource.getName());
            for (Method m : jaxRsCandidates(resource)) {
                Optional<String> http = httpMethod(m);
                Path path = m.getAnnotation(Path.class);
                if (http.isPresent()) {
                    endpoints.add(terminal(root, m, http.get(), prefix, chain));
                } else if (path != null) {
                    locator(root, m, path, prefix, chain, stack);
                } else if (m.isDefault()) {
                    conveniences.add(describe(m));
                } else {
                    anomalies.add("Abstract method without JAX-RS annotations (RESTEasy proxy creation fails): "
                            + describe(m));
                }
            }
        }

        private void locator(Class<?> root, Method m, Path path, String prefix, List<ChainStep> chain,
                             Set<Class<?>> stack) {
            Class<?> target = m.getReturnType();
            if (!target.isInterface()) {
                anomalies.add("Locator returns a non-interface (RESTEasy treats it as an HTTP-less invoker): "
                        + describe(m));
                return;
            }
            ChainStep declared = step(m, path.value(), true);
            List<ParamSpec> params = declared.params().stream().map(p -> {
                if (p.source() == Source.PATH || p.source() == Source.MATRIX) {
                    return p;
                }
                anomalies.add("Locator parameter ignored by RESTEasy client (" + p.source() + " " + p.name() + "): "
                        + describe(m));
                return p.dropped();
            }).toList();
            ChainStep step = new ChainStep(declared.resource(), declared.method(), declared.signature(),
                    declared.path(), true, declared.deprecated(), params, declared.javaMethod());
            checkTemplateBinding(m, path.value(), step.params());
            if (stack.contains(target)) {
                cycles.add(describe(m) + " -> " + target.getName() + " (already on chain "
                        + stack.stream().map(Class::getSimpleName).collect(Collectors.joining(" > ")) + ")");
                return;
            }
            List<ChainStep> next = append(chain, step);
            Set<Class<?>> nextStack = new LinkedHashSet<>(stack);
            nextStack.add(target);
            visit(root, target, PathTemplates.join(prefix, path.value(), classPath(target)), next, nextStack);
        }

        private Endpoint terminal(Class<?> root, Method m, String http, String prefix, List<ChainStep> chain) {
            String methodPath = Optional.ofNullable(m.getAnnotation(Path.class)).map(Path::value).orElse("");
            ChainStep step = step(m, methodPath, false);
            checkTemplateBinding(m, methodPath, step.params());
            long bodies = step.params().stream().filter(p -> p.source() == Source.BODY).count();
            if (bodies > 1) {
                anomalies.add("More than one entity parameter: " + describe(m));
            }
            String template = PathTemplates.stripRegex(PathTemplates.join(prefix, methodPath));
            List<ChainStep> full = append(chain, step);
            unboundVariables(template, full).forEach(v ->
                    anomalies.add("Template variable {" + v + "} never bound by any @PathParam on chain: " + describe(m)));
            return new Endpoint(
                    root.getName(),
                    http,
                    template,
                    PathTemplates.normalize(template),
                    PathTemplates.variableNames(template),
                    full,
                    mediaTypes(m, Consumes.class),
                    mediaTypes(m, Produces.class),
                    m.getGenericReturnType().getTypeName(),
                    returnKind(m));
        }

        /** A step's @PathParam names should match the variables its own @Path introduces. */
        private void checkTemplateBinding(Method m, String methodPath, List<ParamSpec> params) {
            Set<String> declared = new TreeSet<>(PathTemplates.variableNames(methodPath));
            if (m.getDeclaringClass().isAnnotationPresent(Path.class)) {
                declared.addAll(PathTemplates.variableNames(classPath(m.getDeclaringClass())));
            }
            params.stream()
                    .filter(p -> p.source() == Source.PATH && !declared.contains(p.name()))
                    .forEach(p -> anomalies.add("@PathParam(\"" + p.name() + "\") not in the method's own @Path \""
                            + methodPath + "\": " + describe(m)));
        }
    }

    // ---------------------------------------------------------------------------------------------------------
    // Pure annotation helpers

    /** Public abstract/default instance methods, deterministically ordered; static and synthetic excluded. */
    static List<Method> jaxRsCandidates(Class<?> resource) {
        return Arrays.stream(resource.getMethods())
                .filter(m -> !Modifier.isStatic(m.getModifiers()) && !m.isSynthetic() && !m.isBridge())
                .filter(m -> m.getDeclaringClass() != Object.class)
                .sorted(Comparator.comparing(Method::getName).thenComparing(JaxRsSurfaceWalker::signature))
                .toList();
    }

    /** HTTP method from any annotation meta-annotated with {@code @HttpMethod} (covers custom verbs). */
    static Optional<String> httpMethod(Method m) {
        List<String> verbs = Arrays.stream(m.getAnnotations())
                .map(a -> a.annotationType().getAnnotation(HttpMethod.class))
                .filter(Objects::nonNull)
                .map(HttpMethod::value)
                .toList();
        if (verbs.size() > 1) {
            throw new IllegalStateException("Multiple HTTP method annotations on " + describe(m));
        }
        return verbs.stream().findFirst();
    }

    static boolean isJaxRsResource(Class<?> c) {
        return c.isAnnotationPresent(Path.class)
                || Arrays.stream(c.getMethods()).anyMatch(m -> httpMethod(m).isPresent() || m.isAnnotationPresent(Path.class));
    }

    static String classPath(Class<?> c) {
        Path p = c.getAnnotation(Path.class);
        return p == null ? "" : p.value();
    }

    private static ChainStep step(Method m, String path, boolean locator) {
        return new ChainStep(
                m.getDeclaringClass().getName(),
                m.getName(),
                signature(m),
                path,
                locator,
                m.isAnnotationPresent(Deprecated.class),
                params(m),
                m);
    }

    static List<ParamSpec> params(Method m) {
        Annotation[][] annotations = m.getParameterAnnotations();
        Class<?>[] raw = m.getParameterTypes();
        Type[] generic = m.getGenericParameterTypes();
        List<ParamSpec> out = new ArrayList<>(raw.length);
        for (int i = 0; i < raw.length; i++) {
            Source source = Source.BODY;
            String name = null;
            String defaultValue = null;
            for (Annotation a : annotations[i]) {
                switch (a) {
                    case PathParam p -> { source = Source.PATH; name = p.value(); }
                    case QueryParam q -> { source = Source.QUERY; name = q.value(); }
                    case FormParam f -> { source = Source.FORM; name = f.value(); }
                    case HeaderParam h -> { source = Source.HEADER; name = h.value(); }
                    case CookieParam c -> { source = Source.COOKIE; name = c.value(); }
                    case MatrixParam x -> { source = Source.MATRIX; name = x.value(); }
                    case BeanParam b -> source = Source.BEAN;
                    case Context c -> source = Source.CONTEXT;
                    case DefaultValue d -> defaultValue = d.value();
                    default -> { }
                }
            }
            out.add(new ParamSpec(i, source, name, generic[i].getTypeName(), defaultValue, raw[i].isPrimitive(), true));
        }
        return List.copyOf(out);
    }

    /** Method-level annotation wins; otherwise the declaring interface's (JAX-RS inheritance rule). */
    static List<String> mediaTypes(Method m, Class<? extends Annotation> kind) {
        Annotation a = m.getAnnotation(kind);
        if (a == null) {
            a = m.getDeclaringClass().getAnnotation(kind);
        }
        if (a == null) {
            return List.of();
        }
        String[] values = a instanceof Consumes c ? c.value() : ((Produces) a).value();
        return Arrays.stream(values)
                .flatMap(v -> Arrays.stream(v.split(",")))
                .map(String::strip)
                .filter(s -> !s.isEmpty())
                .toList();
    }

    static Endpoint.ReturnKind returnKind(Method m) {
        Class<?> r = m.getReturnType();
        if (r == void.class) {
            return Endpoint.ReturnKind.VOID;
        }
        return r == Response.class ? Endpoint.ReturnKind.RESPONSE : Endpoint.ReturnKind.TYPED;
    }

    static String signature(Method m) {
        return m.getName() + Arrays.stream(m.getParameterTypes())
                .map(Class::getSimpleName)
                .collect(Collectors.joining(",", "(", ")"));
    }

    static String describe(Method m) {
        return m.getDeclaringClass().getSimpleName() + "#" + signature(m);
    }

    private static Set<String> unboundVariables(String template, List<ChainStep> chain) {
        Set<String> bound = chain.stream()
                .flatMap(s -> s.params().stream())
                .filter(p -> p.source() == Source.PATH)
                .map(ParamSpec::name)
                .collect(Collectors.toSet());
        Set<String> unbound = new TreeSet<>(PathTemplates.variableNames(template));
        unbound.removeAll(bound);
        return unbound;
    }

    private static List<ChainStep> append(List<ChainStep> chain, ChainStep step) {
        List<ChainStep> out = new ArrayList<>(chain);
        out.add(step);
        return List.copyOf(out);
    }
}
