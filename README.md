# Codex Agent Orchestrator

**AI coding agent orchestration with Herdr, Git worktrees, and independent verification.**

[![CI](https://github.com/Snseam/codex-agent-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/Snseam/codex-agent-orchestrator/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

**English** · [简体中文](README.zh-CN.md)

[Quick start](#quick-start) · [How it works](#how-it-works) · [Agent support](#agent-support) · [Documentation](#documentation) · [Contributing](CONTRIBUTING.md)

Codex Agent Orchestrator (**CAO**) is a local, zero-dependency Node.js CLI for coordinating coding agents through [Herdr](https://github.com/herdrdev/herdr). Let Codex App plan the work, assign scoped tasks to Claude Code or other agent sessions, and verify their changes before integrating them into your project.

> **Early preview.** The Claude Code workflow has passed local end-to-end tests, including controlled failure and repair. Other adapters are implemented but not yet verified end to end. Large-scale speed and completion-rate gains have not been measured.

## Why CAO?

- **Coordinate existing agents.** Use Herdr-managed sessions while preserving each CLI's provider and model configuration.
- **Isolate parallel work.** Assign independent tasks separate Git worktrees, declared file ownership, dependencies, and run capacity.
- **Verify actual changes.** Check result identity and file scope, stop the worker, then run your acceptance commands against its candidate.
- **Repair with evidence.** Start a new attempt with failed check output and the previous worktree's changes intact.
- **Integrate with checks.** Detect changed target files, apply the verified patch, and rerun acceptance commands in the project checkout.
- **Keep work inspectable.** Save tasks, prompts, results, terminal output, patches, and verification logs locally.

## How it works

```mermaid
flowchart TD
    C[Codex App or CLI caller] --> O[CAO: tasks, attempts, dependencies]
    O --> H[Herdr: named sessions and terminals]
    H --> A[Claude Code / Pi / OpenCode / Codex CLI]
    A --> W[Isolated Git worktree]
    W --> V[Independent verification]
    V -->|Failed checks and feedback| O
    V -->|Accepted candidate| I[Apply patch and verify project]
```

Codex decides what to build and how to divide the work. CAO manages the task lifecycle; Herdr runs the interactive terminals. The selected coding agent uses the tools available in its own installation.

```text
dispatch → collect → verify → integrate
                       ↓
                     retry → collect → verify
```

Each stage is an explicit CLI command. Task submission is not completion: `collect` requires an attempt-specific result, and `verify` runs checks independently of the agent's claims.

## Quick start

### 1. Prerequisites

- **Node.js 22+** and **Git**.
- [Herdr](https://github.com/herdrdev/herdr) installed and available on `PATH`.
- A supported coding agent CLI, already configured with its provider and credentials.
- A target Git repository with at least one commit.

Live agent workflows have been tested on macOS. CI checks the offline suite on macOS and Linux; that does not establish live Herdr compatibility on every platform.

### 2. Run from source

```bash
git clone https://github.com/Snseam/codex-agent-orchestrator.git
cd codex-agent-orchestrator
node bin/cao.mjs doctor
```

No `npm install` is needed. There is currently no published npm package.

Try a self-contained workflow with your configured Claude Code:

```bash
npm run smoke -- --live --happy
```

This creates a disposable Git project, fixes a small function in a worktree, verifies and integrates the change, then stops its Herdr session. A new directory may need a trust confirmation. If it pauses, inspect the saved run before supplying input; see [task states and recovery](docs/states.md).

### 3. Assign work in your project

Replace the example path with your target repository:

```bash
node bin/cao.mjs init --project /path/to/your-repo --id demo --max-parallel 2
mkdir -p work
```

Save the following as `work/task.json` in the CAO checkout. This example assumes your target has `src/math.mjs` and `tests/math.test.mjs`; adapt the objective, allowed paths, and checks to your project.

```json
{
  "id": "fix-add",
  "objective": "Fix add(a, b) to return the sum. Preserve the existing API and tests.",
  "agent": "claude",
  "allowedPaths": ["src/math.mjs"],
  "checks": [
    {
      "name": "math tests",
      "argv": ["node", "--test", "tests/math.test.mjs"],
      "timeoutMs": 60000
    }
  ],
  "isolation": "worktree",
  "maxAttempts": 3,
  "maxChildren": 0
}
```

Validate and dispatch:

```bash
node bin/cao.mjs validate --file work/task.json
node bin/cao.mjs dispatch --run demo --file work/task.json
node bin/cao.mjs collect --run demo --task fix-add --wait-ms 30000
```

Check the returned state before advancing. Repeat `collect` while running; use `inspect --output` when input is needed. At `submitted`, run independent verification:

```bash
node bin/cao.mjs verify --run demo --task fix-add
```

If the result is `rework`, start a repair attempt, then collect and verify it again:

```bash
node bin/cao.mjs retry --run demo --task fix-add
```

At `accepted`, integrate the candidate. Close the run after all tasks finish or are cancelled:

```bash
node bin/cao.mjs integrate --run demo --task fix-add
node bin/cao.mjs cleanup --run demo
```

Commands return JSON, with errors on stderr; `--help` prints usage. State lives outside the target project, by default under `~/.local/state/codex-agent-orchestrator` or `$XDG_STATE_HOME/codex-agent-orchestrator`. Use the same `--state-dir` across commands and runs that coordinate one project.

## Agent support

| Agent | Task value | Current validation |
| --- | --- | --- |
| Claude Code | `claude` | Local live workflow and controlled repair verified |
| Pi | `pi` | Launch adapter implemented; live workflow not yet verified |
| OpenCode | `opencode` | Launch adapter implemented; live workflow not yet verified |
| Codex CLI | `codex` | Launch adapter implemented; live workflow not yet verified |

`agentArgs` forwards CLI-specific options. `nativeInstructions` describes how a worker should use its available native tools. `maxChildren` is a reporting contract, not a measured or enforced count of running subagents. See the [adapter architecture](docs/architecture.md).

## Verification and boundaries

- CAO is explicitly driven by its caller; it has no background scheduler, MCP server, or native subagent telemetry.
- Worktrees and `allowedPaths` are coordination controls, not a filesystem sandbox. Ignored untracked files and external side effects are outside the Git snapshot.
- Failed integration can leave edits in the project. CAO blocks new work for that project until recovery succeeds; `recover` rechecks the current checkout without applying the patch again.
- Direct `checkout` tasks can retain unverified edits too. Retry that task or recover after its worker stops. Shared project locks require one state directory.
- Interrupted verification fails closed and needs process/evidence inspection. `resume` does not blindly resend work or replay checks.
- CAO does not automatically commit, push, publish, install dependencies, or change model providers.

Initial validation included **67 local tests** and **two live Claude Code scenarios**. The suite is now separated into offline tests and an explicit Herdr integration test. One early run needed an extra Enter for a long pasted prompt; task-file dispatch passed a subsequent normal run without input after task submission. New-directory trust was handled in both scenarios. These are functional checks, not performance benchmarks.

## Development

```bash
npm test                         # Offline tests; no agent credentials needed
npm run check                    # Syntax checks
npm run test:herdr                # Requires Herdr; does not start an agent
npm run smoke -- --live           # Controlled failure → repair → integration
```

Plain `npm run smoke` only prints instructions. Live smoke tests use your configured agent and may incur provider charges. Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing runtime or recovery behavior.

## Documentation

| Resource | Contents |
| --- | --- |
| [Architecture](docs/architecture.md) | CLI, state store, Herdr runtime, Git isolation, verification |
| [Task states and recovery](docs/states.md) | Result contract, retries, interaction, checkout and integration holds |
| [Codex skill draft](skills/herdr-dev/SKILL.md) | Guidance for driving CAO from Codex; not installed automatically |
| [Changelog](CHANGELOG.md) | Release history |
| [中文文档](README.zh-CN.md) | Chinese overview and getting started |

## Contributing and support

Bug reports, documentation fixes, and focused pull requests are welcome. Read the [contribution guidelines](CONTRIBUTING.md) and [code of conduct](CODE_OF_CONDUCT.md), then [open an issue](https://github.com/Snseam/codex-agent-orchestrator/issues/new/choose).

For security vulnerabilities, follow [SECURITY.md](SECURITY.md) and use private reporting instead of public issues.

Maintained by [Snseam](https://github.com/Snseam). CAO is an independent project integrating with existing coding tools.

## License

[Apache License 2.0](LICENSE). Copyright 2026 Snseam. See [NOTICE](NOTICE).
