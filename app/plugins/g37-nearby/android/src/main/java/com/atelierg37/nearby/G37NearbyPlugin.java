package com.atelierg37.nearby;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

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

    @Override
    public void load() {
        engine = NearbyEngine.get(getContext());
        engine.setListener(this);
        engine.setForeground(true);
    }

    @Override
    protected void handleOnResume() {
        if (engine == null) return;
        engine.setListener(this);
        engine.setForeground(true);
        if (wanted) engine.start(null);
    }

    @Override
    protected void handleOnPause() {
        // Le service d'arrière-plan prend le relais (recherche périodique).
        if (engine != null) engine.setForeground(false);
    }

    @Override
    protected void handleOnDestroy() {
        if (engine != null) {
            engine.setForeground(false);
            engine.setListener(null);
        }
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
        int minutes = call.getInt("intervalMinutes", 120);
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
