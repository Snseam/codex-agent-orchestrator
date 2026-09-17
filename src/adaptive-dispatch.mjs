import path from 'node:path';
import crypto from 'node:crypto';
import { invariant } from './errors.mjs';
import { taskDigest, validateTask } from './task.mjs';
import { withLock, runPath } from './state.mjs';
import { ResourceService } from './resources/index.mjs';
import { planAdaptive } from './adaptive-selection.mjs';

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function requestContract(input, options) {
  return hash({ inputDigest: taskDigest(input), explicitAgent: input.agent || null, explicitIsolation: input.isolation || null,
    preference: options.preference || 'balanced', resources: options.allowedResourceIds?.slice().sort() ?? null,
    fixedAgent: options.fixedAgent || null, fixedProfileId: options.fixedProfileId || null,
    executor: options.fixedExecutorKind || null, thread: options.thread || null });
}

function runHistory(run) {
  return Object.values(run.tasks).flatMap(task => task.attempts.flatMap(attempt => {
    const fingerprint = attempt.routeDecision?.resource?.fingerprint;
    const taskKind = task.definition.brief?.taskKind;
    const end = attempt.operation?.finishedAt || attempt.verification?.finishedAt || attempt.performance?.updatedAt;
    if (!fingerprint || !taskKind || !end) return [];
    const elapsedMs = Date.parse(end) - Date.parse(attempt.createdAt);
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return [];
    return [{ fingerprint, taskKind, status: attempt.deadlineExceededAt ? 'timed_out' : attempt.status, elapsedMs, observedAt: end }];
  }));
}

// This controller binds a choice to one attempt. It never reapplies a saved
// recommendation blindly, and a repeated request never creates another worker.
export class AdaptiveDispatcher {
  constructor({ orchestrator, resources } = {}) {
    invariant(orchestrator?.root, 'invalid_adaptive_controller', 'An orchestrator is required.');
    this.orchestrator = orchestrator;
    this.resources = resources || new ResourceService({ root: orchestrator.root });
  }

  async dispatch(runId, input, options = {}) {
    const task = validateTask(input);
    await this.orchestrator._loadRun(runId);
    const thread = options.thread || this.orchestrator.coordinatorId;
    const selection = { ...options, thread };
    const requestDigest = requestContract(input, selection);
    return withLock(path.join(runPath(this.orchestrator.root, runId), `adaptive-${task.id}.lock`), async () => {
      const run = await this.orchestrator._loadRun(runId);
      const existing = run.tasks[task.id];
      if (existing) {
        const attempt = existing.attempts.find(a => a.id === existing.currentAttempt);
        invariant(attempt?.routeDecision?.requestDigest === requestDigest, 'task_conflict', 'This task id is already bound to a different request or execution path.');
        return { ...(await this.orchestrator.inspect(runId, task.id)), duplicate: true, adaptive: true };
      }
      const inventory = await this.resources.discover();
      const plan = await planAdaptive({ input, inventory, ...selection, hostAvailable: Boolean(thread), history: runHistory(run) });
      invariant(plan.effectiveTask && plan.decision.selected, 'adaptive_route_unavailable', 'No eligible execution path satisfies the request.', { decision: plan.decision });
      if (plan.selectedResource?.kind !== 'host') {
        const fresh = await this.resources.get(plan.selectedResource.id);
        invariant(fresh.fingerprint === plan.selectedResource.fingerprint, 'resource_configuration_changed', 'Selected configuration changed before dispatch.');
      }
      const routeDecision = {
        schemaVersion: 1, mode: 'adaptive', applied: true, appliedMeaning: 'bound-to-attempt-not-acceptance',
        requestDigest, inputDigest: plan.inputDigest, decidedAt: new Date().toISOString(),
        selected: plan.decision.selected, resource: plan.selectedResource?.kind === 'host' ? null : plan.selectedResource,
        preference: selection.preference || 'balanced',
        reasons: [...plan.decision.reasons.filter(reason => reason !== 'shadow_advisory_only_not_dispatched'), 'adaptive_bound_to_attempt'],
        evidence: plan.evidence,
        configurationScope: 'observed-user-config-not-all-project-plugins',
      };
      const result = plan.decision.selected.executorKind === 'host'
        ? await this.orchestrator.hostStart(runId, plan.effectiveTask, { thread, routeDecision })
        : await this.orchestrator.dispatch(runId, plan.effectiveTask, { routeDecision });
      return { ...result, adaptive: true };
    });
  }
}
