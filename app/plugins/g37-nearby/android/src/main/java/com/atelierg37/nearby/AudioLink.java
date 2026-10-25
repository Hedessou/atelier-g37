package com.atelierg37.nearby;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaRecorder;
import android.media.audiofx.AcousticEchoCanceler;
import android.media.audiofx.AutomaticGainControl;
import android.media.audiofx.NoiseSuppressor;
import android.util.Log;

import java.io.DataInputStream;
import java.io.EOFException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Appel Bluetooth / Wi-Fi direct (Google Nearby) : micro → flux, flux → écouteur.
 * Version 4 : voix large bande 16 kHz (ADPCM), anti-écho, anti-bruit, gain automatique,
 * petite mémoire tampon qui absorbe les à-coups du Bluetooth sans laisser le retard s'accumuler.
 */
final class AudioLink {
    private static final String TAG = "G37Audio";
    private static final byte MAGIC = 0x47; // 'G'
    private static final byte CODEC_ADPCM16 = 2;
    private static final int PREFILL_FRAMES = 3;      // 60 ms avant de commencer à jouer
    private static final int MAX_BACKLOG_FRAMES = 12; // au-delà de 240 ms de retard, on rattrape

    private final Context ctx;
    private volatile boolean running = true;
    private volatile boolean muted = false;
    private Thread captureThread;
    private Thread playThread;
    private OutputStream outStream;
    private InputStream inStream;
    private volatile boolean speaker = false;

    AudioLink(Context context) {
        ctx = context.getApplicationContext();
        AudioRoute.apply(ctx, false);
    }

    void startCapture(final OutputStream out) {
        if (captureThread != null) return;
        outStream = out;
        captureThread = new Thread(() -> {
            AudioRecord rec = null;
            AcousticEchoCanceler aec = null;
            NoiseSuppressor ns = null;
            AutomaticGainControl agc = null;
            try {
                int min = AudioRecord.getMinBufferSize(Adpcm.RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
                rec = new AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, Adpcm.RATE,
                        AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, Adpcm.SAMPLES * 2 * 8));
                int session = rec.getAudioSessionId();
                if (AcousticEchoCanceler.isAvailable()) { aec = AcousticEchoCanceler.create(session); if (aec != null) aec.setEnabled(true); }
                if (NoiseSuppressor.isAvailable()) { ns = NoiseSuppressor.create(session); if (ns != null) ns.setEnabled(true); }
                if (AutomaticGainControl.isAvailable()) { agc = AutomaticGainControl.create(session); if (agc != null) agc.setEnabled(true); }
                rec.startRecording();
                out.write(new byte[] { MAGIC, CODEC_ADPCM16 });
                out.flush();
                Adpcm.Encoder encoder = new Adpcm.Encoder();
                short[] pcm = new short[Adpcm.SAMPLES];
                short[] silence = new short[Adpcm.SAMPLES];
                byte[] frame = new byte[Adpcm.FRAME_BYTES];
                while (running) {
                    int got = 0;
                    while (got < Adpcm.SAMPLES && running) {
                        int n = rec.read(pcm, got, Adpcm.SAMPLES - got);
                        if (n <= 0) break;
                        got += n;
                    }
                    if (got < Adpcm.SAMPLES) continue;
                    encoder.encode(muted ? silence : pcm, frame);
                    out.write(frame);
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
                try { if (agc != null) agc.release(); } catch (Exception ignored) { }
                try { out.close(); } catch (Exception ignored) { }
            }
        }, "g37-audio-capture");
        captureThread.start();
    }

    void play(final InputStream raw) {
        if (playThread != null) return;
        inStream = raw;
        playThread = new Thread(() -> {
            AudioTrack track = null;
            try {
                DataInputStream in = new DataInputStream(raw);
                int b0 = in.readUnsignedByte();
                int b1 = in.readUnsignedByte();
                if (b0 != (MAGIC & 0xFF) || b1 != CODEC_ADPCM16) {
                    Log.w(TAG, "Flux d'une ancienne version : son ignoré");
                    return;
                }
                int min = AudioTrack.getMinBufferSize(Adpcm.RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
                track = new AudioTrack(
                        new AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                                .build(),
                        new AudioFormat.Builder()
                                .setSampleRate(Adpcm.RATE)
                                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                                .build(),
                        Math.max(min, Adpcm.SAMPLES * 2 * 6),
                        AudioTrack.MODE_STREAM,
                        AudioManager.AUDIO_SESSION_ID_GENERATE);
                byte[] frame = new byte[Adpcm.FRAME_BYTES];
                short[] pcm = new short[Adpcm.SAMPLES];
                int buffered = 0;
                boolean playing = false;
                while (running) {
                    // Retard trop grand (Bluetooth qui a « bouchonné ») : on saute des trames pour revenir au direct.
                    try {
                        int backlog = raw.available() / Adpcm.FRAME_BYTES;
                        if (backlog > MAX_BACKLOG_FRAMES) {
                            for (int i = 0; i < backlog - PREFILL_FRAMES; i++) in.readFully(frame);
                        }
                    } catch (Exception ignored) {
                        // available() non pris en charge : on continue normalement
                    }
                    in.readFully(frame);
                    Adpcm.decode(frame, pcm);
                    track.write(pcm, 0, Adpcm.SAMPLES);
                    if (!playing && ++buffered >= PREFILL_FRAMES) {
                        track.play();
                        playing = true;
                    }
                }
            } catch (EOFException e) {
                Log.i(TAG, "Fin du flux");
            } catch (Exception e) {
                Log.w(TAG, "Lecture arrêtée", e);
            } finally {
                try { if (track != null) { track.stop(); track.release(); } } catch (Exception ignored) { }
                try { raw.close(); } catch (Exception ignored) { }
            }
        }, "g37-audio-play");
        playThread.start();
    }

    void setMuted(boolean value) {
        muted = value;
    }

    void setSpeaker(boolean on) {
        speaker = on;
        AudioRoute.apply(ctx, on);
    }

    boolean isSpeaker() {
        return speaker;
    }

    void stop() {
        running = false;
        try { if (captureThread != null) captureThread.interrupt(); } catch (Exception ignored) { }
        try { if (playThread != null) playThread.interrupt(); } catch (Exception ignored) { }
        try { if (outStream != null) outStream.close(); } catch (Exception ignored) { }
        try { if (inStream != null) inStream.close(); } catch (Exception ignored) { }
        AudioRoute.reset(ctx);
    }
}
