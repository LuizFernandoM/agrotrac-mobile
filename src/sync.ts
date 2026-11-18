import { backoff, confirmation, type Snapshot } from './domain';
import type { Repository } from './repository';
export type Transport = (snapshot: Snapshot) => Promise<{ status: number; body: unknown } | null>;
export class SyncCoordinator {
  private active?: Promise<void>;
  private requested = false;
  constructor(private repo: Repository, private send: Transport, private changed: () => void = () => {}, private now = Date.now, private foreground = () => true) {}
  trigger(): Promise<void> {
    this.requested = true;
    if (!this.active) this.active = this.drain().finally(() => { this.active = undefined; if (this.requested) void this.trigger().catch(() => {}); });
    return this.active;
  }
  private async drain() {
    do {
      this.requested = false;
      let row;
      while (this.foreground() && (row = await this.repo.next(this.now()))) {
        if (!this.foreground()) break;
        const id = row.payload.local_id;
        if (!await this.repo.claim(id)) continue;
        this.changed();
        try {
          const result = await this.send(row);
          if (!result || result.status === 401) {
            await this.repo.release(id);
            break;
          }
          if (result.status === 200 || result.status === 201) await this.repo.success(id, confirmation(row, result.body));
          else {
            const blocked = [400,403,409,413,415].includes(result.status);
            await this.repo.failure(id, `HTTP_${result.status}`, blocked, this.now() + backoff(row.attempts + 1), result.status === 409);
          }
        } catch (e) {
          const code = e instanceof Error && ['INVALID_CONFIRMATION','PHOTO_INTEGRITY_ERROR'].includes(e.message) ? e.message : 'NETWORK_TIMEOUT_OR_UPLOAD_ERROR';
          await this.repo.failure(id, code, code === 'PHOTO_INTEGRITY_ERROR', this.now() + backoff(row.attempts + 1));
        } finally { this.changed(); }
      }
    } while (this.requested);
  }
}
