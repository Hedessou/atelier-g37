package com.atelierg37.nearby;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import org.json.JSONObject;

/**
 * Bouton « Refuser » de l'écran d'appel : coupe la sonnerie.
 * Appel sans Internet (Bluetooth / Wi-Fi) : l'appelant est prévenu tout de suite par la liaison de proximité.
 * Appel Internet : l'app préviendra l'appelant à sa prochaine ouverture.
 */
public class G37CallActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        G37Notify.cancelCall(context);
        String room = intent.getStringExtra("room");
        String via = intent.getStringExtra("via");
        String endpoint = intent.getStringExtra("endpoint");
        if (room == null || room.isEmpty()) return;
        if (("proche".equals(via) || "wifi".equals(via)) && endpoint != null && !endpoint.isEmpty()) {
            try {
                NearbyEngine engine = NearbyEngine.get(context);
                engine.clearRinging(room);
                engine.sendMessage(endpoint, new JSONObject().put("t", "call").put("type", "decline").put("callId", room).toString());
            } catch (Exception ignored) {
            }
            return;
        }
        context.getSharedPreferences(G37Notify.LAUNCH_PREFS, Context.MODE_PRIVATE)
                .edit().putString("declined", room).putLong("declinedAt", System.currentTimeMillis()).apply();
    }
}
