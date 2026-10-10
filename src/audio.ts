// Som do piano: amostras reais embutidas na página (uma a cada terça menor,
// afinadas no navegador). Enquanto carregam, usa um timbre sintetizado.

const sampleUrls = import.meta.glob('./samples/*.mp3', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

const PC: Record<string, number> = { C: 0, Ds: 3, Fs: 6, A: 9 };

// A página publicada não pode fazer fetch de data: URLs, então decodifica direto.
function dataUrlToBuffer(url: string): ArrayBuffer {
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export interface Voice {
  release(): void;
}

export class Piano {
  private ac: AudioContext | null = null;
  private out!: GainNode;
  private buffers = new Map<number, AudioBuffer>();
  private live = new Set<{ gain: GainNode; stop: (at: number) => void }>();
  loaded = false;

  /** Precisa ser chamado a partir de um clique ou tecla (regra dos navegadores). */
  unlock() {
    if (!this.ac) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ac = new Ctx();
      const comp = this.ac.createDynamicsCompressor();
      comp.threshold.value = -14;
      this.out = this.ac.createGain();
      this.out.gain.value = 0.8;
      this.out.connect(comp).connect(this.ac.destination);
      void this.loadSamples();
    }
    if (this.ac.state === 'suspended') void this.ac.resume();
  }

  private async loadSamples() {
    const ac = this.ac!;
    await Promise.all(Object.entries(sampleUrls).map(async ([path, url]) => {
      const m = /([A-Za-z]+)(\d)\.mp3$/.exec(path);
      if (!m) return;
      const midi = PC[m[1]] + (Number(m[2]) + 1) * 12;
      try {
        const data = url.startsWith('data:') ? dataUrlToBuffer(url) : await (await fetch(url)).arrayBuffer();
        this.buffers.set(midi, await ac.decodeAudioData(data));
      } catch {
        /* sem essa amostra, a vizinha cobre */
      }
    }));
    this.loaded = this.buffers.size > 0;
    document.documentElement.dataset.sound = this.loaded ? 'piano' : 'synth';
  }

  /** Toca uma nota. Com `seconds` finito ela é solta sozinha; sem isso, chame release(). */
  play(midi: number, seconds = Infinity, velocity = 0.8): Voice | null {
    const ac = this.ac;
    if (!ac) return null;
    const now = ac.currentTime;
    const gain = ac.createGain();
    gain.connect(this.out);
    let stop: (at: number) => void;

    const nearest = this.nearestSample(midi);
    if (nearest) {
      const src = ac.createBufferSource();
      src.buffer = nearest.buffer;
      src.playbackRate.value = Math.pow(2, (midi - nearest.midi) / 12);
      src.connect(gain);
      gain.gain.setValueAtTime(velocity, now);
      src.start(now);
      stop = at => { try { src.stop(at); } catch { /* já parou */ } };
    } else {
      stop = this.synth(ac, midi, gain, now, velocity);
    }

    const voice = { gain, stop };
    this.live.add(voice);
    const release = (at = ac.currentTime) => {
      if (!this.live.has(voice)) return;
      gain.gain.cancelScheduledValues(at);
      gain.gain.setValueAtTime(gain.gain.value, at);
      gain.gain.setTargetAtTime(0, at, 0.12);
      stop(at + 0.8);
      setTimeout(() => this.live.delete(voice), (at - ac.currentTime + 0.9) * 1000);
    };
    if (isFinite(seconds)) {
      const at = now + Math.max(0.08, seconds);
      gain.gain.setTargetAtTime(0, at, 0.12);
      stop(at + 0.8);
      setTimeout(() => this.live.delete(voice), (at - now + 0.9) * 1000);
    }
    return { release: () => release() };
  }

  stopAll() {
    if (!this.ac) return;
    const now = this.ac.currentTime;
    for (const v of this.live) {
      v.gain.gain.cancelScheduledValues(now);
      v.gain.gain.setValueAtTime(v.gain.gain.value, now);
      v.gain.gain.setTargetAtTime(0, now, 0.03);
      v.stop(now + 0.2);
    }
    this.live.clear();
  }

  private nearestSample(midi: number) {
    let best: { midi: number; buffer: AudioBuffer } | null = null;
    for (const [m, buffer] of this.buffers) {
      if (!best || Math.abs(m - midi) < Math.abs(best.midi - midi)) best = { midi: m, buffer };
    }
    return best;
  }

  private synth(ac: AudioContext, midi: number, gain: GainNode, now: number, velocity: number) {
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(9000, f * 10), now);
    lp.frequency.exponentialRampToValueAtTime(Math.max(f * 2.5, 400), now + 1.5);
    const o1 = ac.createOscillator(); o1.type = 'triangle'; o1.frequency.value = f;
    const o2 = ac.createOscillator(); o2.type = 'sine'; o2.frequency.value = f * 2;
    const g2 = ac.createGain(); g2.gain.value = 0.22;
    o1.connect(lp); o2.connect(g2).connect(lp); lp.connect(gain);
    const peak = 0.4 * velocity;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(peak, now + 0.006);
    gain.gain.setTargetAtTime(peak * 0.25, now + 0.006, 0.45);
    o1.start(now); o2.start(now);
    return (at: number) => { for (const o of [o1, o2]) { try { o.stop(at); } catch { /* já parou */ } } };
  }
}
