package com.atelierg37.nearby;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Échanges sur un réseau Wi-Fi local, même sans Internet : box/routeur de l'atelier sans abonnement,
 * ou point d'accès (partage de connexion) d'un des téléphones.
 * Les téléphones s'annoncent en UDP (diffusion) et se connectent tout seuls en TCP.
 * Débit élevé : synchronisation rapide, mises à jour, et appels voix/vidéo (WebRTC) côté app.
 * Comme pour Bluetooth, le contenu sensible est chiffré et signé par l'app avant d'arriver ici.
 */
final class LanEngine {
    interface Callback {
        void onLanPeerFound(String id, String name);
        void onLanPeerLost(String id);
        void onLanConnected(String id, String name);
        void onLanDisconnected(String id);
        void onLanMessage(String id, String text);
        void onLanFile(String id, JSONObject meta, File file);
    }

    static final String PREFIX = "lan:";
    static final int UDP_PORT = 37037;
    static final int TCP_PORT = 37038;
    private static final String TAG = "G37Lan";
    private static final int T_HELLO = 0, T_TEXT = 1, T_FILE = 2, T_PING = 3;
    private static final int MAX_TEXT = 8 * 1024 * 1024;
    private static final long MAX_FILE = 300L * 1024 * 1024;

    private final Context ctx;
    private final Callback cb;
    private final File tmpDir;

    private volatile boolean running = false;
    private volatile String name;
    private volatile long beaconEveryMs = 2000;
    private DatagramSocket udp;
    private ServerSocket server;
    private int tcpPort = TCP_PORT;
    private ScheduledExecutorService timer;
    private final ExecutorService dialer = Executors.newCachedThreadPool();
    private WifiManager.MulticastLock multicastLock;
    private long lastBeacon = 0;

    /** Collègues entendus (nom → dernière annonce) et adresse où les joindre. */
    private final Map<String, Long> seen = new ConcurrentHashMap<>();
    private final Map<String, InetSocketAddress> where = new ConcurrentHashMap<>();
    private final Map<String, Conn> conns = new ConcurrentHashMap<>();
    private final Set<String> dialing = ConcurrentHashMap.newKeySet();

    LanEngine(Context context, Callback callback, File tmp) {
        ctx = context.getApplicationContext();
        cb = callback;
        tmpDir = tmp;
    }

    static boolean isLan(String endpointId) {
        return endpointId != null && endpointId.startsWith(PREFIX);
    }

    private static String idOf(String peerName) {
        return PREFIX + peerName;
    }

    private static String nameOf(String id) {
        return id.substring(PREFIX.length());
    }

    boolean isRunning() {
        return running;
    }

    /** Annonce toutes les 2 s app ouverte, toutes les 15 s en arrière-plan (économie de batterie). */
    void setBeaconInterval(long ms) {
        beaconEveryMs = Math.max(1000, ms);
    }

    Map<String, String> connectedPeers() {
        Map<String, String> out = new HashMap<>();
        for (Conn c : conns.values()) if (c.ready) out.put(idOf(c.peer), c.peer);
        return out;
    }

    Map<String, String> foundPeers() {
        Map<String, String> out = new HashMap<>();
        for (String n : seen.keySet()) out.put(idOf(n), n);
        return out;
    }

    boolean isConnected(String id) {
        Conn c = conns.get(nameOf(id));
        return c != null && c.ready;
    }

    // ---------- Démarrage / arrêt ----------
    synchronized void start(String myName) {
        if (myName == null || myName.isEmpty()) return;
        name = myName;
        if (running) return;
        running = true;
        try {
            WifiManager wm = (WifiManager) ctx.getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                multicastLock = wm.createMulticastLock("g37:lan");
                multicastLock.setReferenceCounted(false);
                multicastLock.acquire();
            }
        } catch (Exception e) {
            Log.w(TAG, "Verrou de diffusion indisponible", e);
        }
        openServer();
        openUdp();
        timer = Executors.newSingleThreadScheduledExecutor();
        timer.scheduleWithFixedDelay(this::tick, 300, 1000, TimeUnit.MILLISECONDS);
    }

    synchronized void stop() {
        running = false;
        try { if (timer != null) timer.shutdownNow(); } catch (Exception ignored) { }
        timer = null;
        try { if (udp != null) udp.close(); } catch (Exception ignored) { }
        udp = null;
        try { if (server != null) server.close(); } catch (Exception ignored) { }
        server = null;
        for (Conn c : new ArrayList<>(conns.values())) c.close();
        conns.clear();
        seen.clear();
        where.clear();
        dialing.clear();
        try { if (multicastLock != null && multicastLock.isHeld()) multicastLock.release(); } catch (Exception ignored) { }
        multicastLock = null;
    }

    private void openServer() {
        ServerSocket ss = null;
        try {
            ss = new ServerSocket();
            ss.setReuseAddress(true);
            ss.bind(new InetSocketAddress(TCP_PORT));
        } catch (Exception e) {
            try { if (ss != null) ss.close(); } catch (Exception ignored) { }
            try {
                ss = new ServerSocket(0);
            } catch (Exception e2) {
                Log.w(TAG, "Serveur local impossible", e2);
                return;
            }
        }
        server = ss;
        tcpPort = ss.getLocalPort();
        final ServerSocket accepting = ss;
        Thread t = new Thread(() -> {
            while (running && !accepting.isClosed()) {
                try {
                    Socket s = accepting.accept();
                    dialer.execute(() -> handshake(s, false));
                } catch (Exception e) {
                    if (running && !accepting.isClosed()) Log.w(TAG, "Connexion entrante", e);
                }
            }
        }, "g37-lan-accept");
        t.setDaemon(true);
        t.start();
    }

    private void openUdp() {
        try {
            DatagramSocket s = new DatagramSocket(null);
            s.setReuseAddress(true);
            s.setBroadcast(true);
            s.bind(new InetSocketAddress(UDP_PORT));
            udp = s;
        } catch (Exception e) {
            Log.w(TAG, "Annonces Wi-Fi impossibles", e);
            return;
        }
        final DatagramSocket listening = udp;
        Thread t = new Thread(() -> {
            byte[] buf = new byte[2048];
            while (running && !listening.isClosed()) {
                try {
                    DatagramPacket p = new DatagramPacket(buf, buf.length);
                    listening.receive(p);
                    onBeacon(p);
                } catch (Exception e) {
                    if (running && !listening.isClosed()) Log.w(TAG, "Annonce reçue illisible", e);
                }
            }
        }, "g37-lan-udp");
        t.setDaemon(true);
        t.start();
    }

    // ---------- Annonces ----------
    private void tick() {
        try {
            long now = System.currentTimeMillis();
            if (now - lastBeacon >= beaconEveryMs) {
                lastBeacon = now;
                beacon();
            }
            // Collègue silencieux depuis 45 s et sans liaison : oublié.
            for (Map.Entry<String, Long> e : seen.entrySet()) {
                if (now - e.getValue() > 45000 && !conns.containsKey(e.getKey())) {
                    seen.remove(e.getKey());
                    where.remove(e.getKey());
                    cb.onLanPeerLost(idOf(e.getKey()));
                }
            }
            // Liaisons : maintien et détection des coupures.
            for (Conn c : new ArrayList<>(conns.values())) {
                if (now - c.lastRx > 25000) c.close();
                else if (c.ready && now - c.lastTx > 5000) c.ping();
            }
        } catch (Exception e) {
            Log.w(TAG, "Tic", e);
        }
    }

    private void beacon() {
        DatagramSocket s = udp;
        String n = name;
        if (s == null || n == null) return;
        byte[] data;
        try {
            data = new JSONObject().put("s", NearbyEngine.SERVICE_ID).put("n", n).put("p", tcpPort).put("v", 1)
                    .toString().getBytes(StandardCharsets.UTF_8);
        } catch (Exception e) {
            return;
        }
        for (InetAddress target : broadcastTargets()) {
            try {
                s.send(new DatagramPacket(data, data.length, target, UDP_PORT));
            } catch (Exception ignored) {
                // interface sans diffusion : on passe à la suivante
            }
        }
    }

    /** Adresse de diffusion de chaque réseau local (Wi-Fi, point d'accès, Wi-Fi direct) + diffusion générale. */
    private static List<InetAddress> broadcastTargets() {
        List<InetAddress> out = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                String n = ni.getName() == null ? "" : ni.getName();
                if (n.startsWith("rmnet") || n.startsWith("ccmni") || n.startsWith("pdp") || n.startsWith("dummy") || n.startsWith("tun")) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    InetAddress b = ia.getBroadcast();
                    if (b != null && ia.getAddress() instanceof Inet4Address && !out.contains(b)) out.add(b);
                }
            }
        } catch (Exception ignored) {
        }
        try {
            out.add(InetAddress.getByName("255.255.255.255"));
        } catch (Exception ignored) {
        }
        return out;
    }

    /** Adresses IPv4 locales (affichées dans le guide de connexion). */
    static List<String> localAddresses() {
        List<String> out = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    if (ia.getAddress() instanceof Inet4Address && ia.getBroadcast() != null) {
                        out.add(ni.getName() + " " + ia.getAddress().getHostAddress());
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    private void onBeacon(DatagramPacket p) {
        String my = name;
        if (my == null) return;
        JSONObject o;
        try {
            o = new JSONObject(new String(p.getData(), p.getOffset(), p.getLength(), StandardCharsets.UTF_8));
        } catch (Exception e) {
            return;
        }
        if (!NearbyEngine.SERVICE_ID.equals(o.optString("s"))) return;
        final String peer = o.optString("n", "");
        int port = o.optInt("p", TCP_PORT);
        if (peer.isEmpty() || peer.equals(my) || port <= 0 || port > 65535) return;
        boolean isNew = !seen.containsKey(peer);
        seen.put(peer, System.currentTimeMillis());
        where.put(peer, new InetSocketAddress(p.getAddress(), port));
        if (isNew) cb.onLanPeerFound(idOf(peer), peer);
        if (conns.containsKey(peer) || dialing.contains(peer)) return;
        // Un seul des deux appelle (le plus petit nom) ; l'autre prend le relais s'il ne se passe rien.
        if (my.compareTo(peer) < 0) {
            dial(peer);
        } else {
            Long first = firstHeard.get(peer);
            long now = System.currentTimeMillis();
            if (first == null) firstHeard.put(peer, now);
            else if (now - first > 6000) dial(peer);
        }
    }

    private final Map<String, Long> firstHeard = new ConcurrentHashMap<>();

    /** Annonce immédiate (ex. retour au premier plan, ou juste avant un appel). */
    void announceNow() {
        lastBeacon = 0;
    }

    private void dial(final String peer) {
        final InetSocketAddress addr = where.get(peer);
        if (addr == null || !dialing.add(peer)) return;
        dialer.execute(() -> {
            Socket s = null;
            try {
                s = socketFor(addr.getAddress());
                s.connect(addr, 5000);
                handshake(s, true);
            } catch (Exception e) {
                Log.i(TAG, "Liaison Wi-Fi impossible avec " + peer + " : " + e.getMessage());
                try { if (s != null) s.close(); } catch (Exception ignored) { }
            } finally {
                dialing.remove(peer);
            }
        });
    }

    /**
     * Sur un Wi-Fi sans Internet, Android peut faire passer le trafic par les données mobiles :
     * on attache explicitement la liaison au réseau Wi-Fi qui contient l'adresse du collègue.
     */
    private Socket socketFor(InetAddress target) throws IOException {
        try {
            ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null && target instanceof Inet4Address) {
                for (Network n : cm.getAllNetworks()) {
                    NetworkCapabilities caps = cm.getNetworkCapabilities(n);
                    if (caps == null || !caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) continue;
                    LinkProperties lp = cm.getLinkProperties(n);
                    if (lp == null) continue;
                    for (LinkAddress la : lp.getLinkAddresses()) {
                        if (sameSubnet(la.getAddress(), target, la.getPrefixLength())) return n.getSocketFactory().createSocket();
                    }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Réseau Wi-Fi introuvable, liaison standard", e);
        }
        return new Socket();
    }

    private static boolean sameSubnet(InetAddress a, InetAddress b, int prefix) {
        byte[] x = a.getAddress();
        byte[] y = b.getAddress();
        if (x.length != y.length || prefix <= 0) return false;
        int full = prefix / 8;
        int rest = prefix % 8;
        for (int i = 0; i < full && i < x.length; i++) if (x[i] != y[i]) return false;
        if (rest == 0 || full >= x.length) return true;
        int mask = (0xFF << (8 - rest)) & 0xFF;
        return (x[full] & mask) == (y[full] & mask);
    }

    // ---------- Liaisons ----------
    private void handshake(Socket s, boolean outgoing) {
        Conn c = null;
        try {
            s.setTcpNoDelay(true);
            s.setKeepAlive(true);
            s.setSoTimeout(10000);
            c = new Conn(s, outgoing);
            c.sendNow(T_HELLO, new JSONObject().put("s", NearbyEngine.SERVICE_ID).put("n", name).put("v", 1).toString().getBytes(StandardCharsets.UTF_8));
            int type = c.in.readUnsignedByte();
            int len = c.in.readInt();
            if (type != T_HELLO || len <= 0 || len > 4096) throw new IOException("Présentation invalide");
            byte[] b = new byte[len];
            c.in.readFully(b);
            JSONObject hello = new JSONObject(new String(b, StandardCharsets.UTF_8));
            if (!NearbyEngine.SERVICE_ID.equals(hello.optString("s"))) throw new IOException("Autre application");
            String peer = hello.optString("n", "");
            if (peer.isEmpty() || peer.equals(name)) throw new IOException("Nom invalide");
            c.peer = peer;
            s.setSoTimeout(30000);
            synchronized (conns) {
                Conn prev = conns.get(peer);
                if (prev != null && prev.alive()) {
                    // Deux liaisons croisées : on garde celle ouverte par le plus petit nom (même choix des deux côtés).
                    boolean keepNew = (name.compareTo(peer) < 0) == outgoing;
                    if (!keepNew) { c.close(); return; }
                    prev.replaced = true;
                    prev.close();
                }
                conns.put(peer, c);
            }
            if (!seen.containsKey(peer)) {
                seen.put(peer, System.currentTimeMillis());
                cb.onLanPeerFound(idOf(peer), peer);
            }
            seen.put(peer, System.currentTimeMillis());
            c.ready = true;
            cb.onLanConnected(idOf(peer), peer);
            c.readLoop();
        } catch (Exception e) {
            if (c != null) c.close();
            else try { s.close(); } catch (Exception ignored) { }
        }
    }

    void send(String id, String text) throws IOException {
        Conn c = conns.get(nameOf(id));
        if (c == null || !c.ready) throw new IOException("Collègue non relié en Wi-Fi");
        c.sendText(text);
    }

    void sendFile(String id, File file, JSONObject meta) throws IOException {
        Conn c = conns.get(nameOf(id));
        if (c == null || !c.ready) throw new IOException("Collègue non relié en Wi-Fi");
        c.sendFile(file, meta);
    }

    void disconnect(String id) {
        Conn c = conns.get(nameOf(id));
        if (c != null) c.close();
    }

    private final class Conn {
        final Socket socket;
        final boolean outgoing;
        final DataInputStream in;
        final DataOutputStream out;
        final ExecutorService writer = Executors.newSingleThreadExecutor();
        volatile String peer = "";
        volatile boolean ready = false;
        volatile boolean closed = false;
        volatile boolean replaced = false;
        volatile long lastRx = System.currentTimeMillis();
        volatile long lastTx = System.currentTimeMillis();

        Conn(Socket s, boolean outgoing) throws IOException {
            socket = s;
            this.outgoing = outgoing;
            in = new DataInputStream(new BufferedInputStream(s.getInputStream(), 64 * 1024));
            out = new DataOutputStream(new BufferedOutputStream(s.getOutputStream(), 64 * 1024));
        }

        boolean alive() {
            return !closed && !socket.isClosed();
        }

        synchronized void sendNow(int type, byte[] payload) throws IOException {
            out.writeByte(type);
            out.writeInt(payload.length);
            out.write(payload);
            out.flush();
            lastTx = System.currentTimeMillis();
        }

        void ping() {
            writer.execute(() -> {
                try {
                    synchronized (this) {
                        out.writeByte(T_PING);
                        out.writeInt(0);
                        out.flush();
                        lastTx = System.currentTimeMillis();
                    }
                } catch (Exception e) {
                    close();
                }
            });
        }

        void sendText(String text) {
            final byte[] b = text.getBytes(StandardCharsets.UTF_8);
            writer.execute(() -> {
                try {
                    sendNow(T_TEXT, b);
                } catch (Exception e) {
                    close();
                }
            });
        }

        void sendFile(final File file, final JSONObject meta) {
            writer.execute(() -> {
                try (InputStream src = new FileInputStream(file)) {
                    byte[] m = meta.toString().getBytes(StandardCharsets.UTF_8);
                    long size = file.length();
                    synchronized (this) {
                        out.writeByte(T_FILE);
                        out.writeInt(m.length);
                        out.write(m);
                        out.writeLong(size);
                        byte[] buf = new byte[64 * 1024];
                        long left = size;
                        while (left > 0) {
                            int n = src.read(buf, 0, (int) Math.min(buf.length, left));
                            if (n < 0) throw new IOException("Fichier raccourci");
                            out.write(buf, 0, n);
                            left -= n;
                            lastTx = System.currentTimeMillis();
                        }
                        out.flush();
                    }
                } catch (Exception e) {
                    Log.w(TAG, "Fichier non envoyé", e);
                    close();
                }
            });
        }

        void readLoop() throws IOException {
            while (!closed) {
                int type;
                try {
                    type = in.readUnsignedByte();
                } catch (SocketTimeoutException e) {
                    if (System.currentTimeMillis() - lastRx > 30000) throw e;
                    continue;
                }
                lastRx = System.currentTimeMillis();
                seen.put(peer, lastRx);
                int len = in.readInt();
                if (type == T_PING) {
                    continue;
                } else if (type == T_TEXT) {
                    if (len < 0 || len > MAX_TEXT) throw new IOException("Message trop long");
                    byte[] b = new byte[len];
                    in.readFully(b);
                    cb.onLanMessage(idOf(peer), new String(b, StandardCharsets.UTF_8));
                } else if (type == T_FILE) {
                    if (len < 0 || len > 64 * 1024) throw new IOException("Description de fichier invalide");
                    byte[] m = new byte[len];
                    in.readFully(m);
                    JSONObject meta;
                    try { meta = new JSONObject(new String(m, StandardCharsets.UTF_8)); } catch (Exception e) { meta = new JSONObject(); }
                    long size = in.readLong();
                    if (size < 0 || size > MAX_FILE) throw new IOException("Fichier trop lourd");
                    if (!tmpDir.exists()) tmpDir.mkdirs();
                    File dest = new File(tmpDir, "lan-" + System.nanoTime() + ".part");
                    try (OutputStream o = new FileOutputStream(dest)) {
                        byte[] buf = new byte[64 * 1024];
                        long left = size;
                        while (left > 0) {
                            int n = in.read(buf, 0, (int) Math.min(buf.length, left));
                            if (n < 0) throw new IOException("Fichier interrompu");
                            o.write(buf, 0, n);
                            left -= n;
                            lastRx = System.currentTimeMillis();
                        }
                    } catch (IOException e) {
                        dest.delete();
                        throw e;
                    }
                    cb.onLanFile(idOf(peer), meta, dest);
                } else {
                    // type inconnu (version plus récente) : on saute le contenu
                    if (len < 0 || len > MAX_TEXT) throw new IOException("Trame invalide");
                    in.skipBytes(len);
                }
            }
        }

        void close() {
            if (closed) return;
            closed = true;
            try { socket.close(); } catch (Exception ignored) { }
            writer.shutdownNow();
            String p = peer;
            if (!p.isEmpty() && conns.get(p) == this) conns.remove(p);
            if (ready && !replaced && !p.isEmpty() && !conns.containsKey(p)) cb.onLanDisconnected(idOf(p));
        }
    }
}
