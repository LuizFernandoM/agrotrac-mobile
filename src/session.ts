import { apiUrl, gatewayRequest, postMultipart, type GatewayFetch } from './http';

type Session = Readonly<{
  base: string;
  token: string;
  expiresAt: number;
}>;

export class MobileSession {
  private session?: Session;
  private expiry?: ReturnType<typeof setTimeout>;

  constructor(private changed: (signedIn: boolean) => void, private request: GatewayFetch) {}

  current() {
    if (this.session && this.session.expiresAt <= Date.now()) this.clear();
    return this.session;
  }

  clear(expected = this.session) {
    if (!expected || this.session !== expected) return;
    clearTimeout(this.expiry);
    this.session = undefined;
    this.changed(false);
  }

  async login(base: string, username: string, password: string) {
    base = apiUrl(base);
    const { status, body } = await gatewayRequest(base, '/v1/live/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, client: 'mobile' }),
    }, 8000, this.request);
    if (status !== 200) return status;
    if (!body || typeof body !== 'object') throw Error('INVALID_SESSION');
    const { access_token, token_type, expires_at, user } = body as Record<string, unknown>;
    const expiresAt = typeof expires_at === 'string' ? Date.parse(expires_at) : NaN;
    if (token_type !== 'Bearer' || typeof access_token !== 'string' || !/^[A-Za-z0-9._~+/-]+=*$/.test(access_token)
      || !Number.isFinite(expiresAt) || expiresAt <= Date.now()
      || !user || typeof user !== 'object' || !('id' in user) || typeof user.id !== 'string' || !user.id
      || !('role' in user) || (user.role !== 'operator' && user.role !== 'admin')) throw Error('INVALID_SESSION');
    this.clear();
    const session = { base, token: access_token, expiresAt };
    this.session = session;
    const expire = () => {
      const remaining = session.expiresAt - Date.now();
      if (remaining <= 0) this.clear(session);
      else this.expiry = setTimeout(expire, Math.min(remaining, 2_147_483_647));
    };
    this.changed(true);
    expire();
    return status;
  }

  async logout() {
    const session = this.current();
    if (!session) return;
    this.clear(session);
    const { status } = await gatewayRequest(session.base, '/v1/live/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.token}` },
    }, 8000, this.request);
    return status;
  }

  async upload(session: Session, form: FormData, timeoutMs: number) {
    if (this.current() !== session) return null;
    const result = await postMultipart(session.base, form, session.token, timeoutMs, this.request);
    if (result.status === 401) this.clear(session);
    return result;
  }
}
