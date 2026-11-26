/* Generated from schemas/*.schema.json. Run npm run generate:types; do not edit. */

export interface GitHubItemSnapshot {
  schemaVersion: "1.0";
  scopeId: string;
  itemId: string;
  subjectId: string;
  repositoryId: string;
  repository: string;
  sourceSha: string;
  updatedAt: string;
  fields: {
    [k: string]:
      | {
          present: false;
        }
      | {
          present: true;
          value: string | number | boolean | null | string[];
        };
  };
  optionNames: {
    [k: string]: {
      [k: string]: string;
    };
  };
  issue?: GithubIssue;
}
export interface GithubIssue {
  number: number;
  title: string;
}
