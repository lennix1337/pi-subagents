const SUCCESSION_KEY = Symbol.for("pi-subagents.session-succession");
const MAX_INHERITED_SESSIONS = 8;
const MAX_RECORDED_SESSIONS = 64;

type SuccessionGlobal = typeof globalThis & { [SUCCESSION_KEY]?: Map<string, readonly string[]> };

function successions(): Map<string, readonly string[]> {
	const runtime = globalThis as SuccessionGlobal;
	runtime[SUCCESSION_KEY] ??= new Map();
	return runtime[SUCCESSION_KEY];
}

/** Records that sessionId replaced previousSessionId in this process, inheriting its chain. */
export function recordSessionReplacement(sessionId: string, previousSessionId: string): void {
	const chain = [...new Set([previousSessionId, ...(successions().get(previousSessionId) ?? [])])].filter((id) => id !== sessionId);
	successions().delete(sessionId);
	successions().set(sessionId, chain.slice(0, MAX_INHERITED_SESSIONS));
	while (successions().size > MAX_RECORDED_SESSIONS) successions().delete(successions().keys().next().value!);
}

/** Sessions this process replaced on the way to sessionId, newest first; their runs belong to sessionId. */
export function inheritedSessionIds(sessionId: string): readonly string[] {
	return successions().get(sessionId) ?? [];
}
