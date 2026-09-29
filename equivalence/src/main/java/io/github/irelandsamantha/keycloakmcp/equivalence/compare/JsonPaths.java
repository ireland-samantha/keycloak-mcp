package io.github.irelandsamantha.keycloakmcp.equivalence.compare;

import java.util.regex.Pattern;

/** Path patterns over the paths {@link JsonDiff} prints ({@code $.a.b[0].c}). */
final class JsonPaths {

    private JsonPaths() {
    }

    /**
     * Compiles a path pattern: {@code [*]} matches any array index and {@code .*} any single field name; everything
     * else is literal.
     */
    static Pattern pattern(String path) {
        StringBuilder regex = new StringBuilder();
        int i = 0;
        while (i < path.length()) {
            if (path.startsWith("[*]", i)) {
                regex.append("\\[\\d+]");
                i += 3;
            } else if (path.startsWith(".*", i)) {
                regex.append("\\.[^.\\[]+");
                i += 2;
            } else {
                regex.append(Pattern.quote(String.valueOf(path.charAt(i))));
                i++;
            }
        }
        return Pattern.compile(regex.toString());
    }
}
