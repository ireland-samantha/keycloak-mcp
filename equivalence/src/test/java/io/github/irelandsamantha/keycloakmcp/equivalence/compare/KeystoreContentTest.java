package io.github.irelandsamantha.keycloakmcp.equivalence.compare;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.TextNode;
import io.github.irelandsamantha.keycloakmcp.equivalence.Json;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.util.Base64;
import java.util.function.UnaryOperator;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

class KeystoreContentTest {

    /** Self-signed EC certificate, CN=equivalence-keystore-test (keytool -genkeypair, 2026-09-29); only its bytes matter. */
    private static final String CERTIFICATE = """
            -----BEGIN CERTIFICATE-----
            MIIBYjCCAQigAwIBAgIJANUqR22ie9z4MAoGCCqGSM49BAMDMCQxIjAgBgNVBAMT
            GWVxdWl2YWxlbmNlLWtleXN0b3JlLXRlc3QwIBcNMjYwOTI5MTE1OTM2WhgPMjEy
            NjA5MDUxMTU5MzZaMCQxIjAgBgNVBAMTGWVxdWl2YWxlbmNlLWtleXN0b3JlLXRl
            c3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATTwv+OyD1i52fDYCd/YjCZgchL
            G/Q8I1mtOqnn5xCXOYl8n3bsmBtPiEWEnrB7kbij/PQq680C3JrAQ8ZMNwepoyEw
            HzAdBgNVHQ4EFgQUCBP51Jft/mz/MZcDXl526imebNcwCgYIKoZIzj0EAwMDSAAw
            RQIgFUeJLMMv0D8R67s+aVh0T11jSr+OT6Q1rUlkpyeHyPkCIQDJMk+dmIPLISWF
            w3bSfF20fqtd3K3oNPacMDosKUNx5A==
            -----END CERTIFICATE-----
            """;
    private static final String STORE_PASSWORD = "store-password";
    private static final String KEY_PASSWORD = "key-password";

    /** Fills a keystore of the type under test. */
    @FunctionalInterface
    private interface Entries {
        void addTo(KeyStore store) throws Exception;
    }

    private static Certificate certificate() throws Exception {
        return CertificateFactory.getInstance("X.509")
                .generateCertificate(new ByteArrayInputStream(CERTIFICATE.getBytes(StandardCharsets.US_ASCII)));
    }

    private static PrivateKey key() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(256);
        return generator.generateKeyPair().getPrivate();
    }

    /** A keystore as an observation carries a binary body. */
    private static JsonNode binary(String type, Entries entries) throws Exception {
        KeyStore store = KeyStore.getInstance(type);
        store.load(null, null);
        entries.addTo(store);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        store.store(out, STORE_PASSWORD.toCharArray());
        return Observation.ofHttp(200, "application/octet-stream", out.toByteArray()).value();
    }

    private static UnaryOperator<JsonNode> view(String type) {
        return KeystoreContent.view(new KeystoreContent.Opening(type, STORE_PASSWORD, KEY_PASSWORD));
    }

    /** A private key with the client certificate and the realm certificate, as the download builds them. */
    private static Entries download(PrivateKey key, Certificate certificate, String realmAlias) {
        return store -> {
            store.setKeyEntry("seed-client", key, KEY_PASSWORD.toCharArray(), new Certificate[] {certificate});
            store.setCertificateEntry(realmAlias, certificate);
        };
    }

    @ParameterizedTest
    @ValueSource(strings = {"JKS", "PKCS12"})
    void twoEncodingsOfTheSameEntriesReadAlike(String type) throws Exception {
        PrivateKey key = key();
        Certificate certificate = certificate();
        JsonNode first = binary(type, download(key, certificate, "seed-realm"));
        JsonNode second = binary(type, download(key, certificate, "seed-realm"));
        assertNotEquals(first.path("base64"), second.path("base64"), "salted: the bytes never match");
        JsonNode content = view(type).apply(first);
        assertEquals(content, view(type).apply(second));
        String der = Base64.getEncoder().encodeToString(certificate.getEncoded());
        assertEquals(Json.read("""
                {"contentType": "application/octet-stream", "keystore": {"type": "%s", "entries": {
                  "seed-client": {"entry": "PrivateKeyEntry", "key": {"algorithm": "EC", "format": "PKCS#8", "encoded": "%s"},
                                  "certificateChain": ["%s"]},
                  "seed-realm": {"entry": "TrustedCertificateEntry", "certificateChain": ["%s"]}}}}"""
                .formatted(type, Base64.getEncoder().encodeToString(key.getEncoded()), der, der)), content);
    }

    @ParameterizedTest
    @ValueSource(strings = {"JKS", "PKCS12"})
    void anotherKeyAliasOrEntryReadsDifferently(String type) throws Exception {
        PrivateKey key = key();
        Certificate certificate = certificate();
        JsonNode content = view(type).apply(binary(type, download(key, certificate, "seed-realm")));
        assertNotEquals(content, view(type).apply(binary(type, download(key(), certificate, "seed-realm"))), "key");
        assertNotEquals(content, view(type).apply(binary(type, download(key, certificate, "other-realm"))), "alias");
        assertNotEquals(content, view(type).apply(binary(type, store -> store.setKeyEntry("seed-client", key,
                KEY_PASSWORD.toCharArray(), new Certificate[] {certificate}))), "entries");
    }

    @Test
    void aKeystoreThatDoesNotOpenKeepsItsBytesAndSaysWhy() throws Exception {
        JsonNode binary = binary("PKCS12", download(key(), certificate(), "seed-realm"));
        JsonNode unread = KeystoreContent.view(new KeystoreContent.Opening("PKCS12", "wrong", KEY_PASSWORD)).apply(binary);
        assertEquals(binary.path("base64"), unread.path("base64"));
        assertTrue(unread.path("unreadableKeystore").asText().contains("IOException"), unread.toString());
    }

    @Test
    void anyOtherValueIsLeftAsItIs() {
        JsonNode json = Json.read("""
                {"base64": "AAAA"}""");
        for (JsonNode value : new JsonNode[] {NullNode.getInstance(), new TextNode("text"), json,
                JsonNodeFactory.instance.arrayNode()}) {
            assertSame(value, view("JKS").apply(value));
        }
    }
}
