import type { WorkflowStore } from '../storage-sqlite/workflows.ts';
import type { GitHubRest } from './github.ts';
import type { GitHubClient } from '../provider-github/client.ts';
import { safeReason } from '../core/diagnostics.ts';

export async function publishRunSummary(store: WorkflowStore, runId: string, rest: GitHubRest, client: GitHubClient) {
  if (!store.summaryDue(runId) || !store.summaryAllowed(runId) || store.projectionAllowed(runId) && store.pendingProgressWrite(runId)) return;
  const run = store.get('run', runId), status = store.controlStatus(runId), session = store.managedSession(runId), diagnostic = store.workflowDiagnostic(runId);
  const marker = `<!-- labstride:summary:${runId} -->`;
  const conflicts = store.managedProjectionDiagnostics(runId);
  const body = `${marker}\nLabstride run: \`${runId}\`\n\nPhase: \`${status.phase}\`\nAutomation: \`${safeReason(status.queueReason ?? 'enabled')}\`\nDiagnostic: \`${safeReason(diagnostic ?? 'none')}\`\nRepairs: ${status.budget.repairs}/${status.budget.maxRepairs}\nUnattended limit: ${status.budget.unattendedMs} ms\nBudget hold: \`${safeReason(status.budgetHold ?? 'none')}\`\nUnknown operations: ${status.operations.filter(op => op.state === 'outcome_unknown').length}\nField conflicts: ${conflicts.length}\n${session ? `Session: \`${session.sessionId}\`\n\nUse the same session for questions and plan approval.\n` : ''}`;
  const intent = store.summaryIntent(runId, body);
  if (!intent.dispatch && !intent.pending) return;
  const source = store.operations(runId)[0].request.source, path = `/repos/${source.repository}`;
  if (intent.number) {
    const current = await rest.request('GET', `${path}/issues/comments/${intent.number}`);
    if (current.body === intent.body) { store.completeSummary(runId, intent.number, intent.body); return; }
    if (!intent.dispatch) return; // Lost acknowledgement is read-only recovery.
    if (current.body !== intent.previous || !current.body.includes(marker)) { store.summaryError(runId, 'summary_conflict'); return; }
    if (!store.summaryAllowed(runId)) return;
    await rest.request('PATCH', `${path}/issues/comments/${intent.number}`, { body: intent.body });
    const readback = await rest.request('GET', `${path}/issues/comments/${intent.number}`);
    if (readback.body !== intent.body) { store.summaryError(runId, 'summary_conflict'); return; }
    store.completeSummary(runId, intent.number, intent.body); return;
  }
  if (!intent.dispatch) return; // An unknown create never becomes a second comment.
  const issueId = store.get('request', run.requestId).issueId;
  const data = await client.query('query LabstrideSummaryIssue($id:ID!){node(id:$id){... on Issue{number repository{nameWithOwner}}}}', { id: issueId }, rest.reference) as any;
  if (data.node?.repository?.nameWithOwner !== source.repository || !Number.isSafeInteger(data.node.number)) throw Error('identity_mismatch');
  if (!store.summaryAllowed(runId)) return;
  const created = await rest.request('POST', `${path}/issues/${data.node.number}/comments`, { body: intent.body });
  if (!Number.isSafeInteger(created.id) || created.body !== intent.body) throw Error('outcome_unknown');
  const readback = await rest.request('GET', `${path}/issues/comments/${created.id}`);
  if (readback.body === intent.body) store.completeSummary(runId, created.id, intent.body);
}
