import { songFromMidi } from './midiImport';
import type { Song } from './songs';

// Importação pelo YouTube: manda o link para o serviço da VPS (pasta transcriber/),
// acompanha a fila e, quando o MIDI fica pronto, abre com o mesmo importador dos
// arquivos .mid. A janela pode ser fechada no meio: a música entra na lista
// quando terminar.

interface Status {
  id: string;
  estado: 'na_fila' | 'baixando' | 'transcrevendo' | 'pronto' | 'erro';
  titulo: string;
  duracao: number;
  posicao?: number;
  decorrido?: number;
  estimativa?: number;
  erro?: string;
}

const SAVED_KEY = 'pc-youtube';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, init);
  } catch {
    throw new Error('Sem conexão com o servidor de importação.');
  }
  if (!r.ok) {
    const body = await r.json().catch(() => null) as { detail?: string } | null;
    throw new Error(typeof body?.detail === 'string' ? body.detail
      : r.status === 502 || r.status === 404 ? 'O serviço de importação não está no ar agora.'
      : 'O servidor de importação respondeu com erro.');
  }
  return r.json() as Promise<T>;
}

async function fetchSong(id: string, title: string): Promise<Song> {
  const r = await fetch(`/api/importar/${encodeURIComponent(id)}/midi`);
  if (!r.ok) throw new Error('Não consegui baixar a música transcrita.');
  const song = songFromMidi(await r.arrayBuffer(), title);
  song.title = title || song.title;
  // A transcrição sai em segundos, sem andamento de verdade: o MIDI vem com o
  // padrão de 120 BPM, e mostrar esse número seria inventar.
  song.bpm = 0;
  return song;
}

function saved(): { id: string; title: string }[] {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); } catch { return []; }
}
function remember(id: string, title: string) {
  const list = saved().filter(s => s.id !== id);
  list.push({ id, title });
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(list.slice(-20))); } catch { /* sem armazenamento */ }
}

const ESTADOS: Record<Status['estado'], string> = {
  na_fila: 'Na fila',
  baixando: 'Baixando o áudio do vídeo…',
  transcrevendo: 'Transcrevendo as notas…',
  pronto: 'Pronto!',
  erro: 'Não deu certo',
};
const fmtMin = (s: number) => s < 90 ? `${Math.max(1, Math.round(s))} s` : `${Math.round(s / 60)} min`;

export function initYoutubeImport(addSong: (song: Song, open: boolean) => void) {
  const dialog = $<HTMLDialogElement>('ytDialog');
  const form = $<HTMLFormElement>('ytForm');
  const input = $<HTMLInputElement>('ytLink');
  const submit = $<HTMLButtonElement>('ytSubmit');
  const progress = $('ytProgress');
  const state = $('ytState');
  const detail = $('ytDetail');
  const bar = $('ytBar');
  const error = $('ytError');
  let busy = false;

  $('openYoutube').onclick = () => {
    dialog.showModal();
    if (!busy) { error.hidden = true; input.focus(); }
  };
  $('ytCancel').onclick = () => dialog.close();
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });

  function show(s: Status) {
    progress.hidden = false;
    state.textContent = ESTADOS[s.estado];
    let pct = 0, text = s.titulo;
    if (s.estado === 'na_fila') {
      text = s.posicao && s.posicao > 1 ? `Há ${s.posicao - 1} música(s) na sua frente.` : 'Começando…';
    } else if (s.estado === 'baixando') {
      pct = 5;
    } else if (s.estado === 'transcrevendo') {
      const est = Math.max(1, s.estimativa ?? 60), done = s.decorrido ?? 0;
      pct = 10 + 88 * Math.min(1, done / est);
      const left = est - done;
      text = `${s.titulo} · ${left > 0 ? `faltam cerca de ${fmtMin(left)}` : 'quase lá'}`;
    } else if (s.estado === 'pronto') {
      pct = 100;
    }
    detail.textContent = text;
    bar.style.width = pct + '%';
  }

  function fail(msg: string) {
    busy = false;
    submit.disabled = false;
    progress.hidden = true;
    error.textContent = msg;
    error.hidden = false;
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (busy) return;
    busy = true;
    submit.disabled = true;
    error.hidden = true;
    show({ id: '', estado: 'na_fila', titulo: '', duracao: 0, posicao: 1 });
    try {
      let s = await api<Status>('/api/importar', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ link: input.value }),
      });
      while (s.estado !== 'pronto' && s.estado !== 'erro') {
        show(s);
        await new Promise(r => setTimeout(r, 2000));
        s = await api<Status>(`/api/importar/${encodeURIComponent(s.id)}`);
      }
      if (s.estado === 'erro') return fail(s.erro || 'A importação falhou.');
      show(s);
      const song = await fetchSong(s.id, s.titulo);
      remember(s.id, song.title);
      // Se a pessoa fechou a janela e foi tocar outra coisa, só acrescenta à lista.
      addSong(song, dialog.open);
      busy = false;
      submit.disabled = false;
      progress.hidden = true;
      input.value = '';
      dialog.close();
    } catch (err) {
      fail((err as Error).message);
    }
  });

  // Músicas importadas antes voltam para a lista (o MIDI fica guardado no servidor).
  for (const { id, title } of saved()) {
    fetchSong(id, title).then(song => addSong(song, false), () => { /* servidor fora: segue sem ela */ });
  }
}
