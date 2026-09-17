# 显式启用自适应派发

> English: [../adaptive-dispatch.md](../adaptive-dispatch.md)

自适应派发会将可用资源绑定到实际 attempt；必须显式启用，原有 delegated/shadow 对话不变。

```bash
node bin/cao.mjs dispatch --adaptive --run RUN_ID --file task.json
node bin/cao.mjs dispatch --adaptive --run RUN_ID --file task.json --executor external --resources RESOURCE_ID
# 或为当前对话开启：
node bin/cao.mjs mode enable --strategy adaptive --preference balanced
```

先使用 resources list 和显式 calibrate 获得证据。派发不会暗中调用模型测速；证据不足或过期时可能没有合格外部候选。任务省略 agent 或填写 auto 可自由选择；具体 agent、固定 profile、profile 池、资源允许列表和 executor 都会约束选择。显式 worktree 排除当前 host；省略 isolation 时，host 使用 checkout，外部执行保持默认 worktree。

选择 host 后只返回已登记任务，由当前对话继续实现并调用 host report/verify；dispatch 不会让 App 自动编辑。选择外部资源则通过 Herdr 启动，继续原有 collect/verify/integrate 流程。

每个 attempt 保存原始请求摘要、资源指纹和决策。相同请求重复派发只返回原 attempt；相同 ID 改变请求则拒绝。启动前配置漂移会明确失败。重试保留有效任务和资源绑定，不暗中换提供商；本次受管 profile 的 fallback 链禁用，避免运行未选择的配置。需要换方案时，诊断后创建新的明确任务。

原生选择使用 `execution: {"native": true}` 并传入模型/provider 参数，因此 CAO 默认 profile 不会覆盖它，不修改原生配置。资源指纹是配置观测，不是对全部项目插件或代理内部模型的完整冻结。已知容量分组受约束，未知账号关系保持保守；原生子代理并不是 provider 请求级硬限流。

当前偏好采用保守规则。同一 run 的历史仅匹配相同资源指纹和任务类别，至少三个终态样本，并将失败纳入分母。fastest 和 quality-first 都先比较实际完成比例；quality-first 随后优先 integrated 次数，fastest 随后优先更短耗时。subscription-first 不按这段历史重排。少量样本与隔离校准不代表普遍速度/质量保证。不会自动安装或测速。

## 原生子代理证据

仅为确认支持的原生能力设置 maxChildren 和 nativeInstructions，CAO 不强制创建子代理。Claude 私有 hook 事件会参与验收：观察到未结束或被遗漏的 child 时阻止提交/验收，父会话 Stop 不等于 SubagentStop。允许子代理的 adaptive Claude 任务缺失或损坏遥测时保持 unknown。其他 harness 继续明确标注为报告合同证据。

无法确认 child 完成时保留容量并报告阻塞，不杀无法归属的后代，不伪造完成状态。旧任务在遥测不可用时保留报告合同回退，但观察到未结束 child 仍会阻止验收。

看板 snapshot 增加有界的路由和子任务证据字段；完整项目验收仍与候选验收分开。本轮提供显式开启的派发机制，真实多 Agent 吞吐对照与 S6 默认推广尚待完成。
