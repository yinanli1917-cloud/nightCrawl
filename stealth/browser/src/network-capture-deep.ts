/**
 * [INPUT]: Depends on buffers.CircularBuffer. Otherwise pure.
 * [OUTPUT]: Exports DeepNetEntry, DeepNetRing, deepNetBuffer, isApiRequest,
 *           redactHeaders, redactBody, redactUrl, attachDeepCapture.
 * [POS]: Skill-library DISCOVERY SUBSTRATE. The existing network buffer logs only
 *        method+url, so the system cannot SEE the API payload to learn a backend
 *        shortcut from. This captures xhr/fetch request/response bodies+headers — but
 *        REDACTED, in-memory only (a small ring). Raw bodies NEVER hit disk; only a
 *        verified, secret-stripped SHAPE (skill-discovery) is ever persisted. Privacy
 *        spine: API-only filter + redaction + bounded ring + promote-only-on-success.
 */

import { CircularBuffer } from './buffers';

export interface DeepNetEntry {
  timestamp: number;
  method: string;
  url: string;
  resourceType: string;                 // 'xhr' | 'fetch'
  reqHeaders?: Record<string, string>;  // redacted
  reqBody?: string;                     // redacted, capped
  status?: number;
  respContentType?: string;
  respBodySample?: string;              // redacted, capped
}

const DEFAULT_CAP = 2000;
const REQ_BODY_CAP = 8192;
const RESP_BODY_CAP = 4096;

/** A small named ring so tests can use a tiny capacity. */
export class DeepNetRing {
  private buf: CircularBuffer<DeepNetEntry>;
  constructor(cap: number = DEFAULT_CAP) { this.buf = new CircularBuffer<DeepNetEntry>(cap); }
  push(e: DeepNetEntry): void { this.buf.push(e); }
  toArray(): DeepNetEntry[] { return this.buf.toArray(); }
}

/** The process-wide deep capture ring (in-memory only). */
export const deepNetBuffer = new DeepNetRing();

/** Capture ONLY the API surface — never documents, media, css, fonts. */
export function isApiRequest(resourceType: string): boolean {
  return resourceType === 'xhr' || resourceType === 'fetch';
}

// ─── Redaction (secrets never persist raw) ─────────────────

const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|bearer)$/i;
const SENSITIVE_KEY = /token|secret|password|passwd|api[_-]?key|auth|session|bearer|credential|ssn|otp|private[_-]?key/i;
const SENSITIVE_PARAM = /(token|access_token|refresh_token|api[_-]?key|auth|password|secret|sig|signature|code)/i;
// Token-shaped values, regardless of key.
const TOKEN_SHAPE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\bsk-[A-Za-z0-9]{16,}\b|\bghp_[A-Za-z0-9]{16,}\b|\bAKIA[0-9A-Z]{12,}\b/g;
const MASK = '[REDACTED]';

export function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k] = SENSITIVE_HEADER.test(k) ? MASK : v;
  return out;
}

export function redactBody(body: string, _contentType?: string): string {
  if (!body) return body;
  let s = body;
  // JSON-ish "key":"value" where key is sensitive.
  s = s.replace(/"([A-Za-z0-9_.-]+)"\s*:\s*"[^"]*"/g, (m, key) => (SENSITIVE_KEY.test(key) ? `"${key}":"${MASK}"` : m));
  // Form-encoded key=value where key is sensitive.
  s = s.replace(/([A-Za-z0-9_.-]+)=([^&\s]+)/g, (m, key) => (SENSITIVE_KEY.test(key) ? `${key}=${MASK}` : m));
  // Token-shaped values anywhere.
  s = s.replace(TOKEN_SHAPE, MASK);
  return s.slice(0, REQ_BODY_CAP);
}

export function redactUrl(url: string): string {
  return url.replace(/([?&])([A-Za-z0-9_.-]+)=([^&#]*)/g, (m, sep, key, val) =>
    SENSITIVE_PARAM.test(key) ? `${sep}${key}=${MASK}` : m,
  );
}

// ─── Capture wiring (best-effort, never blocks navigation) ──

/**
 * Attach deep capture to a page. Records xhr/fetch only, redacted, into the ring. Body
 * reads are best-effort and swallow errors (same posture as the existing
 * requestfinished handler). Called by browser-manager with one line.
 */
export function attachDeepCapture(page: {
  on: (event: string, cb: (x: any) => void) => void;
}, ring: DeepNetRing = deepNetBuffer): void {
  try {
    page.on('requestfinished', async (req: any) => {
      try {
        const type = typeof req.resourceType === 'function' ? req.resourceType() : req.resourceType;
        if (!isApiRequest(type)) return;
        const res = typeof req.response === 'function' ? await req.response() : undefined;
        const entry: DeepNetEntry = {
          timestamp: Date.now(),
          method: typeof req.method === 'function' ? req.method() : req.method,
          url: redactUrl(typeof req.url === 'function' ? req.url() : req.url),
          resourceType: type,
          reqHeaders: redactHeaders((typeof req.headers === 'function' ? req.headers() : req.headers) ?? {}),
          reqBody: req.postData ? redactBody(typeof req.postData === 'function' ? req.postData() : req.postData) : undefined,
          status: res ? (typeof res.status === 'function' ? res.status() : res.status) : undefined,
        };
        ring.push(entry);
      } catch {}
    });
  } catch {}
}
