package com.atelierg37.nearby;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.util.Log;

import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.nearby.Nearby;
import com.google.android.gms.nearby.connection.AdvertisingOptions;
import com.google.android.gms.nearby.connection.ConnectionInfo;
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback;
import com.google.android.gms.nearby.connection.ConnectionResolution;
import com.google.android.gms.nearby.connection.ConnectionsClient;
import com.google.android.gms.nearby.connection.ConnectionsStatusCodes;
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo;
import com.google.android.gms.nearby.connection.DiscoveryOptions;
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback;
import com.google.android.gms.nearby.connection.Payload;
import com.google.android.gms.nearby.connection.PayloadCallback;
import com.google.android.gms.nearby.connection.PayloadTransferUpdate;
import com.google.android.gms.nearby.connection.Strategy;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Cœur des échanges sans Internet (Google Nearby Connections : Bluetooth, BLE et Wi-Fi choisis automatiquement).
 * Partagé par l'app ouverte (module G37Nearby) et par le service d'arrière-plan (recherche toutes les 2 h).
 * Les données échangées sont opaques ici : l'app les chiffre et les signe avant de les confier au téléphone.
 */
public final class NearbyEngine {
    public interface Listener {
        void onEvent(String name, JSONObject data);
    }

    static final String SERVICE_ID = "com.atelierg37.p2p";
    static final String PREFS = "g37.nearby";
    private static final String TAG = "G37Nearby";
    private static NearbyEngine instance;

    static synchronized NearbyEngine get(Context context) {
        if (instance == null) instance = new NearbyEngine(context.getApplicationContext());
        return instance;
    }

    private final Context ctx;
    private final ConnectionsClient client;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final LocalFileServer fileServer = new LocalFileServer();

    private volatile Listener listener;
    private volatile boolean foreground = false;
    private String localName;
    private boolean advertising = false;
    private boolean discovering = false;

    private final Map<String, String> found = new ConcurrentHashMap<>();
    private final Map<String, String> connecting = new ConcurrentHashMap<>();
    private final Map<String, String> connected = new ConcurrentHashMap<>();
    private final Set<String> requested = ConcurrentHashMap.newKeySet();
    private final Map<Long, JSONObject> fileMeta = new ConcurrentHashMap<>();
    private final Map<Long, Payload> incoming = new ConcurrentHashMap<>();
    private final Map<Long, String> incomingFrom = new ConcurrentHashMap<>();
    private final Map<Long, File> outgoingTemp = new ConcurrentHashMap<>();
    private AudioLink audio;

    private NearbyEngine(Context context) {
        ctx = context;
        client = Nearby.getConnectionsClient(context);
        localName = prefs().getString("name", null);
    }

    SharedPreferences prefs() {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // ---------- Fichiers ----------
    File baseDir() {
        File d = new File(ctx.getFilesDir(), "g37p2p");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    File inboxDir() {
        File d = new File(baseDir(), "inbox");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    File packetFile() {
        return new File(baseDir(), "packet.bin");
    }

    /** Chemin relatif au dossier de l'app (comme Directory.Data côté app). Refuse toute sortie du dossier. */
    File resolve(String relative) throws Exception {
        File root = ctx.getFilesDir().getCanonicalFile();
        File f = new File(root, relative).getCanonicalFile();
        if (!f.getPath().startsWith(root.getPath() + File.separator)) throw new SecurityException("Chemin refusé");
        return f;
    }

    String rel(File f) {
        return ctx.getFilesDir().toURI().relativize(f.toURI()).getPath();
    }

    private static void copy(InputStream in, OutputStream out) throws Exception {
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        out.flush();
    }

    private static void writeText(File f, String text) throws Exception {
        try (OutputStream out = new FileOutputStream(f)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        }
    }

    private static String readText(File f) throws Exception {
        try (InputStream in = new FileInputStream(f)) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            copy(in, out);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    static JSONObject obj(Object... kv) {
        JSONObject o = new JSONObject();
        try {
            for (int i = 0; i + 1 < kv.length; i += 2) o.put((String) kv[i], kv[i + 1] == null ? JSONObject.NULL : kv[i + 1]);
        } catch (JSONException ignored) {
        }
        return o;
    }

    // ---------- État ----------
    void setListener(Listener l) {
        listener = l;
    }

    void setForeground(boolean value) {
        foreground = value;
    }

    boolean isForeground() {
        return foreground;
    }

    private void emit(String name, JSONObject data) {
        Listener l = listener;
        if (l == null) return;
        try {
            l.onEvent(name, data);
        } catch (Exception e) {
            Log.w(TAG, "Événement " + name, e);
        }
    }

    JSONObject info() {
        JSONArray peers = new JSONArray();
        for (Map.Entry<String, String> e : connected.entrySet()) peers.put(obj("endpointId", e.getKey(), "name", e.getValue(), "connected", true));
        for (Map.Entry<String, String> e : found.entrySet()) {
            if (!connected.containsKey(e.getKey())) peers.put(obj("endpointId", e.getKey(), "name", e.getValue(), "connected", false));
        }
        return obj("running", advertising || discovering, "name", localName, "peers", peers, "sdk", Build.VERSION.SDK_INT);
    }

    // ---------- Recherche et connexions ----------
    synchronized void start(String name) {
        if (name != null && !name.isEmpty()) {
            localName = name;
            prefs().edit().putString("name", name).apply();
        }
        if (localName == null) return;
        if (!advertising) {
            advertising = true;
            client.startAdvertising(localName, SERVICE_ID, lifecycle,
                    new AdvertisingOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build())
                    .addOnFailureListener(e -> {
                        if (statusOf(e) != ConnectionsStatusCodes.STATUS_ALREADY_ADVERTISING) {
                            advertising = false;
                            emit("error", obj("where", "advertise", "message", String.valueOf(e.getMessage())));
                        }
                    });
        }
        if (!discovering) {
            discovering = true;
            client.startDiscovery(SERVICE_ID, discovery,
                    new DiscoveryOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build())
                    .addOnFailureListener(e -> {
                        if (statusOf(e) != ConnectionsStatusCodes.STATUS_ALREADY_DISCOVERING) {
                            discovering = false;
                            emit("error", obj("where", "discover", "message", String.valueOf(e.getMessage())));
                        }
                    });
        }
    }

    synchronized void stop() {
        try {
            client.stopAdvertising();
            client.stopDiscovery();
            client.stopAllEndpoints();
        } catch (Exception e) {
            Log.w(TAG, "Arrêt", e);
        }
        advertising = false;
        discovering = false;
        found.clear();
        connecting.clear();
        connected.clear();
        requested.clear();
    }

    /** Recherche courte lancée par le service d'arrière-plan. */
    void burst(long durationMs) {
        if (foreground) return;
        start(null);
        main.postDelayed(() -> {
            if (!foreground) stop();
        }, durationMs);
    }

    private static int statusOf(Exception e) {
        return e instanceof ApiException ? ((ApiException) e).getStatusCode() : -1;
    }

    private void request(final String endpointId) {
        if (localName == null) return;
        requested.add(endpointId);
        client.requestConnection(localName, endpointId, lifecycle)
                .addOnFailureListener(e -> {
                    requested.remove(endpointId);
                    if (statusOf(e) != ConnectionsStatusCodes.STATUS_ALREADY_CONNECTED_TO_ENDPOINT) {
                        Log.i(TAG, "Connexion refusée : " + e.getMessage());
                    }
                });
    }

    private final EndpointDiscoveryCallback discovery = new EndpointDiscoveryCallback() {
        @Override
        public void onEndpointFound(final String endpointId, DiscoveredEndpointInfo info) {
            String name = info.getEndpointName();
            found.put(endpointId, name);
            emit("peerFound", obj("endpointId", endpointId, "name", name));
            if (connected.containsKey(endpointId) || requested.contains(endpointId) || connecting.containsKey(endpointId)) return;
            // Un seul des deux téléphones demande la connexion (l'autre réessaie s'il ne se passe rien).
            if (localName != null && localName.compareTo(name) < 0) {
                request(endpointId);
            } else {
                main.postDelayed(() -> {
                    if (found.containsKey(endpointId) && !connected.containsKey(endpointId)
                            && !requested.contains(endpointId) && !connecting.containsKey(endpointId)) {
                        request(endpointId);
                    }
                }, 12000);
            }
        }

        @Override
        public void onEndpointLost(String endpointId) {
            found.remove(endpointId);
            emit("peerLost", obj("endpointId", endpointId));
        }
    };

    private final ConnectionLifecycleCallback lifecycle = new ConnectionLifecycleCallback() {
        @Override
        public void onConnectionInitiated(String endpointId, ConnectionInfo info) {
            connecting.put(endpointId, info.getEndpointName());
            // Acceptation automatique : le contenu est de toute façon chiffré et signé par l'app.
            client.acceptConnection(endpointId, payloads);
        }

        @Override
        public void onConnectionResult(final String endpointId, ConnectionResolution result) {
            String name = connecting.remove(endpointId);
            requested.remove(endpointId);
            if (!result.getStatus().isSuccess()) return;
            if (name == null) name = found.containsKey(endpointId) ? found.get(endpointId) : "";
            connected.put(endpointId, name);
            emit("connected", obj("endpointId", endpointId, "name", name));
            sendPacket(endpointId);
            if (!foreground) {
                // En arrière-plan : on échange les données puis on libère la liaison.
                main.postDelayed(() -> {
                    if (!foreground) {
                        client.disconnectFromEndpoint(endpointId);
                        connected.remove(endpointId);
                    }
                }, 60000);
            }
        }

        @Override
        public void onDisconnected(String endpointId) {
            connected.remove(endpointId);
            requested.remove(endpointId);
            emit("disconnected", obj("endpointId", endpointId));
        }
    };

    // ---------- Données ----------
    private final PayloadCallback payloads = new PayloadCallback() {
        @Override
        public void onPayloadReceived(String endpointId, Payload payload) {
            int type = payload.getType();
            if (type == Payload.Type.BYTES) {
                byte[] bytes = payload.asBytes();
                if (bytes == null) return;
                String text = new String(bytes, StandardCharsets.UTF_8);
                try {
                    JSONObject o = new JSONObject(text);
                    if ("file".equals(o.optString("t"))) {
                        fileMeta.put(o.getLong("id"), o);
                        return;
                    }
                } catch (JSONException ignored) {
                }
                emit("message", obj("endpointId", endpointId, "data", text));
            } else if (type == Payload.Type.FILE) {
                incoming.put(payload.getId(), payload);
                incomingFrom.put(payload.getId(), endpointId);
            } else if (type == Payload.Type.STREAM) {
                Payload.Stream stream = payload.asStream();
                if (stream == null) return;
                synchronized (NearbyEngine.this) {
                    if (audio == null) audio = new AudioLink(ctx);
                    audio.play(stream.asInputStream());
                }
                emit("audio", obj("endpointId", endpointId, "state", "receiving"));
            }
        }

        @Override
        public void onPayloadTransferUpdate(String endpointId, PayloadTransferUpdate update) {
            final long id = update.getPayloadId();
            int status = update.getStatus();
            if (status == PayloadTransferUpdate.Status.SUCCESS) {
                if (incoming.containsKey(id)) io.execute(() -> finishFile(id));
                File tmp = outgoingTemp.remove(id);
                if (tmp != null) {
                    tmp.delete();
                    emit("sent", obj("endpointId", endpointId, "payloadId", id));
                }
            } else if (status == PayloadTransferUpdate.Status.FAILURE || status == PayloadTransferUpdate.Status.CANCELED) {
                incoming.remove(id);
                incomingFrom.remove(id);
                fileMeta.remove(id);
                File tmp = outgoingTemp.remove(id);
                if (tmp != null) tmp.delete();
            }
        }
    };

    @SuppressWarnings("deprecation")
    private void finishFile(long id) {
        Payload payload = incoming.remove(id);
        String from = incomingFrom.remove(id);
        JSONObject meta = fileMeta.remove(id);
        if (payload == null) return;
        Payload.File f = payload.asFile();
        if (f == null) return;
        String kind = meta != null ? meta.optString("kind", "file").replaceAll("[^a-z]", "") : "file";
        String name = meta != null ? meta.optString("name", "") : "";
        File dest = new File(inboxDir(), kind + "-" + System.currentTimeMillis() + "-" + Math.abs(id) + ".bin");
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                Uri uri = f.asUri();
                if (uri == null) return;
                try (InputStream in = ctx.getContentResolver().openInputStream(uri); OutputStream out = new FileOutputStream(dest)) {
                    if (in == null) return;
                    copy(in, out);
                }
                try {
                    ctx.getContentResolver().delete(uri, null, null);
                } catch (Exception ignored) {
                }
            } else {
                File javaFile = f.asJavaFile();
                if (javaFile == null) return;
                try (InputStream in = new FileInputStream(javaFile); OutputStream out = new FileOutputStream(dest)) {
                    copy(in, out);
                }
                javaFile.delete();
            }
            String peerName = from == null ? "" : (connected.containsKey(from) ? connected.get(from) : (found.containsKey(from) ? found.get(from) : ""));
            JSONObject info = obj("path", rel(dest), "kind", kind, "name", name, "endpointId", from, "peerName", peerName,
                    "receivedAt", System.currentTimeMillis(), "size", dest.length());
            if (meta != null) info.put("meta", meta);
            writeText(new File(dest.getPath() + ".json"), info.toString());
            emit("file", info);
        } catch (Exception e) {
            Log.w(TAG, "Fichier reçu illisible", e);
            dest.delete();
        }
    }

    void sendFile(String endpointId, File source, String kind, String name) throws Exception {
        // Copie d'abord : l'app peut réécrire le fichier pendant l'envoi.
        File tmp = new File(baseDir(), "out-" + System.nanoTime() + ".bin");
        try (InputStream in = new FileInputStream(source); OutputStream out = new FileOutputStream(tmp)) {
            copy(in, out);
        }
        Payload filePayload = Payload.fromFile(tmp);
        outgoingTemp.put(filePayload.getId(), tmp);
        JSONObject meta = obj("t", "file", "id", filePayload.getId(), "kind", kind, "name", name, "size", tmp.length());
        client.sendPayload(endpointId, Payload.fromBytes(meta.toString().getBytes(StandardCharsets.UTF_8)));
        client.sendPayload(endpointId, filePayload);
    }

    void sendPacket(final String endpointId) {
        final File packet = packetFile();
        if (!packet.exists()) return;
        io.execute(() -> {
            try {
                sendFile(endpointId, packet, "packet", "packet");
            } catch (Exception e) {
                Log.w(TAG, "Paquet non envoyé", e);
            }
        });
    }

    void broadcastPacket() {
        for (String id : connected.keySet()) sendPacket(id);
    }

    void sendMessage(String endpointId, String data) {
        client.sendPayload(endpointId, Payload.fromBytes(data.getBytes(StandardCharsets.UTF_8)));
    }

    JSONArray listInbox() {
        JSONArray out = new JSONArray();
        File[] files = inboxDir().listFiles();
        if (files == null) return out;
        for (File f : files) {
            if (!f.getName().endsWith(".bin.json")) continue;
            try {
                out.put(new JSONObject(readText(f)));
            } catch (Exception e) {
                f.delete();
            }
        }
        return out;
    }

    void deleteFile(String relative) throws Exception {
        File f = resolve(relative);
        f.delete();
        new File(f.getPath() + ".json").delete();
    }

    JSONObject sha256(String relative) throws Exception {
        File f = resolve(relative);
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
        }
        StringBuilder hex = new StringBuilder();
        for (byte b : md.digest()) hex.append(String.format("%02x", b));
        return obj("hex", hex.toString(), "size", f.length());
    }

    String serveFile(String relative, String name) throws Exception {
        return fileServer.serve(resolve(relative), name);
    }

    // ---------- Appels de proximité ----------
    synchronized void startAudio(String endpointId) throws Exception {
        if (audio == null) audio = new AudioLink(ctx);
        ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createPipe();
        client.sendPayload(endpointId, Payload.fromStream(pipe[0]));
        audio.startCapture(new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1]));
    }

    synchronized void stopAudio() {
        if (audio != null) {
            audio.stop();
            audio = null;
        }
    }

    synchronized void setMuted(boolean muted) {
        if (audio != null) audio.setMuted(muted);
    }

    synchronized void setSpeaker(boolean on) {
        if (audio != null) audio.setSpeaker(on);
    }
}
