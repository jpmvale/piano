// Entrada de notas: teclado do computador (layout de "tracker", duas fileiras)
// e teclado MIDI de verdade pela Web MIDI, quando o navegador permite.

export type NoteHandler = (midi: number, on: boolean, velocity: number) => void;

// Posição em semitons a partir da nota base. Fileira de baixo: Z S X D C V G B H N J M , . ;
// fileira de cima começa uma oitava acima: Q 2 W 3 E R 5 T 6 Y 7 U I 9 O 0 P.
const CODE_TO_STEP: Record<string, number> = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11,
  Comma: 12, KeyL: 13, Period: 14, Semicolon: 15, Slash: 16,
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18, KeyT: 19, Digit6: 20,
  KeyY: 21, Digit7: 22, KeyU: 23, KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27, KeyP: 28,
};
const CODE_LABEL: Record<string, string> = {
  Comma: ',', Period: '.', Semicolon: ';', Slash: '/',
};

export class ComputerKeyboard {
  base = 48; // C3
  private down = new Map<string, number>();

  constructor(private onNote: NoteHandler) {
    window.addEventListener('keydown', e => this.key(e, true));
    window.addEventListener('keyup', e => this.key(e, false));
    window.addEventListener('blur', () => this.releaseAll());
  }

  /** Rótulo da tecla do computador para cada nota (o primeiro que aparece, priorizando a fileira de cima). */
  labels(): Map<number, string> {
    const out = new Map<number, string>();
    const codes = Object.keys(CODE_TO_STEP).sort((a, b) => (isUpper(b) ? 1 : 0) - (isUpper(a) ? 1 : 0));
    for (const code of codes) {
      const midi = this.base + CODE_TO_STEP[code];
      if (!out.has(midi)) out.set(midi, CODE_LABEL[code] ?? code.replace(/^Key|^Digit/, ''));
    }
    return out;
  }

  releaseAll() {
    for (const midi of this.down.values()) this.onNote(midi, false, 0);
    this.down.clear();
  }

  private key(e: KeyboardEvent, on: boolean) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement).closest?.('input, select, textarea, dialog')) return;
    const step = CODE_TO_STEP[e.code];
    if (step === undefined) return;
    e.preventDefault();
    if (on) {
      if (e.repeat || this.down.has(e.code)) return;
      const midi = this.base + step;
      this.down.set(e.code, midi);
      this.onNote(midi, true, 0.8);
    } else {
      const midi = this.down.get(e.code);
      if (midi === undefined) return;
      this.down.delete(e.code);
      this.onNote(midi, false, 0);
    }
  }
}

function isUpper(code: string) {
  return CODE_TO_STEP[code] >= 12 && !['Comma', 'KeyL', 'Period', 'Semicolon', 'Slash'].includes(code);
}

export type MidiStatus =
  | { state: 'unsupported' }
  | { state: 'denied'; message: string }
  | { state: 'ready'; inputs: string[] };

/** Pede acesso ao teclado MIDI. Chamar a partir de um clique. */
export async function connectMidi(onNote: NoteHandler, onStatus: (s: MidiStatus) => void) {
  if (!('requestMIDIAccess' in navigator)) {
    onStatus({ state: 'unsupported' });
    return;
  }
  try {
    const access = await navigator.requestMIDIAccess();
    const wire = () => {
      const names: string[] = [];
      access.inputs.forEach(input => {
        names.push(input.name || 'Teclado MIDI');
        input.onmidimessage = (ev: MIDIMessageEvent) => {
          const d = ev.data;
          if (!d || d.length < 3) return;
          const cmd = d[0] & 0xf0;
          if (cmd === 0x90 && d[2] > 0) onNote(d[1], true, d[2] / 127);
          else if (cmd === 0x80 || (cmd === 0x90 && d[2] === 0)) onNote(d[1], false, 0);
        };
      });
      onStatus({ state: 'ready', inputs: names });
    };
    access.onstatechange = wire;
    wire();
  } catch (err) {
    onStatus({ state: 'denied', message: (err as Error).message || String(err) });
  }
}
