# Codex Agent Orchestrator

Codex Agent Orchestrator（CAO）是一个零依赖 Node 22 CLI，用 Herdr 启动和管理外部 coding agent，在隔离 worktree 中派发任务、收集结果、独立验收、重试并集成补丁。

CAO 不是 daemon，也不是模型供应商。每一步都由 CLI 显式驱动：`dispatch → collect → verify → retry → integrate`。它保留各 agent 自己的 provider、模型、登录态和本地配置；`agentArgs` 只按任务声明透传给对应 agent。

当前实现重点是 Claude/Herdr 的真实运行路径。已有一次真实控制链路完成：首个会话按测试要求保留错误实现、独立验收失败后，由第二个会话修复，随后 `verify` 和 `integrate` 通过。该过程包含人工处理新 fixture trust，以及一次长粘贴只落在输入框、由 controller 补 Enter 的干预；新版短 prompt 路径也已完成正常冒烟：确认测试目录 trust 后，任务派发、修复、验收、集成和清理均通过，任务派发后没有补输入。两次实验不构成大规模完成率或速度提升的证据。Pi、OpenCode、Codex 目前只有 Herdr 启动适配与提示契约，尚未做端到端验证。

## 要求

- Node.js 22+
- Git，目标仓库至少有一个 commit
- Herdr CLI
- 至少一个 Herdr 支持的交互式 coding agent：`claude`、`pi`、`opencode` 或 `codex`

本仓没有 npm 运行依赖。可以直接用 `node bin/cao.mjs ...`。

## 快速开始

先确认 CLI 和环境：

```bash
cd /Users/yyl-macbookpro/Program/codex-agent-orchestrator
node bin/cao.mjs --help
node bin/cao.mjs doctor
```

初始化一个 run。状态目录必须在目标项目外部；默认是 `~/.local/state/codex-agent-orchestrator`，也可以用 `--state-dir` 指定。

```bash
node bin/cao.mjs init \
  --project /path/to/target-repo \
  --id demo-run \
  --max-parallel 2
```

创建任务 JSON，例如 `task.fix-math.json`：

```json
{
  "id": "fix-math",
  "objective": "修复 src/math.mjs 中 add(a,b) 的实现，并保持现有 API 不变。",
  "agent": "claude",
  "role": "implementer",
  "allowedPaths": ["src/math.mjs", "tests/math.test.mjs"],
  "checks": [
    {
      "name": "node tests",
      "argv": ["node", "--test", "tests/math.test.mjs"],
      "timeoutMs": 60000
    }
  ],
  "isolation": "worktree",
  "agentArgs": [],
  "nativeInstructions": "优先做最小修改；不要提交、不要推送。",
  "maxChildren": 0,
  "maxAttempts": 3,
  "dependsOn": []
}
```

先校验任务格式：

```bash
node bin/cao.mjs validate --file task.fix-math.json
```

派发任务。`dispatch` 只提交一次；如果提交后 CLI 超时，后续用 `collect` 或 `resume` 对账，不会自动重复发送同一个 prompt。CAO 会把完整任务写到 attempt 目录的 `prompt.txt`，真正注入 worker 的是一个短入口，要求 agent 读取该文件后执行。

```bash
node bin/cao.mjs dispatch --run demo-run --file task.fix-math.json
node bin/cao.mjs status --run demo-run
node bin/cao.mjs inspect --run demo-run --task fix-math --output
```

收集 agent 结果。agent 必须最后写入 CAO 提供的 `result.json`，并打印 `CAO_RESULT <attemptId>`；CAO 会检查 nonce、changedFiles、children、unresolved 与允许路径。

```bash
node bin/cao.mjs collect --run demo-run --task fix-math --wait-ms 45000
```

独立验收。`verify` 会关闭 worker pane，然后在候选 worktree 运行任务里的 `checks`。通过后才生成候选 patch。

```bash
node bin/cao.mjs verify --run demo-run --task fix-math
```

如果验收失败，给出反馈重试。重试沿用同一个候选 worktree 和已有改动，创建新的 attempt、nonce 和 prompt。

```bash
printf '测试仍失败，请根据 check-*.json 修复。\n' > feedback.txt
node bin/cao.mjs retry --run demo-run --task fix-math --feedback-file feedback.txt
node bin/cao.mjs collect --run demo-run --task fix-math --wait-ms 45000
node bin/cao.mjs verify --run demo-run --task fix-math
```

集成到目标项目。`integrate` 只对 `worktree` 任务可用：它验证候选 patch 未变、目标文件未被别人改动，然后应用 patch 并在目标项目重新运行 checks。CAO 不会自动 commit 或 push。若 apply 后复验失败，改动会保留在当前 checkout，项目进入 integration hold；修好后用 `recover` 复验当前 checkout，不会再次 apply patch。

```bash
node bin/cao.mjs integrate --run demo-run --task fix-math
```

清理只停止 CAO 为该 run 启动的 Herdr session 并关闭该 run 的新 dispatch；worktree、状态记录和证据会保留。`cleanup` 不清除 checkout/integration hold。

```bash
node bin/cao.mjs recover --run demo-run --task fix-math   # 仅在 incomplete integration 或 stopped checkout 需要恢复时使用
node bin/cao.mjs cleanup --run demo-run
```

## 命令速查

| 命令 | 作用 |
| --- | --- |
| `init --project PATH [--id ID] [--max-parallel N]` | 创建 run，记录项目基线和 CAO 专用 Herdr session。 |
| `validate --file TASK.json` | 校验任务 JSON。 |
| `dispatch --run ID --file TASK.json` | 预留 attempt、准备 worktree/checkout、启动 agent 并发送 prompt。 |
| `status [--run ID]` | 查看 run 列表或某个 run 的任务/attempt 状态。 |
| `inspect --run ID --task ID [--output]` | 查看单个任务；`--output` 会读取 worker 可见输出。 |
| `collect --run ID --task ID [--wait-ms N]` | 等待并收集 result JSON，不重新提交。 |
| `verify --run ID --task ID` | 停止 worker，运行 checks，生成 verification。 |
| `retry --run ID --task ID [--feedback-file PATH]` | 在失败/中断/取消后创建下一次 attempt。 |
| `resume --run ID --task ID` | 对账中断状态；未提交则尝试发送，已提交则 collect。 |
| `input --run ID --task ID (--keys enter | --text-file PATH)` | 给仍可交互的 worker 发送人工输入。 |
| `integrate --run ID --task ID` | 把已验收 worktree patch 应用到目标项目并复验。 |
| `recover --run ID --task ID` | 复验当前 checkout：用于 incomplete integration 或已停止的 checkout 任务，不重放 worker、不重复 apply patch。 |
| `cancel --run ID --task ID` | 请求取消并关闭 worker pane；checkout 无改动时可释放 checkout hold。 |
| `cleanup --run ID` | 停止 CAO session、关闭 run 新派发，保留证据，不清除 hold。 |
| `doctor` | 查看本机工具和 agent 可用性。 |

所有命令输出 JSON；错误也以 JSON 写到 stderr。

## 任务字段

`id`、`objective`、`allowedPaths`、`checks` 是必填。`agent` 可选值是 `claude`、`pi`、`opencode`、`codex`，默认 `claude`。`isolation` 可选 `worktree` 或 `checkout`，默认 `worktree`。路径必须是规范化相对路径或以 `/` 结尾的目录前缀；不支持 glob、绝对路径、反斜杠、路径穿越和 `.git`。

`allowedPaths` 是验收范围，不是安全沙箱。agent 进程仍按本机权限运行；CAO 在 `collect` 时拒绝未被允许的 tracked/unignored 变更。未追踪且被 Git 忽略的文件不会进入快照或候选 patch，因此集成时不会覆盖目标项目中的 gitignored 文件。

`maxChildren` 只约束 agent 最终报告中的 `children` 数量。CAO 不监测 Claude/Pi/OpenCode/Codex 的原生 child/subagent 实际生命周期，也没有 MCP/daemon 原生 children telemetry；它不把终端 idle 当作 child 已完成的证明。

## 更多文档

- [架构与模块](docs/architecture.md)
- [状态、隔离与集成语义](docs/states.md)

## 开发与验证

```bash
npm test
npm run check
npm run smoke -- --live             # 两次尝试的受控失败/修复实验
npm run smoke -- --live --happy     # 单次正常修复实验
```

不带 `--live` 的 smoke 只显示说明，不启动模型。遇到终端输入需求时脚本保存 run 和 journal；用 `inspect --output` 检查并处理后，按输出路径执行 `npm run smoke -- --live --resume /absolute/path/to/smoke.json`。真实冒烟在独立测试仓库内执行，保留日志和工作副本；第一次访问目录可能需要确认信任。首版实测环境是 macOS，尚未验证其他操作系统。

仓库内技能草案：[skills/herdr-dev/SKILL.md](skills/herdr-dev/SKILL.md)。当前没有安装到全局。
