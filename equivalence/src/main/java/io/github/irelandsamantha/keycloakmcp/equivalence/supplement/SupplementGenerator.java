package io.github.irelandsamantha.keycloakmcp.equivalence.supplement;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.Json;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.AdminClientArtifact;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.AdminClientSurface;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.HeadOpenApi;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.OpView;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.PathTemplates;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.ReferenceSurface;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.ChainStep;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.Endpoint;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.ParamSpec;
import io.github.irelandsamantha.keycloakmcp.equivalence.surface.model.WalkResult;

import java.io.IOException;
import java.lang.reflect.Type;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.SortedMap;
import java.util.TreeMap;
import java.util.stream.Collectors;

/**
 * Writes {@code data/admin-client-supplement-nightly.json}: every operation the Java admin client exposes that the
 * HEAD OpenAPI definition lacks, in the format keycloak-mcp's {@code nightly} catalog loader merges.
 *
 * <pre>mvn -f equivalence/pom.xml -Psupplement</pre>
 */
public final class SupplementGenerator {

    /** One supplement operation; field order is the file's. */
    record Operation(String key, String method, String path, String summary, String description, List<String> tags,
                     List<Parameter> parameters, List<String> requestTypes, List<String> responseTypes,
                     Map<String, Object> requestSchema, Map<String, Object> responseSchema, List<String> adminClient) {
    }

    /** A path or query parameter, shaped like keycloak-mcp's catalog parameters. */
    record Parameter(String name, String in, boolean required, String type) {
    }

    record Document(String source, String resolvedVersion, String sourceSha256, String scmRevision,
                    String openapiSha256, List<Operation> operations, SortedMap<String, Object> schemas) {
    }

    private final ReferenceSurface reference;
    private final Map<String, List<Endpoint>> bindings;
    private final PathParameterNames names;
    private final JsonSchemas schemas;

    SupplementGenerator(JsonNode openApi, WalkResult adminClient) {
        this.reference = ReferenceSurface.of(openApi, adminClient);
        this.bindings = adminClient.endpoints().stream()
                .collect(Collectors.groupingBy(Endpoint::key, TreeMap::new, Collectors.toList()));
        this.names = new PathParameterNames(Json.fieldNames(openApi.path("paths")));
        this.schemas = new JsonSchemas(Json.fieldNames(openApi.path("components").path("schemas")));
    }

    public static void main(String[] args) throws IOException {
        if (args.length != 1) {
            throw new IllegalArgumentException("usage: SupplementGenerator <output.json>");
        }
        Path out = Path.of(args[0]).toAbsolutePath().normalize();
        Path root = Path.of(System.getProperty("keycloakmcp.root", "..")).toAbsolutePath().normalize();
        HeadOpenApi.Document openApi = HeadOpenApi.load(root);
        AdminClientArtifact jar = AdminClientArtifact.inspect(AdminClientSurface.jar());
        SupplementGenerator generator = new SupplementGenerator(openApi.json(), AdminClientSurface.walk());
        List<Operation> operations = generator.operations();
        Json.write(out, new Document("org.keycloak:keycloak-admin-client:" + jar.version(), jar.resolvedVersion(),
                jar.sha256(), jar.scmRevision(), openApi.sha256(), operations, generator.schemas.generated()));
        System.out.printf("%d admin-client-only operations, %d generated schemas (admin client %s, OpenAPI %s) -> %s%n",
                operations.size(), generator.schemas.generated().size(), jar.resolvedVersion(), openApi.source(), out);
    }

    /** Admin-client operations absent from the OpenAPI definition, sorted by key. */
    List<Operation> operations() {
        return bindings.keySet().stream()
                .filter(key -> !reference.openApi().containsKey(key))
                .map(this::operation)
                .sorted(Comparator.comparing(Operation::key))
                .toList();
    }

    private Operation operation(String key) {
        OpView view = reference.adminClient().get(key);
        Endpoint primary = primary(bindings.get(key));
        ChainStep terminal = primary.terminal();
        String path = names.harmonize(primary.pathTemplate());
        String javaMethod = simpleName(terminal.resource()) + "#" + terminal.method();
        return new Operation(
                primary.httpMethod() + " " + path,
                primary.httpMethod(),
                path,
                summary(terminal),
                "Reachable through the Java admin client (" + javaMethod + "); absent from the Keycloak OpenAPI definition.",
                tags(path),
                parameters(path, bindings.get(key)),
                List.copyOf(view.consumes()),
                List.copyOf(view.produces()),
                requestSchema(primary),
                primary.returnKind() == Endpoint.ReturnKind.TYPED ? schemas.entity(terminal.javaMethod().getGenericReturnType()) : null,
                primary.chain().stream().map(s -> simpleName(s.resource()) + "#" + s.signature()).toList());
    }

    /**
     * The binding that describes the operation: not deprecated (the admin client keeps deprecated form variants,
     * e.g. testLDAPConnection), then declaring the most query parameters (all bindings' are listed anyway).
     */
    private static Endpoint primary(List<Endpoint> group) {
        return group.stream()
                .max(Comparator.comparing((Endpoint e) -> !e.deprecated())
                        .thenComparingInt(e -> e.params(ParamSpec.Source.QUERY).size())
                        .thenComparing(Endpoint::javaChain, Comparator.reverseOrder()))
                .orElseThrow();
    }

    private static List<Parameter> parameters(String path, List<Endpoint> group) {
        List<Parameter> out = new ArrayList<>();
        for (String name : PathTemplates.variableNames(path)) {
            out.add(new Parameter(name, "path", true, "string"));
        }
        SortedMap<String, String> query = new TreeMap<>();
        for (Endpoint e : group) {
            for (ChainStep step : e.chain()) {
                for (ParamSpec p : step.params()) {
                    if (p.source() == ParamSpec.Source.QUERY && p.sent()) {
                        query.putIfAbsent(p.name(), JsonSchemas.parameterType(step.javaMethod().getParameterTypes()[p.index()]));
                    }
                }
            }
        }
        query.forEach((name, type) -> out.add(new Parameter(name, "query", false, type)));
        return out;
    }

    private Map<String, Object> requestSchema(Endpoint e) {
        ChainStep terminal = e.terminal();
        Type[] types = terminal.javaMethod().getGenericParameterTypes();
        List<ParamSpec> form = e.params(ParamSpec.Source.FORM);
        if (!form.isEmpty()) {
            SortedMap<String, Object> properties = new TreeMap<>();
            form.forEach(p -> properties.put(p.name(), schemas.scalar(types[p.index()])));
            Map<String, Object> object = new LinkedHashMap<>();
            object.put("type", "object");
            object.put("properties", properties);
            return object;
        }
        return e.params(ParamSpec.Source.BODY).stream().findFirst()
                .map(body -> schemas.entity(types[body.index()]))
                .orElse(null);
    }

    /**
     * Majority tags of the documented operations sharing the longest path prefix, at least {@code /admin/realms/{}};
     * untagged when those are (as the OpenAPI authorization operations are).
     */
    private List<String> tags(String path) {
        List<String> segments = List.of(PathTemplates.normalize(path).split("/"));
        for (int length = segments.size(); length >= 4; length--) {
            String prefix = String.join("/", segments.subList(0, length));
            Map<String, Long> siblingTags = reference.openApi().values().stream()
                    .filter(op -> (PathTemplates.normalize(op.path()) + "/").startsWith(prefix + "/"))
                    .collect(Collectors.groupingBy(op -> String.join(",", op.tags()), Collectors.counting()));
            if (!siblingTags.isEmpty()) {
                String tags = siblingTags.entrySet().stream()
                        .max(Map.Entry.<String, Long>comparingByValue()
                                .thenComparing(Map.Entry.comparingByKey(Comparator.reverseOrder())))
                        .orElseThrow().getKey();
                return tags.isEmpty() ? List.of() : List.of(tags.split(","));
            }
        }
        return List.of();
    }

    /** "RolePoliciesResource#findByName" becomes "Role policies: find by name". */
    private static String summary(ChainStep terminal) {
        String resource = simpleName(terminal.resource()).replaceFirst("Resource$", "");
        String words = humanize(resource);
        return Character.toUpperCase(words.charAt(0)) + words.substring(1) + ": " + humanize(terminal.method());
    }

    private static String humanize(String camel) {
        return camel.replaceAll("([a-z0-9])([A-Z])", "$1 $2").replaceAll("([A-Z]+)([A-Z][a-z])", "$1 $2").toLowerCase();
    }

    /** Simple name of a (possibly nested) class from its binary name. */
    private static String simpleName(String binaryName) {
        return binaryName.substring(Math.max(binaryName.lastIndexOf('.'), binaryName.lastIndexOf('$')) + 1);
    }
}
