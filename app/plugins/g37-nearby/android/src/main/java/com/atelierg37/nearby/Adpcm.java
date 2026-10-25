package com.atelierg37.nearby;

/**
 * Codage de la voix pour les appels Bluetooth (IMA ADPCM, 4 bits par échantillon).
 * 16 kHz « large bande » au même débit que l'ancien 8 kHz µ-law (≈ 65 kbit/s) : voix nettement plus claire.
 * Trame de 20 ms = 320 échantillons → 3 octets d'en-tête (prédiction, index) + 160 octets.
 * Chaque trame porte son état : le décodeur se recale tout seul.
 */
final class Adpcm {
    static final int RATE = 16000;
    static final int SAMPLES = 320;
    static final int FRAME_BYTES = 3 + SAMPLES / 2;

    private static final int[] INDEX = { -1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8 };
    private static final int[] STEP = {
            7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97,
            107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
            876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871,
            5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623,
            27086, 29794, 32767 };

    private Adpcm() {
    }

    static final class Encoder {
        private int pred = 0;
        private int index = 0;

        /** Code exactement SAMPLES échantillons dans out (FRAME_BYTES octets). */
        void encode(short[] pcm, byte[] out) {
            out[0] = (byte) (pred >> 8);
            out[1] = (byte) pred;
            out[2] = (byte) index;
            int o = 3;
            for (int i = 0; i < SAMPLES; i += 2) {
                int a = step(pcm[i]);
                int b = step(pcm[i + 1]);
                out[o++] = (byte) ((a & 0x0F) | ((b & 0x0F) << 4));
            }
        }

        private int step(int sample) {
            int step = STEP[index];
            int diff = sample - pred;
            int code = 0;
            if (diff < 0) { code = 8; diff = -diff; }
            int delta = step >> 3;
            if (diff >= step) { code |= 4; diff -= step; delta += step; }
            step >>= 1;
            if (diff >= step) { code |= 2; diff -= step; delta += step; }
            step >>= 1;
            if (diff >= step) { code |= 1; delta += step; }
            pred += (code & 8) != 0 ? -delta : delta;
            if (pred > 32767) pred = 32767;
            else if (pred < -32768) pred = -32768;
            index += INDEX[code];
            if (index < 0) index = 0;
            else if (index > 88) index = 88;
            return code;
        }
    }

    /** Décode une trame (FRAME_BYTES octets) en SAMPLES échantillons. */
    static void decode(byte[] in, short[] pcm) {
        int pred = (short) (((in[0] & 0xFF) << 8) | (in[1] & 0xFF));
        int index = in[2] & 0xFF;
        if (index > 88) index = 88;
        int s = 0;
        for (int i = 3; i < FRAME_BYTES; i++) {
            for (int half = 0; half < 2; half++) {
                int code = half == 0 ? in[i] & 0x0F : (in[i] >> 4) & 0x0F;
                int step = STEP[index];
                int delta = step >> 3;
                if ((code & 4) != 0) delta += step;
                if ((code & 2) != 0) delta += step >> 1;
                if ((code & 1) != 0) delta += step >> 2;
                pred += (code & 8) != 0 ? -delta : delta;
                if (pred > 32767) pred = 32767;
                else if (pred < -32768) pred = -32768;
                index += INDEX[code];
                if (index < 0) index = 0;
                else if (index > 88) index = 88;
                pcm[s++] = (short) pred;
            }
        }
    }
}
