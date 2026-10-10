import { Midi } from '@tonejs/midi';
import { newNoteId, type Hand, type Note, type Song } from './songs';

// Lê um arquivo .mid e converte para o formato interno.
// Mãos: com duas ou mais faixas com notas, a 1ª é a direita e a 2ª a esquerda
// (o padrão de quase todo MIDI de piano). Com uma faixa só, divide no Dó central.
export async function songFromMidiFile(file: File): Promise<Song> {
  const midi = new Midi(await file.arrayBuffer());
  const tracks = midi.tracks.filter(t => t.notes.length > 0);
  if (tracks.length === 0) throw new Error('Esse arquivo MIDI não tem notas.');

  const notes: Note[] = [];
  if (tracks.length === 1) {
    for (const n of tracks[0].notes) push(n, n.midi >= 60 ? 'R' : 'L');
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
    title: (midi.name || file.name.replace(/\.midi?$/i, '')).trim() || 'Arquivo MIDI',
    key: '',
    bpm,
    beatsPerBar: ts[0],
    notes,
    bars,
    duration,
  };
}
