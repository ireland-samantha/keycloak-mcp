package io.github.irelandsamantha.keycloakmcp.equivalence.harness;

import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class McpStdioClientTest {

    /**
     * Answers each request only when the next one arrives (the last on stdin close), so the second response is
     * written before the first: the client must correlate by id, not by order.
     */
    private static final String OUT_OF_ORDER_SERVER = """
            const rl = require('node:readline').createInterface({ input: process.stdin });
            let held = null;
            const reply = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { echo: m.method } }) + '\\n');
            rl.on('line', line => {
              const m = JSON.parse(line);
              console.error('got ' + m.method);
              if (m.id === undefined) return;
              if (held) { reply(m); reply(held); held = null; } else held = m;
            });
            rl.on('close', () => process.exit(3));
            """;

    private static String echo(McpStdioClient client, String method) {
        try {
            return client.request(method, null).response().at("/result/echo").asText();
        } catch (Exception e) {
            throw new CompletionException(e);
        }
    }

    @Test
    void correlatesOutOfOrderResponsesByIdAndCapturesStderr() throws Exception {
        try (McpStdioClient client = McpStdioClient.start(List.of("node", "-e", OUT_OF_ORDER_SERVER), Map.of(), Duration.ofSeconds(10))) {
            CompletableFuture<String> first = CompletableFuture.supplyAsync(() -> echo(client, "first"));
            Thread.sleep(200);
            assertEquals("second", echo(client, "second"));
            assertEquals("first", first.get(10, TimeUnit.SECONDS));
            assertEquals(3, client.shutdown(Duration.ofSeconds(5)));
            List<String> stderr = client.stderr().stream().map(McpStdioClient.Line::text).toList();
            assertTrue(stderr.containsAll(List.of("got first", "got second")), stderr.toString());
        }
    }
}
