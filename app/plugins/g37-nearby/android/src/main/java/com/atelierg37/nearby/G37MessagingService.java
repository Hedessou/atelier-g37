package com.atelierg37.nearby;

import android.util.Log;

import androidx.annotation.NonNull;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.lang.reflect.Method;
import java.util.Map;

/**
 * Reçoit toutes les notifications Firebase (remplace celui du module Capacitor, qui reste appelé quand l'app est ouverte).
 * App fermée ou en arrière-plan : le téléphone affiche lui-même la notification avec la bonne sonnerie,
 * ou l'écran d'appel plein écran qui sonne jusqu'à la réponse.
 */
public class G37MessagingService extends FirebaseMessagingService {
    private static final String TAG = "G37Push";
    private static final String CAP = "com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin";

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        super.onMessageReceived(message);
        Map<String, String> data = message.getData();
        String kind = data.get("kind");
        if (message.getNotification() != null || kind == null) {
            forward(message);
            return;
        }
        if (G37Notify.appForeground) {
            // L'app est à l'écran : elle fait sonner et affiche l'appel elle-même.
            forward(message);
            return;
        }
        try {
            if (kind.equals("call")) G37Notify.showIncomingCall(this, data);
            else if (kind.equals("call_end")) {
                // L'appelant a raccroché avant la réponse : « appel manqué », comme sur un vrai téléphone.
                String room = data.get("room");
                String ringing = G37Notify.ringingRoom(this);
                G37Notify.cancelCall(this);
                if (room != null && room.equals(ringing)) {
                    String body = data.get("body");
                    String name = body != null && body.startsWith("Appel de ") ? body.substring(9) : "Collègue";
                    G37Notify.showMissedCall(this, name, "1".equals(data.get("video")));
                }
            }
            else G37Notify.showAlert(this, data);
        } catch (Exception e) {
            Log.e(TAG, "Notification non affichée", e);
        }
    }

    @Override
    public void onNewToken(@NonNull String token) {
        super.onNewToken(token);
        try {
            Method m = Class.forName(CAP).getMethod("onNewToken", String.class);
            m.invoke(null, token);
        } catch (Exception e) {
            Log.w(TAG, "Jeton non transmis", e);
        }
    }

    private void forward(RemoteMessage message) {
        try {
            Method m = Class.forName(CAP).getMethod("sendRemoteMessage", RemoteMessage.class);
            m.invoke(null, message);
        } catch (Exception e) {
            Log.w(TAG, "Message non transmis à l'app", e);
        }
    }
}
