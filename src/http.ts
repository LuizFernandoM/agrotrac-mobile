export function apiUrl(value: string) {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('Informe URL HTTP(S) do Gateway, sem credenciais ou parâmetros.');
  return url.toString().replace(/\/$/, '');
}
type GatewayOptions = Pick<RequestInit, 'method' | 'headers' | 'credentials' | 'redirect' | 'signal'> & { body?: FormData | string };
export type GatewayFetch = (url: string, options: GatewayOptions) => Promise<Pick<Response, 'status' | 'json'>>;

export async function gatewayRequest(base: string, path: string, options: GatewayOptions, timeoutMs: number, request: GatewayFetch) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await request(`${apiUrl(base)}${path}`, { ...options, credentials: 'omit', redirect: 'error', signal: controller.signal });
    let body: unknown = null;
    try { body = await response.json(); } catch { /* preserve permanent HTTP status even with invalid error body */ }
    return { status: response.status, body };
  } finally { clearTimeout(timer); }
}

export function postMultipart(base: string, form: FormData, token: string, timeoutMs = 30000, request: GatewayFetch = fetch) {
  return gatewayRequest(base, '/v1/audit/weighings/sync', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  }, timeoutMs, request);
}
