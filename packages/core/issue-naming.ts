import type { GitHubItemSnapshot } from '../../contracts/generated/github-item.ts';

type GitHubIssue = NonNullable<GitHubItemSnapshot['issue']>;
const unsafeDisplay = /[\u0000-\u001f\u007f-\u009f\p{Bidi_Control}\p{Surrogate}]/gu;

export function issueMetadata(number: unknown, title: unknown): GitHubIssue | undefined {
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || number > 2147483647 ||
    typeof title !== 'string' || !title.length || title.length > 4096) return;
  return { number, title };
}

function displayText(title: string): string {
  return title.normalize('NFC').replace(unsafeDisplay, ' ').replace(/\s+/gu, ' ').trim();
}

export function issueThreadName(repository: string, issue: GitHubIssue): string {
  const prefix = '#'+issue.number+' • ';
  const repo = displayText(repository.split('/').at(-1) ?? repository);
  const suffix = ' • '+Array.from(repo).slice(0, 100).join('');
  const title = Array.from(displayText(issue.title) || 'Issue');
  return prefix+title.slice(0, 200-Array.from(prefix+suffix).length).join('').trimEnd()+suffix;
}

export function issueBranchName(locator: string, issue: GitHubIssue): string {
  const slug = displayText(issue.title).normalize('NFKD').replace(/\p{Mark}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-/, '').slice(0, 48).replace(/-$/, '') || 'issue';
  return 'labstride/'+issue.number+'-'+slug+'-'+locator.slice(3,15);
}
