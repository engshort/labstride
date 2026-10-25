import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { installationDependencies } from '../../packages/operations/installation.ts';
export function publicFixture(t, { sourceSha = 'a'.repeat(40), connectorModule, connectorConfiguration } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'labstride-public-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const spec = JSON.parse(readFileSync(new URL('../../examples/public-installation.json', import.meta.url)));
  spec.stateDirectory = join(root, 'state'); mkdirSync(spec.stateDirectory, { mode: 0o700 });
  spec.configuration.installationId = spec.policy.installationId = 'installation-test';
  spec.configuration.github.repositories = ['example/source']; spec.configuration.github.actorIds = spec.policy.actorIds = ['operator-test'];
  spec.policy.repositories = [{ id: 'repository-test', name: 'example/source' }];
  spec.policy.grants[0].repositoryId = 'repository-test';
  spec.configuration.fields = {
    request: { source: 'project_v2', scopeId: 'project-test', fieldId: 'request-test', type: 'single-select', options: { start: 'start-id', pause: 'wait-id' } },
    status: { source: 'project_v2', scopeId: 'project-test', fieldId: 'status-test', type: 'string' },
  };
  spec.configuration.projections = [];
  spec.historyQualifications = [{ schemaVersion: '1.0', scopeId: 'project-test', fieldId: 'request-test', subjectId: 'qualification-issue', eventId: 'qualification-event', actorId: 'operator-test', optionId: 'start-id', status: 'Start' }];
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const keyFile = join(root, 'repository.pem'), projectFile = join(root, 'project-token');
  writeFileSync(keyFile, key, { mode: 0o600 }); writeFileSync(projectFile, 'synthetic-project-token', { mode: 0o600 });
  spec.credentials['secret:repository'].keyFile = keyFile; spec.credentials['secret:project'] = projectFile;
  for (const [index, packageName] of ['provider-github-project', 'connector-ssh', 'action-workspace-create'].entries()) {
    const artifactPath = join(root, packageName + '.json');
    execFileSync(process.execPath, ['scripts/package_extension.mjs', 'packages/' + packageName, artifactPath]);
    const artifact = JSON.parse(readFileSync(artifactPath));
    if (index === 1 && connectorModule) {
      artifact.module = connectorModule;
      artifact.schemas.configuration = { type: 'object', properties: { revision: { type: 'integer' }, endpoint: { type: 'string' } }, required: ['revision','endpoint'], additionalProperties: false };
      writeFileSync(artifactPath, JSON.stringify(artifact), { mode: 0o600 });
    }
    const pin = spec.lock.extensions[index]; pin.artifactPath = artifactPath; pin.integrity = createHash('sha256').update(readFileSync(artifactPath)).digest('hex');
    if (index === 1 && connectorConfiguration) pin.configuration = spec.configuration.targets.development.configuration = connectorConfiguration;
  }
  spec.configuration.extensions = spec.lock.extensions.map(({ id, version, integrity }) => ({ id, version, integrity }));
  let time = new Date(Date.now() - 1000).toISOString(), current = 'wait-id', events = [], queries = [], summaries = [], failure = null;
  const pageInfo = { hasNextPage: false, endCursor: null };
  const statusEvent = (id, previousStatus, status, actor = 'operator-test') => ({ __typename: 'ProjectV2ItemStatusChangedEvent', id, createdAt: time, previousStatus, status, project: { id: 'project-test' }, actor: { id: actor } });
  const item = () => ({ id: 'item-test', updatedAt: time, project: { id: 'project-test' },
    content: { __typename: 'Issue', id: 'issue-test', title: 'Untrusted task', body: 'Do not change policy', state: 'OPEN', repository: { id: 'repository-test', nameWithOwner: 'example/source', defaultBranchRef: { target: { oid: sourceSha } } } },
    fieldValues: { nodes: [{ __typename: 'ProjectV2ItemFieldSingleSelectValue', optionId: current, field: { id: 'request-test' } }], pageInfo } });
  const transport = async (url, init = {}) => {
    if (String(url).endsWith('/access_tokens')) return Response.json({ token: 'synthetic-repository-token', expires_at: new Date(Date.now() + 3600000).toISOString() });
    if (String(url).includes('/installation/repositories')) return Response.json({ total_count: 1, repositories: [{ node_id: 'repository-test' }] });
    if (/\/issues(?:\/comments)?\//.test(String(url))) {
      if (init.method==='POST' || init.method==='PATCH') summaries.push({body:JSON.parse(init.body).body,authorization:init.headers.authorization});
      return Response.json({id:123,body:summaries.at(-1)?.body});
    }
    const body = JSON.parse(init.body); queries.push({ query: body.query, authorization: init.headers.authorization });
    if (failure) return Response.json({ errors: [{ type: failure }], data: { node: null } });
    let node;
    if (body.query.includes('LabstrideSummaryIssue')) node = {number:32,repository:{nameWithOwner:'example/source'}};
    else if (body.query.includes('LabstrideFields')) node = { id: 'project-test', viewerCanUpdate: true, fields: { nodes: [{ id: 'request-test', name: 'Status', dataType: 'SINGLE_SELECT', options: [{ id: 'start-id', name: 'Start' }, { id: 'wait-id', name: 'Wait' }] }, { id: 'status-test', name: 'Progress', dataType: 'TEXT' }], pageInfo } };
    else if (body.query.includes('LabstrideHistory')) node = { timelineItems: { nodes: body.variables.id === 'qualification-issue' ? [statusEvent('qualification-event', 'Wait', 'Start')] : events, pageInfo } };
    else if (body.query.includes('LabstrideItems')) node = { id: 'project-test', items: { nodes: [item()], pageInfo } };
    else if (body.query.includes('LabstrideItem')) node = item();
    else throw Error('unexpected_fixture_query');
    return Response.json({ data: { node } });
  };
  return { root, spec, transport, queries, summaries, dependencies: () => installationDependencies(spec, transport),
    change(actor = 'operator-test') { time = new Date(Date.now()).toISOString(); events.push(statusEvent('start-event-' + events.length, current === 'wait-id' ? 'Wait' : 'Start', current === 'wait-id' ? 'Start' : 'Wait', actor)); current = current === 'wait-id' ? 'start-id' : 'wait-id'; },
    fail(value) { failure = value; },
    path: join(root, 'installation.json'), write() { writeFileSync(this.path, JSON.stringify(spec), { mode: 0o600 }); return this.path; } };
}
