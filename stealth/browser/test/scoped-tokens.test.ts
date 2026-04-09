/**
 * Scoped token system tests — per-agent permission control
 *
 * Verifies that tokens with limited scopes are correctly enforced:
 *   - read scope: text, html, links, but NOT js, cookie, storage set
 *   - write scope: click, fill, but NOT cookie, js
 *   - admin scope: js, eval, cookie, storage set, cookie-import
 *   - meta scope: status, help, tabs
 *   - domain restrictions: block commands on non-matching URLs
 *   - rate limiting: reject requests over the threshold
 *   - backward compat: legacy tokens (no scopes) get full access
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  TokenRegistry,
  type ScopedToken,
  COMMAND_SCOPE_MAP,
  Scope,
  checkPermission,
  matchesDomain,
} from '../src/token-registry';

// ─── Scope Mapping ─────────────────────────────────────────────

describe('Command-to-scope mapping', () => {
  test('read commands map to read scope', () => {
    expect(COMMAND_SCOPE_MAP['text']).toBe(Scope.Read);
    expect(COMMAND_SCOPE_MAP['html']).toBe(Scope.Read);
    expect(COMMAND_SCOPE_MAP['links']).toBe(Scope.Read);
    expect(COMMAND_SCOPE_MAP['forms']).toBe(Scope.Read);
    expect(COMMAND_SCOPE_MAP['accessibility']).toBe(Scope.Read);
    expect(COMMAND_SCOPE_MAP['css']).toBe(Scope.Read);
    expect(COMMAND_SCOPE_MAP['attrs']).toBe(Scope.Read);
    expect(COMMAND_SCOPE_MAP['is']).toBe(Scope.Read);
    expect(COMMAND_SCOPE_MAP['perf']).toBe(Scope.Read);
  });

  test('write commands map to write scope', () => {
    expect(COMMAND_SCOPE_MAP['click']).toBe(Scope.Write);
    expect(COMMAND_SCOPE_MAP['fill']).toBe(Scope.Write);
    expect(COMMAND_SCOPE_MAP['select']).toBe(Scope.Write);
    expect(COMMAND_SCOPE_MAP['hover']).toBe(Scope.Write);
    expect(COMMAND_SCOPE_MAP['type']).toBe(Scope.Write);
    expect(COMMAND_SCOPE_MAP['press']).toBe(Scope.Write);
    expect(COMMAND_SCOPE_MAP['scroll']).toBe(Scope.Write);
    expect(COMMAND_SCOPE_MAP['wait']).toBe(Scope.Write);
    expect(COMMAND_SCOPE_MAP['viewport']).toBe(Scope.Write);
    expect(COMMAND_SCOPE_MAP['goto']).toBe(Scope.Write);
    expect(COMMAND_SCOPE_MAP['back']).toBe(Scope.Write);
    expect(COMMAND_SCOPE_MAP['forward']).toBe(Scope.Write);
    expect(COMMAND_SCOPE_MAP['reload']).toBe(Scope.Write);
    expect(COMMAND_SCOPE_MAP['upload']).toBe(Scope.Write);
    expect(COMMAND_SCOPE_MAP['cleanup']).toBe(Scope.Write);
    expect(COMMAND_SCOPE_MAP['dialog-accept']).toBe(Scope.Write);
    expect(COMMAND_SCOPE_MAP['dialog-dismiss']).toBe(Scope.Write);
  });

  test('dangerous commands map to admin scope', () => {
    expect(COMMAND_SCOPE_MAP['js']).toBe(Scope.Admin);
    expect(COMMAND_SCOPE_MAP['eval']).toBe(Scope.Admin);
    expect(COMMAND_SCOPE_MAP['cookies']).toBe(Scope.Admin);
    expect(COMMAND_SCOPE_MAP['cookie']).toBe(Scope.Admin);
    expect(COMMAND_SCOPE_MAP['cookie-import']).toBe(Scope.Admin);
    expect(COMMAND_SCOPE_MAP['cookie-import-browser']).toBe(Scope.Admin);
    expect(COMMAND_SCOPE_MAP['header']).toBe(Scope.Admin);
    expect(COMMAND_SCOPE_MAP['useragent']).toBe(Scope.Admin);
    expect(COMMAND_SCOPE_MAP['console']).toBe(Scope.Admin);
    expect(COMMAND_SCOPE_MAP['network']).toBe(Scope.Admin);
    expect(COMMAND_SCOPE_MAP['dialog']).toBe(Scope.Admin);
  });

  test('storage command maps to admin scope', () => {
    expect(COMMAND_SCOPE_MAP['storage']).toBe(Scope.Admin);
  });

  test('meta commands map to meta scope', () => {
    expect(COMMAND_SCOPE_MAP['status']).toBe(Scope.Meta);
    expect(COMMAND_SCOPE_MAP['tabs']).toBe(Scope.Meta);
    expect(COMMAND_SCOPE_MAP['tab']).toBe(Scope.Meta);
    expect(COMMAND_SCOPE_MAP['newtab']).toBe(Scope.Meta);
    expect(COMMAND_SCOPE_MAP['closetab']).toBe(Scope.Meta);
    expect(COMMAND_SCOPE_MAP['screenshot']).toBe(Scope.Meta);
    expect(COMMAND_SCOPE_MAP['snapshot']).toBe(Scope.Meta);
    expect(COMMAND_SCOPE_MAP['url']).toBe(Scope.Meta);
  });

  test('server control commands map to admin scope', () => {
    expect(COMMAND_SCOPE_MAP['stop']).toBe(Scope.Admin);
    expect(COMMAND_SCOPE_MAP['restart']).toBe(Scope.Admin);
  });
});

// ─── Permission Checks ─────────────────────────────────────────

describe('checkPermission', () => {
  test('token with read scope can run text', () => {
    const token: ScopedToken = { id: 't1', scopes: [Scope.Read] };
    expect(checkPermission(token, 'text')).toEqual({ allowed: true });
  });

  test('token with read scope cannot run js', () => {
    const token: ScopedToken = { id: 't1', scopes: [Scope.Read] };
    const result = checkPermission(token, 'js');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('admin');
  });

  test('token with write scope can run click', () => {
    const token: ScopedToken = { id: 't1', scopes: [Scope.Write] };
    expect(checkPermission(token, 'click')).toEqual({ allowed: true });
  });

  test('token with write scope cannot run cookie', () => {
    const token: ScopedToken = { id: 't1', scopes: [Scope.Write] };
    const result = checkPermission(token, 'cookie');
    expect(result.allowed).toBe(false);
  });

  test('token with admin scope can run js', () => {
    const token: ScopedToken = { id: 't1', scopes: [Scope.Admin] };
    expect(checkPermission(token, 'js')).toEqual({ allowed: true });
  });

  test('token with meta scope can run status', () => {
    const token: ScopedToken = { id: 't1', scopes: [Scope.Meta] };
    expect(checkPermission(token, 'status')).toEqual({ allowed: true });
  });

  test('token with meta scope cannot run text', () => {
    const token: ScopedToken = { id: 't1', scopes: [Scope.Meta] };
    const result = checkPermission(token, 'text');
    expect(result.allowed).toBe(false);
  });

  test('token with multiple scopes has union of permissions', () => {
    const token: ScopedToken = { id: 't1', scopes: [Scope.Read, Scope.Write] };
    expect(checkPermission(token, 'text')).toEqual({ allowed: true });
    expect(checkPermission(token, 'click')).toEqual({ allowed: true });
    const result = checkPermission(token, 'js');
    expect(result.allowed).toBe(false);
  });

  test('unknown command is denied', () => {
    const token: ScopedToken = { id: 't1', scopes: [Scope.Read, Scope.Write, Scope.Admin, Scope.Meta] };
    const result = checkPermission(token, 'nonexistent-cmd');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('unknown');
  });
});

// ─── Sidebar Agent Token ────────────────────────────────────────

describe('Sidebar agent restrictions', () => {
  const sidebarToken: ScopedToken = {
    id: 'sidebar',
    scopes: [Scope.Read, Scope.Write, Scope.Meta],
    // No admin scope — sidebar cannot run dangerous commands
  };

  test('sidebar can run text', () => {
    expect(checkPermission(sidebarToken, 'text')).toEqual({ allowed: true });
  });

  test('sidebar can run click', () => {
    expect(checkPermission(sidebarToken, 'click')).toEqual({ allowed: true });
  });

  test('sidebar can run screenshot', () => {
    expect(checkPermission(sidebarToken, 'screenshot')).toEqual({ allowed: true });
  });

  test('sidebar cannot run js', () => {
    expect(checkPermission(sidebarToken, 'js').allowed).toBe(false);
  });

  test('sidebar cannot run cookie', () => {
    expect(checkPermission(sidebarToken, 'cookie').allowed).toBe(false);
  });

  test('sidebar cannot run storage (admin scope)', () => {
    expect(checkPermission(sidebarToken, 'storage').allowed).toBe(false);
  });

  test('sidebar cannot run eval', () => {
    expect(checkPermission(sidebarToken, 'eval').allowed).toBe(false);
  });

  test('sidebar cannot run stop', () => {
    expect(checkPermission(sidebarToken, 'stop').allowed).toBe(false);
  });
});

// ─── Domain Restrictions ────────────────────────────────────────

describe('Domain matching', () => {
  test('exact domain match', () => {
    expect(matchesDomain('example.com', ['example.com'])).toBe(true);
  });

  test('wildcard subdomain match', () => {
    expect(matchesDomain('sub.example.com', ['*.example.com'])).toBe(true);
  });

  test('wildcard does not match base domain', () => {
    expect(matchesDomain('example.com', ['*.example.com'])).toBe(false);
  });

  test('no match returns false', () => {
    expect(matchesDomain('evil.com', ['example.com', '*.safe.org'])).toBe(false);
  });

  test('empty domain list matches nothing', () => {
    expect(matchesDomain('example.com', [])).toBe(false);
  });
});

describe('Domain-restricted permissions', () => {
  const restrictedToken: ScopedToken = {
    id: 'restricted',
    scopes: [Scope.Read, Scope.Write],
    domains: ['*.example.com', 'safe.org'],
  };

  test('allowed on matching domain', () => {
    const result = checkPermission(restrictedToken, 'text', 'https://sub.example.com/page');
    expect(result.allowed).toBe(true);
  });

  test('allowed on exact domain', () => {
    const result = checkPermission(restrictedToken, 'click', 'https://safe.org/path');
    expect(result.allowed).toBe(true);
  });

  test('blocked on non-matching domain', () => {
    const result = checkPermission(restrictedToken, 'text', 'https://evil.com/steal');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('domain');
  });

  test('meta commands bypass domain restrictions', () => {
    const metaToken: ScopedToken = {
      id: 'meta',
      scopes: [Scope.Meta],
      domains: ['*.example.com'],
    };
    // status doesn't care about current URL
    const result = checkPermission(metaToken, 'status');
    expect(result.allowed).toBe(true);
  });

  test('no URL provided with domain restriction blocks non-meta commands', () => {
    const result = checkPermission(restrictedToken, 'text');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('domain');
  });
});

// ─── Rate Limiting ──────────────────────────────────────────────

describe('Rate limiting', () => {
  let registry: TokenRegistry;

  beforeEach(() => {
    registry = new TokenRegistry();
  });

  test('requests within rate limit are allowed', () => {
    const token: ScopedToken = { id: 'limited', scopes: [Scope.Read], rateLimit: 5 };
    registry.register(token);

    for (let i = 0; i < 5; i++) {
      expect(registry.checkRateLimit('limited')).toBe(true);
    }
  });

  test('requests over rate limit are rejected', () => {
    const token: ScopedToken = { id: 'limited', scopes: [Scope.Read], rateLimit: 3 };
    registry.register(token);

    expect(registry.checkRateLimit('limited')).toBe(true);
    expect(registry.checkRateLimit('limited')).toBe(true);
    expect(registry.checkRateLimit('limited')).toBe(true);
    expect(registry.checkRateLimit('limited')).toBe(false);
  });

  test('rate limit resets after window expires', async () => {
    const token: ScopedToken = { id: 'limited', scopes: [Scope.Read], rateLimit: 2 };
    registry = new TokenRegistry(100); // 100ms window for testing
    registry.register(token);

    expect(registry.checkRateLimit('limited')).toBe(true);
    expect(registry.checkRateLimit('limited')).toBe(true);
    expect(registry.checkRateLimit('limited')).toBe(false);

    await Bun.sleep(150);

    expect(registry.checkRateLimit('limited')).toBe(true);
  });

  test('token without rate limit is always allowed', () => {
    const token: ScopedToken = { id: 'unlimited', scopes: [Scope.Read] };
    registry.register(token);

    for (let i = 0; i < 100; i++) {
      expect(registry.checkRateLimit('unlimited')).toBe(true);
    }
  });

  test('unknown token fails rate limit check', () => {
    expect(registry.checkRateLimit('nonexistent')).toBe(false);
  });
});

// ─── Token Registry ─────────────────────────────────────────────

describe('TokenRegistry', () => {
  let registry: TokenRegistry;

  beforeEach(() => {
    registry = new TokenRegistry();
  });

  test('register and retrieve token', () => {
    const token: ScopedToken = { id: 'test', scopes: [Scope.Read] };
    registry.register(token);
    expect(registry.get('test')).toEqual(token);
  });

  test('get returns null for unknown token', () => {
    expect(registry.get('nonexistent')).toBeNull();
  });

  test('revoke removes token', () => {
    const token: ScopedToken = { id: 'test', scopes: [Scope.Read] };
    registry.register(token);
    registry.revoke('test');
    expect(registry.get('test')).toBeNull();
  });

  test('createFullAccessToken returns all scopes', () => {
    const token = registry.createFullAccessToken('admin-cli');
    expect(token.scopes).toContain(Scope.Read);
    expect(token.scopes).toContain(Scope.Write);
    expect(token.scopes).toContain(Scope.Admin);
    expect(token.scopes).toContain(Scope.Meta);
    expect(token.domains).toBeUndefined();
    expect(token.rateLimit).toBeUndefined();
  });

  test('createSidebarToken has read+write+meta but not admin', () => {
    const token = registry.createSidebarToken('sidebar-1');
    expect(token.scopes).toContain(Scope.Read);
    expect(token.scopes).toContain(Scope.Write);
    expect(token.scopes).toContain(Scope.Meta);
    expect(token.scopes).not.toContain(Scope.Admin);
  });
});

// ─── Backward Compatibility ─────────────────────────────────────

describe('Backward compatibility', () => {
  test('legacy auth token (plain string) gets full access via createFullAccessToken', () => {
    const registry = new TokenRegistry();
    const token = registry.createFullAccessToken('legacy-uuid-token');
    registry.register(token);

    // Should be able to do anything
    expect(checkPermission(token, 'js')).toEqual({ allowed: true });
    expect(checkPermission(token, 'cookie')).toEqual({ allowed: true });
    expect(checkPermission(token, 'text')).toEqual({ allowed: true });
    expect(checkPermission(token, 'click')).toEqual({ allowed: true });
    expect(checkPermission(token, 'status')).toEqual({ allowed: true });
    expect(checkPermission(token, 'stop')).toEqual({ allowed: true });
    expect(checkPermission(token, 'storage')).toEqual({ allowed: true });
  });
});

// ─── Server Integration (source-level) ──────────────────────────

import * as fs from 'fs';
import * as path from 'path';

const SERVER_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/server.ts'), 'utf-8');

describe('Server integration', () => {
  test('server imports token-registry', () => {
    expect(SERVER_SRC).toContain("import { TokenRegistry, checkPermission");
  });

  test('server creates tokenRegistry and full-access main token', () => {
    expect(SERVER_SRC).toContain('new TokenRegistry()');
    expect(SERVER_SRC).toContain('createFullAccessToken(AUTH_TOKEN)');
  });

  test('handleCommand accepts a ScopedToken parameter', () => {
    expect(SERVER_SRC).toContain('handleCommand(body: any, token: ScopedToken)');
  });

  test('handleCommand calls checkPermission before dispatch', () => {
    // Permission check must appear BEFORE the browser readiness gate
    const permIdx = SERVER_SRC.indexOf('checkPermission(token, command');
    const browserReadyIdx = SERVER_SRC.indexOf('await browserReady', permIdx > 0 ? 0 : undefined);
    expect(permIdx).toBeGreaterThan(-1);
    // Permission check comes before browserReady (fast-fail on denied commands)
    expect(permIdx).toBeLessThan(SERVER_SRC.indexOf('await browserReady', permIdx));
  });

  test('handleCommand returns 403 on permission denial', () => {
    expect(SERVER_SRC).toContain('status: 403');
    expect(SERVER_SRC).toContain('Permission denied');
  });

  test('handleCommand checks rate limit', () => {
    expect(SERVER_SRC).toContain('checkRateLimit(token.id)');
    expect(SERVER_SRC).toContain('status: 429');
  });

  test('/command endpoint extracts token from request', () => {
    expect(SERVER_SRC).toContain('getTokenFromRequest(req)');
  });
});
