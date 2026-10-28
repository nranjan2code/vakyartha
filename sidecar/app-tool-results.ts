// Executable apps consume bounded source JSON, not model-facing clipped prose.
// The existing tool still performs schema checks, policy rechecks and logging.
export class AppToolResults {
  private pending = new Map<string, { text: string; isError?: boolean } | undefined>();
  observe(session: string, result: { text: string; isError?: boolean }): void {
    if (this.pending.has(session)) this.pending.set(session, result);
  }
  async execute(run: (session: string) => Promise<unknown>): Promise<string> {
    const session = `app-read:${crypto.randomUUID()}`;
    this.pending.set(session, undefined);
    try {
      await run(session);
      const raw = this.pending.get(session);
      if (!raw) throw new Error('No integration source receipt; app read failed');
      if (raw.isError) throw new Error('Integration returned an error');
      if (Buffer.byteLength(raw.text) > 250 * 1024) throw new Error('App source reply exceeds bounds');
      return raw.text;
    } finally { this.pending.delete(session); }
  }
}
