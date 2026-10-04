package io.github.irelandsamantha.keycloakmcp.equivalence.harness;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * An SMTP server that accepts every message and discards it, so the server under test can "send" mail. Some state
 * only exists after a successful send: an organization invitation is stored in the same transaction that mails it,
 * and a mail failure rolls it back ({@code OrganizationInvitationResource.java:184-205}).
 *
 * <p>Speaks the minimum of RFC 5321 a client without authentication or TLS needs: greeting, EHLO/HELO, MAIL, RCPT,
 * DATA, RSET, NOOP, QUIT. Listens on all interfaces because the server usually runs in a container.
 */
public final class SmtpSink implements AutoCloseable {

    private final ServerSocket socket;
    private final AtomicInteger delivered = new AtomicInteger();

    private SmtpSink(ServerSocket socket) {
        this.socket = socket;
        Thread.ofVirtual().start(this::accept);
    }

    public static SmtpSink start() throws IOException {
        ServerSocket socket = new ServerSocket();
        socket.bind(new InetSocketAddress(0));
        return new SmtpSink(socket);
    }

    public int port() {
        return socket.getLocalPort();
    }

    /** Messages accepted so far. */
    public int delivered() {
        return delivered.get();
    }

    @Override
    public void close() throws IOException {
        socket.close();
    }

    private void accept() {
        while (!socket.isClosed()) {
            try {
                Socket connection = socket.accept();
                Thread.ofVirtual().start(() -> converse(connection));
            } catch (IOException closed) {
                return;
            }
        }
    }

    private void converse(Socket connection) {
        try (connection;
             BufferedReader in = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.US_ASCII))) {
            OutputStream out = connection.getOutputStream();
            reply(out, "220 equivalence-smtp");
            for (String line; (line = in.readLine()) != null; ) {
                String verb = line.split(" ", 2)[0].toUpperCase(Locale.ROOT);
                switch (verb) {
                    case "EHLO", "HELO" -> reply(out, "250 equivalence-smtp");
                    case "MAIL", "RCPT", "RSET", "NOOP" -> reply(out, "250 OK");
                    case "DATA" -> {
                        reply(out, "354 End data with <CR><LF>.<CR><LF>");
                        skipMessage(in);
                        delivered.incrementAndGet();
                        reply(out, "250 OK");
                    }
                    case "QUIT" -> {
                        reply(out, "221 Bye");
                        return;
                    }
                    default -> reply(out, "502 Command not implemented");
                }
            }
        } catch (IOException dropped) {
            // the client hung up; nothing to deliver
        }
    }

    private static void skipMessage(BufferedReader in) throws IOException {
        for (String line; (line = in.readLine()) != null && !line.equals("."); ) {
            // discard the message body
        }
    }

    private static void reply(OutputStream out, String line) throws IOException {
        out.write((line + "\r\n").getBytes(StandardCharsets.US_ASCII));
        out.flush();
    }
}
