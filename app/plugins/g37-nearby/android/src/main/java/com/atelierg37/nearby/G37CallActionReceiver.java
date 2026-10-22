package com.atelierg37.nearby;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Bouton « Refuser » de l'écran d'appel : coupe la sonnerie ; l'app préviendra l'appelant à sa prochaine ouverture. */
public class G37CallActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        G37Notify.cancelCall(context);
        String room = intent.getStringExtra("room");
        if (room != null && !room.isEmpty()) {
            context.getSharedPreferences(G37Notify.LAUNCH_PREFS, Context.MODE_PRIVATE)
                    .edit().putString("declined", room).putLong("declinedAt", System.currentTimeMillis()).apply();
        }
    }
}
