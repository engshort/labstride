import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceFixture } from './helpers/workspace-fixture.mjs';
import { WorkspaceRegistry } from '../packages/target-helper/workspaces.ts';
import { runGit } from '../packages/target-helper/workspace-git.ts';
import { preparePublication } from '../packages/operations/publication.ts';

async function fixture(t, { signed = true, workflow = false, unrelated = false, empty = false } = {}) {
  const f = workspaceFixture(t, undefined, { priorHistory: true });
  const registry = new WorkspaceRegistry(f.policy, f.dependencies); t.after(() => registry.close());
  const response = await registry.handle(f.request); assert.equal(response.outcome, 'ok');
  const cwd = f.sourcePath(response.workspace), git = args => runGit(cwd, args);
  assert.equal(git(['rev-parse', '--is-shallow-repository']), 'true');
  if (!empty) {
    if (unrelated) git(['checkout', '--orphan', 'unrelated']);
    if (workflow) { mkdirSync(join(cwd, '.github/workflows'), { recursive: true }); writeFileSync(join(cwd, '.github/workflows/task.yml'), 'name: untrusted change\n'); }
    else writeFileSync(join(cwd, 'result.txt'), 'implemented\n');
    git(['add', '.']); git(['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', ...(signed ? ['--signoff'] : []), '-m', 'Implement task']);
  }
  const file = join(f.root, 'result.bundle'); git(['bundle', 'create', file, 'HEAD']);
  const identity = { sha: git(['rev-parse', 'HEAD']), baseSha: f.operation.source.sha, branch: response.workspace.branch };
  return { ...f, cwd, identity, bundle: { ...identity, bundle: readFileSync(file).toString('base64') } };
}

test('a real depth-one source with pre-baseline history imports at the exact registered base boundary', async t => {
  const f = await fixture(t), prepared = preparePublication(f.bundle, f.identity); t.after(() => prepared.close());
  assert.equal(runGit(prepared.bare, ['rev-parse', 'FETCH_HEAD']), f.identity.sha);
  assert.equal(readFileSync(join(prepared.bare, 'shallow'), 'utf8'), f.identity.baseSha + '\n');
  runGit(prepared.bare, ['merge-base', '--is-ancestor', f.identity.baseSha, f.identity.sha]);
  assert.equal(runGit(prepared.bare, ['diff', '--name-only', f.identity.baseSha, f.identity.sha]), 'result.txt');
  prepared.close(); assert.equal(existsSync(prepared.bare), false);
});

for (const [name, options, code] of [
  ['unsigned commit', { signed: false }, /dco_missing/],
  ['CI workflow edit', { workflow: true }, /ci_definition_changed/],
  ['unrelated commit graph', { unrelated: true }, /publication_ancestry_failed/],
  ['unchanged head', { empty: true }, /empty_result/],
]) test(`publication rejects ${name} before credentials or remote effects`, async t => {
  const f = await fixture(t, options);
  assert.throws(() => preparePublication(f.bundle, f.identity), code);
});

test('bundle head, branch and source metadata cannot replace the registered publication identity', async t => {
  const f = await fixture(t);
  for (const change of [{ sha: 'b'.repeat(40) }, { baseSha: 'b'.repeat(40) }, { branch: 'another-branch' }]) {
    assert.throws(() => preparePublication({ ...f.bundle, ...change }, f.identity), /identity_mismatch/);
  }
  assert.throws(() => preparePublication(f.bundle, { ...f.identity, baseSha: f.identity.baseSha + '\n' }), /identity_mismatch/);
});

test('a follow-up must contain the previously published head', async t => {
  const f = await fixture(t);
  const published = { headSha: 'b'.repeat(40), baseSha: f.identity.baseSha };
  assert.throws(() => preparePublication(f.bundle, f.identity, runGit, published), /publication_published_ancestry_failed/);
});

test('a follow-up can keep the previously verified workflows when main has moved again', async t => {
  const f = await fixture(t);
  const prepared = preparePublication(f.bundle, f.identity, runGit, { headSha: f.identity.baseSha, baseSha: 'b'.repeat(40) });
  t.after(() => prepared.close());
  assert.equal(runGit(prepared.bare, ['rev-parse', 'FETCH_HEAD']), f.identity.sha);
});

for (const baseSha of ['observed', 'advanced']) test(`a follow-up cannot change workflows beyond the ${baseSha} baseline`, async t => {
  const f = await fixture(t, { workflow: true });
  const published = { headSha: f.identity.baseSha, baseSha: baseSha === 'observed' ? f.identity.baseSha : 'b'.repeat(40) };
  assert.throws(() => preparePublication(f.bundle, f.identity, runGit, published), /ci_definition_changed/);
});
