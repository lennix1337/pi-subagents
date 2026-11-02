# Acting ahead (speculative fixes)

Acting ahead starts a background child when CI fails on one of your own PRs. The child works in its own worktree, tries to reproduce the failure and fix it, and the result is reported only when the harness confirms the fix. Anything else is discarded without a notice.

It is **off by default**. The package exposes the API; the extension does not start it yet.

## Configuration

`parseActingAheadConfig` validates a section with these fields. Unknown fields and out-of-range caps are refused.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Nothing runs unless this is `true`. |
| `owners` | `[]` | GitHub owners whose repositories may be speculated on. |
| `maxConcurrent` | `1` | Speculative runs at once (1 to 3). |
| `maxRuntimeMs` | 20 min | A run past this is stopped and its result discarded (1 min to 2 h). Verification counts toward it. |
| `cooldownMs` | 6 h | No new attempt on the same PR inside this window. |
| `testCommands` | `{}` | `owner/name` → argv, run without a shell. A repo without one is refused. |

## Admission

Rules run in order and the first refusal is returned with its reason: disabled; not a CI failure; owner not allowlisted; no test command; concurrency cap reached; already speculating on this PR; cooldown.

## Confirmation

The child's own report is not evidence. The harness:

1. refuses evidence with absolute or escaping paths, or a file listed as both fix and test;
2. requires a clean worktree;
3. runs the configured test command with the fix in place, which must pass;
4. reverts only the fix files to the base commit and runs the same command, which must fail;
5. restores the fix and checks the worktree is clean again. If it cannot restore, the result is not confirmed.

Only a confirmed fix produces one line for the operator.

## Cap and discard

The runtime cap stops the child and frees its slot. A result that arrives after the cap is ignored. Discards are kept in memory (`snapshot().discarded`) for the caller and are never announced.

## PR thread routing

A speculative child subscribes to its PR. Later watcher events for that PR (`gitwatch.pr-event` on the Pi event bus) are steered to the child. A merged or closed PR ends the subscription and the parent is also informed. Without a publisher, nothing is routed.

## Not yet wired

- No extension registration and no settings reader for the section above.
- The launcher that starts a child in a worktree and maps its result to an outcome is injected by the caller. It has no live implementation yet.
- The watcher does not publish events yet; pi-gitwatch has no subscriber.
