// Real PostgreSQL lock/receipt tests in a disposable network-isolated database.
// Physical digests, root helpers and systemd are synthetic; selected modes exercise actual provider workers and SQL.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";
import { testOfficeAdoptionAuthority } from "./test-runtime-office-adoption-cases.mjs";
import { testOfficeActivation } from "./test-runtime-office-activation-cases.mjs";
import { testRuntimeScreenLifecycle } from "./test-runtime-screen-lifecycle-cases.mjs";
import { testRuntimeComputerLifecycle } from "./test-runtime-computer-lifecycle-cases.mjs";
import { prepareScreenObservationRecovery } from "./test-runtime-screen-observation-recovery-cases.mjs";
import { testOfficeLifecycleRevocation } from "./test-runtime-office-lifecycle-cases.mjs";
import { testOfficeStopAcknowledgement } from "./test-runtime-office-stop-cases.mjs";
import { testOfficeSuccessorAdmission } from "./test-runtime-office-successor-cases.mjs";
import { prepareOfficeWake, renewOfficeWakeBinding, testOfficeWake } from "./test-runtime-office-wake-cases.mjs";
import { openOfficeSystemdGuest } from "./fixtures/office-systemd-guest-host.mjs";
import { testOfficeBootSystemd } from "./test-runtime-office-boot-systemd-cases.mjs";

const bootSystemdMode = process.argv.length === 3 && process.argv[2] === "--boot-successor-systemd";
const systemdMode = process.argv.length === 3 && process.argv[2] === "--successor-systemd";
const vmCyclesMode = process.argv.length === 3 && process.argv[2] === "--vm-cycles";
const resumeMode = vmCyclesMode || (process.argv.length === 3 && process.argv[2] === "--resume-worker");
const powerOffMode = resumeMode || (process.argv.length === 3 && process.argv[2] === "--power-off-worker");
const successorWorkerMode = systemdMode || (process.argv.length === 3 && process.argv[2] === "--successor-worker");
const stopWorkerMode = powerOffMode || successorWorkerMode || (process.argv.length === 3 && process.argv[2] === "--stop-worker");
const lifecycleMode = stopWorkerMode || (process.argv.length === 3 && process.argv[2] === "--lifecycle");
const activationWorkerMode = lifecycleMode || (process.argv.length === 3 && process.argv[2] === "--activation-worker");
const configurationMode = activationWorkerMode || (process.argv.length === 3 && process.argv[2] === "--configuration-worker");
const wakeMode = process.argv.length === 3 && process.argv[2] === "--activation-wake";
const successorMode = process.argv.length === 3 && process.argv[2] === "--successor-admission";
const bootSuccessorMode = process.argv.length === 3 && process.argv[2] === "--boot-successor-admission";
const stopMode = bootSuccessorMode || successorMode || (process.argv.length === 3 && process.argv[2] === "--lifecycle-stop");
const lifecycleRevocationMode = stopMode || (process.argv.length === 3 && process.argv[2] === "--lifecycle-revocation");
const activationMode = wakeMode || lifecycleRevocationMode || (process.argv.length === 3 && process.argv[2] === "--activation");
const preparationMode = configurationMode || (process.argv.length === 3 && process.argv[2] === "--preparation-worker");
const bootMode = preparationMode || (process.argv.length === 3 && process.argv[2] === "--boot-worker");
const creationMode = bootMode || (process.argv.length === 3 && process.argv[2] === "--creation-worker");
if (process.argv.length !== 2 && !creationMode && !activationMode && !bootSystemdMode) throw new Error("Usage: node scripts/test-runtime-office-start.mjs [--creation-worker|--boot-worker|--preparation-worker|--configuration-worker|--activation-worker|--lifecycle|--stop-worker|--power-off-worker|--resume-worker|--vm-cycles|--successor-worker|--successor-systemd|--boot-successor-systemd|--activation|--activation-wake|--lifecycle-revocation|--lifecycle-stop|--successor-admission|--boot-successor-admission]");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const container = `qorpera-office-start-${randomBytes(6).toString("hex")}`;
const psql = ["exec", "-i", container, "psql", "-X", "-qAt", "-U", "postgres", "-d", "office", "-v", "ON_ERROR_STOP=1"];
const children = new Set();
function docker(args, input) {
	const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
	assert(!result.error && result.status === 0, `${result.stderr || String(result.error ?? "Disposable database command failed")}\n${result.stdout?.slice(-2500) ?? ""}`);
	return result.stdout.trim();
}
function session() {
	const child = spawn("docker", psql);
	children.add(child);
	let output = "", error = "";
	child.stdout.on("data", (chunk) => { output += chunk; });
	child.stderr.on("data", (chunk) => { error += chunk; });
	const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
	const done = new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code) => { clearTimeout(timer); children.delete(child); resolve({ code, output: output.trim(), error }); });
	});
	return { child, done, output: () => output };
}
async function until(check) {
	const deadline = Date.now() + 8_000;
	while (!check()) {
		assert(Date.now() < deadline, "SQL barrier timed out");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
async function databaseReady() {
	let consecutive = 0;
	for (let attempt = 0; attempt < 60 && consecutive < 2; attempt++) {
		const result = spawnSync("docker", ["exec", container, "pg_isready", "-U", "postgres", "-d", "office"], { timeout: 2000 });
		consecutive = result.status === 0 ? consecutive + 1 : 0;
		if (consecutive < 2) await new Promise((resolve) => setTimeout(resolve, 500));
	}
	assert.equal(consecutive, 2);
}
async function race(statements) {
	const contenders = statements.map(() => session());
	for (let index = 0; index < contenders.length; index++) contenders[index].child.stdin.end(statements[index]);
	return Promise.all(contenders.map((contender) => contender.done));
}
const sqlText = (value) => `'${value.replaceAll("'", "''")}'`;
const literal = (value) => `${sqlText(JSON.stringify(value))}::jsonb`;
const service = `set request.jwt.claims='{"role":"service_role"}'; set role service_role;`;
const owner = `set request.jwt.claims='{"role":"authenticated","sub":"30000000-0000-4000-8000-000000000001"}'; set role authenticated;`;
let started = false, systemdGuest;
const bundleRoot = await realpath(await mkdtemp(join(tmpdir(), "office-start-control-")));
try {
	if(systemdMode)systemdGuest=await openOfficeSystemdGuest(root,process.env.QORPERA_OFFICE_SYSTEMD_TEST_IMAGE);
	if(bootSystemdMode)systemdGuest=await openOfficeSystemdGuest(root,process.env.QORPERA_OFFICE_SYSTEMD_TEST_IMAGE,{retainedBoot:true});
	await build({ entryPoints: {
		control: join(root, "packages/runner-orchestrator/src/lxd-office-start-control.ts"),
		provider: join(root, "packages/runner-orchestrator/src/lxd-office-provider-control.ts"),
		...(bootSystemdMode ? {
			contracts: join(root,"packages/contracts/src/index.ts"),
			bootData: join(root,"packages/runtime/test/fixtures/company-computer-boot-configuration.ts"),
			stopHistory: join(root,"packages/runner-orchestrator/test/fixtures/office-stop-history.ts"),
			bootIntentControl: join(root,"packages/runner-orchestrator/src/lxd-office-boot-intent-control.ts"),
			bootSuccessorControl: join(root,"packages/runner-orchestrator/src/lxd-office-boot-successor-control.ts"),
			successorControl: join(root,"packages/runner-orchestrator/src/lxd-office-successor-control.ts"),
			stopControl: join(root,"packages/runner-orchestrator/src/lxd-office-stop-control.ts"),
		} : {}),
		...(wakeMode ? {
			wake: join(root, "packages/runtime/src/cloud-wake-bus.ts"),
			native: join(root, "packages/runtime/src/cloud-company-computer-native-client.ts"),
			authority: join(root, "packages/runtime/src/cloud-native-tool-authority.ts"),
			operations: join(root, "packages/runtime/src/cloud-native-tool-operations.ts"),
		} : {}),
		...(lifecycleRevocationMode ? { lifecycleControl: join(root, "packages/runner-orchestrator/src/lxd-office-lifecycle-control.ts") } : {}),
		...(stopMode ? { stopControl: join(root, "packages/runner-orchestrator/src/lxd-office-stop-control.ts") } : {}),
		...(successorMode ? { successorControl: join(root, "packages/runner-orchestrator/src/lxd-office-successor-control.ts") } : {}),
		...(bootSuccessorMode ? { bootSuccessorControl: join(root, "packages/runner-orchestrator/src/lxd-office-boot-successor-control.ts"), bootIntentControl: join(root, "packages/runner-orchestrator/src/lxd-office-boot-intent-control.ts") } : {}),
		...(activationMode ? {
			startup: join(root, "packages/runtime/src/cloud-company-computer-startup.ts"),
			screenLifecycle: join(root, "packages/runtime/src/cloud-company-computer-screen-lifecycle.ts"),
			screenOutbox: join(root, "packages/runtime/src/cloud-company-computer-screen-outbox.ts"),
			activation: join(root, "packages/runner-orchestrator/src/lxd-office-activation-control.ts"),
		} : {}),
        ...(creationMode ? { creation: join(root, "packages/runner-orchestrator/test/fixtures/office-creation-sql-probe.ts") } : {}),
	}, bundle: true, platform: "node", format: "esm", target: "node22", outdir: bundleRoot, outExtension: { ".js": ".mjs" }, logLevel: "silent" });
	const { LxdOfficeStartControl, lxdOfficeProviderBindingSha256 } = await import(pathToFileURL(join(bundleRoot, "control.mjs")).href);
	const { LxdOfficeProviderControl } = await import(pathToFileURL(join(bundleRoot, "provider.mjs")).href);
	docker(["run", "-d", "--rm", "--name", container, "--network", "none", "--pull", "never",
		"-e", "POSTGRES_PASSWORD=disposable-office-only", "-e", "POSTGRES_DB=office", POSTGRES_IMAGE]);
	started = true;
	await databaseReady();
	docker(psql, readFileSync(join(root, "supabase/tests/bootstrap.sql"), "utf8"));
	const migrations = sortMigrationNames(readdirSync(join(root, "supabase/migrations")));
	for (const name of migrations) docker(psql, readFileSync(join(root, "supabase/migrations", name), "utf8"));
	docker(psql, readFileSync(join(root,"supabase/tests/fixtures/runtime-node-inventory-observer.sql"),"utf8"));
	const wake = readFileSync(join(root, "supabase/tests/300_runtime_wake_bus.test.sql"), "utf8").split("-- END WAKE FIXTURE");
	const office = readFileSync(join(root, "supabase/tests/fixtures/runtime-office-registry-cases.sql"), "utf8").split("-- Synthetic guest readiness only.");
	assert.equal(wake.length, 2);
	assert.equal(office.length, 2);
	const setup = JSON.parse(docker(psql, `${wake[0]}\n${office[0]}
		set local role service_role;
		select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress');
		select jsonb_build_object('binding',current_setting('qorpera_test.wake_binding')::jsonb,
			'descriptor',public.qorpera_native_office_start_descriptor(current_setting('qorpera_test.wake_binding')::jsonb),
			'identity',public.qorpera_describe_native_tool_authority(current_setting('qorpera_test.wake_binding')::jsonb)->'identity'); commit;`).split("\n").at(-1));
	assert.equal(setup.descriptor.state, "available");
	// The wake fixture binding carries 120-second bounds; keep it live across the phases below.
	const renewWakeBinding = () => renewOfficeWakeBinding({ setup, service, execute: (sql) => docker(psql, sql) });
	renewWakeBinding();
	const scope = setup.descriptor.scope;
	const providers = [randomUUID(), randomUUID()];
    const creation = creationMode ? await import(pathToFileURL(join(bundleRoot, "creation.mjs")).href) : null;
    const creationPolicies = creation ? new Map(providers.map((providerId) => [providerId, creation.officeCreationSqlPolicy(scope, providerId, bundleRoot)])) : null;
	const enroll = (providerId, version = 0, enabled = true) => `select public.qorpera_set_runtime_office_provider(${literal(scope)},1,'${providerId}','${creationPolicies?.get(providerId).digest ?? 'f'.repeat(64)}',${version},${enabled});`;
	const enrollments = await race(providers.map((providerId) => `${service} ${enroll(providerId)}`));
	assert.equal(enrollments.filter((result) => result.code === 0).length, 1);
	assert.match(enrollments.find((result) => result.code !== 0).error, /Office provider cannot be rebound/);
	const providerId = providers[enrollments.findIndex((result) => result.code === 0)];
	const nodeId=randomUUID();
	if(creationMode){
		const policy=creationPolicies.get(providerId).policy;
		docker(psql,`${service} select public.qorpera_configure_runtime_node(${literal({schema:"qorpera.runtime-node-policy/v1",nodeId,
		 machineIdSha256:policy.host.machineIdSha256,label:"office-sql-fixture",cpuMillis:policy.guest.cpus*1000+1000,
		 memoryBytes:policy.guest.memoryBytes+1073741824,headroomCpuMillis:1000,headroomMemoryBytes:1073741824,
		 standardCpuMillis:policy.guest.cpus*1000,standardMemoryBytes:policy.guest.memoryBytes,enabled:true})},0);
		 select public.qorpera_enroll_runtime_node_provider('${nodeId}','${policy.host.machineIdSha256}','office','${providerId}',
		 '${creationPolicies.get(providerId).digest}',${policy.guest.cpus*1000},${policy.guest.memoryBytes});`);
	}
	let nodeAdmissionCalls=0;
	const observeNode=()=>{
		const policy=creationPolicies.get(providerId).policy;
		// Explicit synthetic host measurements, fresh for each actual SQL gate.
		const observation={schema:"qorpera.runtime-node-observation/v1",nodeId,machineIdSha256:policy.host.machineIdSha256,
		 observationId:randomUUID(),observedAt:new Date().toISOString(),cpuMillis:policy.guest.cpus*1000+1000,
		 memoryBytes:policy.guest.memoryBytes+1073741824,state:"ready"};
		docker(psql,`${service} select public.qorpera_test_observe_runtime_node(${literal(observation)});`);
	};
	// The node demand as each admission finds it. Since 20260923060000 an explicit power-off
	// suspends it (still placed, not counted) and the resume's admission re-admits it.
	const nodeDemand=(allocationId)=>JSON.parse(docker(psql,`select coalesce((select jsonb_build_object('state',case when released_at is not null then 'released'
	 when suspended_at is not null then 'suspended' when reserved_at is not null then 'reserved' else 'pending' end,
	 'nodeId',node_id,'reservedAt',reserved_at,'suspendedAt',suspended_at)
	 from public.qorpera_runtime_node_demands where allocation_id=${sqlText(allocationId)}),'{"state":"none"}');`));
	const nodeAdmissions=[],suspensions=[];
	const nodeCall=(args)=>{
		nodeAdmissionCalls++;
		nodeAdmissions.push(nodeDemand(args.p_allocation_id));
		observeNode();
		return `select public.qorpera_reserve_runtime_node_machine(${[args.p_allocation_id,args.p_provider_kind,args.p_provider_id,
		 args.p_policy_sha256,args.p_instance_sha256,args.p_machine_id_sha256].map(sqlText).join(',')},${args.p_cpu_millis},${args.p_memory_bytes});`;
	};
	console.log("PASS: concurrent infrastructure enrollment assigns one immutable provider host/policy");
	const request = (id) => `select public.qorpera_request_runtime_office_start(${literal(scope)},1,'${id}');`;
	const requests = await race([`${owner} ${request(randomUUID())}`, `${owner} ${request(randomUUID())}`]);
	for (const result of requests) assert.equal(result.code, 0, result.error);
	const intents = requests.map((result) => JSON.parse(result.output));
	assert.deepEqual(intents[0], intents[1]);
	assert.equal(intents[0].state, "requested");
	const intent = intents[0].intentId;
	assert.equal(docker(psql, "select count(*) from public.qorpera_runtime_office_start_intents;"), "1");
	assert.equal(docker(psql, "select count(*) from public.qorpera_runtime_machine_allocations;"), "0");
	console.log("PASS: simultaneous member starts coalesce one durable intent without machine admission");

	// Concurrent deliveries of one real native receipt coalesce with member
	// demand. The ordinary ledger forbids two unresolved receipts in one run.
	// This also exercises
	// job/profile/office lock ordering without a share-to-update lock upgrade.
	const principals = Object.fromEntries(Object.entries(setup.identity).filter(([key]) => !["assignmentId","runnerId","leaseId","sponsorVersion","providerConnectionId","providerConnectionVersion"].includes(key)));
	const nativeCalls = [0].map((index) => {
		const receipt = randomUUID();
		const key = `start-race-${index}`;
		const envelope = JSON.stringify({ schema: "qorpera.cloud-tool-operation/v2", principals, operation: {
			tool: "computer_start", toolVersion: "qorpera.company-computer-tools/v2", logicalOperationKey: key,
			arguments: { kind: "start" }, requiresCompanyRevision: false,
			target: { realm: "company_computer", scope, computerGeneration: 1, resources: setup.descriptor.resources },
		} });
		const digest = createHash("sha256").update(envelope).digest("hex");
		docker(psql, `${service} select public.qorpera_begin_native_tool_operation(${literal(setup.binding)},'${receipt}',
			'computer_start:${key}','${digest}',repeat('d',64),false);`);
		return `${service} select public.qorpera_native_office_start(${literal(setup.binding)},${sqlText(envelope)},'begin','${receipt}',repeat('d',64));`;
	});
	const native = await race([nativeCalls[0], nativeCalls[0], `${owner} ${request(randomUUID())}`]);
	for (const result of native) {
		assert.equal(result.code, 0, result.error);
		assert.deepEqual(JSON.parse(result.output), intents[0]);
	}
	assert.equal(docker(psql, "select count(*) from public.qorpera_runtime_office_start_intents where requested_by_user_id is not null and receipt_id is null;"), "1");
	console.log("PASS: concurrent native receipt deliveries and member requests preserve one intent and original provenance");
	if (wakeMode) await prepareOfficeWake({ setup, intent, service, execute: (sql) => docker(psql, sql), literal });

	const allocations = [randomUUID(), randomUUID()];
	const bindings = allocations.map((allocationId) => ({ schema: "qorpera.lxd-office-guest/v2", ...scope,
		providerId, providerPolicySha256: "f".repeat(64),
		computerGeneration: 1, allocationId, project: "offices", imageFingerprint: "a".repeat(64), bootstrapSha256: "b".repeat(64),
		storagePool: "office-vms", rootDiskBytes: 64 * 1024 ** 3, workbenchSource: "/mnt/disposable-fixture/office",
		network: "office-net", cpus: 2, memoryBytes: 4 * 1024 ** 3 }));
	const bindingDigests = bindings.map(lxdOfficeProviderBindingSha256);
	const sqlCall = (method, args) => {
		if(method==="qorpera_reserve_runtime_node_machine")return nodeCall(args);
		assert(["qorpera_reserve_runtime_office_start", "qorpera_check_runtime_office_start", "qorpera_check_runtime_office_adoption", "qorpera_runtime_office_provider_status"].includes(method));
		if (method === "qorpera_runtime_office_provider_status") return `select public.${method}(${literal(args.p_scope)},
			${args.p_computer_generation},${sqlText(args.p_provider_id)},${sqlText(args.p_provider_policy_sha256)});`;
		const parameters = [literal(args.p_scope), String(args.p_computer_generation), sqlText(args.p_intent_id),
			sqlText(args.p_allocation_id), sqlText(args.p_instance_sha256)];
		if (method === "qorpera_reserve_runtime_office_start") parameters.push(sqlText(args.p_image_sha256), sqlText(args.p_bootstrap_sha256));
		parameters.push(sqlText(args.p_provider_binding_sha256));
		parameters.push(sqlText(args.p_provider_id), sqlText(args.p_provider_policy_sha256));
		if (method === "qorpera_check_runtime_office_adoption") parameters.push(literal(args.p_mappings));
		return `select public.${method}(${parameters.join(",")});`;
	};
    if (creationMode) {
        let activationReplyLost = false, revocationReplyLost = false, stopAckReplyLost = false, successorPrepareLost = false, successorActivateLost = false, bootIntentReplyLost = false, bootSuccessorPrepareLost = false, bootSuccessorActivateLost = false;
        const bootIntentLosses = new Set(), bootPreparationLosses = new Set(), bootActivationLosses = new Set();
        const revocationLosses = new Set(), stopAckLosses = new Set(), successorPreparationLosses = new Set(), successorActivationLosses = new Set();
 const serviceSuccessorRegistry = { call: async (method,args,signal) => {
   signal.throwIfAborted();
   assert(["qorpera_prepare_runtime_office_successor","qorpera_runtime_office_successor_status","qorpera_check_runtime_office_successor","qorpera_activate_runtime_office_successor"].includes(method));
   const params=[literal(args.p_request)]; if(method==="qorpera_activate_runtime_office_successor")params.push(sqlText(args.p_service_invocation_id));
   const value=JSON.parse(docker(psql,`${service} select public.${method}(${params.join(',')});`));
   if(method==="qorpera_prepare_runtime_office_successor"&&(resumeMode ? !successorPreparationLosses.has(args.p_request.attestation.activationId) : !successorPrepareLost)){successorPrepareLost=true;successorPreparationLosses.add(args.p_request.attestation.activationId);throw new Error("lost committed successor preparation");}
   if(method==="qorpera_activate_runtime_office_successor"&&(resumeMode ? !successorActivationLosses.has(args.p_request.attestation.activationId) : !successorActivateLost)){successorActivateLost=true;successorActivationLosses.add(args.p_request.attestation.activationId);throw new Error("lost committed successor activation");}
   signal.throwIfAborted();return value;
  } };
        const registry = { call: async (method, args, signal) => {
            signal.throwIfAborted();
            return JSON.parse(docker(psql, `${service} ${sqlCall(method, args)}`));
        } };
        const result = await creation.runOfficeCreationSqlProbe(creationPolicies.get(providerId).policy, registry,
            bootMode ? { guest: systemdGuest, powerOff: powerOffMode, lifecycle: lifecycleMode, prepare: preparationMode, configure: configurationMode, revoke: async () => { const version=docker(psql,"select version from public.qorpera_runtime_office_providers;");docker(psql, `${service} ${enroll(providerId, Number(version), false)}`); },
 ...(stopWorkerMode ? { stop: {
  registry: { call: async (method, args, signal) => {
   signal.throwIfAborted();
   if (method === "qorpera_suspend_runtime_node_machine") {
    // After the confirmed stop of an explicit power-off the worker gives the node slot back
    // (lxd-office-node-admission.ts). Its exact six arguments reach the real SQL unchanged.
    assert(powerOffMode);
    assert.deepEqual(Object.keys(args), ["p_allocation_id", "p_provider_id", "p_policy_sha256", "p_instance_sha256", "p_machine_id_sha256", "p_transition_id"]);
    const { policy, digest } = creationPolicies.get(providerId);
    assert.deepEqual([args.p_provider_id, args.p_policy_sha256, args.p_machine_id_sha256], [providerId, digest, policy.host.machineIdSha256]);
    assert.deepEqual(JSON.parse(docker(psql, `select jsonb_build_object('action',t.request->>'action','instanceSha256',a.instance_sha256)
     from public.qorpera_runtime_office_lifecycle_transitions t join public.qorpera_runtime_machine_allocations a on a.id=t.allocation_id and a.released_at is null
     where t.id=${sqlText(args.p_transition_id)} and t.allocation_id=${sqlText(args.p_allocation_id)};`)), { action: "power_off", instanceSha256: args.p_instance_sha256 });
    if (suspensions.length) assert.deepEqual(args, suspensions[0].args); // One explicit power-off per run; later VM cycles are reboots.
    const receipt = JSON.parse(docker(psql, `${service} select public.qorpera_suspend_runtime_node_machine(${Object.values(args).map(sqlText).join(",")});`));
    // Every replay repeats the one receipt. All of them come before the resume re-admits the demand.
    assert(!nodeAdmissions.some(({ state }) => state === "suspended"));
    if (suspensions.length) assert.deepEqual(receipt, suspensions[0].receipt);
    else {
     assert.deepEqual(Object.keys(receipt).sort(), ["allocationId", "nodeId", "state", "suspendedAt"]);
     assert.deepEqual([receipt.state, receipt.allocationId, receipt.nodeId], ["suspended", args.p_allocation_id, nodeId]);
     assert.equal(receipt.suspendedAt, nodeDemand(args.p_allocation_id).suspendedAt);
    }
    suspensions.push({ args, receipt });
    signal.throwIfAborted(); return receipt;
   }
   assert(["qorpera_begin_runtime_office_lifecycle", "qorpera_runtime_office_lifecycle_status", "qorpera_prepare_runtime_office_stop", "qorpera_ack_runtime_office_stop", "qorpera_runtime_office_stop_status"].includes(method));
   const params = [literal(args.p_request)];
   if (method === "qorpera_prepare_runtime_office_stop") params.push(literal(args.p_command), sqlText(args.p_inspection_id), sqlText(args.p_start_completion_sha256));
   if (method === "qorpera_ack_runtime_office_stop") params.push(literal(args.p_inspection));
   const output = docker(psql, `${service} select public.${method}(${params.join(",")});`);
   const value = output ? JSON.parse(output) : null;
   if (method === "qorpera_begin_runtime_office_lifecycle" && (resumeMode ? !revocationLosses.has(args.p_request.transitionId) : !revocationReplyLost)) { revocationReplyLost = true; revocationLosses.add(args.p_request.transitionId); throw new Error("synthetic lost committed revocation reply"); }
   if (method === "qorpera_ack_runtime_office_stop" && (resumeMode ? !stopAckLosses.has(args.p_request.transitionId) : !stopAckReplyLost)) { stopAckReplyLost = true; stopAckLosses.add(args.p_request.transitionId); throw new Error("synthetic lost committed stop acknowledgement reply"); }
   signal.throwIfAborted(); return value;
  } },
  restartDatabase: async () => { docker(["restart", container]); await databaseReady(); },
 } } : {}),
 ...(resumeMode ? { resume: {
 laterCycles: vmCyclesMode,
 serviceRegistry: serviceSuccessorRegistry,
  successorRegistry: { call: async (method,args,signal) => {
   signal.throwIfAborted();
   assert(["qorpera_prepare_runtime_office_boot_successor","qorpera_runtime_office_boot_successor_status","qorpera_check_runtime_office_boot_successor","qorpera_activate_runtime_office_boot_successor"].includes(method));
   const params=[literal(args.p_request)]; if(method==="qorpera_activate_runtime_office_boot_successor")params.push(sqlText(args.p_service_invocation_id));
   const value=JSON.parse(docker(psql,`${service} select public.${method}(${params.join(',')});`));
   if(method==="qorpera_prepare_runtime_office_boot_successor"&&!bootPreparationLosses.has(args.p_request.attestation.activationId)){bootSuccessorPrepareLost=true;bootPreparationLosses.add(args.p_request.attestation.activationId);throw new Error("lost committed boot successor preparation");}
   if(method==="qorpera_activate_runtime_office_boot_successor"&&!bootActivationLosses.has(args.p_request.attestation.activationId)){bootSuccessorActivateLost=true;bootActivationLosses.add(args.p_request.attestation.activationId);throw new Error("lost committed boot successor activation");}
   signal.throwIfAborted();return value;
  } },
  registry: { call: async (method,args,signal) => {
   signal.throwIfAborted();
   if(method==="qorpera_reserve_runtime_node_machine")return JSON.parse(docker(psql,`${service} ${nodeCall(args)}`));
   assert(["qorpera_prepare_runtime_office_boot_intent","qorpera_runtime_office_boot_intent_status","qorpera_check_runtime_office_boot_intent"].includes(method));
   const value=JSON.parse(docker(psql,`${service} select public.${method}(${literal(args.p_request)});`));
   if(method==="qorpera_prepare_runtime_office_boot_intent"&&!bootIntentLosses.has(args.p_request.bootIntentId)){bootIntentReplyLost=true;bootIntentLosses.add(args.p_request.bootIntentId);throw new Error("lost committed boot intent");}
   signal.throwIfAborted(); return value;
  } },
  enable: async () => { const version=docker(psql,"select version from public.qorpera_runtime_office_providers;");docker(psql,`${service} ${enroll(providerId,Number(version),true)}`); },
 } } : {}),
 ...(successorWorkerMode ? { successor: {
  registry: serviceSuccessorRegistry,
  enable: async () => { const version=docker(psql,"select version from public.qorpera_runtime_office_providers;");docker(psql,`${service} ${enroll(providerId,Number(version),true)}`); },
 } } : {}),
 ...(activationWorkerMode ? { activation: {
  registry: { call: async (method, args, signal) => {
   signal.throwIfAborted();
   let params;
   if (method === "qorpera_prepare_runtime_office_activation") params = [literal(args.p_scope), String(args.p_computer_generation), sqlText(args.p_intent_id), sqlText(args.p_allocation_id), sqlText(args.p_instance_sha256), sqlText(args.p_provider_binding_sha256), sqlText(args.p_provider_id), sqlText(args.p_provider_policy_sha256), literal(args.p_mappings), literal(args.p_attestation)];
   else {
    assert(["qorpera_runtime_office_activation_status", "qorpera_activate_runtime_office"].includes(method));
    params = [literal(args.p_scope), String(args.p_computer_generation), sqlText(args.p_intent_id), sqlText(args.p_activation_id), sqlText(args.p_provider_id), sqlText(args.p_provider_policy_sha256)];
    if (method === "qorpera_activate_runtime_office") params.push(sqlText(args.p_service_invocation_id));
   }
   const result = JSON.parse(docker(psql, `${service} select public.${method}(${params.join(",")});`));
   if (method === "qorpera_activate_runtime_office" && !activationReplyLost) { activationReplyLost = true; throw new Error("synthetic lost committed activation reply"); }
   signal.throwIfAborted(); return result;
  } },
  ready: async (identity, activationId, nativePort, viewerPort) => {
   docker(psql, `${service} select public.qorpera_check_runtime_office_startup(${literal(identity)}); select public.qorpera_report_runtime_office_ready(${literal(identity)},${sqlText(activationId)},${nativePort},${viewerPort});`);
  },
 } } : {}),
 } : undefined);
        assert.equal(docker(psql, "select count(*) from public.qorpera_runtime_machine_allocations where released_at is null;"), "1");
        assert.equal(docker(psql, "select state from public.qorpera_runtime_offices;"), successorWorkerMode ? "active" : stopWorkerMode ? "maintenance" : activationWorkerMode ? "active" : "provisioning");
        if (stopWorkerMode) {
         assert(revocationReplyLost && stopAckReplyLost);
         assert.equal(docker(psql, "select count(*) from public.qorpera_runtime_office_stops;"), resumeMode ? (vmCyclesMode ? "6" : "4") : successorWorkerMode ? "2" : "1");
         assert.equal(docker(psql, "select count(*) from public.qorpera_runtime_office_lifecycle_transitions;"), resumeMode ? (vmCyclesMode ? "6" : "4") : successorWorkerMode ? "2" : "1");
         assert.equal(docker(psql, "select count(*) from public.qorpera_runtime_office_screens where drain_pending;"), "0");
         if(!successorWorkerMode)console.log("PASS: concrete serialized stop worker with real SQL and Unix HTTP survives lost revocation, physical stop and committed acknowledgement replies plus database restart; maintenance and machine capacity remain fenced");
         if(powerOffMode)console.log("PASS: explicit power-off worker uses current SQL stop authority, retains one VM stop through lost operation polling and database/provider recovery, and preserves maintenance and the company's allocation; VM measurement is synthetic");
         if(resumeMode){assert(bootIntentReplyLost&&bootSuccessorPrepareLost&&bootSuccessorActivateLost);assert.equal(revocationLosses.size,vmCyclesMode?6:4);assert.equal(stopAckLosses.size,vmCyclesMode?6:4);assert.equal(bootIntentLosses.size,vmCyclesMode?3:1);assert.equal(bootPreparationLosses.size,vmCyclesMode?3:1);assert.equal(bootActivationLosses.size,vmCyclesMode?3:1);assert.equal(successorPreparationLosses.size,2);assert.equal(successorActivationLosses.size,2);assert.equal(docker(psql,"select count(*) from public.qorpera_runtime_office_boot_intents i join public.qorpera_runtime_office_successors s on s.activation_id=i.activation_id;"),vmCyclesMode?"3":"1");assert.equal(docker(psql,"select count(*) from public.qorpera_runtime_office_activations where superseded_at is null;"),"1");if(vmCyclesMode)console.log("PASS: two additional VM resume/configuration/activation cycles with exact lost-reply recovery; six activation histories, six stops, three boot intents and one charged allocation in maintenance");
         if(!vmCyclesMode)console.log("PASS: serialized resume, boot configuration, activation and two complete service restart/stop cycles with actual SQL and Unix HTTP survive lost committed intent/preparation/activation/revocation/stop acknowledgements, lost physical replies and database restarts; four activation histories, original configuration and one charged allocation are preserved in maintenance");}
        }
        // Service stops and reboots keep the node slot. An explicit power-off alone leaves the demand
        // placed but suspended, so the node counts no computer; resume re-admits it. A fresh
        // observation makes the free capacity readable.
        const slotGivenBack=powerOffMode&&!resumeMode, guest=creationPolicies.get(providerId).policy.guest;
        observeNode();
        const nodeCapacity=JSON.parse(docker(psql,`${service} select public.qorpera_runtime_node_capacity('${nodeId}');`));
        assert.equal(nodeCapacity.state,"eligible");
        assert.equal(nodeCapacity.allocatedComputers,slotGivenBack?0:1); assert.equal(nodeCapacity.pendingRequests,0); assert.equal(nodeCapacity.admissibleSlots,slotGivenBack?1:0);
        assert.deepEqual([nodeCapacity.allocatedCpuMillis,nodeCapacity.allocatedMemoryBytes],slotGivenBack?[0,0]:[guest.cpus*1000,guest.memoryBytes]);
        assert.deepEqual([nodeCapacity.freeCpuMillis,nodeCapacity.freeMemoryBytes],slotGivenBack?[guest.cpus*1000,guest.memoryBytes]:[0,0]);
        assert.equal(nodeAdmissionCalls,1+(bootMode?1:0)+(resumeMode?(vmCyclesMode?3:1):0));
        const demand=nodeDemand(docker(psql,"select id from public.qorpera_runtime_machine_allocations where released_at is null;"));
        assert.equal(demand.state,slotGivenBack?"suspended":"reserved"); assert.equal(demand.nodeId,nodeId);
        // One demand across every boot: each later admission finds it on this node with its first reservation
        // time; only the resume after the explicit power-off finds it suspended.
        const admissionsFound=nodeAdmissions.map(({state})=>state);
        assert.deepEqual(admissionsFound,["none",...(bootMode?["reserved"]:[]),...(resumeMode?["suspended",...(vmCyclesMode?["reserved","reserved"]:[])]:[])]);
        for(const found of nodeAdmissions.slice(1))assert.deepEqual([found.nodeId,found.reservedAt],[nodeId,demand.reservedAt]);
        // The confirmed pass and its replay; resume modes replay once more while the resume plan is retained.
        assert.equal(suspensions.length,resumeMode?3:powerOffMode?2:0);
        if(slotGivenBack)assert.equal(demand.suspendedAt,suspensions[0].receipt.suspendedAt);
        console.log(JSON.stringify({schema:"qorpera.office-node-admission-proof/v2",nodeAdmissionCalls,admissionsFound,
         allocatedComputers:nodeCapacity.allocatedComputers,allocatedCpuMillis:nodeCapacity.allocatedCpuMillis,allocatedMemoryBytes:nodeCapacity.allocatedMemoryBytes,
         freeCpuMillis:nodeCapacity.freeCpuMillis,freeMemoryBytes:nodeCapacity.freeMemoryBytes,demand:demand.state,oneDemandAcrossBoots:true,
         nodeSlot:resumeMode?"suspended by the power-off, re-admitted by resume":powerOffMode?"given back by the power-off":"held",
         suspensionCalls:suspensions.length,suspensionReceipt:suspensions[0]?.receipt,actualSql:true,actualProviderWorkers:true,hostMeasurements:"synthetic",physicalVm:false}));
        if(slotGivenBack)console.log("PASS: the confirmed explicit power-off suspends the computer's node demand with one exact receipt through every replay; the node counts no computer and has its slot free while the demand stays placed and the allocation retained");
        if(resumeMode)console.log(`PASS: resume re-admits the suspended node demand through the ordinary reservation, keeping its node and first reservation time${vmCyclesMode?"; the two later reboots keep the slot without suspension":""}`);
        if (activationWorkerMode) { assert(activationReplyLost); assert.equal(docker(psql, "select count(*) from public.qorpera_runtime_office_activations where state='active';"), successorWorkerMode ? "3" : resumeMode ? (vmCyclesMode ? "6" : "4") : "1"); }
        if(successorWorkerMode){
         assert(successorPrepareLost&&successorActivateLost);
         assert.equal(docker(psql,"select count(*) from public.qorpera_runtime_office_activations where superseded_at is null;"),"1");
         console.log("PASS: concrete serialized successor worker completes two same-boot restart cycles with real SQL and Unix HTTP, preserving three activations, two stops and one allocation through lost replies and database restart");
        }
        if (lifecycleMode) { assert.equal(result.serializedLifecycle, true); assert.equal(result.retainedPhases, 8); }
        console.log(JSON.stringify(result));
        if(systemdMode){
         const proof=await systemdGuest.proof();
         assert.equal(proof.counts.preparation,1);assert.equal(proof.counts.configuration,1);
         assert.equal(proof.counts['service-start'],1);assert.equal(proof.counts['service-stop'],2);assert.equal(proof.counts['service-restart'],2);
         assert.equal(proof.invocations.length,3);assert.equal(proof.descendantsStopped,2);assert(proof.workbenchRetained&&proof.actualKernelFlock);
         console.log('OFFICE_SQL_SYSTEMD_PROOF='+JSON.stringify({...proof,sqlMigrations:migrations.length,actualPostgres:true,actualUnixHttp:true,serializedProviderWorkers:true,physicalGate:'synthetic',vmBootAndCopy:'synthetic',readiness:'fixture reports real measured invocation',deployed:false,modelCalls:false}));
        }
        console.log(`PASS: concrete ${activationWorkerMode ? "creation, first-boot, preparation, configuration and activation workers" : configurationMode ? "creation, first-boot, preparation and configuration workers" : preparationMode ? "creation, first-boot and preparation workers" : bootMode ? "creation and first-boot workers" : "creation worker"}, real SQL and Unix HTTP after ${migrations.length} migrations; ${systemdMode ? "actual root controls and systemd; physical gate/VM, copy, inventory and ordinary workload remain synthetic" : "physical gate/VM, systemd and copy remain synthetic"}`);
    } else {
	const reservationStatements = [];
	for (const binding of bindings) {
		const capture = new LxdOfficeStartControl(intent, binding, { call: async (method, args) => {
			reservationStatements.push(sqlCall(method, args));
			return { state: "refused", reason: "MACHINE_CAPACITY_EXHAUSTED" };
		} });
		await capture.reserve(new AbortController().signal);
	}
	const reservations = await race(reservationStatements.map((sql) => `${service} ${sql}`));
	assert.equal(reservations.filter((result) => result.code === 0).length, 1);
	assert.match(reservations.find((result) => result.code !== 0).error, /Office start allocation cannot be rebound/);
	const winner = reservations.findIndex((result) => result.code === 0);
	const reserved = JSON.parse(reservations[winner].output);
	assert.equal(reserved.state, "reserved");
	assert.equal(reserved.allocationId, allocations[winner]);
	assert.equal(reserved.providerBindingSha256, bindingDigests[winner]);
	assert.deepEqual(JSON.parse(docker(psql, `${service} ${reservationStatements[winner]}`)), reserved);
	assert.equal(docker(psql, "select count(*) from public.qorpera_runtime_machine_allocations where released_at is null;"), "1");
	console.log("PASS: competing provider reservations bind exactly one allocation; replay cannot rebind it");

	const registry = { call: async (method, args, signal) => {
		signal.throwIfAborted();
		return JSON.parse(docker(psql, `${service} ${sqlCall(method, args)}`));
	} };
	const control = new LxdOfficeStartControl(intent, bindings[winner], registry);
	const provider = new LxdOfficeProviderControl({ ...scope, computerGeneration: 1, providerId,
		providerPolicySha256: "f".repeat(64), imageFingerprint: "a".repeat(64), bootstrapSha256: "b".repeat(64) }, registry);
	const recovered = await provider.status(new AbortController().signal);
	assert.deepEqual(recovered, { providerVersion: 1, preparationEnabled: true, officeState: "provisioning", intent: { intentId: intent, state: "reserved" },
		reservation: { allocationId: reserved.allocationId, instanceSha256: reserved.instanceSha256, providerBindingSha256: reserved.providerBindingSha256 } });
	assert.deepEqual(await control.reserve(new AbortController().signal), { state: "reserved" });
	const preparation = await control.check(new AbortController().signal);
	assert(preparation.validForMs > 0 && preparation.validForMs <= 5000 && !preparation.signal.aborted);
	console.log("PASS: actual provider control adapter agrees with SQL reservation identity and bounded preparation authority");
	await testOfficeAdoptionAuthority({ scope, control, service, owner, sqlCall, race, session, until, execute: (sql) => docker(psql, sql), literal });
	if (bootSystemdMode) {
		const modules=await Promise.all(['contracts','bootData','stopHistory','bootIntentControl','bootSuccessorControl','successorControl','stopControl'].map(name=>import(pathToFileURL(join(bundleRoot,name+'.mjs')).href)));
		const proof=await testOfficeBootSystemd({guest:systemdGuest,scope,binding:bindings[winner],instanceSha256:reserved.instanceSha256,providerBindingSha256:bindingDigests[winner],intent,service,literal,execute:sql=>docker(psql,sql),restartDatabase:async()=>{docker(['restart',container]);await databaseReady();},contracts:modules[0],...Object.assign({},...modules.slice(1))});
		console.log('OFFICE_BOOT_SQL_SYSTEMD_PROOF='+JSON.stringify({...proof,sqlMigrations:migrations.length}));
		console.log('PASS: real SQL admission and packaged new-boot controls complete three distinct invocations and stops, preserving one allocation through lost SQL replies; original boot, copy and VM observations remain synthetic');
	} else if (activationMode) {
		const { CompanyComputerStartupControl } = await import(pathToFileURL(join(bundleRoot, "startup.mjs")).href);
		const { LxdOfficeActivationControl } = await import(pathToFileURL(join(bundleRoot, "activation.mjs")).href);
		const activationResult = await testOfficeActivation({ scope, binding: bindings[winner], instanceSha256: reserved.instanceSha256, providerBindingSha256: bindingDigests[winner], intent, service, owner, race, session, until, execute: (sql) => docker(psql, sql), literal, CompanyComputerStartupControl, LxdOfficeActivationControl });
		console.log(`PASS: activation concurrency after ${migrations.length} migrations; physical readiness remains synthetic`);
		docker(psql, `select set_config('qorpera_test.screen_startup',${literal(activationResult.startup)}::text,false);\n${readFileSync(join(root,"supabase/tests/fixtures/runtime-screen-lifecycle-cases.sql"),"utf8")}`);
		console.log("PASS: retained screen lifecycle records bind the actual SQL service activation, preserve exact replay and ordered history, and permit cleanup after revocation; desktop measurements remain synthetic");
		docker(psql, `select set_config('qorpera_test.screen_startup',${literal(activationResult.startup)}::text,false);\n${readFileSync(join(root,"supabase/tests/fixtures/runtime-screen-history-cases.sql"),"utf8")}`);
		console.log("PASS: screen usage bounds original heartbeats, exposes unknown gaps, preserves clipped/partitioned arithmetic and keeps discovery private; timestamps remain fixtures");
		const screenResult=await testRuntimeScreenLifecycle({startup:activationResult.startup,service,literal,execute:sql=>docker(psql,sql),race,retainOpen:stopMode,
			CompanyComputerScreenOutbox:(await import(pathToFileURL(join(bundleRoot,"screenOutbox.mjs")).href)).CompanyComputerScreenOutbox,
			CompanyComputerScreenLifecyclePublisher: (await import(pathToFileURL(join(bundleRoot, "screenLifecycle.mjs")).href)).CompanyComputerScreenLifecyclePublisher,
			restartDatabase:async()=>{docker(["restart",container]);await databaseReady();}});
		const screenRecovery=stopMode?await prepareScreenObservationRecovery({startup:activationResult.startup,openLifetimeId:screenResult.openLifetimeId,
			service,owner,literal,execute:sql=>docker(psql,sql),race,restartDatabase:async()=>{docker(["restart",container]);await databaseReady();},
			CompanyComputerScreenLifecyclePublisher:(await import(pathToFileURL(join(bundleRoot,"screenLifecycle.mjs")).href)).CompanyComputerScreenLifecyclePublisher,
			CompanyComputerScreenOutbox:(await import(pathToFileURL(join(bundleRoot,"screenOutbox.mjs")).href)).CompanyComputerScreenOutbox}):undefined;
		try {
		if (lifecycleRevocationMode) {
			renewWakeBinding();
			const { LxdOfficeLifecycleControl } = await import(pathToFileURL(join(bundleRoot, "lifecycleControl.mjs")).href);
			const revocation = await testOfficeLifecycleRevocation({ scope, binding: bindings[winner], startup: activationResult.startup, attestation: activationResult.attestation, setup, service, owner, race, session, until, literal, action: bootSuccessorMode ? "reboot" : "service_restart",
				execute: sql => docker(psql, sql), restartDatabase: async () => { docker(["restart", container]); await databaseReady(); }, LxdOfficeLifecycleControl });
			if (stopMode) {
				const { LxdOfficeStopControl } = await import(pathToFileURL(join(bundleRoot, "stopControl.mjs")).href);
				const stop = await testOfficeStopAcknowledgement({ ...revocation, scope, service, owner, race, session, until, literal,
					screenLifetimeId:screenResult.openLifetimeId,
						execute: sql => docker(psql, sql), restartDatabase: async () => { docker(["restart", container]); await databaseReady(); }, LxdOfficeStopControl });
				await screenRecovery.finish();
				if (successorMode || bootSuccessorMode) {
					const module = await import(pathToFileURL(join(bundleRoot, bootSuccessorMode ? "bootSuccessorControl.mjs" : "successorControl.mjs")).href);
					const LxdOfficeSuccessorControl = bootSuccessorMode ? module.LxdOfficeBootSuccessorControl : module.LxdOfficeSuccessorControl;
					const LxdOfficeBootIntentControl = bootSuccessorMode ? (await import(pathToFileURL(join(bundleRoot, "bootIntentControl.mjs")).href)).LxdOfficeBootIntentControl : undefined;
					await testOfficeSuccessorAdmission({ stop, attestation: activationResult.attestation, scope, service, owner, race, session, until, literal, boot: bootSuccessorMode,
						prepareWake: () => prepareOfficeWake({ setup, intent, service, execute: sql => docker(psql, sql), literal }),
						execute: sql => docker(psql, sql), restartDatabase: async () => { docker(["restart", container]); await databaseReady(); }, CompanyComputerStartupControl, LxdOfficeSuccessorControl, LxdOfficeBootIntentControl });
				}
			}
		}
		} finally {await screenRecovery?.close();}
		await testRuntimeComputerLifecycle({allocationId:activationResult.startup.allocationId,service,literal,execute:sql=>docker(psql,sql),
			restartDatabase:async()=>{docker(["restart",container]);await databaseReady();},kind:'office',stopped:stopMode,closing:lifecycleRevocationMode,expectedBootRequests:bootSuccessorMode?2:0});
		if (wakeMode) {
			const { parseCloudWakeEnvelope } = await import(pathToFileURL(join(bundleRoot, "wake.mjs")).href);
			const helpers = wake[0].split("-- BEGIN WAKE HELPERS")[1].split("-- END WAKE HELPERS")[0];
			const { createHttpCompanyComputerSessionFactory } = await import(pathToFileURL(join(bundleRoot, "native.mjs")).href);
			const { CloudNativeToolRun } = await import(pathToFileURL(join(bundleRoot, "authority.mjs")).href);
			const { CloudNativeToolOperations } = await import(pathToFileURL(join(bundleRoot, "operations.mjs")).href);
			await testOfficeWake({ setup, intent, service, owner, execute: (sql) => docker(psql, sql), literal, race, session, until, helpers, parseCloudWakeEnvelope, createHttpCompanyComputerSessionFactory, CloudNativeToolRun, CloudNativeToolOperations,
				restartDatabase: async () => { docker(["restart", container]); await databaseReady(); },
			});
		}
	} else {

	const check = `select public.qorpera_check_runtime_office_adoption(${literal(scope)},1,'${intent}',
		'${allocations[winner]}','${reserved.instanceSha256}','${bindingDigests[winner]}',
		'${bindings[winner].providerId}','${bindings[winner].providerPolicySha256}','[]'::jsonb);`;
	const disabling = session();
	disabling.child.stdin.write(`begin; select public.qorpera_lock_profile_gc_fence('${scope.companyId}');
		select id from public.qorpera_runtime_offices where id='${scope.companyComputerId}' for update; select 'PROVIDER_LOCKED';\n`);
	await until(() => disabling.output().includes("PROVIDER_LOCKED"));
	const providerWaiting = session();
	providerWaiting.child.stdin.end(`${service} set application_name='office-provider-disable-race'; ${check}`);
	await until(() => docker(psql, "select count(*) from pg_stat_activity where application_name='office-provider-disable-race' and wait_event_type='Lock';") === "1");
	disabling.child.stdin.end(`${service} ${enroll(providerId, 1, false)} commit;`);
	const disableResult = await disabling.done;
	assert.equal(disableResult.code, 0, disableResult.error);
	const fenced = await providerWaiting.done;
	assert.notEqual(fenced.code, 0);
	assert.match(fenced.error, /Office provider authority unavailable/);
	assert.deepEqual(await provider.status(new AbortController().signal), { ...recovered, providerVersion: 2, preparationEnabled: false });
	assert.equal(docker(psql, "select count(*) from public.qorpera_runtime_machine_allocations where released_at is null;"), "1");
	docker(psql, `${service} ${enroll(providerId, 2, true)}`);
	console.log("PASS: provider disable fences waiting preparation while concrete discovery retains the exact allocation");
	assert.equal(JSON.parse(docker(psql, `${service} ${check}`)).state, "authorized");
	const blocker = session();
	blocker.child.stdin.write(`begin; select public.qorpera_lock_profile_gc_fence('${scope.companyId}');
		select id from public.qorpera_runtime_offices where id='${scope.companyComputerId}' for update;
		select 'START_LOCKED';\n`);
	await until(() => blocker.output().includes("START_LOCKED"));
	const waiting = session();
	waiting.child.stdin.end(`${service} set application_name='office-start-cancel-race'; ${check}`);
	await until(() => docker(psql, "select count(*) from pg_stat_activity where application_name='office-start-cancel-race' and wait_event_type='Lock';") === "1");
	blocker.child.stdin.end(`${owner} select public.qorpera_cancel_runtime_office_start(${literal(scope)},1,'${intent}'); commit;`);
	const cancelled = await blocker.done;
	assert.equal(cancelled.code, 0, cancelled.error);
	const denied = await waiting.done;
	assert.notEqual(denied.code, 0);
	assert.match(denied.error, /Office start reservation differs/);
	assert.equal(docker(psql, "select state from public.qorpera_runtime_office_start_intents;"), "cancelled");
	assert.equal(docker(psql, "select count(*) from public.qorpera_runtime_machine_allocations where released_at is null;"), "1");
	assert.equal(docker(psql, "select state from public.qorpera_runtime_offices;"), activationWorkerMode ? "active" : "provisioning");
        if (activationWorkerMode) { assert(activationReplyLost); assert.equal(docker(psql, "select count(*) from public.qorpera_runtime_office_activations where state='active';"), "1"); }
	await assert.rejects(control.check(new AbortController().signal), /Office start reservation differs/);
	assert.deepEqual(await provider.status(new AbortController().signal), { ...recovered, providerVersion: 3, intent: { intentId: intent, state: "cancelled" } });
	console.log("PASS: preparation waiting behind cancellation observes revocation; capacity remains occupied and office inactive");
	console.log(`PASS: start concurrency after ${migrations.length} migrations; no hosted database or physical provider access`);
	}
    }
} finally {
	for (const child of children) child.kill("SIGKILL");
	try{if (started) docker(["rm", "-f", "-v", container]);}
	finally{try{await systemdGuest?.close();}finally{await rm(bundleRoot, { recursive: true, force: true });}}
}
