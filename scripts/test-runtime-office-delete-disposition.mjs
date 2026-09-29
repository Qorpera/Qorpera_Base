// Governed office root reset against real PostgreSQL: all migrations, the real
// office/wake fixtures, real activation, replace revocation and stop, then the
// full reset phase chain through the actual provider adapters. Every VM, root
// and archive observation is synthetic; no LXD, NAS, node or hosted database.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { hostedDatabase, migrationNames, newestBundleActivation } from "./test-hosted-db-cluster.mjs";
import { testOfficeActivation } from "./test-runtime-office-activation-cases.mjs";
import { testOfficeAdoptionAuthority } from "./test-runtime-office-adoption-cases.mjs";
import { testOfficeLifecycleRevocation } from "./test-runtime-office-lifecycle-cases.mjs";
import { testOfficeResetChain } from "./test-runtime-office-delete-disposition-cases.mjs";
import { testOfficeStopAcknowledgement } from "./test-runtime-office-stop-cases.mjs";
import { renewOfficeWakeBinding } from "./test-runtime-office-wake-cases.mjs";
import { testRuntimeComputerLifecycle } from "./test-runtime-computer-lifecycle-cases.mjs";
import { prepareScreenObservationRecovery } from "./test-runtime-screen-observation-recovery-cases.mjs";
import { testRuntimeScreenLifecycle } from "./test-runtime-screen-lifecycle-cases.mjs";

if (process.argv.length !== 2) throw new Error("Usage: node scripts/test-runtime-office-delete-disposition.mjs");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
/** The database, in the suite's PostgreSQL or a container of this script's own; set once the bundles are built. */
let database;
let psql;
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
	const deadline = Date.now() + 5_000;
	while (!check()) {
		assert(Date.now() < deadline, "SQL barrier timed out");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
async function race(statements) {
	const contenders = statements.map(() => session());
	contenders.forEach((contender, index) => contender.child.stdin.end(statements[index]));
	return Promise.all(contenders.map((contender) => contender.done));
}
const sqlText = (value) => `'${value.replaceAll("'", "''")}'`;
const literal = (value) => `${sqlText(JSON.stringify(value))}::jsonb`;
const service = `set request.jwt.claims='{"role":"service_role"}'; set role service_role;`;
const owner = `set request.jwt.claims='{"role":"authenticated","sub":"30000000-0000-4000-8000-000000000001"}'; set role authenticated;`;
// This focused SQL lane reuses fixture checkpoints without container restarts.
// Restarting a container clears its disposable tmpfs; reboot proof belongs to the existing driver.
console.log("FOCUSED_PROOF_SCOPE: reused fixture log restart labels are inherited; this tmpfs driver performs no database/container restart and claims no restart proof.");
const restartDatabase = async () => {};
const bundleRoot = await realpath(await mkdtemp(join(tmpdir(), "office-reset-control-")));
try {
	await build({
		entryPoints: {
			control: join(root, "packages/runner-orchestrator/src/lxd-office-start-control.ts"),
			provider: join(root, "packages/runner-orchestrator/src/lxd-office-provider-control.ts"),
			startup: join(root, "packages/runtime/src/cloud-company-computer-startup.ts"),
			screenLifecycle: join(root, "packages/runtime/src/cloud-company-computer-screen-lifecycle.ts"),
			screenOutbox: join(root, "packages/runtime/src/cloud-company-computer-screen-outbox.ts"),
			activation: join(root, "packages/runner-orchestrator/src/lxd-office-activation-control.ts"),
			lifecycleControl: join(root, "packages/runner-orchestrator/src/lxd-office-lifecycle-control.ts"),
			stopControl: join(root, "packages/runner-orchestrator/src/lxd-office-stop-control.ts"),
			resetControl: join(root, "packages/runner-orchestrator/src/lxd-office-reset-control.ts"),
		},
		// The reviewed worktree sources are the subject; never a sibling checkout's built dist.
		alias: {
			"@qorpera/contracts": join(root, "packages/contracts/src"),
			"@qorpera/runtime": join(root, "packages/runtime/src"),
			"@qorpera/cloud-client": join(root, "packages/cloud-client/src"),
		},
		bundle: true, platform: "node", format: "esm", target: "node22", outdir: bundleRoot, outExtension: { ".js": ".mjs" }, logLevel: "silent",
		external: ["vitest"],
	});
	const load = async (name) => import(pathToFileURL(join(bundleRoot, `${name}.mjs`)).href);
	const { LxdOfficeStartControl, lxdOfficeProviderBindingSha256 } = await load("control");
	const { LxdOfficeProviderControl } = await load("provider");
	// The newest bundle activation is held back: the cases apply it mid-test as "a newer bundle than the office was built for".
	const names = migrationNames();
	const future = newestBundleActivation(names);
	assert.ok(future);
	const migrations = names.filter(name => name !== future);
	database = await hostedDatabase("office", { skip: [future] });
	psql = database.cluster.psqlArgs("office", ["-qAt"]);
	docker(psql, readFileSync(join(root, "supabase/tests/fixtures/runtime-node-inventory-observer.sql"), "utf8"));
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
	const renewWakeBinding = () => renewOfficeWakeBinding({ setup, service, execute: (sql) => docker(psql, sql) });
	renewWakeBinding();
	const scope = setup.descriptor.scope;
	const providerId = randomUUID();
	const enroll = (version = 0, enabled = true) => `select public.qorpera_set_runtime_office_provider(${literal(scope)},1,'${providerId}','${"f".repeat(64)}',${version},${enabled});`;
	docker(psql, `${service} ${enroll()}`);
	const intent = JSON.parse(docker(psql, `${owner} select public.qorpera_request_runtime_office_start(${literal(scope)},1,'${randomUUID()}');`)).intentId;
	// One real native start receipt registers the staff screen the later
	// screen/stop fixtures bind to, exactly as the start driver does.
	const principals = Object.fromEntries(Object.entries(setup.identity).filter(([key]) => !["assignmentId", "runnerId", "leaseId", "sponsorVersion", "providerConnectionId", "providerConnectionVersion"].includes(key)));
	const receipt = randomUUID();
	const envelope = JSON.stringify({ schema: "qorpera.cloud-tool-operation/v2", principals, operation: {
		tool: "computer_start", toolVersion: "qorpera.company-computer-tools/v2", logicalOperationKey: "reset-start",
		arguments: { kind: "start" }, requiresCompanyRevision: false,
		target: { realm: "company_computer", scope, computerGeneration: 1, resources: setup.descriptor.resources },
	} });
	docker(psql, `${service} select public.qorpera_begin_native_tool_operation(${literal(setup.binding)},'${receipt}','computer_start:reset-start','${createHash("sha256").update(envelope).digest("hex")}',repeat('d',64),false);`);
	assert.equal(JSON.parse(docker(psql, `${service} select public.qorpera_native_office_start(${literal(setup.binding)},${sqlText(envelope)},'begin','${receipt}',repeat('d',64));`)).intentId, intent);
	const binding = { schema: "qorpera.lxd-office-guest/v2", ...scope, providerId, providerPolicySha256: "f".repeat(64),
		computerGeneration: 1, allocationId: randomUUID(), project: "offices", imageFingerprint: "a".repeat(64), bootstrapSha256: "b".repeat(64),
		storagePool: "office-vms", rootDiskBytes: 64 * 1024 ** 3, workbenchSource: "/mnt/disposable-fixture/office",
		network: "office-net", cpus: 2, memoryBytes: 4 * 1024 ** 3 };
	const providerBindingSha256 = lxdOfficeProviderBindingSha256(binding);
	const sqlCall = (method, args) => {
		assert(["qorpera_reserve_runtime_office_start", "qorpera_check_runtime_office_start", "qorpera_check_runtime_office_adoption", "qorpera_runtime_office_provider_status"].includes(method));
		if (method === "qorpera_runtime_office_provider_status") return `select public.${method}(${literal(args.p_scope)},${args.p_computer_generation},${sqlText(args.p_provider_id)},${sqlText(args.p_provider_policy_sha256)});`;
		const parameters = [literal(args.p_scope), String(args.p_computer_generation), sqlText(args.p_intent_id), sqlText(args.p_allocation_id), sqlText(args.p_instance_sha256)];
		if (method === "qorpera_reserve_runtime_office_start") parameters.push(sqlText(args.p_image_sha256), sqlText(args.p_bootstrap_sha256));
		parameters.push(sqlText(args.p_provider_binding_sha256), sqlText(args.p_provider_id), sqlText(args.p_provider_policy_sha256));
		if (method === "qorpera_check_runtime_office_adoption") parameters.push(literal(args.p_mappings));
		return `select public.${method}(${parameters.join(",")});`;
	};
	const registry = { call: async (method, args, signal) => { signal.throwIfAborted(); return JSON.parse(docker(psql, `${service} ${sqlCall(method, args)}`)); } };
	const control = new LxdOfficeStartControl(intent, binding, registry);
	const reserved = await control.reserve(new AbortController().signal);
	assert.equal(reserved.state, "reserved");
	const provider = new LxdOfficeProviderControl({ ...scope, computerGeneration: 1, providerId, providerPolicySha256: "f".repeat(64), imageFingerprint: "a".repeat(64), bootstrapSha256: "b".repeat(64) }, registry);
	const recovered = await provider.status(new AbortController().signal);
	assert.equal(recovered.officeState, "provisioning");
	const instanceSha256 = recovered.reservation.instanceSha256;
	// Adoption authority registers the synthetic pre-existing screen/profile
	// mappings that the screen, stop and reset fixtures later bind to.
	await testOfficeAdoptionAuthority({ scope, control, service, owner, sqlCall, race, session, until, execute: (sql) => docker(psql, sql), literal });
	console.log("PASS: real office fixture, provider enrollment, member start intent, adoption authority and one charged allocation");
	const { CompanyComputerStartupControl } = await load("startup");
	const { LxdOfficeActivationControl } = await load("activation");
	const activationResult = await testOfficeActivation({ scope, binding, instanceSha256, providerBindingSha256, intent, service, owner, race, session, until, execute: (sql) => docker(psql, sql), literal, CompanyComputerStartupControl, LxdOfficeActivationControl });
	for (const fixture of ["runtime-screen-lifecycle-cases.sql", "runtime-screen-history-cases.sql"])
		docker(psql, `select set_config('qorpera_test.screen_startup',${literal(activationResult.startup)}::text,false);\n${readFileSync(join(root, "supabase/tests/fixtures", fixture), "utf8")}`);
	const { CompanyComputerScreenLifecyclePublisher } = await load("screenLifecycle");
	const { CompanyComputerScreenOutbox } = await load("screenOutbox");
	const screenResult = await testRuntimeScreenLifecycle({ startup: activationResult.startup, service, literal, execute: (sql) => docker(psql, sql), race, retainOpen: true, CompanyComputerScreenLifecyclePublisher, CompanyComputerScreenOutbox, restartDatabase });
	const screenRecovery = await prepareScreenObservationRecovery({ startup: activationResult.startup, openLifetimeId: screenResult.openLifetimeId, service, owner, literal, execute: (sql) => docker(psql, sql), race, restartDatabase, CompanyComputerScreenLifecyclePublisher, CompanyComputerScreenOutbox });
	try {
		renewWakeBinding();
		const { LxdOfficeLifecycleControl } = await load("lifecycleControl");
		const revocation = await testOfficeLifecycleRevocation({ scope, binding, startup: activationResult.startup, attestation: activationResult.attestation, setup, service, owner, race, session, until, literal, action: "replace", execute: (sql) => docker(psql, sql), restartDatabase, LxdOfficeLifecycleControl });
		const { LxdOfficeStopControl } = await load("stopControl");
		const stop = await testOfficeStopAcknowledgement({ ...revocation, scope, service, owner, race, session, until, literal, screenLifetimeId: screenResult.openLifetimeId, execute: (sql) => docker(psql, sql), restartDatabase, LxdOfficeStopControl });
		await screenRecovery.finish();
		console.log("PASS: replace revocation and physical stop acknowledgement retain the office in maintenance with one charged allocation and unconfirmed diagnostics");
		const controls = await load("resetControl");
		const resetResult = await testOfficeResetChain({ stop, attestation: activationResult.attestation, scope, binding, service, owner, race, session, until, literal, execute: (sql) => docker(psql, sql), restartDatabase, controls, CompanyComputerStartupControl });
	} finally {
		await screenRecovery.close();
	}
	console.log(JSON.stringify({ schema: "qorpera.office-delete-disposition-sql-proof/v1", migrations: migrations.length, actualSql: true, actualProviderAdapters: true, physicalVm: "synthetic", archive: "synthetic-digests", nas: "fixture", hostedDatabase: false }));
	console.log(`PASS: governed office root reset after ${migrations.length} migrations; no hosted database, LXD, NAS, node or canonical file access`);
} finally {
	for (const child of children) child.kill("SIGKILL");
	try { database?.close(); } finally { await rm(bundleRoot, { recursive: true, force: true }); }
}
