# OptChat integration

OptChat (the user's fork) lists pi-subagents runs in its own **Agents** panel, marked with `π`. The integration is read-only about run data: OptChat reads the artifacts pi-subagents already writes and only ever writes *control requests* into a run's control inbox.

## What OptChat reads

| Artifact | Path | What it shows |
| --- | --- | --- |
| Async run status | `<temp-root>/async-subagent-runs/<runId>/status.json` | A live or finished async run: state, agent, model, thinking level, task and the child's transcript. |
| Live foreground record | `<temp-root>/async-subagent-results/live-foreground/<runId>-<index>.json` | A foreground child that is working right now, from a single-agent call. The record is refreshed while the child runs and removed when it ends. It holds no task prompt, so the row is labelled by its agent. |
| Saved foreground runs | `<temp-root>/async-subagent-results/foreground-history.json` | The foreground runs pi-subagents has already persisted, one row per child. |

`<temp-root>` is `PI_SUBAGENTS_TEMP_ROOT` when it is set, otherwise `<os temp>/pi-subagents-<scope>`, where the scope is the user id, the user name or the home directory, following the same rule pi-subagents itself uses. Both extensions therefore find the same artifacts without extra configuration.

When the saved metadata leaves the model or the thinking level out, OptChat reads them from the head of that run's own Pi session file, which records the model and the thinking level the child actually ran with. The panel therefore shows the effective model and thinking level, not the ones OptChat would pick for itself.

A run with several steps is shown as one row per step, each with its own agent, model, thinking level and state. A run with one step is one row.

## What OptChat can do with a run

- **Open** the transcript of a saved run. It is read-only: the conversation belongs to pi-subagents, not to OptChat.
- **Steer**, **interrupt** and **stop** a live async run through the run's own control inbox (`<runDir>/control/`), the same channel the parent uses for a detached runner. The request is a file the runner watches, so it reaches the run from any Pi session, not only the one that started it.
- **Steer** and **pause** a live foreground child through the in-process RPC (`subagents:rpc:v1:request`). A foreground child runs inside the Pi process that started it, so only that session can reach it; from another session the row is read-only and the panel says so.
- **Hide** a run from OptChat's panel with **D**. That only affects OptChat's list; pi-subagents keeps the run and all of its artifacts.

## Known limits

- A foreground child runs inside the Pi process that started it. OptChat can steer and pause it from that session; another session can only read it. An async run has no such limit, because its runner is a separate process with a control inbox.
- A duration is shown when the artifact records both a start and an end. The saved foreground history has no start time of its own, so a run OptChat did not see working shows a dash; a run it watched start shows the real duration.
- A live foreground record whose heartbeat stopped belongs to a run that died without cleaning up. OptChat ignores it after a few minutes, and pi-subagents prunes it after a day (checked when a child ends, at most once an hour).
- Only a single-agent foreground call writes a live record. Parallel and chain steps run as async runs, which the panel lists from their `status.json`.
