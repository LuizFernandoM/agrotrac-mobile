export type Payload = Readonly<{ local_id: string; placa: string; peso_bruto_kg: number; tara_kg: number; peso_liquido_kg: number; booking_id: string | null; captured_at: string | null; motorista_nome: string | null; motorista_documento: string | null; observacoes: string | null }>;
export type Photo = Readonly<{ uri: string; file_sha256: string; file_size_bytes: number; mime_type: 'image/jpeg' | 'image/png'; width: number; height: number }>;
export type Snapshot = Readonly<{ payload: Payload; photo: Photo }>;
export type Status = 'PENDING' | 'IN_FLIGHT' | 'SYNCED' | 'FAILED_CONFLICT';
export type Row = Snapshot & { status: Status; attempts: number; next_attempt_at: number; auto_retry_blocked: number; last_error: string | null; sequence: string | null; received_at: string | null };
export const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
export const utc = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
export function kg(text: string) {
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw Error('Informe kg inteiros seguros.');
  return Number(text);
}
export function canonical(input: Record<string, unknown>): Payload {
  const { local_id, placa, peso_bruto_kg: gross, tara_kg: tare } = input;
  if (!uuid(local_id) || typeof placa !== 'string' || !/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(placa)) throw Error('UUID ou placa inválida.');
  if (!Number.isSafeInteger(gross) || !Number.isSafeInteger(tare) || Number(gross) <= 0 || Number(tare) < 0 || Number(gross) < Number(tare)) throw Error('Pesos inválidos: bruto positivo e maior ou igual à tara.');
  if (input.booking_id != null && !uuid(input.booking_id) || input.captured_at != null && !utc(input.captured_at)) throw Error('Agendamento ou data UTC inválida.');
  const text = (k: string, max: number): string | null => {
    const v = input[k];
    if (v == null) return null;
    if (typeof v !== 'string' || v.length > max || /[\u0000-\u001f\u007f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v)) throw Error(`Campo ${k} inválido.`);
    return v;
  };
  return Object.freeze({ local_id, placa, peso_bruto_kg: Number(gross), tara_kg: Number(tare), peso_liquido_kg: Number(gross) - Number(tare), booking_id: input.booking_id as string ?? null, captured_at: input.captured_at as string ?? null, motorista_nome: text('motorista_nome', 100), motorista_documento: text('motorista_documento', 100), observacoes: text('observacoes', 500) });
}
export function photoLimits(bytes: Uint8Array, declared: string | null | undefined, width: number, height: number) {
  const png = [137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v);
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
  const mime = png ? 'image/png' : jpeg ? 'image/jpeg' : null;
  if (!mime || declared != null && declared !== mime) throw Error('Foto deve ser JPEG/PNG com MIME e bytes correspondentes.');
  if (!bytes.length || bytes.length > 10485760 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 16777216) throw Error('Foto excede limites: 10 MiB, 8192 por dimensão, 16.777.216 pixels.');
  return mime;
}
export function confirmation(snapshot: Snapshot, body: unknown): { sequence: string; received_at: string } {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object' || Array.isArray(b) || !Object.entries(snapshot.payload).every(([k, v]) => b[k] === v) || typeof b.sequence !== 'string' || !/^[1-9][0-9]*$/.test(b.sequence) || !utc(b.received_at)) throw Error('INVALID_CONFIRMATION');
  const p = b.romaneio as Record<string, unknown> | null;
  if (!p || !['file_sha256', 'file_size_bytes', 'mime_type'].every(k => p[k] === snapshot.photo[k as keyof Photo])) throw Error('INVALID_CONFIRMATION');
  return { sequence: b.sequence, received_at: b.received_at };
}
export const backoff = (attempt: number) => Math.min(1000 * 2 ** Math.min(attempt, 10), 60000);
