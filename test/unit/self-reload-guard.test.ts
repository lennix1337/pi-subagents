import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerSelfReloadGuard } from '../../src/integrations/self-reload-guard.ts';

test('readiness query reports current ownership and active work without stopping it', () => {
  let listener: (value: unknown) => void = () => {}, active = true, session: string | null = 'session-1', unsubscribed = false;
  const events = { on(name: string, handler: (value: unknown) => void) { assert.equal(name, 'optchat:reload-check'); listener = handler; return () => { unsubscribed = true; }; } };
  const release = registerSelfReloadGuard(events, () => session, () => active);
  const results: unknown[] = [];
  const query = (sessionId: string) => listener({ sessionId, respond: (...args: unknown[]) => results.push(args) });
  query('session-1'); assert.match(JSON.stringify(results.pop()), /active subagent work/i); assert.equal(active, true);
  active = false; query('session-1'); assert.deepEqual(results.pop(), ['pi-subagents', undefined]);
  query('another-session'); assert.match(JSON.stringify(results.pop()), /ownership/i);
  session = null; query('session-1'); assert.match(JSON.stringify(results.pop()), /ownership/i);
  listener(null); listener({}); assert.equal(results.length, 0);
  release(); assert.equal(unsubscribed, true);
});
