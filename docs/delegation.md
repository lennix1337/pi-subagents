# Delegation and context handoff

The parent works directly by default. Delegate only when the operator requested it in the current request or through applicable user or project instructions. This topic is the decision layer for an authorized handoff: choose fresh or forked context, write a cold-start brief, and route the agent, model, and thinking level.

## When delegation earns its overhead

Delegate when a child materially improves one of these outcomes:

- **Independent evidence or review**: a fresh reviewer can inspect the work without inheriting the parent's assumptions.
- **Specialization**: a configured agent has the right tools, prompt, skills, or external runner.
- **Useful parallelism**: independent read-only angles finish sooner together.
- **Isolation**: a writer needs its own cwd or worktree, or a risky step should not mutate the parent session.
- **Context hygiene**: the task is self-contained and the parent history is large, stale, or irrelevant.

Do not delegate only because a task is large, complex, or risky. A single child is valid; a fanout, writer, reviewer, or oracle still has to earn its tokens and elapsed time. Keep user intent, constraints, arbitration, final acceptance, and publication authority in the parent. If a child would materially help but delegation is not authorized, suggest the intended agent and context and ask; do not launch on your own. For example: "This diff has an independent review angle; I can launch a fresh reviewer with a read-only brief for P0/P1 findings. May I?"

## Context and brief

Choose the context first, then write the handoff. These two decisions are coupled: a fresh child needs a complete brief, while a forked child already has the parent history and needs a narrower instruction.

### Fresh or fork

| Situation | Context | Why |
| --- | --- | --- |
| Independent task, review, recon, research, or parallel angle | `fresh` | The child gets its agent prompt, any configured inherited context, and the task brief. No parent context rot. |
| Continuation of the current decisions, plan, or implementation thread | `fork` | The child inherits the parent transcript and can see why earlier choices were made. |
| Hard decision, root-cause audit, or oracle escalation | `fork` when inherited decisions matter; otherwise `fresh` | Fork preserves the contract; fresh gives an independent reading. |
| Agent declares `defaultContext` | omit `context` | The agent default applies. `profile` requires that declared default. |

Fresh is the normal choice for delegated work. Fork only when inherited decisions or history genuinely matter to the child; forking copies the parent system prompt, project and global context, skills, subagent catalog, and the parent's list of running runs when shown. That is useful for continuity but can also carry the exact assumptions or context rot the child was meant to escape. Packaged `oracle` and `advisor` default to fork; pass `options.context: "fresh"` when you want their independent reading instead.

`context` lives in `options` for the model-facing call: `{agent, task, options: {context: "fresh"}}`. An explicit `context: "fresh"` or `"fork"` overrides every workflow child. Explicit `context: "fork"` fails fast when the parent session is not persisted or has no current leaf; an implicit fork default falls back to fresh.

### Cold-start brief

A fresh child does not see the parent chat. It cannot ask a follow-up question unless a supervisor channel is configured. The `task` text is the entire conversational handoff, so write it as a self-contained contract:

```text
Goal: the concrete outcome the child must produce.
Target: repository, explicit cwd, branch/ref/HEAD, files, symbols, or URL.
Authority: read-only, or the exact files/paths the child may edit; commit/push/PR/comment permissions.
Evidence: plans, diffs, decisions, constraints, prior findings, and where they live.
Success criteria: what must be true before the child can finish.
Constraints: true invariants only; what not to change or re-litigate.
Validation: focused commands or the next-best check when validation is impossible.
Output: inline summary, artifact path, finding format, or structured schema.
Stop rules: when to ask, escalate, or stop after enough evidence.
```

Brief-writing rules:

- Repeat the exact target and authority boundary. Do not rely on "the repo" or "the diff" being obvious.
- Point to durable artifacts or paste only the relevant excerpt. Do not dump the whole conversation or a whole file when a path and line range will do.
- State decisions that are already approved so the child does not reopen them.
- Give each parallel child a distinct angle, output path, and non-overlapping ownership.
- Ask for evidence: files, lines, commands, results, confidence, and residual risks.
- Keep secrets out of task prose, raw workflow args, and artifacts. Pass a path or an environment reference instead.
- For implementation, name the approved scope and the validation contract more clearly than the process.

## Choose agent, model, and thinking

Discover before executing; discovery is read-only and does not launch a child:

1. `{action:"list"}` shows agent types, descriptions, and declared defaults.
2. `{action:"models"}` shows live models across every authenticated provider and account, with each model's `thinking=` levels.
3. `{action:"models",agent:"name"}` shows one agent's effective model and supported levels.

Common routing, after the operator-authority gate:

- `scout` for fast codebase recon and compressed context.
- `worker` for a bounded implementation slice; one writer per cwd or worktree.
- `reviewer` for independent review, with evidence and file/line references.
- `researcher` for external sources, docs, and ecosystem evidence.
- `oracle` or `advisor` for a rare hard decision or root-cause audit, bounded and read-only.
- `delegate` for a generic lightweight task with no specialized role.
- External CLI agents only when their CLI is installed, authenticated, and the task fits their runner contract.

Model and thinking routing:

- Keep the parent on its ordinary strong default model. Choose a child model by the task, not by copying the parent reflexively.
- A child can use any authenticated provider or account, even when the parent is on a different one: `model: "anthropic/claude-haiku-5-5"` from a Codex parent, or `model: "openai-codex/gpt-6-luna"` from an Opus parent.
- Use `thinking` for the child's effort. `off` or `minimal` for mechanical checks, `low` or `medium` for scoped work, `high` for serious review or implementation, and `xhigh` or `max` only for a deliberate escalation.
- `thinking` and `model` are independent. `thinking` alone keeps the agent's model; omit both to inherit the agent default. A model `:level` suffix wins over top-level `thinking`. `false` means `off`; `true` is invalid.
- Treat the listed levels as advisory. A provider may map an unsupported level to its nearest budget; do not rely on a level name as an exact token budget.
- A top-level `thinking` applies to every child in one execution call. A per-child model suffix still wins. Delegated recovery overrides remain authoritative.
- For external CLI agents, native options are supported only when the adapter declares them. The Claude Code adapter accepts model and thinking; most other external runners reject a thinking override with a structured error.

## Shape and examples

Use the smallest shape that fits:

- One bounded child: `{agent, task}`.
- Independent children: one parallel call or `runs.all`.
- Dependent steps: one workflow script with `runs.run`; await each result before using it.
- Long work: async by default; inspect later. Use foreground only when the same turn needs the result.

### Review handoff

```text
Goal: adversarial review of the current diff; findings only, no edits.
Target: repo C:\work\api, branch feature/limits, diff against main. Files: src/limits.ts, test/limits.test.ts.
Authority: read-only. Do not edit, stage, commit, or comment.
Evidence: the diff is in the working tree; the plan is docs/plans/limits.md.
Success: every finding has file/line evidence, a concrete failure mode, and a severity.
Validation: run the focused test file and report the exact command and result.
Output: P0/P1/P2 findings, then "Merge verdict: BLOCK|OK|OK with notes".
Stop: after the diff and its immediate callers are covered; do not expand to unrelated modules.
```

### Implementation handoff

```text
Goal: implement only the approved rate-limit fix.
Target: C:\work\api, branch feature/limits, current HEAD. Seam: src/limits.ts and its test file.
Authority: edit only those two files; no commit, push, or dependency changes.
Evidence: approved plan docs/plans/limits.md; failing test output is in the task artifact.
Success: the focused test passes and existing behavior outside the seam is unchanged.
Validation: run the focused test, then the package typecheck.
Output: changed files, commands/results, residual risks, and anything not verified.
Stop: if the fix needs a contract or schema change, stop and report the decision.
```

### Continuation handoff

Use `context: "fork"` and a short task that points at the existing thread:

```text
Goal: continue the implementation from the parent session after the reviewer's P1 fix.
Target: the same worktree and branch as the parent.
Authority: the same edit boundary as the parent; no new scope.
Evidence: the reviewer findings in the parent transcript.
Success: the named P1 is fixed and the focused validation passes.
Output: diff summary, validation result, remaining findings.
Stop: on any new product or architecture decision.
```

## Edge cases

- **Unknown agent, model, or level**: the error lists valid choices. Read them and retry once with an exact id; do not guess or silently fall back to another provider.
- **Model suffix typo**: `provider/model:loww` is not a thinking level. Use a known suffix or pass `thinking` separately. A known suffix wins over the top-level selector.
- **Unsupported level**: the registry list is authoritative for discovery, but the provider may clamp an unsupported level. If exact effort matters, choose a model whose list includes the level.
- **Fork without a session**: explicit `context: "fork"` fails when the parent has no persisted session file or current leaf. Use fresh with a complete brief, or fix the session first.
- **Fork carries parent-only material**: the child inherits the parent system prompt, project/global context, skills, and subagent catalog. Use fresh when the child should not see parent orchestration instructions or stale history.
- **Cross-provider fork**: a forked child on a different model receives inherited thinking blocks as plain text, so that provider sees the parent's reasoning. Use fresh with a brief when that is not acceptable; a same-model fork is also the only shape that can reuse the parent's prompt cache.
- **Fork context overflow**: a large parent transcript can exceed a small child context window. Fresh is bounded by the brief; `forkContext.mode: "pruned"` is a configuration-level mitigation, not a substitute for a focused task.
- **Child cannot ask**: a normal fresh child returns one result. Use a configured supervisor/intercom channel for mid-run questions, or ask the user before launching.
- **Parallel writers**: never let two children edit the same cwd or worktree. Use `worktree: true` or separate lanes with explicit ownership.
- **Resume and recovery**: a resumed child uses its recovery descriptor; a new top-level `thinking` does not rewrite that recovered level.
- **Large output**: use a managed output artifact or `outputMode: "file-only"` for long reports; return the path and a short summary.
- **Secrets**: never put tokens, passwords, or private customer data in a task, raw workflow args, or an artifact. Pass a reference the child can resolve.
- **Async default**: a child may still be running when the parent turns. Return control and inspect with status; do not sleep or poll in a loop.
- **Cost**: a top-reasoning child at `max` is an escalation, not a default. Keep fanouts small and give each child a reason to exist.
