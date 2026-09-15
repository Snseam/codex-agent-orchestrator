---
name: herdr-dev
description: Coordinate authorized development through the local Codex Agent Orchestrator CLI and Herdr coding-agent sessions, with isolated worktrees, independent verification, repair attempts and integration. Use when the user chooses this collaboration method for a project.
---

# Herdr development coordination

Use the installed CAO CLI, or this repository's `bin/cao.mjs`. Resolve its absolute path once; when the skill is read from this repository it is `../../bin/cao.mjs` relative to this folder. If the skill has been copied elsewhere, locate the existing CAO checkout or executable instead of assuming the relative path still works. Read the CLI `--help` and the repository README for the current manifest schema. This is a repository skill draft; it does not install or register itself.

## Plan useful independent work

Keep product decisions, acceptance conditions, shared interfaces and cross-task sequencing in Codex. Give each external session an independently reviewable task, exact owned paths and executable acceptance checks. Worktree tasks may run in parallel; integrate predecessors before dispatching dependent worktrees. Checkout mode permits one writer across runs sharing the same state directory. Use one state directory for a project; put it outside the target Git worktree.

For an existing project, reproduce the issue and establish the baseline before dispatch. For a new application, establish a committed skeleton and one thin end-to-end path, then expand independent features. A candidate competition uses separate task IDs/worktrees and integrates only the selected candidate.

Select the user's configured agent, preserving its provider/model settings. `agent` accepts `claude`, `pi`, `opencode`, or `codex`; actual availability must be checked locally. `nativeInstructions` can request the selected agent's available internal tools; set `maxChildren` to the intended number and avoid duplicating externally owned tasks inside the worker. Native children are self-reported, not monitored or capped by CAO. Do not promise native teams or large-scale concurrency from this MVP alone.

## Drive the actual CLI loop

1. `init --project ABS_PATH` creates a run and an owned named Herdr session. Save the run ID and use it for every command. `validate --file TASK.json` checks the definition; `dispatch --run RUN --file TASK.json` reserves and sends a task once.
2. `collect --run RUN --task TASK --wait-ms 30000` waits for evidence. `inspect --output` reads the worker. Never infer completion from `idle`, a final chat sentence, or a successful transport acknowledgment.
3. On `needs_input`, inspect the exact terminal output and error. Resolve only what existing authorization covers. Use `input --keys ...` or `input --text-file ...` for a concrete inspected interaction; do not press Enter blindly. `resume` reconciles the same attempt and never resends an acknowledged assignment. If the worker is idle without a result, ask it to write the current attempt's report; do not replay the implementation request.
4. On `submitted`, run `verify`. It stops the owned worker, checks the collected snapshot, runs the manifest's checks independently and creates a patch only on success. A stale nonce, changed snapshot, unexpected path or unfinished reported child blocks acceptance.
5. On `rework`, inspect independent evidence and use `retry` with a focused feedback file when useful. CAO creates a new attempt and nonce, preserves partial work, and includes failed check output. Continue authorized repair attempts up to the task's `maxAttempts`; if the same blocker repeats, revise the diagnosis or task boundary instead of replaying the same instructions.
6. On `accepted`, review the candidate and call `integrate` when integration is within the user's requested development scope. It checks the target baseline and patch hash, applies without a commit, and reruns checks in the target project. A task is delivered only when the requested project-level acceptance passes, not merely when individual candidates pass.
7. After completion or cancellation, `cleanup --run RUN` stops the owned Herdr server and closes the run for new dispatches. Evidence and worktrees remain available. It does not delete project files or commit/push.

## Failure and recovery boundaries

- An uncertain transport outcome is not a retry instruction. Inspect or resume first; use a new attempt only after the old worker is stopped.
- Integration failure/cancellation can leave an applied patch in the project. CAO blocks new dispatches and integrations for that project across runs. Inspect and repair the retained checkout; `recover` rechecks the current checkout and does not apply the patch again. It preserves the hold if checks fail. `cleanup` only stops the Herdr server and closes that run for new dispatches; it does not clear this hold.
- Checkout tasks write the target checkout directly. If a checkout task fails, is interrupted, or is cancelled after making changes, CAO holds the project and blocks new tasks/integrations. Continue with `retry` on the original task, or stop the worker and use `recover` to verify the current checkout. A checkout cancellation with no changes can release the hold.
- An interrupted verification is fail-closed in this MVP. `resume` does not replay its commands and `recover` does not automatically recover a crashed `verifying` attempt. Inspect retained process/evidence state before deciding on manual recovery; do not edit the ledger to fake acceptance.
- CAO records terminal/process identity and rejects adoption when the pane, terminal, foreground process group, shell pid, or agent kind changes. Treat identity failures as requiring inspection, not force-close.
- Scopes, file locks and worktrees are coordination controls, not a filesystem sandbox. Git-ignored files and external side effects are outside the snapshot. Use checks whose behavior is suitable for the actual target repository.
- Preserve scope and persistent authorization. This skill does not add permission to change providers, install dependencies, publish, send messages or delete work. Do not ask again for ordinary development and verification already authorized by the user.

Report the implemented behavior, independent acceptance results, actual external sessions/repair attempts, unresolved limitations and retained evidence. Separate a controlled fault-injection test from a measurement of real project success rate or speed.
