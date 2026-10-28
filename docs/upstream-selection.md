# Selective upstream sync — 2026-10-27

Compared fork `4a15bd9d` with `nicobailon/pi-subagents` main `2cab20f8`.
This is a selective backport, not an upgrade to every feature of upstream 0.83.0.
The fork's operator decisions and `VISION.md` remain authoritative.

## Included

| Upstream commits | Benefit |
| --- | --- |
| `b09eb5e8`, `c63fb81f`, `2cab20f8` | Reject blocking memory FIFOs, invalid tool modifiers and untrusted ancestor discovery probes. |
| `c214d8c4`, `7cade17c` | Parse quoted tool/extension lists and preserve empty lines inside nested frontmatter. |
| `4cce6ebf`, `4f2a9892` | Report repeated corrupt-state failures once per observed change; keep other terminal runs visible. |
| `f45abdb9`, `41d53672` | Preserve mid-conversation system messages when projecting parent notices and child history. Cache hit-rate gains are not measured here. |
| `61946c1e`, `b19664af`, `7fe94c3f` | Finish terminal children without cancelling final compaction; bound shutdown; apply foreground extension bindings only during child startup and restore the parent environment. |
| `bb01ceea`, `abf3b394`, `8b3d1941`, `bf40e8bb` | Validate options and thinking levels, reject misspelled overrides, preserve explicit `thinking: off`. |
| `a51ecd87`, `aac696d6`, `00d18950` | Notify hosts when jobs change; match background work across session identity forms; resolve capability ceilings by the native Pi session ID. |
| `b17d1fad`, `a03b55da` | Refuse resumes during worktree finalization; require an explicit interrupt target. |
| `187da1bd` | Keep explicitly requested missions waiting when their required acceptance evidence is not accepted. |
| Dependency changes from `54909408`, `a3c3f534` | Pin and override `undici` to 8.12.3, preserving this fork's TypeScript 7.0.2. |

Patches retain upstream regression tests. The integration adds a missing `spawnSync` import to a shutdown fixture (its original upstream import came through an excluded commit), and propagates non-ENOENT failures while inspecting corrupt-state metadata instead of swallowing them.

## Additional operator-approved capabilities

The operator also requested remote Mac execution over their Tailscale/SSH network and automatic workflow recovery. This supersedes the initial exclusion of those two features.

- `07e95285`, `7a1fa2ce`: native Pi children in Rex panes on a configured SSH Mac; only user settings select the SSH host.
- `96751fc4`, `bf672517`, `f9b49c69`: persisted launches, boot-aware owner liveness, once-only resume claims, child reuse and completion-delivery adoption after an owner exits.
- Selected lifecycle/placement cleanup from `4751df61` and supervisor-error propagation from `9d72792a` keep these paths consistent with later fixes.

Recovery applies to the owning interactive session, reuses finished children and re-attaches running children. It does not resume operator-stopped work, other sessions, print runs, old runs or launches refused by current admission/authority checks. This fork also refuses automatic recovery of resources with authorized host commands: their previous effects must be reconciled before an explicit manual relaunch. `autoResume: false` disables recovery. Current-session reload remains a separate operator action.

Remote placement currently needs a POSIX coordinator (macOS/Linux/WSL), Rex and Pi on the target Mac, the same extension version and noninteractive SSH with a known host key. Native Windows coordination is refused. SSH access alone is not proof of a working remote child, and the integration does not install or configure the Mac. See [agents](agents.md#running-a-pi-child-in-a-rex-pane-on-another-mac).

## Deliberately not included
- Bun worker extraction and GC workarounds: no Bun runtime change is part of this Windows/Node integration.
- The alternate `options.script` launch path and associated error-only changes: retain the existing workflow contract rather than adding another route.
- Wholesale skill rewrites, broad refactors, release/version bumps, and unrelated visual/documentation changes: preserve this fork's guidance and avoid claiming an upstream release.

## Fork invariants

Project-trust checks, privacy-safe child tool activity, prompt-free foreground ledger, native scheduling/identity checks, parent completion-until-final-answer guard, self-reload readiness, parent notifications, model discovery/thinking controls, lazy startup imports, LF policy and the existing tool-description budget remain in place. No provider calls, account changes, deployment, package release or current-session reload are part of validation.

Use the named checks in `.pi/checks.json`. `unit-windows` runs every unit test with the two-file concurrency already used by Windows CI; it does not raise test timeouts or skip failures. A real-session smoke requires a separately authorized reload and has not been performed by this sync. Remote-Mac smokes also require an explicit SSH target and approved provider usage; the default checks are offline.
