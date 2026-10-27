import { compiledSnapshot } from '../configuration/compiler.ts';
import type { GitHubOptions } from './github.ts';
import { GitHubError } from './github.ts';
import { LifecycleError } from './lifecycle.ts';
import type { GitHubStore } from '../storage-sqlite/github.ts';

export function createGitHubWorker(store: GitHubStore, options: GitHubOptions) {
  const snapshot=compiledSnapshot(options.compiled), configuration=snapshot.configuration;
  const scopes=[...new Set(Object.values(snapshot.bindings).filter(binding=>binding.providerId===options.adapter.providerId&&['project_v2','organization_issue_field'].includes(binding.source)).map(binding=>binding.scopeId))];
  const keys=scopes.map(scope=>store.registerGitHub(options.compiled,options.adapter.providerId,scope).key);
  let ticking=false;
  return {
    keys,
    async tick():Promise<void>{
      if(ticking)return;ticking=true;options.adapter.beginTick();
      try{
        for(const key of keys){
          let project=store.githubStatus(key);
          if(project.lastError&&!store.githubDue(key))continue;
          try{
            if(store.githubDue(key)){
              let page;
              try{page=await options.adapter.list(project.scopeId,project.cursor);}
              catch(error){if(error instanceof GitHubError&&error.code==='invalid_cursor')store.resetGitHubList(key);throw error;}
              store.commitGitHubList(project,page.items,page.endCursor,page.hasNextPage,configuration.github.pollIntervalSeconds*1000);
              project=store.githubStatus(key);
            }
            const fields=Object.entries(snapshot.bindings).filter(([,binding])=>binding.scopeId===project.scopeId&&binding.providerId===project.providerId&&binding.history&&binding.actorAttribution);
            if(fields.length!==1)throw new GitHubError('unsupported_history_binding');
            for(const job of store.githubItems(key)){
              let page;
              try{page=await options.adapter.history(job.subjectId,job.cursor);}
              catch(error){if(error instanceof GitHubError&&error.code==='invalid_cursor')store.resetGitHubHistory(job);throw error;}
              const item=await options.adapter.item(job.itemId);
              store.commitGitHubHistory(job,page,item,fields[0][0]);
            }
            const blockedItems=new Set(store.githubItemDiagnostics(key).map(value=>value.itemId));
            for(const candidate of store.githubCandidates(key)){
              const itemId=candidate.observation.event.facts.itemId;
              if(typeof itemId!=='string')throw new GitHubError('invalid_provider_data');
              if(blockedItems.has(itemId))continue;
              const fresh=await options.adapter.item(itemId);
              store.admitGitHubCandidate(candidate,fresh,options);
            }
          }catch(error){
            if(error instanceof LifecycleError&&error.code==='revision_conflict')continue;
            const code=error instanceof GitHubError?error.code:error instanceof LifecycleError?error.code:'provider_unavailable';
            store.githubRetry(key,code,error instanceof GitHubError?error.retryAfterMs??0:0);
            if(code==='budget_exhausted')break;
          }
        }
        // New configuration controls new requests. Existing runs still project
        // through their immutable configuration and exact membership binding.
        for(const project of store.githubProgressProjects(options.adapter.providerId)){
          if(project.lastError&&!store.githubDue(project.key))continue;
          const pending=store.pendingGitHubProgress(project.key);if(!pending.length)continue;
          const reader=project.configDigest===snapshot.digest?options.adapter:options.adapter.withConfiguration?.(store.configurationSnapshot(project.configDigest).configuration);
          if(!reader)continue;
          try{
            for(const progress of pending){const item=await reader.item(progress.itemId);if(item)store.enqueueGitHubProgress(progress.runId,progress.fact,item);}
          }catch(error){
            const code=error instanceof GitHubError?error.code:'provider_unavailable';store.githubRetry(project.key,code,error instanceof GitHubError?error.retryAfterMs??0:0);
            if(code==='budget_exhausted')break;
          }
        }
      }finally{ticking=false;}
    },
  };
}
