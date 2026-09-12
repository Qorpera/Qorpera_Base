// Actual inventory reader and publisher against Unix HTTP + disposable real
// PostgreSQL. LXD responses and protected physical-host evidence are fixtures;
// no real daemon, guest, hosted service or account is contacted.
import assert from "node:assert/strict";
import { testRuntimeComputerLifecycle } from "./test-runtime-computer-lifecycle-cases.mjs";
import { testRuntimeNodeComputers } from "./test-runtime-node-computers-cases.mjs";
import { testRuntimeNodeHealth } from "./test-runtime-node-health-cases.mjs";
import { testRuntimeHostInventory } from "./test-runtime-host-inventory-cases.mjs";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { readFileSync,readdirSync } from "node:fs";
import { mkdtemp,realpath,rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname,join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { POSTGRES_IMAGE,sortMigrationNames } from "./test-hosted-db.mjs";

if(process.argv.length!==2)throw new Error("Usage: node scripts/test-runtime-node-inventory.mjs");
const root=dirname(dirname(fileURLToPath(import.meta.url))),scratch=await realpath(await mkdtemp(join(tmpdir(),"node-inventory-")));
const container=`qorpera-inventory-${randomBytes(6).toString("hex")}`,nodeId="36000000-0000-4000-8000-000000000010";
const psql=["exec","-i",container,"psql","-X","-qAt","-U","postgres","-d","inventory","-v","ON_ERROR_STOP=1"];
const read=path=>readFileSync(join(root,path),"utf8"),quote=v=>`'${String(v).replaceAll("'","''")}'`,literal=v=>`${quote(JSON.stringify(v))}::jsonb`;
const service=`set request.jwt.claims='{"role":"service_role"}'; set role service_role;`;
function docker(args,input){const r=spawnSync("docker",args,{input,encoding:"utf8",timeout:60000,maxBuffer:16*1024*1024});assert(!r.error&&r.status===0,`${r.stderr}\n${r.stdout?.slice(-3000)??""}\n${r.error??""}`);return r.stdout.trim();}
const sql=s=>docker(psql,s),rpc=(name,args)=>JSON.parse(sql(`${service} select public.${name}(${args.join(",")});`));
async function ready(){let count=0;for(let n=0;n<60&&count<2;n++){const r=spawnSync("docker",["exec",container,"pg_isready","-h","127.0.0.1","-U","postgres","-d","inventory"],{timeout:2000});count=r.status===0?count+1:0;if(count<2)await new Promise(r=>setTimeout(r,250));}assert.equal(count,2);}
let started=false,server;
try {
	await build({entryPoints:{observer:join(root,"packages/runner-orchestrator/src/runtime-node-observer.ts"),inventory:join(root,"packages/runner-orchestrator/src/runtime-node-inventory.ts"),lxd:join(root,"packages/runner-orchestrator/src/lxd-client.ts"),health:join(root,"packages/runner-orchestrator/src/runtime-node-health.ts"),digest:join(root,"packages/runner-orchestrator/src/lxd-office-image-provenance.ts")},outdir:scratch,bundle:true,platform:"node",format:"cjs",outExtension:{".js":".cjs"},target:"node22"});
	const require=createRequire(import.meta.url),{RuntimeNodeInventoryObserver}=require(join(scratch,"observer.cjs")),{runtimeNodeInstanceConfigurationSha256}=require(join(scratch,"inventory.cjs")),{LxdUnixClient}=require(join(scratch,"lxd.cjs"));
	docker(["run","-d","--rm","--name",container,"--network","none","-e","POSTGRES_PASSWORD=disposable-inventory","-e","POSTGRES_DB=inventory",POSTGRES_IMAGE]);started=true;await ready();sql(read("supabase/tests/bootstrap.sql"));
	const migrations=sortMigrationNames(readdirSync(join(root,"supabase/migrations")));for(const name of migrations)sql(read(`supabase/migrations/${name}`));
	const wake=read("supabase/tests/300_runtime_wake_bus.test.sql").split("-- END WAKE FIXTURE"),office=read("supabase/tests/fixtures/runtime-office-registry-cases.sql").split("set local role service_role;\nselect set_config('qorpera_test.office_lease'");
	assert.equal(wake.length,2);assert.equal(office.length,2);sql(`${wake[0]}\n${office[0]}\n${read("supabase/tests/fixtures/runtime-node-capacity-setup.sql")}\ncommit;`);
	const native=JSON.parse(sql(`select jsonb_build_object('id',id,'provider',provider_adapter,'instance',instance_sha256) from public.qorpera_runtime_machine_allocations where runner_id is not null;`));
	const reserve=()=>rpc("qorpera_reserve_runtime_node_machine",[quote(native.id),"'native'",quote(native.provider),quote("f".repeat(64)),quote(native.instance),quote("c".repeat(64)),"3000","2147483648"]);
	const capacity=()=>rpc("qorpera_runtime_node_capacity",[quote(nodeId)]);
	const observation=()=>({schema:"qorpera.runtime-node-observation/v1",nodeId,machineIdSha256:"c".repeat(64),observationId:randomUUID(),observedAt:new Date().toISOString(),cpuMillis:6000,memoryBytes:8589934592,state:"ready"});
	const bare=observation();rpc("qorpera_observe_runtime_node",[literal(bare)]);assert.equal(reserve().reason,"NODE_OBSERVATION_UNAVAILABLE");assert.equal(capacity().admissibleSlots,0);
	const hostView=testRuntimeHostInventory({nodeId,sql,rpc,quote});
	const certificate=read("deploy/cloud-secret-broker/supabase-prod-ca-2021.crt"),certificateSha256=new X509Certificate(certificate).fingerprint256.replaceAll(":","").toLowerCase();
	const config={"limits.cpu":"1","limits.memory":"512MiB","volatile.uuid":randomUUID(),"cloud-init.user-data":"PRIVATE-INFRASTRUCTURE-CREDENTIAL","user.qorpera.management_vm":"fixture-management-marker"};
	const management={name:"management",project:"default",location:"none",type:"virtual-machine",status:"Running",statusCode:103,config,expandedConfig:{...config},profiles:[],devices:{},expandedDevices:{}};
	let instances=[management],broken=false,afterContext,losePublication=false,lastPublication;
	const socket=join(scratch,"lxd.socket"),httpCalls=[];
	server=createServer((req,res)=>{httpCalls.push(`${req.method} ${req.url}`);let metadata;
		if(req.url==="/1.0?project=default")metadata={auth:"trusted",auth_user_method:"unix",api_version:"1.0",api_status:"stable",public:false,api_extensions:["instance_all_projects"],environment:{server:"lxd",kernel:"Linux",server_clustered:false,project:"default",driver:"lxc | qemu",instance_types:["container","virtual-machine"],certificate,certificate_fingerprint:certificateSha256,server_name:"fixture-node",server_version:"6.9",kernel_architecture:"x86_64"}};
		else if(req.url==="/1.0/instances?all-projects=true&recursion=0")metadata=instances.map(i=>`/1.0/instances/${i.name}?project=${i.project}`);
		else if(req.url==="/1.0/instances?all-projects=true&recursion=1")metadata=instances.map(i=>({name:i.name,project:i.project,location:i.location,type:i.type,status:i.status,status_code:i.statusCode,config:i.config,expanded_config:i.expandedConfig,devices:i.devices,expanded_devices:i.expandedDevices,profiles:i.profiles}));
		else {res.writeHead(404);res.end();return;}
		res.writeHead(broken?500:200,{"content-type":"application/json"});res.end(JSON.stringify({type:"sync",status_code:200,metadata}));});
	await new Promise(resolve=>server.listen(socket,resolve));
	const policy={schema:"qorpera.runtime-node-inventory-policy/v1",nodeId,host:{machineIdSha256:"c".repeat(64),socketPath:socket,socketGid:2000,certificateSha256,serverName:"fixture-node",serverVersion:"6.9",architecture:"x86_64"},operatingCpuMillis:1000,operatingMemoryBytes:512*1024**2,
		infrastructure:[{project:management.project,name:management.name,physicalId:config["volatile.uuid"],type:management.type,configurationSha256:runtimeNodeInstanceConfigurationSha256(management),cpuMillis:1000,memoryBytes:512*1024**2}]};
	rpc("qorpera_enroll_runtime_node_inventory",[literal(policy)]);
	const host={machineIdSha256:"c".repeat(64),cpuMillis:6000,memoryBytes:8589934592,bootId:randomUUID(),namespace:"mnt:[fixture]",socket:{dev:1,ino:2,uid:0,gid:2000,mode:0o140660,nlink:1}};
	const keys={qorpera_runtime_node_inventory_context:["p_node_id"],qorpera_observe_runtime_node:["p_observation"],qorpera_observe_runtime_node_inventory:["p_observation","p_context_sha256","p_inventory"]};
	const registry={async call(method,args,signal){signal.throwIfAborted();assert.deepEqual(Object.keys(args).sort(),[...keys[method]].sort());
		const result=rpc(method,keys[method].map(k=>typeof args[k]==="object"?literal(args[k]):quote(args[k])));
		if(method==="qorpera_runtime_node_inventory_context"&&afterContext){const run=afterContext;afterContext=undefined;run();}
		if(method==="qorpera_observe_runtime_node_inventory"){lastPublication=structuredClone(args);if(losePublication){losePublication=false;throw new Error("lost committed inventory reply");}}
		return result;}};
	const observer=new RuntimeNodeInventoryObserver(policy,registry,{lxd:new LxdUnixClient(socket),host:async()=>structuredClone(host)});
	const observe=()=>observer.observe(new AbortController().signal);
	assert.equal((await observe()).state,"ready");assert.equal(capacity().admissibleSlots,2);
	hostView.assertReady(1);
	const context=rpc("qorpera_runtime_node_inventory_context",[quote(nodeId)]),empty={schema:"qorpera.runtime-node-inventory/v1",bootId:host.bootId,entries:[]};
	assert.throws(()=>rpc("qorpera_observe_runtime_node_inventory",[literal(bare),quote(context.contextSha256),literal(empty)]),/no inventory authority/);
	// Reserve after the observer's context read. Publication must fail on the
	// actual changed ledger, even though the complete physical scan is stable.
	afterContext=()=>assert.equal(reserve().state,"reserved");await assert.rejects(observe(),/UNCONFIRMED/);
	assert.equal((await observe()).state,"ready");assert.equal(capacity().allocatedCpuMillis,3000);assert.equal(capacity().allocatedComputers,1);
	let allocation=rpc("qorpera_runtime_node_inventory_context",[quote(nodeId)]).allocations[0];
	const nativeConfig={"limits.cpu":"3","limits.memory":"2GiB","volatile.uuid":randomUUID(),"user.qorpera.schema":"qorpera.native-job-vm/v1","user.qorpera.acquisition_id":allocation.allocationId,"user.qorpera.provider_adapter":allocation.providerId,"user.qorpera.provider_policy_sha256":allocation.policySha256,"user.qorpera.instance_sha256":allocation.instanceSha256};
	const vm={...structuredClone(management),name:"native-job",project:"company-a",config:nativeConfig,expandedConfig:{...nativeConfig}};instances.push(vm);
	assert.equal((await observe()).state,"ready");allocation=rpc("qorpera_runtime_node_inventory_context",[quote(nodeId)]).allocations[0];assert.equal(allocation.physical.physicalId,nativeConfig["volatile.uuid"]);
	hostView.assertManaged(native.id);
	const historyUntil=new Date().toISOString(),historyFrom=new Date(Date.now()-60000).toISOString();
	const runningHistory=rpc("qorpera_runtime_computer_history",[quote(native.id),quote(historyFrom),quote(historyUntil)]);
	assert.equal(runningHistory.placement.physical.physicalId,nativeConfig["volatile.uuid"]);assert.equal(runningHistory.intervals.at(-1).state,"running");assert.equal(runningHistory.screenUsage,null);
	assert.equal(runningHistory.profileId,sql(`select profile_id from public.qorpera_runtime_machine_allocations where id=${quote(native.id)};`));
	const computerView=testRuntimeNodeComputers({nodeId,allocationId:native.id,sql,rpc,quote});
		vm.status="Stopped";vm.statusCode=102;assert.equal((await observe()).state,"ready",JSON.stringify(lastPublication?.p_inventory));assert.equal(capacity().allocatedCpuMillis,3000);
	computerView.assertPhysical('suspended');
	const originalUUID=vm.config["volatile.uuid"];vm.config["volatile.uuid"]=vm.expandedConfig["volatile.uuid"]=randomUUID();
	assert.equal((await observe()).state,"unavailable");assert.equal(reserve().reason,"NODE_OBSERVATION_UNAVAILABLE");
	computerView.assertPhysical('unknown','NODE_UNAVAILABLE');
	hostView.assertSubstituted();
	vm.config["volatile.uuid"]=vm.expandedConfig["volatile.uuid"]=originalUUID;
	const unregistered={...structuredClone(management),project:"legacy",name:"stopped-unmanaged",type:"container",status:"Stopped",statusCode:102};unregistered.config["volatile.uuid"]=unregistered.expandedConfig["volatile.uuid"]=randomUUID();instances.push(unregistered);
	assert.equal((await observe()).state,"unavailable");assert.equal(lastPublication.p_inventory.entries.length,3);assert.equal(capacity().admissibleSlots,0);
	hostView.assertUnmanaged();
	instances.pop();assert.equal((await observe()).state,"ready");
	vm.expandedDevices.extra={type:"disk",source:"/unexpected"};assert.equal((await observe()).state,"unavailable");delete vm.expandedDevices.extra;
	management.expandedConfig["limits.cpu"]="2";assert.equal((await observe()).state,"unavailable");management.expandedConfig["limits.cpu"]="1";
	assert.equal((await observe()).state,"ready");const exact=structuredClone(lastPublication);
	assert.equal(JSON.stringify(exact).includes("PRIVATE-INFRASTRUCTURE-CREDENTIAL"),false);
	losePublication=true;await assert.rejects(observe(),/UNCONFIRMED/);assert.equal(capacity().state,"eligible");
	const latest=capacity().observedAt;
	rpc("qorpera_observe_runtime_node_inventory",[literal(exact.p_observation),quote(exact.p_context_sha256),literal(exact.p_inventory)]);assert.equal(capacity().observedAt,latest);
	assert.throws(()=>rpc("qorpera_observe_runtime_node_inventory",[literal(exact.p_observation),quote(exact.p_context_sha256),literal({...exact.p_inventory,bootId:randomUUID()})]),/identity changed/);
	broken=true;assert.equal((await observe()).state,"unavailable");assert.equal(reserve().reason,"NODE_OBSERVATION_UNAVAILABLE");hostView.assertUnavailable();broken=false;
	instances=[management];assert.equal((await observe()).state,"ready");assert.equal(capacity().allocatedComputers,1,"absence never releases an allocation");
	computerView.assertPhysical('unknown','INSTANCE_NOT_OBSERVED');
	rpc("qorpera_release_runtime_machine",[quote(native.id),quote(native.provider),quote(native.instance)]);assert.equal(capacity().allocatedComputers,0);
	computerView.assertReleased();
	const receipts=sql("select jsonb_agg(to_jsonb(r) order by observation_id) from public.qorpera_runtime_node_inventory_receipts r;"),binding=sql("select binding from public.qorpera_runtime_node_instance_bindings;");
	const retainedHistory=rpc("qorpera_runtime_computer_history",[quote(native.id),quote(historyFrom),quote(historyUntil)]);
	const retainedHost=hostView.assertHistorical();
	docker(["restart",container]);await ready();assert.equal(sql("select jsonb_agg(to_jsonb(r) order by observation_id) from public.qorpera_runtime_node_inventory_receipts r;"),receipts);assert.equal(sql("select binding from public.qorpera_runtime_node_instance_bindings;"),binding);
	assert.deepEqual(rpc("qorpera_runtime_computer_history",[quote(native.id),quote(historyFrom),quote(historyUntil)]),retainedHistory);
	const restartedHost=hostView.assertHistorical();delete retainedHost.asOf;delete restartedHost.asOf;assert.deepEqual(restartedHost,retainedHost);
	computerView.assertReleased();
	assert.equal((await observe()).state,"ready");
	await testRuntimeNodeHealth({nodeId,sql,psql,service,literal,quote,restartDatabase:async()=>{docker(["restart",container]);await ready();},
		read,officeDigest:require(join(scratch,'digest.cjs')).officeDigest,parsePolicy:require(join(scratch,'inventory.cjs')).parseRuntimeNodeInventoryPolicy,
		RuntimeNodeHealthPublisher:require(join(scratch,'health.cjs')).RuntimeNodeHealthPublisher});
	sql(read("supabase/tests/fixtures/runtime-computer-history-cases.sql"));
	await testRuntimeComputerLifecycle({allocationId:native.id,service:"set request.jwt.claims='{\"role\":\"service_role\"}'; set role service_role;",literal,execute:sql,
		restartDatabase:async()=>{docker(["restart",container]);await ready();},kind:'native',released:true});
	for(const role of ["anon","authenticated","service_role","qorpera_secret_broker"]){for(const table of ["inventory_policies","inventory_receipts","instance_bindings"])assert.equal(sql(`select has_table_privilege(${quote(role)},'public.qorpera_runtime_node_${table}','SELECT,INSERT,UPDATE,DELETE');`),"f");}
	for(const role of ["anon","authenticated","qorpera_secret_broker"])assert.equal(sql(`select count(*) from pg_proc where pronamespace='public'::regnamespace and proname in ('qorpera_enroll_runtime_node_inventory','qorpera_runtime_node_inventory_context','qorpera_observe_runtime_node_inventory','qorpera_runtime_node_inventory_ready') and has_function_privilege(${quote(role)},oid,'EXECUTE');`),"0");
	assert(httpCalls.length>60 && httpCalls.every(c=>c.startsWith("GET ")));
	console.log('HOST_INVENTORY_SQL_PROOF='+JSON.stringify({schema:'qorpera.runtime-host-inventory-proof/v1',migrations:migrations.length,actualSql:true,actualInventoryPublisher:true,actualUnixReader:true,
	 physicalHostAndDaemon:'fixtures',managedAndInfrastructure:true,unmanagedVisible:true,substitutedUnknown:true,missingAndStaleUnknown:true,
	 observationPinnedPages:true,historicalNotCurrent:true,changedPolicyAndHardwareUnknown:true,operatorOnly:true,noRawConfiguration:true,databaseRestart:true}));
	console.log('NODE_COMPUTERS_SQL_PROOF='+JSON.stringify({schema:'qorpera.runtime-node-computers-proof/v1',actualSql:true,actualInventoryPublisher:true,
		physicalMeasurements:'fixture',runningActiveJob:true,runningWithoutRecordedJobsStillCharged:true,expiredJobUnknown:true,sharedScreenJobLink:true,
		pendingDrainUnknown:true,stalePhysicalStateUnknown:true,pendingCapacityReason:true,pagination:true,suspendedStillCharged:true,
		absentStillCharged:true,confirmedReleaseRemovesLiveAllocation:true,releaseSurvivesRestart:true,operatorOnly:true,missingHealthAndActivityExplicit:true}));
	console.log(JSON.stringify({schema:"qorpera.runtime-node-inventory-proof/v1",migrations:migrations.length,actualPublisher:true,actualUnixHttp:true,actualSql:true,physicalHost:"fixture",lxd:"fixture",hardwareOnlyBlocked:true,changedLedgerRejected:true,immutablePhysicalBinding:true,stoppedAndAbsentCharged:true,unmanagedBlocksAdmission:true,headroomInfrastructure:true,historySurvivesRestart:true,computerUsageWindows:true,unknownUsageExplicit:true,usageHistorySurvivesRestart:true,httpReads:httpCalls.length}));
} finally {
	if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
	if(started)spawnSync("docker",["rm","-f",container],{timeout:15000});
	await rm(scratch,{recursive:true,force:true});
}
