import { Midi } from '@tonejs/midi';
import { newNoteId, type Hand, type Note, type Song } from './songs';

// Lê um arquivo .mid e converte para o formato interno.
// Mãos: com duas ou mais faixas com notas, a 1ª é a direita e a 2ª a esquerda
// (o padrão de quase todo MIDI de piano). Com uma faixa só (é o caso das músicas
// transcritas do YouTube), as mãos são separadas por splitHands.
export async function songFromMidiFile(file: File): Promise<Song> {
  return songFromMidi(await file.arrayBuffer(), file.name.replace(/\.midi?$/i, ''));
}

export function songFromMidi(data: ArrayBuffer, fallbackTitle: string): Song {
  const midi = new Midi(data);
  const tracks = midi.tracks.filter(t => t.notes.length > 0);
  if (tracks.length === 0) throw new Error('Esse arquivo MIDI não tem notas.');

  const notes: Note[] = [];
  if (tracks.length === 1) {
    const hands = splitHands(tracks[0].notes);
    tracks[0].notes.forEach((n, i) => push(n, hands[i]));
  } else {
    // Se a "segunda" faixa for mais aguda, ela é a mão direita.
    const avg = (t: (typeof tracks)[number]) => t.notes.reduce((s, n) => s + n.midi, 0) / t.notes.length;
    const [a, b] = avg(tracks[0]) >= avg(tracks[1]) ? [tracks[0], tracks[1]] : [tracks[1], tracks[0]];
    for (const n of a.notes) push(n, 'R');
    for (const n of b.notes) push(n, 'L');
    for (const t of tracks.slice(2)) for (const n of t.notes) push(n, n.midi >= 60 ? 'R' : 'L');
  }
  function push(n: { midi: number; time: number; duration: number }, hand: Hand) {
    notes.push({ id: newNoteId(), midi: n.midi, time: n.time, duration: Math.max(0.05, n.duration), hand });
  }
  notes.sort((x, y) => x.time - y.time || x.midi - y.midi);

  const ts = midi.header.timeSignatures[0]?.timeSignature ?? [4, 4];
  const bpm = Math.round(midi.header.tempos[0]?.bpm ?? 120);
  const barTicks = midi.header.ppq * 4 * (ts[0] / ts[1]);

  // Começa no compasso da primeira nota, para não ficar esperando um silêncio inicial.
  const firstBar = Math.floor(midi.header.secondsToTicks(notes[0].time) / barTicks) * barTicks;
  const offset = midi.header.ticksToSeconds(firstBar);
  for (const n of notes) n.time -= offset;
  const duration = Math.max(...notes.map(n => n.time + n.duration));

  const bars: number[] = [];
  for (let tick = firstBar; ; tick += barTicks) {
    const sec = midi.header.ticksToSeconds(tick) - offset;
    if (sec > duration - 1e-3) break;
    if (sec > -1e-3) bars.push(Math.max(0, sec));
    if (bars.length > 2000) break;
  }
  if (bars.length === 0) bars.push(0);

  return {
    title: (midi.name || fallbackTitle).trim() || 'Arquivo MIDI',
    key: '',
    bpm,
    beatsPerBar: ts[0],
    notes,
    bars,
    duration,
  };
}

// Separa as mãos de uma faixa única de piano.
// Dividir sempre no Dó central erra muito: a mão direita desce abaixo dele e a
// esquerda sobe, conforme a música. Aqui cada mão tem um "centro" que segue as
// notas que ela tocou por último. Notas que começam juntas formam um acorde, e o
// acorde é cortado no ponto que deixa cada parte mais perto do centro da sua mão,
// sem que uma mão abra mais que uma décima.
export function splitHands(notes: readonly { midi: number; time: number }[]): Hand[] {
  const order = notes.map((_, i) => i).sort((a, b) => notes[a].time - notes[b].time || notes[a].midi - notes[b].midi);
  const hands: Hand[] = new Array(notes.length);
  let left = 48, right = 67;   // Dó 3 e Sol 4: onde as mãos costumam começar
  const SPAN = 16, FOLLOW = 0.35;

  for (let i = 0; i < order.length;) {
    // Acorde: tudo que começa até 40 ms depois da primeira nota
    let j = i + 1;
    while (j < order.length && notes[order[j]].time - notes[order[i]].time < 0.04) j++;
    const chord = order.slice(i, j).sort((a, b) => notes[a].midi - notes[b].midi);
    const pitch = chord.map(k => notes[k].midi);

    // cut = quantas notas (das mais graves) vão para a esquerda
    let best = -1, bestCost = Infinity;
    for (let cut = 0; cut <= chord.length; cut++) {
      const lo = pitch.slice(0, cut), hi = pitch.slice(cut);
      if (lo.length && lo[lo.length - 1] - lo[0] > SPAN) continue;
      if (hi.length && hi[hi.length - 1] - hi[0] > SPAN) continue;
      let cost = 0;
      for (const p of lo) cost += Math.abs(p - left);
      for (const p of hi) cost += Math.abs(p - right);
      if (cost < bestCost) { bestCost = cost; best = cut; }
    }
    // Acorde largo demais para duas mãos (pedal, arpejo rápido): volta ao meio
    if (best < 0) {
      const mid = (left + right) / 2;
      best = pitch.filter(p => p < mid).length;
    }

    chord.forEach((k, idx) => { hands[k] = idx < best ? 'L' : 'R'; });
    const lo = pitch.slice(0, best), hi = pitch.slice(best);
    if (lo.length) left += (lo.reduce((s, p) => s + p, 0) / lo.length - left) * FOLLOW;
    if (hi.length) right += (hi.reduce((s, p) => s + p, 0) / hi.length - right) * FOLLOW;
    // As mãos não trocam de lugar
    if (right - left < 5) { const m = (left + right) / 2; left = m - 2.5; right = m + 2.5; }
    i = j;
  }
  return hands;
}
