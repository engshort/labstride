import { ConfigurationStore } from './configuration.ts';
import type { ConfigurationReceipt } from './configuration.ts';
import { authorizationObservationDigest } from './policy.ts';
import { validated } from './validation.ts';
import { canonical, digest } from '../configuration/json.ts';
import { compiledSnapshot } from '../configuration/compiler.ts';
import { fieldValue } from '../configuration/values.ts';
import type { CompiledConfiguration } from '../configuration/compiler.ts';
import type { RuleObservation } from '../configuration/rules.ts';
import type { ActorEvidence, LocalPolicyAuthority } from '../core/policy.ts';
import { recoveryContext } from './execution.ts';
import type { AuditContext, RecordOf } from '../core/lifecycle.ts';
import { LifecycleError } from '../core/lifecycle.ts';
import type { GitHubCandidate, GitHubHistory, GitHubHistoryEvent, GitHubItem, GitHubItemJob, GitHubOptions, GitHubProject } from '../core/github.ts';

function projectKey(installation: string, provider: string, scope: string, config: string): string { return digest([installation,provider,scope,config]); }
function statusValue(item: GitHubItem, field: string): string | null | undefined {
  const state = item.fields[field];
  return state ? !state.present || state.value === null ? null : typeof state.value === 'string' ? state.value : undefined : undefined;
}
// History strings are not IDs. Resolve against both observed binding revisions;
// an ambiguous rename is a blocked observation, never an arbitrary choice.
function optionId(name: string | null, before: GitHubItem, current: GitHubItem, field: string): string | null | undefined {
  if (!name) return null;
  const ids = new Set([...Object.entries(before.optionNames[field] ?? {}), ...Object.entries(current.optionNames[field] ?? {})]
    .filter(([, display]) => display === name).map(([id]) => id));
  return ids.size === 1 ? [...ids][0] : undefined;
}
function orderedTransition(events: GitHubHistoryEvent[], before: GitHubItem, current: GitHubItem, field: string): GitHubHistoryEvent | null {
  if (!events.length) return null;
  if (events.length > 12) throw new LifecycleError('identity_conflict');
  const edges = events.map(event => ({ event, from: optionId(event.previousStatus,before,current,field), to: optionId(event.status,before,current,field) }));
  if (edges.some(edge => edge.from === undefined || edge.to === undefined)) throw new LifecycleError('identity_conflict');
  const start = statusValue(before,field), end = statusValue(current,field);
  let count = 0, visited=0, last: GitHubHistoryEvent | null = null;
  const visit = (value: string | null | undefined, remaining: typeof edges, tail: GitHubHistoryEvent | null): void => {
    if(++visited>4096)throw new LifecycleError('identity_conflict');
    if (count > 1) return;
    if (!remaining.length) { if (value === end) { count++; last = tail; } return; }
    for (let i=0;i<remaining.length;i++) if (remaining[i].from === value) {
      // Provider timestamps can constrain distinct seconds, but never order ties.
      if (remaining.some(other => other.event.occurredAt < remaining[i].event.occurredAt)) continue;
      visit(remaining[i].to, remaining.filter((_,index) => index !== i), remaining[i].event);
    }
  };
  visit(start,edges,null);
  if (count !== 1) throw new LifecycleError('identity_conflict');
  return last;
}

export class GitHubStore extends ConfigurationStore {
  registerGitHub(compiled: CompiledConfiguration, providerId: string, scopeId: string): GitHubProject {
    const snapshot = compiledSnapshot(compiled), installationId = snapshot.configuration.installationId;
    if (this.get('installation',installationId).configRevision !== snapshot.digest ||
      !Object.values(snapshot.bindings).some(binding => binding.providerId === providerId && binding.scopeId === scopeId && ['project_v2','organization_issue_field'].includes(binding.source)))
      throw new LifecycleError('effect_blocked');
    const key = projectKey(installationId,providerId,scopeId,snapshot.digest);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT payload FROM github_projects WHERE key=?').get(key);
      if (row) return validated<GitHubProject>('github-reconciliation',JSON.parse(String(row.payload)));
      const project: GitHubProject = { schemaVersion:'1.0',key,installationId,providerId,scopeId,configDigest:snapshot.digest,
        revision:1,cursor:null,epoch:1,nextAt:this.clock.now(),attempts:0,lastError:null };
      this.db.prepare('INSERT INTO github_projects VALUES (?,?,?)').run(key,installationId,canonical(validated('github-reconciliation',project)));
      return project;
    });
  }
  githubStatus(key: string): GitHubProject {
    const row = this.db.prepare('SELECT payload FROM github_projects WHERE key=?').get(key);
    if (!row) throw new LifecycleError('not_found');
    return validated('github-reconciliation',JSON.parse(String(row.payload)) as GitHubProject);
  }
  private saveProject(project: GitHubProject, expected: number): void {
    if (this.githubStatus(project.key).revision !== expected) throw new LifecycleError('revision_conflict');
    this.db.prepare('UPDATE github_projects SET payload=? WHERE key=?').run(canonical(validated('github-reconciliation',project)),project.key);
  }
  githubDue(key: string): boolean { return this.githubStatus(key).nextAt <= this.clock.now(); }
  commitGitHubList(project: GitHubProject, items: GitHubItem[], cursor: string | null, hasNext: boolean, intervalMs: number): void {
    if (items.length>100 || hasNext && (!cursor || cursor === project.cursor) || !Number.isSafeInteger(intervalMs) || intervalMs<15000)
      throw new LifecycleError('invalid_payload');
    const safe = items.map(item => validated('github-item',item));
    this.transaction(() => {
      if (this.get('installation',project.installationId).configRevision !== project.configDigest) throw new LifecycleError('effect_blocked');
      this.saveProject({...project,revision:project.revision+1,cursor:hasNext?cursor:null,epoch:project.epoch+(hasNext?0:1),
        nextAt:hasNext?this.clock.now():new Date(Date.parse(this.clock.now())+intervalMs).toISOString(),attempts:0,lastError:null},project.revision);
      for (const item of safe) {
        if (item.scopeId !== project.scopeId) throw new LifecycleError('identity_conflict');
        const key = digest([project.key,item.itemId]), old = this.db.prepare('SELECT * FROM github_items WHERE key=?').get(key);
        if (old && old.subject_id !== item.subjectId) throw new LifecycleError('identity_conflict');
        if (!old) this.db.prepare('INSERT INTO github_items(key,project_key,item_id,subject_id,snapshot,seen_epoch) VALUES (?,?,?,?,?,?)')
          .run(key,project.key,item.itemId,item.subjectId,canonical(item),project.epoch);
        else this.db.prepare('UPDATE github_items SET dirty=1,seen_epoch=?,removed=0,baseline=CASE WHEN removed=1 THEN 0 ELSE baseline END,revision=revision+1 WHERE key=?')
          .run(project.epoch,key);
      }
      if (!hasNext) {
        this.db.prepare('UPDATE github_items SET removed=1,baseline=0,dirty=0,revision=revision+1 WHERE project_key=? AND seen_epoch<? AND removed=0').run(project.key,project.epoch);
        this.db.prepare("UPDATE github_candidates SET state='superseded' WHERE state='pending' AND item_key IN (SELECT key FROM github_items WHERE project_key=? AND removed=1)").run(project.key);
      }
    });
  }
  githubItems(projectKey: string): GitHubItemJob[] {
    return this.db.prepare('SELECT * FROM github_items WHERE project_key=? AND dirty=1 AND removed=0 ORDER BY rowid LIMIT 16').all(projectKey)
      .map(row => ({ key:String(row.key),projectKey,itemId:String(row.item_id),subjectId:String(row.subject_id),revision:Number(row.revision),cursor:row.cursor as string|null }));
  }
  commitGitHubHistory(job: GitHubItemJob, input: GitHubHistory, itemInput: GitHubItem | null, statusField: string): void {
    const page = validated('github-history-page',input), item = itemInput && validated('github-item',itemInput);
    if (page.hasNextPage && (!page.endCursor || page.endCursor === job.cursor)) throw new LifecycleError('invalid_payload');
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM github_items WHERE key=?').get(job.key), project = this.githubStatus(job.projectKey);
      if (!row || row.revision !== job.revision) throw new LifecycleError('revision_conflict');
      if (this.get('installation',project.installationId).configRevision !== project.configDigest) throw new LifecycleError('effect_blocked');
      if (!item) {
        this.db.prepare('UPDATE github_items SET removed=1,baseline=0,dirty=0,revision=revision+1,last_error=? WHERE key=?').run('item_unavailable',job.key); return;
      }
      if (item.itemId !== job.itemId || item.subjectId !== job.subjectId || item.scopeId !== project.scopeId) throw new LifecycleError('identity_conflict');
      const binding=this.configurationSnapshot(project.configDigest).bindings[statusField];
      for (const event of page.events.filter(event => event.scopeId === project.scopeId &&
        (binding.source!=='organization_issue_field'||event.fieldId===binding.fieldId))) {
        const old = this.db.prepare('SELECT payload FROM github_history WHERE item_key=? AND event_id=?').get(job.key,event.id);
        if (old && old.payload !== canonical(event)) throw new LifecycleError('identity_conflict');
        this.db.prepare('INSERT OR IGNORE INTO github_history(item_key,event_id,payload) VALUES (?,?,?)').run(job.key,event.id,canonical(event));
      }
      if (page.hasNextPage) {
        this.db.prepare('UPDATE github_items SET cursor=?,revision=revision+1 WHERE key=?').run(page.endCursor,job.key); return;
      }
      const before = validated<GitHubItem>('github-item',JSON.parse(String(row.snapshot)));
      const events = this.db.prepare('SELECT payload FROM github_history WHERE item_key=? AND processed=0').all(job.key)
        .map(value => JSON.parse(String(value.payload)) as GitHubHistoryEvent);
      let error: string | null = null;
      if (row.baseline && !events.some(event => event.kind !== 'status')) {
        try {
          const last = orderedTransition(events.filter(event => event.kind==='status'),before,item,statusField);
          if (last) this.createGitHubCandidate(project,job,before,item,statusField,last,events);
          else if (statusValue(before,statusField) !== statusValue(item,statusField)) error='history_unavailable';
        } catch (failure) {
          if (!(failure instanceof LifecycleError) || failure.code !== 'identity_conflict') throw failure;
          error='history_ambiguous';
        }
      }
      if(!error)this.db.prepare('UPDATE github_history SET processed=1 WHERE item_key=?').run(job.key);
      // Re-read the last provider page next cycle. Event IDs, not timestamps or
      // totalCount, define deduplication; bootstrap never executes old requests.
      this.db.prepare('UPDATE github_items SET snapshot=?,baseline=1,cursor=?,overlap_cursor=?,dirty=?,revision=revision+1,last_error=? WHERE key=?')
        // Preserve blocked history and its baseline, but retry it on the next
        // enumeration rather than starving other items every worker tick.
        .run(canonical(error?before:item),job.cursor,job.cursor,0,error,job.key);
      this.log(null,'github_observation',{ itemKey:job.key,error,eventIds:events.map(event=>event.id) });
    });
  }
  private createGitHubCandidate(project: GitHubProject, job: GitHubItemJob, before: GitHubItem, item: GitHubItem,
    field: string, last: GitHubHistoryEvent, events: GitHubHistoryEvent[]): void {
    const id = digest([job.key,events.map(event=>event.id).sort()]);
    if (this.db.prepare('SELECT 1 FROM github_candidates WHERE id=?').get(id)) return;
    const key = [project.installationId,project.providerId,item.subjectId];
    const allocated = this.db.prepare('SELECT generation FROM github_generations WHERE installation_id=? AND provider_id=? AND subject_id=?').get(...key);
    const request = this.db.prepare('SELECT max(generation) AS generation FROM requests WHERE installation_id=? AND provider_id=? AND issue_id=?').get(...key);
    const generation = Math.max(Number(allocated?.generation??0),Number(request?.generation??0))+1;
    const previous = optionId(last.previousStatus,before,item,field);
    if(previous===undefined)throw new LifecycleError('identity_conflict');
    const observation: RuleObservation = validated('rule-observation',{schemaVersion:'1.0',initialSync:false,configDigest:project.configDigest,generation,
      current:item.fields,previous:{...before.fields,[field]:previous===null?{present:false}:{present:true,value:previous}},
      event:{schemaVersion:'1.0',eventId:`github:${id}`,externalId:`github:${id}`,installationId:project.installationId,provider:project.providerId,
        subjectId:item.subjectId,actorId:last.actorId??'unknown',kind:'field.changed',origin:last.actorId?'human':'provider',
        occurredAt:last.occurredAt,observedAt:this.clock.now(),sourceVersion:digest(item),facts:{scopeId:project.scopeId,itemId:item.itemId,historyEventId:last.id}}});
    const source = {repositoryId:item.repositoryId,repository:item.repository,sha:item.sourceSha};
    const evidence: ActorEvidence | null = last.actorId ? {schemaVersion:'1.0',installationId:project.installationId,providerId:project.providerId,
      externalId:observation.event.externalId,subjectId:item.subjectId,actorId:last.actorId,repositoryId:item.repositoryId,repository:item.repository,
      configDigest:project.configDigest,generation,observationDigest:authorizationObservationDigest(observation),evidenceRefs:[`github:history:${last.id}`]} : null;
    this.db.prepare("UPDATE github_candidates SET state='superseded' WHERE item_key=? AND state='pending'").run(job.key);
    this.db.prepare(`INSERT INTO github_generations VALUES (?,?,?,?) ON CONFLICT(installation_id,provider_id,subject_id) DO UPDATE SET generation=excluded.generation`).run(...key,generation);
    this.db.prepare("INSERT INTO github_candidates VALUES (?,?,?,?,?,'pending',NULL)").run(id,job.key,canonical(observation),evidence?canonical(validated('actor-evidence',evidence)):null,canonical(source));
  }
  protected override verifyRequestActor(observation: RuleObservation): ActorEvidence | null {
    if (!observation.event.externalId.startsWith('github:')) return super.verifyRequestActor(observation);
    const row = this.db.prepare('SELECT observation,evidence FROM github_candidates WHERE id=? AND state=?').get(observation.event.externalId.slice(7),'pending');
    if (!row?.evidence || authorizationObservationDigest(JSON.parse(String(row.observation))) !== authorizationObservationDigest(observation)) return null;
    return validated('actor-evidence',JSON.parse(String(row.evidence)) as ActorEvidence);
  }
  githubCandidates(projectKey: string): GitHubCandidate[] {
    return this.db.prepare("SELECT c.* FROM github_candidates c JOIN github_items i ON i.key=c.item_key WHERE i.project_key=? AND c.state='pending' ORDER BY c.rowid LIMIT 16").all(projectKey)
      .map(row=>({id:String(row.id),itemKey:String(row.item_key),observation:validated<RuleObservation>('rule-observation',JSON.parse(String(row.observation))),source:JSON.parse(String(row.source))}));
  }
  admitGitHubCandidate(candidate: GitHubCandidate, fresh: GitHubItem | null, options: GitHubOptions): ConfigurationReceipt | null {
    if (fresh) fresh=validated('github-item',fresh);
    return this.transaction(() => {
      const row=this.db.prepare('SELECT * FROM github_candidates WHERE id=?').get(candidate.id);
      if (!row) throw new LifecycleError('not_found');
      if (row.state==='admitted') return JSON.parse(String(row.receipt));
      if (row.state!=='pending') return null;
      const recorded=validated<RuleObservation>('rule-observation',JSON.parse(String(row.observation)));
      if (canonical(recorded)!==canonical(candidate.observation) || canonical(candidate.source)!==row.source) throw new LifecycleError('identity_conflict');
      const item=this.db.prepare('SELECT item_id,removed FROM github_items WHERE key=?').get(row.item_key as string)!;
      if (!fresh || item.removed || fresh.itemId!==item.item_id || fresh.subjectId!==recorded.event.subjectId ||
        fresh.scopeId!==recorded.event.facts.scopeId || canonical(fresh.fields)!==canonical(recorded.current) ||
        fresh.repositoryId!==candidate.source.repositoryId || fresh.repository!==candidate.source.repository || fresh.sourceSha!==candidate.source.sha) {
        this.db.prepare("UPDATE github_candidates SET state='superseded' WHERE id=?").run(candidate.id);
        this.log(null,'github_candidate_superseded',{candidateId:candidate.id});return null;
      }
      const receipt=this.requestConfiguredStart(options.compiled,recorded,{source:candidate.source},options.buildPlan,
        {actorId:recorded.event.actorId,reason:'Reconciled current GitHub request',evidenceRefs:[`github:candidate:${candidate.id}`]});
      this.db.prepare("UPDATE github_candidates SET state='admitted',receipt=? WHERE id=?").run(canonical(receipt),candidate.id);
      return receipt;
    });
  }
  githubRetry(key: string, code: string, minimumDelay=0): void {
    if(!Number.isSafeInteger(minimumDelay)||minimumDelay<0||minimumDelay>86400000||!code||code.length>1024)throw new LifecycleError('invalid_payload');
    this.transaction(()=>{
      const project=this.githubStatus(key),attempts=project.attempts+1;
      const delay=Math.max(minimumDelay,Math.min(3600000,1000*2**Math.min(attempts,12))*(0.5+Math.random()*0.5));
      this.saveProject({...project,revision:project.revision+1,attempts,lastError:code,nextAt:new Date(Date.parse(this.clock.now())+delay).toISOString()},project.revision);
    });
  }
  githubItemDiagnostics(projectKey: string): {itemId:string;code:string}[] {
    return this.db.prepare('SELECT item_id,last_error FROM github_items WHERE project_key=? AND last_error IS NOT NULL').all(projectKey)
      .map(row=>({itemId:String(row.item_id),code:String(row.last_error)}));
  }
  rebaselineGitHubItem(installationId:string,providerId:string,itemId:string,audit:AuditContext,authority?:LocalPolicyAuthority):void{
    this.assertOperator(authority);const context=recoveryContext(audit);
    this.transaction(()=>{
      const active=this.get('installation',installationId).configRevision;
      const rows=this.db.prepare('SELECT * FROM github_items WHERE item_id=? AND removed=0').all(itemId).filter(row=>{
        const project=this.githubStatus(String(row.project_key));
        return project.installationId===installationId&&project.providerId===providerId&&project.configDigest===active;
      });
      if(rows.length!==1)throw new LifecycleError('identity_conflict');
      const row=rows[0],project=this.githubStatus(String(row.project_key));
      // This narrow recovery command cannot re-admit an issue with any prior
      // request, even if its existing run is complete or an effect is unknown.
      if(this.db.prepare("SELECT 1 FROM requests WHERE json_extract(payload,'$.installationId')=? AND json_extract(payload,'$.providerId')=? AND json_extract(payload,'$.issueId')=?").get(installationId,providerId,row.subject_id))
        throw new LifecycleError('effect_blocked');
      this.db.prepare("UPDATE github_candidates SET state='superseded' WHERE item_key=? AND state='pending'").run(row.key);
      this.db.prepare('UPDATE github_items SET cursor=NULL,overlap_cursor=NULL,baseline=0,dirty=1,last_error=NULL,revision=revision+1 WHERE key=? AND revision=?').run(row.key,row.revision);
      this.saveProject({...project,revision:project.revision+1,nextAt:this.clock.now(),attempts:0,lastError:null},project.revision);
      this.log(null,'github_operator_rebaseline',{installationId,providerId,itemId,itemKey:row.key,previousRevision:row.revision,previousError:row.last_error,context});
    });
  }
  resetGitHubList(key:string):void{
    this.transaction(()=>{const p=this.githubStatus(key);this.saveProject({...p,cursor:null,revision:p.revision+1,lastError:'invalid_cursor',nextAt:this.clock.now()},p.revision);});
  }
  resetGitHubHistory(job:GitHubItemJob):void{
    this.transaction(()=>{
      // Lost history coverage requires a new inert baseline. Existing execution
      // and candidate identities are retained; a full scan cannot import starts.
      const changed=this.db.prepare('UPDATE github_items SET cursor=NULL,overlap_cursor=NULL,baseline=0,last_error=?,revision=revision+1 WHERE key=? AND revision=?')
        .run('invalid_cursor',job.key,job.revision);
      if(!changed.changes)throw new LifecycleError('revision_conflict');
    });
  }
  protected githubProgressValue(runId:string,mapping:ReturnType<typeof compiledSnapshot>['configuration']['projections'][number]):unknown{
    if(!mapping.valueFrom)return mapping.value;
    const run=this.get('run',runId),source=mapping.valueFrom;
    if(source.kind==='session-id'){
      const rows=this.db.prepare('SELECT id FROM sessions WHERE run_id=?').all(runId);
      const sessions=rows.map(row=>this.get('session',String(row.id))).filter(session=>{
        const binding=this.binding(session.id);
        return binding.status==='attached'&&binding.runId===runId&&binding.workspaceId===session.workspaceId&&binding.sessionId===session.sessionId;
      });
      if(sessions.length!==1)throw new LifecycleError('effect_blocked');return sessions[0].sessionId;
    }
    const rows=this.db.prepare('SELECT id FROM workspaces WHERE run_id=?').all(run.id);
    const workspaces=rows.map(row=>this.get('workspace',String(row.id))).filter(workspace=>workspace.targetId===source.targetId&&['ready','in_use','retained'].includes(workspace.state));
    if(workspaces.length!==1)throw new LifecycleError('effect_blocked');const workspace=workspaces[0];
    const results=this.db.prepare("SELECT e.payload FROM execution_results e JOIN operations o ON o.id=e.operation_id WHERE o.workspace_id=? AND json_extract(o.payload,'$.request.actionId')='labstride.workspace-create'").all(workspace.id);
    const receipts=results.map(row=>validated('execution-record',JSON.parse(String(row.payload)) as import('../../contracts/generated/execution-record.ts').ExecutionRecord))
      .filter(result=>result.kind==='result'&&result.result.status==='succeeded'&&result.result.outputs.workspace)
      .map(result=>{if(result.kind!=='result')throw new LifecycleError('invalid_payload');return validated('ssh-workspace-receipt',result.result.outputs.workspace as import('../../contracts/generated/ssh-workspace-receipt.ts').OwnedWorkspaceCreationReceiptV1);});
    if(receipts.length!==1)throw new LifecycleError('effect_blocked');const receipt=receipts[0],operation=this.get('operation',receipt.operationId);
    if(operation.state!=='succeeded'||operation.workspaceId!==workspace.id||operation.request.actionVersion!=='1.0.0'||receipt.requestDigest!==operation.request.requestDigest||canonical(receipt.source)!==canonical(operation.request.source))throw new LifecycleError('identity_conflict');
    if(receipt.workspaceId!==workspace.id||receipt.runId!==runId||receipt.targetId!==source.targetId||receipt.rootId!==source.rootId||receipt.locator!==workspace.locator||receipt.ownershipRef!==workspace.ownershipRef||
      !this.db.prepare("SELECT 1 FROM resources WHERE created_by_operation=? AND workspace_id=? AND json_extract(payload,'$.locator')=?").get(receipt.operationId,workspace.id,receipt.handle))throw new LifecycleError('identity_conflict');
    return source.rootPath+'/'+receipt.locator+'/source';
  }
  githubProjectionContext(projection:RecordOf<'projection'>):{
    configuration:ReturnType<typeof compiledSnapshot>['configuration'];logical:string;scopeId:string;itemId:string;generation:number;
  }{
    const run=this.get('run',projection.runId),request=this.get('request',run.requestId),snapshot=this.runConfiguration(run.id);
    if(!snapshot||projection.generation!==request.generation)throw new LifecycleError('effect_blocked');
    const field=Object.entries(snapshot.bindings).find(([,field])=>field.providerId===projection.providerId&&field.fieldId===projection.fieldId&&['project_v2','organization_issue_field'].includes(field.source));
    if(!field||!snapshot.configuration.projections.some(mapping=>mapping.field===field[0]&&canonical(fieldValue(snapshot.configuration.fields[mapping.field],this.githubProgressValue(run.id,mapping) as import('../configuration/values.ts').Value,true))===canonical(projection.payload.value)))throw new LifecycleError('effect_blocked');
    const project=projectKey(request.installationId,projection.providerId,field[1].scopeId,snapshot.digest);
    if(!projection.providerTarget||projection.providerTarget.scopeId!==field[1].scopeId)throw new LifecycleError('identity_conflict');
    const member=this.db.prepare('SELECT subject_id,removed FROM github_items WHERE project_key=? AND item_id=?').get(project,projection.providerTarget.resourceId);
    if(!member||member.removed||member.subject_id!==request.issueId||projection.subjectId!==request.issueId)throw new LifecycleError('identity_conflict');
    const generation=Number(this.db.prepare('SELECT max(generation) AS generation FROM requests WHERE installation_id=? AND provider_id=? AND issue_id=?')
      .get(request.installationId,request.providerId,request.issueId)!.generation);
    return{configuration:snapshot.configuration,logical:field[0],scopeId:field[1].scopeId,itemId:projection.providerTarget.resourceId,generation};
  }
  protected serializeGitHubProgress(_runId:string):boolean{return false;}
  pendingProgressWrite(runId:string):boolean{
    return !!this.db.prepare("SELECT 1 FROM projections p JOIN deliveries d ON d.projection_id=p.id WHERE p.run_id=? AND d.state IN ('pending','reconcile') LIMIT 1").get(runId);
  }
  enqueueGitHubProgress(runId:string,fact:string,item:GitHubItem,occurrence?:string):string[]{
    item=validated('github-item',item);
    if(occurrence!==undefined&&!/^[a-z0-9_.:-]{1,128}$/.test(occurrence))throw new LifecycleError('invalid_payload');
    return this.transaction(()=>{
      const run=this.get('run',runId),request=this.get('request',run.requestId),snapshot=this.runConfiguration(runId);
      if(!snapshot||request.issueId!==item.subjectId||run.repositoryId!==item.repositoryId)throw new LifecycleError('identity_conflict');
      const ids:string[]=[];
      for(const mapping of snapshot.configuration.projections.filter(mapping=>mapping.fact===fact)){
        const binding=snapshot.bindings[mapping.field],state=item.fields[mapping.field];
        if(!binding||!['project_v2','organization_issue_field'].includes(binding.source)||binding.scopeId!==item.scopeId||!state)throw new LifecycleError('effect_blocked');
        const identity=[runId,fact,binding.fieldId,mapping.valueFrom??mapping.value];
        if(occurrence!==undefined)identity.push(occurrence);
        const id=`github-progress:${digest(identity)}`;
        if(this.db.prepare('SELECT 1 FROM projections WHERE id=?').get(id)){ids.push(id);continue;}
        // The installed native-field profile reads a fresh issue between its
        // own writes, including different outputs of the same fact.
        if(this.serializeGitHubProgress(runId)&&this.pendingProgressWrite(runId))return ids;
        const record:RecordOf<'projection'>={schemaVersion:'1.0',kind:'projection',id,revision:1,createdAt:this.clock.now(),updatedAt:this.clock.now(),
          runId,providerId:binding.providerId,subjectId:item.subjectId,fieldId:binding.fieldId,generation:request.generation,
          providerTarget:{schemaVersion:'1.0',scopeId:item.scopeId,resourceId:item.itemId},
          payload:{schemaVersion:'1.0',expectedFingerprint:githubFingerprint(item,mapping.field),value:fieldValue(snapshot.configuration.fields[mapping.field],this.githubProgressValue(run.id,mapping) as import('../configuration/values.ts').Value,true)}};
        this.githubProjectionContext(record);
        const context:AuditContext={actorId:'coordinator',reason:'Mapped operational progress',evidenceRefs:[`run:${runId}`,`fact:${fact}`]};
        this.write([{record,expectedRevision:null}],context);this.enqueue('projection',id);ids.push(id);
      }
      return ids;
    });
  }
  pendingGitHubProgress(key:string):{runId:string;itemId:string;fact:string}[]{
    const project=this.githubStatus(key),result:{runId:string;itemId:string;fact:string}[]=[];
    const rows=this.db.prepare(`SELECT r.id,i.item_id FROM runs r JOIN requests q ON q.id=r.request_id JOIN github_items i ON i.subject_id=q.issue_id
      WHERE i.project_key=? AND i.removed=0 AND q.installation_id=? AND q.provider_id=? ORDER BY r.rowid DESC LIMIT 64`).all(key,project.installationId,project.providerId);
    for(const row of rows){
      const run=this.get('run',String(row.id)),snapshot=this.runConfiguration(run.id);
      if(!snapshot||snapshot.digest!==project.configDigest)continue;
      const facts=new Set([`run.${run.state}`]);
      for(const workspace of this.db.prepare('SELECT id FROM workspaces WHERE run_id=?').all(run.id))facts.add(`workspace.${this.get('workspace',String(workspace.id)).state}`);
      for(const session of this.db.prepare('SELECT id FROM sessions WHERE run_id=?').all(run.id))facts.add(`session.${this.get('session',String(session.id)).state}`);
      for(const mapping of snapshot.configuration.projections)if(facts.has(mapping.fact)){
        const id=`github-progress:${digest([run.id,mapping.fact,snapshot.bindings[mapping.field].fieldId,mapping.valueFrom??mapping.value])}`;
        if(!this.db.prepare('SELECT 1 FROM projections WHERE id=?').get(id))result.push({runId:run.id,itemId:String(row.item_id),fact:mapping.fact});
      }
    }
    return result.slice(0,16);
  }
  githubProgressProjects(providerId:string):GitHubProject[]{
    return this.db.prepare(`SELECT DISTINCT p.payload FROM github_projects p JOIN runs r ON r.config_digest=json_extract(p.payload,'$.configDigest')
      WHERE json_extract(p.payload,'$.providerId')=? ORDER BY p.rowid DESC`).all(providerId)
      .map(row=>validated<GitHubProject>('github-reconciliation',JSON.parse(String(row.payload))));
  }
  receiveGitHubWebhook(installationId: string, deliveryId: string, hash: string): {schemaVersion:'1.0';deliveryId:string;durable:true} {
    if (!/^[A-Za-z0-9-]{1,128}$/.test(deliveryId)||!/^[a-f0-9]{64}$/.test(hash)) throw new LifecycleError('invalid_payload');
    return this.transaction(()=>{
      this.get('installation',installationId);
      const old=this.db.prepare('SELECT digest,receipt FROM github_webhooks WHERE installation_id=? AND delivery_id=?').get(installationId,deliveryId);
      if(old){if(old.digest!==hash)throw new LifecycleError('identity_conflict');return JSON.parse(String(old.receipt));}
      const receipt={schemaVersion:'1.0' as const,deliveryId,durable:true as const};
      this.db.prepare('INSERT INTO github_webhooks VALUES (?,?,?,?)').run(installationId,deliveryId,hash,canonical(receipt));
      for(const row of this.db.prepare('SELECT key FROM github_projects WHERE installation_id=?').all(installationId)){
        const project=this.githubStatus(String(row.key));
        this.saveProject({...project,revision:project.revision+1,nextAt:this.clock.now()},project.revision);
      }
      return receipt;
    });
  }
}
export function githubFingerprint(item:GitHubItem,field:string):string{
  return digest([item.scopeId,item.itemId,field,item.updatedAt,item.fields[field]]);
}
