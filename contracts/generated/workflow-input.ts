/* Generated from schemas/*.schema.json. Run npm run generate:types; do not edit. */

export interface WorkflowActionInputV1 {
  target: string;
  enrollment: string;
  source: Source;
}
export interface Source {
  repositoryId: string;
  repository: string;
  sha: string;
  issue?: GithubIssue;
}
export interface GithubIssue {
  number: number;
  title: string;
}
