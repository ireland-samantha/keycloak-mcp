package io.github.irelandsamantha.keycloakmcp.equivalence.harness;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Hand-rolled MCP stdio client: newline-delimited JSON-RPC 2.0 over a child process. No MCP SDK, so the harness
 * observes the wire exactly.
 *
 * <p>Wire facts established against {@code @modelcontextprotocol/server} 2.1.0: one JSON object per line, UTF-8,
 * no Content-Length framing; responses may arrive out of order (requests are handled concurrently), so they are
 * correlated by id; tool failures come back as {@code result.isError=true}, protocol failures as JSON-RPC errors.
 */
public final class McpStdioClient implements AutoCloseable {

    /** Floats as BigDecimal so number formatting differences stay observable instead of being normalised away. */
    public static final ObjectMapper JSON = new ObjectMapper().enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS);

    public static final String PROTOCOL_VERSION = "2025-11-25";

    /** One line the server wrote, with its arrival time. */
    public record Line(long nanos, String text) {
    }

    /** A JSON-RPC response and how long it took. */
    public record Exchange(JsonNode response, long elapsedNanos, String rawResponseLine) {
    }

    /** The first text content of a {@code tools/call} result. */
    public record ToolResult(boolean isError, String text) {
        public JsonNode json() {
            try {
                return JSON.readTree(text);
            } catch (IOException e) {
                throw new IllegalStateException("Tool result is not JSON: " + text, e);
            }
        }
    }

    private final Process process;
    private final OutputStream stdin;
    private final Duration timeout;
    private final Map<Long, CompletableFuture<String>> pending = new ConcurrentHashMap<>();
    private final List<Line> stderr = Collections.synchronizedList(new ArrayList<>());
    private final List<Line> unsolicited = Collections.synchronizedList(new ArrayList<>());
    private final AtomicLong ids = new AtomicLong();
    private final Thread stdoutPump;
    private final Thread stderrPump;

    private McpStdioClient(Process process, Duration timeout) {
        this.process = process;
        this.stdin = process.getOutputStream();
        this.timeout = timeout;
        this.stdoutPump = Thread.ofVirtual().start(this::pumpStdout);
        this.stderrPump = Thread.ofVirtual().start(this::pumpStderr);
    }

    /** Starts the server with only {@code PATH} and {@code env} in its environment, so tests stay hermetic. */
    public static McpStdioClient start(List<String> command, Map<String, String> env, Duration timeout) throws IOException {
        ProcessBuilder pb = new ProcessBuilder(command);
        pb.environment().clear();
        pb.environment().put("PATH", System.getenv("PATH"));
        pb.environment().putAll(env);
        return new McpStdioClient(pb.start(), timeout);
    }

    /** MCP handshake: {@code initialize} then {@code notifications/initialized}. Returns the initialize result. */
    public JsonNode initialize() throws IOException, InterruptedException, TimeoutException {
        ObjectNode params = JSON.createObjectNode().put("protocolVersion", PROTOCOL_VERSION);
        params.putObject("capabilities");
        params.putObject("clientInfo").put("name", "keycloak-mcp-equivalence").put("version", "0");
        Exchange ex = request("initialize", params);
        if (ex.response().has("error")) {
            throw new IllegalStateException("initialize failed: " + ex.rawResponseLine() + diagnostics());
        }
        notify("notifications/initialized", null);
        return ex.response().get("result");
    }

    /** {@code tools/call}; a JSON-RPC error (as opposed to a tool error) is a protocol failure and throws. */
    public ToolResult callTool(String name, JsonNode arguments) throws IOException, InterruptedException, TimeoutException {
        ObjectNode params = JSON.createObjectNode().put("name", name);
        params.set("arguments", arguments);
        Exchange ex = request("tools/call", params);
        JsonNode result = ex.response().get("result");
        if (result == null) {
            throw new IllegalStateException("tools/call " + name + " failed: " + ex.rawResponseLine());
        }
        return new ToolResult(result.path("isError").asBoolean(false), result.path("content").path(0).path("text").asText());
    }

    public Exchange request(String method, JsonNode params) throws IOException, InterruptedException, TimeoutException {
        long id = ids.incrementAndGet();
        ObjectNode msg = JSON.createObjectNode().put("jsonrpc", "2.0").put("id", id).put("method", method);
        if (params != null) {
            msg.set("params", params);
        }
        CompletableFuture<String> reply = new CompletableFuture<>();
        pending.put(id, reply);
        long start = System.nanoTime();
        try {
            writeLine(JSON.writeValueAsString(msg));
            String raw = reply.get(timeout.toMillis(), TimeUnit.MILLISECONDS);
            return new Exchange(JSON.readTree(raw), System.nanoTime() - start, raw);
        } catch (ExecutionException e) {
            throw new IOException(method + " failed: " + e.getCause().getMessage() + diagnostics(), e.getCause());
        } catch (TimeoutException e) {
            throw new TimeoutException(method + " got no response within " + timeout + diagnostics());
        } finally {
            pending.remove(id);
        }
    }

    public void notify(String method, JsonNode params) throws IOException {
        ObjectNode msg = JSON.createObjectNode().put("jsonrpc", "2.0").put("method", method);
        if (params != null) {
            msg.set("params", params);
        }
        writeLine(JSON.writeValueAsString(msg));
    }

    public List<Line> stderr() {
        synchronized (stderr) {
            return List.copyOf(stderr);
        }
    }

    /** Closes stdin (the MCP stdio shutdown signal) and waits for exit; returns the exit code. */
    public int shutdown(Duration grace) throws InterruptedException {
        try {
            stdin.close();
        } catch (IOException alreadyClosed) {
            // the process may already be gone; its exit code still tells the story
        }
        if (!process.waitFor(grace.toMillis(), TimeUnit.MILLISECONDS)) {
            process.destroy();
            if (!process.waitFor(2, TimeUnit.SECONDS)) {
                process.destroyForcibly();
            }
            process.waitFor();
        }
        stdoutPump.join(Duration.ofSeconds(2));
        stderrPump.join(Duration.ofSeconds(2));
        return process.exitValue();
    }

    @Override
    public void close() throws InterruptedException {
        if (process.isAlive()) {
            shutdown(Duration.ofSeconds(5));
        }
    }

    private synchronized void writeLine(String json) throws IOException {
        if (json.indexOf('\n') >= 0) {
            throw new IllegalArgumentException("stdio framing forbids embedded newlines");
        }
        stdin.write((json + "\n").getBytes(StandardCharsets.UTF_8));
        stdin.flush();
    }

    private void pumpStdout() {
        try (BufferedReader r = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            for (String line; (line = r.readLine()) != null; ) {
                route(line);
            }
        } catch (IOException streamClosed) {
            // fall through: pending requests are failed below
        } finally {
            pending.values().forEach(f -> f.completeExceptionally(new IOException("server stdout closed")));
        }
    }

    private void route(String line) {
        long now = System.nanoTime();
        JsonNode msg;
        try {
            msg = JSON.readTree(line);
        } catch (IOException e) {
            unsolicited.add(new Line(now, "UNPARSEABLE: " + line));
            return;
        }
        JsonNode id = msg.get("id");
        boolean response = id != null && id.canConvertToLong() && (msg.has("result") || msg.has("error"));
        CompletableFuture<String> reply = response ? pending.get(id.asLong()) : null;
        if (reply != null) {
            reply.complete(line);
        } else {
            unsolicited.add(new Line(now, line));
        }
    }

    private void pumpStderr() {
        try (BufferedReader r = new BufferedReader(new InputStreamReader(process.getErrorStream(), StandardCharsets.UTF_8))) {
            for (String line; (line = r.readLine()) != null; ) {
                stderr.add(new Line(System.nanoTime(), line));
            }
        } catch (IOException streamClosed) {
            // nothing more to capture
        }
    }

    /** Process state plus the last stderr lines and unsolicited stdout lines, for failure messages. */
    private String diagnostics() {
        return " [alive=" + process.isAlive() + (process.isAlive() ? "" : ", exit=" + process.exitValue())
                + ", stderr tail=" + tail(stderr) + ", unsolicited stdout tail=" + tail(unsolicited) + "]";
    }

    private static List<String> tail(List<Line> lines) {
        synchronized (lines) {
            List<String> texts = lines.stream().map(Line::text).toList();
            return texts.subList(Math.max(0, texts.size() - 20), texts.size());
        }
    }
}
