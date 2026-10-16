// Desenha a "cascata": pista com as notas caindo, linha vermelha e teclado.
import type { Hand } from './songs';
import type { Player } from './player';

const BLACK = new Set([1, 3, 6, 8, 10]);
const VISIBLE_SECONDS = 3;
const MIN_LABEL = 10;
export const NAMES = {
  en: ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'],
  pt: ['Dó', 'Dó#', 'Ré', 'Ré#', 'Mi', 'Fá', 'Fá#', 'Sol', 'Sol#', 'Lá', 'Lá#', 'Si'],
};
export type NameStyle = keyof typeof NAMES | 'none';

const COLORS: Record<Hand, { fill: string; dark: string; edge: string; text: string; glow: string }> = {
  R: { fill: '#a8ef55', dark: '#5f9a1f', edge: '#d9ffa8', text: '#1b2a08', glow: 'rgba(168,239,85,0.45)' },
  L: { fill: '#82b2f0', dark: '#3f6fb5', edge: '#cfe2ff', text: '#0c1b33', glow: 'rgba(130,178,240,0.45)' },
};

interface Key { midi: number; x: number; w: number; black: boolean }

export interface Pressed { midi: number; kind: 'hit' | 'wrong' | 'free' }

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  W = 0; H = 0; hitY = 0; keyH = 0; pps = 100;
  private dpr = 1;
  private keys: Key[] = [];
  private keyByMidi = new Map<number, Key>();
  private whiteW = 0;
  private lo = 48; private hi = 84;
  names: NameStyle = 'en';
  pcLabels: Map<number, string> | null = null;
  private flashes: { midi: number; until: number; ok: boolean }[] = [];

  constructor(private cv: HTMLCanvasElement) {
    this.ctx = cv.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(cv);
  }

  setRange(midis: number[]) {
    let lo = Math.floor(Math.min(...midis) / 12) * 12;
    let hi = Math.ceil((Math.max(...midis) + 1) / 12) * 12; // termina num Dó, como no vídeo
    while (hi - lo < 36) { if ((hi - lo) % 24 === 12) lo -= 12; else hi += 12; }
    this.lo = Math.max(21, lo); this.hi = Math.min(108, hi);
    this.layoutKeys();
  }

  resize() {
    // Tamanho do layout, não da caixa na tela: com a tela virada por CSS a caixa vem girada.
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = this.cv.clientWidth; this.H = this.cv.clientHeight;
    this.cv.width = Math.round(this.W * this.dpr);
    this.cv.height = Math.round(this.H * this.dpr);
    this.keyH = Math.max(70, Math.min(170, this.W * 0.11, this.H * 0.32));
    this.hitY = this.H - this.keyH;
    this.pps = this.hitY / VISIBLE_SECONDS;
    this.layoutKeys();
  }

  private layoutKeys() {
    this.keys = []; this.keyByMidi.clear();
    const whites: number[] = [];
    for (let m = this.lo; m <= this.hi; m++) if (!BLACK.has(m % 12)) whites.push(m);
    this.whiteW = this.W / whites.length;
    whites.forEach((m, i) => this.addKey({ midi: m, x: i * this.whiteW, w: this.whiteW, black: false }));
    const bw = this.whiteW * 0.6;
    for (let m = this.lo; m <= this.hi; m++) {
      if (!BLACK.has(m % 12)) continue;
      const right = this.keyByMidi.get(m + 1);
      if (right) this.addKey({ midi: m, x: right.x - bw / 2, w: bw, black: true });
    }
  }
  private addKey(k: Key) { this.keys.push(k); this.keyByMidi.set(k.midi, k); }

  keyAt(x: number, y: number): number | null {
    if (y < this.hitY - 2) return null;
    if (y < this.hitY + this.keyH * 0.62) {
      const b = this.keys.find(k => k.black && x >= k.x && x <= k.x + k.w);
      if (b) return b.midi;
    }
    const w = this.keys.find(k => !k.black && x >= k.x && x < k.x + k.w);
    return w ? w.midi : null;
  }

  flash(midi: number, ok: boolean) {
    this.flashes.push({ midi, ok, until: performance.now() + 350 });
  }

  private label(m: number) {
    return this.names === 'none' ? '' : NAMES[this.names][m % 12];
  }

  draw(p: Player, pressed: Map<number, Pressed['kind']>) {
    const { ctx, W, hitY, keyH, pps } = this;
    const s = p.song, t = p.t, now = performance.now();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, this.H);

    // Pista e guias verticais em cada Dó (mais forte) e Fá
    ctx.fillStyle = '#11131b';
    ctx.fillRect(0, 0, W, hitY);
    for (const k of this.keys) {
      const pc = k.midi % 12;
      if (k.black || (pc !== 0 && pc !== 5)) continue;
      ctx.fillStyle = pc === 0 ? '#262b3a' : '#1b1f2b';
      ctx.fillRect(Math.round(k.x), 0, 1, hitY);
    }

    // Compassos
    ctx.font = '600 11px "Nunito Sans", system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    s.bars.forEach((bt, i) => {
      const y = hitY - (bt - t) * pps;
      if (y < -2 || y > hitY) return;
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(0, Math.round(y), W, 1);
      ctx.fillStyle = 'rgba(141,148,168,0.75)';
      ctx.fillText(String(i + 1), 6, y - 3);
    });

    // Trecho A–B
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 1.5;
    for (const [tm, lbl] of [[p.loop.a, 'A'], [p.loop.b, 'B']] as const) {
      if (tm == null) continue;
      const y = hitY - (tm - t) * pps;
      if (y < 0 || y > hitY) continue;
      ctx.strokeStyle = p.loop.on ? 'rgba(255,209,102,0.85)' : 'rgba(255,209,102,0.45)';
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      ctx.fillStyle = '#ffd166';
      ctx.fillText(lbl, W - 16, y - 3);
    }
    ctx.setLineDash([]);

    // Notas
    const active = new Map<number, Hand>();
    const labelSize = Math.max(9, Math.min(17, this.whiteW * 0.55));
    const waitingIds = new Set(p.waiting.map(n => n.id));
    const pulse = 0.5 + 0.5 * Math.sin(now / 140);
    for (const n of s.notes) {
      const start = n.time, end = n.time + n.duration;
      if (start <= t && end > t && (p.mode === 'listen' || !p.practicing(n.hand) || p.hit.has(n.id))) active.set(n.midi, n.hand);
      const yBottom = hitY - (start - t) * pps;
      const yTop = hitY - (end - t) * pps;
      if (yTop > hitY || yBottom < 0) continue;
      const k = this.keyByMidi.get(n.midi);
      if (!k) continue;
      const c = COLORS[n.hand];
      const pad = k.black ? 1 : Math.max(1.5, k.w * 0.1);
      const x = k.x + pad, w = k.w - pad * 2;
      const top = yTop + 1.5, bottom = Math.min(yBottom - 1.5, hitY);
      const h = bottom - top;
      if (h <= 0) continue;
      const mine = p.mode !== 'listen' && p.practicing(n.hand);
      const missed = p.missed.has(n.id);
      ctx.globalAlpha = p.mode !== 'listen' && !mine ? 0.45 : 1;
      ctx.fillStyle = missed ? '#4a4f5e' : k.black ? c.dark : c.fill;
      this.rr(x, top, w, h, Math.min(6, w * 0.3));
      ctx.fill();
      ctx.lineWidth = waitingIds.has(n.id) ? 2.5 : 1;
      ctx.strokeStyle = waitingIds.has(n.id) ? `rgba(255,255,255,${0.5 + 0.5 * pulse})` : c.edge;
      if (!waitingIds.has(n.id)) ctx.globalAlpha *= 0.5;
      ctx.stroke();
      ctx.globalAlpha = p.mode !== 'listen' && !mine ? 0.45 : 1;
      const label = this.label(n.midi);
      if (label && yBottom <= hitY + 1) {
        // Tamanho cheio quando cabe; em nota curta a letra encolhe (até um mínimo
        // legível) e fica centrada na barra, mas aparece sempre.
        const full = h > labelSize + 4;
        const size = full ? labelSize : Math.max(MIN_LABEL, h - 3);
        if (!full && h < size + 3) {
          // Barra mais baixa que a letra: uma etiqueta da mesma cor segura a letra
          const ph = size + 4;
          ctx.fillStyle = missed ? '#4a4f5e' : k.black ? c.dark : c.fill;
          this.rr(x, top + h / 2 - ph / 2, w, ph, Math.min(4, w * 0.3));
          ctx.fill();
        }
        ctx.font = `800 ${size}px "Baloo 2", system-ui, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = full ? 'alphabetic' : 'middle';
        ctx.fillStyle = missed ? '#c9ccd6' : k.black ? '#ffffff' : c.text;
        const fit = Math.min(1, (w - 2) / ctx.measureText(label).width);
        ctx.save(); ctx.translate(x + w / 2, full ? bottom - 4 : top + h / 2 + size * 0.08); ctx.scale(fit, fit);
        ctx.fillText(label, 0, 0);
        ctx.restore();
        ctx.textAlign = 'left';
      }
      ctx.globalAlpha = 1;
    }

    // Brilho na linha de toque
    for (const [m, hand] of active) this.glow(m, COLORS[hand].glow);

    // Teclado
    const blackH = keyH * 0.62;
    this.flashes = this.flashes.filter(f => f.until > now);
    const flashOf = (m: number) => this.flashes.find(f => f.midi === m);
    const keyFill = (m: number, black: boolean) => {
      const hand = active.get(m);
      const press = pressed.get(m);
      const fl = flashOf(m);
      if (press === 'wrong' || (fl && !fl.ok)) return '#ff5d6c';
      if (hand) return black ? COLORS[hand].dark : COLORS[hand].fill;
      if (press) return black ? '#c79a2e' : '#ffd166';
      return null;
    };
    for (const k of this.keys) {
      if (k.black) continue;
      const fill = keyFill(k.midi, false);
      ctx.fillStyle = fill ?? '#f3f1ec';
      this.rr(k.x + 0.5, hitY, k.w - 1, keyH, 4);
      ctx.fill();
      if (!fill) {
        const gr = ctx.createLinearGradient(0, hitY + keyH * 0.7, 0, hitY + keyH);
        gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.08)');
        ctx.fillStyle = gr; ctx.fill();
      }
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      // Letra de cada tecla branca (o Dó leva também a oitava)
      const name = this.names === 'none' ? (k.midi % 12 === 0 ? 'C' : '') : NAMES[this.names][k.midi % 12];
      if (name && (k.midi % 12 === 0 || this.whiteW >= 12)) {
        const txt = k.midi % 12 === 0 ? name + (Math.floor(k.midi / 12) - 1) : name;
        ctx.font = `${k.midi % 12 === 0 ? 700 : 600} ${Math.max(9, Math.min(15, this.whiteW * 0.42))}px "Nunito Sans", system-ui, sans-serif`;
        ctx.fillStyle = fill ? 'rgba(0,0,0,0.55)' : k.midi % 12 === 0 ? '#7d8395' : '#a4a9b6';
        const fit = Math.min(1, (k.w - 3) / ctx.measureText(txt).width);
        ctx.save(); ctx.translate(k.x + k.w / 2, hitY + keyH - 6); ctx.scale(fit, fit);
        ctx.fillText(txt, 0, 0);
        ctx.restore();
      }
      const pc = this.pcLabels?.get(k.midi);
      if (pc && this.whiteW >= 16) {
        ctx.font = `700 ${Math.max(9, Math.min(13, this.whiteW * 0.4))}px "JetBrains Mono", ui-monospace, monospace`;
        ctx.fillStyle = 'rgba(70,76,96,0.9)';
        ctx.fillText(pc, k.x + k.w / 2, hitY + keyH * 0.78);
      }
      ctx.textAlign = 'left';
    }
    for (const k of this.keys) {
      if (!k.black) continue;
      const fill = keyFill(k.midi, true);
      ctx.fillStyle = fill ?? '#16171c';
      this.rr(k.x, hitY - 2, k.w, blackH, 3);
      ctx.fill();
      if (!fill) {
        ctx.fillStyle = '#2c2e36';
        ctx.fillRect(k.x + k.w * 0.18, hitY + blackH - 9, k.w * 0.64, 4);
      }
      const pc = this.pcLabels?.get(k.midi);
      if (pc && this.whiteW >= 16) {
        ctx.font = `700 ${Math.max(8, Math.min(11, this.whiteW * 0.34))}px "JetBrains Mono", ui-monospace, monospace`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillStyle = 'rgba(200,204,216,0.75)';
        ctx.fillText(pc, k.x + k.w / 2, hitY + blackH - 14);
        ctx.textAlign = 'left';
      }
    }

    // Linha de toque
    ctx.fillStyle = '#ff4d5e';
    ctx.shadowColor = 'rgba(255,77,94,0.7)'; ctx.shadowBlur = 8;
    ctx.fillRect(0, hitY - 2, W, 3);
    ctx.shadowBlur = 0;

    // Tonalidade no canto, como no vídeo
    if (s.key) {
      ctx.font = '600 13px "Nunito Sans", system-ui, sans-serif';
      const kw = ctx.measureText(s.key).width + 16;
      ctx.fillStyle = 'rgba(13,15,22,0.8)';
      this.rr(6, hitY - 32, kw, 24, 12); ctx.fill();
      ctx.fillStyle = 'rgba(170,176,194,0.95)';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.key, 14, hitY - 19);
    }

    // Mensagens no centro da pista
    if (p.waiting.length && p.playing) {
      const names = [...new Set(p.waiting.map(n => NAMES[this.names === 'pt' ? 'pt' : 'en'][n.midi % 12]))].join(' + ');
      this.pill(`Toque ${names} para seguir`, hitY * 0.3);
    } else if (t < 0 && !p.playing) {
      this.pill('Aperte ▶ ou Espaço para começar', hitY * 0.62);
    }
  }

  private glow(m: number, color: string) {
    const k = this.keyByMidi.get(m);
    if (!k) return;
    const { ctx, hitY } = this;
    const cx = k.x + k.w / 2;
    const g = ctx.createRadialGradient(cx, hitY, 0, cx, hitY, k.w * 1.6);
    g.addColorStop(0, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.35, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - k.w * 1.6, hitY - k.w * 1.6, k.w * 3.2, k.w * 1.6);
  }

  private pill(msg: string, y: number) {
    const { ctx, W } = this;
    ctx.font = '700 14px "Nunito Sans", system-ui, sans-serif';
    const tw = ctx.measureText(msg).width + 28;
    ctx.fillStyle = 'rgba(13,15,22,0.88)';
    this.rr(W / 2 - tw / 2, y - 17, tw, 34, 17); ctx.fill();
    ctx.strokeStyle = '#262b3a'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = '#eceef4';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(msg, W / 2, y + 1);
    ctx.textAlign = 'left';
  }

  private rr(x: number, y: number, w: number, h: number, r: number) {
    const ctx = this.ctx;
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}
