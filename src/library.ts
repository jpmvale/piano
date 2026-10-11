import { api, json } from './api';

// Tela de escolha de músicas: lista do servidor com a dificuldade de 0 a 10,
// busca, ordem e filtro. Admin renomeia e apaga qualquer uma; quem enviou apaga a sua.

export interface Musica {
  id: string;
  titulo: string;
  origem: 'casa' | 'midi' | 'audio';
  dono: { id: number; nome: string } | null;
  minha: boolean;
  notas: number;
  duracao: number;
  notas_por_minuto: number;
  dificuldade: number;
  pode_renomear: boolean;
  pode_apagar: boolean;
}

type Ordem = 'facil' | 'dificil' | 'nome' | 'recentes';
type Filtro = 'todas' | 'casa' | 'minhas';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (s: number) => Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0');
const sem = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const NIVEL = (n: number) => n <= 2 ? 'Bem fácil' : n <= 4 ? 'Fácil' : n <= 6 ? 'Médio' : n <= 8 ? 'Difícil' : 'Muito difícil';

function origem(m: Musica): string {
  if (m.origem === 'casa') return 'Da casa';
  const como = m.origem === 'midi' ? 'MIDI' : 'áudio';
  if (m.minha) return `Sua (${como})`;
  return m.dono ? `De ${m.dono.nome} (${como})` : `Importada (${como})`;
}

export interface Biblioteca {
  abrir(): void;
  atualizar(): Promise<Musica[]>;
  musicas(): Musica[];
  marcarAtual(id: string | undefined): void;
}

export function initLibrary(opts: {
  tocar: (m: Musica) => void;
  apagada: (id: string) => void;
  renomeada: (m: Musica) => void;
}): Biblioteca {
  const dialog = $<HTMLDialogElement>('libDialog');
  const lista = $('libLista'), vazio = $('libVazio'), erro = $('libErro');
  const busca = $<HTMLInputElement>('libBusca'), ordemSel = $<HTMLSelectElement>('libOrdem');
  let musicas: Musica[] = [];
  let atual: string | undefined;
  let filtro: Filtro = 'todas';

  try {
    const o = localStorage.getItem('pc-ordem');
    if (o) ordemSel.value = o;
  } catch { /* sem armazenamento */ }

  $('libFechar').onclick = () => dialog.close();
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
  busca.oninput = () => desenhar();
  ordemSel.onchange = () => {
    desenhar();
    try { localStorage.setItem('pc-ordem', ordemSel.value); } catch { /* sem armazenamento */ }
  };
  document.querySelectorAll<HTMLButtonElement>('#libFiltro button').forEach(b => {
    b.onclick = () => {
      filtro = b.dataset.filtro as Filtro;
      document.querySelectorAll('#libFiltro button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      desenhar();
    };
  });

  function falhar(msg: string) {
    erro.textContent = msg;
    erro.hidden = false;
  }

  function visiveis(): Musica[] {
    const q = sem(busca.value.trim());
    const ms = musicas.filter(m =>
      (filtro === 'todas' || (filtro === 'casa' ? m.origem === 'casa' : m.minha))
      && (!q || sem(m.titulo).includes(q) || sem(m.dono?.nome ?? '').includes(q)));
    const porNome = (a: Musica, b: Musica) => a.titulo.localeCompare(b.titulo, 'pt-BR');
    const ordem = ordemSel.value as Ordem;
    const idx = new Map(musicas.map((m, i) => [m.id, i]));
    return ms.sort(
      ordem === 'facil' ? (a, b) => a.dificuldade - b.dificuldade || a.notas_por_minuto - b.notas_por_minuto || porNome(a, b)
      : ordem === 'dificil' ? (a, b) => b.dificuldade - a.dificuldade || b.notas_por_minuto - a.notas_por_minuto || porNome(a, b)
      : ordem === 'nome' ? porNome
      : (a, b) => idx.get(b.id)! - idx.get(a.id)!);
  }

  function cartao(m: Musica): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'cartao';
    li.style.setProperty('--n', String(m.dificuldade));
    if (m.id === atual) li.classList.add('atual');
    li.innerHTML = `
      <button class="cartao-tocar">
        <span class="nivel" aria-hidden="true"><b></b><small>/10</small></span>
        <span class="info"><b class="titulo"></b><span class="sub"></span></span>
        <span class="barras" aria-hidden="true">${'<i></i>'.repeat(10)}</span>
      </button>
      <div class="cartao-acoes"></div>`;
    li.querySelector('.nivel b')!.textContent = String(m.dificuldade);
    li.querySelector('.titulo')!.textContent = m.titulo;
    li.querySelector('.sub')!.textContent =
      `${origem(m)} · ${fmt(m.duracao)} · ${m.notas_por_minuto} notas/min · ${NIVEL(m.dificuldade)}`;
    li.querySelectorAll('.barras i').forEach((i, k) => i.classList.toggle('on', k < m.dificuldade));
    const tocar = li.querySelector<HTMLButtonElement>('.cartao-tocar')!;
    tocar.setAttribute('aria-label', `${m.titulo}, dificuldade ${m.dificuldade} de 10, ${origem(m)}`);
    tocar.onclick = () => { dialog.close(); opts.tocar(m); };

    const acoes = li.querySelector('.cartao-acoes')!;
    if (m.pode_renomear) {
      const b = botao('Renomear', '<path d="M4 17.2V20h2.8l8.3-8.3-2.8-2.8zM19.7 7.3a1 1 0 0 0 0-1.4l-1.6-1.6a1 1 0 0 0-1.4 0l-1.3 1.3 2.8 2.8z"/>');
      b.onclick = () => renomear(li, m);
      acoes.append(b);
    }
    if (m.pode_apagar) {
      const b = botao('Apagar', '<path d="M9 3h6l1 2h4v2H4V5h4zM6 9h12l-1 12H7z"/>');
      b.classList.add('perigo');
      b.onclick = () => void apagar(m);
      acoes.append(b);
    }
    return li;
  }

  function botao(rotulo: string, svg: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'btn ghost';
    b.title = rotulo;
    b.setAttribute('aria-label', rotulo);
    b.innerHTML = `<svg viewBox="0 0 24 24">${svg}</svg>`;
    return b;
  }

  function renomear(li: HTMLLIElement, m: Musica) {
    const form = document.createElement('form');
    form.className = 'renomear';
    form.innerHTML = '<input maxlength="120" required aria-label="Novo nome"><button class="btn primary">Salvar</button><button type="button" class="btn ghost">Cancelar</button>';
    const input = form.querySelector('input')!;
    input.value = m.titulo;
    form.querySelector<HTMLButtonElement>('button[type=button]')!.onclick = () => desenhar();
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); desenhar(); }
    });
    form.onsubmit = async e => {
      e.preventDefault();
      try {
        const nova = await api<Musica>(`/api/musicas/${encodeURIComponent(m.id)}`, json('PATCH', { titulo: input.value }));
        musicas = musicas.map(x => x.id === m.id ? nova : x);
        opts.renomeada(nova);
        desenhar();
      } catch (err) {
        falhar((err as Error).message);
      }
    };
    li.replaceChildren(form);
    input.select();
  }

  async function apagar(m: Musica) {
    const quem = m.minha ? '' : m.origem === 'casa' ? ' Ela é uma das músicas da casa.' : m.dono ? ` Ela foi enviada por ${m.dono.nome}.` : '';
    if (!confirm(`Apagar "${m.titulo}" para todo mundo?${quem}`)) return;
    try {
      await api(`/api/musicas/${encodeURIComponent(m.id)}`, { method: 'DELETE' });
      musicas = musicas.filter(x => x.id !== m.id);
      opts.apagada(m.id);
      desenhar();
    } catch (err) {
      falhar((err as Error).message);
    }
  }

  function desenhar() {
    erro.hidden = true;
    const ms = visiveis();
    lista.replaceChildren(...ms.map(cartao));
    vazio.hidden = ms.length > 0;
    vazio.textContent = musicas.length === 0 ? 'Nenhuma música ainda. Use o + para adicionar.'
      : filtro === 'minhas' && !busca.value ? 'Você ainda não enviou músicas. Use o + para adicionar.'
      : 'Nenhuma música com esse nome.';
  }

  return {
    abrir() {
      desenhar();
      if (!dialog.open) dialog.showModal();
      (lista.querySelector<HTMLElement>('.atual .cartao-tocar') ?? busca).focus();
    },
    async atualizar() {
      try {
        musicas = await api<Musica[]>('/api/musicas');
      } catch (err) {
        falhar((err as Error).message);
      }
      desenhar();
      return musicas;
    },
    musicas: () => musicas,
    marcarAtual(id) { atual = id; },
  };
}
