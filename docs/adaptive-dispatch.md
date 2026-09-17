# Opt-in adaptive dispatch

> 中文: [zh-CN/adaptive-dispatch.md](zh-CN/adaptive-dispatch.md)

Adaptive dispatch binds an eligible resource to an actual task attempt. It is opt-in; existing delegated and shadow conversations retain their behavior.

```bash
node bin/cao.mjs dispatch --adaptive --run RUN_ID --file task.json
node bin/cao.mjs dispatch --adaptive --run RUN_ID --file task.json --executor external --resources RESOURCE_ID
# Or explicitly enable it for the current conversation:
node bin/cao.mjs mode enable --strategy adaptive --preference balanced
```

Use `resources list` and explicit `calibrate` first. Dispatch does not secretly run model probes. Missing/expired evidence can prevent an external selection. Omit task `agent` or use `auto` for free selection; a concrete agent, fixed profile, profile pool, resource allowlist or explicit executor constrains the choice. Explicit worktree isolation prevents current-host execution. Without an explicit isolation, a host choice uses checkout while an external choice keeps the default worktree.

If host is selected, dispatch returns a registered host task; the current conversation must implement, `host report`, and independently `host verify` it. Dispatch never makes the current App execute edits by itself. External selections launch through Herdr and keep the usual collect/verify/integrate workflow.

Every adaptive attempt records the original request digest, selected resource fingerprint and decision. Repeating the same request returns its existing attempt. A changed request under the same task id is rejected. Configuration drift before launch fails explicitly. Retries retain the same effective task/resource binding; they do not silently switch providers. Managed profile fallback chains are disabled for this pinned attempt, so an unselected fallback cannot run. Use a new scoped task after diagnosing a needed route change.

Native selections use `execution: {"native": true}` and explicit model/provider arguments, so the global CAO default profile cannot replace them. This does not rewrite native settings. Native resource metadata is observed configuration, not a complete freeze of project plugins or opaque proxy internals. Known capacity groups are reserved; unknown account relationships remain conservative. Native children are not a hard provider request limit.

Preferences currently use conservative rules. Matching same-run history requires the exact resource fingerprint and task kind, at least three terminal samples, and retains failures in the denominator. Both fastest and quality-first prefer higher observed completion fractions. Quality-first then prefers more integrated outcomes before elapsed time; fastest then prefers lower elapsed time. Subscription-first does not reorder from this history. These small samples and isolated calibration do not establish universal performance or statistical quality guarantees. No automatic install or calibration occurs.

## Native child evidence

Set `maxChildren` and `nativeInstructions` only for an installation whose native tools support the requested work. CAO does not force creation of subagents. Claude private hook records now participate in acceptance: an observed unfinished or omitted child blocks collection/verification, and parent Stop does not substitute for SubagentStop. Missing or damaged telemetry remains unknown for adaptive Claude tasks that permit children. Other harnesses retain explicitly labelled report-contract evidence.

If child completion cannot be established, CAO retains capacity and reports the blocker. It does not kill unowned descendants or fabricate a completed status. Existing legacy tasks retain their report-contract fallback when telemetry is unavailable; observed unfinished children still block them.

Monitor snapshots expose bounded route and child-evidence metadata. Full project acceptance remains separate from candidate acceptance. This implementation is an opt-in dispatch mechanism; a full real multi-agent throughput experiment and the S6 default rollout are still pending.
