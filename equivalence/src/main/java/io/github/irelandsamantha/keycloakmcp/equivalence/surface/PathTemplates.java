package io.github.irelandsamantha.keycloakmcp.equivalence.surface;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;

/**
 * JAX-RS / OpenAPI URI template helpers. Understands {@code {name}} and {@code {name: regex}} variables,
 * including regexes that themselves contain balanced braces (e.g. {@code {id: [a-z]{2}}}).
 */
public final class PathTemplates {

    private PathTemplates() {
    }

    /** A parsed template piece: either literal text or a variable. */
    public sealed interface Part permits Literal, Variable {
    }

    public record Literal(String text) implements Part {
    }

    public record Variable(String name, String regex) implements Part {
    }

    /**
     * Joins {@code @Path} fragments the way {@code WebTarget.path(...)} does: one slash between fragments,
     * empty fragments ignored, leading slash, no trailing slash.
     */
    public static String join(String... fragments) {
        StringBuilder out = new StringBuilder();
        for (String f : fragments) {
            if (f == null) {
                continue;
            }
            String trimmed = trimSlashes(f);
            if (!trimmed.isEmpty()) {
                out.append('/').append(trimmed);
            }
        }
        return out.isEmpty() ? "/" : out.toString();
    }

    /** Parses a template into literal and variable parts. */
    public static List<Part> parse(String template) {
        List<Part> parts = new ArrayList<>();
        StringBuilder literal = new StringBuilder();
        int i = 0;
        while (i < template.length()) {
            char c = template.charAt(i);
            if (c != '{') {
                literal.append(c);
                i++;
                continue;
            }
            int end = matchingBrace(template, i);
            if (!literal.isEmpty()) {
                parts.add(new Literal(literal.toString()));
                literal.setLength(0);
            }
            String body = template.substring(i + 1, end);
            int colon = body.indexOf(':');
            String name = (colon < 0 ? body : body.substring(0, colon)).strip();
            String regex = colon < 0 ? null : body.substring(colon + 1).strip();
            parts.add(new Variable(name, regex));
            i = end + 1;
        }
        if (!literal.isEmpty()) {
            parts.add(new Literal(literal.toString()));
        }
        return parts;
    }

    /** Template with regex constraints removed: {@code /a/{p: .*}} becomes {@code /a/{p}}. */
    public static String stripRegex(String template) {
        return render(template, v -> "{" + v.name() + "}");
    }

    /**
     * Name-free identity of a template: variables become {@code {}}, duplicate/trailing slashes collapse.
     * Two templates that differ only in variable names normalise to the same string.
     */
    public static String normalize(String template) {
        String rendered = render(template, v -> "{}").replaceAll("/{2,}", "/");
        return rendered.length() > 1 && rendered.endsWith("/") ? rendered.substring(0, rendered.length() - 1) : rendered;
    }

    /** Operation identity used for every cross-source join: {@code "GET /admin/realms/{}/users"}. */
    public static String operationKey(String method, String template) {
        return method + " " + normalize(template);
    }

    /** Variable names in path order. */
    public static List<String> variableNames(String template) {
        return parse(template).stream()
                .filter(Variable.class::isInstance)
                .map(p -> ((Variable) p).name())
                .toList();
    }

    /** Renders a template with each variable replaced by {@code value(position, variable)}. */
    public static String expand(String template, VariableRenderer value) {
        StringBuilder out = new StringBuilder();
        int position = 0;
        for (Part p : parse(template)) {
            switch (p) {
                case Literal l -> out.append(l.text());
                case Variable v -> out.append(value.render(position++, v));
            }
        }
        return out.toString();
    }

    /** Supplies the text for the {@code position}-th variable of a template. */
    @FunctionalInterface
    public interface VariableRenderer {
        String render(int position, Variable variable);
    }

    private static String render(String template, Function<Variable, String> var) {
        return expand(template, (position, v) -> var.apply(v));
    }

    private static int matchingBrace(String s, int open) {
        int depth = 0;
        for (int i = open; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '{') {
                depth++;
            } else if (c == '}' && --depth == 0) {
                return i;
            }
        }
        throw new IllegalArgumentException("Unbalanced '{' at " + open + " in template: " + s);
    }

    private static String trimSlashes(String s) {
        int start = 0;
        int end = s.length();
        while (start < end && s.charAt(start) == '/') {
            start++;
        }
        while (end > start && s.charAt(end - 1) == '/') {
            end--;
        }
        return s.substring(start, end);
    }
}
