/* Generated from schemas/*.schema.json. Run npm run generate:types; do not edit. */

export interface WorkspaceCreateInputsV1 {
  target: string;
  rootId: string;
  source: {
    repositoryId: string;
    repository: string;
    sha: string;
    issue?: GithubIssue;
  };
}
export interface GithubIssue {
  number: number;
  title: string;
}
