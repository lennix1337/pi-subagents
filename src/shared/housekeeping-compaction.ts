/**
 * A housekeeping compaction only trims Pi's in-memory context (started by the host, e.g. pi-optchat);
 * the agent's task is untouched, so it must neither re-drive the parent nor reset watchdog state.
 */
export function isHousekeepingCompaction(event: { compactionEntry?: { details?: unknown } }): boolean {
	const details = event.compactionEntry?.details;
	return typeof details === "object" && details !== null && (details as { housekeeping?: unknown }).housekeeping === true;
}
