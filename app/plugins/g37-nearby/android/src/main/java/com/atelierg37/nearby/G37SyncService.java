package com.atelierg37.nearby;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * Service discret (notification permanente exigée par Android) : toutes les 2 h environ,
 * le téléphone cherche les collègues proches pendant 2 minutes et échange les données avec eux,
 * même si l'app est fermée et même sans Internet.
 */
public class G37SyncService extends Service {
    private static final String TAG = "G37Sync";
    private static final String CHANNEL = "g37_sync";
    private static final int NOTIFICATION_ID = 3707;
    private static final long BURST_MS = 2 * 60 * 1000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            NearbyEngine engine = NearbyEngine.get(G37SyncService.this);
            if (!engine.isForeground()) engine.burst(BURST_MS);
            handler.postDelayed(this, intervalMs());
        }
    };

    public static void start(Context context) {
        try {
            ContextCompat.startForegroundService(context, new Intent(context, G37SyncService.class));
        } catch (Exception e) {
            Log.w(TAG, "Service non démarré", e);
        }
    }

    public static void stop(Context context) {
        context.stopService(new Intent(context, G37SyncService.class));
    }

    private long intervalMs() {
        int minutes = NearbyEngine.get(this).prefs().getInt("interval", 120);
        return Math.max(15, minutes) * 60L * 1000L;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Synchronisation sans Internet", NotificationManager.IMPORTANCE_MIN);
            channel.setDescription("Échange des données avec les collègues proches (Bluetooth / Wi-Fi)");
            channel.setShowBadge(false);
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(channel);
        }
        PendingIntent open = null;
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch != null) {
            open = PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        }
        Notification notification = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(getApplicationInfo().icon)
                .setContentTitle("Atelier G37")
                .setContentText("Synchronisation avec les collègues à proximité")
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setContentIntent(open)
                .build();
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification,
                    Build.VERSION.SDK_INT >= 29 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE : 0);
        } catch (Exception e) {
            Log.w(TAG, "Arrière-plan refusé par Android", e);
            stopSelf();
            return;
        }
        handler.postDelayed(tick, 60 * 1000);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(tick);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
