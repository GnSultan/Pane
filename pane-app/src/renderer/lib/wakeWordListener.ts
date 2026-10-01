// ============================================================================
// Wake word listener — renderer side of the local keyword spotter.
// ============================================================================
//
// While the voice session is ARMED (parked + listening for its name), this
// module owns a dedicated low-overhead mic path:
//
//   getUserMedia (echoCancellation off, autoGainControl off — raw speech)
//     → AudioWorklet (128-frame taps at ctx rate, linear-resampled to 16k)
//     → postMessage Float32Array (~100ms batches)
//     → electronAPI.send("wake_word_feed", …)  [fire-and-forget]
//
// The main process runs the sherpa-onnx spotter and pushes
// `wake_word_detected` back. The AudioWorklet code is inlined as a Blob URL
// — no static asset file needed.
//
// PRIVACY: the armed mic exists ONLY to feed the local spotter. It is never
// attached to the realtime session (the parked session's track stays
// detached) and never leaves the machine.

export interface WakeWordListener {
  /** Begin listening. Resolves false when the mic is unavailable (caller
   *  falls back to plain standby). */
  start: () => Promise<boolean>;
  /** Stop and release the mic entirely. */
  stop: () => void;
  /** Register the detection callback; returns an unlisten fn. */
  onDetect: (cb: (keyword: string) => void) => () => void;
}

// ── The worklet source ────────────────────────────────────────────────────
// Collects 128-frame input taps, resamples ctxRate→16k linearly, buffers,
// and posts ~100ms chunks. Kept tiny: this runs on the audio thread.
const WORKLET_SRC = `
class WakeWordProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1600); // 100ms @ 16k
    this.fill = 0;
    this.ratio = sampleRate / 16000;
    this.pos = 0; // fractional source position for linear resampling
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    while (this.pos < ch.length) {
      const i = Math.floor(this.pos);
      if (i + 1 >= ch.length) break;
      const frac = this.pos - i;
      const s = ch[i] + (ch[i + 1] - ch[i]) * frac;
      this.buf[this.fill++] = s;
      this.pos += this.ratio;
      if (this.fill === this.buf.length) {
        this.port.postMessage(this.buf.slice(0));
        this.fill = 0;
      }
    }
    this.pos -= ch.length;
    return true;
  }
}
registerProcessor("wake-word-processor", WakeWordProcessor);
`;

export function createWakeWordListener(phrase: string): WakeWordListener {
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let node: AudioWorkletNode | null = null;
  let url: string | null = null;
  let detectCb: ((keyword: string) => void) | null = null;
  let ipcUnlisten: (() => void) | null = null;

  const onMessage = (ev: MessageEvent): void => {
    const samples = ev.data as Float32Array;
    if (samples && samples.length > 0) {
      window.electronAPI.send("wake_word_feed", samples);
    }
  };

  const onIpc = (keyword: string): void => {
    detectCb?.(keyword);
  };

  return {
    async start() {
      if (node) return true; // already running
      try {
        // Configure the spotter for this phrase BEFORE any audio flows.
        const cfg = (await window.electronAPI.invoke("wake_word_configure", {
          phrase,
        })) as { ok: boolean; error?: string };
        if (!cfg.ok) {
          console.warn("[wake-word] configure failed:", cfg.error);
          return false;
        }

        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            // Raw speech for ASR-grade processing — the spotter has its own
            // feature normalization; browser DSP would smear it.
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 1,
          },
        });
        const AC =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        ctx = new AC();
        url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
        await ctx.audioWorklet.addModule(url);
        node = new AudioWorkletNode(ctx, "wake-word-processor");
        node.port.onmessage = onMessage;
        ctx.createMediaStreamSource(stream).connect(node);
        // Worklet with no output destination is fine — process() taps inputs.

        ipcUnlisten = window.electronAPI.on("wake_word_detected", onIpc);
        return true;
      } catch (err) {
        console.warn("[wake-word] start failed:", err);
        this.stop();
        return false;
      }
    },

    stop() {
      ipcUnlisten?.();
      ipcUnlisten = null;
      node?.disconnect();
      node = null;
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      if (url) URL.revokeObjectURL(url);
      url = null;
      ctx?.close().catch(() => undefined);
      ctx = null;
      window.electronAPI.invoke("wake_word_dispose", {}).catch(() => undefined);
    },

    onDetect(cb) {
      detectCb = cb;
      return () => {
        if (detectCb === cb) detectCb = null;
      };
    },
  };
}
