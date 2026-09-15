# Changelog

Notable changes to Codex Agent Orchestrator are recorded here. Pre-1.0 interfaces may change between releases.

## Unreleased

### Added

- `usage` queries local Claude Code, Codex CLI, Pi, and OpenCode token records through optional Tokscale tooling (`>=4.16.0 <5`).
- Agent/model/date filters, JSON or terminal-table output, and CAO run/task workspace attribution with explicit precision and coverage metadata.
- Separate input, output, cache read/write, and reasoning counters; incomplete or shared checkout usage is not presented as an exact task total.
- An opt-in synthetic Tokscale integration test and bilingual token-usage documentation.

## [0.1.0] - 2026-09-15

Initial public preview.

### Added

- A zero-dependency Node.js CLI for Herdr-managed coding-agent workflows.
- Durable run/task/attempt records, explicit task dependencies, capacity checks, and duplicate-dispatch protection.
- Isolated Git worktrees, dirty-baseline preservation, scope checks, patch verification, and project integration checks.
- Independent command verification, failure feedback, retry, cancellation, and guarded recovery.
- Launch adapters for Claude Code, Pi, OpenCode, and Codex CLI; a repository-local Codex skill draft.
- English and Simplified Chinese documentation, Apache-2.0 licensing, contribution guidance, and security reporting policy.
- Offline CI for Node.js 22 on macOS and Linux, with separately invoked Herdr and live-agent tests.

### Validation and limitations

- The original 67 local tests passed; the suite now separates 66 offline tests from one read-only Herdr integration test.
- Two local Claude Code scenarios passed: controlled failure/repair and normal task-file dispatch, including project integration checks.
- Pi, OpenCode, and Codex CLI live workflows remain unverified. Native subagent monitoring, a background scheduler, and large-scale performance evaluation are not included.

[0.1.0]: https://github.com/Snseam/codex-agent-orchestrator/releases/tag/v0.1.0
