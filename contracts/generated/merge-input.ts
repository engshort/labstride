/* Generated from schemas/*.schema.json. Run npm run generate:types; do not edit. */

export interface GitHubMergeActionInputV1 {
  schemaVersion: "1.0";
  enrollment: string;
  target: string;
  source: Source;
  pullRequest: number;
  expectedHead: string;
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
