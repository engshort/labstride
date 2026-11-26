import test from 'node:test';
import assert from 'node:assert/strict';
import {GitHubClient} from '../packages/provider-github/client.ts';
import {GitHubIssueFieldsAdapter} from '../packages/provider-github/issue-fields.ts';
import {githubFixture,localAuthority} from './helpers/github-fixture.mjs';
import {startCoordinator} from '../apps/coordinator/main.ts';
import {createGitHubWorker} from '../packages/core/github-worker.ts';
const page={hasNextPage:false,endCursor:null};
const selection={__typename:'IssueFieldSingleSelect',id:'request-a',name:'Request',dataType:'SINGLE_SELECT',options:[{id:'go-a',name:'Start'},{id:'wait-a',name:'Waiting'}]};
const text={__typename:'IssueFieldText',id:'path-a',name:'Checkout',dataType:'TEXT'};
const event={__typename:'IssueFieldChangedEvent',id:'qualification',createdAt:'2026-10-23T12:00:00.000Z',previousValue:null,newValue:null,previousOptions:[{name:'Waiting'}],newOptions:[{name:'Start'}],issueField:selection,actor:{id:'operator-test'}};
const config={github:{repositories:['owner/repo'],credentialRef:'secret:repository',projectCredentialRef:'secret:project'},fields:{request:{source:'organization_issue_field',scopeId:'repo-a',fieldId:'request-a',type:'single-select',options:{go:'go-a',wait:'wait-a'}},path:{source:'organization_issue_field',scopeId:'repo-a',fieldId:'path-a',type:'string'}}};
const qualification={schemaVersion:'1.0',scopeId:'repo-a',fieldId:'request-a',subjectId:'issue-a',eventId:'qualification',actorId:'operator-test',optionId:'go-a',status:'Start'};
function provider(){
 const state={permission:'WRITE',canSet:true,owner:'Organization',events:[event],requests:[],values:[{__typename:'IssueFieldSingleSelectValue',field:{id:'request-a'},optionId:'go-a',value:'Start'},{__typename:'IssueFieldTextValue',field:{id:'path-a'},value:'context.source'}]};
 const issue=()=>({__typename:'Issue',id:'issue-a',number:123,updatedAt:event.createdAt,title:'Owned',body:'',state:'OPEN',viewerCanSetFields:state.canSet,repository:{id:'repo-a',nameWithOwner:'owner/repo',defaultBranchRef:{target:{oid:'a'.repeat(40)}}},issueFieldValues:{nodes:state.values,pageInfo:page}});
 const client=new GitHubClient({credential:async ref=>{assert.equal(ref,'secret:repository');return 'opaque';},requestsPerTick:100,fetch:async(_url,init)=>{
  const body=JSON.parse(init.body);state.requests.push(body);let data;
  if(body.query.includes('LabstrideIssueFieldOwner'))data={node:{id:'repo-a',nameWithOwner:'owner/repo',viewerPermission:state.permission,owner:{__typename:state.owner,id:'org-a'}}};
  else if(body.query.includes('LabstrideIssueFieldDefinitions'))data={node:{id:'org-a',issueFields:{nodes:[selection,text],pageInfo:page}}};
  else if(body.query.includes('LabstrideNativeHistory'))data={node:{repository:{id:'repo-a',nameWithOwner:'owner/repo'},timelineItems:{nodes:state.events,pageInfo:page}}};
  else if(body.query.includes('LabstrideNativeIssues'))data={node:{id:'repo-a',issues:{nodes:[issue()],pageInfo:page}}};
  else if(body.query.includes('LabstrideNativeIssue')||body.query.includes('LabstrideNativeWritePreflight')||body.query.includes('LabstrideNativeWriteCapability'))data={node:issue()};
  else if(body.query.includes('LabstrideNativeProjection'))data={setIssueFieldValue:{clientMutationId:body.variables.input.clientMutationId}};
  else throw Error('Unexpected query');return Response.json({data});
 }});
 const adapter=new GitHubIssueFieldsAdapter({providerId:'test.provider',configuration:config,client,historyQualifications:[qualification]});return {state,adapter};
}
test('native issue bindings qualify field-specific actor history without Project membership',async()=>{
 const {state,adapter}=provider();const description=await adapter.describeField(config.fields.request,'secret:repository');assert.equal(description.history,true);assert.equal(description.writable,true);
 const snapshot=await adapter.item('issue-a');assert.equal(snapshot.scopeId,'repo-a');assert.equal(snapshot.itemId,snapshot.subjectId);assert.deepEqual(snapshot.issue,{number:123,title:'Owned'});assert.deepEqual(snapshot.fields.path,{present:true,value:'context.source'});
 assert.equal((await adapter.list('repo-a',null)).items.length,1);assert.equal((await adapter.history('issue-a',null)).events[0].fieldId,'request-a');
 state.events=[{...event,issueField:{...selection,id:'another-field'}}];adapter.beginTick();await assert.rejects(adapter.describeField(config.fields.request,'secret:repository'),error=>error.code==='history_unavailable');
});
test('native writes use one stable field, repository credential and final issue permission check',async()=>{
 const {state,adapter}=provider();await adapter.setField('repo-a','issue-a','path-a','string','/owned/source','attempt-a');
 const write=state.requests.find(request=>request.query.includes('LabstrideNativeProjection'));assert.deepEqual(write.variables.input,{issueId:'issue-a',clientMutationId:'attempt-a',issueFields:[{fieldId:'path-a',textValue:'/owned/source'}]});
 state.canSet=false;await assert.rejects(adapter.setField('repo-a','issue-a','path-a','string','/other','attempt-b'),error=>error.code==='unsupported_binding');assert.equal(state.requests.filter(request=>request.query.includes('LabstrideNativeProjection')).length,1);
 await assert.rejects(adapter.setField('repo-a','issue-a','request-a','single-select','foreign-option','attempt-c'));state.permission='READ';adapter.beginTick();assert.equal((await adapter.describeField(config.fields.path,'secret:repository')).writable,false);
});
test('installation credentials use independently observed field capability when the human repository role is null',async()=>{
 const {state,adapter}=provider();state.permission=null;
 assert.equal((await adapter.describeField(config.fields.path,'secret:repository')).writable,true);
 state.canSet=false;adapter.beginTick();
 assert.equal((await adapter.describeField(config.fields.path,'secret:repository')).writable,false);
 await assert.rejects(adapter.setField('repo-a','issue-a','path-a','string','/owned/source','attempt-denied'),error=>error.code==='unsupported_binding');
 assert.equal(state.requests.some(request=>request.query.includes('mutation LabstrideNativeProjection')),false);
});
test('foreign repository owners, unknown values and unqualified actors cannot supply native authority',async()=>{
 const {state,adapter}=provider();state.owner='User';await assert.rejects(adapter.item('issue-a'),error=>error.code==='binding_invalid');state.owner='Organization';
 state.values[0].optionId='foreign';await assert.rejects(adapter.item('issue-a'),error=>error.code==='binding_invalid');state.values[0].optionId='go-a';
 state.events=[{...event,actor:null}];await assert.rejects(adapter.describeField(config.fields.request,'secret:repository'),error=>error.code==='history_unavailable');
});
test('native reconciliation ignores another field history, admits one current transition and retains it after restart',async t=>{
 const f=await githubFixture(t,{native:true});await f.worker.tick();assert.equal(f.store.snapshot().records.filter(row=>row.kind==='run').length,0);
 f.advance();f.events.push({id:'other-field-event',kind:'status',scopeId:'scope-a',fieldId:'another-field',actorId:'operator-test',occurredAt:f.now(),previousStatus:'Unrelated',status:'Other'});f.change();
 await Promise.all([f.worker.tick(),createGitHubWorker(f.store,f.options).tick()]);assert.equal(f.store.snapshot().records.filter(row=>row.kind==='run').length,1);
 const reboot=startCoordinator(f.root,{policyAuthority:localAuthority,clock:{now:f.now}});t.after(()=>reboot.store.close());f.advance();await createGitHubWorker(reboot.store,f.options).tick();assert.equal(reboot.store.snapshot().records.filter(row=>row.kind==='run').length,1);
});

test('a six-field profile keeps runtime choices mapped and registered resource outputs separate from issue input',async()=>{
 const {readFileSync}=await import('node:fs');const {issueFieldConfiguration,issueFieldSessionInputs}=await import('../packages/provider-github/issue-field-profile.ts');
 const profile=JSON.parse(readFileSync(new URL('../examples/github-issue-field-profile.json',import.meta.url)));
 const fragment=issueFieldConfiguration(profile);assert.equal(fragment.fields.request.allowManagedProgress,true);assert.equal(fragment.rules[0].condition.value,'approved');assert.equal(fragment.projections.find(p=>p.field==='path').valueFrom.kind,'workspace-source-path');
 assert.deepEqual(issueFieldSessionInputs(profile).model.mapping,{'model-selected':'example-model'});profile.fields.path.fieldId=profile.fields.session.fieldId;assert.throws(()=>issueFieldConfiguration(profile),error=>error.code==='binding_invalid');
});

test('path projection requires the committed checkout receipt/resource and never trusts the issue Path value',async t=>{
 const {workspaceFixture}=await import('./helpers/workspace-fixture.mjs');const {WorkspaceRegistry}=await import('../packages/target-helper/workspaces.ts');
 const {prepareWorkspaceStart}=await import('../packages/connector-ssh/workspaces.ts');const {planFor}=await import('./helpers/configuration-fixture.mjs');
 const {requestDigest}=await import('../packages/storage-sqlite/execution.ts');const {loadExtension,freezeProfile}=await import('../packages/extensions/loader.ts');
 const {createWorker,actionKey}=await import('../packages/core/worker.ts');const {execFileSync}=await import('node:child_process');const {readFileSync}=await import('node:fs');const {join}=await import('node:path');const {createHash}=await import('node:crypto');
 const source=workspaceFixture(t);source.policy.installationId='installation-a';source.policy.targetId='target-a';
 const registry=new WorkspaceRegistry(source.policy,source.dependencies);t.after(()=>registry.close());let actionPin;
 const f=await githubFixture(t,{native:true,configure(f){
   f.source=source.operation.source;f.config.github.repositories=[f.source.repository];
   f.config.fields.note={source:'organization_issue_field',scopeId:'scope-a',fieldId:'path-a',type:'string'};
   f.descriptors['path-a']={...f.descriptors['note-a'],source:'organization_issue_field',scopeId:'scope-a',fieldId:'path-a',history:false,actorAttribution:false,operators:['equals','notEquals','exists']};
   f.config.projections=[{fact:'workspace.ready',field:'note',valueFrom:{kind:'workspace-source-path',targetId:'target-a',rootId:'source',rootPath:source.policy.roots[0].path}}];
   const artifactPath=join(f.root,'workspace-action.json');execFileSync(process.execPath,['scripts/package_extension.mjs','packages/action-workspace-create',artifactPath]);
   actionPin={id:'labstride.workspace-create',version:'1.0.0',kind:'action',artifactPath,integrity:createHash('sha256').update(readFileSync(artifactPath)).digest('hex'),permissions:['filesystem.workspace'],capabilities:['workspace.create.v1'],configuration:{}};
   f.dependencies.lock.extensions=f.dependencies.lock.extensions.filter(pin=>pin.kind!=='action');f.dependencies.lock.extensions.push(actionPin);
   f.config.workflows.prepare=[{id:'checkout',action:actionPin.id,inputs:{target:'target-a',rootId:'source',source:'context.source'}}];
 },buildPlan(f,compiled){return(steps,observation)=>{const plan=planFor(f,compiled)(steps,observation);plan.run.repositoryId=f.source.repositoryId;plan.operation.request.source=f.source;plan.operation.request.requestDigest=requestDigest(plan.operation.request);return prepareWorkspaceStart(plan,'installation-a');};}});
 await f.worker.tick();f.advance();f.change();await f.worker.tick();const run=f.store.snapshot().records.find(row=>row.kind==='run');
 f.item.fields.note={present:true,value:'/foreign/issue-path'};assert.throws(()=>f.store.enqueueGitHubProgress(run.id,'workspace.ready',f.item),error=>error.code==='effect_blocked');
 const profile=freezeProfile(run.id,f.compiled.snapshot.digest,actionPin,f.dependencies.host);
 const loaded=await loadExtension(profile,f.dependencies.host,{target:{async binding(){return{installationId:'installation-a',revision:1};},async validate(){},async invoke(request){return registry.handle(request);}}});
 const worker=createWorker(f.store,{executorId:'native-output-test',nextAttempt:()=> 'attempt-native',adapters:new Map([[actionKey(actionPin.id,actionPin.version),loaded.instance]])});await worker.tick();await worker.drain();
 assert.equal(f.store.get('run',run.id).state,'ready');const ids=f.store.enqueueGitHubProgress(run.id,'workspace.ready',f.item);assert.equal(ids.length,1);
 const projection=f.store.get('projection',ids[0]);const workspace=f.store.snapshot().records.find(row=>row.kind==='workspace');assert.equal(projection.payload.value,join(source.policy.roots[0].path,workspace.locator,'source'));assert.notEqual(projection.payload.value,f.item.fields.note.value);
 assert.deepEqual(f.store.enqueueGitHubProgress(run.id,'workspace.ready',f.item),ids);
});
