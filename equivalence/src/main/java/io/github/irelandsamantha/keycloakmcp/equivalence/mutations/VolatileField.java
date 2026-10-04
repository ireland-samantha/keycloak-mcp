package io.github.irelandsamantha.keycloakmcp.equivalence.mutations;

/**
 * A readback value that legitimately differs between two realms in the same state, masked on both sides.
 *
 * @param readback operation key of the {@link Readback}, as written there
 * @param path     JSON path as {@code JsonDiff} prints it; {@code [*]} matches any index, {@code .*} any field
 * @param reason   why the value differs, citing the server source
 */
public record VolatileField(String readback, String path, String reason) {
}
