package com.atelierg37.nearby;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.wifi.SoftApConfiguration;
import android.net.wifi.WifiConfiguration;
import android.net.wifi.WifiManager;
import android.net.wifi.WifiNetworkSpecifier;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONObject;

/**
 * Réseau Wi-Fi créé par le téléphone lui-même (« point d'accès local » d'Android, sans Internet) :
 *  - un téléphone « base » crée le réseau d'un geste (nom et mot de passe choisis par Android) ;
 *  - les collègues reliés en Bluetooth reçoivent une invitation et le rejoignent en un geste
 *    (Android demande une seule confirmation) ;
 *  - ensuite tout passe par ce Wi-Fi : synchronisation rapide, appels voix et vidéo (LanEngine).
 * Le partage de connexion classique d'Android ne peut pas être allumé par une app : ce réseau-ci le remplace.
 */
final class HotspotManager {
    interface Listener {
        void onHotspotChanged(JSONObject state);
    }

    interface Result {
        void ok(JSONObject data);

        void fail(String code, String message);
    }

    private static final String TAG = "G37Hotspot";
    // Types de sécurité de SoftApConfiguration (Android 11+).
    static final int SEC_OPEN = 0, SEC_WPA2 = 1, SEC_WPA3_TRANSITION = 2, SEC_WPA3 = 3;

    private final Context ctx;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());

    private WifiManager.LocalOnlyHotspotReservation reservation;
    private String hostSsid, hostPass;
    private int hostSec = SEC_WPA2;

    private ConnectivityManager.NetworkCallback joinCallback;
    private volatile Network joined;
    private String joinSsid;
    private int legacyNetId = -1;

    HotspotManager(Context context, Listener l) {
        ctx = context.getApplicationContext();
        listener = l;
    }

    static boolean supported() {
        return Build.VERSION.SDK_INT >= 26;
    }

    synchronized JSONObject state() {
        return NearbyEngine.obj("supported", supported(), "hosting", reservation != null, "ssid", reservation != null ? hostSsid : null,
                "password", reservation != null ? hostPass : null, "security", hostSec,
                "joined", joined != null || legacyNetId >= 0, "joinedSsid", joined != null || legacyNetId >= 0 ? joinSsid : null);
    }

    /** Invitation à transmettre aux collègues (null si ce téléphone n'a pas créé de réseau). */
    synchronized JSONObject invite() {
        if (reservation == null || hostSsid == null) return null;
        return NearbyEngine.obj("ssid", hostSsid, "password", hostPass, "security", hostSec);
    }

    private void changed() {
        final JSONObject s = state();
        main.post(() -> listener.onHotspotChanged(s));
    }

    private static String unquote(String s) {
        if (s == null) return null;
        if (s.length() >= 2 && s.startsWith("\"") && s.endsWith("\"")) return s.substring(1, s.length() - 1);
        return s;
    }

    // ---------- Créer le réseau ----------
    void startHost(final Result r) {
        if (!supported()) {
            r.fail("unsupported", "Android 8 ou plus récent nécessaire");
            return;
        }
        synchronized (this) {
            if (reservation != null) {
                r.ok(state());
                return;
            }
        }
        if (joined != null || legacyNetId >= 0) leave();
        WifiManager wm = (WifiManager) ctx.getSystemService(Context.WIFI_SERVICE);
        if (wm == null) {
            r.fail("unsupported", "Wi-Fi indisponible");
            return;
        }
        try {
            wm.startLocalOnlyHotspot(new WifiManager.LocalOnlyHotspotCallback() {
                @Override
                @SuppressWarnings("deprecation")
                public void onStarted(WifiManager.LocalOnlyHotspotReservation res) {
                    String ssid = null, pass = null;
                    int sec = SEC_WPA2;
                    try {
                        if (Build.VERSION.SDK_INT >= 30) {
                            SoftApConfiguration c = res.getSoftApConfiguration();
                            ssid = c.getSsid();
                            pass = c.getPassphrase();
                            sec = c.getSecurityType();
                        } else {
                            WifiConfiguration c = res.getWifiConfiguration();
                            if (c != null) {
                                ssid = c.SSID;
                                pass = c.preSharedKey;
                            }
                        }
                    } catch (Exception e) {
                        Log.w(TAG, "Réglages du réseau illisibles", e);
                    }
                    ssid = unquote(ssid);
                    pass = unquote(pass);
                    if (ssid == null || ssid.isEmpty()) {
                        res.close();
                        r.fail("generic", "Nom du réseau inconnu");
                        return;
                    }
                    synchronized (HotspotManager.this) {
                        reservation = res;
                        hostSsid = ssid;
                        hostPass = pass;
                        hostSec = sec;
                    }
                    r.ok(state());
                    changed();
                }

                @Override
                public void onStopped() {
                    synchronized (HotspotManager.this) {
                        reservation = null;
                        hostSsid = null;
                        hostPass = null;
                    }
                    changed();
                }

                @Override
                public void onFailed(int reason) {
                    String code;
                    switch (reason) {
                        case WifiManager.LocalOnlyHotspotCallback.ERROR_NO_CHANNEL: code = "no_channel"; break;
                        case WifiManager.LocalOnlyHotspotCallback.ERROR_INCOMPATIBLE_MODE: code = "incompatible"; break;
                        case WifiManager.LocalOnlyHotspotCallback.ERROR_TETHERING_DISALLOWED: code = "disallowed"; break;
                        default: code = "generic";
                    }
                    r.fail(code, "Échec " + reason);
                }
            }, main);
        } catch (SecurityException e) {
            // Autorisation « Appareils à proximité » / position manquante, ou Localisation éteinte (Android 8 à 12).
            r.fail("permission", String.valueOf(e.getMessage()));
        } catch (IllegalStateException e) {
            r.fail("busy", String.valueOf(e.getMessage()));
        } catch (Exception e) {
            r.fail("generic", String.valueOf(e.getMessage()));
        }
    }

    void stopHost() {
        WifiManager.LocalOnlyHotspotReservation res;
        synchronized (this) {
            res = reservation;
            reservation = null;
            hostSsid = null;
            hostPass = null;
        }
        if (res != null) {
            try {
                res.close();
            } catch (Exception ignored) {
            }
            changed();
        }
    }

    // ---------- Rejoindre le réseau d'un collègue ----------
    @SuppressWarnings("deprecation")
    void join(final String ssid, final String password, final int security, final Result r) {
        if (ssid == null || ssid.isEmpty()) {
            r.fail("invalid", "Nom du réseau manquant");
            return;
        }
        synchronized (this) {
            if (reservation != null) {
                r.fail("hosting", "Ce téléphone a déjà créé un réseau");
                return;
            }
        }
        leave();
        final ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
        final WifiManager wm = (WifiManager) ctx.getSystemService(Context.WIFI_SERVICE);
        if (cm == null || wm == null) {
            r.fail("unsupported", "Wi-Fi indisponible");
            return;
        }
        try {
            if (!wm.isWifiEnabled() && Build.VERSION.SDK_INT < 29) wm.setWifiEnabled(true);
        } catch (Exception ignored) {
        }
        joinSsid = ssid;
        if (Build.VERSION.SDK_INT >= 29) {
            try {
                WifiNetworkSpecifier.Builder b = new WifiNetworkSpecifier.Builder().setSsid(ssid);
                if (password != null && !password.isEmpty()) {
                    if (security == SEC_WPA3) b.setWpa3Passphrase(password);
                    else b.setWpa2Passphrase(password);
                }
                NetworkRequest req = new NetworkRequest.Builder()
                        .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                        .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                        .setNetworkSpecifier(b.build())
                        .build();
                final boolean[] answered = { false };
                ConnectivityManager.NetworkCallback cb = new ConnectivityManager.NetworkCallback() {
                    @Override
                    public void onAvailable(Network network) {
                        joined = network;
                        // Les annonces et liaisons de l'app passent par ce Wi-Fi (sans Internet) tant qu'il est rejoint.
                        try {
                            cm.bindProcessToNetwork(network);
                        } catch (Exception e) {
                            Log.w(TAG, "Liaison au réseau impossible", e);
                        }
                        if (!answered[0]) {
                            answered[0] = true;
                            r.ok(state());
                        }
                        changed();
                    }

                    @Override
                    public void onLost(Network network) {
                        if (network.equals(joined)) {
                            joined = null;
                            try {
                                cm.bindProcessToNetwork(null);
                            } catch (Exception ignored) {
                            }
                            changed();
                        }
                    }

                    @Override
                    public void onUnavailable() {
                        joinCallback = null;
                        if (!answered[0]) {
                            answered[0] = true;
                            r.fail("refused", "Réseau introuvable ou connexion refusée");
                        }
                        changed();
                    }
                };
                joinCallback = cb;
                cm.requestNetwork(req, cb, main, 60000);
            } catch (SecurityException e) {
                joinCallback = null;
                r.fail("permission", String.valueOf(e.getMessage()));
            } catch (Exception e) {
                joinCallback = null;
                r.fail("generic", String.valueOf(e.getMessage()));
            }
        } else {
            // Android 8 et 9 : le téléphone entier rejoint le réseau (comme dans les réglages Wi-Fi).
            try {
                WifiConfiguration conf = new WifiConfiguration();
                conf.SSID = "\"" + ssid + "\"";
                if (password != null && !password.isEmpty()) conf.preSharedKey = "\"" + password + "\"";
                else conf.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE);
                int id = wm.addNetwork(conf);
                if (id < 0) {
                    r.fail("generic", "Réseau refusé par le téléphone");
                    return;
                }
                legacyNetId = id;
                wm.disconnect();
                wm.enableNetwork(id, true);
                wm.reconnect();
                r.ok(state());
                changed();
            } catch (SecurityException e) {
                r.fail("permission", String.valueOf(e.getMessage()));
            } catch (Exception e) {
                r.fail("generic", String.valueOf(e.getMessage()));
            }
        }
    }

    @SuppressWarnings("deprecation")
    void leave() {
        ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
        boolean was = joined != null || joinCallback != null || legacyNetId >= 0;
        if (cm != null) {
            try {
                if (joined != null) cm.bindProcessToNetwork(null);
            } catch (Exception ignored) {
            }
            try {
                if (joinCallback != null) cm.unregisterNetworkCallback(joinCallback);
            } catch (Exception ignored) {
            }
        }
        joined = null;
        joinCallback = null;
        if (legacyNetId >= 0) {
            try {
                WifiManager wm = (WifiManager) ctx.getSystemService(Context.WIFI_SERVICE);
                if (wm != null) wm.removeNetwork(legacyNetId);
            } catch (Exception ignored) {
            }
            legacyNetId = -1;
        }
        if (was) changed();
    }
}
