/**
 * [INPUT]: None (in-memory correlation; the transport is injected via attach()).
 * [OUTPUT]: Exports BridgeCommand, BridgeResult, BridgeHub.
 * [POS]: Phase-3B bridge transport — the daemon-side brain that pushes a command
 *        to the connected real-browser bridge and awaits its result.
 *
 * Reliability contract (the fix for Kimi's lost-on-reconnect failure): every
 * dispatch() promise is GUARANTEED to settle — it resolves on deliver(), rejects
 * on timeout, and rejects on detach() (disconnect). It never hangs and never
 * silently drops an in-flight command. The hub is transport-agnostic: server.ts
 * attaches an SSE writer as the `send` sink and routes /bridge/result to deliver().
 */

import { DEFAULT_SESSION_ID } from './session-id';

export interface BridgeCommand {
  id: string;
  command: string;
  args: string[];
  /** Session that issued this command — the extension binds one tab per session. */
  sessionId: string;
}

export interface BridgeResult {
  ok: boolean;
  result?: any;
  error?: string;
}

interface Pending {
  resolve: (r: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BridgeHub {
  private send: ((cmd: BridgeCommand) => void) | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;

  /** True when a real-browser bridge is connected and able to take commands. */
  isConnected(): boolean {
    return this.send !== null;
  }

  /**
   * Resolve once a bridge is connected, or after `ms` if not. Lets an explicit
   * --engine=real ride out a daemon-restart reconnect gap (the extension retries on a
   * ~3s backoff) instead of silently falling back to headless and stranding a live
   * logged-in session.
   */
  async waitForConnected(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (!this.isConnected() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
    }
    return this.isConnected();
  }

  /** Connect a transport sink (the SSE writer that pushes commands to the host). */
  attach(send: (cmd: BridgeCommand) => void): void {
    this.send = send;
  }

  /**
   * Disconnect. Connection-scoped: if `send` is given and is NOT the current
   * sink, this is a STALE connection's teardown (e.g. an old SSE aborting after
   * a newer one already attached during a daemon restart) — ignore it so it
   * can't clobber the live connection. With no arg, force a full disconnect.
   */
  detach(send?: (cmd: BridgeCommand) => void): void {
    if (send && send !== this.send) return; // stale teardown — a newer sink is live
    this.send = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('bridge disconnected'));
    }
    this.pending.clear();
  }

  /** Push a command to the bridge and await its result (always settles). */
  dispatch(command: string, args: string[], timeoutMs = 30000, sessionId: string = DEFAULT_SESSION_ID): Promise<any> {
    if (!this.send) return Promise.reject(new Error('real-browser bridge is offline'));
    const id = `b${++this.seq}`;
    const send = this.send;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`bridge command timeout (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        send({ id, command, args, sessionId });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Settle the matching dispatch with a result or error. Unknown id → ignored. */
  deliver(id: string, result: any, error?: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve(result);
  }
}
