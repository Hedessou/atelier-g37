package com.atelierg37.nearby;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.location.LocationManager;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.app.NotificationManagerCompat;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/** Pont entre l'app (JavaScript) et les échanges sans Internet du téléphone. */
@CapacitorPlugin(
        name = "G37Nearby",
        permissions = {
                @Permission(alias = "bluetooth", strings = {
                        Manifest.permission.BLUETOOTH_SCAN,
                        Manifest.permission.BLUETOOTH_ADVERTISE,
                        Manifest.permission.BLUETOOTH_CONNECT
                }),
                @Permission(alias = "wifi", strings = { Manifest.permission.NEARBY_WIFI_DEVICES }),
                @Permission(alias = "location", strings = {
                        Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION
                }),
                @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
                @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
        }
)
public class G37NearbyPlugin extends Plugin implements NearbyEngine.Listener {
    private NearbyEngine engine;
    private boolean wanted = false;

    private MediaPlayer player;
    private JSObject pendingLaunch;

    @Override
    public void load() {
        engine = NearbyEngine.get(getContext());
        engine.setListener(this);
        engine.setForeground(true);
        G37Notify.appForeground = true;
        try {
            G37Notify.ensureChannels(getContext());
        } catch (Exception ignored) {
        }
        Activity a = getActivity();
        if (a != null) readLaunch(a.getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        readLaunch(intent);
    }

    /** Ouverture depuis une notification : onglet à afficher ou appel entrant (sonnerie / réponse). */
    private void readLaunch(Intent intent) {
        if (intent == null) return;
        JSObject data = new JSObject();
        String tab = intent.getStringExtra("g37_tab");
        String room = intent.getStringExtra("g37_call_room");
        if (tab != null && !tab.isEmpty()) {
            data.put("tab", tab);
            String peer = intent.getStringExtra("g37_peer");
            if (peer != null) data.put("peer", peer);
        }
        if (room != null && !room.isEmpty()) {
            JSObject call = new JSObject();
            call.put("room", room);
            call.put("name", intent.getStringExtra("g37_call_name"));
            call.put("from", intent.getStringExtra("g37_call_from"));
            call.put("action", intent.getStringExtra("g37_call_action"));
            call.put("group", intent.getBooleanExtra("g37_call_group", false));
            try {
                data.put("call", call);
            } catch (Exception ignored) {
            }
            G37Notify.cancelCall(getContext());
            Activity a = getActivity();
            if (a != null && Build.VERSION.SDK_INT >= 27) {
                a.setShowWhenLocked(true);
                a.setTurnScreenOn(true);
            }
        }
        intent.removeExtra("g37_tab");
        intent.removeExtra("g37_call_room");
        if (data.length() == 0) return;
        pendingLaunch = data;
        notifyListeners("launch", data, true);
    }

    @Override
    protected void handleOnResume() {
        G37Notify.appForeground = true;
        if (engine == null) return;
        engine.setListener(this);
        engine.setForeground(true);
        if (wanted) engine.start(null);
    }

    @Override
    protected void handleOnPause() {
        // Le service d'arrière-plan prend le relais (recherche périodique) ; les notifications sonnent seules.
        G37Notify.appForeground = false;
        if (engine != null) engine.setForeground(false);
    }

    @Override
    protected void handleOnDestroy() {
        G37Notify.appForeground = false;
        stopPlayer();
        if (engine != null) {
            engine.setForeground(false);
            engine.setListener(null);
        }
    }

    // ---------- Ouverture depuis une notification ----------
    @PluginMethod
    public void consumeLaunch(PluginCall call) {
        JSObject r = new JSObject();
        try {
            if (pendingLaunch != null) r.put("launch", pendingLaunch);
        } catch (Exception ignored) {
        }
        pendingLaunch = null;
        SharedPreferences lp = getContext().getSharedPreferences(G37Notify.LAUNCH_PREFS, Context.MODE_PRIVATE);
        String declined = lp.getString("declined", null);
        if (declined != null && System.currentTimeMillis() - lp.getLong("declinedAt", 0) < 120000) r.put("declined", declined);
        lp.edit().remove("declined").remove("declinedAt").apply();
        call.resolve(r);
    }

    // ---------- Sonneries ----------
    @PluginMethod
    public void setSoundPrefs(PluginCall call) {
        SharedPreferences.Editor e = G37Notify.prefs(getContext()).edit();
        if (call.getString("alert") != null) e.putString("alert", call.getString("alert"));
        if (call.getString("message") != null) e.putString("message", call.getString("message"));
        if (call.getString("call") != null) e.putString("call", call.getString("call"));
        if (call.getBoolean("loud") != null) e.putBoolean("loud", call.getBoolean("loud"));
        e.apply();
        G37Notify.ensureChannels(getContext());
        call.resolve();
    }

    @PluginMethod
    public void playSound(PluginCall call) {
        String name = call.getString("name", "alert_atelier");
        boolean loop = call.getBoolean("loop", false);
        String usage = call.getString("usage", "notification");
        stopPlayer();
        int u = usage.equals("ringtone") ? AudioAttributes.USAGE_NOTIFICATION_RINGTONE
                : usage.equals("alarm") ? AudioAttributes.USAGE_ALARM : AudioAttributes.USAGE_NOTIFICATION_EVENT;
        AudioAttributes attrs = new AudioAttributes.Builder().setUsage(u).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        int session = am != null ? am.generateAudioSessionId() : 0;
        player = MediaPlayer.create(getContext(), G37Notify.rawId(getContext(), name), attrs, session);
        if (player == null) { call.reject("Son introuvable"); return; }
        player.setLooping(loop);
        final MediaPlayer started = player;
        player.setOnCompletionListener(mp -> { if (mp == player && !started.isLooping()) stopPlayer(); });
        player.start();
        call.resolve();
    }

    @PluginMethod
    public void stopSound(PluginCall call) {
        stopPlayer();
        call.resolve();
    }

    private void stopPlayer() {
        MediaPlayer p = player;
        player = null;
        if (p == null) return;
        try {
            p.stop();
        } catch (Exception ignored) {
        }
        p.release();
    }

    // ---------- Son des appels Internet (haut-parleur / écouteur) ----------
    @PluginMethod
    public void setAudioRoute(PluginCall call) {
        boolean speaker = call.getBoolean("speaker", false);
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (am == null) { call.resolve(); return; }
        am.setMode(AudioManager.MODE_IN_COMMUNICATION);
        if (Build.VERSION.SDK_INT >= 31) {
            if (speaker) {
                for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
                    if (d.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
                        am.setCommunicationDevice(d);
                        break;
                    }
                }
            } else {
                am.clearCommunicationDevice();
            }
        } else {
            am.setSpeakerphoneOn(speaker);
        }
        engine.setSpeaker(speaker);
        call.resolve();
    }

    @PluginMethod
    public void resetAudio(PluginCall call) {
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (am != null) {
            if (Build.VERSION.SDK_INT >= 31) am.clearCommunicationDevice();
            else am.setSpeakerphoneOn(false);
            am.setMode(AudioManager.MODE_NORMAL);
        }
        call.resolve();
    }

    // ---------- État du téléphone (autorisations importantes) ----------
    @PluginMethod
    public void getSystemStatus(PluginCall call) {
        Context c = getContext();
        JSObject r = new JSObject();
        r.put("sdk", Build.VERSION.SDK_INT);
        r.put("notifications", NotificationManagerCompat.from(c).areNotificationsEnabled());
        boolean fullScreen = true;
        if (Build.VERSION.SDK_INT >= 34) {
            NotificationManager nm = c.getSystemService(NotificationManager.class);
            fullScreen = nm == null || nm.canUseFullScreenIntent();
        }
        r.put("fullScreen", fullScreen);
        PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
        r.put("battery", pm == null || pm.isIgnoringBatteryOptimizations(c.getPackageName()));
        boolean bt = false;
        try {
            BluetoothManager bm = (BluetoothManager) c.getSystemService(Context.BLUETOOTH_SERVICE);
            BluetoothAdapter ad = bm != null ? bm.getAdapter() : null;
            bt = ad != null && ad.isEnabled();
        } catch (Exception ignored) {
        }
        r.put("bluetooth", bt);
        boolean loc = true;
        try {
            LocationManager lm = (LocationManager) c.getSystemService(Context.LOCATION_SERVICE);
            if (lm != null) {
                loc = Build.VERSION.SDK_INT >= 28 ? lm.isLocationEnabled()
                        : lm.isProviderEnabled(LocationManager.GPS_PROVIDER) || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
            }
        } catch (Exception ignored) {
        }
        r.put("location", loc);
        r.put("locationNeeded", Build.VERSION.SDK_INT <= 32);
        r.put("nearby", allGranted(neededAliases(false)));
        r.put("microphone", getPermissionState("microphone") == PermissionState.GRANTED);
        r.put("installApps", Build.VERSION.SDK_INT < 26 || c.getPackageManager().canRequestPackageInstalls());
        call.resolve(r);
    }

    private void openSettings(Intent i, PluginCall call) {
        try {
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            try {
                Intent app = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
                app.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(app);
                call.resolve();
            } catch (Exception e2) {
                call.reject("Réglage introuvable");
            }
        }
    }

    @PluginMethod
    public void openSystemSetting(PluginCall call) {
        String which = call.getString("which", "app");
        String pkg = getContext().getPackageName();
        Intent i;
        switch (which) {
            case "battery":
                i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + pkg));
                break;
            case "fullScreen":
                i = Build.VERSION.SDK_INT >= 34
                        ? new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + pkg))
                        : new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg));
                break;
            case "notifications":
                i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, pkg);
                break;
            case "bluetooth":
                i = new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE);
                break;
            case "location":
                i = new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS);
                break;
            case "installApps":
                i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + pkg));
                break;
            default:
                i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg));
        }
        openSettings(i, call);
    }

    @Override
    public void onEvent(String name, JSONObject data) {
        try {
            notifyListeners(name, new JSObject(data.toString()));
        } catch (JSONException ignored) {
        }
    }

    // ---------- Autorisations ----------
    private String[] neededAliases(boolean microphone) {
        List<String> list = new ArrayList<>();
        int sdk = Build.VERSION.SDK_INT;
        if (sdk >= 31) list.add("bluetooth");
        if (sdk >= 33) {
            list.add("wifi");
            list.add("notifications");
        }
        if (sdk <= 32) list.add("location");
        if (microphone) list.add("microphone");
        return list.toArray(new String[0]);
    }

    private boolean allGranted(String[] aliases) {
        for (String alias : aliases) {
            if (getPermissionState(alias) != PermissionState.GRANTED) return false;
        }
        return true;
    }

    private JSObject permissionResult(PluginCall call) {
        JSObject r = new JSObject();
        r.put("nearby", allGranted(neededAliases(false)));
        r.put("microphone", getPermissionState("microphone") == PermissionState.GRANTED);
        return r;
    }

    @PluginMethod
    public void checkNearbyPermissions(PluginCall call) {
        call.resolve(permissionResult(call));
    }

    @PluginMethod
    public void requestNearbyPermissions(PluginCall call) {
        String[] aliases = neededAliases(call.getBoolean("microphone", false));
        if (aliases.length == 0 || allGranted(aliases)) {
            call.resolve(permissionResult(call));
            return;
        }
        requestPermissionForAliases(aliases, call, "onPermissions");
    }

    @PermissionCallback
    private void onPermissions(PluginCall call) {
        call.resolve(permissionResult(call));
    }

    // ---------- Recherche ----------
    @PluginMethod
    public void start(PluginCall call) {
        String name = call.getString("name");
        wanted = true;
        engine.setListener(this);
        engine.setForeground(true);
        engine.start(name);
        call.resolve(toJS(engine.info()));
    }

    @PluginMethod
    public void stop(PluginCall call) {
        wanted = false;
        engine.stop();
        call.resolve();
    }

    @PluginMethod
    public void getInfo(PluginCall call) {
        call.resolve(toJS(engine.info()));
    }

    @PluginMethod
    public void setBackground(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", true);
        int minutes = call.getInt("intervalMinutes", 30);
        engine.prefs().edit().putBoolean("bg", enabled).putInt("interval", Math.max(15, minutes)).apply();
        if (enabled) G37SyncService.start(getContext());
        else G37SyncService.stop(getContext());
        call.resolve();
    }

    // ---------- Échanges ----------
    @PluginMethod
    public void broadcastPacket(PluginCall call) {
        engine.broadcastPacket();
        call.resolve();
    }

    @PluginMethod
    public void sendPacket(PluginCall call) {
        String id = call.getString("endpointId");
        if (id == null) { call.reject("endpointId manquant"); return; }
        engine.sendPacket(id);
        call.resolve();
    }

    @PluginMethod
    public void sendFile(final PluginCall call) {
        final String id = call.getString("endpointId");
        final String path = call.getString("path");
        final String kind = call.getString("kind", "file");
        final String name = call.getString("name", "");
        if (id == null || path == null) { call.reject("endpointId et path requis"); return; }
        new Thread(() -> {
            try {
                engine.sendFile(id, engine.resolve(path), kind, name);
                call.resolve();
            } catch (Exception e) {
                call.reject("Envoi impossible : " + e.getMessage());
            }
        }).start();
    }

    @PluginMethod
    public void sendMessage(PluginCall call) {
        String id = call.getString("endpointId");
        String data = call.getString("data");
        if (id == null || data == null) { call.reject("endpointId et data requis"); return; }
        engine.sendMessage(id, data);
        call.resolve();
    }

    @PluginMethod
    public void listInbox(PluginCall call) {
        JSObject r = new JSObject();
        try {
            r.put("files", new JSArray(engine.listInbox().toString()));
        } catch (JSONException e) {
            r.put("files", new JSArray());
        }
        call.resolve(r);
    }

    @PluginMethod
    public void deleteFile(PluginCall call) {
        try {
            engine.deleteFile(call.getString("path", ""));
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void sha256(final PluginCall call) {
        new Thread(() -> {
            try {
                call.resolve(toJS(engine.sha256(call.getString("path", ""))));
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        }).start();
    }

    @PluginMethod
    public void serveFile(PluginCall call) {
        try {
            JSObject r = new JSObject();
            r.put("url", engine.serveFile(call.getString("path", ""), call.getString("name", "update.zip")));
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void installApk(PluginCall call) {
        try {
            File src = engine.resolve(call.getString("path", ""));
            File dir = new File(getContext().getCacheDir(), "updates");
            if (!dir.exists()) dir.mkdirs();
            File apk = new File(dir, "atelier-g37-update.apk");
            try (InputStream in = new FileInputStream(src); OutputStream out = new FileOutputStream(apk)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
            JSObject r = new JSObject();
            if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
                Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
                settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(settings);
                r.put("needsPermission", true);
                call.resolve(r);
                return;
            }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
            Intent install = new Intent(Intent.ACTION_VIEW);
            install.setDataAndType(uri, "application/vnd.android.package-archive");
            install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(install);
            r.put("started", true);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Installation impossible : " + e.getMessage());
        }
    }

    // ---------- Appels de proximité ----------
    @PluginMethod
    public void startAudio(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            call.reject("Micro non autorisé");
            return;
        }
        try {
            engine.startAudio(call.getString("endpointId", ""));
            call.resolve();
        } catch (Exception e) {
            call.reject("Appel impossible : " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopAudio(PluginCall call) {
        engine.stopAudio();
        call.resolve();
    }

    @PluginMethod
    public void setMuted(PluginCall call) {
        engine.setMuted(call.getBoolean("muted", false));
        call.resolve();
    }

    @PluginMethod
    public void setSpeaker(PluginCall call) {
        engine.setSpeaker(call.getBoolean("on", false));
        call.resolve();
    }

    private static JSObject toJS(JSONObject o) {
        try {
            return new JSObject(o.toString());
        } catch (JSONException e) {
            return new JSObject();
        }
    }
}
