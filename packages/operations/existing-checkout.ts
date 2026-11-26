import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { OwnedWorkspaceCreationReceiptV1 as Receipt } from '../../contracts/generated/ssh-workspace-receipt.ts';
import { directoryIdentity } from '../target-helper/filesystem.ts';

type Identity = Pick<ReturnType<typeof directoryIdentity>, 'device' | 'inode' | 'uid'>;
export interface ExistingCheckoutPolicy {
  path: string;
  baseBranch: string;
  repository: string;
  checkout: Identity;
  gitDirectory: Identity;
}

export function existingCheckout(policy: ExistingCheckoutPolicy, runGit: (path: string, args: string[]) => string) {
  const git = (args: string[]) => runGit(policy.path, args);
  const same = (path: string, pinned: Identity) => {
    const actual = directoryIdentity(path);
    return realpathSync(path) === path && actual.device === pinned.device && actual.inode === pinned.inode && actual.uid === pinned.uid;
  };
  function verify() {
    if (!same(policy.path, policy.checkout) || !same(join(policy.path, '.git'), policy.gitDirectory) ||
        git(['rev-parse', '--show-toplevel']) !== policy.path || git(['rev-parse', '--absolute-git-dir']) !== join(policy.path, '.git')) throw Error('identity_mismatch');
    const origin = git(['remote', 'get-url', 'origin']).replace(/\.git$/, '');
    if (origin !== `https://github.com/${policy.repository}` && origin !== `git@github.com:${policy.repository}` &&
        origin !== `ssh://git@github.com/${policy.repository}`) throw Error('identity_mismatch');
    return policy.path;
  }
  function branch(receipt: Receipt, expected: string) {
    verify();
    if (receipt.source.repository !== policy.repository) throw Error('identity_mismatch');
    if (git(['symbolic-ref', '--short', 'HEAD']) !== expected) throw Error('resource_busy');
  }
  function probe(receipt: Receipt) {
    branch(receipt, policy.baseBranch);
    if (git(['status', '--porcelain=v1', '--untracked-files=all'])) throw Error('checkout_not_publishable');
  }
  function inspect(receipt: Receipt) {
    branch(receipt, receipt.branch);
    if (git(['rev-parse', 'HEAD']) !== receipt.source.sha || git(['status', '--porcelain=v1', '--untracked-files=all'])) throw Error('outcome_unknown');
    return { cwd: policy.path };
  }
  return { verify, probe, inspect,
    active(receipt: Receipt) { branch(receipt, receipt.branch); return policy.path; },
    prepare(receipt: Receipt, source: string) {
      probe(receipt);
      // The enrolled helper already fetched the pinned commit. Transfer only
      // that object through local Git, without loading any App credentials.
      git(['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', source, receipt.source.sha]);
      // A shallow source may omit parents absent from the lab repository.
      // Preserve the existing checkout unless its history can be traversed.
      git(['rev-list', '--count', receipt.source.sha]);
      git(['switch', '--no-overwrite-ignore', '--no-recurse-submodules', '-c', receipt.branch, receipt.source.sha]);
      return inspect(receipt);
    },
  };
}
