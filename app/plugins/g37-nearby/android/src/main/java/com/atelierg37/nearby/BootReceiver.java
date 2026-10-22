package com.atelierg37.nearby;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Relance la synchronisation sans Internet après un redémarrage du téléphone ou une mise à jour de l'app. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) return;
        if (NearbyEngine.get(context).prefs().getBoolean("bg", false)) G37SyncService.start(context);
    }
}
