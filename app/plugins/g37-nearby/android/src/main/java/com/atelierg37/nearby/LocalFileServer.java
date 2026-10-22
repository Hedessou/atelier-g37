package com.atelierg37.nearby;

import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;

/**
 * Petit serveur réservé au téléphone lui-même (127.0.0.1) : il sert une seule fois un fichier
 * (mise à jour reçue d'un collègue) pour que le module de mise à jour l'installe comme s'il venait d'Internet.
 */
final class LocalFileServer {
    private static final String TAG = "G37Serve";
    private ServerSocket socket;
    private Thread thread;

    synchronized String serve(final File file, String name) throws Exception {
        stop();
        final ServerSocket ss = new ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"));
        ss.setSoTimeout(1000);
        socket = ss;
        byte[] rnd = new byte[16];
        new SecureRandom().nextBytes(rnd);
        StringBuilder token = new StringBuilder();
        for (byte b : rnd) token.append(String.format("%02x", b));
        final String path = "/" + token + "/" + name.replaceAll("[^A-Za-z0-9._-]", "_");
        final long deadline = System.currentTimeMillis() + 10 * 60 * 1000;
        thread = new Thread(() -> {
            while (!ss.isClosed() && System.currentTimeMillis() < deadline) {
                try (Socket client = ss.accept()) {
                    client.setSoTimeout(15000);
                    BufferedReader reader = new BufferedReader(new InputStreamReader(client.getInputStream(), StandardCharsets.US_ASCII));
                    String requestLine = reader.readLine();
                    String line;
                    while ((line = reader.readLine()) != null && !line.isEmpty()) {
                        // en-têtes ignorés
                    }
                    OutputStream out = client.getOutputStream();
                    if (requestLine != null && requestLine.startsWith("GET " + path)) {
                        String head = "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: " + file.length()
                                + "\r\nConnection: close\r\n\r\n";
                        out.write(head.getBytes(StandardCharsets.US_ASCII));
                        try (InputStream in = new FileInputStream(file)) {
                            byte[] buf = new byte[64 * 1024];
                            int n;
                            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                        }
                    } else {
                        out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                    }
                    out.flush();
                } catch (SocketTimeoutException ignored) {
                    // on attend la demande
                } catch (Exception e) {
                    if (!ss.isClosed()) Log.w(TAG, "Envoi local", e);
                }
            }
            try { ss.close(); } catch (Exception ignored) { }
        }, "g37-local-serve");
        thread.start();
        return "http://127.0.0.1:" + ss.getLocalPort() + path;
    }

    synchronized void stop() {
        try { if (socket != null) socket.close(); } catch (Exception ignored) { }
        socket = null;
        thread = null;
    }
}
