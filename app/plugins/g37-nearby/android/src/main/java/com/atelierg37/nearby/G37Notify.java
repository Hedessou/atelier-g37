package com.atelierg37.nearby;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;

import java.util.Map;

/**
 * Notifications de l'atelier construites par le téléphone lui-même (même app fermée) :
 * sonneries choisies dans les Paramètres, son fort (volume « réveil ») et écran d'appel plein écran.
 */
public final class G37Notify {
    static final String PREFS = "g37.sound";
    static final String LAUNCH_PREFS = "g37.launch";
    static final int CALL_NOTIFICATION_ID = 3790;
    static volatile boolean appForeground = false;

    private G37Notify() {
    }

    static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String alertSound(Context ctx) { return prefs(ctx).getString("alert", "alert_atelier"); }
    static String messageSound(Context ctx) { return prefs(ctx).getString("message", "alert_message"); }
    static String callSound(Context ctx) { return prefs(ctx).getString("call", "call_marimba"); }
    static boolean loud(Context ctx) { return prefs(ctx).getBoolean("loud", true); }

    static String alertChannel(Context ctx) { return "g37a_" + alertSound(ctx) + (loud(ctx) ? "_f" : "_n"); }
    static String messageChannel(Context ctx) { return "g37m_" + messageSound(ctx) + (loud(ctx) ? "_f" : "_n"); }
    static String callChannel(Context ctx) { return "g37c_" + callSound(ctx); }

    static int rawId(Context ctx, String name) {
        int id = ctx.getResources().getIdentifier(name, "raw", ctx.getPackageName());
        return id != 0 ? id : ctx.getResources().getIdentifier("alert_atelier", "raw", ctx.getPackageName());
    }

    static Uri soundUri(Context ctx, String name) {
        return Uri.parse("android.resource://" + ctx.getPackageName() + "/" + rawId(ctx, name));
    }

    /** Crée les canaux correspondant aux sons choisis (le son d'un canal ne peut plus changer après sa création). */
    static void ensureChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        boolean isLoud = loud(ctx);
        String alert = alertChannel(ctx);
        String message = messageChannel(ctx);
        String call = callChannel(ctx);
        for (NotificationChannel c : nm.getNotificationChannels()) {
            String id = c.getId();
            boolean ours = id.startsWith("g37a_") || id.startsWith("g37m_") || id.startsWith("g37c_");
            if (ours && !id.equals(alert) && !id.equals(message) && !id.equals(call)) nm.deleteNotificationChannel(id);
        }
        int usage = isLoud ? AudioAttributes.USAGE_ALARM : AudioAttributes.USAGE_NOTIFICATION_EVENT;
        create(nm, alert, "Alertes de l'atelier", "Pannes, arrêts, maintenances et graissages à faire",
                soundUri(ctx, alertSound(ctx)), usage, new long[]{0, 500, 200, 500, 200, 800});
        create(nm, message, "Messages", "Messages privés et groupe Maintenance R/F",
                soundUri(ctx, messageSound(ctx)), usage, new long[]{0, 300, 150, 300});
        create(nm, call, "Appels", "Appels des collègues",
                soundUri(ctx, callSound(ctx)), AudioAttributes.USAGE_NOTIFICATION_RINGTONE, new long[]{0, 800, 400, 800, 400, 800});
    }

    private static void create(NotificationManager nm, String id, String name, String description, Uri sound, int usage, long[] vibration) {
        if (nm.getNotificationChannel(id) != null) return;
        NotificationChannel ch = new NotificationChannel(id, name, NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription(description);
        ch.setSound(sound, new AudioAttributes.Builder()
                .setUsage(usage)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
        ch.enableVibration(true);
        ch.setVibrationPattern(vibration);
        ch.enableLights(true);
        ch.setLightColor(Color.rgb(245, 158, 11));
        ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        ch.setShowBadge(true);
        nm.createNotificationChannel(ch);
    }

    private static Intent launchIntent(Context ctx) {
        Intent launch = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        if (launch == null) launch = new Intent();
        launch.setPackage(ctx.getPackageName());
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return launch;
    }

    private static int flags() {
        return PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
    }

    static void showAlert(Context ctx, Map<String, String> data) {
        ensureChannels(ctx);
        String kind = val(data, "kind", "alert");
        String title = val(data, "title", "Spinning R/F");
        String body = val(data, "body", "");
        String tag = val(data, "tag", String.valueOf(System.currentTimeMillis()));
        boolean isMessage = kind.equals("dm") || kind.equals("chat");
        Intent open = launchIntent(ctx);
        open.putExtra("g37_tab", val(data, "tab", ""));
        if (data.containsKey("peer")) open.putExtra("g37_peer", data.get("peer"));
        int code = tag.hashCode();
        PendingIntent pi = PendingIntent.getActivity(ctx, code, open, flags());
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, isMessage ? messageChannel(ctx) : alertChannel(ctx))
                .setSmallIcon(R.drawable.ic_g37_notif)
                .setColor(Color.rgb(245, 158, 11))
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(isMessage ? NotificationCompat.CATEGORY_MESSAGE : NotificationCompat.CATEGORY_ALARM)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setAutoCancel(true)
                .setContentIntent(pi);
        if (Build.VERSION.SDK_INT < 26) {
            b.setSound(soundUri(ctx, isMessage ? messageSound(ctx) : alertSound(ctx)));
            b.setVibrate(new long[]{0, 500, 200, 500});
        }
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(tag, code, b.build());
    }

    static void showIncomingCall(Context ctx, Map<String, String> data) {
        ensureChannels(ctx);
        String room = val(data, "room", "");
        String name = val(data, "name", "Collègue");
        boolean group = "1".equals(data.get("group"));
        String title = group ? "Appel de groupe" : "Appel de " + name;
        String body = group ? name + " t'invite à un appel de groupe" : "Appel Spinning R/F";

        Intent ring = launchIntent(ctx);
        ring.putExtra("g37_call_room", room).putExtra("g37_call_name", name).putExtra("g37_call_action", "ring")
                .putExtra("g37_call_from", val(data, "from", "")).putExtra("g37_call_group", group);
        PendingIntent fullScreen = PendingIntent.getActivity(ctx, 3791, ring, flags());

        Intent answer = launchIntent(ctx);
        answer.putExtra("g37_call_room", room).putExtra("g37_call_name", name).putExtra("g37_call_action", "answer")
                .putExtra("g37_call_from", val(data, "from", "")).putExtra("g37_call_group", group);
        PendingIntent answerPi = PendingIntent.getActivity(ctx, 3792, answer, flags());

        Intent decline = new Intent(ctx, G37CallActionReceiver.class);
        decline.setAction("com.atelierg37.CALL_DECLINE");
        decline.putExtra("room", room);
        PendingIntent declinePi = PendingIntent.getBroadcast(ctx, 3793, decline, flags());

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, callChannel(ctx))
                .setSmallIcon(R.drawable.ic_g37_notif)
                .setColor(Color.rgb(34, 197, 94))
                .setContentTitle(title)
                .setContentText(body)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOngoing(true)
                .setAutoCancel(true)
                .setTimeoutAfter(45000)
                .setFullScreenIntent(fullScreen, true)
                .setContentIntent(fullScreen)
                .addAction(0, "Refuser", declinePi)
                .addAction(0, "Répondre", answerPi);
        if (Build.VERSION.SDK_INT < 26) {
            b.setSound(soundUri(ctx, callSound(ctx)));
            b.setVibrate(new long[]{0, 800, 400, 800});
        }
        Notification n = b.build();
        n.flags |= Notification.FLAG_INSISTENT; // la sonnerie se répète jusqu'à la réponse
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(CALL_NOTIFICATION_ID, n);
    }

    static void cancelCall(Context ctx) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(CALL_NOTIFICATION_ID);
    }

    private static String val(Map<String, String> data, String key, String fallback) {
        String v = data.get(key);
        return v == null || v.isEmpty() ? fallback : v;
    }
}
