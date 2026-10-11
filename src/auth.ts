import { api, json } from './api';

// Tela de entrada: "Entrar" ou "Criar conta" (com o código de convite).

export interface Usuario {
  id: number;
  nome: string;
  email: string;
  papel: 'ADMIN' | 'USER';
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export async function usuarioAtual(): Promise<Usuario | null> {
  try {
    return await api<Usuario>('/api/auth/eu');
  } catch {
    return null;
  }
}

export async function sair() {
  await api('/api/auth/sair', { method: 'POST' }).catch(() => { /* sai da tela mesmo assim */ });
}

/** Mostra a tela de entrada e resolve com a pessoa quando ela entrar. */
export function pedirEntrada(): Promise<Usuario> {
  const tela = $('authScreen'), form = $<HTMLFormElement>('authForm'), erro = $('authError');
  const enviar = $<HTMLButtonElement>('authSubmit');
  document.body.classList.add('locked');
  tela.hidden = false;
  let criando = false;

  function modo(criar: boolean) {
    criando = criar;
    document.querySelectorAll<HTMLButtonElement>('#authTabs button')
      .forEach(b => b.setAttribute('aria-selected', String((b.dataset.tab === 'criar') === criar)));
    form.querySelectorAll<HTMLElement>('.so-criar').forEach(el => { el.hidden = !criar; });
    form.querySelectorAll<HTMLInputElement>('.so-criar input').forEach(i => { i.required = criar; });
    $<HTMLInputElement>('authSenha').autocomplete = criar ? 'new-password' : 'current-password';
    enviar.textContent = criar ? 'Criar conta' : 'Entrar';
    erro.hidden = true;
  }
  document.querySelectorAll<HTMLButtonElement>('#authTabs button')
    .forEach(b => { b.onclick = () => modo(b.dataset.tab === 'criar'); });
  modo(false);
  $<HTMLInputElement>('authEmail').focus();

  return new Promise(resolve => {
    form.onsubmit = async e => {
      e.preventDefault();
      erro.hidden = true;
      enviar.disabled = true;
      const v = (id: string) => $<HTMLInputElement>(id).value;
      try {
        const u = criando
          ? await api<Usuario>('/api/auth/cadastro', json('POST', {
            nome: v('authNome'), email: v('authEmail'), senha: v('authSenha'), convite: v('authConvite'),
          }))
          : await api<Usuario>('/api/auth/entrar', json('POST', { email: v('authEmail'), senha: v('authSenha') }));
        tela.hidden = true;
        document.body.classList.remove('locked');
        $<HTMLInputElement>('authSenha').value = '';
        resolve(u);
      } catch (err) {
        erro.textContent = (err as Error).message;
        erro.hidden = false;
      } finally {
        enviar.disabled = false;
      }
    };
  });
}
