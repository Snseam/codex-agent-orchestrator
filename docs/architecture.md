# Architecture and modules

> 中文: [zh-CN/architecture.md](zh-CN/architecture.md)

Codex Agent Orchestrator (CAO) is an explicit CLI controller. It is not a daemon, does not provide MCP-native child telemetry, does not change model/provider settings, does not install plugins, and does not commit or push. Execution commands load state, perform a stage, write evidence, and exit. Read-only queries inspect state or local usage records.

## Runtime boundary

```text
User / Codex App
  -> node bin/cao.mjs <command>
      -> Orchestrator
          -> State store
          -> Git / worktree / patch layer
          -> Herdr runtime
              -> claude | pi | opencode | codex
          -> verification commands
```

CAO owns only the runs, attempts, Herdr session, workspaces/panes, and evidence it creates. Agent accounts, models, provider configuration, native delegation features, and local permissions remain owned by the corresponding tool installation.

## CLI layer: `bin/cao.mjs`

The CLI parses arguments, reads task files, creates the `Orchestrator`, and prints JSON. Supported stages are `init`, `validate`, `dispatch`, `status`, `inspect`, `collect`, `verify`, `retry`, `resume`, `input`, `integrate`, `recover`, `cancel`, `cleanup`, `doctor`, and `usage`.

Key semantics:

- `dispatch` submits a task once.
- `collect` reconciles and waits; it does not resubmit the assignment.
- `verify` checks an already collected candidate; it does not continue the worker conversation.
- `integrate` applies a verified worktree patch to the target checkout and reruns checks there.
- `recover` rechecks retained checkout state. It does not rerun a worker and does not apply the same patch again.

## Orchestrator: `src/orchestrator.mjs`

The orchestrator is the state machine and coordination layer.

- `init` resolves the Git root, records the base commit, baseline snapshot, initial dirty state, maximum parallelism, and a CAO-owned Herdr session.
- `dispatch` validates a task, checks dependencies and holds, reserves an attempt, prepares worktree or checkout isolation, starts Herdr server/workspace/agent, records identity, writes `prompt.txt`, and sends a short dispatch prompt.
- `collect` observes the Herdr agent, reads the result JSON, validates task/attempt/nonce, validates reported children, checks changed paths against the task scope, and saves terminal output.
- `verify` closes the owned worker, runs task checks independently, writes `check-*.json` and `verification.json`, and for accepted worktree tasks creates `candidate.patch`.
- `retry` creates a new attempt with a new nonce, reuses the previous candidate cwd, and carries failed evidence/feedback into the next `prompt.txt`.
- `integrate` applies an accepted worktree patch to the target checkout, records an integration operation, and reruns checks in the target project. Failure or cancellation creates a cross-run integration hold until recovery succeeds.
- `recover` rechecks current checkout state: incomplete integrations are verified without applying the patch again; stopped checkout tasks are moved back through verification using the current checkout.
- `cancel` closes the owned worker when identity still matches. Checkout cancellation releases the checkout hold only when there are no changes relative to that task baseline.
- `cleanup` stops the run's Herdr server and closes the run for future dispatch. It retains worktrees, evidence, and any checkout/integration holds.

## State store: `src/state.mjs`

The default state root is `~/.local/state/codex-agent-orchestrator`; `--state-dir` can override it. The state root must be outside the target Git worktree.

```text
<stateRoot>/
  runs/<runId>/
    run.json
    events.jsonl
    herdr-server.log
    attempts/<attemptId>/
      task.json
      prompt.txt
      result.json
      terminal.txt
      check-*.json
      verification.json
      candidate.patch
      integration-<random>.json
```

JSON writes use a temporary file and atomic rename. Locks are directory locks with pid/hostname/nonce owners. CAO only recovers a stale lock when the owner is on the same host and the process is definitely dead. Checkout and integration project locks live under `<stateRoot>/locks/`, so they coordinate only callers using the same state root.

## Task and prompt layer: `src/task.mjs`, `src/adapters.mjs`

`validateTask` rejects unknown keys and unsafe paths. Paths must be normalized relative paths or trailing-slash directory prefixes; globs, absolute paths, backslashes, traversal, and `.git` are rejected.

The full assignment is written to `prompt.txt`: objective, allowed paths, checks, native instructions, child-reporting contract, and result JSON skeleton. `dispatch` sends a short entry prompt asking the worker to read `prompt.txt` and execute the contract.

Adapters preserve provider settings:

- `claude` starts Herdr kind `claude` and prepends `--add-dir <attemptDirectory>` before task `agentArgs`.
- `pi`, `opencode`, and `codex` pass task `agentArgs` through unchanged to Herdr `agent start`.

`maxChildren` is a reporting contract only. CAO validates the number and status values in result JSON; it does not observe or enforce native children/subagents and has no MCP/daemon child telemetry.

## Herdr runtime: `src/runtime/herdr.mjs`

The runtime targets an explicit named session and refuses default-session server operations. It strips inherited `HERDR_SOCKET_PATH`, `HERDR_SESSION`, `HERDR_PANE_ID`, and related Herdr environment variables before invoking Herdr, so commands do not accidentally target the caller's pane.

Main operations:

- `ensureServer`: starts `herdr --session <session> server` and polls `api snapshot` for up to 10 seconds.
- `createWorkspace`: creates a workspace at the attempt cwd without focusing it.
- `startAgent`: starts the selected Herdr agent kind in the root pane.
- `prompt`, `keys`, `readAgent`: submit the short prompt, send inspected human input, or read visible output.
- `getProcessInfo`: captures pane process identity.
- `closePane`, `stopServer`: close the worker pane or stop the CAO Herdr session.

CAO records and rechecks `paneId`, `terminalId`, foreground process group id, shell pid, and agent kind. If any of these identities change, CAO refuses collect/input/cancel instead of adopting or closing an unknown process.

## Git layer: `src/git.mjs`

The Git layer handles snapshots, worktrees, patches, and integration checks.

- Snapshots include tracked files and untracked files that are not ignored by Git. Tracked files are included even if they match ignore patterns.
- Snapshots record hash, mode, and type; symlink targets are hashed without following the link.
- Snapshots reject submodules and paths that pass through symlink ancestors, and never read `.git`.
- Worktree tasks use `git worktree add --detach`. If the source checkout is dirty, CAO writes the current tracked plus untracked/non-ignored state into a tree and resets the candidate worktree to that tree, preserving the user's baseline.
- `makePatch` uses a temporary `GIT_INDEX_FILE` to produce a binary patch without touching the user's real index.
- `applyPatch` runs `git apply --check` and then `git apply`; it does not stage, commit, or push.

Untracked ignored files are not part of snapshots, changed paths, candidate patches, or integration overwrites.

## Verification layer: `src/process.mjs`

Checks are spawned from argv arrays, never through a shell. Each check runs in either the candidate cwd or the target project cwd and observes its own `timeoutMs`. Timeout or cancellation kills the process group CAO started. Captured output is bounded and written into evidence JSON.

Verification commands are expected not to edit source files. `verify` and `integrate` compare snapshots before and after checks; if checks mutate source state, the attempt fails or remains held for recovery.

## Token usage: `src/usage.mjs`, `src/runtime/tokscale.mjs`

`UsageService` queries an optional external Tokscale CLI and leaves the CAO ledger unchanged. The adapter validates version, grouping, numeric fields, and aggregate totals before the service returns token buckets. Machine queries group client/provider/model; scoped queries call one workspace report per client, match recorded worker directories, and expose attribution precision and coverage. Checkout and ambiguous observations are separated from task totals. See [usage reports](usage.md) for installation, counter semantics, and coordinator/session limitations.
