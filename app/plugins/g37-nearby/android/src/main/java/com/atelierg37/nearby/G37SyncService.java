package com.atelierg37.nearby;

import android.Manifest;
import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * Service discret (notification permanente exigée par Android) :
 *  - le téléphone reste joignable par les collègues proches (annonce Bluetooth + écoute du Wi-Fi local), app fermée ;
 *  - régulièrement, il cherche activement les collègues pendant 3 minutes et échange les données ;
 *  - pendant un appel, il garde le micro actif même si l'écran s'éteint ou si on change d'app.
 */
public class G37SyncService extends Service {
    private static final String TAG = "G37Sync";
    private static final String CHANNEL = "g37_sync";
    private static final String CALL_CHANNEL = "g37_incall";
    private static final int NOTIFICATION_ID = 3707;
    private static final long BURST_MS = 3 * 60 * 1000;
    static final String ACTION_CALL_ON = "call_on";
    static final String ACTION_CALL_OFF = "call_off";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private long lastBurst = 0;
    private boolean inCall = false;
    private String callTitle = "Appel en cours";
    private PowerManager.WakeLock callLock;

    /** Réveil fiable même en veille profonde (Doze) : Android déclenche ce rappel même écran éteint. */
    private void scheduleAlarm() {
        try {
            AlarmManager am = (AlarmManager) getSystemService(ALARM_SERVICE);
            if (am == null) return;
            Intent i = new Intent(this, G37SyncService.class).setAction("tick");
            PendingIntent pi = PendingIntent.getService(this, 3708, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            long at = System.currentTimeMillis() + intervalMs();
            if (Build.VERSION.SDK_INT >= 23) am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            else am.set(AlarmManager.RTC_WAKEUP, at, pi);
        } catch (Exception e) {
            Log.w(TAG, "Réveil non programmé", e);
        }
    }

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            handler.removeCallbacks(this);
            NearbyEngine engine = NearbyEngine.get(G37SyncService.this);
            engine.ensureBackground();
            if (System.currentTimeMillis() - lastBurst < intervalMs() / 2) {
                handler.postDelayed(this, intervalMs());
                return;
            }
            lastBurst = System.currentTimeMillis();
            scheduleAlarm();
            if (!engine.isForeground()) {
                // Le téléphone reste éveillé le temps de la recherche (Bluetooth, Wi-Fi direct, même Wi-Fi, point d'accès).
                try {
                    PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
                    if (pm != null) pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "g37:sync").acquire(BURST_MS + 15000);
                } catch (Exception ignored) {
                }
                engine.burst(BURST_MS);
            }
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

    /** Appel en cours : le service garde le micro (et l'écran d'appel) actif en arrière-plan. */
    public static void setInCall(Context context, boolean on, String title) {
        try {
            Intent i = new Intent(context, G37SyncService.class).setAction(on ? ACTION_CALL_ON : ACTION_CALL_OFF);
            if (title != null) i.putExtra("title", title);
            ContextCompat.startForegroundService(context, i);
        } catch (Exception e) {
            Log.w(TAG, "Mode appel non appliqué", e);
        }
    }

    private long intervalMs() {
        int minutes = NearbyEngine.get(this).prefs().getInt("interval", 30);
        return Math.max(15, minutes) * 60L * 1000L;
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Synchronisation sans Internet", NotificationManager.IMPORTANCE_MIN);
        channel.setDescription("Reste joignable par les collègues proches (Bluetooth / Wi-Fi) et échange les données");
        channel.setShowBadge(false);
        nm.createNotificationChannel(channel);
        NotificationChannel call = new NotificationChannel(CALL_CHANNEL, "Appel en cours", NotificationManager.IMPORTANCE_LOW);
        call.setDescription("Affichée pendant un appel");
        call.setShowBadge(false);
        call.setSound(null, null);
        nm.createNotificationChannel(call);
    }

    private Notification buildNotification() {
        PendingIntent open = null;
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch != null) {
            launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            open = PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        }
        if (inCall) {
            return new NotificationCompat.Builder(this, CALL_CHANNEL)
                    .setSmallIcon(R.drawable.ic_g37_notif)
                    .setContentTitle(callTitle)
                    .setContentText("Touchez pour revenir à l'appel")
                    .setOngoing(true)
                    .setCategory(NotificationCompat.CATEGORY_CALL)
                    .setPriority(NotificationCompat.PRIORITY_LOW)
                    .setUsesChronometer(true)
                    .setContentIntent(open)
                    .build();
        }
        boolean always = NearbyEngine.get(this).alwaysReachable();
        return new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_g37_notif)
                .setContentTitle("Spinning R/F")
                .setContentText(always ? "Joignable sans Internet (Bluetooth, Wi-Fi) · synchronisation des collègues"
                        : "Synchronisation avec les collègues (Bluetooth, Wi-Fi, Internet)")
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setContentIntent(open)
                .build();
    }

    private boolean micGranted() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    private void goForeground() {
        int type = 0;
        if (Build.VERSION.SDK_INT >= 29) {
            type = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;
            if (inCall && micGranted() && Build.VERSION.SDK_INT >= 30) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
        }
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), type);
        } catch (Exception e) {
            Log.w(TAG, "Premier plan refusé (type " + type + ")", e);
            if (inCall) {
                // Android a refusé le micro en arrière-plan : on garde au moins la synchronisation.
                inCall = false;
                try {
                    ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(),
                            Build.VERSION.SDK_INT >= 29 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE : 0);
                } catch (Exception e2) {
                    stopSelf();
                }
            } else {
                stopSelf();
            }
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
        goForeground();
        NearbyEngine.get(this).ensureBackground();
        handler.postDelayed(tick, 20 * 1000);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if ("tick".equals(action)) {
            handler.post(tick);
        } else if (ACTION_CALL_ON.equals(action)) {
            inCall = true;
            String t = intent.getStringExtra("title");
            if (t != null && !t.isEmpty()) callTitle = t;
            goForeground();
            try {
                PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
                if (pm != null && (callLock == null || !callLock.isHeld())) {
                    callLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "g37:call");
                    callLock.acquire(3 * 60 * 60 * 1000L);
                }
            } catch (Exception ignored) {
            }
        } else if (ACTION_CALL_OFF.equals(action)) {
            inCall = false;
            goForeground();
            releaseCallLock();
            if (!NearbyEngine.get(this).prefs().getBoolean("bg", false)) {
                stopSelf();
            }
        } else {
            goForeground();
        }
        return START_STICKY;
    }

    private void releaseCallLock() {
        try {
            if (callLock != null && callLock.isHeld()) callLock.release();
        } catch (Exception ignored) {
        }
        callLock = null;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(tick);
        releaseCallLock();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
