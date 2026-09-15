# Coordinate development with CAO

Use the CLI path resolved by this skill's `scripts/cao.mjs --paths`. Read the checkout's README and CLI `--help` for the current task schema; use the returned absolute guide paths when routing or monitoring needs more detail.

## Split useful work

Keep requirements, acceptance conditions, shared interfaces, and cross-task decisions in Codex. Give an external session an independently reviewable task, exact owned paths, and executable checks. Worktree tasks may run in parallel; integrate predecessors before dispatching dependent worktrees. Checkout mode permits one writer across runs sharing the same state directory. Keep that directory outside the target Git worktree.

For an existing project, reproduce the issue and establish a baseline before dispatch. For a new application, establish a committed skeleton and one thin end-to-end path before expanding independent features. Creating a commit still requires the user's applicable authorization. A candidate competition uses separate task IDs/worktrees and integrates only the selected candidate.

Inspect available agents and `profile list`. Without an execution selector/default, supported agents inherit their native provider configuration. For profiles, read the resolved profiles guide and run `route explain --file TASK.json` before dispatch. Use `agent: "auto"` when a profile may choose the agent; a concrete agent constrains routing. Preserve the user's native/CC Switch provider and authentication settings. Use stdin and private credential references for secrets, never prompt text or CLI arguments.

Request native collaboration through `nativeInstructions` only when the selected agent actually supports it. Set `maxChildren` to the intended number and avoid duplicating externally owned work inside a worker. Child reports remain part of the delivery contract. CAO attempt limits do not enforce native child or provider request concurrency.

## Drive the CLI to acceptance

1. Inspect a recorded active run before creating another. `init --project ABS_PATH --max-parallel N` creates a run and an owned Herdr session. Generate a task file with the conversation's configured agent/profile and `maxAttempts`; `validate --file TASK.json` checks it. `dispatch --run RUN --file TASK.json` reserves and submits once.
2. `collect --run RUN --task TASK --wait-ms 30000` waits for evidence. `inspect --output` reads the worker when needed. Terminal idle, a final chat sentence, and a transport acknowledgement do not prove acceptance.
3. On `needs_input`, inspect the precise terminal output and error. Resolve only what existing authorization covers. Use `input --keys ...` or `input --text-file ...` for that inspected interaction. `resume` reconciles the same attempt without resending an acknowledged assignment. If a worker is idle without a report, request the current attempt's report instead of replaying the implementation task.
4. On `submitted`, run `verify`. It stops the owned worker, checks the candidate identity and scope, runs checks independently, and creates a patch only on success. A stale nonce, changed snapshot, unexpected path, or unfinished reported child blocks acceptance.
5. On `rework`, inspect evidence and `retry` with focused feedback. A new attempt preserves partial work and includes failed checks. Stay within the task's configured attempt limit; repeated identical failures call for a revised diagnosis or task boundary.
6. On `accepted`, review the candidate and `integrate` within the user's development authorization. CAO checks the target baseline/patch hash, applies without committing, and reruns checks in the target project. Finish project-level acceptance, not just individual candidate acceptance.
7. After completion or cancellation, `cleanup --run RUN` stops the owned Herdr server and closes the run. Evidence/worktrees remain. It does not commit, push, or delete project files.

## Recovery and observation

- An uncertain transport outcome is not permission to retry blindly. Inspect/resume first; stop the old worker before creating a replacement attempt. Do not force-stop a gateway with active users.
- Failed or cancelled checkout work can leave edits in place. Failed integration can leave an applied patch. CAO holds the affected project; inspect the retained checkout and use the documented `retry`/`recover` path. `recover` rechecks the current checkout and does not replay a patch. `cleanup` does not clear a recovery hold.
- A crashed `verifying` attempt is fail-closed; inspect its process/evidence state. Do not edit the ledger to pretend it passed. Runtime identity mismatches require inspection, not force-closing an arbitrary terminal.
- When the user asks to see activity, use `monitor start --project ABS_PATH --open` with the same state directory. Conversation view shows linked native and external agents. Status may be observed, stale, or unknown; token counts carry their own scope/completeness. A native finished turn is distinct from independently accepted work. Stopping the viewer does not stop agents.
- Worktrees and file scopes coordinate writes; they are not a filesystem sandbox. Choose checks appropriate for the target repository and preserve existing authorization boundaries.

Report delivered behavior, independent verification, actual external sessions/repair attempts, and remaining limitations. Retain run/task IDs and evidence paths for the conversation's next turn.
