# 架构与模块

CAO 是一个显式驱动的 CLI 控制器。它不常驻后台，没有 daemon 或 MCP 原生 children 监测，不接管 provider 配置，不自动安装插件，也不自动 commit/push。每次命令读取状态、执行一个阶段、写回状态并退出。

## 运行边界

```text
用户/Codex App
  -> node bin/cao.mjs <command>
      -> Orchestrator
          -> State store
          -> Git/worktree/patch
          -> Herdr runtime
              -> claude | pi | opencode | codex
          -> verification commands
```

CAO 只管理自己创建的 run、attempt、Herdr session、workspace/pane 和证据文件。agent 自身的模型、账号、provider、权限、原生子代理能力和本地配置由对应工具负责。

## 入口层：`bin/cao.mjs`

CLI 负责参数解析、读取任务文件、创建 `Orchestrator` 和输出 JSON。命令集合是固定阶段：`init`、`validate`、`dispatch`、`status`、`inspect`、`collect`、`verify`、`retry`、`resume`、`input`、`integrate`、`recover`、`cancel`、`cleanup`、`doctor`。

重要语义：

- `dispatch` 只提交一次。
- `collect` 等待和对账，不重新提交。
- `verify` 验证已收集候选，不向 agent 继续发任务。
- `integrate` 应用已验收 patch 并在目标项目复验。
- `recover` 只复验已保留在 checkout 中的恢复场景：incomplete integration 不再次 apply patch；stopped checkout 任务按当前 checkout 重新验收。

## Orchestrator：`src/orchestrator.mjs`

Orchestrator 是状态机和流程协调层。

- `init`：确认项目 Git root、记录 `baseCommit`、项目快照、初始 dirty 状态和 CAO 专用 Herdr session。
- `dispatch`：校验任务、检查依赖和容量、创建 attempt、准备隔离目录、启动 Herdr server/workspace/agent、发送 prompt。
- `collect`：观察 Herdr agent 状态，读取 result JSON，校验 attempt nonce、child 报告、允许路径和候选快照。
- `verify`：关闭 worker pane，运行 checks，保存 `check-*.json` 与 `verification.json`，worktree 任务通过后生成 `candidate.patch`。
- `retry`：在 `rework`、`failed`、`interrupted`、`cancelled` 后创建下一 attempt，把报告、验收结果和反馈带入新 prompt。
- `integrate`：对 accepted worktree attempt 应用 patch 到目标项目，并重新运行 checks；失败或取消会形成跨 run hold，直到 recover 通过。
- `recover`：对 integration hold 复验当前 checkout，不再次 apply patch；对已停止的 failed/rework/interrupted/cancelled checkout 任务，按当前 checkout 重新进入 verify。
- `cancel`/`cleanup`：关闭 worker 或停止 CAO session；证据与工作树保留。checkout cancel 无改动时释放 checkout hold；cleanup 关闭 run 的新 dispatch，但不清除 hold。

## 状态层：`src/state.mjs`

默认状态根是 `~/.local/state/codex-agent-orchestrator`，也可以用 `--state-dir` 指定。状态根必须在目标项目外部。

目录形态：

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
      integration.json
```

写 JSON 使用临时文件 + rename；锁使用目录锁，带 pid/hostname/nonce owner。只恢复同主机且进程确定死亡的锁。checkout 单写锁和项目集成锁位于 `<stateRoot>/locks/`，因此只在相同 stateRoot 下互相可见。

## 任务与 prompt：`src/task.mjs`、`src/adapters.mjs`

`validateTask` 严格拒绝未知字段和不安全路径。`compilePrompt` 把任务目标、允许路径、检查命令、原生说明、child 报告契约和 result JSON skeleton 写入 prompt。

adapter 保留 provider 设置。完整 assignment 写入 attempt 的 `prompt.txt`；`dispatch` 注入 worker 的是短入口 prompt，只要求 agent 读取 `prompt.txt` 并执行其中的 result contract。

adapter 保留 provider 设置：

- `claude`：Herdr kind 为 `claude`，启动参数会先加 `--add-dir <attemptDirectory>`，再追加 `agentArgs`。
- `pi`、`opencode`、`codex`：按 `agentArgs` 原样传给 Herdr `agent start`。

`maxChildren` 是报告契约。CAO 只验证 result JSON 中 `children.length <= maxChildren` 和 child 状态字段，不监控真实原生 child/subagent 数量，没有 MCP/daemon telemetry，也不保证它们已停止。

## Herdr runtime：`src/runtime/herdr.mjs`

runtime 只操作显式 session，并拒绝 default session。调用 Herdr 前会清理继承的 `HERDR_SOCKET_PATH`、`HERDR_SESSION`、`HERDR_PANE_ID` 等环境变量，避免误连当前 pane。

主要操作：

- `ensureServer`：启动 `herdr --session <session> server`，轮询 `api snapshot` 至多 10 秒。
- `createWorkspace`：在 attempt cwd 创建 workspace，不抢焦点。
- `startAgent`：在 root pane 启动指定 kind 的 agent。
- `prompt`、`keys`、`readAgent`：提交 prompt、发送人工输入、读取可见输出。
- `closePane`、`stopServer`：关闭 worker pane 或停止 CAO session。

CAO 依赖 Herdr 的 pane/terminal/process identity。attempt 会记录 `paneId`、`terminalId`、foreground process group、shell pid 和 agent kind；collect/input/cancel 会复核这些值。若 terminal、pane、process group、shell pid 或 kind 改变，CAO 会拒绝收集、输入或关闭，避免误接管替换后的 pane。

## Git 层：`src/git.mjs`

Git 层负责项目快照、worktree、patch 和集成前冲突检查。

- 快照包含 tracked + untracked 且未被 gitignore 排除的文件，记录 hash、mode、type。
- 快照拒绝 submodule，不读取 `.git`，也拒绝经过 symlink ancestor 的路径。
- worktree 任务使用 `git worktree add --detach`；源项目 dirty 时，会先把当前 tracked/untracked 状态写入 tree，再把候选 worktree reset 到该 tree，保留用户未提交基线。
- `makePatch` 用临时 `GIT_INDEX_FILE` 生成 binary patch，不修改用户真实 index。
- `applyPatch` 先 `git apply --check`，再 `git apply`；不 stage、不 commit。

Gitignored 文件不会进入快照、candidate patch 或集成覆盖范围。

## 验证层：`src/process.mjs`

checks 使用 argv 数组直接 spawn，不走 shell。每个 check 在候选 cwd 或目标项目 cwd 运行，遵守 `timeoutMs`。超时或取消会终止 CAO 启动的进程组；stdout/stderr 有大小上限并写入证据 JSON。

验证命令不应修改源码。`verify` 和 `integrate` 都会检查验证前后快照是否稳定；如果验证修改了源码，attempt 会进入失败/返工状态。
