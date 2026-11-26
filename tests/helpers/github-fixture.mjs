import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startCoordinator} from '../../apps/coordinator/main.ts';
import {createGitHubWorker} from '../../packages/core/github-worker.ts';
import {configurationFixture,localAuthority,publishFixturePolicy,planFor,context} from './configuration-fixture.mjs';
export {context,localAuthority,planFor};

export async function githubFixture(t,{progress=false,native=false,configure=()=>{},buildPlan}={}){
  const root=mkdtempSync(join(tmpdir(),'labstride-github-')),f=configurationFixture(root);
  let now='2026-10-23T12:00:00.000Z';
  f.config.projections=Array.isArray(progress)?progress:progress?[{fact:'run.queued',field:f.names.status,value:'busy'}]:[];
  for(const [id,binding] of Object.entries(f.descriptors))if(id!=='request-a'){binding.history=false;binding.actorAttribution=false;binding.operators=binding.operators.filter(operator=>operator!=='changedTo');}
  if(native)for(const name of ['request','status']){
    const field=f.config.fields[name],descriptor=f.descriptors[field.fieldId];
    field.source=descriptor.source='organization_issue_field';descriptor.credentialRef='secret:repository';
  }
  configure(f);
  const compilation=await f.compile();if(!compilation.ok)throw Error(JSON.stringify(compilation));
  const compiled=compilation.configuration;
  const {store}=startCoordinator(root,{policyAuthority:localAuthority,clock:{now:()=>now}});
  store.activateConfiguration(compiled,null,context,localAuthority);publishFixturePolicy(store,f,compiled);
  let closed=false;
  const close=()=>{if(!closed){store.close();closed=true;}};
  t.after(()=>{close();rmSync(root,{recursive:true,force:true});});
  const item={schemaVersion:'1.0',scopeId:'scope-a',itemId:'item-test',subjectId:'issue-test',repositoryId:f.source.repositoryId,repository:f.source.repository,sourceSha:f.source.sha,
    updatedAt:now,fields:{request:{present:true,value:'wait-a'},status:{present:false},note:{present:true,value:'literal'},keep:{present:true,value:false}},
    optionNames:{request:{'go-a':'Start','wait-a':'Waiting'},status:{'busy-a':'Busy'}}};
  const events=native?[]:[{id:'membership-1',kind:'added',scopeId:'scope-a',actorId:context.actorId,occurredAt:now,previousStatus:null,status:null}];
  let present=true,calls=0;
  const adapter={providerId:'test.provider',beginTick(){},async list(){calls++;return{items:present?[structuredClone(item)]:[],hasNextPage:false,endCursor:'list-cursor'};},
    async item(){calls++;return present?structuredClone(item):null;},async history(){calls++;return{schemaVersion:'1.0',events:structuredClone(events),hasNextPage:false,endCursor:'history-cursor'};}};
  const options={compiled,adapter,buildPlan:buildPlan?buildPlan(f,compiled):planFor(f,compiled)},worker=createGitHubWorker(store,options),key=worker.keys[0];
  return{...f,compiled,store,close,adapter,options,worker,key,item,events,root,now:()=>now,calls:()=>calls,
    advance(ms=60001){now=new Date(Date.parse(now)+ms).toISOString();},
    present(value){present=value;},
    change(value='go-a',actorId=context.actorId){const before=item.fields.request.present?item.optionNames.request[item.fields.request.value]:'';
      item.fields.request=value===null?{present:false}:{present:true,value};item.updatedAt=now;
      events.push({id:`status-${events.length}`,kind:'status',scopeId:'scope-a',...(native?{fieldId:'request-a'}:{}),actorId,occurredAt:now,previousStatus:before,status:value===null?'':item.optionNames.request[value]});},
  };
}
