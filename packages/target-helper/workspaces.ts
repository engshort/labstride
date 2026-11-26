import { createCleanupTables, assertWorkspaceAvailable } from './cleanup-state.ts';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, chownSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TargetRegistry } from './registry.ts';
import { assertPrivateDatabase, directoryIdentity, sameIdentity, TargetError, withWorkspaceRoot } from './filesystem.ts';
import { digest } from '../storage-sqlite/execution.ts';
import { validated } from '../storage-sqlite/validation.ts';
import { validateWorkspaceRequest, workspaceIdentity, workspaceCapabilities } from './workspace-contracts.ts';
import type { WorkspacePolicy, WorkspaceRequest, WorkspaceResponse, WorkspaceReceipt } from './workspace-contracts.ts';
import { sourceAccess, observeSource, runGit } from './workspace-git.ts';
import type { SourceAccess } from './workspace-git.ts';
export type WorkspaceStage = 'intent'|'staging'|'materialized'|'promoted'|'accessible'|'committed';
export interface WorkspaceDependencies {
  barrier?: (stage: WorkspaceStage) => void;
  observeSource?: (source: SourceAccess) => Promise<void>;
  git?: typeof runGit;
}
const syncDirectory = (path:string) => {const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}};
const absent = (path:string) => {try{lstatSync(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}throw new TargetError('resource_busy');};
const legacyPolicy = (policy:WorkspacePolicy) => {const {codingGid:_gid,sources:_sources,cleanup:_cleanup,...base}=policy;return {...base,schemaVersion:'1.0' as const};};
export class WorkspaceRegistry {
  private db: DatabaseSync;
  readonly policy:WorkspacePolicy;
  private dependencies:WorkspaceDependencies;
  constructor(input:WorkspacePolicy,dependencies:WorkspaceDependencies={}) {
    this.policy=validated('ssh-workspace-policy',input);this.dependencies=dependencies;
    const policy=this.policy;
    if(policy.helperUid===policy.codingUid || process.getuid!()!==policy.helperUid ||
      ![process.getgid!(),...process.getgroups!()].includes(policy.codingGid) ||
      new Set(policy.sources.map(source=>source.repositoryId)).size!==policy.sources.length)throw new TargetError('configuration_invalid');
    for(const source of policy.sources)sourceAccess(source);
    // Legacy registry ownership and reservations survive the additive migration.
    const legacy=new TargetRegistry(legacyPolicy(policy));legacy.close();
    assertPrivateDatabase(policy.stateDir,'target.sqlite');
    this.db=new DatabaseSync(join(policy.stateDir,'target.sqlite'),{timeout:5000});
    this.db.exec(`PRAGMA synchronous=FULL; BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS workspace_creations (operation_id TEXT PRIMARY KEY, workspace_id TEXT UNIQUE NOT NULL,
        request_digest TEXT NOT NULL, request TEXT NOT NULL CHECK(json_valid(request)), state TEXT NOT NULL,
        receipt TEXT CHECK(receipt IS NULL OR json_valid(receipt)), error TEXT);
      CREATE TRIGGER IF NOT EXISTS workspace_identity_immutable BEFORE UPDATE OF operation_id,workspace_id,request_digest,request ON workspace_creations
        BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TRIGGER IF NOT EXISTS workspace_creation_retained BEFORE DELETE ON workspace_creations BEGIN SELECT RAISE(ABORT,'immutable'); END;
      `);
    createCleanupTables(this.db);
    this.db.exec('PRAGMA user_version=3; COMMIT');
  }
  async handle(input:unknown):Promise<WorkspaceResponse> {
    const request=validated<WorkspaceRequest>('ssh-workspace-request',input as WorkspaceRequest);
    const {operation:_operation,includeRoots:_includeRoots,...base}=request;
    const reply=(workspace:WorkspaceReceipt|null,error:TargetError['code']|null=null,roots?:WorkspacePolicy['roots']):WorkspaceResponse=>validated('ssh-workspace-response',{
      ...base,outcome:error===null?'ok':error==='outcome_unknown'?'outcome_unknown':'error',workspace,
      ...(roots?{roots}:{}),
      capabilities:error===null?roots?[...workspaceCapabilities,'workspace.root-map.v1']:[...workspaceCapabilities]:[],error:error===null?null:{code:error,message:error,evidenceId:null,retryClass:error==='outcome_unknown'?'reconcile':'none'},
    });
    let dispatched=false;
    try {
      validateWorkspaceRequest(this.policy,request);
      if(request.method==='probe') {
        for(const root of this.policy.roots)withWorkspaceRoot(root.path,root.identity,()=>{});
        return reply(null,null,request.includeRoots?structuredClone(this.policy.roots):undefined);
      }
      const op=request.operation!; assertWorkspaceAvailable(this.db, op.workspaceId);
      const root=this.policy.roots.find(root=>root.id===op.inputs.rootId)!;
      const identity=workspaceIdentity(request.installationId,request.targetId,op.workspaceId,op.source.issue);
      const saved=this.db.prepare('SELECT * FROM workspace_creations WHERE operation_id=?').get(op.operationId);
      if(saved) {
        if(saved.request_digest!==op.requestDigest || saved.request!==JSON.stringify(op))throw new TargetError('identity_mismatch');
        if(saved.state==='failed')return reply(null,saved.error as TargetError['code']);
        if(!saved.receipt)throw new TargetError('outcome_unknown');
        const receipt=validated<WorkspaceReceipt>('ssh-workspace-receipt',JSON.parse(String(saved.receipt)));
        const expected={...identity,installationId:request.installationId,targetId:request.targetId,targetRevision:request.targetRevision,
          runId:op.runId,workspaceId:op.workspaceId,operationId:op.operationId,handle:op.operationId,requestDigest:op.requestDigest,rootId:root.id,source:op.source};
        for(const field of Object.keys(expected) as (keyof typeof expected)[])
          if(digest(receipt[field])!==digest(expected[field]))throw new TargetError('identity_mismatch');
        withWorkspaceRoot(root.path,root.identity,(directory)=>{
          const path=join(directory,identity.locator);
          if(saved.state!=='ready' && (lstatSync(path).mode&0o777)!==0o750)throw new TargetError('outcome_unknown');
          this.checkPublished(path,receipt);
        });
        // Recover a publication observed before the process persisted its final acknowledgement.
        this.db.prepare("UPDATE workspace_creations SET state='ready' WHERE operation_id=?").run(op.operationId);
        return reply(receipt);
      }
      if(request.method==='inspect')throw new TargetError('outcome_unknown');
      if(Date.parse(op.deadline)<=Date.now())throw new TargetError('forbidden');
      const source=sourceAccess(this.policy.sources.find(source=>source.repositoryId===op.source.repositoryId)!);
      await (this.dependencies.observeSource??observeSource)(source);
      // Recheck after the independent read; another request may have claimed it.
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const prior=this.db.prepare('SELECT 1 FROM workspace_creations WHERE operation_id=? OR workspace_id=?').get(op.operationId,op.workspaceId);
        if(prior)throw new TargetError('resource_busy');
        const reservation=this.db.prepare('SELECT payload FROM reservations WHERE workspace_id=?').get(op.workspaceId);
        if(reservation) {const owner=JSON.parse(String(reservation.payload));if(owner.runId!==op.runId || owner.rootId!==root.id || owner.installationId!==request.installationId)throw new TargetError('identity_mismatch');}
        withWorkspaceRoot(root.path,root.identity,directory=>{absent(join(directory,identity.locator));absent(join(directory,identity.locator+'.stage'));});
        this.db.prepare("INSERT INTO workspace_creations VALUES (?,?,?,?, 'creating', NULL, NULL)")
          .run(op.operationId,op.workspaceId,op.requestDigest,JSON.stringify(op));
        this.db.exec('COMMIT');dispatched=true;
      }catch(error){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw error;}
      this.dependencies.barrier?.('intent');
      const receipt=withWorkspaceRoot(root.path,root.identity,(directory,check)=>{
        const stage=join(directory,identity.locator+'.stage'),destination=join(directory,identity.locator),checkout=join(stage,'source');
        absent(destination);mkdirSync(stage,{mode:0o700});mkdirSync(checkout,{mode:0o2770});
        chownSync(stage,this.policy.helperUid,this.policy.codingGid);chownSync(checkout,this.policy.helperUid,this.policy.codingGid);chmodSync(checkout,0o2770);
        this.dependencies.barrier?.('staging');
        const git=this.dependencies.git??runGit;
        const previousMask=process.umask(0o007);
        try {
        git(checkout,['init','--template=','.']);git(checkout,['remote','add','origin',source.binding.gitUrl]);
        git(checkout,['fetch','--no-tags','--no-recurse-submodules','--depth=1','origin',op.source.sha],source);
        if(git(checkout,['rev-parse','--verify',`${op.source.sha}^{commit}`])!==op.source.sha)throw new TargetError('identity_mismatch');
        git(checkout,['-c','core.sharedRepository=group','checkout','--no-recurse-submodules','-b',identity.branch,op.source.sha]);
        if(git(checkout,['rev-parse','HEAD'])!==op.source.sha || git(checkout,['symbolic-ref','--short','HEAD'])!==identity.branch)throw new TargetError('identity_mismatch');
        // The staging wrapper is private until handoff; no untrusted writer can
        // change source entries during materialization or permission setup.
        git(checkout,['config','core.sharedRepository','group']);
        const receipt=validated<WorkspaceReceipt>('ssh-workspace-receipt',{schemaVersion:'1.0',installationId:request.installationId,targetId:request.targetId,
          targetRevision:request.targetRevision,runId:op.runId,workspaceId:op.workspaceId,operationId:op.operationId,requestDigest:op.requestDigest,
          rootId:root.id,...identity,handle:op.operationId,source:op.source,directoryIdentity:directoryIdentity(stage),checkoutIdentity:directoryIdentity(checkout),state:'ready'});
        writeFileSync(join(stage,'workspace.json'),JSON.stringify(receipt)+'\n',{mode:0o640,flag:'wx'});
        chownSync(join(stage,'workspace.json'),this.policy.helperUid,this.policy.codingGid);
        const marker=openSync(join(stage,'workspace.json'),constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(marker);}finally{closeSync(marker);}
        syncDirectory(checkout);syncDirectory(stage);
        this.db.prepare("UPDATE workspace_creations SET state='materialized',receipt=? WHERE operation_id=?").run(JSON.stringify(receipt),op.operationId);
        this.dependencies.barrier?.('materialized');check();absent(destination);
        // Only this helper identity can write the protected parent. The durable
        // unique claim excludes another managed creator; no replace is attempted.
        renameSync(stage,destination);syncDirectory(root.path);this.dependencies.barrier?.('promoted');
        chmodSync(destination,0o750);this.dependencies.barrier?.('accessible');check();
        this.checkPublished(destination,receipt);
        this.db.prepare("UPDATE workspace_creations SET state='ready' WHERE operation_id=?").run(op.operationId);
        this.dependencies.barrier?.('committed');return receipt;
        } finally { process.umask(previousMask); }
      });
      return reply(receipt);
    }catch(error) {
      // After durable intent, never infer failure or replay from a thrown error.
      const code=dispatched?'outcome_unknown':error instanceof TargetError?error.code:'outcome_unknown';
      return reply(null,code);
    }
  }
  checkPublished(path:string,receipt:WorkspaceReceipt,fenced=false):void {
    const stat=lstatSync(path),child=lstatSync(join(path,'source'));
    if(!stat.isDirectory() || stat.isSymbolicLink() || stat.uid!==this.policy.helperUid || stat.gid!==this.policy.codingGid ||
      !((fenced?[0o700,0o750]:[0o750]).includes(stat.mode&0o777)) || !child.isDirectory() || child.isSymbolicLink() || child.uid!==this.policy.helperUid || child.gid!==this.policy.codingGid ||
      !sameIdentity(directoryIdentity(path),receipt.directoryIdentity))throw new TargetError('identity_mismatch');
    // source is deliberately group-writable: observe only its top descriptor,
    // never execute Git or traverse coding-controlled content during inspection.
    if(!sameIdentity(directoryIdentity(join(path,'source')),receipt.checkoutIdentity))throw new TargetError('identity_mismatch');
    const markerFd=openSync(join(path,'workspace.json'),constants.O_RDONLY|constants.O_NOFOLLOW);
    let marker:unknown;
    try {const info=fstatSync(markerFd);if(!info.isFile() || info.nlink!==1 || info.uid!==this.policy.helperUid || (info.mode&0o022) || info.size>65536)throw new TargetError('identity_mismatch');marker=JSON.parse(readFileSync(markerFd,'utf8'));}
    finally{closeSync(markerFd);}
    if(digest(marker)!==digest(receipt))throw new TargetError('identity_mismatch');
  }
  // A runtime may attach only to the original, proven source creation. Resolve
  // its request from protected state rather than trusting a caller's receipt.
  async inspectOperation(operationId:string):Promise<WorkspaceResponse> {
    const row=this.db.prepare('SELECT request FROM workspace_creations WHERE operation_id=?').get(operationId);
    if(!row)throw new TargetError('outcome_unknown');
    const operation=JSON.parse(String(row.request));
    return this.handle({schemaVersion:'2.0',requestId:operationId,installationId:this.policy.installationId,
      targetId:this.policy.targetId,targetRevision:this.policy.targetRevision,method:'inspect',operation});
  }
  beginUse(operationId:string,workspaceId:string):void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      assertWorkspaceAvailable(this.db,workspaceId);
      this.db.prepare('INSERT INTO workspace_uses VALUES (?,?,1) ON CONFLICT(operation_id) DO UPDATE SET active=1').run(operationId,workspaceId);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  endUse(operationId:string):void { this.db.prepare('UPDATE workspace_uses SET active=0 WHERE operation_id=?').run(operationId); }
  close(){this.db.close();}
}
