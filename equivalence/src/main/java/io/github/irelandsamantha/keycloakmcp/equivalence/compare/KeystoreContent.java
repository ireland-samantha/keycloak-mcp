package io.github.irelandsamantha.keycloakmcp.equivalence.compare;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.security.GeneralSecurityException;
import java.security.Key;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.function.UnaryOperator;

/**
 * A binary keystore as what it holds rather than as its bytes. Keycloak builds the client keystore download anew
 * for every request ({@code ClientAttributeCertificateResource.java:304-338}): PKCS12 salts its integrity MAC and
 * its encrypted bags, and JKS stamps every entry with the time it was added, so two downloads of the same state never
 * share their bytes. Opened with the passwords the request chose, a keystore is instead compared by its type and,
 * per alias, the kind of entry, its certificate chain (DER) and its key (algorithm, format, encoding). Entry dates
 * are left out: they are the time of the request.
 */
public final class KeystoreContent {

    private static final Base64.Encoder BASE64 = Base64.getEncoder();

    /**
     * @param type          {@link KeyStore#getInstance(String)} type, e.g. {@code JKS} or {@code PKCS12}
     * @param storePassword opens the store
     * @param keyPassword   opens its key entries
     */
    public record Opening(String type, String storePassword, String keyPassword) {
    }

    private KeystoreContent() {
    }

    /**
     * Replaces a binary value ({@code {base64, contentType}}, see {@link Observation}) by its content opened with
     * {@code opening}; any other value (an error, JSON) is returned as it is. A keystore that cannot be opened keeps
     * its bytes and gains the reason ({@code unreadableKeystore}), so it can never pass for another one.
     */
    public static UnaryOperator<JsonNode> view(Opening opening) {
        return value -> {
            if (value == null || !value.isObject() || !value.has("base64") || !value.has("contentType")) {
                return value;
            }
            ObjectNode out = JsonNodeFactory.instance.objectNode().put("contentType", value.path("contentType").asText());
            try {
                out.set("keystore", content(Base64.getDecoder().decode(value.path("base64").asText()), opening));
            } catch (GeneralSecurityException | IOException | IllegalArgumentException e) {
                out.put("base64", value.path("base64").asText()).put("unreadableKeystore", e.toString());
            }
            return out;
        };
    }

    /** What the keystore in {@code bytes} holds, alias by alias in alphabetical order. */
    static ObjectNode content(byte[] bytes, Opening opening) throws GeneralSecurityException, IOException {
        KeyStore store = KeyStore.getInstance(opening.type());
        store.load(new ByteArrayInputStream(bytes), opening.storePassword().toCharArray());
        ObjectNode out = JsonNodeFactory.instance.objectNode().put("type", store.getType());
        ObjectNode entries = out.putObject("entries");
        List<String> aliases = Collections.list(store.aliases());
        Collections.sort(aliases);
        for (String alias : aliases) {
            ObjectNode entry = entries.putObject(alias);
            if (store.isKeyEntry(alias)) {
                Key key = store.getKey(alias, opening.keyPassword().toCharArray());
                entry.put("entry", store.getCertificateChain(alias) == null ? "SecretKeyEntry" : "PrivateKeyEntry");
                entry.putObject("key").put("algorithm", key.getAlgorithm()).put("format", key.getFormat())
                        .put("encoded", key.getEncoded() == null ? null : BASE64.encodeToString(key.getEncoded()));
                chain(entry, store.getCertificateChain(alias));
            } else {
                entry.put("entry", "TrustedCertificateEntry");
                chain(entry, new Certificate[] {store.getCertificate(alias)});
            }
        }
        return out;
    }

    private static void chain(ObjectNode entry, Certificate[] chain) throws GeneralSecurityException {
        if (chain == null) {
            return;
        }
        var array = entry.putArray("certificateChain");
        for (Certificate certificate : chain) {
            array.add(BASE64.encodeToString(certificate.getEncoded()));
        }
    }
}
