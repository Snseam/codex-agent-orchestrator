# Codex Agent Orchestrator

由 Codex App 统筹，通过 Herdr 管理 Claude Code、Pi 和其他 coding agent 的协作开发工具。

优先提高允许自动多轮修复后的完整验收通过率，再优化相同完成率下的交付速度。

## 当前状态

项目处于初始化阶段。仓库目前记录项目方向，控制器及 Agent 适配器尚未实现。

## 架构方向

- **Codex App**：需求、任务图、角色分配、跨模块决策与最终验收。
- **薄控制器**：任务和尝试身份、状态记录、派发、恢复与容量管理。
- **Herdr**：终端运行、会话定位、状态观察与人工接管。
- **Agent 适配器**：复用各 Agent 的原生工具、子代理、团队及会话能力。
- **工作副本与交接产物**：隔离并行修改，保存接口约定和可追溯结果。
- **独立验证入口**：针对固定交付版本执行必要检查，并为修复提供证据。

## 首个开发闭环

```text
创建任务 → Herdr 启动 Claude Code → 下发任务 → 收集结果
    → 独立验证 → 根据失败证据修复 → 最终验收
```

首先实现任务记录、Herdr 接入、Claude Code 适配、验证和恢复，再按实际需求接入 Pi、其他 Agent 和内部协作机制。

## 工作原则

- 保留现有 Agent 的供应商和模型配置。
- 每个任务明确修改范围、依赖和验收条件。
- 区分 Agent 状态、任务提交与最终验收通过。
- 通过明确身份和结果版本处理重试，避免重复执行和误认旧结果。
- 只对独立工作并行执行，保留已有改动并检查整合后的行为。

## 参考

- [Herdr](https://github.com/herdrdev/herdr)
- [Herdr 自动化文档](https://herdr.dev/docs/agent-automation/)
- [Claude Code](https://code.claude.com/docs/)
- [Pi](https://pi.dev/)
