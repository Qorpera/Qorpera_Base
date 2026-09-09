// Actual login gateway, physical-operation journal and all PostgreSQL RPCs.
// Host measurements, LXD and guest sign-in are explicit local fixtures. No
// hosted endpoints, account credentials, provider login or paid model calls.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";

if (process.argv.length !== 2) throw new Error("Usage: node scripts/test-runtime-login-node.mjs");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const container = `qorpera-login-node-${randomBytes(6).toString("hex")}`;
const scratch = await realpath(await mkdtemp(join(tmpdir(), "login-node-proof-")));
const psql = ["exec", "-i", container, "psql", "-X", "-qAt", "-U", "postgres", "-d", "login", "-v", "ON_ERROR_STOP=1"];
const read = path => readFileSync(join(root,path),"utf8");
const quoted = value => `'${String(value).replaceAll("'","''")}'`;
const literal = value => `${quoted(JSON.stringify(value))}::jsonb`;
const service = `set request.jwt.claims='{"role":"service_role"}'; set role service_role;`;
const profileId = "30000000-0000-4000-8000-000000000010", owner = "30000000-0000-4000-8000-000000000001", nodeId = "36000000-0000-4000-8000-000000000010";
const host = {machineIdSha256:"c".repeat(64),cpuMillis:16000,memoryBytes:64*1024**3};
function docker(args,input) {
	const result = spawnSync("docker",args,{input,encoding:"utf8",timeout:60000,maxBuffer:16*1024*1024});
	assert(!result.error && result.status === 0,`${result.stderr}\n${result.stdout?.slice(-2000) ?? ""}\n${result.error ?? ""}`);
	return result.stdout.trim();
}
const sql = statement => docker(psql,statement);
async function ready() {
	let count = 0;
	for(let attempt=0;attempt<60 && count<2;attempt++) {
		const result=spawnSync("docker",["exec",container,"pg_isready","-U","postgres","-d","login"],{timeout:2000});
		count=result.status===0 ? count+1 : 0;
		if(count<2) await new Promise(resolve=>setTimeout(resolve,250));
	}
	assert.equal(count,2);
}
let started = false;
try {
	await build({entryPoints:{gateway:join(root,"packages/runner-orchestrator/src/lxd-login-gateway.ts"),policy:join(root,"packages/runner-orchestrator/src/lxd-login-plan.ts")},outdir:scratch,bundle:true,platform:"node",format:"cjs",outExtension:{".js":".cjs"},target:"node22",
		plugins:[{name:"explicit-fixture-host",setup(builder){
			builder.onResolve({filter:/^\.\/runtime-node-host\.ts$/},()=>({path:"host",namespace:"fixture-host"}));
			builder.onLoad({filter:/.*/,namespace:"fixture-host"},()=>({contents:`export async function readRuntimeNodeHost(signal) { signal.throwIfAborted(); return ${JSON.stringify(host)}; }`,loader:"js"}));
		}}]});
	const require = createRequire(import.meta.url);
	const {LxdNativeLoginGateway}=require(join(scratch,"gateway.cjs")), {lxdLoginNodePolicy}=require(join(scratch,"policy.cjs"));
	docker(["run","-d","--rm","--name",container,"--network","none","-e","POSTGRES_PASSWORD=disposable-login","-e","POSTGRES_DB=login",POSTGRES_IMAGE]);started=true;
	await ready(); sql(read("supabase/tests/bootstrap.sql"));
	const migrations=sortMigrationNames(readdirSync(join(root,"supabase/migrations")));
	for(const name of migrations) sql(read(`supabase/migrations/${name}`));
	sql(read("supabase/tests/fixtures/runtime-node-inventory-observer.sql"));
	const foundation=read("supabase/tests/300_runtime_wake_bus.test.sql").split("select set_config('qorpera_test.wake_login'");
	assert.equal(foundation.length,2); sql(`${foundation[0]}\ncommit;`);
	const identityId=sql(`select id from public.qorpera_member_compute_identities where profile_id=${quoted(profileId)} and owner_user_id=${quoted(owner)};`);
	const capability="f".repeat(43), capabilitySha=createHash("sha256").update(capability).digest("hex"), clientConnectionId=randomUUID();
	const login=JSON.parse(sql(`set request.jwt.claims=${quoted(JSON.stringify({role:"authenticated",sub:owner}))}; set role authenticated;
		select public.qorpera_begin_native_provider_login(${quoted(profileId)},${quoted(randomUUID())},${quoted(clientConnectionId)},${quoted(identityId)},'openai','codex-cli',${quoted(capabilitySha)},900);`));
	const ca=read("deploy/cloud-secret-broker/supabase-prod-ca-2021.crt");
	const config={adapterId:"lxd",supabaseUrl:"https://fixture.invalid",supabaseServiceKey:"fixture-service",stateRoot:join(scratch,"state"),project:"qorpera-runners",loginProfile:"qorpera-login-v1",networkInterface:"enp5s0",imageServer:"local",imageFingerprint:"a".repeat(64),storagePool:"qorpera-vm",identityVolumePrefix:"identity-",identityVolumeSize:"32GiB",rootDiskSize:"64GiB",cpuLimit:4,memoryLimit:"8GiB",nativeBridgePort:8083,guestTrustedSource:"10.41.0.1",identityRecoveryCaCertificate:ca,identityRecoveryCaSha256:createHash("sha256").update(ca).digest("hex"),guestReadyTimeoutMs:10000,codexPath:"/usr/local/bin/codex",claudePath:"/usr/local/bin/claude"};
	const {policySha256}=lxdLoginNodePolicy(config,host.machineIdSha256);
	const nodePolicy={schema:"qorpera.runtime-node-policy/v1",nodeId,machineIdSha256:host.machineIdSha256,label:"login-node-fixture",cpuMillis:6000,memoryBytes:16*1024**3,headroomCpuMillis:2000,headroomMemoryBytes:1024**3,standardCpuMillis:4000,standardMemoryBytes:8*1024**3,enabled:true};
	const observe=state=>sql(`${service} select public.qorpera_test_observe_runtime_node(${literal({schema:"qorpera.runtime-node-observation/v1",nodeId,machineIdSha256:host.machineIdSha256,observationId:randomUUID(),observedAt:new Date().toISOString(),cpuMillis:host.cpuMillis,memoryBytes:host.memoryBytes,state})});`);
	const signatures={qorpera_describe_native_provider_login_route:["p_login_id","p_capability_sha256"],qorpera_reserve_runtime_login_machine:["p_allocation_id","p_provider_adapter","p_instance_sha256","p_login_id","p_capability_sha256"],qorpera_reserve_runtime_node_machine:["p_allocation_id","p_provider_kind","p_provider_id","p_policy_sha256","p_instance_sha256","p_machine_id_sha256","p_cpu_millis","p_memory_bytes"],qorpera_describe_runtime_login_machine:["p_allocation_id","p_provider_adapter","p_instance_sha256"],qorpera_release_runtime_login_machine:["p_allocation_id","p_provider_adapter","p_instance_sha256","p_login_id"]};
	let loseNode=false,loseRelease=false,companyCalls=0,nodeCalls=0,forwarded=0;
	const fetcher=async(input,init)=>{
		init?.signal?.throwIfAborted(); const url=new URL(String(input)); assert.equal(init.redirect,"error");
		if(url.origin==="http://10.41.0.9:8083") {
			if(url.pathname==="/healthz") return Response.json({ok:true});
			assert.equal(url.pathname,"/login"); assert.equal(new Headers(init.headers).get("authorization"),`Bearer ${capability}`); forwarded++;
			return Response.json({schema:"qorpera.native-provider-login-result/v1",login_id:login.login_id,status:"awaiting_member",interaction_url:"https://provider.invalid/device",user_code:"FIXTURE"});
		}
		assert.equal(url.origin,"https://fixture.invalid"); const name=url.pathname.slice("/rest/v1/rpc/".length),args=JSON.parse(String(init.body)),keys=signatures[name];assert(keys);assert.deepEqual(Object.keys(args).sort(),[...keys].sort());
		const result=JSON.parse(sql(`${service} select public.${name}(${keys.map(key=>quoted(args[key])).join(",")});`));
		if(name==="qorpera_reserve_runtime_login_machine") companyCalls++;
		if(name==="qorpera_reserve_runtime_node_machine") {nodeCalls++;if(loseNode && result.state==="reserved"){loseNode=false;throw new Error("lost committed node admission");}}
		if(name==="qorpera_release_runtime_login_machine" && loseRelease){loseRelease=false;throw new Error("lost committed release");}
		return Response.json(result);
	};
	let instance,creates=0,starts=0,stops=0,deletes=0,loseStopPoll=false;const volumes=new Map(),operations=new Map();
	const lxd={async getInstance(_project,name){return instance?.name===name?structuredClone(instance):undefined;},async getStorageVolume(_project,_pool,name){return volumes.get(name);},async createStorageVolume(_project,_pool,request){volumes.set(request.name,{name:request.name,type:request.type,contentType:request.content_type,description:request.description,config:request.config});},
		async submitInstanceOperation(project,action,signal){signal.throwIfAborted();const operationId=randomUUID();operations.set(operationId,action.action);
			if(action.action==="create"){creates++;const request=action.request;instance={...structuredClone(request),status:"Stopped",statusCode:102,expandedDevices:structuredClone(request.devices),expandedConfig:structuredClone(request.config)};observe("unavailable");}
			if(action.action==="start"){starts++;instance.status="Running";instance.statusCode=103;}
			if(action.action==="stop"){stops++;instance.status="Stopped";instance.statusCode=102;}
			if(action.action==="delete"){deletes++;instance=undefined;}
			return {project,instanceName:action.action==="create"?action.request.name:action.name,operationId};},
		async inspectInstanceOperation(reference,signal){signal.throwIfAborted();assert(operations.has(reference.operationId));if(loseStopPoll && operations.get(reference.operationId)==="stop"){loseStopPoll=false;throw new Error("lost accepted stop poll");}return "succeeded";},
		async getInstanceState(){return {status:instance.status,statusCode:instance.statusCode,network:{enp5s0:{addresses:[{family:"inet",scope:"global",address:"10.41.0.9"}]}}};},async pushInstanceFile(){},async execInstance(){},
		async createInstance(){throw new Error("untracked creation forbidden");},async setInstancePower(){throw new Error("untracked power forbidden");},async deleteInstance(){throw new Error("untracked deletion forbidden");},
	};
	const gateway=()=>new LxdNativeLoginGateway(config,lxd,fetcher);
	const request=()=>new Request("http://127.0.0.1/login",{method:"POST",headers:{authorization:`Bearer ${capability}`,"content-type":"application/json"},body:JSON.stringify({schema:"qorpera.native-provider-login/v1",login_id:login.login_id,client_connection_id:clientConnectionId,compute_identity_id:identityId,compute_identity_ownership_kind:"member",compute_identity_owner_user_id:owner,compute_identity_owner_scope_key:null,provider:"openai",native_harness:"codex-cli",login_capability:capability,expires_at:login.expires_at})});
	assert.equal((await gateway().handle(request())).status,503);assert.equal(creates,0);assert.equal(volumes.size,0);
	sql(`${service} select public.qorpera_configure_runtime_node(${literal(nodePolicy)},0); select public.qorpera_enroll_runtime_node_provider(${quoted(nodeId)},${quoted(host.machineIdSha256)},'login','lxd',${quoted(policySha256)},4000,8589934592);`);
	assert.equal((await gateway().handle(request())).status,503);assert.equal(creates,0);
	observe("ready");loseNode=true;assert.equal((await gateway().handle(request())).status,503);assert.equal(creates,0);
	assert.equal(sql("select count(*) from public.qorpera_runtime_node_demands where reserved_at is not null and released_at is null;"),"1");
	assert.equal((await gateway().handle(request())).status,503);assert.equal(creates,1);assert.equal(starts,0);assert.equal(instance.status,"Stopped");
	observe("ready");assert.equal((await gateway().handle(request())).status,200);assert.equal(starts,1);assert.equal(forwarded,1);
	const authorityPath=join(config.stateRoot,login.login_id,"authority.json"),authority=await readFile(authorityPath,"utf8");
	assert.equal(JSON.parse(authority).policy.machineIdSha256,host.machineIdSha256);assert.notEqual(JSON.parse(authority).allocationId,login.login_id);
	assert(!authority.includes(capability));assert.equal(sql("select count(*) from public.qorpera_runtime_machine_allocations;"),"1");
	const charged=sql("select to_jsonb(d) from public.qorpera_runtime_node_demands d;");docker(["restart",container]);await ready();assert.equal(sql("select to_jsonb(d) from public.qorpera_runtime_node_demands d;"),charged);assert.equal(await readFile(authorityPath,"utf8"),authority);
	// Explicit expiry fixture; cleanup itself must use actual revoked SQL
	// authority and retained physical history, with all member clients absent.
	sql(`update public.qorpera_native_provider_login_sessions set expires_at=clock_timestamp()-interval '1 second' where id=${quoted(login.login_id)}; ${service} select public.qorpera_configure_runtime_node(${literal({...nodePolicy,enabled:false})},1);`);
	loseStopPoll=true;assert.deepEqual(await gateway().reconcile(new AbortController().signal),{scanned:1,unconfirmed:1});assert.equal(stops,1);assert.equal(deletes,0);
	assert.equal(sql("select count(*) from public.qorpera_runtime_machine_allocations where released_at is null;"),"1");
	loseRelease=true;assert.deepEqual(await gateway().reconcile(new AbortController().signal),{scanned:1,unconfirmed:1});assert.equal(deletes,1);assert.equal(instance,undefined);
	assert.deepEqual(await gateway().reconcile(new AbortController().signal),{scanned:1,unconfirmed:0});
	assert.equal(stops,1);assert.equal(deletes,1);assert.equal(volumes.size,1);assert(volumes.has(`identity-${identityId}`));
	assert.equal(sql("select count(*) from public.qorpera_runtime_node_demands d join public.qorpera_runtime_machine_allocations a on a.id=d.allocation_id join public.qorpera_runtime_login_machine_requests r using(allocation_id) where d.released_at=a.released_at and r.released_at=a.released_at;"),"1");
	assert.equal(companyCalls,nodeCalls);
	console.log(JSON.stringify({schema:"qorpera.login-node-provider-sql-proof/v1",migrations:migrations.length,companyCalls,nodeCalls,creates,starts,stops,deletes,forwarded,unconfiguredRefused:true,staleRefused:true,lostAdmissionRetained:true,preStartRefusalRetryable:true,databaseRestartRetained:true,allMemberClientsAbsentDuringCleanup:true,lostStopPollRecovered:true,lostReleaseRecovered:true,identityVolumeRetained:true,physicalHostAndVm:"synthetic",providerLoginInvoked:false}));
} finally { if(started) docker(["rm","-f",container]); await rm(scratch,{recursive:true,force:true}); }
