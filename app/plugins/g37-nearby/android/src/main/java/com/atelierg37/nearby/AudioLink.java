package com.atelierg37.nearby;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaRecorder;
import android.media.audiofx.AcousticEchoCanceler;
import android.media.audiofx.NoiseSuppressor;
import android.util.Log;

import java.io.InputStream;
import java.io.OutputStream;

/** Appel de proximité : micro → flux Nearby, flux Nearby → haut-parleur (voix 8 kHz µ-law). */
final class AudioLink {
    private static final String TAG = "G37Audio";
    private static final int RATE = 8000;
    private static final int FRAME = 160; // 20 ms

    private final AudioManager audioManager;
    private volatile boolean running = true;
    private volatile boolean muted = false;
    private Thread captureThread;
    private Thread playThread;
    private OutputStream outStream;
    private InputStream inStream;

    AudioLink(Context context) {
        audioManager = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        try {
            audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
        } catch (Exception e) {
            Log.w(TAG, "Mode communication indisponible", e);
        }
    }

    void startCapture(final OutputStream out) {
        if (captureThread != null) return;
        outStream = out;
        captureThread = new Thread(() -> {
            AudioRecord rec = null;
            AcousticEchoCanceler aec = null;
            NoiseSuppressor ns = null;
            try {
                int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
                rec = new AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, RATE,
                        AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, FRAME * 20));
                if (AcousticEchoCanceler.isAvailable()) {
                    aec = AcousticEchoCanceler.create(rec.getAudioSessionId());
                    if (aec != null) aec.setEnabled(true);
                }
                if (NoiseSuppressor.isAvailable()) {
                    ns = NoiseSuppressor.create(rec.getAudioSessionId());
                    if (ns != null) ns.setEnabled(true);
                }
                rec.startRecording();
                short[] pcm = new short[FRAME];
                byte[] enc = new byte[FRAME];
                while (running) {
                    int n = rec.read(pcm, 0, FRAME);
                    if (n <= 0) continue;
                    for (int i = 0; i < n; i++) enc[i] = muted ? (byte) 0xFF : MuLaw.encode(pcm[i]);
                    out.write(enc, 0, n);
                    out.flush();
                }
            } catch (SecurityException e) {
                Log.w(TAG, "Micro non autorisé", e);
            } catch (Exception e) {
                Log.w(TAG, "Capture arrêtée", e);
            } finally {
                try { if (rec != null) { rec.stop(); rec.release(); } } catch (Exception ignored) { }
                try { if (aec != null) aec.release(); } catch (Exception ignored) { }
                try { if (ns != null) ns.release(); } catch (Exception ignored) { }
                try { out.close(); } catch (Exception ignored) { }
            }
        }, "g37-audio-capture");
        captureThread.start();
    }

    void play(final InputStream in) {
        if (playThread != null) return;
        inStream = in;
        playThread = new Thread(() -> {
            AudioTrack track = null;
            try {
                int min = AudioTrack.getMinBufferSize(RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
                track = new AudioTrack(
                        new AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                                .build(),
                        new AudioFormat.Builder()
                                .setSampleRate(RATE)
                                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                                .build(),
                        Math.max(min, FRAME * 20),
                        AudioTrack.MODE_STREAM,
                        AudioManager.AUDIO_SESSION_ID_GENERATE);
                track.play();
                byte[] buf = new byte[FRAME * 2];
                short[] pcm = new short[FRAME * 2];
                while (running) {
                    int n = in.read(buf);
                    if (n < 0) break;
                    for (int i = 0; i < n; i++) pcm[i] = MuLaw.decode(buf[i]);
                    track.write(pcm, 0, n);
                }
            } catch (Exception e) {
                Log.w(TAG, "Lecture arrêtée", e);
            } finally {
                try { if (track != null) { track.stop(); track.release(); } } catch (Exception ignored) { }
                try { in.close(); } catch (Exception ignored) { }
            }
        }, "g37-audio-play");
        playThread.start();
    }

    void setMuted(boolean value) {
        muted = value;
    }

    @SuppressWarnings("deprecation")
    void setSpeaker(boolean on) {
        try {
            audioManager.setSpeakerphoneOn(on);
        } catch (Exception e) {
            Log.w(TAG, "Haut-parleur", e);
        }
    }

    @SuppressWarnings("deprecation")
    void stop() {
        running = false;
        try { if (captureThread != null) captureThread.interrupt(); } catch (Exception ignored) { }
        try { if (playThread != null) playThread.interrupt(); } catch (Exception ignored) { }
        try { if (outStream != null) outStream.close(); } catch (Exception ignored) { }
        try { if (inStream != null) inStream.close(); } catch (Exception ignored) { }
        try {
            audioManager.setSpeakerphoneOn(false);
            audioManager.setMode(AudioManager.MODE_NORMAL);
        } catch (Exception ignored) { }
    }
}
