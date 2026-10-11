import { api, json } from './api';

// Tela de músicas: a lista do servidor numa tela inteira, pensada para crescer.
// Busca, ordem por qualquer coluna (data, duração, dificuldade…), filtro por origem e
// por dificuldade, e a lista desenhada aos poucos. Admin renomeia e apaga qualquer
// música; quem enviou apaga a sua.

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
  criada_em: number;   // segundos desde 1970
}

type Campo = 'dificuldade' | 'titulo' | 'dono' | 'duracao' | 'npm' | 'criada';
type Filtro = 'todas' | 'casa' | 'minhas';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (s: number) => Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0');
const sem = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const LOTE = 100; // linhas desenhadas por vez: a lista pode ter milhares
const data = (s: number) => new Date(s * 1000).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
const NIVEL = (n: number) => n <= 2 ? 'Bem fácil' : n <= 4 ? 'Fácil' : n <= 6 ? 'Médio' : n <= 8 ? 'Difícil' : 'Muito difícil';

function origem(m: Musica): string {
  if (m.origem === 'casa') return 'Da casa';
  const como = m.origem === 'midi' ? 'MIDI' : 'áudio';
  if (m.minha) return `Você (${como})`;
  return m.dono ? `${m.dono.nome} (${como})` : `Importada (${como})`;
}

const CHAVE: Record<Campo, (m: Musica) => number | string> = {
  dificuldade: m => m.dificuldade * 10_000 + m.notas_por_minuto,
  titulo: m => m.titulo,
  dono: m => m.origem === 'casa' ? '' : m.dono?.nome ?? '~',
  duracao: m => m.duracao,
  npm: m => m.notas_por_minuto,
  criada: m => m.criada_em,
};
// Direção de quando se clica numa coluna pela primeira vez.
const DIR_INICIAL: Record<Campo, 'asc' | 'desc'> = {
  dificuldade: 'asc', titulo: 'asc', dono: 'asc', duracao: 'asc', npm: 'asc', criada: 'desc',
};

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
  const nivelSel = $<HTMLSelectElement>('libNivel'), mais = $<HTMLButtonElement>('libMais');
  let musicas: Musica[] = [];
  let atual: string | undefined;
  let filtro: Filtro = 'todas';
  let mostradas = LOTE;

  try {
    const o = localStorage.getItem('pc-ordem');
    if (o && [...ordemSel.options].some(x => x.value === o)) ordemSel.value = o;
  } catch { /* sem armazenamento */ }

  $('libFechar').onclick = () => dialog.close();
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
  busca.oninput = () => desenhar();
  nivelSel.onchange = () => desenhar();
  function ordenar(valor: string) {
    if (![...ordemSel.options].some(x => x.value === valor)) return;
    ordemSel.value = valor;
    desenhar();
    try { localStorage.setItem('pc-ordem', valor); } catch { /* sem armazenamento */ }
  }
  ordemSel.onchange = () => ordenar(ordemSel.value);
  // Cabeçalho: clicar numa coluna ordena por ela; clicar de novo inverte.
  document.querySelectorAll<HTMLButtonElement>('#libCab button').forEach(b => {
    b.onclick = () => {
      const campo = b.dataset.campo as Campo, [atualCampo, dir] = ordemSel.value.split(':');
      const nova = atualCampo === campo ? (dir === 'asc' ? 'desc' : 'asc') : DIR_INICIAL[campo];
      ordenar(`${campo}:${nova}`);
    };
  });
  mais.onclick = () => { mostradas += LOTE; desenhar(false); };
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
    const [lo, hi] = nivelSel.value ? nivelSel.value.split('-').map(Number) : [0, 10];
    const ms = musicas.filter(m =>
      (filtro === 'todas' || (filtro === 'casa' ? m.origem === 'casa' : m.minha))
      && m.dificuldade >= lo && m.dificuldade <= hi
      && (!q || sem(m.titulo).includes(q) || sem(m.dono?.nome ?? '').includes(q)));
    const [campo, dir] = ordemSel.value.split(':') as [Campo, 'asc' | 'desc'];
    const chave = CHAVE[campo], sinal = dir === 'asc' ? 1 : -1;
    const col = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });
    const cmp = (x: number | string, y: number | string) =>
      typeof x === 'string' ? col.compare(x, y as string) : x - (y as number);
    return ms.sort((a, b) => sinal * cmp(chave(a), chave(b)) || col.compare(a.titulo, b.titulo));
  }

  function cartao(m: Musica): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'cartao';
    li.style.setProperty('--n', String(m.dificuldade));
    if (m.id === atual) li.classList.add('atual');
    li.innerHTML = `
      <span class="nivel" aria-hidden="true"><b></b><small>/10</small></span>
      <span class="info"><button class="titulo"></button><span class="sub"></span></span>
      <span class="c-dono"></span>
      <span class="c-num c-dur"></span>
      <span class="c-num c-npm"></span>
      <span class="c-num c-data"></span>
      <span class="cartao-acoes"></span>`;
    const t = (sel: string, txt: string) => { li.querySelector(sel)!.textContent = txt; };
    t('.nivel b', String(m.dificuldade));
    t('.titulo', m.titulo);
    t('.sub', `${origem(m)} · ${fmt(m.duracao)} · ${NIVEL(m.dificuldade)}`);
    t('.c-dono', origem(m));
    t('.c-dur', fmt(m.duracao));
    t('.c-npm', String(m.notas_por_minuto));
    t('.c-data', data(m.criada_em));
    li.title = `${NIVEL(m.dificuldade)}: ${m.notas_por_minuto} notas por minuto, ${m.notas} notas`;
    const tocar = li.querySelector<HTMLButtonElement>('.titulo')!;
    tocar.setAttribute('aria-label', `Tocar ${m.titulo}, dificuldade ${m.dificuldade} de 10, ${origem(m)}`);
    // A linha inteira toca a música; o botão do nome é o caminho pelo teclado.
    li.onclick = e => {
      if ((e.target as HTMLElement).closest('.cartao-acoes, form')) return;
      dialog.close();
      opts.tocar(m);
    };

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
    form.querySelector<HTMLButtonElement>('button[type=button]')!.onclick = () => desenhar(false);
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); desenhar(false); }
    });
    form.onsubmit = async e => {
      e.preventDefault();
      try {
        const nova = await api<Musica>(`/api/musicas/${encodeURIComponent(m.id)}`, json('PATCH', { titulo: input.value }));
        musicas = musicas.map(x => x.id === m.id ? nova : x);
        opts.renomeada(nova);
        desenhar(false);
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
      desenhar(false);
    } catch (err) {
      falhar((err as Error).message);
    }
  }

  /** `doZero`: filtro ou ordem mudou, então volta ao primeiro lote e ao topo. */
  function desenhar(doZero = true) {
    erro.hidden = true;
    if (doZero) { mostradas = LOTE; lista.scrollTop = 0; }
    const ms = visiveis();
    lista.replaceChildren(...ms.slice(0, mostradas).map(cartao));
    mais.hidden = ms.length <= mostradas;
    mais.textContent = `Mostrar mais (${ms.length - mostradas} restantes)`;
    $('libTotal').textContent = ms.length === musicas.length ? `(${musicas.length})` : `(${ms.length} de ${musicas.length})`;
    const [campo, dir] = ordemSel.value.split(':');
    document.querySelectorAll<HTMLButtonElement>('#libCab button').forEach(b => {
      b.dataset.dir = b.dataset.campo === campo ? dir : '';
      b.setAttribute('aria-pressed', String(b.dataset.campo === campo));
    });
    vazio.hidden = ms.length > 0;
    vazio.textContent = musicas.length === 0 ? 'Nenhuma música ainda. Use o + para adicionar.'
      : filtro === 'minhas' && !busca.value ? 'Você ainda não enviou músicas. Use o + para adicionar.'
      : 'Nenhuma música com esses filtros.';
  }

  return {
    abrir() {
      desenhar();
      if (!dialog.open) dialog.showModal();
      (lista.querySelector<HTMLElement>('.atual .titulo') ?? busca).focus();
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
