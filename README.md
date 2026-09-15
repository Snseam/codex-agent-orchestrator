# Codex Agent Orchestrator

**AI coding agent orchestration with Herdr, Git worktrees, and independent verification.**

[![CI](https://github.com/Snseam/codex-agent-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/Snseam/codex-agent-orchestrator/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-22.13%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

**English** · [简体中文](README.zh-CN.md)

[Start in Codex](#start-in-codex) · [CLI quick start](#quick-start) · [How it works](#how-it-works) · [Execution profiles](#execution-profiles) · [Agent support](#agent-support) · [Token usage](#token-usage) · [Documentation](#documentation) · [Contributing](CONTRIBUTING.md)

Codex Agent Orchestrator (**CAO**) is a local, zero-dependency Node.js CLI for coordinating coding agents through [Herdr](https://github.com/herdrdev/herdr). Let Codex App or Codex CLI plan the work, assign scoped tasks to Claude Code or other agent sessions, and verify their changes before integrating them into your project.

> **Early preview.** The base Claude Code workflow has passed local end-to-end tests, including controlled failure and repair. Profiled execution has also been checked with Herdr 0.9+ using two Claude sessions against a local Anthropic-compatible test server. Codex and Pi profile requests have passed local mock API checks; their complete Herdr workflows and OpenCode remain unverified. Large-scale speed, quality, and cost effects have not been measured.

## Start in Codex

**Paste once, then describe your work normally.** This tells Codex to use CAO by default for subsequent development tasks in that conversation. You do not need to write task JSON, run the CLI yourself, or globally install a skill.

1. Open a **new or existing local conversation** in Codex App or Codex CLI with access to your project files and terminal.
2. Copy the entire prompt below. Keep the defaults, or edit the project, agent, and limits to suit your work.
3. After Codex reports that setup is ready, send your development request. You can also append the first request to the same message.

```text
Use Codex Agent Orchestrator (CAO) by default for development tasks in this conversation from now on, until I ask to turn it off. Keep this preference scoped to this conversation.

Project: use the current project; ask for its path only if unclear.
Worker agent: use an existing compatible CAO profile when configured; otherwise use my configured Claude Code.
Maximum concurrent external sessions: 2.
Maximum attempts per task: 3.

Set up the workflow:
- Find and reuse my local CAO checkout. If absent, clone https://github.com/Snseam/codex-agent-orchestrator into an unused directory outside the target project, and report that path. Preserve existing files.
- Read the checkout's README.md and skills/herdr-dev/SKILL.md, resolve bin/cao.mjs to an absolute path, and check --help and doctor. Use node with that CLI path; a global cao command or skill installation is not required.
- Check the target Git repository, installed agents, and existing CAO profiles/default. Keep one shared CAO state directory outside the target project. If an essential dependency, login, initial Git commit, or permission is missing, explain the exact blocker and the smallest next step. Do not claim setup succeeded or silently switch workflows.
- Preserve my native agent and CC Switch provider/authentication settings. Do not install dependencies or change global configuration just to activate this preference.

For subsequent development requests:
- You own requirements, task boundaries, acceptance checks, review, and integration. Generate task files and drive CAO yourself; delegate implementation through CAO-managed sessions.
- Give independent work separate worktrees and clear owned paths. Respect dependencies; request useful native agent collaboration only when actually supported.
- Drive dispatch → collect → verify. Use evidence to repair within the attempt limit, then integrate accepted changes and recheck the project. Terminal idle or an agent's success claim is not acceptance.
- Inspect needs_input or uncertain outcomes before acting; never blindly replay an assignment. Stop and clean up owned sessions when finished or cancelled, retaining evidence.
- Keep the resolved CLI path, project, state directory, run/task IDs, and this preference in your conversation handoff notes. After an interruption, inspect the recorded run before continuing.
- Answer questions and planning requests directly without starting workers. If a requested development task cannot use CAO, explain why rather than quietly doing it another way. Respect later instructions and existing authorization for commits or publication.

If I supplied no development task, only check readiness and report the resolved paths, selected agent/profile, and any blocker. Then wait for my next request.
```

Once ready, messages can be as simple as:

```text
Add CSV import to this project. Handle duplicate rows and malformed files, add regression coverage, and finish integration with passing checks.
```

| What you want | What to send in the same conversation |
| --- | --- |
| See progress | “Show the current CAO run, task states, and blockers.” |
| Change the agent | “Use my configured Pi for subsequent CAO tasks; check compatibility first.” |
| Handle one task directly | “For this task only, work directly without CAO.” |
| Turn off the default | “Stop using CAO by default in this conversation. Inspect and safely stop any active CAO work first; keep its changes and evidence.” |
| Restore the default | “Use CAO by default again for development tasks in this conversation.” |

This is a **conversation instruction**, not an account-wide setting or background scheduler. Paste it again in a different conversation. It does not promise continued orchestration after Codex stops running. To resume an existing run in another conversation, also provide its project, state directory, and run ID so Codex can inspect it before starting anything new.

The prompt can fetch CAO itself, but it still needs Node.js 22.13+, Git, Herdr, a configured supported agent, and a target repository with at least one commit. Codex reports missing prerequisites during setup. For a brand-new project, explicitly ask it to create the initial Git skeleton and commit first. See [manual CLI setup](#quick-start) or [execution profiles](docs/execution-profiles.md) for more control.

## Why CAO?

- **Coordinate existing agents.** Use Herdr-managed sessions while preserving each CLI's provider and model configuration.
- **Choose execution profiles.** Route tasks to native Claude, Codex, Pi, or OpenCode profiles with local relay gateways, stored secrets, fallbacks, and capacity reservations.
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

- **Node.js 22.13+** and **Git**.
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

By default, commands return JSON, with errors on stderr; `--help` prints usage. State lives outside the target project, by default under `~/.local/state/codex-agent-orchestrator` or `$XDG_STATE_HOME/codex-agent-orchestrator`. Use the same `--state-dir` across commands and runs that coordinate one project.

## Execution profiles

Execution profiles are optional. They let CAO select a native agent, model, upstream endpoint, credential reference, and routing policy per task while keeping global provider files unchanged. Profiles can be authored directly or imported from a read-only CC Switch database. Stored secrets are read from stdin or environment references; secret values are never stored in profile JSON.

Useful commands:

```bash
node bin/cao.mjs profile put --file profile.json --default
printf '%s\n' "$ANTHROPIC_API_KEY" | node bin/cao.mjs secret set --id anthropic-main --stdin
node bin/cao.mjs source discover --directory ~/.cc-switch
node bin/cao.mjs profile import-cc-switch --provider claude-main --app claude --id claude-main
node bin/cao.mjs route explain --file work/task.json
node bin/cao.mjs gateway list
```

Routing supports fixed profiles and automatic `agent: "auto"` selection. A default profile is an execution selector too: if a legacy task omits `execution`, CAO can use the default profile, including for `agent: "auto"`. With a concrete task agent, the default must still be compatible with that agent.

The first CC Switch source adapter targets schema version 18 and supports direct Claude API records from `settings_config.env` plus explicit `--allow-shared` reuse of the active Claude proxy. OAuth-only and non-Claude records are listed as unsupported rather than imported as direct profiles. See [execution profiles and routing](docs/execution-profiles.md).

## Agent Monitor

Agent Monitor is a local, read-only status page for CAO runs and related Codex/Claude children. From a project checkout, start it with:

```bash
node bin/cao.mjs monitor start --open
```

Or ask Codex:

```text
打开当前项目Agent看板
```

When `--project`, `--run`, and `--all` are omitted, the CLI uses the current directory's Git root. The page is localhost-only, uses a URL fragment token that the browser stores in `sessionStorage`, and exposes metadata only. It does not execute commands, send input, cancel tasks, stop agents, or display prompts/tool inputs/tool outputs/model replies. `monitor stop` stops only the monitor server.

The monitor distinguishes CAO delivery from native runtime state: a native child can be idle or finished without the CAO attempt being `accepted`. Codex metadata prefers app-server proxy and currently falls back to local SQLite metadata when proxy is unavailable; Claude child state is strongest for new CAO-managed attempts with private hooks and lower confidence for unmanaged local fallback. The page also has a Project view and Conversation view, and can show per-agent token metadata when native records provide it; token rows are usage observations, not plan balance, billing truth, or exact task cost. See [Local Agent Monitor](docs/monitor.md).

To inspect the current conversation view with token columns, you can ask Codex:

```text
打开当前项目Agent看板，切到当前对话并显示每个Agent Token
```

## Agent support

| Agent | Task value | Current validation |
| --- | --- | --- |
| Claude Code | `claude` | Local live workflow and controlled repair verified; profiled local relay verified with a simulated Anthropic API |
| Pi | `pi` | Native CLI profile request verified against a mock API; complete Herdr workflow not yet verified |
| OpenCode | `opencode` | Launch and profiled runtime adapter implemented; live workflow not yet verified |
| Codex CLI | `codex` | Native CLI profile request verified against a mock API; complete Herdr workflow not yet verified |

`agentArgs` forwards CLI-specific options in inherited mode. Profiled tasks reject arguments that would conflict with profile-owned model, provider, session, config, or worktree settings; Codex allows selected reasoning and verbosity `-c` overrides. `nativeInstructions` describes how a worker should use its available native tools. `maxChildren` is a reporting contract, not a measured or enforced count of running subagents. See the [adapter architecture](docs/architecture.md) and [execution profiles](docs/execution-profiles.md).

## Token usage

CAO can query local token records through the optional external Tokscale CLI. Tokscale is not a CAO runtime dependency; install it separately if you want reports:

```bash
npm install -g @tokscale/cli@4.16.0
node bin/cao.mjs usage --today
```

Use `--tokscale-bin /path/to/tokscale` or `CAO_TOKSCALE_BIN=/path/to/tokscale` when the binary is not on `PATH`. JSON is the default output; add `--table` for a compact terminal view. Machine reports cover local records for `claude`, `codex`, `pi`, and `opencode`. Run/task reports are workspace-scoped and always set `attribution.exactTaskAttribution: false`; they do not prove exact causal task usage. CAO calls only Tokscale local `models --json` reports, omits costs, and never calls Tokscale `submit`, `autosubmit`, `usage`, or any model. See [token usage reports](docs/usage.md).

## Verification and boundaries

- CAO is explicitly driven by its caller; it has no background scheduler or MCP server. The local Agent Monitor can observe selected native metadata, but coverage is source-dependent and not a hard native-child telemetry guarantee.
- Worktrees and `allowedPaths` are coordination controls, not a filesystem sandbox. Ignored untracked files and external side effects are outside the Git snapshot.
- Failed integration can leave edits in the project. CAO blocks new work for that project until recovery succeeds; `recover` rechecks the current checkout without applying the patch again.
- Direct `checkout` tasks can retain unverified edits too. Retry that task or recover after its worker stops. Shared project locks require one state directory.
- Interrupted verification fails closed and needs process/evidence inspection. `resume` does not blindly resend work or replay checks.
- CAO does not automatically commit, push, publish, install dependencies, or change model providers.

Validation evidence includes offline tests, explicit Herdr checks, base Claude Code live scenarios, and a profiled execution smoke with Herdr 0.9+ using two Claude sessions against a local simulated Anthropic API. The profiled smoke covered separate profile model/key routing, Read/Write/Bash/tool submission, independent acceptance, 16 matched gateway requests, unchanged global provider files, and runtime release. This is functional integration evidence, not a measurement of real model quality, provider billing, or production reliability.

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
| [Architecture](docs/architecture.md) | CLI, state store, Herdr runtime, Git isolation, verification, profiled execution |
| [Execution profiles and routing](docs/execution-profiles.md) | Profile CRUD, secrets, CC Switch import, routing, gateway lifecycle |
| [Local Agent Monitor](docs/monitor.md) | Read-only local dashboard for CAO, Codex, and Claude metadata |
| [Task states and recovery](docs/states.md) | Result contract, retries, interaction, checkout and integration holds |
| [Token usage reports](docs/usage.md) | Optional Tokscale integration, JSON shape, attribution boundaries |
| [Codex skill draft](skills/herdr-dev/SKILL.md) | Guidance for driving CAO from Codex; not installed automatically |
| [Changelog](CHANGELOG.md) | Release history |
| [中文文档](README.zh-CN.md) | Chinese overview and getting started |

## Contributing and support

Bug reports, documentation fixes, and focused pull requests are welcome. Read the [contribution guidelines](CONTRIBUTING.md) and [code of conduct](CODE_OF_CONDUCT.md), then [open an issue](https://github.com/Snseam/codex-agent-orchestrator/issues/new/choose).

For security vulnerabilities, follow [SECURITY.md](SECURITY.md) and use private reporting instead of public issues.

Maintained by [Snseam](https://github.com/Snseam). CAO is an independent project integrating with existing coding tools.

## License

[Apache License 2.0](LICENSE). Copyright 2026 Snseam. See [NOTICE](NOTICE).
