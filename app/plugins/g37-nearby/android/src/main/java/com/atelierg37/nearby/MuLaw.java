package com.atelierg37.nearby;

/** Compression audio G.711 µ-law (voix 8 kHz : 64 kbit/s, adapté au Bluetooth). */
final class MuLaw {
    private static final int BIAS = 0x84;
    private static final int CLIP = 32635;

    private MuLaw() {}

    static byte encode(short sample) {
        int pcm = sample;
        int sign = (pcm >> 8) & 0x80;
        if (sign != 0) pcm = -pcm;
        if (pcm > CLIP) pcm = CLIP;
        pcm += BIAS;
        int exponent = 7;
        for (int mask = 0x4000; (pcm & mask) == 0 && exponent > 0; exponent--, mask >>= 1) {
            // recherche du segment
        }
        int mantissa = (pcm >> (exponent + 3)) & 0x0F;
        return (byte) ~(sign | (exponent << 4) | mantissa);
    }

    static short decode(byte value) {
        int u = ~value & 0xFF;
        int sign = u & 0x80;
        int exponent = (u >> 4) & 0x07;
        int mantissa = u & 0x0F;
        int sample = ((mantissa << 3) + BIAS) << exponent;
        sample -= BIAS;
        return (short) (sign != 0 ? -sample : sample);
    }
}
