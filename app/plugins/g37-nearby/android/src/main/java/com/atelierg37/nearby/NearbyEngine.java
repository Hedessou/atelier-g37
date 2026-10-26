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
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Cœur des échanges sans Internet, partagé par l'app ouverte (module G37Nearby) et par le service d'arrière-plan.
 *  - Google Nearby Connections : Bluetooth, BLE et Wi-Fi direct choisis automatiquement (identifiant « nearby »).
 *  - Réseau Wi-Fi local (box sans Internet ou point d'accès d'un téléphone) : identifiants « lan:… » (LanEngine).
 * Pour l'app, les deux se ressemblent : mêmes événements, mêmes envois de messages et de fichiers.
 * Version 4 : le téléphone reste joignable app fermée (annonce permanente, recherche par rafales),
 * affiche lui-même les appels de proximité entrants et les messages / pannes reçus des collègues proches.
 * Version 5 : liaisons Bluetooth fiables (nouvel essai automatique, plus de collision entre les deux téléphones,
 * recherche mise en pause pendant la connexion), relance rapide, journal des erreurs, et réseau Wi-Fi
 * créé par le téléphone lui-même (point d'accès local) avec invitation automatique des collègues.
 */
public final class NearbyEngine implements LanEngine.Callback, HotspotManager.Listener {
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
    private final LanEngine lan;
    private final HotspotManager hotspot;

    private volatile Listener listener;
    private volatile boolean foreground = false;
    private String localName;
    private boolean advertising = false;
    private boolean discovering = false;
    private long discoveryUntil = 0;

    private final Map<String, String> found = new ConcurrentHashMap<>();
    private final Map<String, String> connecting = new ConcurrentHashMap<>();
    private final Map<String, String> connected = new ConcurrentHashMap<>();
    private final Set<String> requested = ConcurrentHashMap.newKeySet();
    // v5 : suivi des tentatives de liaison Bluetooth (nouvel essai, délais croissants).
    private final Map<String, Long> firstSeenAt = new ConcurrentHashMap<>();
    private final Map<String, Long> requestedAt = new ConcurrentHashMap<>();
    private final Map<String, Integer> attempts = new ConcurrentHashMap<>();
    private final Map<String, Long> nextTryAt = new ConcurrentHashMap<>();
    private final java.util.ArrayDeque<JSONObject> errors = new java.util.ArrayDeque<>();
    private long discoveryStartedAt = 0;
    private long lastFoundAt = 0;
    private boolean discoveryPaused = false;
    private boolean watchdogOn = false;
    private final Map<Long, JSONObject> fileMeta = new ConcurrentHashMap<>();
    private final Map<Long, Payload> incoming = new ConcurrentHashMap<>();
    private final Map<Long, String> incomingFrom = new ConcurrentHashMap<>();
    private final Map<Long, File> outgoingTemp = new ConcurrentHashMap<>();
    private AudioLink audio;

    /** Appel de proximité qui sonne alors que l'app est fermée (repris par l'app à l'ouverture). */
    private volatile JSONObject ringing;

    private NearbyEngine(Context context) {
        ctx = context;
        client = Nearby.getConnectionsClient(context);
        localName = prefs().getString("name", null);
        lan = new LanEngine(context, this, new File(baseDir(), "lan-tmp"));
        hotspot = new HotspotManager(context, this);
    }

    SharedPreferences prefs() {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Rester joignable app fermée (appels et messages de proximité). Activé par défaut. */
    boolean alwaysReachable() {
        return prefs().getBoolean("always", true);
    }

    void setAlwaysReachable(boolean on) {
        prefs().edit().putBoolean("always", on).apply();
        if (!foreground) {
            if (on) ensureBackground();
            else stop();
        }
    }

    /** Numéro du compte connecté sur ce téléphone (le nom annoncé est « G37:<id>:<appareil> »). */
    int myUserId() {
        String n = localName;
        if (n == null) return -1;
        String[] parts = n.split(":");
        try {
            return parts.length >= 2 ? Integer.parseInt(parts[1]) : -1;
        } catch (NumberFormatException e) {
            return -1;
        }
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

    File hintsFile() {
        return new File(baseDir(), "hints.json");
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

    static String readText(File f) throws Exception {
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
        lan.setBeaconInterval(value ? 2000 : 15000);
        if (value) lan.announceNow();
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

    String nameOf(String endpointId) {
        if (LanEngine.isLan(endpointId)) return endpointId.substring(LanEngine.PREFIX.length());
        String n = connected.get(endpointId);
        if (n == null) n = found.get(endpointId);
        return n == null ? "" : n;
    }

    JSONObject info() {
        JSONArray peers = new JSONArray();
        for (Map.Entry<String, String> e : connected.entrySet()) peers.put(obj("endpointId", e.getKey(), "name", e.getValue(), "connected", true, "medium", "nearby"));
        for (Map.Entry<String, String> e : found.entrySet()) {
            if (!connected.containsKey(e.getKey())) peers.put(obj("endpointId", e.getKey(), "name", e.getValue(), "connected", false, "medium", "nearby"));
        }
        Map<String, String> lanConnected = lan.connectedPeers();
        for (Map.Entry<String, String> e : lanConnected.entrySet()) peers.put(obj("endpointId", e.getKey(), "name", e.getValue(), "connected", true, "medium", "wifi"));
        for (Map.Entry<String, String> e : lan.foundPeers().entrySet()) {
            if (!lanConnected.containsKey(e.getKey())) peers.put(obj("endpointId", e.getKey(), "name", e.getValue(), "connected", false, "medium", "wifi"));
        }
        JSONArray errs = new JSONArray();
        synchronized (errors) {
            for (JSONObject e : errors) errs.put(e);
        }
        return obj("running", advertising || discovering || lan.isRunning(), "advertising", advertising, "discovering", discovering || discoveryPaused,
                "wifiLan", lan.isRunning(), "name", localName, "peers", peers, "sdk", Build.VERSION.SDK_INT, "always", alwaysReachable(),
                "native", 5, "errors", errs, "hotspot", hotspot.state());
    }

    /** Dernières erreurs (affichées dans le guide de connexion pour comprendre un échec). */
    private void noteError(String where, Exception e, String endpointId) {
        noteError(where, statusOf(e), String.valueOf(e.getMessage()), endpointId);
    }

    private void noteError(String where, int code, String message, String endpointId) {
        JSONObject o = obj("where", where, "code", code, "message", message, "at", System.currentTimeMillis(),
                "peer", endpointId == null ? null : nameOf(endpointId));
        synchronized (errors) {
            errors.addFirst(o);
            while (errors.size() > 8) errors.removeLast();
        }
        Log.i(TAG, where + " " + code + " " + message);
        emit("error", o);
    }

    // ---------- Recherche et connexions ----------
    private void setName(String name) {
        if (name != null && !name.isEmpty()) {
            localName = name;
            prefs().edit().putString("name", name).apply();
        }
    }

    /** App ouverte : annonce + recherche continues, Bluetooth et Wi-Fi local. */
    synchronized void start(String name) {
        setName(name);
        if (localName == null) return;
        startAdvertising();
        startDiscovery();
        discoveryUntil = Long.MAX_VALUE;
        lan.start(localName);
        startWatchdog();
    }

    /** Recherche voulue en ce moment (app ouverte, ou rafale du service d'arrière-plan). */
    private boolean wantDiscovery() {
        return localName != null && (foreground || System.currentTimeMillis() < discoveryUntil);
    }

    /**
     * Relance immédiate (bouton « Relancer la recherche ») : recherche Bluetooth repartie de zéro,
     * annonce Wi-Fi, et nouvel essai tout de suite vers chaque collègue déjà repéré.
     */
    synchronized void quickConnect(String name) {
        setName(name);
        if (localName == null) return;
        attempts.clear();
        nextTryAt.clear();
        long now = System.currentTimeMillis();
        for (Map.Entry<String, Long> e : requestedAt.entrySet()) {
            if (now - e.getValue() > 20000) {
                requested.remove(e.getKey());
                requestedAt.remove(e.getKey());
            }
        }
        if (discoveryUntil < now + 120000) discoveryUntil = foreground ? Long.MAX_VALUE : now + 120000;
        startAdvertising();
        restartDiscovery();
        lan.start(localName);
        lan.announceNow();
        startWatchdog();
        for (String id : found.keySet()) {
            firstSeenAt.put(id, now - 60000); // l'autre téléphone n'a rien fait : on appelle nous-mêmes
            maybeConnect(id);
        }
    }

    private synchronized void restartDiscovery() {
        try {
            client.stopDiscovery();
        } catch (Exception ignored) {
        }
        discovering = false;
        discoveryPaused = false;
        startDiscovery();
    }

    /** Surveillance toutes les 4 s : nouveaux essais, reprise de la recherche, recherche bloquée relancée. */
    private void startWatchdog() {
        if (watchdogOn) return;
        watchdogOn = true;
        main.postDelayed(watchdog, 4000);
    }

    private final Runnable watchdog = new Runnable() {
        @Override
        public void run() {
            long now = System.currentTimeMillis();
            // Hors recherche (app fermée entre deux rafales) : rien à surveiller, la prochaine rafale relancera.
            boolean active = wantDiscovery() || !requestedAt.isEmpty() || discoveryPaused;
            if (!active || localName == null) {
                watchdogOn = false;
                return;
            }
            try {
                // Demande restée sans réponse : on la considère perdue.
                for (Map.Entry<String, Long> e : requestedAt.entrySet()) {
                    if (now - e.getValue() > 35000 && !connecting.containsKey(e.getKey()) && !connected.containsKey(e.getKey())) {
                        requested.remove(e.getKey());
                        requestedAt.remove(e.getKey());
                        backoff(e.getKey());
                        noteError("connect", -2, "Pas de réponse", e.getKey());
                    }
                }
                if (discoveryPaused && (requestedAt.isEmpty() || now - newestRequest() > 15000)) resumeDiscovery();
                if (wantDiscovery()) for (String id : found.keySet()) maybeConnect(id);
                // Recherche lancée depuis longtemps sans rien trouver : certains téléphones la bloquent, on la relance.
                if (wantDiscovery() && discovering && !discoveryPaused && connected.isEmpty() && requestedAt.isEmpty()
                        && now - discoveryStartedAt > 90000 && now - lastFoundAt > 90000) {
                    restartDiscovery();
                } else if (wantDiscovery() && !discovering && !discoveryPaused) {
                    startDiscovery();
                }
            } catch (Exception e) {
                Log.w(TAG, "Surveillance", e);
            }
            main.postDelayed(this, 4000);
        }
    };

    private long newestRequest() {
        long n = 0;
        for (Long v : requestedAt.values()) n = Math.max(n, v);
        return n;
    }

    /** Délai avant le prochain essai : 3 s, 6 s, 12 s… jusqu'à 45 s (avec un peu de hasard pour éviter les collisions). */
    private void backoff(String endpointId) {
        int n = attempts.containsKey(endpointId) ? attempts.get(endpointId) + 1 : 1;
        attempts.put(endpointId, n);
        long delay = Math.min(45000L, 3000L << Math.min(n - 1, 4));
        delay += (long) (Math.random() * 1500);
        nextTryAt.put(endpointId, System.currentTimeMillis() + delay);
    }

    /**
     * Faut-il demander la liaison maintenant ? Le téléphone au plus petit nom appelle ;
     * l'autre attend 20 s (une liaison Bluetooth peut prendre plus de 10 s) avant d'appeler à son tour.
     */
    private void maybeConnect(String endpointId) {
        if (localName == null) return;
        String name = found.get(endpointId);
        if (name == null || connected.containsKey(endpointId) || connecting.containsKey(endpointId) || requested.contains(endpointId)) return;
        if (linkedByWifi(name)) return; // déjà relié par le Wi-Fi local : inutile
        long now = System.currentTimeMillis();
        Long next = nextTryAt.get(endpointId);
        if (next != null && now < next) return;
        boolean caller = localName.compareTo(name) < 0;
        if (!caller) {
            Long first = firstSeenAt.get(endpointId);
            if (first == null || now - first < 20000) return;
        }
        request(endpointId);
    }

    /** Pendant qu'une liaison Bluetooth s'établit, la recherche est suspendue (elle la perturbe beaucoup). */
    private synchronized void pauseDiscovery() {
        if (!discovering) return;
        try {
            client.stopDiscovery();
        } catch (Exception ignored) {
        }
        discovering = false;
        discoveryPaused = true;
    }

    private synchronized void resumeDiscovery() {
        if (!discoveryPaused) return;
        discoveryPaused = false;
        if (wantDiscovery()) startDiscovery();
    }

    /** App fermée, mode « toujours joignable » : on reste visible (annonce) et à l'écoute du Wi-Fi local. */
    synchronized void ensureBackground() {
        if (localName == null || !alwaysReachable()) return;
        startAdvertising();
        lan.start(localName);
    }

    private void startAdvertising() {
        if (advertising) return;
        advertising = true;
        client.startAdvertising(localName, SERVICE_ID, lifecycle,
                new AdvertisingOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build())
                .addOnFailureListener(e -> {
                    if (statusOf(e) != ConnectionsStatusCodes.STATUS_ALREADY_ADVERTISING) {
                        advertising = false;
                        noteError("advertise", e, null);
                    }
                });
    }

    private void startDiscovery() {
        if (discovering) return;
        discovering = true;
        discoveryStartedAt = System.currentTimeMillis();
        client.startDiscovery(SERVICE_ID, discovery,
                new DiscoveryOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build())
                .addOnFailureListener(e -> {
                    if (statusOf(e) != ConnectionsStatusCodes.STATUS_ALREADY_DISCOVERING) {
                        discovering = false;
                        noteError("discover", e, null);
                    }
                });
    }

    private synchronized void stopDiscovery() {
        try {
            client.stopDiscovery();
        } catch (Exception ignored) {
        }
        discovering = false;
    }

    synchronized void stop() {
        try {
            client.stopAdvertising();
            client.stopDiscovery();
            client.stopAllEndpoints();
        } catch (Exception e) {
            Log.w(TAG, "Arrêt", e);
        }
        lan.stop();
        advertising = false;
        discovering = false;
        discoveryPaused = false;
        found.clear();
        connecting.clear();
        connected.clear();
        requested.clear();
        requestedAt.clear();
        firstSeenAt.clear();
        attempts.clear();
        nextTryAt.clear();
    }

    /** Recherche courte lancée par le service d'arrière-plan. */
    void burst(long durationMs) {
        if (foreground) return;
        if (localName == null) return;
        synchronized (this) {
            startAdvertising();
            startDiscovery();
            lan.start(localName);
            lan.announceNow();
            discoveryUntil = System.currentTimeMillis() + durationMs;
            startWatchdog();
        }
        main.postDelayed(() -> {
            if (foreground || System.currentTimeMillis() < discoveryUntil) return;
            discoveryPaused = false;
            if (alwaysReachable()) stopDiscovery(); // on reste joignable, seule la recherche s'arrête
            else stop();
        }, durationMs + 500);
    }

    private static int statusOf(Exception e) {
        return e instanceof ApiException ? ((ApiException) e).getStatusCode() : -1;
    }

    private void request(final String endpointId) {
        if (localName == null) return;
        if (!requested.add(endpointId)) return;
        requestedAt.put(endpointId, System.currentTimeMillis());
        pauseDiscovery();
        try {
            client.requestConnection(localName, endpointId, lifecycle)
                    .addOnFailureListener(e -> {
                        requested.remove(endpointId);
                        requestedAt.remove(endpointId);
                        if (statusOf(e) == ConnectionsStatusCodes.STATUS_ALREADY_CONNECTED_TO_ENDPOINT) return;
                        backoff(endpointId);
                        noteError("connect", e, endpointId);
                        if (requestedAt.isEmpty()) main.postDelayed(this::resumeDiscovery, 800);
                    });
        } catch (Exception e) {
            requested.remove(endpointId);
            requestedAt.remove(endpointId);
            backoff(endpointId);
            noteError("connect", e, endpointId);
            resumeDiscovery();
        }
    }

    /** Déjà relié à ce collègue par le Wi-Fi local : inutile d'ouvrir aussi une liaison Bluetooth. */
    private boolean linkedByWifi(String peerName) {
        return peerName != null && lan.isConnected(LanEngine.PREFIX + peerName);
    }

    private final EndpointDiscoveryCallback discovery = new EndpointDiscoveryCallback() {
        @Override
        public void onEndpointFound(final String endpointId, DiscoveredEndpointInfo info) {
            String name = info.getEndpointName();
            if (name == null || !name.startsWith("G37:")) return;
            found.put(endpointId, name);
            lastFoundAt = System.currentTimeMillis();
            if (!firstSeenAt.containsKey(endpointId)) firstSeenAt.put(endpointId, lastFoundAt);
            emit("peerFound", obj("endpointId", endpointId, "name", name, "medium", "nearby"));
            // Un seul des deux téléphones demande la liaison ; l'autre prend le relais au bout de 20 s (surveillance).
            maybeConnect(endpointId);
            startWatchdog();
        }

        @Override
        public void onEndpointLost(String endpointId) {
            found.remove(endpointId);
            firstSeenAt.remove(endpointId);
            attempts.remove(endpointId);
            nextTryAt.remove(endpointId);
            emit("peerLost", obj("endpointId", endpointId));
        }
    };

    private final ConnectionLifecycleCallback lifecycle = new ConnectionLifecycleCallback() {
        @Override
        public void onConnectionInitiated(String endpointId, ConnectionInfo info) {
            String name = info.getEndpointName();
            if (name == null || !name.startsWith("G37:")) {
                client.rejectConnection(endpointId);
                return;
            }
            connecting.put(endpointId, name);
            // Acceptation automatique : le contenu est de toute façon chiffré et signé par l'app.
            client.acceptConnection(endpointId, payloads).addOnFailureListener(e -> noteError("accept", e, endpointId));
        }

        @Override
        public void onConnectionResult(final String endpointId, ConnectionResolution result) {
            String name = connecting.remove(endpointId);
            requested.remove(endpointId);
            requestedAt.remove(endpointId);
            if (requestedAt.isEmpty()) main.postDelayed(NearbyEngine.this::resumeDiscovery, 800);
            if (!result.getStatus().isSuccess()) {
                backoff(endpointId);
                int code = result.getStatus().getStatusCode();
                String msg = result.getStatus().getStatusMessage();
                noteError("connect", code, msg == null ? "" : msg, endpointId);
                return;
            }
            attempts.remove(endpointId);
            nextTryAt.remove(endpointId);
            if (name == null) name = found.containsKey(endpointId) ? found.get(endpointId) : "";
            connected.put(endpointId, name);
            emit("connected", obj("endpointId", endpointId, "name", name, "medium", "nearby"));
            // Même collègue déjà relié en Wi-Fi : les données passent déjà par là.
            if (!linkedByWifi(name)) {
                sendPacket(endpointId);
                sendHints(endpointId);
            }
            // Réseau Wi-Fi créé par ce téléphone : on invite le collègue à le rejoindre.
            sendHotspotInvite(endpointId);
            if (!foreground && !alwaysReachable()) {
                // En arrière-plan sans « toujours joignable » : on échange les données puis on libère la liaison.
                main.postDelayed(() -> {
                    if (!foreground && !alwaysReachable()) {
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
            requestedAt.remove(endpointId);
            // Toujours à portée : nouvel essai rapide (la surveillance s'en charge).
            nextTryAt.put(endpointId, System.currentTimeMillis() + 2000);
            emit("disconnected", obj("endpointId", endpointId));
            startWatchdog();
        }
    };

    // ---------- Wi-Fi local (LanEngine) ----------
    @Override
    public void onLanPeerFound(String id, String name) {
        emit("peerFound", obj("endpointId", id, "name", name, "medium", "wifi"));
    }

    @Override
    public void onLanPeerLost(String id) {
        emit("peerLost", obj("endpointId", id));
    }

    @Override
    public void onLanConnected(String id, String name) {
        emit("connected", obj("endpointId", id, "name", name, "medium", "wifi"));
        sendPacket(id);
        sendHints(id);
    }

    @Override
    public void onLanDisconnected(String id) {
        emit("disconnected", obj("endpointId", id));
    }

    @Override
    public void onLanMessage(String id, String text) {
        handleText(id, text);
    }

    @Override
    public void onLanFile(final String id, final JSONObject meta, final File file) {
        io.execute(() -> storeIncoming(file, meta, id, true));
    }

    // ---------- Données (Nearby) ----------
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
                handleText(endpointId, text);
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
        File tmp = new File(baseDir(), "in-" + System.nanoTime() + ".part");
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                Uri uri = f.asUri();
                if (uri == null) return;
                try (InputStream in = ctx.getContentResolver().openInputStream(uri); OutputStream out = new FileOutputStream(tmp)) {
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
                try (InputStream in = new FileInputStream(javaFile); OutputStream out = new FileOutputStream(tmp)) {
                    copy(in, out);
                }
                javaFile.delete();
            }
            storeIncoming(tmp, meta, from, false);
        } catch (Exception e) {
            Log.w(TAG, "Fichier reçu illisible", e);
            tmp.delete();
        }
    }

    /** Range un fichier reçu (Bluetooth ou Wi-Fi) dans la boîte de réception lue par l'app. */
    private void storeIncoming(File tmp, JSONObject meta, String from, boolean viaWifi) {
        String kind = meta != null ? meta.optString("kind", "file").replaceAll("[^a-z]", "") : "file";
        if (kind.isEmpty()) kind = "file";
        String name = meta != null ? meta.optString("name", "") : "";
        File dest = new File(inboxDir(), kind + "-" + System.currentTimeMillis() + "-" + Math.abs(System.nanoTime() % 1000000) + ".bin");
        try {
            if (!tmp.renameTo(dest)) {
                try (InputStream in = new FileInputStream(tmp); OutputStream out = new FileOutputStream(dest)) {
                    copy(in, out);
                }
                tmp.delete();
            }
            JSONObject info = obj("path", rel(dest), "kind", kind, "name", name, "endpointId", from, "peerName", from == null ? "" : nameOf(from),
                    "receivedAt", System.currentTimeMillis(), "size", dest.length(), "medium", viaWifi ? "wifi" : "nearby");
            if (meta != null) info.put("meta", meta);
            writeText(new File(dest.getPath() + ".json"), info.toString());
            emit("file", info);
        } catch (Exception e) {
            Log.w(TAG, "Fichier non rangé", e);
            dest.delete();
            tmp.delete();
        }
    }

    void sendFile(String endpointId, File source, String kind, String name) throws Exception {
        // Copie d'abord : l'app peut réécrire le fichier pendant l'envoi.
        File tmp = new File(baseDir(), "out-" + System.nanoTime() + ".bin");
        try (InputStream in = new FileInputStream(source); OutputStream out = new FileOutputStream(tmp)) {
            copy(in, out);
        }
        if (LanEngine.isLan(endpointId)) {
            final File sending = tmp;
            lan.sendFile(endpointId, sending, obj("t", "file", "id", System.nanoTime(), "kind", kind, "name", name, "size", sending.length()));
            // Le fichier temporaire est relu par la liaison Wi-Fi : on le supprime un peu plus tard.
            main.postDelayed(sending::delete, 10 * 60 * 1000);
            return;
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

    /** Petites annonces (« message de… », « panne M/C… ») affichées par le téléphone du collègue même app fermée. */
    void sendHints(final String endpointId) {
        final File hints = hintsFile();
        if (!hints.exists() || hints.length() > 30000) return;
        io.execute(() -> {
            try {
                JSONArray items = new JSONArray(readText(hints));
                if (items.length() == 0) return;
                sendMessage(endpointId, obj("t", "hints", "items", items).toString());
            } catch (Exception e) {
                Log.w(TAG, "Annonces non envoyées", e);
            }
        });
    }

    void broadcastPacket() {
        Set<String> names = new HashSet<>();
        for (Map.Entry<String, String> e : lan.connectedPeers().entrySet()) {
            names.add(e.getValue());
            sendPacket(e.getKey());
            sendHints(e.getKey());
        }
        for (Map.Entry<String, String> e : connected.entrySet()) {
            if (names.contains(e.getValue())) continue;
            sendPacket(e.getKey());
            sendHints(e.getKey());
        }
    }

    void sendMessage(String endpointId, String data) {
        if (LanEngine.isLan(endpointId)) {
            try {
                lan.send(endpointId, data);
            } catch (Exception e) {
                Log.w(TAG, "Message Wi-Fi non envoyé", e);
            }
            return;
        }
        client.sendPayload(endpointId, Payload.fromBytes(data.getBytes(StandardCharsets.UTF_8)));
    }

    // ---------- Messages reçus ----------
    private void handleText(String endpointId, String text) {
        JSONObject o = null;
        try {
            o = new JSONObject(text);
        } catch (JSONException ignored) {
        }
        if (o != null) {
            String t = o.optString("t");
            if ("hints".equals(t)) {
                showHints(o);
            } else if ("call".equals(t)) {
                nativeCall(endpointId, o);
            }
        }
        emit("message", obj("endpointId", endpointId, "data", text));
    }

    private boolean appVisible() {
        return foreground && G37Notify.appForeground && listener != null;
    }

    /** Appel de proximité alors que l'app n'est pas à l'écran : sonnerie et écran d'appel par le téléphone. */
    private void nativeCall(String endpointId, JSONObject o) {
        String type = o.optString("type");
        String callId = o.optString("callId");
        if ("offer".equals(type) || "invite".equals(type)) {
            if (appVisible()) return;
            if (myUserId() > 0 && o.optInt("to", myUserId()) != myUserId()) return;
            JSONObject r = obj("endpointId", endpointId, "callId", callId, "from", o.optInt("from", 0), "name", o.optString("name", "Collègue"),
                    "video", o.optBoolean("video", false), "mode", "invite".equals(type) ? o.optString("mode", "rtc") : "nearby",
                    "at", System.currentTimeMillis());
            ringing = r;
            Map<String, String> data = new HashMap<>();
            data.put("room", callId);
            data.put("name", r.optString("name"));
            data.put("from", String.valueOf(r.optInt("from")));
            data.put("group", "0");
            data.put("via", LanEngine.isLan(endpointId) ? "wifi" : "proche");
            data.put("endpoint", endpointId);
            data.put("mode", r.optString("mode"));
            data.put("video", r.optBoolean("video") ? "1" : "0");
            main.post(() -> G37Notify.showIncomingCall(ctx, data));
        } else if ("hangup".equals(type) || "cancel".equals(type)) {
            JSONObject r = ringing;
            if (r != null && callId.equals(r.optString("callId"))) {
                ringing = null;
                main.post(() -> {
                    G37Notify.cancelCall(ctx);
                    if (!appVisible()) G37Notify.showMissedCall(ctx, r.optString("name", "Collègue"), r.optBoolean("video"));
                });
            }
        }
    }

    /** L'app reprend l'appel qui sonnait pendant qu'elle était fermée. */
    JSONObject takeRinging() {
        JSONObject r = ringing;
        ringing = null;
        if (r != null && System.currentTimeMillis() - r.optLong("at", 0) > 60000) return null;
        return r;
    }

    void clearRinging(String callId) {
        JSONObject r = ringing;
        if (r != null && (callId == null || callId.equals(r.optString("callId")))) ringing = null;
    }

    private void showHints(JSONObject o) {
        if (appVisible()) return; // l'app ouverte s'en occupe (paquet de données)
        JSONArray items = o.optJSONArray("items");
        if (items == null) return;
        int me = myUserId();
        SharedPreferences p = prefs();
        Set<String> shown = new HashSet<>(p.getStringSet("hintsShown", new HashSet<>()));
        long now = System.currentTimeMillis();
        int count = 0;
        for (int i = 0; i < items.length() && count < 8; i++) {
            JSONObject h = items.optJSONObject(i);
            if (h == null) continue;
            String id = h.optString("id");
            if (id.isEmpty() || shown.contains(id)) continue;
            if (me > 0 && h.optInt("from", -2) == me) continue;
            int to = h.optInt("to", -1);
            if (to >= 0 && to != me) continue;
            if (now - h.optLong("at", now) > 3L * 24 * 3600 * 1000) continue;
            shown.add(id);
            count++;
            final Map<String, String> data = new HashMap<>();
            String kind = h.optString("kind", "alert");
            data.put("kind", kind);
            data.put("title", h.optString("title", "Spinning R/F"));
            data.put("body", h.optString("body", "") + " · reçu sans Internet");
            data.put("tag", "near-" + id);
            data.put("tab", h.optString("tab", "dm".equals(kind) || "chat".equals(kind) ? "discussion" : "pannes"));
            if (h.has("peer")) data.put("peer", String.valueOf(h.optInt("peer")));
            main.post(() -> G37Notify.showAlert(ctx, data));
        }
        if (count == 0) return;
        if (shown.size() > 400) {
            Set<String> trimmed = new HashSet<>();
            int keep = 0;
            for (String s : shown) if (keep++ < 300) trimmed.add(s);
            shown = trimmed;
        }
        p.edit().putStringSet("hintsShown", shown).apply();
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

    // ---------- Réseau Wi-Fi créé par le téléphone (v5) ----------
    HotspotManager hotspot() {
        return hotspot;
    }

    @Override
    public void onHotspotChanged(JSONObject state) {
        emit("hotspot", state);
        if (state.optBoolean("hosting")) {
            for (String id : connected.keySet()) sendHotspotInvite(id);
        }
        // Nouveau réseau (créé ou rejoint) : on s'annonce tout de suite sur ce Wi-Fi.
        lan.announceNow();
    }

    /** Invitation envoyée par Bluetooth : nom et mot de passe du réseau que ce téléphone a créé. */
    void sendHotspotInvite(String endpointId) {
        JSONObject inv = hotspot.invite();
        if (inv == null || LanEngine.isLan(endpointId)) return;
        try {
            inv.put("t", "hotspot");
            inv.put("from", myUserId());
            sendMessage(endpointId, inv.toString());
        } catch (Exception e) {
            Log.w(TAG, "Invitation non envoyée", e);
        }
    }

    // ---------- Appels de proximité (Bluetooth / Wi-Fi direct) ----------
    synchronized void startAudio(String endpointId) throws Exception {
        if (LanEngine.isLan(endpointId)) throw new IllegalStateException("Appel Wi-Fi : passe par l'app (WebRTC)");
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
