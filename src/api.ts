// Conversa com o servidor (pasta transcriber/). A sessão vai num cookie httpOnly,
// então basta mandar os cookies; 401 em qualquer rota quer dizer "entre de novo".

export class SemSessao extends Error {}

let aoPerderSessao: () => void = () => {};
export function quandoPerderSessao(fn: () => void) { aoPerderSessao = fn; }

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, { credentials: 'same-origin', ...init });
  } catch {
    throw new Error('Sem conexão com o servidor.');
  }
  if (r.status === 401 && !path.startsWith('/api/auth/entrar')) {
    aoPerderSessao();
    throw new SemSessao('Entre na sua conta para continuar.');
  }
  if (!r.ok) {
    const body = await r.json().catch(() => null) as { detail?: unknown } | null;
    throw new Error(typeof body?.detail === 'string' ? body.detail
      : r.status === 502 || r.status === 404 ? 'O servidor não está no ar agora.'
      : 'O servidor respondeu com erro.');
  }
  return (r.headers.get('content-type')?.includes('json') ? r.json() : r.arrayBuffer()) as Promise<T>;
}

export const json = (method: string, body: unknown): RequestInit =>
  ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
