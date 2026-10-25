package com.atelierg37.nearby;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.util.Log;

/**
 * Sortie du son pendant un appel : écouteur, haut-parleur, ou casque / oreillette (filaire ou Bluetooth) s'il y en a un.
 * Utilisé par les appels Internet / Wi-Fi (WebRTC) et par les appels Bluetooth.
 */
final class AudioRoute {
    private static final String TAG = "G37Route";

    private AudioRoute() {
    }

    @SuppressWarnings("deprecation")
    static void apply(Context ctx, boolean speaker) {
        AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        if (am == null) return;
        try {
            am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            if (Build.VERSION.SDK_INT >= 31) {
                AudioDeviceInfo chosen = null;
                for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
                    int t = d.getType();
                    if (speaker) {
                        if (t == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) { chosen = d; break; }
                    } else if (t == AudioDeviceInfo.TYPE_WIRED_HEADSET || t == AudioDeviceInfo.TYPE_WIRED_HEADPHONES
                            || t == AudioDeviceInfo.TYPE_USB_HEADSET || t == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
                            || t == AudioDeviceInfo.TYPE_BLE_HEADSET) {
                        chosen = d; // casque ou oreillette en priorité
                        break;
                    } else if (t == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE && chosen == null) {
                        chosen = d;
                    }
                }
                if (chosen != null) am.setCommunicationDevice(chosen);
                else am.clearCommunicationDevice();
            } else {
                am.setSpeakerphoneOn(speaker);
                if (!speaker && am.isBluetoothScoAvailableOffCall()) {
                    try { am.startBluetoothSco(); am.setBluetoothScoOn(true); } catch (Exception ignored) { }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Sortie audio", e);
        }
    }

    @SuppressWarnings("deprecation")
    static void reset(Context ctx) {
        AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        if (am == null) return;
        try {
            if (Build.VERSION.SDK_INT >= 31) am.clearCommunicationDevice();
            else {
                am.setSpeakerphoneOn(false);
                try { am.setBluetoothScoOn(false); am.stopBluetoothSco(); } catch (Exception ignored) { }
            }
            am.setMode(AudioManager.MODE_NORMAL);
        } catch (Exception e) {
            Log.w(TAG, "Remise à zéro audio", e);
        }
    }
}
