import { api } from './api';

// Importação de áudio: manda o arquivo para o serviço da VPS (pasta transcriber/) e
// acompanha a fila. Quando o MIDI fica pronto, o servidor já guardou a música como sua;
// o jogo só abre. A janela pode ser fechada no meio: a música entra na lista quando terminar.

interface Status {
  id: string;
  estado: 'na_fila' | 'baixando' | 'transcrevendo' | 'pronto' | 'erro';
  titulo: string;
  duracao: number;
  posicao?: number;
  decorrido?: number;
  estimativa?: number;
  erro?: string;
  onde?: 'vps' | 'mac';
  musica?: string | null;   // id da música criada para quem pediu
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const ESTADOS: Record<Status['estado'], string> = {
  na_fila: 'Na fila',
  baixando: 'Preparando o áudio…',
  transcrevendo: 'Transcrevendo as notas…',
  pronto: 'Pronto!',
  erro: 'Não deu certo',
};
const fmtMin = (s: number) => s < 90 ? `${Math.max(1, Math.round(s))} s` : `${Math.round(s / 60)} min`;

/** Liga a janela de importação de áudio; devolve a função que a abre. */
export function initAudioImport(pronta: (musica: string | null, open: boolean) => void): () => void {
  const dialog = $<HTMLDialogElement>('audDialog');
  const fileInput = $<HTMLInputElement>('audFile');
  const fileBtn = $<HTMLLabelElement>('audFileBtn');
  const progress = $('audProgress');
  const state = $('audState');
  const detail = $('audDetail');
  const bar = $('audBar');
  const error = $('audError');
  let busy = false;

  $('audClose').onclick = () => dialog.close();
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
    if (s.onde === 'mac' && (s.estado === 'baixando' || s.estado === 'transcrevendo')) {
      state.textContent = ESTADOS[s.estado].replace('…', ' no seu Mac…');
    }
    detail.textContent = text;
    bar.style.width = pct + '%';
  }

  function setBusy(on: boolean) {
    busy = on;
    fileInput.disabled = on;
    fileBtn.classList.toggle('disabled', on);
  }

  function fail(msg: string) {
    setBusy(false);
    progress.hidden = true;
    error.textContent = msg;
    error.hidden = false;
  }

  async function run(start: () => Promise<Status>) {
    if (busy) return;
    setBusy(true);
    error.hidden = true;
    show({ id: '', estado: 'na_fila', titulo: '', duracao: 0, posicao: 1 });
    try {
      let s = await start();
      while (s.estado !== 'pronto' && s.estado !== 'erro') {
        show(s);
        await new Promise(r => setTimeout(r, 2000));
        s = await api<Status>(`/api/importar/${encodeURIComponent(s.id)}`);
      }
      if (s.estado === 'erro') return fail(s.erro || 'A importação falhou.');
      show(s);
      // Se a pessoa fechou a janela e foi tocar outra coisa, só acrescenta à lista.
      pronta(s.musica ?? null, dialog.open);
      setBusy(false);
      progress.hidden = true;
      dialog.close();
    } catch (err) {
      fail((err as Error).message);
    }
  }

  fileBtn.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    if (file.size > 60 * 1024 * 1024) return fail('O arquivo passa de 60 MB.');
    const body = new FormData();
    body.append('arquivo', file);
    void run(() => api<Status>('/api/enviar', { method: 'POST', body }));
  });

  return () => {
    dialog.showModal();
    if (!busy) { error.hidden = true; fileBtn.focus(); }
  };
}
