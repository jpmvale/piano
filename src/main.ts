import './style.css';
import { Piano, TIMBRES, type Voice } from './audio';
import { ComputerKeyboard, connectMidi } from './input';
import { songFromMidi, songFromMidiFile } from './midiImport';
import { LEAD, Player, type Mode } from './player';
import { Renderer, NAMES, type NameStyle, type Pressed } from './renderer';
import { BUILTIN_SONGS, type Song } from './songs';
import { initAudioImport } from './audioImport';
import { api, quandoPerderSessao } from './api';
import { pedirEntrada, sair, usuarioAtual, type Usuario } from './auth';
import { initLibrary, type Musica } from './library';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const piano = new Piano();
const player = new Player(
  (n, seconds) => piano.play(n.midi, seconds, n.hand === 'L' ? 0.6 : 0.8),
  () => piano.stopAll(),
);
const renderer = new Renderer($<HTMLCanvasElement>('cv'));
// Músicas já abertas nesta visita, pelo id do servidor (as notas vêm do MIDI ou de songs.ts).
const cache = new Map<string, Song>();

// ---------- Notas tocadas pela pessoa (tela, computador ou MIDI) ----------
const held = new Map<number, { voice: Voice | null; kind: Pressed['kind'] }>();
function userNote(midi: number, on: boolean, velocity = 0.8) {
  if (on) {
    piano.unlock();
    held.get(midi)?.voice?.release();
    const kind = player.judge(midi);
    held.set(midi, { voice: piano.play(midi, Infinity, velocity), kind });
    if (kind !== 'free') renderer.flash(midi, kind === 'hit');
  } else {
    held.get(midi)?.voice?.release();
    held.delete(midi);
  }
}
const pcKeyboard = new ComputerKeyboard(userNote);

// ---------- Música ----------
function loadSong(s: Song) {
  player.load(s);
  renderer.setRange(s.notes.map(n => n.midi));
  updatePcBase();
  renderTicks();
  $('songTitleBtn').textContent = s.title;
  const parts = s.bpm
    ? [s.key, `${s.beatsPerBar}/4`, `${s.bpm} BPM`, `${s.bars.length} compassos`].filter(Boolean)
    : ['Música transcrita do áudio'];
  $('meta').textContent = parts.join(' · ');
  refreshLoop();
  setPlayIcon();
  library.marcarAtual(s.id);
}
function remember(id: string) {
  try { localStorage.setItem('pc-ultima', id); } catch { /* sem armazenamento */ }
}

async function songOf(m: Musica): Promise<Song> {
  let song = cache.get(m.id);
  if (!song) {
    if (m.origem === 'casa') {
      const base = BUILTIN_SONGS.find(b => b.id === m.id);
      if (!base) throw new Error('Essa música não existe mais nesta versão do jogo.');
      song = { ...base };
    } else {
      song = songFromMidi(await api<ArrayBuffer>(`/api/musicas/${encodeURIComponent(m.id)}/midi`), m.titulo);
      // A transcrição sai em segundos, sem andamento de verdade: o MIDI vem com o
      // padrão de 120 BPM, e mostrar esse número seria inventar.
      if (m.origem === 'audio') song.bpm = 0;
    }
    cache.set(m.id, song);
  }
  song.id = m.id;
  song.title = m.titulo;
  return song;
}

async function play(m: Musica) {
  try {
    stop();
    loadSong(await songOf(m));
    remember(m.id);
  } catch (err) {
    $('meta').textContent = (err as Error).message;
  }
}

const library = initLibrary({
  tocar: m => void play(m),
  apagada: id => {
    cache.delete(id);
    // Apagou a que estava tocando: volta para a primeira da lista.
    if (player.song.id === id) {
      const outra = library.musicas()[0];
      if (outra) void play(outra);
    }
  },
  renomeada: m => {
    const s = cache.get(m.id);
    if (s) s.title = m.titulo;
    if (player.song.id === m.id) $('songTitleBtn').textContent = m.titulo;
  },
});
$('songsBtn').onclick = () => library.abrir();
$('songTitleBtn').onclick = () => library.abrir();

$<HTMLInputElement>('midiFile').addEventListener('change', async e => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  let song: Song;
  try {
    song = await songFromMidiFile(file);
  } catch (err) {
    $('meta').textContent = 'Não consegui ler esse arquivo: ' + ((err as Error).message || 'formato desconhecido');
    return;
  }
  // Toca na hora e guarda no servidor como música sua.
  loadSong(song);
  const body = new FormData();
  body.append('arquivo', file);
  body.append('titulo', song.title);
  body.append('notas', String(song.notes.length));
  body.append('duracao', String(song.duration));
  try {
    const m = await api<Musica>('/api/musicas/midi', { method: 'POST', body });
    cache.set(m.id, song);
    song.id = m.id;
    library.marcarAtual(m.id);
    remember(m.id);
    await library.atualizar();
  } catch (err) {
    $('meta').textContent = 'Tocando, mas não consegui guardar no servidor: ' + (err as Error).message;
  }
});

const openAudio = initAudioImport(async (id, open) => {
  const ms = await library.atualizar();
  const m = ms.find(x => x.id === id);
  if (m && open) void play(m);
});

// ---------- Menus do topo: + (MIDI ou MP3) e conta ----------
function menu(wrap: HTMLElement) {
  const btn = wrap.querySelector<HTMLElement>('.btn')!, box = wrap.querySelector<HTMLElement>('.menu')!;
  const set = (open: boolean) => {
    box.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) (box.querySelector<HTMLElement>('[aria-checked="true"]') ?? box.querySelector<HTMLElement>('.menu-item'))?.focus();
  };
  btn.onclick = () => set(box.hidden);
  document.addEventListener('pointerdown', e => {
    if (!box.hidden && !wrap.contains(e.target as Node)) set(false);
  });
  box.addEventListener('keydown', e => {
    e.stopPropagation(); // atalhos do jogo não valem dentro do menu
    const items = [...box.querySelectorAll<HTMLElement>('.menu-item')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') { e.preventDefault(); set(false); btn.focus(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); (document.activeElement as HTMLElement).click(); }
  });
  box.addEventListener('click', e => { if ((e.target as HTMLElement).closest('.menu-item')) set(false); });
}
menu($('addWrap'));
menu($('userWrap'));
$('addAudio').onclick = () => openAudio();

// ---------- Conta ----------
function showUser(u: Usuario) {
  $('userBtn').textContent = u.nome.trim().charAt(0).toUpperCase() || '?';
  $('userBtn').title = `${u.nome} (${u.email})`;
  $('userName').textContent = u.nome;
  $('userEmail').textContent = u.email;
  $('userAdmin').hidden = u.papel !== 'ADMIN';
}

let entrando: Promise<void> | null = null;
/** Pede login (se preciso) e carrega as músicas da conta. */
function entrar(): Promise<void> {
  entrando ??= (async () => {
    stop();
    const u = (await usuarioAtual()) ?? (await pedirEntrada());
    showUser(u);
    cache.clear();
    const ms = await library.atualizar();
    let ultima: string | null = null;
    try { ultima = localStorage.getItem('pc-ultima'); } catch { /* sem armazenamento */ }
    const m = ms.find(x => x.id === ultima);
    if (m) await play(m);
    else library.abrir(); // primeira visita: começa escolhendo a música
  })().finally(() => { entrando = null; });
  return entrando;
}
quandoPerderSessao(() => {
  if (!entrando) {
    document.querySelectorAll('dialog[open]').forEach(d => (d as HTMLDialogElement).close());
    void entrar();
  }
});
$('logoutBtn').onclick = async () => {
  await sair();
  try { localStorage.removeItem('pc-ultima'); } catch { /* sem armazenamento */ }
  void entrar();
};

// Teclas do computador começam no Dó mais grave da parte que você toca
function updatePcBase() {
  const s = player.song;
  const mine = s.notes.filter(n => player.mode === 'listen' || player.practicing(n.hand));
  const low = Math.min(...(mine.length ? mine : s.notes).map(n => n.midi));
  pcKeyboard.base = Math.floor(low / 12) * 12;
  renderer.pcLabels = $('pcKeys').getAttribute('aria-pressed') === 'true' ? pcKeyboard.labels() : null;
}

// ---------- Tela cheia: só o palco e o controle de tocar ----------
function setTheater(on: boolean) {
  document.body.classList.toggle('theater', on);
  $('theaterBtn').setAttribute('aria-pressed', String(on));
  $('theaterBtn').querySelector('span')!.textContent = on ? 'Sair' : 'Tela cheia';
  $('theaterIcon').innerHTML = on
    ? '<path d="M8 4h2v6H4V8h4zm6 0h2v4h4v2h-6zM4 14h6v6H8v-4H4zm10 0h6v2h-4v4h-2z"/>'
    : '<path d="M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z"/>';
  const fs = document.fullscreenElement != null;
  // A tela cheia do navegador é um extra: onde não existe (iPhone), fica só o modo teatro.
  if (on && !fs) document.documentElement.requestFullscreen?.().catch(() => { /* sem permissão */ });
  if (!on && fs) void document.exitFullscreen();
  if (!on) unrotate();
  void updateWakeLock();
}
$('theaterBtn').onclick = () => setTheater(!document.body.classList.contains('theater'));
// Esc do navegador sai da tela cheia: sai do modo teatro junto.
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && document.body.classList.contains('theater')) setTheater(false);
});

// ---------- Celular: virar a tela e não deixar apagar ----------
const isPhone = matchMedia('(hover: none) and (pointer: coarse)').matches;
document.body.classList.toggle('phone', isPhone);
type Lockable = ScreenOrientation & { lock?: (o: string) => Promise<void>; unlock?: () => void };
const orientation = screen.orientation as Lockable | undefined;
let locked = false;
const portrait = () => innerHeight > innerWidth;
// Onde o navegador não deixa travar a orientação (iPhone), o app é girado 90° por CSS.
function setCssRotated(on: boolean) {
  document.documentElement.classList.toggle('rotated', on);
}
function unrotate() {
  setCssRotated(false);
  if (locked) { orientation?.unlock?.(); locked = false; }
}
$('rotateBtn').onclick = async () => {
  if (document.documentElement.classList.contains('rotated')) { setCssRotated(false); return; }
  try {
    if (!orientation?.lock) throw new Error('sem lock');
    await orientation.lock(portrait() ? 'landscape' : 'portrait');
    locked = true;
  } catch {
    if (portrait()) setCssRotated(true);
  }
};
// Girou o celular de verdade para deitado: a rotação por CSS não é mais necessária.
addEventListener('resize', () => { if (!portrait()) setCssRotated(false); });
// Ponto do toque nas coordenadas do elemento, também com o app girado por CSS.
function localPoint(el: Element, e: PointerEvent) {
  const r = el.getBoundingClientRect();
  if (document.documentElement.classList.contains('rotated')) return { x: e.clientY - r.top, y: r.right - e.clientX, w: r.height };
  return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width };
}

// Tela sempre acesa no celular enquanto está em tela cheia ou tocando.
let wakeLock: WakeLockSentinel | null = null;
async function updateWakeLock() {
  const want = isPhone && document.visibilityState === 'visible'
    && (document.body.classList.contains('theater') || player.playing);
  if (want && !wakeLock && 'wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { /* bateria fraca ou sem permissão */ }
  } else if (!want && wakeLock) {
    const w = wakeLock; wakeLock = null; void w.release();
  }
}
// O navegador solta o bloqueio quando a aba some; pede de novo ao voltar.
document.addEventListener('visibilitychange', () => void updateWakeLock());

// ---------- Transporte ----------
function setPlayIcon() {
  $('play').setAttribute('aria-label', player.playing ? 'Pausar' : 'Tocar');
  $('playIcon').innerHTML = player.playing
    ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>'
    : '<path d="M8 5v14l11-7z"/>';
  void updateWakeLock();
}
function togglePlay() {
  piano.unlock();
  if (player.playing) player.pause(); else player.play();
  setPlayIcon();
}
function stop() { player.stop(); setPlayIcon(); }
function setSpeed(v: number) {
  player.speed = Math.round(Math.max(0.3, Math.min(1.5, v)) * 10) / 10;
  $('speedVal').textContent = Math.round(player.speed * 100) + '%';
}
function refreshLoop() {
  const L = player.loop, ready = L.a != null && L.b != null;
  if (!ready) L.on = false;
  $('loopBtn').setAttribute('aria-pressed', String(L.on));
  $<HTMLButtonElement>('loopBtn').disabled = !ready;
  $<HTMLButtonElement>('clearLoop').disabled = L.a == null && L.b == null;
}
function setMode(m: Mode) {
  player.mode = m;
  document.querySelectorAll<HTMLButtonElement>('#mode button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
  $<HTMLButtonElement>('waitBtn').disabled = m === 'listen';
  $('score').hidden = m === 'listen';
  player.seek(player.t);
  updatePcBase();
}

$('play').onclick = togglePlay;
$('stop').onclick = stop;
$('prev').onclick = () => player.stepBar(-1);
$('next').onclick = () => player.stepBar(1);
$('slower').onclick = () => setSpeed(player.speed - 0.1);
$('faster').onclick = () => setSpeed(player.speed + 0.1);
$('markA').onclick = () => { player.setLoopPoint('a'); refreshLoop(); };
$('markB').onclick = () => { player.setLoopPoint('b'); refreshLoop(); };
$('loopBtn').onclick = () => { player.loop.on = !player.loop.on; refreshLoop(); };
$('clearLoop').onclick = () => { player.clearLoop(); refreshLoop(); };
document.querySelectorAll<HTMLButtonElement>('#mode button').forEach(b => { b.onclick = () => setMode(b.dataset.mode as Mode); });
$('waitBtn').onclick = () => {
  player.waitForMe = !player.waitForMe;
  $('waitBtn').setAttribute('aria-pressed', String(player.waitForMe));
  player.seek(player.t);
};
$('pcKeys').onclick = () => {
  const on = $('pcKeys').getAttribute('aria-pressed') !== 'true';
  $('pcKeys').setAttribute('aria-pressed', String(on));
  updatePcBase();
  try { localStorage.setItem('pc-keys', on ? '1' : '0'); } catch { /* sem armazenamento */ }
};
$<HTMLSelectElement>('names').onchange = e => {
  renderer.names = (e.target as HTMLSelectElement).value as NameStyle;
  try { localStorage.setItem('pc-names', renderer.names); } catch { /* sem armazenamento */ }
};
// ---------- Timbre ----------
const timbreSel = $<HTMLSelectElement>('timbre');
for (const t of TIMBRES) timbreSel.add(new Option(t.name, t.id));
timbreSel.onchange = async () => {
  const id = timbreSel.value;
  timbreSel.blur(); // devolve o teclado aos atalhos
  try { localStorage.setItem('pc-timbre', id); } catch { /* sem armazenamento */ }
  piano.unlock();
  $('timbreStatus').textContent = 'Carregando…';
  const ok = await piano.setTimbre(id);
  if (piano.timbreId !== id) return; // outra escolha já passou na frente
  $('timbreStatus').textContent = ok ? '' : 'Não consegui baixar esse timbre. Tente de novo.';
  if (ok && !player.playing) piano.play(60, 0.6, 0.8); // amostra do som novo
};

$('midiBtn').onclick = () => {
  piano.unlock();
  $('midiStatus').textContent = 'Procurando teclado…';
  void connectMidi(userNote, s => {
    $('midiStatus').textContent =
      s.state === 'unsupported' ? 'Este navegador não tem suporte a MIDI. Use Chrome ou Edge.'
      : s.state === 'denied' ? 'Esta página não recebeu acesso ao MIDI. Use as teclas da tela ou do computador.'
      : s.inputs.length ? `Conectado: ${s.inputs.join(', ')}`
      : 'Nenhum teclado MIDI encontrado. Ligue o cabo e tente de novo.';
  });
};

document.addEventListener('keydown', e => {
  if ((e.target as HTMLElement).closest('select, input, dialog') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === ' ' && (e.target as HTMLElement).closest('button')) return;
  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'ArrowLeft': e.preventDefault(); player.stepBar(-1); break;
    case 'ArrowRight': e.preventDefault(); player.stepBar(1); break;
    case 'ArrowUp': e.preventDefault(); setSpeed(player.speed + 0.1); break;
    case 'ArrowDown': e.preventDefault(); setSpeed(player.speed - 0.1); break;
    case 'Escape': stop(); break;
    case '[': $('markA').click(); break;
    case ']': $('markB').click(); break;
    case 'f': case 'F': $('theaterBtn').click(); break;
    case '\\': if (!$<HTMLButtonElement>('loopBtn').disabled) $('loopBtn').click(); break;
  }
});

// ---------- Palco: arrastar para navegar, tocar nas teclas ----------
const cv = $<HTMLCanvasElement>('cv');
let drag: { y0: number; t0: number } | null = null;
const pointerKey = new Map<number, number>();
cv.addEventListener('pointerdown', e => {
  const { x, y } = localPoint(cv, e);
  cv.setPointerCapture(e.pointerId);
  const m = renderer.keyAt(x, y);
  if (m != null) { pointerKey.set(e.pointerId, m); userNote(m, true); return; }
  drag = { y0: y, t0: player.t };
  cv.classList.add('dragging');
});
cv.addEventListener('pointermove', e => {
  const { x, y } = localPoint(cv, e);
  if (drag) { player.seek(drag.t0 + (y - drag.y0) / renderer.pps); return; }
  const cur = pointerKey.get(e.pointerId);
  if (cur != null && e.buttons) {
    const m = renderer.keyAt(x, y);
    if (m != null && m !== cur) { userNote(cur, false); pointerKey.set(e.pointerId, m); userNote(m, true); }
  }
});
function endPointer(e: PointerEvent) {
  const cur = pointerKey.get(e.pointerId);
  if (cur != null) { userNote(cur, false); pointerKey.delete(e.pointerId); }
  if (drag) { drag = null; cv.classList.remove('dragging'); }
}
cv.addEventListener('pointerup', endPointer);
cv.addEventListener('pointercancel', endPointer);
cv.addEventListener('wheel', e => {
  e.preventDefault();
  player.seek(player.t - (e.deltaY / renderer.pps) * 0.6);
}, { passive: false });

// ---------- Linha do tempo ----------
const track = $('track');
let trackDrag = false;
const span = () => player.end - player.start;
function trackSeek(e: PointerEvent) {
  const { x, w } = localPoint(track, e);
  player.seek(player.start + (x / w) * span());
}
track.addEventListener('pointerdown', e => { trackDrag = true; track.setPointerCapture(e.pointerId); trackSeek(e); });
track.addEventListener('pointermove', e => { if (trackDrag) trackSeek(e); });
track.addEventListener('pointerup', () => { trackDrag = false; });
track.addEventListener('pointercancel', () => { trackDrag = false; });
track.addEventListener('keydown', e => {
  if (e.key === 'Home') { e.preventDefault(); player.seek(player.start); }
  if (e.key === 'End') { e.preventDefault(); player.seek(player.end); }
});

const fmt = (s: number) => { s = Math.max(0, s); return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };
const pct = (t: number) => ((t - player.start) / span()) * 100 + '%';
function renderTicks() {
  const box = $('ticks');
  box.innerHTML = '';
  for (const bt of player.song.bars) {
    const d = document.createElement('div');
    d.className = 'tick'; d.style.left = pct(bt);
    box.appendChild(d);
  }
  $('tEnd').textContent = fmt(player.song.duration);
}
let lastPlaying = false;
function updateUI() {
  $('fill').style.width = pct(player.t);
  $('thumb').style.left = pct(player.t);
  $('tNow').textContent = fmt(player.t);
  const bar = player.barIndex();
  $('bar').textContent = `Compasso ${bar || '–'}/${player.song.bars.length}`;
  track.setAttribute('aria-valuetext', `${fmt(player.t)}, compasso ${bar || 0}`);
  const lb = $('loopBox'), { a, b } = player.loop;
  lb.hidden = a == null || b == null;
  if (a != null && b != null) { lb.style.left = pct(a); lb.style.width = ((b - a) / span()) * 100 + '%'; }
  $('sHit').textContent = String(player.hit.size);
  $('sMiss').textContent = String(player.missed.size);
  $('sWrong').textContent = String(player.wrong);
  if (lastPlaying !== player.playing) { lastPlaying = player.playing; setPlayIcon(); }
}

// ---------- Laço ----------
let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!drag && !trackDrag) player.tick(dt);
  const pressed = new Map<number, Pressed['kind']>();
  for (const [m, h] of held) pressed.set(m, h.kind);
  renderer.draw(player, pressed);
  updateUI();
  requestAnimationFrame(frame);
}

// ---------- Início ----------
try {
  const n = localStorage.getItem('pc-names');
  if (n && (n in NAMES || n === 'none')) { renderer.names = n as NameStyle; $<HTMLSelectElement>('names').value = n; }
  if (localStorage.getItem('pc-keys') === '1') $('pcKeys').setAttribute('aria-pressed', 'true');
  const t = localStorage.getItem('pc-timbre');
  if (t && TIMBRES.some(x => x.id === t)) { timbreSel.value = t; void piano.setTimbre(t); }
} catch { /* sem armazenamento */ }
renderer.resize();
loadSong(BUILTIN_SONGS[0]); // o palco já aparece atrás da tela de entrada
setMode('listen');
setSpeed(1);
player.seek(-LEAD + 0.6); // primeiras notas já descendo, para a tela não abrir vazia
requestAnimationFrame(frame);
void entrar();
