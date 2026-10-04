package io.github.irelandsamantha.keycloakmcp.equivalence.fixtures;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * State only a login creates: a login failure (brute-force status, LOGIN_ERROR event), an online session and an
 * offline session of the seeded user with the confidential client (LOGIN events), and, after them, a rotated
 * client secret.
 */
final class SessionSeeding {

    private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

    private SessionSeeding() {
    }

    static void seed(Seeding s) {
        s.run("failed login", () -> login(s, "not-" + s.userPassword, "openid", 400));
        s.run("online session", () -> login(s, s.userPassword, "openid", 200));
        s.run("offline session", () -> login(s, s.userPassword, "openid offline_access", 200));
        // With the seeded secret-rotation profile, regenerating keeps the previous secret as the rotated one
        // (ClientSecretRotationExecutor.java rotateSecret); done last because it changes the secret logins use.
        s.run("rotated client secret", () -> s.realm.clients().get(s.id(SeededRealm.CLIENT_ID)).generateNewSecret());
    }

    /** A resource-owner password grant, the only login that needs no browser. */
    private static void login(Seeding s, String password, String scope, int expectedStatus) {
        Map<String, String> form = new LinkedHashMap<>();
        form.put("grant_type", "password");
        form.put("client_id", RealmSeeder.CLIENT);
        form.put("client_secret", s.clientSecret);
        form.put("username", RealmSeeder.USER);
        form.put("password", password);
        form.put("scope", scope);
        String body = form.entrySet().stream()
                .map(e -> e.getKey() + "=" + URLEncoder.encode(e.getValue(), StandardCharsets.UTF_8))
                .collect(Collectors.joining("&"));
        URI token = URI.create(s.context.serverUrl() + "/realms/" + URLEncoder.encode(s.realmName, StandardCharsets.UTF_8) + "/protocol/openid-connect/token");
        HttpRequest request = HttpRequest.newBuilder(token).timeout(Duration.ofSeconds(30))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(body)).build();
        try {
            HttpResponse<String> response = HTTP.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != expectedStatus) {
                throw new IllegalStateException("login answered HTTP " + response.statusCode() + " " + response.body());
            }
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
        }
    }
}
