import type {LabstrideInstallationConfigurationV1 as Configuration} from '../../contracts/generated/config.ts';
import type {ProviderDescription} from '../configuration/compiler.ts';
import type {GitHubAdapterOptions} from './adapter.ts';
import type {GitHubHistory,GitHubHistoryEvent,GitHubItem,GitHubReader} from '../core/github.ts';
import {GitHubError} from '../core/github.ts';
import {object,string,nodes,pageInfo} from './client.ts';
import {validated} from '../storage-sqlite/validation.ts';
import {createGitHubProjection} from './projection.ts';
import { issueMetadata } from '../core/issue-naming.ts';

const definitions=`__typename ... on IssueFieldSingleSelect{id name dataType options{id name}}
 ... on IssueFieldText{id name dataType} ... on IssueFieldNumber{id name dataType} ... on IssueFieldDate{id name dataType}`;
const valueFields=`__typename ... on IssueFieldSingleSelectValue{optionId value field{... on IssueFieldSingleSelect{id}}}
 ... on IssueFieldTextValue{value field{... on IssueFieldText{id}}} ... on IssueFieldNumberValue{value field{... on IssueFieldNumber{id}}}
 ... on IssueFieldDateValue{value field{... on IssueFieldDate{id}}}`;
const issueFields=`__typename id number updatedAt title body state viewerCanSetFields repository{id nameWithOwner defaultBranchRef{target{oid}}}
 issueFieldValues(first:100){nodes{${valueFields}} pageInfo{hasNextPage endCursor}}`;
const eventFields=`__typename ... on IssueFieldAddedEvent{id createdAt value options{name} issueField{${definitions}} actor{__typename ... on User{id} ... on Bot{id}}}
 ... on IssueFieldChangedEvent{id createdAt previousValue newValue previousOptions{name} newOptions{name} issueField{${definitions}} actor{__typename ... on User{id} ... on Bot{id}}}
 ... on IssueFieldRemovedEvent{id createdAt options{name} issueField{${definitions}} actor{__typename ... on User{id} ... on Bot{id}}}`;
const types:Record<string,string>={SINGLE_SELECT:'single-select',TEXT:'string',NUMBER:'number',DATE:'date'};
// Repository-scoped native issue fields. No Project membership is required.
// Only explicitly qualified single-select history can authorize a start.
export class GitHubIssueFieldsAdapter implements GitHubReader {
  readonly providerId:string;
  #writable=new Map<string,boolean>();
  #options:GitHubAdapterOptions;
  #definitions=new Map<string,Record<string,unknown>[]>();
  #qualified=new Set<string>();
  constructor(options:GitHubAdapterOptions){
    this.providerId=string(options.providerId);this.#options={...options,configuration:structuredClone(options.configuration),
      historyQualifications:options.historyQualifications.map(value=>validated('github-history-qualification',value))};
  }
  beginTick(){this.#options.client.beginTick();this.#definitions.clear();this.#writable.clear();this.#qualified.clear();}
  withConfiguration(configuration:Configuration){return new GitHubIssueFieldsAdapter({...this.#options,configuration});}
  projection(store:Parameters<typeof createGitHubProjection>[0]){return createGitHubProjection(store,this);}
  private async definitions(scopeId:string):Promise<Record<string,unknown>[]>{
    const cached=this.#definitions.get(scopeId);if(cached)return cached;
    const metadata=object(await this.#options.client.query('query LabstrideIssueFieldOwner($id:ID!){node(id:$id){... on Repository{id nameWithOwner viewerPermission owner{__typename ... on Organization{id}}}}}',
      {id:scopeId},this.#options.configuration.github.credentialRef));
    const repo=object(metadata.node),owner=object(repo.owner);
    if(repo.id!==scopeId||!this.#options.configuration.github.repositories.includes(string(repo.nameWithOwner))||owner.__typename!=='Organization')throw new GitHubError('binding_invalid');
    let writable=['WRITE','MAINTAIN','ADMIN'].includes(String(repo.viewerPermission));
    // Installation tokens have no human repository role: viewerPermission is
    // null even when Issues(write) permits field writes. Verify GitHub's actual
    // operation-specific capability on the independently enrolled issue.
    if(repo.viewerPermission===null){
      const enrolled=this.#options.historyQualifications.find(value=>value.scopeId===scopeId);
      if(enrolled){
        const probe=object(await this.#options.client.query('query LabstrideNativeWriteCapability($id:ID!){node(id:$id){... on Issue{id viewerCanSetFields repository{id}}}}',
          {id:enrolled.subjectId},this.#options.configuration.github.credentialRef));
        const issue=object(probe.node);
        writable=issue.id===enrolled.subjectId&&object(issue.repository).id===scopeId&&issue.viewerCanSetFields===true;
      }
    }
    this.#writable.set(scopeId,writable);
    const result:Record<string,unknown>[]=[];let after:string|null=null;
    for(let page=0;page<10;page++){
      const data=object(await this.#options.client.query(`query LabstrideIssueFieldDefinitions($id:ID!,$after:String){node(id:$id){... on Organization{id issueFields(first:100,after:$after){nodes{${definitions}} pageInfo{hasNextPage endCursor}}}}}`,
        {id:string(owner.id),after},this.#options.configuration.github.credentialRef));
      const org=object(data.node);if(org.id!==owner.id)throw new GitHubError('binding_invalid');
      const connection=object(org.issueFields),next=pageInfo(connection.pageInfo);result.push(...nodes(connection.nodes));
      if(!next.hasNextPage){this.#definitions.set(scopeId,result);return result;}
      if(next.endCursor===after)throw new GitHubError('invalid_provider_data');after=next.endCursor;
    }
    throw new GitHubError('field_page_limit');
  }
  async describeField(field:Configuration['fields'][string],credentialRef:string):Promise<ProviderDescription>{
    if(credentialRef!==this.#options.configuration.github.credentialRef||field.source!=='organization_issue_field')throw new GitHubError('unsupported_binding');
    const found=(await this.definitions(field.scopeId)).find(value=>value.id===field.fieldId);
    if(!found||types[string(found.dataType)]!==field.type)throw new GitHubError('binding_invalid');
    const options=found.options?nodes(found.options):[];
    const qualification=this.#options.historyQualifications.find(value=>value.scopeId===field.scopeId&&value.fieldId===field.fieldId);
    if(qualification){
      const key=JSON.stringify(qualification);
      if(!this.#qualified.has(key)){
        let cursor:string|null=null,matched=false;
        for(let page=0;page<20;page++){
          const history=await this.history(qualification.subjectId,cursor);
          const event=history.events.find(event=>event.id===qualification.eventId&&event.fieldId===field.fieldId&&event.scopeId===field.scopeId&&event.actorId===qualification.actorId);
          if(event){if(event.status!==qualification.status||!options.some(option=>option.id===qualification.optionId))throw new GitHubError('unsupported_history_binding');matched=true;}
          if(!history.hasNextPage)break;cursor=history.endCursor;
        }
        if(!matched)throw new GitHubError('history_unavailable');this.#qualified.add(key);
      }
    }
    const history=!!qualification&&field.type==='single-select';
    return {schemaVersion:'1.0',providerId:this.providerId,credentialRef,source:field.source,scopeId:field.scopeId,fieldId:field.fieldId,type:field.type,
      optionIds:options.map(option=>string(option.id)),operators:['equals','notEquals','exists',...(field.type==='string'?['contains' as const]:[]),...(history?['changedTo' as const]:[])],
      readable:true,writable:this.#writable.get(field.scopeId)===true,history,actorAttribution:history,displayName:string(found.name),optionNames:Object.fromEntries(options.map(option=>[string(option.id),string(option.name)])),
      evidenceRefs:[`github:repository:${field.scopeId}`,`github:issue-field:${field.fieldId}`,...(qualification?[`github:history:${qualification.eventId}`]:[])]};
  }
  private async snapshot(raw:Record<string,unknown>):Promise<GitHubItem|null>{
    if(raw.__typename!=='Issue')return null;
    const repo=object(raw.repository),scopeId=string(repo.id),repository=string(repo.nameWithOwner);
    if(!this.#options.configuration.github.repositories.includes(repository))return null;
    const descriptors=await this.definitions(scopeId),connection=object(raw.issueFieldValues);
    if(pageInfo(connection.pageInfo).hasNextPage)throw new GitHubError('field_page_limit');
    const values=nodes(connection.nodes),fields:GitHubItem['fields']={},optionNames:GitHubItem['optionNames']={};
    for(const [logical,field] of Object.entries(this.#options.configuration.fields)){
      if(field.scopeId!==scopeId)continue;
      if(field.source==='native_issue'&&['title','body','state'].includes(field.fieldId)&&field.type==='string'){
        if(typeof raw[field.fieldId]!=='string')throw new GitHubError('invalid_provider_data');fields[logical]={present:true,value:raw[field.fieldId] as string};continue;
      }
      if(field.source!=='organization_issue_field')throw new GitHubError('unsupported_binding');
      const descriptor=descriptors.find(value=>value.id===field.fieldId);
      if(!descriptor||types[string(descriptor.dataType)]!==field.type)throw new GitHubError('binding_invalid');
      const options=descriptor.options?nodes(descriptor.options):[];
      if(Object.values(field.options??{}).some(id=>!options.some(option=>option.id===id)))throw new GitHubError('binding_invalid');
      optionNames[logical]=Object.fromEntries(options.map(option=>[string(option.id),string(option.name)]));
      const value=values.find(value=>value.field&&object(value.field).id===field.fieldId);
      if(!value){fields[logical]={present:false};continue;}
      const current=value[field.type==='single-select'?'optionId':'value'];
      if(typeof current!==(field.type==='number'?'number':'string')||field.type==='number'&&!Number.isFinite(current))throw new GitHubError('invalid_provider_data');
      if(field.type==='single-select'&&!options.some(option=>option.id===current))throw new GitHubError('binding_invalid');
      fields[logical]={present:true,value:current as string|number};
    }
    const issue=issueMetadata(raw.number,raw.title);
    return validated('github-item',{schemaVersion:'1.0',scopeId,itemId:string(raw.id),subjectId:string(raw.id),repositoryId:scopeId,repository,
      sourceSha:string(object(object(repo.defaultBranchRef).target).oid),updatedAt:string(raw.updatedAt),fields,optionNames,...(issue ? { issue } : {})} as GitHubItem);
  }
  async list(scopeId:string,cursor:string|null){
    await this.definitions(scopeId);
    const data=object(await this.#options.client.query(`query LabstrideNativeIssues($id:ID!,$after:String){node(id:$id){... on Repository{id issues(first:20,after:$after,orderBy:{field:CREATED_AT,direction:ASC}){nodes{${issueFields}} pageInfo{hasNextPage endCursor}}}}}`,
      {id:scopeId,after:cursor},this.#options.configuration.github.credentialRef));
    const repo=object(data.node);if(repo.id!==scopeId)throw new GitHubError('binding_invalid');
    const connection=object(repo.issues),page=pageInfo(connection.pageInfo),items:GitHubItem[]=[];
    for(const raw of nodes(connection.nodes)){const item=await this.snapshot(raw);if(item)items.push(item);}
    return{items,...page};
  }
  async item(id:string):Promise<GitHubItem|null>{
    const data=object(await this.#options.client.query(`query LabstrideNativeIssue($id:ID!){node(id:$id){... on Issue{${issueFields}}}}`,{id},this.#options.configuration.github.credentialRef));
    return data.node===null?null:this.snapshot(object(data.node));
  }
  async history(id:string,cursor:string|null):Promise<GitHubHistory>{
    const data=object(await this.#options.client.query(`query LabstrideNativeHistory($id:ID!,$after:String){node(id:$id){... on Issue{repository{id nameWithOwner} timelineItems(first:100,after:$after,itemTypes:[ISSUE_FIELD_ADDED_EVENT,ISSUE_FIELD_CHANGED_EVENT,ISSUE_FIELD_REMOVED_EVENT]){nodes{${eventFields}} pageInfo{hasNextPage endCursor}}}}}`,
      {id,after:cursor},this.#options.configuration.github.credentialRef));
    const issue=object(data.node),repo=object(issue.repository);
    if(!this.#options.configuration.github.repositories.includes(string(repo.nameWithOwner)))throw new GitHubError('binding_invalid');
    const connection=object(issue.timelineItems),page=pageInfo(connection.pageInfo),events:GitHubHistoryEvent[]=[];
    for(const raw of nodes(connection.nodes)){
      if(raw.issueField===null)throw new GitHubError('history_unavailable');const field=object(raw.issueField);
      if(field.__typename!=='IssueFieldSingleSelect')continue;
      const name=(value:unknown,options:unknown):string|null=>{
        if(options!==null&&options!==undefined){const choices=nodes(options);if(choices.length>1)throw new GitHubError('invalid_provider_data');if(choices.length)return string(choices[0].name);}
        return typeof value==='string'&&value?value:null;
      };
      const type=string(raw.__typename),actor=raw.actor===null?null:object(raw.actor);
      if(!['IssueFieldAddedEvent','IssueFieldChangedEvent','IssueFieldRemovedEvent'].includes(type))throw new GitHubError('invalid_provider_data');
      events.push({id:string(raw.id),kind:'status',scopeId:string(repo.id),fieldId:string(field.id),actorId:actor?.id?string(actor.id):null,occurredAt:string(raw.createdAt),
        previousStatus:type==='IssueFieldAddedEvent'?null:name(raw.previousValue,type==='IssueFieldChangedEvent'?raw.previousOptions:raw.options),
        status:type==='IssueFieldRemovedEvent'?null:name(type==='IssueFieldChangedEvent'?raw.newValue:raw.value,type==='IssueFieldChangedEvent'?raw.newOptions:raw.options)});
    }
    return validated('github-history-page',{schemaVersion:'1.0',events,...page});
  }
  async setField(scopeId:string,itemId:string,fieldId:string,type:string,value:unknown,token:string){
    const descriptor=(await this.definitions(scopeId)).find(field=>field.id===fieldId);
    if(!descriptor||types[string(descriptor.dataType)]!==type)throw new GitHubError('unsupported_binding');
    const before=object(await this.#options.client.query(`query LabstrideNativeWritePreflight($id:ID!){node(id:$id){... on Issue{${issueFields}}}}`,{id:itemId},this.#options.configuration.github.credentialRef));
    const raw=object(before.node),item=await this.snapshot(raw);
    if(!item||item.scopeId!==scopeId)throw new GitHubError('binding_invalid');
    if(raw.viewerCanSetFields!==true)throw new GitHubError('unsupported_binding');
    const property=type==='single-select'?'singleSelectOptionId':type==='string'?'textValue':type==='number'?'numberValue':type==='date'?'dateValue':null;
    if(!property||value!==null&&(typeof value!==(type==='number'?'number':'string')||type==='number'&&!Number.isFinite(value)))throw new GitHubError('invalid_value');
    if(type==='single-select'&&value!==null&&!nodes(descriptor.options).some(option=>option.id===value))throw new GitHubError('invalid_value');
    await this.#options.client.query('mutation LabstrideNativeProjection($input:SetIssueFieldValueInput!){setIssueFieldValue(input:$input){clientMutationId}}',
      {input:{issueId:itemId,clientMutationId:token,issueFields:[{fieldId,...(value===null?{delete:true}:{[property]:value})}]}},this.#options.configuration.github.credentialRef);
  }
}
