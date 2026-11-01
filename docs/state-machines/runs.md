# Implicit state machines in `src/runs/**`

Scope: the 155 files under `src/runs/` (background runner and supervision, foreground execution, shared run
plumbing) and their tests. Everything outside `src/runs/**` is catalogued separately.
Method: grep for status/state/phase fields and string unions, mutated booleans, timers, persisted JSON with a
state field, lease/heartbeat/retry counters, plus a read of every file that owns one. Line numbers refer to
`origin/main` at the time of the audit (`487cb8eb`) unless marked "now".

Severity: **P1** data loss or wrong terminal result, **P2** stuck/zombie work or crash in a reachable path,
**P3** latent, cosmetic or self-healing.
Fix status: **fixed** (code + regression test that fails without it) or **catalogued** (reason given).

## Findings at a glance

| id | sev | machine | finding | status |
|----|-----|---------|---------|--------|
| F1 | P2 | M17 scheduled runs | a run that ended `partial` is never seen as finished by disk reconciliation, so the schedule stays claimed (overlap-skip forever, delete refused) when the completion event was missed | **fixed** |
| F2 | P2 | M9 result watcher | a late `error` event from a watcher that `stopResultWatcher()` already replaced re-armed polling/restart and set `deliveryActive = true` again, reviving delivery for a stopped runtime | **fixed** |
| F3 | P2 | M18 child commands | the `yieldTimeMs` timer called `operate("yield")` after `shutdown()`; `operate` throws on a closed controller, so the throw escaped a timer callback (uncaught exception in the child) | **fixed** |
| F4 | P3 | M18 child commands | liveness was `endedAt === undefined`, stamped a tick after `state` settles; a cancel in that tick rewrote `completed` to `cancel_requested` | **fixed** |
| F5 | P3 | M2 run-state predicates | eleven copies of "is this run state finished" with different members (see M2); `chain-root-attachment` omitted `rejected`, `workflow-terminal-proof` treated unknown strings as terminal | **fixed** (one module) |
| F6 | P2 | M1 run status | runner writes `status.json` blindly; a reconciler repair of a still-alive but stale runner (deadline + 10 min, or 24 h without update) can be overwritten, giving two different terminal results | catalogued |
| F7 | P3 | M24 retention | `TERMINAL_STATES` excludes `partial`, so a partial run dir is reported `non-terminal` and never reclaimed | catalogued |
| F8 | P3 | M7 nested registry | merge treats `paused` as terminal; a later `running` event for the same nested child is dropped (not verified end to end) | catalogued |
| F9 | P3 | M1 run status | `readStatus` (outside this slice, `src/shared/utils.ts`) casts `state` without checking it is a known value | catalogued |
| F10 | P3 | M10 job tracker | any exception in `refreshJob` sets the job `failed`; the next good refresh flips it back (flap) | catalogued |
| F11 | P3 | M14/M15 child session drain | the 11-flag drain machine exists twice (foreground and background) | catalogued |
| F12 | P3 | M3 runner disposition | `interrupted/stopped/timedOut/usageBudgetExceeded` + `statusPayload.state` encode one disposition | catalogued |
| F13 | P3 | M4 step status | two spellings for one state (`complete`/`completed`) | catalogued |
| F14 | P3 | M12 wait subscriptions | record is removed before the wake message is sent; a send failure loses the wake | catalogued |
| F15 | P3 | M20 placed run owner | `markConnectionUnknown` can overwrite `closed` | catalogued |
| F16 | P3 | M5 startup handshake | pre-proceed termination spins synchronously (`waitForStartupIntervalSync`, up to 1 s per signal) | catalogued |
| F17 | P3 | M8 session lease | `updateWriter` does not enforce `none -> spawning -> running` ordering | catalogued |
| F18 | P3 | M11 completion notifier | batcher has no closed state of its own; only the notifier's `disposed` flag protects it | catalogued |
| F19 | P3 | M10 job tracker | `handleComplete` (event) and `refreshJob` (file) both write `job.status`; a refresh that reads a not-yet-final `status.json` regresses `complete` to `running` until the next refresh | catalogued |

Why F6, F11, F12 are not changed: they sit in the runner lifecycle (`subagent-runner.ts`, `execution.ts`,
`run-child-session.ts`), which `VISION.md` puts behind owner approval ("Broad changes need approval before they
expand across ... runner lifecycle code"). Each is described below with the table a change would adopt.

---

## M1. Async run status (`status.json`, `state`)

- Where: `src/runs/background/subagent-runner.ts` (`statusPayload.state`, written at 3406, 3568, 3599, 3668,
  4912, 5076), `stale-run-reconciler.ts:489` (`reconcileAsyncRun`), `async-job-tracker.ts:505`.
  Memory (`statusPayload`) and file (`<asyncDir>/status.json`, plus `.active-runs` and `.terminal-runs` index markers).
- States: `queued | running | paused | complete | failed | partial | stopped | rejected`
  (`AsyncStatus["state"]`, `src/shared/types.ts:1944`). `rejected` is never produced at run level today.
- Transitions:

  | from | event | to | writer |
  |------|-------|----|--------|
  | queued | runner starts | running | runner |
  | running | interrupt request | paused | runner `interruptRunner` (3400) |
  | running / paused | stop request | stopped (state set at the end) | runner `stopRunner` (3425) |
  | running | deadline | failed (state set at the end) | runner `timeoutRunner` (3461) |
  | running | steps finish | complete / partial / failed / paused / stopped | runner end (4912) |
  | running | runner PID dead, or alive but stale | failed | reconciler `writeFailedRepair` |
  | running | result file already on disk | state from result | reconciler `terminalStatusFromResult` |

- Readers: job tracker, `listAsyncRuns`, wait/bg_wait, retention, schedules, workflows, FleetView.
- Invariants: a terminal state is written once, together with `endedAt`; the result file is published before
  or with it; `processTerminal` proof follows the runner exit.
- Explicitness: union field with named writers; the runner end computes the state in one precedence expression
  (`stopped || signalTerminated` > `timedOut || usageBudgetExceeded` > `interrupted` > all-success > partial > failed).
- Findings: **F6** (P2): no compare-and-set. The runner persists `{ ...statusPayload }` with
  `runPersistence.write(statusPath, ...)` (2134, 2278) and never re-reads `status.json`; `reconcileAsyncRun`
  may repair a live-but-stale runner (`DEADLINE_GRACE_MS` 10 min past the deadline with no update, or
  `staleAlivePidMs` 24 h; skipped for `reconcileOrphanedAsyncRuns`). If that runner was only slow, its next
  write replaces the repaired `failed`, and its result file races the repair's result file. Mitigations in place:
  repair only on dead PID by default, long grace windows, `skipDeadlineRepair` for foreign sessions. A fix needs a
  runner-side "do not overwrite a foreign terminal state" check on the terminal write (one read on the cold
  final-write path); left for owner approval. **F9** (P3): unknown `state` strings pass `readStatus`; the
  reconciler ignores them (`state !== "running"` returns unchanged) and the tracker shows them as active.
  Fix belongs in `src/shared/utils.ts` (other slice).

## M2. "Is this run state finished?" predicates

- Before: eleven hand-written copies, not all equal:

  | copy | `partial` | `paused` | `rejected` | unknown string |
  |------|-----------|----------|------------|----------------|
  | `stale-run-reconciler.terminal` | yes | yes | yes | no |
  | `terminal-run-index.isTerminalState` | yes | yes | yes | no |
  | `async-status-projection.terminalState` | yes | yes | yes | no |
  | `nested-events.terminal` | yes | yes | yes | no |
  | `worktree-cleanup-plan.terminalRunState` | yes | yes | yes | no |
  | `async-job-tracker.isTerminalJobStatus` | yes | yes | yes | no |
  | `chain-root-attachment.TERMINAL_STATES` | yes | yes | **no** | no |
  | `workflow-terminal-proof.isTerminalAsyncState` | yes | no | yes | **yes** |
  | `scheduled-runs` (two inline arrays) | **no** | no | yes | no |
  | `async-retention.TERMINAL_STATES` | **no** | no | yes | no |
  | `retained-children.isRetainedChildState` | yes | yes | no | no |

- After: `src/runs/shared/async-run-state.ts` defines the lifecycle once and exports
  `isSettledAsyncRunState` (everything except queued/running, includes resumable `paused`) and
  `isFinalAsyncRunState` (settled minus `paused`). The six copies with identical semantics (reconciler,
  terminal-run-index, async-status-projection, nested-events, worktree-cleanup-plan, job tracker) now call it;
  `scheduled-runs` uses the final predicate (**F1**, `partial` added); `workflow-terminal-proof` keeps its
  exported name but is now fail-closed for unknown strings; `chain-root-attachment` now also treats `rejected` as settled.
  `async-retention` and `retained-children` keep their own sets on purpose (see F7 and M24).
- Test: `test/unit/async-run-state.test.ts`.

## M3. Runner disposition (interrupt / stop / timeout / usage budget)

- Where: `subagent-runner.ts:1916-1923` (`interrupted`, `timedOut`, `stopped`, `usageBudgetExceeded`),
  `interruptRunner` 3400, `stopRunner` 3425, `timeoutRunner` 3461, end-of-run derivation 4912.
- States (implicit): running, paused (interrupted), stopping/stopped, timed out, usage-budget failed, finished.
- Guards: `interruptRunner` needs `state === "running"` and not already interrupted; `stopRunner` needs not
  stopped/timed out and `state` running or paused; `timeoutRunner` needs none of stopped/interrupted/timed out.
  They are mutually consistent: stop beats timeout and vice versa by whichever comes first; a paused run ignores
  its deadline until resumed or stopped.
- Finding **F12** (P3): four booleans plus `statusPayload.state` encode one disposition; the same precedence is
  restated per step (3016, 4519) and per run (4912). No inconsistency found today; the replacement would be a
  single `disposition` union with one `requestDisposition(next)` that rejects illegal moves (paused to timed out,
  stopped to anything). Catalogued: runner lifecycle, owner approval needed.

## M4. Step status inside `status.json`

- Where: `RunnerStatusStep.status`: `pending | running | complete | completed | failed | partial | paused | stopped | rejected`
  (written at 1678, 1718, 2339, 3016, 3412-3474, 3604-3672, 3807-4200, 4519-4548, 4802 in the runner; by
  `execution.ts` as `progress.status`; by `stale-run-reconciler.buildFailedRepair`).
- Invariant: a step that is `running`/`pending` when its run settles is closed by the same writer.
- Finding **F13** (P3): `complete` (async runner) and `completed` (foreground progress, workflow graph) name one state;
  every reader tests both (`notify.ts:239-241`, `retained-children.ts:33`, `chain-root-attachment.ts`). Collapsing
  them is a persisted-format change. Catalogued.

## M5. Runner startup handshake

- Where: `async-execution.ts:451-640` (`RunnerStartupState`, `completeRunnerStartupHandshake`), runner side
  `subagent-runner-bootstrap.ts`. State lives in a startup file (`startup.json`) and token-checked control files
  (ack / confirm / proceed).
- States: `ready -> acknowledged -> confirmed -> proceed written` (parent) with an `error` state from the runner.
- Explicit and correct: each wait checks the expected state and token, a closed process or timeout ends the wait
  with `startupDidNotProceed`, and every failure path terminates the runner before proceed and persists the failure.
- Finding **F16** (P3): `terminateRunnerBeforeProceed` uses `waitForStartupIntervalSync` (busy loop) when no
  async path is available; up to 1 s per signal on the event loop. The `identified` member of `RunnerStartupState`
  is unused. Catalogued.

## M6. Process-terminal proof

- Where: `process-terminal.ts` (`initializeProcessTerminal` 34, `finalizeProcessTerminal` 152),
  `process-terminal-candidate.ts`; file `process-terminal.json`, overlaid into `status.json`.
- States: `pending -> observed | unknown | not-started` (per run and per step), with a reason for `unknown`.
- Explicit: `validateProof` checks version, state, run id, runner instance id and instance shape on every read;
  an invalid file reads back as `unknown/proof-write-failed`; `finalizeProcessTerminal` is idempotent for
  `observed` and sticky for `unknown`. No finding.

## M7. Nested run registry

- Where: `nested-events.ts` (`projectNestedEvents`, merge at 480-490), `registry.json` plus an event sink.
- States per child: `NestedRunState` (same union as M1).
- Finding **F8** (P3): the merge keeps `existing` when it is settled and `incoming` is not (`paused` counts as
  settled), so a resumed nested child might never show `running` again. Whether resume reuses the child id was
  not verified; catalogued rather than guessed.

## M8. Session revival lease

- Where: `session-lease.ts` (`acquireSessionLease` 202); directory `<root>/<canonicalSessionId>/owner.json`.
- States: `free | owned | unreadable`; owner `writerState: none | spawning | running`.
- Explicit: owner JSON is parsed field by field (writer pid required exactly when `running`), stale takeover needs
  proof the process is gone (host, pid, start identity), tombstone rename serialises contenders, release checks
  the token. Finding **F17** (P3): `updateWriter` accepts any writer state from any other.

## M9. Result watcher / delivery lease

- Where: `result-watcher.ts:211` (`createResultWatcher`). State in `state.watcher`, `state.watcherRestartTimer`
  (shared slot for a restart timeout and a poll interval), `resultScanTimer`, `deliveryActive`, `deliveryEpoch`,
  `activeSessionId`.
- Modes: stopped, native-watching (+ safety scan), polling fallback, restart pending.
- Transitions: `startResultWatcher` (stopped/restart -> native or polling), watcher `error` (native -> polling on
  EMFILE/ENOSPC, else restart pending), `stopResultWatcher` (any -> stopped, epoch bump), `transitionResultDelivery`
  (session change: epoch bump, keep watching).
- Invariant: callbacks of an older epoch never deliver (`ownsCompletion` 252, checked at 455-650).
- Finding **F2** (P2, fixed): the `error` handler was registered per watcher but did not check it still was
  `state.watcher`. After `stopResultWatcher()` (reload, session end) a late `error` armed a poll interval
  or restart timer; the restart then called `startResultWatcher()`, which sets `deliveryActive = true` and bumps
  the epoch, so an old runtime resumed delivering results next to the new one. Fix: ignore errors from a watcher
  that is no longer current. Test: `test/integration/result-watcher.test.ts`
  "ignores a ENOSPC / EIO error from a watcher that was already stopped".

## M10. Async job tracker

- Where: `async-job-tracker.ts:86` (`createAsyncJobTracker`). `AsyncJobState.status` (same union as M1),
  `terminalPublications` (`{ pending: true, instanceId } | { pending: false }`), `runningJobIds`, `cleanupTimers`,
  `refreshTimers`, `jobWatchers`, `supervisorNoticeTimers`, `state.poller`.
- Transitions: `handleStarted` (new job `queued`), `refreshJob` (status from `status.json`; terminal -> publication
  tracking -> `scheduleCleanup`), `handleComplete` (event), catch path (any error -> `failed`), cleanup timer
  (delete after `completionRetentionMs`), `dispose`/`resetJobs`.
- Invariants: no cleanup while a terminal publication is pending or nested descendants are live; timers are
  cleared per job in `closeJobWatcher`; `dispose` clears all of them.
- Findings: **F10** (P3) the catch at the end of `refreshJob` turns every exception (a transient read failure, a
  `workflowChildren` mismatch) into `failed` and schedules cleanup; the next good refresh restores the state and
  `cancelCleanup`. **F19** (P3) `handleComplete` and `refreshJob` can disagree for up to one liveness interval.
  Both self-heal; catalogued.

## M11. Completion notifier and batcher

- Where: `notify.ts` (`seen`, `pending`, `batchers`, `unstartedWakes`, `queuedNotices`, `unansweredCompletions`,
  `bound`, `boundSessionId`, `disposed`, `unsubscribeSettle`), `completion-batcher.ts:101`.
- Notifier: `deliver` -> dedupe (`seen` TTL, `pending` in-flight) -> batch or send -> `settle` resolves the
  promise exactly once (`pending.delete` first). `unansweredCompletions` has a bounded reminder budget
  (`reminded` flag, then "UNHANDLED"). `sessionShutdown` persists unstarted wakes unless reloading.
  Explicit enough; no finding.
- Batcher: `pending[]`, `debounceTimer`, `maxWaitTimer`, `straggler`, `lastEmitAt`; `flush` and `dispose`.
  Finding **F18** (P3): `push` after `dispose` would re-arm timers; unreachable because `deliver` checks
  `disposed` first.

## M12. Wait subscriptions (`bg_wait` wake)

- Where: `wait-subscriptions.ts:103`. Records `{ token, sessionId, runId, expiresAt }` in memory and one file each.
- States: armed -> settled (record removed, message sent) | foreign-expired (swept). `disposed` gates everything.
- Persisted records are validated (`parseRecord`: version, uuid token, kinds, numbers). Wake sources: event bus
  plus a poll interval.
- Finding **F14** (P3): `settle` unlinks the record, then sends; a `sendMessage` failure is logged but the wake is
  gone. Chosen order avoids duplicate wakes; catalogued.

## M13. Control inbox watcher

- Where: `control-channel.ts:554` (`watchAsyncControlInbox`): `disposed`, `watchers`, `interval`,
  `safetyInterval`, `scanFailed` with a repeated-error summary map.
- States: installed (native watchers + safety interval) -> polling (watch error) -> disposed. `startPolling`
  and `check` both honour `disposed`. Scan failures are reported once then summarised. No finding.

## M14. Child session drain, background (`run-child-session.ts:175`)

- Flags: `settled`, `promptSettled`, `forcedTermination`, `cleanTerminalAssistantStopReceived`,
  `agentSettledReceived`, `queuedDrainHold`, `compactionStartedReceived`, `afterCompactionSettlement`,
  `terminalAgentEndReceived`, `compactionAfterFinalOpen`, plus timers `finalDrainTimer`, `finalHardFinishTimer`,
  `watchdogTailTimer`, `abortSettleTimer`, per-tool timeout timers, and `childLifecycleState.compactionRetryActive`.
- Logical states: streaming -> terminal-stop seen (drain armed) -> drain held (queued messages, compaction, watchdog)
  -> forced abort -> hard finish; any -> settled (once, via `settle`).
- Invariants: `settle` and `finish` run once; every timer is cleared in `finish`; `abortChild` is a no-op after
  settle.
- Finding **F11** (P3): the same machine is repeated in `foreground/execution.ts:599-770` with the same flags and a
  near-identical `applyChildLifecycle`; a drift between the copies has no test guarding it. The pure part is
  already shared (`child-lifecycle.ts` `projectChildLifecycle`). Moving the flags into a shared state object is the
  right shape but changes both runners; catalogued for owner approval.

## M15. Foreground child execution

- Where: `foreground/execution.ts:599` `sessionSettled`, `lifecycleFinished`, `detached`, `terminalCallbackInvoked`
  (2339), `detachReadyPublished` (2237); `detachForeground` (630-660) is guarded by all of them plus the abort signal and
  accepts only when `onDetachReceipt` returns `true`.
- Invariants: detach, settle and finish are one-shot; a failed detach receipt leaves the attempt attached.
  Explicit enough; shares F11.

## M16. Imported async root wait

- Where: `chain-root-attachment.ts:233` (`waitForImportedAsyncRoot`): poll loop, `terminalSince` grace window for a
  late result file, abort via `shouldAbort`, directory-vanished error.
- States: waiting -> terminal status seen (grace) -> result built from result file or status. Fixed through F5:
  `rejected` now ends the wait. No other finding.

## M17. Scheduled runs

- Where: `scheduled-runs.ts:578` (`ScheduledRunManager`). Persisted per schedule: `ScheduleRecord`
  (`paused`, `activeRunId`, `trigger.nextRunAt`, claim file `active.lock`) and `ScheduleRunRecord.state`
  `running | skipped | missed | completed | failed_launch | failed_run` (46). Memory: `timers`, `observedAsyncIds`.
- Transitions: timer fire / `schedule.run` / `run-due` -> `launch` (claim lock -> `running` -> attach async id);
  completion event (`handleAsyncCompletion`) or disk reconciliation (`terminalAsyncOutcome`) -> `finishRun`
  (`completed | failed_run`, release claim, re-arm); launch error -> `failed_launch`; overlap -> `skipped`;
  elapsed with `catchUp: none` -> `missed`; stale claim (5 min, no async id) -> `failed_launch`.
- Invariants: one active claim per schedule; `finishRun` releases only if the schedule on disk still names the run
  (`releaseOnly`); the lock is removed only by its owner.
- Finding **F1** (P2, fixed): both disk checks (`terminalAsyncOutcome` and the refusal in `remove`) listed
  `["complete","failed","stopped","rejected"]`. `partial` is a normal final state the runner writes
  (`subagent-runner.ts:4912`). If the completion event was missed (session restart, another session, lost
  event), reconciliation reported the run as still running: `launch` skipped every later occurrence as overlap,
  `restoreOne` never released the claim, and `schedule.delete` answered "stop that run before deleting". Fix: use
  `isFinalAsyncRunState`. Tests: `test/unit/scheduled-runs.test.ts` "releases the claim of a run that ended partial
  when its completion event was missed" and "deletes a schedule whose exact async run ended partial".
  `paused` stays non-final on purpose (resumable, the claim is kept).

## M18. Child commands (`subagent_command`)

- Where: `shared/child-commands.ts:59` (`createChildCommandRuntime`). Job state in
  `snapshot.state: running | yielded | cancel_requested | completed | failed | cancelled`; controller `closed`;
  timers: yield timer per command; persisted `commands.json` and inbox replies.
- Transitions: running -> yielded (yield op or `yieldTimeMs`), running/yielded -> cancel_requested (cancel op,
  `shutdown`), any live -> completed | failed | cancelled when the tool settles.
- Findings, both fixed:
  - **F3** (P2): the yield timer was `setTimeout(() => operate("yield", id))`. `operate` throws
    "Child command controller is closed." once `shutdown()` set `closed`; a command that ignores its abort signal
    outlives `shutdown()`, so the timer fired and threw from a timer callback (process-level uncaught exception).
    Fix: the timer does nothing when closed. Test: "does not throw from the yield timer after the controller closed".
  - **F4** (P3): `active(job)` was `endedAt === undefined`, but `endedAt` is stamped in `.finally`, one microtask after
    `state` becomes `completed/failed/cancelled`. A cancel in that window overwrote the result with
    `cancel_requested`, which then stayed. Fix: liveness is read from `state`
    (`LIVE_COMMAND_STATES`). Test: "does not turn a command that already settled into cancel_requested".
- Note: a run-level abort of the surrounding tool call reports `failed`, not `cancelled`; the existing test
  "retains the native run abort signal after yielding" pins that as intended.

## M19. Herdr RPC subscription

- Where: `herdr-connection.ts:77` `SocketRpcClient.subscribe`: `acknowledged`, `intentional`, `notified`,
  `settled`, ack timer.
- States: connecting -> acknowledged (events flow) -> closed (intentional | disconnected once). Handshake failures
  reject once (`settled`), later disconnects call `onDisconnect` once (`notified`). `call()` has a one-shot
  `finished` guard. Correct; flags are four but the combinations are exactly the three states. No change.

## M20. Placed run owner (Herdr / Rex panes)

- Where: `placed-run-owner.ts:31`; snapshot `{ connection: connected | unknown | closed, state: ready | working |
  blocked | settled | unknown, revision }`; `cleanup()` memoised by `#cleanupPromise`.
- Finding **F15** (P3): `markConnectionUnknown` only compares the connection object, so a late disconnect callback
  after `cleanup()` can turn `closed` into `unknown`; `replaceConnection` has no closed guard either. The
  unsubscribe in `#performCleanup` runs first, which suppresses the callback in practice. Catalogued.

## M21. Retained nested route tracker

- Where: `retained-nested-route-tracker.ts:15`: `watchers`, `refreshTimers`, `poller`. States: tracked -> released
  when no live descendants; `clear()` resets everything. Every timer has a matching clear; a watcher `error` closes
  the watcher and the poll covers it. No finding.

## M22. Active async capacity slots

- Where: `active-async-capacity.ts` (`ActiveAsyncCapacityHandle`: reserve -> `markStarted` / `markWorkflowStarted` ->
  rollback | reconcile -> released); slot directory `owner.json` with `reservationToken` and `generation`.
- Explicit: owner JSON parsed field by field; release verdicts are a union (`releasable | retained | not-owned`)
  with evidence; abandoned-slot release needs process proof or a long timeout. No finding.

## M23. Long-running and failure counters

- Where: `long-running-guard.ts`: `nextLongRunningTrigger` (pure thresholds) and `MutatingFailureState`
  (`consecutiveFailures`, `lastFailureAt`, window reset, path repeat counter). Pure functions over an explicit
  record; reset on window expiry. No finding.

## M24. Async retention eligibility

- Where: `async-retention.ts:31` `TERMINAL_STATES`, `runSkipReason` (319): a run dir is reclaimable only when
  terminal and not referenced (runtime, wait, active index, workflow, nested, mission, handoff, resumable) and old.
- Finding **F7** (P3): `partial` is missing from `TERMINAL_STATES`, so partial runs report `non-terminal` and are
  never reclaimed (a disk leak, not a data loss). It may be deliberate (partial work awaiting attention) but no
  comment or test says so, and `paused` is also absent, where resumability is the stated reason. Not changed because
  it alters what gets deleted.

## M25. Workflow steering receipts

- Where: `foreground/subagent-executor.ts:6120-6200` (`applyWorkflowSteerDelivery`), runner `subagent-runner.ts`
  (`updateSteeringLifecycleTarget`). Receipt target states `scheduled | routed | queued | delivered | failed`, plus
  counters `pending/delivered/failed`.
- Explicit: one-shot settle through `pendingWorkflowSteers` (late callbacks cannot rewrite a settled receipt),
  and the runner end fails every non-final target with a reason. No finding.

## M26. `bg_wait` wake sleep

- Where: `subagent-wait.ts:178` `waitForWake`: `settled`, `wakeController`, unsubscribes. One-shot `done`, abort and
  poll-timeout both route to it, subscriptions are released in every path. No finding.

## M27. Active-run and terminal-run index markers

- Where: `active-run-index.ts`, `terminal-run-index.ts`: marker files derived from `status.state`
  (`updateActiveRunIndex`). Written by the runner, the reconciler and process-terminal finalisation; readers
  tolerate stale markers (`DEFAULT_STALE_TERMINAL_ACTIVE_MARKER_MS`). Corrupt entries are skipped with a
  once-per-signature warning. Derived state, no independent lifecycle.

---

## Summary

| machine | states | explicitness before | after | findings |
|---------|--------|---------------------|-------|----------|
| M1 run status | 8 | union, many writers | unchanged | F6, F9 |
| M2 run-state predicates | 3 classes | 11 copies | one module | F5 (fixed) |
| M3 runner disposition | 6 | 4 booleans + state | unchanged | F12 |
| M4 step status | 9 | union, two spellings | unchanged | F13 |
| M5 startup handshake | 4 + error | explicit (file + token) | unchanged | F16 |
| M6 process-terminal proof | 4 | explicit, validated | unchanged | none |
| M7 nested registry | 8 | union | unchanged | F8 |
| M8 session lease | 3 + 3 | explicit, validated | unchanged | F17 |
| M9 result watcher | 4 modes + epoch | flags + shared timer slot | stale-watcher guard | F2 (fixed) |
| M10 job tracker | 8 + publication | union + maps | unchanged | F10, F19 |
| M11 notifier / batcher | n/a | flags + maps | unchanged | F18 |
| M12 wait subscriptions | 3 | explicit, validated | unchanged | F14 |
| M13 control inbox | 3 | flags | unchanged | none |
| M14 child drain (background) | ~6 | 11 flags | unchanged | F11 |
| M15 child drain (foreground) | ~6 | 11 flags | unchanged | F11 |
| M16 imported root wait | 3 | loop + grace | via M2 | F5 |
| M17 scheduled runs | 6 run states | union + lock file | final-state predicate | F1 (fixed) |
| M18 child commands | 6 | union + `endedAt` | liveness from `state`, closed guard | F3, F4 (fixed) |
| M19 herdr subscription | 3 | 4 flags | unchanged | none |
| M20 placed run owner | 3 x 5 | snapshot union | unchanged | F15 |
| M21 retained route tracker | 2 | maps + timers | unchanged | none |
| M22 capacity slots | 3 verdicts | explicit | unchanged | none |
| M23 failure counters | n/a | explicit record | unchanged | none |
| M24 retention eligibility | n/a | set + reasons | unchanged | F7 |
| M25 steering receipts | 5 | explicit | unchanged | none |
| M26 wake sleep | 2 | one-shot flag | unchanged | none |
| M27 index markers | 2 | derived | unchanged | none |

Totals: 27 machines catalogued; 5 findings fixed (F1 P2, F2 P2, F3 P2, F4 P3, F5 P3); 14 catalogued only.
