export function apiUrl(value: string) {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('Informe URL HTTP(S) do Gateway, sem credenciais ou parâmetros.');
  return url.toString().replace(/\/$/, '');
}
export async function postMultipart(base: string, form: FormData, timeoutMs = 30000, request: typeof fetch = fetch) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await request(`${apiUrl(base)}/v1/audit/weighings/sync`, { method: 'POST', body: form, signal: controller.signal });
    let body: unknown = null;
    try { body = await response.json(); } catch { /* preserve permanent HTTP status even with invalid error body */ }
    return { status: response.status, body };
  } finally { clearTimeout(timer); }
}
