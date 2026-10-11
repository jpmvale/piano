// Som: amostras reais afinadas no navegador. O piano vem embutido na página (uma
// amostra a cada terça menor); os outros timbres ficam em public/timbres/<id>/ e só
// são baixados quando escolhidos (scripts/make-timbres.sh). Enquanto um timbre
// carrega, segue tocando o anterior; sem amostra nenhuma, usa um som sintetizado.

const sampleUrls = import.meta.glob('./samples/*.mp3', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

const PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** "Ds4" → 63, "A2" → 45 */
function noteNumber(name: string): number | null {
  const m = /^([A-G])(s?)(\d)$/.exec(name);
  return m ? PC[m[1]] + (m[2] ? 1 : 0) + (Number(m[3]) + 1) * 12 : null;
}

export interface Timbre {
  id: string;
  name: string;
  release: number;  // segundos do fim do som depois de soltar a tecla
}

export const TIMBRES: Timbre[] = [
  { id: 'piano', name: 'Piano', release: 0.12 },
  { id: 'violao', name: 'Violão', release: 0.15 },
  { id: 'guitarra', name: 'Guitarra', release: 0.12 },
  { id: 'harpa', name: 'Harpa', release: 0.2 },
  { id: 'xilofone', name: 'Xilofone', release: 0.15 },
  { id: 'orgao', name: 'Órgão', release: 0.05 },
  { id: 'violino', name: 'Violino', release: 0.08 },
  { id: 'violoncelo', name: 'Violoncelo', release: 0.08 },
  { id: 'flauta', name: 'Flauta', release: 0.06 },
  { id: 'eletronico', name: 'Teclado eletrônico', release: 0.12 },
];

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
  private banks = new Map<string, Promise<Map<number, AudioBuffer>>>();
  private live = new Set<{ gain: GainNode; stop: (at: number) => void }>();
  private timbre = TIMBRES[0];
  private wanted = TIMBRES[0];
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
      void this.setTimbre(this.wanted.id);
    }
    if (this.ac.state === 'suspended') void this.ac.resume();
  }

  get timbreId() { return this.wanted.id; }

  /**
   * Troca o timbre. Antes do primeiro clique (sem AudioContext) só guarda a escolha.
   * Resolve com false se as amostras não vieram (o timbre anterior continua).
   */
  async setTimbre(id: string): Promise<boolean> {
    const t = TIMBRES.find(x => x.id === id) ?? TIMBRES[0];
    this.wanted = t;
    if (!this.ac) return true;
    if (t.id === 'eletronico') {
      this.timbre = t;
      this.buffers = new Map();
      document.documentElement.dataset.sound = t.id;
      return true;
    }
    let bank = this.banks.get(t.id);
    if (!bank) {
      bank = this.loadBank(t.id);
      this.banks.set(t.id, bank);
    }
    const buffers = await bank;
    if (this.wanted !== t) return true; // a pessoa já escolheu outro enquanto carregava
    if (buffers.size === 0) {
      this.banks.delete(t.id); // tenta de novo numa próxima escolha
      return false;
    }
    this.timbre = t;
    this.buffers = buffers;
    this.loaded = true;
    document.documentElement.dataset.sound = t.id;
    return true;
  }

  private async loadBank(id: string): Promise<Map<number, AudioBuffer>> {
    const ac = this.ac!;
    const bank = new Map<number, AudioBuffer>();
    let files: [number | null, string][];
    if (id === 'piano') {
      files = Object.entries(sampleUrls).map(([path, url]) => [noteNumber(/([A-Za-z]+\d)\.mp3$/.exec(path)?.[1] ?? ''), url]);
    } else {
      try {
        const names = await (await fetch(`/timbres/${id}/notas.json`)).json() as string[];
        files = names.map(n => [noteNumber(n), `/timbres/${id}/${n}.mp3`]);
      } catch {
        return bank;
      }
    }
    await Promise.all(files.map(async ([midi, url]) => {
      if (midi == null) return;
      try {
        const data = url.startsWith('data:') ? dataUrlToBuffer(url) : await (await fetch(url)).arrayBuffer();
        bank.set(midi, await ac.decodeAudioData(data));
      } catch {
        /* sem essa amostra, a vizinha cobre */
      }
    }));
    return bank;
  }

  /** Toca uma nota. Com `seconds` finito ela é solta sozinha; sem isso, chame release(). */
  play(midi: number, seconds = Infinity, velocity = 0.8): Voice | null {
    const ac = this.ac;
    if (!ac) return null;
    const now = ac.currentTime;
    const gain = ac.createGain();
    gain.connect(this.out);
    let stop: (at: number) => void;
    const rel = this.timbre.release;

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
      gain.gain.setTargetAtTime(0, at, rel);
      stop(at + 0.8);
      setTimeout(() => this.live.delete(voice), (at - ac.currentTime + 0.9) * 1000);
    };
    if (isFinite(seconds)) {
      const at = now + Math.max(0.08, seconds);
      gain.gain.setTargetAtTime(0, at, rel);
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
