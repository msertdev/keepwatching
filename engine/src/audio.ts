/**
 * Optional audio. A format renders silent unless it declares an `audio` block.
 *
 * The click generator is a utility, not a house style — pick your own interval,
 * or leave it out. Music beds are never bundled with this repo; point `audio.bed`
 * at a file you have the rights to.
 */
import fs from "node:fs";

const SAMPLE_RATE = 48000;

export interface ClickOpts {
  durationSec: number;
  everySec: number;
  untilSec?: number;
  freqHz?: number;
  gain?: number;
  clickMs?: number;
}

/**
 * Synthesise a click track as a 16-bit mono WAV: a sine burst under a fast
 * exponential decay with a short attack so nothing pops. The file always runs
 * the full duration so ffmpeg gets a clean silent tail.
 */
export function writeClickWav(file: string, opts: ClickOpts): void {
  const {
    durationSec,
    everySec,
    untilSec = durationSec,
    freqHz = 1200,
    gain = 0.3,
    clickMs = 25,
  } = opts;

  const total = Math.round(durationSec * SAMPLE_RATE);
  const buf = new Float32Array(total);
  const clickLen = Math.round((clickMs / 1000) * SAMPLE_RATE);
  const attack = Math.round(0.0015 * SAMPLE_RATE);

  for (let k = 0; k * everySec < untilSec; k++) {
    const start = Math.round(k * everySec * SAMPLE_RATE);
    for (let i = 0; i < clickLen; i++) {
      const idx = start + i;
      if (idx >= total) break;
      const tt = i / SAMPLE_RATE;
      const decay = Math.exp(-tt * 190);
      const env = i < attack ? i / attack : 1;
      buf[idx] += gain * env * decay * Math.sin(2 * Math.PI * freqHz * tt);
    }
  }

  const data = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i++) {
    const v = Math.max(-1, Math.min(1, buf[i]));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);

  fs.writeFileSync(file, Buffer.concat([header, data]));
}
