// Relógio único da música. Desenho, som e pontuação leem `t` daqui.
import type { Hand, Note, Song } from './songs';

export const LEAD = 2; // segundos de "respiro" antes da primeira nota

export type Mode = 'listen' | 'R' | 'L' | 'both';
export type Judgement = 'hit' | 'wrong' | 'free';

const HIT_WINDOW = 0.25; // segundos reais de tolerância para contar acerto

export class Player {
  song!: Song;
  t = -LEAD;
  playing = false;
  speed = 1;
  mode: Mode = 'listen';
  waitForMe = true;
  loop = { a: null as number | null, b: null as number | null, on: false };

  /** Notas que o modo espera está aguardando (o relógio fica parado). */
  waiting: Note[] = [];
  hit = new Set<number>();
  missed = new Set<number>();
  wrong = 0;

  constructor(private onAutoNote: (n: Note, seconds: number) => void, private onStop: () => void) {}

  get end() { return this.song.duration + 1; }
  get start() { return -LEAD; }

  load(song: Song) {
    this.song = song;
    this.loop = { a: null, b: null, on: false };
    this.stop();
  }

  practicing(hand: Hand) {
    return this.mode === 'both' || this.mode === hand;
  }

  play() {
    if (this.t >= this.end - 0.05) this.seek(this.start);
    this.playing = true;
  }
  pause() {
    this.playing = false;
    this.onStop();
  }
  stop() {
    this.playing = false;
    this.seek(this.start);
    this.wrong = 0;
    this.hit.clear();
    this.missed.clear();
  }

  seek(t: number) {
    this.t = Math.max(this.start, Math.min(this.end, t));
    this.waiting = [];
    // Ao voltar, as notas daqui em diante ficam "novas" de novo.
    for (const n of this.song.notes) {
      if (n.time >= this.t - 1e-6) { this.hit.delete(n.id); this.missed.delete(n.id); }
    }
    this.onStop();
  }

  setLoopPoint(which: 'a' | 'b') {
    const L = this.loop;
    L[which] = Math.max(0, this.t);
    if (L.a != null && L.b != null) {
      if (L.b < L.a) [L.a, L.b] = [L.b, L.a];
      if (L.b - L.a < 0.2) L.b = null;
      else L.on = true;
    }
  }
  clearLoop() {
    this.loop = { a: null, b: null, on: false };
  }

  tick(dt: number) {
    if (!this.playing || this.waiting.length) return;
    const from = this.t;
    let to = from + dt * this.speed;
    const L = this.loop;

    if (L.on && L.a != null && L.b != null && from < L.b && to >= L.b) {
      if (this.advance(from, L.b)) return;
      this.seek(L.a - 0.6); // volta um pouco antes de A para dar tempo de se preparar
      return;
    }
    if (this.advance(from, to)) return;
    if (this.t >= this.end) { this.t = this.end; this.playing = false; this.onStop(); }
  }

  /** Avança o relógio de `from` até `to`. Devolve true se parou para esperar notas. */
  private advance(from: number, to: number): boolean {
    const notes = this.song.notes;

    if (this.waitForMe && this.mode !== 'listen') {
      let stopAt = Infinity;
      for (const n of notes) {
        if (n.time >= from && n.time < to && this.practicing(n.hand) && !this.hit.has(n.id)) { stopAt = n.time; break; }
      }
      if (stopAt < Infinity) {
        this.fire(from, stopAt);
        this.t = stopAt;
        this.waiting = notes.filter(n => Math.abs(n.time - stopAt) < 0.03 && this.practicing(n.hand) && !this.hit.has(n.id));
        return true;
      }
    }
    this.fire(from, to);
    this.t = to;
    if (this.mode !== 'listen' && !this.waitForMe) {
      const late = HIT_WINDOW * this.speed;
      for (const n of notes) {
        if (n.time + late < to && n.time + late >= from && this.practicing(n.hand) && !this.hit.has(n.id)) this.missed.add(n.id);
      }
    }
    return false;
  }

  private fire(from: number, to: number) {
    for (const n of this.song.notes) {
      if (n.time < from || n.time >= to) continue;
      if (this.mode !== 'listen' && this.practicing(n.hand)) continue; // essa parte é sua
      this.onAutoNote(n, (n.duration / this.speed) * 0.95);
    }
  }

  /** Alguém tocou uma tecla (computador, MIDI ou tela). */
  judge(midi: number): Judgement {
    if (this.mode === 'listen') return 'free';
    if (this.waiting.length) {
      const n = this.waiting.find(w => w.midi === midi && !this.hit.has(w.id));
      if (!n) { this.wrong++; return 'wrong'; }
      this.hit.add(n.id);
      this.waiting = this.waiting.filter(w => !this.hit.has(w.id));
      return 'hit';
    }
    if (!this.playing) return 'free';
    // No modo espera dá para tocar um pouco antes da nota chegar.
    const late = HIT_WINDOW * this.speed;
    const early = (this.waitForMe ? 0.6 : HIT_WINDOW) * this.speed;
    let best: Note | null = null;
    for (const n of this.song.notes) {
      if (n.midi !== midi || !this.practicing(n.hand) || this.hit.has(n.id)) continue;
      if (n.time - this.t <= early && this.t - n.time <= late && (!best || Math.abs(n.time - this.t) < Math.abs(best.time - this.t))) best = n;
    }
    if (!best) { this.wrong++; return 'wrong'; }
    this.hit.add(best.id);
    this.missed.delete(best.id);
    return 'hit';
  }

  barIndex(): number {
    const bars = this.song.bars;
    if (this.t < bars[0] - 1e-6) return 0;
    let i = 0;
    while (i + 1 < bars.length && bars[i + 1] <= this.t + 1e-6) i++;
    return i + 1;
  }

  stepBar(dir: -1 | 1) {
    const stops = [this.start, ...this.song.bars];
    const target = dir < 0
      ? [...stops].reverse().find(x => x < this.t - 0.25) ?? this.start
      : stops.find(x => x > this.t + 0.01) ?? this.end;
    this.seek(target);
  }
}
