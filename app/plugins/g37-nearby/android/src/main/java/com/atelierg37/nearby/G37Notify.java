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
        // Messages privés : une seule notification par collègue, qui accumule les derniers messages (comme WhatsApp).
        String peer = data.get("peer");
        String groupKey = kind.equals("dm") && peer != null && !peer.isEmpty() ? "dm-" + peer : kind.equals("chat") ? "chat" : null;
        NotificationCompat.Style style = new NotificationCompat.BigTextStyle().bigText(body);
        String text = body;
        if (groupKey != null) {
            tag = groupKey;
            SharedPreferences p = prefs(ctx);
            String prev = p.getString("dmlines:" + groupKey, "");
            String line = body;
            String all = prev.isEmpty() ? line : prev + "\n" + line;
            String[] lines = all.split("\n");
            int from = Math.max(0, lines.length - 6);
            StringBuilder kept = new StringBuilder();
            NotificationCompat.InboxStyle inbox = new NotificationCompat.InboxStyle();
            for (int i = from; i < lines.length; i++) {
                if (kept.length() > 0) kept.append("\n");
                kept.append(lines[i]);
                inbox.addLine(lines[i]);
            }
            p.edit().putString("dmlines:" + groupKey, kept.toString()).apply();
            if (lines.length > 1) {
                inbox.setSummaryText(lines.length + " nouveaux messages");
                style = inbox;
                text = lines.length + " nouveaux messages";
            }
        }
        int code = tag.hashCode();
        PendingIntent pi = PendingIntent.getActivity(ctx, code, open, flags());
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, isMessage ? messageChannel(ctx) : alertChannel(ctx))
                .setSmallIcon(R.drawable.ic_g37_notif)
                .setColor(Color.rgb(245, 158, 11))
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(style)
                .setGroup(isMessage ? "g37-messages" : "g37-alerts")
                .setOnlyAlertOnce(false)
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

    private static Intent callIntent(Context ctx, Map<String, String> data, String action) {
        Intent i = launchIntent(ctx);
        i.putExtra("g37_call_room", val(data, "room", "")).putExtra("g37_call_name", val(data, "name", "Collègue"))
                .putExtra("g37_call_action", action).putExtra("g37_call_from", val(data, "from", ""))
                .putExtra("g37_call_group", "1".equals(data.get("group")))
                .putExtra("g37_call_via", val(data, "via", "internet"))
                .putExtra("g37_call_endpoint", val(data, "endpoint", ""))
                .putExtra("g37_call_mode", val(data, "mode", ""))
                .putExtra("g37_call_video", "1".equals(data.get("video")));
        return i;
    }

    static void showIncomingCall(Context ctx, Map<String, String> data) {
        ensureChannels(ctx);
        String room = val(data, "room", "");
        String name = val(data, "name", "Collègue");
        boolean group = "1".equals(data.get("group"));
        boolean video = "1".equals(data.get("video"));
        String via = val(data, "via", "internet");
        String kindLabel = video ? "Appel vidéo" : "Appel";
        String title = group ? kindLabel + " de groupe" : kindLabel + " de " + name;
        String where = via.equals("proche") ? " · sans Internet (Bluetooth)" : via.equals("wifi") ? " · sans Internet (Wi-Fi)" : "";
        String body = (group ? name + " t'invite à un appel de groupe" : "Spinning R/F") + where;
        prefs(ctx).edit().putString("ringRoom", room).putString("ringName", name).putBoolean("ringVideo", video)
                .putLong("ringAt", System.currentTimeMillis()).apply();

        PendingIntent fullScreen = PendingIntent.getActivity(ctx, 3791, callIntent(ctx, data, "ring"), flags());
        PendingIntent answerPi = PendingIntent.getActivity(ctx, 3792, callIntent(ctx, data, "answer"), flags());

        Intent decline = new Intent(ctx, G37CallActionReceiver.class);
        decline.setAction("com.atelierg37.CALL_DECLINE");
        decline.putExtra("room", room);
        decline.putExtra("via", via);
        decline.putExtra("endpoint", val(data, "endpoint", ""));
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
        prefs(ctx).edit().remove("ringRoom").apply();
    }

    /** Appel qui sonnait (pas encore répondu) : sert à afficher « appel manqué » quand l'appelant raccroche. */
    static String ringingRoom(Context ctx) {
        SharedPreferences p = prefs(ctx);
        if (System.currentTimeMillis() - p.getLong("ringAt", 0) > 120000) return null;
        return p.getString("ringRoom", null);
    }

    static void showMissedCall(Context ctx, String name, boolean video) {
        ensureChannels(ctx);
        Intent open = launchIntent(ctx);
        open.putExtra("g37_tab", "discussion");
        open.putExtra("g37_segment", "calls");
        PendingIntent pi = PendingIntent.getActivity(ctx, 3794, open, flags());
        String when = java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(new java.util.Date());
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, messageChannel(ctx))
                .setSmallIcon(R.drawable.ic_g37_notif)
                .setColor(Color.rgb(239, 68, 68))
                .setContentTitle(video ? "Appel vidéo manqué" : "Appel manqué")
                .setContentText(name + " · " + when)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory("missed_call")
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setAutoCancel(true)
                .setContentIntent(pi);
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify("missed-" + System.currentTimeMillis(), 3795, b.build());
    }

    /** Ouverture de l'app : les messages regroupés par conversation repartent de zéro. */
    static void clearMessageGroups(Context ctx) {
        SharedPreferences p = prefs(ctx);
        SharedPreferences.Editor e = p.edit();
        for (String k : p.getAll().keySet()) if (k.startsWith("dmlines:")) e.remove(k);
        e.apply();
    }

    private static String val(Map<String, String> data, String key, String fallback) {
        String v = data.get(key);
        return v == null || v.isEmpty() ? fallback : v;
    }
}
