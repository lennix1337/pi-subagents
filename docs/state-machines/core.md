# Implicit state machines: pi-subagents core

Scope: everything in `pi-subagents` except `src/runs/**` (run lifecycle, runner, async status writers, which are catalogued separately by the worker that owns that slice). Covers `src/shared`, `src/watchdog`, `src/extension`, `src/workflows`, `src/agents`, `src/inspectors`, `src/api`, `src/slash`, `src/tui`, `src/missions`, `src/intercom`, `src/integrations`, `src/profiles`, `src/policy` and the root `*.mjs` entry points.

Method: a read of every module that holds lifecycle state (status or phase fields, boolean clusters, timers, persisted JSON with a status field, retry or lease logic, handshakes) plus grep sweeps for `setTimeout`/`setInterval`, string unions, `.state =` / `.status =` and `JSON.parse`. Machines that are explicit and correct are catalogued without change. Line numbers refer to `origin/main` at `487cb8eb` unless the finding says it was fixed.

Severity: P1 data loss, wrong authority or wrong account/model; P2 stuck or silently wrong state a user can hit; P3 latent, theoretical or cosmetic.

Finding ids: `C-<machine number>.<n>`. **Fixed** findings have a regression test that fails without the fix (see the summary at the end).

---

## 1. Launch-model route handshake

- Files: `src/shared/model-route.ts:28` (`installModelRouteBus`), `:42` (`routeLaunchModel`); consumer `src/runs/shared/model-resolution.ts:465` (`resolveModelSelection`) and `:505` (`acceptableRoute`); bus installed in `src/extension/index.ts`.
- Purpose: a configured or inherited child model is offered to the parent's account manager (pi-multi-account) on `pi:model-route:request:v1`. The manager mutates `request.result`; the child launches on the answer. An explicitly requested model is never offered.
- States of one request: `no bus` / `bus bound` → `no answer` | `keep` | `route{provider,id,reason}` → `accepted` | `ignored` (replacement unknown to this session's registry, inside no enforced `modelScope`, equal to the asked model, or malformed).
- State lives in: one module-level `emit` binding (memory, per runtime, last binder wins; a stale uninstall cannot unbind a newer runtime), plus the request object on the synchronous bus.
- Readers: `resolveModelSelection` from preflight (`src/api/preflight.ts:419`), foreground (`src/runs/foreground/execution.ts:1873`) and async launch (`src/runs/background/async-execution.ts:1230`, `:2090`).
- Invariants: explicit models never move (`resolveModelSelection` checks `origin !== "explicit"`); thinking suffix is preserved; the replacement must be a registry model and pass every enforced scope; a throwing bus or a malformed answer means "keep".

Findings

- **C-1.1 (P2, catalogued only)** The route is silent in the run record. `resolveModelSelection` returns `routedFrom` and `routeReason` (`model-resolution.ts:474`), but every consumer destructures only `model`/`requestedModel` (`foreground/execution.ts:1873`, `async-execution.ts:1235`, `:2095`, `preflight.ts:419`). A routed child therefore shows `model != requestedModel` with no reason, which is how child `f50dec5c` (requested `openai-codex-account-2/gpt-6.1-terra:low`, ran `anthropic/claude-opus-5-5:low`) looked like an unexplained swap. Fix needs edits in `src/runs/**` (owned by another worker): thread `routedFrom`/`routeReason` into the single result/status and the intercom or event notice. Do it after both PRs land.
- **C-1.2 (P3, catalogued only)** The same launch asks the bus up to twice (preflight, then the launch), so a manager whose answer changes between the calls (a spent flag flipping) can make preflight report a different model than the one launched. The answer is not carried from preflight into the launch.
- **C-1.3 (investigation, not a pi-subagents bug)** The Opus swap of `f50dec5c` is the documented route (`docs/models.md:16`) answering with a wrong target. The manager picked another account's Opus from the saved default instead of preferring the parent session's account at the same quality band. That is a pi-multi-account defect, already fixed there by lennix1337/pi-multi-account PR #12. pi-subagents behaved per contract: the model resolver (`agents.ts:1261-1412`) only parses `subagents.*` settings and does no fallback. No pi-subagents code change; the silent presentation is C-1.1.

---

## 2. Native supervisor request lifecycle (file mailbox)

- File: `src/intercom/native-supervisor-channel.ts` (`SupervisorRequestLifecycle` at `:499`, `requestLifecycle` at `:520`, `refreshPendingRequests`, `createNativeSupervisorChannel` at `:680`).
- Persisted state: `<tmp>/supervisor-channels/<run>-<agent>-<idx>/requests/<id>.json` (request, optional `expiresAt`) and `replies/<id>.json` (reply or transport `error`). Memory: `pending` map, `seenFiles`, `requestCorrelations` (bounded to 256, 10 min retention).
- States: `pending → resolved | expired | inactive | missing | wrong-session`. `requestLifecycle` derives the state from the filesystem on every poll, so there is no stored enum to drift. `resolved/expired/inactive` delete the request file.
- Events: child writes request; parent poll discovers it; `subagent_supervisor reply` writes the reply; deadline passes; run ends; owner session changes.
- Transitions are one-way and computed: reply file exists → `resolved`; `now > expiresAt` → `expired`; run terminal → `inactive`. The owner extends `expiresAt` while Pi holds the notice (`extendQueuedNotices`), and the child re-reads it (`extendedDeadline`).
- Invariants: a request id is registered once (`seenFiles`); a reply written for a request whose file vanished still resolves for the child; progress updates never create a pending entry.

Findings

- **C-2.1 (P3, catalogued only)** `waitForReply` (`:191`) calls `JSON.parse` on the reply file without guarding the parse. The reply is written atomically, so this needs a foreign writer; a corrupt reply throws a `SyntaxError` to the child instead of the transport error.
- **C-2.2 (P3)** The child deletes its request file on any wait failure (`catch` in `sendSupervisorRequest`), including abort. A reply that arrives after that is orphaned in `replies/` until stale-channel cleanup; the parent's `pending` entry disappears on its next poll (`missing`). Correct, but the reply is not reported to the supervisor as late.

## 3. Supervisor settle reminders and queued-notice extension

- File: `src/intercom/native-supervisor-channel.ts:703` (`settleNotices`), `:707` (`queuedNotices`), `handleBeforeSettle`, `updateSettleSubscription`, `updateDeliverySubscription`.
- `settleNotices`: per request `∅ → reminded → warned`, or `∅ → handled` (parent acted). Exactly one reminder and one blocked notice per request; `handled` and `warned` are terminal and excluded from the request filter.
- `queuedNotices`: notice queued behind a busy run; cleared by `message_start` for that request, by `agent_settled`, by lifecycle end, by a failed renewal, or on dispose.
- Subscriptions are created only while needed (`needed` predicate) and torn down when it turns false.
- Explicit and correct; no finding. `dispose()` clears every map and unsubscribes.

## 4. Supervisor transport (watchers and pollers)

- File: `src/intercom/native-supervisor-channel.ts:765` onward (`started`, `poller`, `safetyPoller`, `deferredWatcherRefresh`, `rootWatcher`, `requestWatchers`, `lastStaleCleanupAt`).
- Flags `started` + four optional handles encode: `stopped` | `started, demand-gated` | `started, polling` | `started, native-watch`. Transitions: `start()`, `activateTransport()` (demand), watcher `error` → `startPolling`, the poller self-stops when `hasTransportDemand()` is false and no native watcher exists, `dispose()` clears everything.
- Invariant: handles are cleared with `timers.clear*` through the injected timers (tests use fakes).
- Finding **C-4.1 (P3, catalogued only)**: a demand-gated poller that stops on "no demand" restarts only through `activateTransport`. A launch path that forgets to call it loses wakes until the 5 s safety poll, which exists only for native watchers. Every current launch path calls `activateTransport` (`extension/index.ts` `activateSupervisorTransport`), so this is a contract note, not a reachable bug.

## 5. Parent wake reservation

- File: `src/shared/parent-wake.ts:42` (`createParentWake`). State: `held` (user abort) and a process-global `WeakMap<sessionManager, {sessionId, sentAt}>` shared with pi-intercom's idle wake (`Symbol.for("pi.idle-wake.v1")`).
- States: `free` → `reserved(sentAt)` → (`agent_start`) `free`; `held` ← `userAborted`, cleared by `agentStarted`/`releaseHold`/`bindSession`. A reservation older than 10 s stops counting as pending unless the parent is still busy.
- Time is the third state input (`now() - sentAt < WAKE_PENDING_MS`); the clock is injected for tests.
- Explicit enough; no finding. `sessionShutdown("reload")` intentionally keeps the reservation for the next runtime.

## 6. Workflow resume claim (generation files)

- File: `src/workflows/workflow-resume-claim.ts` (`readTopClaim`, `claimWorkflowResume:163`, `releaseWorkflowResumeClaim`, `workflowResumeClaimState`).
- Persisted state: `resumed-by.<n>.json` in the stopped run's directory; highest `n` is the claim; a release renames to `.released-<uuid>`; `resume-refused.json` records a refusal. In-memory: process-global `heldClaims` set.
- States of the top claim: `open` (none, released or corrupt) | `claim(live owner)` | `claim(dead owner)` | `resumed` (new run's `status.json` exists, permanent) | `unreadable` (fail closed).
- Transitions: claim = exclusive `link()` of generation `n+1`; takeover only when the claimant is dead; release only by the owner; every transition is a single filesystem operation and the loser re-reads. Bounded to 8 rounds, then fails closed.
- Explicit, race-aware, well tested; no finding. Persisted claim JSON is validated (`isClaim`).

## 7. Workflow auto-resume entry

- Files: `src/workflows/workflow-auto-resume.ts:22` (`PendingWorkflowAutoResume.state`), `src/extension/index.ts:681` (`launchWorkflowAutoResume`).
- States `pending → started | cancelled`, writers: `workflow-auto-resume.ts:42` (cancel), `extension/index.ts:689` (start, guarded by `entry.state !== "pending"`). A cancelled entry is kept so the next scan reuses its run id; `finishWorkflowAutoResume` deletes non-cancelled ones.
- Invariant: only a `pending` entry can be cancelled or started; the check and the write are in the same synchronous step after the last `await`.
- **C-7.1 (P3, catalogued only)** `state` is a public mutable field with two writers and no transition function. A third writer could skip the guard. Not worth a wrapper now.

## 8. Workflow permits (child launch and resource)

- File: `src/shared/workflow-child-permit.ts` (`WorkflowChildPermitRecord.state` `available → claimed → consumed`; resource permit `available → consumed`).
- Kept in `WeakMap`s, mutated only inside the claim/consume functions; every function rejects a non-`available` permit and consumes it on mismatch ("fail-consumed"). Explicit and correct; no finding.

## 9. Main watchdog runtime (review state)

- File: `src/watchdog/runtime.ts:129` (`MainWatchdogRuntime`). Fields: `status` (`WATCHDOG_RUNTIME_STATUSES`), `reviewing`, `waitingAtAgentEnd`, `midRunReviewing`, `disposed`, `epoch`, `activeReviewId`, `activeAgentEndId`, `activeReviewAbortController`, `activeAgentEndAbortController`, `midRunGeneration`, `waiters[]`.
- Meaning of the cluster: a boundary review is `idle → queued (deltas buffered) → [waitingAtAgentEnd: LSP pre-pass] → reviewing → idle | stale | failed`; a cadence review is `midRunReviewing` + `reviewing` and is superseded by the boundary review (`cancelMidRunReview`). `epoch` invalidates in-flight work on every `reset`/`invalidateActiveReview`/`dispose`; `isAgentEndCurrent` and `isCurrent` compare ids against it.
- Events: `handleBeforeAgentStart` (reset), `handleTurnEnd` (enqueue), `handleToolResult` (cadence), `handleAgentEnd` (boundary), `handleUserInput`/`handleModelChange` (reset when clarification is on), `refreshConfig` (invalidate on disable), review timeout, `dispose`.
- Invariants: `midRunReviewing ⇒ reviewing` (except for the instant before `reviewDelta`); `waitingAtAgentEnd ⇒ activeAgentEndId !== undefined`; `reviewing ⇒ activeReviewId !== undefined`; `disposed` is absorbing; a callback whose epoch/id no longer matches never writes.

Findings

- **C-9.1 (P2→fixed)** `status` could stay `"reviewing"` after the review had ended. `reviewDelta` sets `status = "reviewing"` but its `finally` cleared only `reviewing`, `activeReviewId` and the warning. When a review ended with no usable result (an injected review returning nothing, or a boundary review superseded by a second `agent_end`), `handleAgentEnd` took no branch that resets the status, so the snapshot, `/watchdog status` and the stale-warning logic saw a review that was no longer running, until the next `reset`. Fix: `reviewDelta`'s `finally` sets `status` to `queued`/`idle` when the finishing review still owns the state (`src/watchdog/runtime.ts:696`). Test: `returns to idle when a review yields no result instead of staying reviewing` in `test/unit/watchdog-runtime.test.ts` (fails with `actual: 'reviewing'` without the fix).
- **C-9.2 (P3, catalogued only)** `WATCHDOG_RUNTIME_STATUSES` contains `"waiting-at-agent-end"` (`src/watchdog/types.ts:30`) that no code path assigns; the state is carried by the `waitingAtAgentEnd` boolean instead. A reader switching on `status` can never see it. Removing it is a type change for `register-main.ts` `statusLabel`; left for a follow-up.
- **C-9.3 (P3, catalogued only)** Three booleans plus `status` encode one lifecycle, and `invalidateActiveReview`, `reset`, `dispose` and `cancelMidRunReview` each re-assign overlapping subsets by hand. The epoch/id guards make the sequence safe today; the lasting fix is a `phase` union (`idle | collecting | reviewing{kind} | settled`) with one `transition()`. It was not done here: the class is 930 lines with 51 tests that pin the observable status values, and a rewrite would be a large diff for no current defect beyond C-9.1.

## 10. Watchdog permission arbiter

- File: `src/watchdog/permission-arbiter.ts:42`. A call races `run()` against a timeout and an abort; `decision` is recorded once (`if (!decision) decision = params`); `finish()` is the single result constructor; the `finally` clears the timer and abort listeners. A late decision after a timeout is discarded. Fails closed. Explicit and correct; no finding.

## 11. Host command runner (workflow `runs.host`)

- File: `src/workflows/host-command.ts:153` (`executeWorkflowHostCommand`). Was: `timedOut`, `stopped`, `settled` booleans plus a memoised `termination` promise.
- States: `running → terminating(timeout | abort) → settled(passed | failed | timed-out | stopped)`.
- **C-11.1 (P2→fixed)** `terminate()` overwrote the cause on every call (`timedOut = reason === "timeout"; stopped = reason === "abort"`) while `termination ??=` kept only the first termination. A workflow abort arriving while a timed-out command was still being killed flipped the reported outcome from `timed-out` to `stopped` (and the converse), so the evidence named a cause that did not kill the process and a timeout could be hidden behind an abort. Fix: a single `stopReason` set once (`host-command.ts:171`, `:186`). Test: `keeps the timed-out outcome when the workflow aborts while the timed-out command is still being terminated` in `test/unit/host-command.test.ts` (fails without the fix).

## 12. Scripted workflow script run (settle)

- File: `src/workflows/scripted-workflow.ts:2174` (`settled`, `finishing`, `assemblyAbortRequested`, `assemblyFlushTimer`, `timer`, `abortError`, `finish` at `:2269`).
- Phases: `running → assembly-flush (abort seen, all children settled, host allows flush) → finishing (worker told to stop, waiting for steer/host promises) → settled`. `finish()` is the only transition and rejects re-entry (`if (settled || finishing) return`); `onAbort` ignores a second abort once finishing; every timer is cleared in `finish`.
- `assemblyAbortRequested` is a sticky modifier, not a phase: it stays true through `finishing`, and a `call` message in that window returns through `finish` without a response (`:2416`). Collapsing the three flags into one enum would change that behaviour, so they are left as is. No finding.

## 13. Extension runtime lifecycle (`runtimeCleaned`)

- File: `src/extension/index.ts:1059` (`runtimeEntry.cleanup`), `installRuntime`, timers `resultIndexCleanupTimer`, `asyncRetentionTimer`, `modulePreloadTimer`, `compactionResumeTimer`.
- States: `fresh → installed(session) → cleaned`. `cleanup()` is idempotent via `runtimeCleaned`; `installRuntime` throws on a cleaned runtime; every timer is cleared, then set to `undefined`; maintenance timers are `unref`ed and one-shot (`startSessionMaintenance` sets each once).
- A runtime replaced by a reload is cleaned by the new one (`previousRuntime.cleanup()`), and a late auto-resume checks `runtimeCleaned` after launch.
- **C-13.1 (P3, catalogued only)** `compactionResumeTimer` (`:1168`) is cleared on `agent_start` and `session_shutdown` but not by `cleanup()` when a reload cleans the previous runtime without a shutdown event; the timer re-checks `state.currentSessionId`, which `cleanup()` sets to `null`, so it exits on its first tick. Bounded, harmless.

## 14. Compaction resume poll

- File: `src/extension/index.ts:1168`–`1223`. A deadline-bounded poll (`COMPACTION_RESUME_DEADLINE_MS`): `idle → waiting(timer) → fired | cancelled`. Cancelled by `agent_start`, a newer compaction, or shutdown; exits when the session id changes or no async job is active. Explicit; no finding.

## 15. Mission record (`MissionStatus` + goal)

- Files: `src/missions/types.ts:3` (`MISSION_STATUSES`: planned, active, waiting, needs_decision, completed, failed, cancelled), `src/missions/store.ts:460` (`updateMission`, the single writer), `src/missions/lifecycle.ts:140` (`missionStatusForRun`), `src/missions/goal-driver.ts:58` (`refreshGoalMission`), `src/missions/actions.ts` (user updates).
- Persisted: `<missionDir>/<id>.json` plus a global index entry, written with `writePrivateAtomicJson`; every read goes through `parseMissionRecord` (validates schema version, status enum, goal status).
- Goal sub-state `goal.status`: `active ↔ budget-exhausted` recomputed from `usage` vs `budget` on every `updateMission`; `paused` by explicit update.
- Transitions: derived from run status in `missionStatusForRun` (terminal states are sticky there), from decisions in `updateMission` (`open decision ⇒ needs_decision`), or set explicitly.
- Findings
  - **C-15.1 (P3, catalogued only)** `updateMission` accepts an explicit `status` that leaves a terminal state (`completed → active`). The lifecycle code never does it, `refreshGoalMission` is guarded by its `listed` terminal filter, but that filter reads a snapshot taken before `readMission`, so a mission that turned terminal in between can be set back to `active` by the goal driver (`goal-driver.ts:58`, status expression `active ? "active" : record.goal ? "active" : record.status`). Narrow window, same process (the updates are synchronous).
  - **C-15.2 (P3, catalogued only)** `updateMission` is an unlocked read-modify-write of one JSON file. Inside one Pi process it is atomic (synchronous), across two Pi processes on the same project two updates can lose one (atomic rename, no lease). `withFileLease` (`src/shared/file-lease.ts`) exists and fits; not added because no cross-process writer is known in this package.

## 16. Capacity-resilient JSON writer

- File: `src/shared/capacity-resilient-json.ts:36`. Map of newest payload per path + one retry timer. States per path: `written | pending(capacity error) | dropped(non-capacity error on retry) | disposed`. A newer ordinary write supersedes a pending one; `dispose()` drops pending payloads and clears the timer. Explicit and correct; no finding. Data loss on `dispose()` with pending writes is the documented contract.

## 17. File coalescer

- File: `src/shared/file-coalescer.ts:17`. One timer per file: `idle → scheduled → fired | flushed | cleared`. Explicit and correct.
- **C-17.1 (P3, catalogued only)** A throwing `handler` runs inside the timer callback, after the entry was deleted, so the exception is uncaught in the host. Its two callers (`src/runs/background/result-watcher.ts:667`, `src/runs/background/subagent-runner.ts:2281`) are in the other slice; both handlers catch internally today.

## 18. JSONL mirror writer

- File: `src/shared/jsonl-writer.ts:27`. `backpressured`, `closed`, `stream`, `bytesWritten`. A stream `error` closes the writer and resumes the source.
- **C-18.1 (P3, catalogued only)** `close()` while `backpressured` never resumes the source (the `drain` listener returns early on `closed`). The only caller passes no-op `pause/resume` (`src/runs/foreground/execution.ts:595`), so nothing can stall today.

## 19. File lease (`tryLease`)

- File: `src/shared/file-lease.ts:35`. Lock directory + `owner.json {token,pid,hostname,processStart}`; a dead owner is retired by rename (fenced by `.retired-<token>`); release removes the lock only if the token still matches. Unknown owners and live PIDs are never evicted. Explicit and correct; no finding.

## 20. Herdr status bridge

- File: `src/integrations/herdr-status.ts:132`. Flags `rootSession`, `published`, `busyRaised`, `busyLabel`, `disposed`, `draining`, `pendingReport`, `refreshTimer`, maps `runs`/`attentionRuns`/`acknowledgedAttention`.
- Report delivery is last-writer-wins (`pendingReport`, one drain loop); `published` and `busyRaised` are idempotent edge flags guarded by the run set; `dispose()` clears attention, runs, busy and the timer before `disposed = true`, then publishes a clear.
- Explicit enough: the flags are derived from `runs.size` and re-synced on every event. No finding.

## 21. Program status reporter (OSC 7501)

- File: `src/integrations/program-status.ts:131`. `active`, `parentIdle`, `unansweredAtSettle`, `sent` map, `listeningForResume`. Desired records are recomputed from the job list on every `sync` and only the diff is written; `dispose` clears them unless the session is quitting. `programState()` is an exhaustive switch over `AsyncJobState["status"]`. Explicit and correct; no finding.

## 22. Nested control inbox listener

- File: `src/extension/fanout-child.ts:84`. Per request id: `seen | inFlight | pendingResults`. A request is processed once, the result write is retried from `pendingResults` when it fails, the request file is unlinked after the result is durable. `seen` is unbounded but request ids are per run.
- Explicit and correct; no finding.

## 23. Slash request bridge (`requestSlashRun`)

- File: `src/slash/slash-commands.ts:360`. `done`, `started`, `startTimeout`, three event subscriptions, a terminal-input hook, an abort listener; `finish()` is the single exit and is idempotent.
- **C-23.1 (P3, catalogued only)** A non-stale error thrown by `pi.events.emit` inside the executor (`:458`) rethrows without calling `finish`, so the subscriptions and the terminal-input hook stay until the 15 s start timeout calls `finish`. Bounded leak, and `emit` rarely throws.

## 24. Result intercom delivery handshake

- File: `src/intercom/result-intercom.ts:332` (`deliverSubagentIntercomMessageEvent`). Request id correlation, one `settled` flag, timer + unsubscribe in `finish`, `emit` throw handled. Explicit and correct; no finding.

## 25. Persisted run status (`status.json`) as read by the shared helper

- File: `src/shared/utils.ts:140` (`readStatus`, mtime/ctime/size/ino cache of 512 entries).
- State field: `AsyncStatus.state` (`queued | running | complete | failed | partial | paused | stopped | rejected`), written by `src/runs/**`; read by about 23 call sites outside `src/runs` (missions, inspectors, TUI, watchdog, workflows, supervisor channel).
- **C-25.1 (P2, catalogued only, cross-slice)** `readStatus` does `JSON.parse(content) as AsyncStatus` and validates only lane metadata. A status file whose `state` is missing or not in the union (a hand edit, a newer or older writer) is accepted and then compared with `===` by every reader, so it silently behaves as "some other state" (never terminal, never active). Throwing here would hide older runs from listings, and the state vocabulary belongs to the `src/runs/**` machine, so the validator is left for the slice owner (it needs the same union as the writer's single transition function).

## 26. Agent definition directory state

- File: `src/agents/agents.ts:312` (`AgentDefinitionDirectoryState`: absent, empty, candidates, unreadable, not-directory). A classification computed from the filesystem on each discovery, not a stored lifecycle. `readSettingsFileStrict` and `parseSubagentSettings` (`agents.ts:1241`–`1412`) validate every persisted setting and throw on a wrong type. No finding.

## 27. Model verification evidence (`resolveModelSelection` origin)

- File: `src/runs/shared/model-resolution.ts:420`–`541`, `ModelOrigin = explicit | inherited | configured`. Computed per launch by `resolveModelOrigin` (stored origin wins), not stored in a machine. Mentioned because it gates machine 1. No finding beyond C-1.1/C-1.2.

## Reviewed, no lifecycle machine worth a change

- `src/tui/fleet.ts:861` (`scheduleRefresh`: `refreshTimer`/`disposed`, reschedules in `finally`, unref'd) and `src/tui/fleet-status.ts:610` (single interval cleared by `clearUiRegistration`): explicit. A throwing `refresh()` is not caught inside the timer in `fleet.ts` (theoretical P3; `collectFleetSnapshot` catches around its status reads).
- `src/inspectors/inspector-runner.ts:123` (render interval stops when the run is terminal), `src/watchdog/lsp-diagnostics.ts` (per-call timers cleared in the same function), `src/agents/global-npm-root.ts` (timer cleared on exit).

## Not examined in depth

`src/extension/rpc.ts` (request/response bridge), `src/profiles/profiles.ts` probe states (`ProbeStatus`), `src/watchdog/lsp-diagnostics.ts` ledger, the many pure formatters in `src/tui`, `src/api/*` typings. They hold no timers or persisted status fields beyond what the grep sweeps showed; a deeper pass could still find P3s.

---

## Summary

| # | Machine | States | Explicitness before | After | Findings |
|---|---------|--------|--------------------|-------|----------|
| 1 | Launch-model route handshake | unbound, keep, route, accepted/ignored | explicit (bus result union) | unchanged | C-1.1 P2 (silent, needs `src/runs`), C-1.2 P3, C-1.3 root cause is pi-multi-account |
| 2 | Supervisor request lifecycle | pending, resolved, expired, inactive, missing, wrong-session | explicit (derived) | unchanged | C-2.1 P3, C-2.2 P3 |
| 3 | Supervisor settle notices | ∅, reminded, warned, handled | explicit | unchanged | none |
| 4 | Supervisor transport | stopped, demand-gated, polling, native-watch | 5 handles + `started` | unchanged | C-4.1 P3 |
| 5 | Parent wake reservation | free, reserved, held | explicit + clock | unchanged | none |
| 6 | Workflow resume claim | open, claim live/dead, resumed, unreadable | explicit (files) | unchanged | none |
| 7 | Workflow auto-resume entry | pending, started, cancelled | explicit, 2 writers | unchanged | C-7.1 P3 |
| 8 | Workflow permits | available, claimed, consumed | explicit | unchanged | none |
| 9 | Main watchdog runtime | idle, queued, reviewing, stale, failed (+dead `waiting-at-agent-end`) | `status` + 3 booleans + epoch | `reviewing` no longer sticks | C-9.1 P2 **fixed**, C-9.2 P3, C-9.3 P3 |
| 10 | Watchdog permission arbiter | decided, timeout, cancelled, malformed | explicit (`finish`) | unchanged | none |
| 11 | Host command runner | running, terminating(cause), settled(4) | 3 booleans | one `stopReason` set once | C-11.1 P2 **fixed** |
| 12 | Scripted workflow run | running, assembly-flush, finishing, settled | 3 flags + 2 timers, single `finish` | unchanged (orthogonal modifier) | none |
| 13 | Extension runtime lifecycle | fresh, installed, cleaned | explicit (`runtimeCleaned`) | unchanged | C-13.1 P3 |
| 14 | Compaction resume poll | idle, waiting, fired, cancelled | explicit | unchanged | none |
| 15 | Mission status + goal | 7 statuses, goal active/paused/budget-exhausted | enum + single writer + validated read | unchanged | C-15.1 P3, C-15.2 P3 |
| 16 | Capacity-resilient JSON writer | written, pending, dropped, disposed | explicit | unchanged | none |
| 17 | File coalescer | idle, scheduled, fired, flushed | explicit | unchanged | C-17.1 P3 |
| 18 | JSONL mirror writer | open, backpressured, closed | 3 flags | unchanged | C-18.1 P3 |
| 19 | File lease | free, held, retired | explicit | unchanged | none |
| 20 | Herdr status bridge | published, busy, disposed, draining | 8 flags, derived from `runs` | unchanged | none |
| 21 | Program status reporter | active, idle, blocked, sent diff | derived | unchanged | none |
| 22 | Nested control inbox | seen, inFlight, pendingResult | explicit | unchanged | none |
| 23 | Slash request bridge | pending, started, done | `done` + `started`, single `finish` | unchanged | C-23.1 P3 |
| 24 | Result intercom delivery | pending, delivered, timed out | explicit | unchanged | none |
| 25 | `status.json` read cache | cached, stale, invalid | untyped cast | unchanged | C-25.1 P2 (cross-slice, catalogued) |
| 26 | Agent directory state | 5-value classification | explicit (derived) | unchanged | none |

Fixed in this change: C-9.1, C-11.1. Catalogued only: every other finding, with the reason stated on each. The model swap of child `f50dec5c` is explained by C-1.3 and presented silently because of C-1.1.
