// Record from the browser mic (Obsidian desktop; Electron exposes the
// Web Audio API), resample to 16 kHz mono 16-bit PCM, and emit a WAV
// ArrayBuffer ready for POSTing to whisper.cpp or Gemma.
//
// Push-to-talk and toggle both drive the same AudioCapture instance:
//   const cap = new AudioCapture();
//   await cap.start();          // user holds mic / clicks toggle
//   const wav = await cap.stop();  // on release / toggle again
//
// No ffmpeg; all resampling runs through OfflineAudioContext.

const TARGET_SAMPLE_RATE = 16000;

export class AudioCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private chunks: Float32Array[] = [];
  private sourceSampleRate = 0;

  async start(): Promise<void> {
    if (this.stream) throw new Error("AudioCapture: already recording");
    this.chunks = [];
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.context = new AudioContext();
    this.sourceSampleRate = this.context.sampleRate;
    this.source = this.context.createMediaStreamSource(this.stream);
    // ScriptProcessorNode is deprecated but still shipped in Electron
    // and is the simplest reliable path. 4096 keeps latency ≈ 90 ms.
    this.processor = this.context.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (ev) => {
      const input = ev.inputBuffer.getChannelData(0);
      // Copy — the input buffer is reused.
      this.chunks.push(new Float32Array(input));
    };
    this.source.connect(this.processor);
    this.processor.connect(this.context.destination);
  }

  async stop(): Promise<ArrayBuffer> {
    if (!this.stream || !this.context || !this.processor || !this.source) {
      throw new Error("AudioCapture: not recording");
    }
    this.processor.disconnect();
    this.source.disconnect();
    this.stream.getTracks().forEach((t) => t.stop());
    const srcRate = this.sourceSampleRate;
    const flat = concat(this.chunks);
    await this.context.close();
    this.stream = null;
    this.context = null;
    this.processor = null;
    this.source = null;
    this.chunks = [];

    const resampled = srcRate === TARGET_SAMPLE_RATE
      ? flat
      : await resampleFloat32(flat, srcRate, TARGET_SAMPLE_RATE);
    const pcm16 = floatToPcm16(resampled);
    return buildWav(pcm16, TARGET_SAMPLE_RATE);
  }

  get isRecording(): boolean {
    return this.stream !== null;
  }
}

function concat(chunks: Float32Array[]): Float32Array {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Float32Array(n);
  let i = 0;
  for (const c of chunks) {
    out.set(c, i);
    i += c.length;
  }
  return out;
}

async function resampleFloat32(
  input: Float32Array,
  srcRate: number,
  dstRate: number,
): Promise<Float32Array> {
  if (input.length === 0) return input;
  const ratio = dstRate / srcRate;
  const outLen = Math.max(1, Math.round(input.length * ratio));
  const ctx = new OfflineAudioContext(1, outLen, dstRate);
  const srcBuffer = new AudioContext().createBuffer(1, input.length, srcRate);
  // Copy explicitly rather than passing `input` — avoids the TS
  // ArrayBuffer-vs-ArrayBufferLike mismatch between the Web Audio
  // type and typed-array types.
  srcBuffer.getChannelData(0).set(input);
  const node = ctx.createBufferSource();
  node.buffer = srcBuffer;
  node.connect(ctx.destination);
  node.start(0);
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0).slice();
}

function floatToPcm16(f32: Float32Array): Int16Array {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function buildWav(pcm16: Int16Array, sampleRate: number): ArrayBuffer {
  const bytesPerSample = 2;
  const numChannels = 1;
  const dataSize = pcm16.length * bytesPerSample;
  const header = 44;
  const buf = new ArrayBuffer(header + dataSize);
  const view = new DataView(buf);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);       // Subchunk1Size
  view.setUint16(20, 1, true);         // AudioFormat PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < pcm16.length; i++, offset += 2) {
    view.setInt16(offset, pcm16[i], true);
  }
  return buf;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}
