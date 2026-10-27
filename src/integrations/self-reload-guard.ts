interface Events {
	on(event: string, handler: (data: unknown) => void): () => void;
}

/** Read-only synchronous readiness query. Never stops jobs or grants reload permission. */
export function registerSelfReloadGuard(events: Events, session: () => string | null, busy: () => boolean): () => void {
	return events.on('optchat:reload-check', (value) => {
		if (!value || typeof value !== 'object') return;
		const query = value as { sessionId?: unknown; respond?: unknown };
		if (typeof query.sessionId !== 'string' || typeof query.respond !== 'function') return;
		const reason = query.sessionId !== session() ? 'pi-subagents ownership is not ready for reload.'
			: busy() ? 'pi-subagents has active subagent work; wait for its completion before reload.' : undefined;
		query.respond('pi-subagents', reason);
	});
}
