package io.github.irelandsamantha.keycloakmcp.equivalence.harness;

import org.junit.jupiter.api.Test;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SmtpSinkTest {

    @Test
    void acceptsAMessageTheWayAMailClientSendsIt() throws Exception {
        try (SmtpSink sink = SmtpSink.start();
             Socket s = new Socket(InetAddress.getLoopbackAddress(), sink.port())) {
            BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.US_ASCII));
            OutputStream out = s.getOutputStream();
            assertTrue(in.readLine().startsWith("220 "));
            assertEquals("250", send(out, in, "EHLO keycloak"));
            assertEquals("250", send(out, in, "MAIL FROM:<noreply@seed.example>"));
            assertEquals("250", send(out, in, "RCPT TO:<invitee@seed.example>"));
            assertEquals("354", send(out, in, "DATA"));
            assertEquals("250", send(out, in, "Subject: invitation\r\n\r\nbody\r\n."));
            assertEquals("221", send(out, in, "QUIT"));
            assertEquals(1, sink.delivered());
        }
    }

    @Test
    void refusesWhatItDoesNotImplement() throws Exception {
        try (SmtpSink sink = SmtpSink.start();
             Socket s = new Socket(InetAddress.getLoopbackAddress(), sink.port())) {
            BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.US_ASCII));
            in.readLine();
            assertEquals("502", send(s.getOutputStream(), in, "STARTTLS"));
            assertEquals(0, sink.delivered());
        }
    }

    private static String send(OutputStream out, BufferedReader in, String lines) throws Exception {
        out.write((lines + "\r\n").getBytes(StandardCharsets.US_ASCII));
        out.flush();
        return in.readLine().substring(0, 3);
    }
}
