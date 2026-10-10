// Formato interno das músicas, compatível com a saída do @tonejs/midi:
// cada nota tem midi, time e duration em segundos, mais a mão (R = direita, L = esquerda).

export type Hand = 'R' | 'L';

export interface Note {
  id: number;
  midi: number;
  time: number;      // segundos desde o início da música
  duration: number;  // segundos
  hand: Hand;
}

export interface Song {
  title: string;
  key: string;           // tonalidade, mostrada no canto como no PHianonize
  bpm: number;
  beatsPerBar: number;
  notes: Note[];
  bars: number[];        // início de cada compasso, em segundos
  duration: number;      // fim da última nota, em segundos
}

// Músicas escritas à mão: "NOTA:tempos", R = pausa, "|" só separa compassos.
interface SongText {
  title: string;
  key: string;
  bpm: number;
  beatsPerBar: number;
  pickup: number;  // tempos de anacruse antes do primeiro compasso
  rh: string;
  lh: string;
}

const TEXT_SONGS: SongText[] = [
  {
    title: 'Brilha, Brilha Estrelinha', key: 'Dó maior', bpm: 92, beatsPerBar: 4, pickup: 0,
    rh: `C4 C4 G4 G4 | A4 A4 G4:2 | F4 F4 E4 E4 | D4 D4 C4:2 |
         G4 G4 F4 F4 | E4 E4 D4:2 | G4 G4 F4 F4 | E4 E4 D4:2 |
         C4 C4 G4 G4 | A4 A4 G4:2 | F4 F4 E4 E4 | D4 D4 C4:2`,
    lh: `C3:4 | F3:2 C3:2 | F3:2 C3:2 | G3:2 C3:2 |
         C3:2 F3:2 | C3:2 G3:2 | C3:2 F3:2 | C3:2 G3:2 |
         C3:4 | F3:2 C3:2 | F3:2 C3:2 | G3:2 C3:2`,
  },
  {
    title: 'Parabéns pra Você', key: 'Dó maior', bpm: 108, beatsPerBar: 3, pickup: 1,
    rh: `G4:.75 G4:.25 | A4 G4 C5 | B4:2 G4:.75 G4:.25 | A4 G4 D5 | C5:2 G4:.75 G4:.25 |
         G5 E5 C5 | B4 A4 F5:.75 F5:.25 | E5 C5 D5 | C5:3`,
    lh: `R:1 | C3:3 | G2:3 | G2:3 | C3:3 | C3:3 | F2:3 | C3:2 G2:1 | C3:3`,
  },
  {
    title: 'Ode à Alegria', key: 'Dó maior', bpm: 100, beatsPerBar: 4, pickup: 0,
    rh: `E4 E4 F4 G4 | G4 F4 E4 D4 | C4 C4 D4 E4 | E4:1.5 D4:.5 D4:2 |
         E4 E4 F4 G4 | G4 F4 E4 D4 | C4 C4 D4 E4 | D4:1.5 C4:.5 C4:2 |
         D4 D4 E4 C4 | D4 E4:.5 F4:.5 E4 C4 | D4 E4:.5 F4:.5 E4 D4 | C4 D4 G3:2 |
         E4 E4 F4 G4 | G4 F4 E4 D4 | C4 C4 D4 E4 | D4:1.5 C4:.5 C4:2`,
    lh: `C3:4 | G2:4 | C3:4 | G2:4 | C3:4 | G2:4 | C3:4 | G2:2 C3:2 |
         G2:4 | G2:2 C3:2 | G2:4 | C3:2 G2:2 | C3:4 | G2:4 | C3:4 | G2:2 C3:2`,
  },
  {
    // Arranjo fácil próprio (a composição de Pachelbel é de domínio público).
    title: 'Cânone em Ré (fácil)', key: 'Ré maior', bpm: 72, beatsPerBar: 4, pickup: 0,
    rh: `R:16 |
         F#5:2 E5:2 | D5:2 C#5:2 | B4:2 A4:2 | B4:2 C#5:2 |
         D5:2 C#5:2 | B4:2 A4:2 | G4:2 F#4:2 | G4:2 E4:2 |
         D4 F#4 A4 G4 | F#4 D4 F#4 E4 | D4 B3 D4 A4 | G4 B4 A4 G4 |
         F#4:4`,
    lh: `D3:2 A2:2 | B2:2 F#2:2 | G2:2 D2:2 | G2:2 A2:2 |
         D3:2 A2:2 | B2:2 F#2:2 | G2:2 D2:2 | G2:2 A2:2 |
         D3:2 A2:2 | B2:2 F#2:2 | G2:2 D2:2 | G2:2 A2:2 |
         D3:2 A2:2 | B2:2 F#2:2 | G2:2 D2:2 | G2:2 A2:2 |
         D3:4`,
  },
];

let nextId = 1;

export function parseNoteName(s: string): number {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(s);
  if (!m) throw new Error('Nota inválida: ' + s);
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1] as 'C'];
  return base + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) + 1) * 12;
}

function parseLine(str: string, hand: Hand, spb: number) {
  const notes: Note[] = [];
  let beat = 0;
  for (const tok of str.trim().split(/\s+/)) {
    if (tok === '|') continue;
    const [n, d] = tok.split(':');
    const dur = d ? parseFloat(d) : 1;
    if (n !== 'R') notes.push({ id: nextId++, midi: parseNoteName(n), time: beat * spb, duration: dur * spb, hand });
    beat += dur;
  }
  return { notes, beats: beat };
}

function fromText(def: SongText): Song {
  const spb = 60 / def.bpm;
  const r = parseLine(def.rh, 'R', spb);
  const l = parseLine(def.lh, 'L', spb);
  const totalBeats = Math.max(r.beats, l.beats);
  const bars: number[] = [];
  for (let b = def.pickup; b < totalBeats - 1e-6; b += def.beatsPerBar) bars.push(b * spb);
  return {
    title: def.title, key: def.key, bpm: def.bpm, beatsPerBar: def.beatsPerBar,
    notes: [...r.notes, ...l.notes].sort((a, b) => a.time - b.time || a.midi - b.midi),
    bars,
    duration: totalBeats * spb,
  };
}

export const BUILTIN_SONGS: Song[] = TEXT_SONGS.map(fromText);

export function newNoteId() {
  return nextId++;
}
