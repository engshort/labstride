import type { GitHubItemSnapshot } from '../../contracts/generated/github-item.ts';
import type { GitHubHistoryPage } from '../../contracts/generated/github-history-page.ts';
import type { GitHubReconciliationStatus } from '../../contracts/generated/github-reconciliation.ts';
import type { CompiledConfiguration } from '../configuration/compiler.ts';
import type { RuleObservation } from '../configuration/rules.ts';
import type { BoundStep } from '../configuration/bindings.ts';
import type { StartPlan } from './execution.ts';
import type { LabstrideOperationRequestV1 } from '../../contracts/generated/operation.ts';
import type { ProjectionAdapter } from './observations.ts';
import type { GitHubStore } from '../storage-sqlite/github.ts';
import type { LabstrideInstallationConfigurationV1 } from '../../contracts/generated/config.ts';

export type GitHubItem = GitHubItemSnapshot;
export type GitHubHistory = GitHubHistoryPage;
export type GitHubHistoryEvent = GitHubHistory['events'][number];
export type GitHubProject = GitHubReconciliationStatus;
export interface GitHubItemJob {
  key: string; projectKey: string; itemId: string; subjectId: string; revision: number; cursor: string | null;
}
export interface GitHubCandidate {
  id: string; itemKey: string; observation: RuleObservation;
  source: LabstrideOperationRequestV1['source'];
}
export interface GitHubReader {
  readonly providerId: string;
  beginTick(): void;
  list(scopeId: string, cursor: string | null): Promise<{ items: GitHubItem[]; endCursor: string | null; hasNextPage: boolean }>;
  item(itemId: string): Promise<GitHubItem | null>;
  history(subjectId: string, cursor: string | null): Promise<GitHubHistory>;
  projection?(store:GitHubStore):ProjectionAdapter;
  withConfiguration?(configuration:LabstrideInstallationConfigurationV1):GitHubReader;
}
export interface GitHubOptions {
  compiled: CompiledConfiguration;
  adapter: GitHubReader;
  buildPlan(steps: BoundStep[], observation: RuleObservation): StartPlan;
}
export class GitHubError extends Error {
  readonly code: string;
  readonly retryAfterMs: number | null;
  constructor(code: string, retryAfterMs: number | null = null) { super(code); this.code = code; this.retryAfterMs = retryAfterMs; }
}
