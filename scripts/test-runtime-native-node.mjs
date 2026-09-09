// Disposable PostgreSQL and actual native provider orchestration. Physical VM,
// protected host evidence and guest execution are explicit fixtures. No hosted
// endpoints, credentials, model calls, guest binaries or production mutations.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";

if (process.argv.length !== 2) throw new Error("Usage: node scripts/test-runtime-native-node.mjs");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const container = `qorpera-native-node-${randomBytes(6).toString("hex")}`;
const psql = ["exec", "-i", container, "psql", "-X", "-qAt", "-U", "postgres", "-d", "native", "-v", "ON_ERROR_STOP=1"];
const scratch = await mkdtemp(join(tmpdir(), "native-node-proof-"));
const read = path => readFileSync(join(root,path),"utf8");
const quoted = value => `'${String(value).replaceAll("'","''")}'`;
const literal = value => `${quoted(JSON.stringify(value))}::jsonb`;
const service = `set request.jwt.claims='{"role":"service_role"}'; set role service_role;`;
const nodeId = "36000000-0000-4000-8000-000000000010", orchestratorId = "30000000-0000-4000-8000-000000000092";
const host = {machineIdSha256:"c".repeat(64),cpuMillis:16000,memoryBytes:64*1024**3};
function docker(args,input) {
	const result = spawnSync("docker",args,{input,encoding:"utf8",timeout:60000,maxBuffer:16*1024*1024});
	assert(!result.error && result.status === 0,`${result.stderr}\n${result.stdout?.slice(-2000) ?? ""}\n${result.error ?? ""}`);
	return result.stdout.trim();
}
const sql = statement => docker(psql,statement);
async function ready() {
	let consecutive = 0;
	for(let attempt=0;attempt<60 && consecutive<2;attempt++) {
		const result=spawnSync("docker",["exec",container,"pg_isready","-U","postgres","-d","native"],{timeout:2000});
		consecutive=result.status===0 ? consecutive+1 : 0;
		if(consecutive<2) await new Promise(resolve=>setTimeout(resolve,250));
	}
	assert.equal(consecutive,2);
}
let started=false;
try {
	await build({entryPoints:{provider:join(root,"packages/runner-orchestrator/src/lxd-provider.ts"),
		policy:join(root,"packages/runner-orchestrator/src/lxd-native-node-policy.ts"),
		control:join(root,"packages/runner-orchestrator/src/orchestrator.ts")},
		outdir:scratch,bundle:true,platform:"node",format:"esm",target:"node22",packages:"external",
		plugins:[{name:"explicit-fixture-host",setup(builder){
			builder.onResolve({filter:/^\.\/runtime-node-host\.ts$/},()=>({path:"host",namespace:"fixture-host"}));
			builder.onLoad({filter:/.*/,namespace:"fixture-host"},()=>({contents:`export async function readRuntimeNodeHost(signal) { signal.throwIfAborted(); return ${JSON.stringify(host)}; }`,loader:"js"}));
		}}]});
	const {LxdCloudRunnerProviderBackend}=await import(pathToFileURL(join(scratch,"provider.js")));
	const {lxdNativeNodePolicy}=await import(pathToFileURL(join(scratch,"policy.js")));
	const {SupabaseCloudRunnerOrchestratorControlPlane}=await import(pathToFileURL(join(scratch,"control.js")));
	docker(["run","-d","--rm","--name",container,"--network","none","-e","POSTGRES_PASSWORD=disposable-native","-e","POSTGRES_DB=native",POSTGRES_IMAGE]);started=true;
	await ready();sql(read("supabase/tests/bootstrap.sql"));
	const migrations=sortMigrationNames(readdirSync(join(root,"supabase/migrations")));
	for(const name of migrations) sql(read(`supabase/migrations/${name}`));
	sql(read("supabase/tests/fixtures/runtime-node-inventory-observer.sql"));
	const foundation=read("supabase/tests/300_runtime_wake_bus.test.sql").split("do $$\ndeclare v_claim jsonb; v_runner jsonb; v_assignment jsonb; v_lease jsonb;");
	assert.equal(foundation.length,2);
	// Use the existing real member prompt, sponsor, company objects and queued
	// job. Provision the runner through the provider under test, not fixture SQL.
	sql(`${foundation[0].replace("'Path fixture','process'","'Path fixture','lxd'")}\ncommit;`);
	const claimControl=new SupabaseCloudRunnerOrchestratorControlPlane("https://fixture.invalid","fixture-key",orchestratorId,"t".repeat(43),async (_url,init)=>{
		const body=JSON.parse(String(init.body));assert.equal(body.action,"claim");
		return Response.json({value:JSON.parse(sql(`${service} select public.qorpera_claim_runner_job_for_orchestrator(${quoted(body.orchestratorId)},${quoted(body.clientClaimId)},${body.leaseSeconds});`))});
	});
	const claim=await claimControl.claimNext(orchestratorId,randomUUID(),900);assert(claim);
	const ca=read("deploy/cloud-secret-broker/supabase-prod-ca-2021.crt");
	const config={adapterId:"lxd",supabaseUrl:"https://fixture.invalid",supabaseServiceKey:"fixture-service",supabasePublishableKey:"fixture-key",
		stateRoot:join(scratch,"state"),project:"qorpera-runners",jobProfile:"qorpera-job-v1",networkInterface:"enp5s0",imageServer:"https://images.invalid/",
		imageFingerprint:"a".repeat(64),storagePool:"qorpera-vm",identityVolumePrefix:"identity-",identityVolumeSize:"32GiB",rootDiskSize:"64GiB",
		cpuLimit:4,memoryLimit:"8GiB",guestAssignmentPort:8082,guestAssignmentSource:"10.41.0.1",nativeBridgePort:8083,nativeExecutionGid:42041,
		guestReadyTimeoutMs:10000,runnerImage:`registry.invalid/qorpera@sha256:${"b".repeat(64)}`,runnerPodmanPath:"/usr/bin/podman",
		runnerEntrypoint:"/opt/qorpera/run-job",runnerVersion:"fixture",codexPath:"/usr/local/bin/codex",claudePath:"/usr/local/bin/claude",
		nativeCompanyRuntime:{mode:"company-path-v1",codexPath:"/opt/qorpera-harnesses/native-company/codex",binarySha256:"a".repeat(64),
			objectGatewayUrl:"https://objects.invalid",objectGatewayToken:"q".repeat(43),network:"qorpera0",recoveryVolumePrefix:"native-recovery-",recoveryVolumeSize:"1GiB",
			secretBroker:{origin:"https://secrets.invalid",runtimeToken:"s".repeat(43),caCertificate:ca,caSha256:createHash("sha256").update(ca).digest("hex")}}};
	const {policy,policySha256}=lxdNativeNodePolicy(config,host.machineIdSha256);
	const nodePolicy={schema:"qorpera.runtime-node-policy/v1",nodeId,machineIdSha256:host.machineIdSha256,label:"native-node-fixture",
		cpuMillis:6000,memoryBytes:16*1024**3,headroomCpuMillis:2000,headroomMemoryBytes:1024**3,standardCpuMillis:4000,standardMemoryBytes:8*1024**3,enabled:true};
	const observe=state=>sql(`${service} select public.qorpera_test_observe_runtime_node(${literal({schema:"qorpera.runtime-node-observation/v1",nodeId,
		machineIdSha256:host.machineIdSha256,observationId:randomUUID(),observedAt:new Date().toISOString(),cpuMillis:host.cpuMillis,memoryBytes:host.memoryBytes,state})});`);
	const capacity=()=>JSON.parse(sql(`${service} select public.qorpera_runtime_node_capacity(${quoted(nodeId)});`));
	let loseNode=false,loseRelease=false,nodeCalls=0,companyCalls=0;
	const signatures={qorpera_provision_execution_runner:["p_run_id","p_client_runner_id","p_provider_adapter","p_activation_token_sha256"],
		qorpera_reserve_runtime_machine:["p_allocation_id","p_provider_adapter","p_instance_sha256","p_run_id","p_runner_id"],
		qorpera_reserve_runtime_node_machine:["p_allocation_id","p_provider_kind","p_provider_id","p_policy_sha256","p_instance_sha256","p_machine_id_sha256","p_cpu_millis","p_memory_bytes"],
		qorpera_release_runtime_machine:["p_allocation_id","p_provider_adapter","p_instance_sha256"]};
	const fetcher=async (input,init)=>{
		init.signal?.throwIfAborted();
		const url=new URL(String(input));assert.equal(url.origin,"https://fixture.invalid");assert.equal(init.redirect,"error");
		const name=url.pathname.slice("/rest/v1/rpc/".length),args=JSON.parse(String(init.body)),keys=signatures[name];assert(keys);
		assert.deepEqual(Object.keys(args).sort(),[...keys].sort());
		const result=JSON.parse(sql(`${service} select public.${name}(${keys.map(key=>quoted(args[key])).join(",")});`));
		if(name==="qorpera_reserve_runtime_machine") companyCalls++;
		if(name==="qorpera_reserve_runtime_node_machine") {nodeCalls++;if(loseNode && result.state==="reserved"){loseNode=false;throw new Error("lost committed node admission");}}
		if(name==="qorpera_release_runtime_machine" && loseRelease){loseRelease=false;throw new Error("lost committed release");}
		return Response.json(result);
	};
	let instance,creates=0,starts=0,deletes=0;
	const volumes=new Map();
	const lxd={
		async getInstance(){return instance ? structuredClone(instance) : undefined;},
		async getStorageVolume(_project,_pool,name){return volumes.get(name);},
		async createStorageVolume(_project,_pool,request){volumes.set(request.name,{name:request.name,type:request.type,contentType:request.content_type,description:request.description,config:request.config});},
		async createInstance(_project,request,_caller,dispatch){dispatch.throwIfAborted();creates++;
			instance={...structuredClone(request),status:"Stopped",statusCode:102,expandedDevices:structuredClone(request.devices),expandedConfig:structuredClone(request.config)};
			observe("unavailable");},
		async setInstancePower(_project,_name,action,_caller,dispatch){if(action==="start"){dispatch.throwIfAborted();starts++;}instance.status=action==="start"?"Running":"Stopped";instance.statusCode=action==="start"?103:102;},
		async pushInstanceFile(){},async execInstance(){},async deleteInstance(){deletes++;instance=undefined;},
	};
	const guest={async waitReady(){return "10.41.0.2";},async deliver(){throw new Error("fixture never invokes native model");}};
	const backend=()=>new LxdCloudRunnerProviderBackend(config,lxd,guest,fetcher);
	const acquire=current=>current.acquire(claim.work.runId,claim.work,new AbortController().signal);
	await assert.rejects(acquire(backend()),/NODE_PROVIDER_UNCONFIGURED/);assert.equal(creates,0);assert.equal(volumes.size,0);
	sql(`${service} select public.qorpera_configure_runtime_node(${literal(nodePolicy)},0);
	 select public.qorpera_enroll_runtime_node_provider(${quoted(nodeId)},${quoted(host.machineIdSha256)},'native','lxd',${quoted(policySha256)},${policy.cpuMillis},${policy.memoryBytes});`);
	await assert.rejects(acquire(backend()),/NODE_OBSERVATION_UNAVAILABLE/);assert.equal(creates,0);assert.equal(volumes.size,0);
	observe("ready");loseNode=true;
	await assert.rejects(acquire(backend()),/lost committed node admission/);assert.equal(creates,0);
	const occupied=sql("select to_jsonb(d) from public.qorpera_runtime_node_demands d;");assert.equal(JSON.parse(occupied).cpu_millis,4000);
	assert(JSON.parse(occupied).reserved_at);assert.equal(JSON.parse(occupied).released_at,null);
	await assert.rejects(acquire(backend()),/NODE_OBSERVATION_UNAVAILABLE/);assert.equal(creates,1);assert.equal(starts,0);
	const allocationId=sql("select id from public.qorpera_runtime_machine_allocations;");
	const journalPath=join(config.stateRoot,allocationId,"journal.json"),before=JSON.parse(await readFile(journalPath,"utf8"));
	assert.equal(before.physicalState,"creating");assert.equal(before.nodeCapacity.policySha256,policySha256);
	observe("ready");const runner=await acquire(backend());assert.equal(creates,1);assert.equal(starts,1);
	assert.equal(sql("select count(*) from public.qorpera_runtime_machine_allocations;"),"1");
	assert.equal(sql("select count(*) from public.qorpera_runtime_node_demands where reserved_at is not null and released_at is null;"),"1");
	const retained=sql("select to_jsonb(d) from public.qorpera_runtime_node_demands d;");docker(["restart",container]);await ready();
	assert.equal(sql("select to_jsonb(d) from public.qorpera_runtime_node_demands d;"),retained);
	assert.deepEqual(JSON.parse(await readFile(journalPath,"utf8")).nodeCapacity,before.nodeCapacity);
	const runningCapacity=capacity();
	sql(`${service} select public.qorpera_configure_runtime_node(${literal({...nodePolicy,enabled:false})},1);`);
	loseRelease=true;await assert.rejects(backend().stop(runner,"idle"),/lost committed release/);assert.equal(instance,undefined);assert.equal(deletes,1);
	await backend().reconcile();assert.equal(deletes,1);
	assert.equal(sql("select count(*) from public.qorpera_runtime_node_demands d join public.qorpera_runtime_machine_allocations a on a.id=d.allocation_id where a.released_at is not null and d.released_at=a.released_at;"),"1");
	assert.equal(volumes.size,2,"identity and recovery disks survive physical VM deletion");
	assert.equal(companyCalls,nodeCalls,"every native node attempt follows the company gate");
	console.log(JSON.stringify({schema:"qorpera.native-node-admission-sql-proof/v1",migrations:migrations.length,nodeCalls,companyCalls,creates,starts,deletes,
		unconfiguredRefused:true,staleRefused:true,lostCommitRetained:true,preStartRefusalRetryable:true,databaseRestartPreserved:true,exactReleaseConfirmed:true,
		identityVolumeRetained:true,recoveryVolumeRetained:true,runtimeMode:"company-path-v1",physicalHostAndVm:"synthetic",nativeModelInvoked:false,runningCapacity}));
} finally {
	if(started) docker(["rm","-f",container]);
	await rm(scratch,{recursive:true,force:true});
}
