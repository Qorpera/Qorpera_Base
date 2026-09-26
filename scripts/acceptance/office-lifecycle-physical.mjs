import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, chown, cp, link, mkdir, readFile, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { build } from "esbuild";
import { startOfficeRpcServer } from "./office-rpc-server.mjs";
import { readWorkloadUsage, verifyWorkloadUsage } from "./workload-usage-evidence.mjs";

// One retained, disposable fixture from empty storage through actual admission
// and a guard-forced outage. Never seed guest readiness, activation, physical
// samples, stopped receipts, or recovery acknowledgements in PostgreSQL.
assert(process.platform === "linux" && process.getuid() === 0);
assert(process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted");
assert([6, 8].includes(process.argv.length) && process.argv[2] === "--image-context" && process.argv[4] === "--out");
assert(process.argv.length === 6 || (process.argv[6] === "--cpus" && ["1", "2"].includes(process.argv[7])));
const guestCpus = process.argv.length === 8 ? Number(process.argv[7]) : 2;
const guestCpuMillis = guestCpus * 1000;
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const context = JSON.parse(await readFile(process.argv[3], "utf8"));
assert(context.provenanceSigned && context.builderVmDeleted && context.finalCloneDeleted);
// GitHub-hosted /opt can be runner-writable. Configuration and bundled tools
// live beneath the same protected /etc ancestry as the actual node observer.
const out = resolve(process.argv[5]), root = "/etc/qorpera-office-lifecycle-acceptance";
const storage = "/srv/qorpera-office-lifecycle-acceptance", journal = `${storage}/journal`, workbench = `${storage}/workbench`, custodyRoot = `${storage}/reset-custody`;
const account = "qorpera-office-provider", unit = "qorpera-office-computer-guard.service";
const evidence = { schema: "qorpera.office-lifecycle-physical-acceptance/v1", commit: process.env.GITHUB_SHA,
	passed: false, checks: {}, observations: [], scope: "Actual office provider, paid SQL, LXD/KVM guest, local NFS and forced-stop recovery. Subscription is a labeled isolated test entitlement; Stripe acceptance is separate." };
const children = new Set();
const physicalSamples = [];
let pg, pgReady, rpc, provider, observer, metering, mounted = false, journalMounted = false, exported = false, guardInstalled = false, fixtureCreated = false;
let machineName, phase = "setup";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const literal = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
const service = "set request.jwt.claims='{\"role\":\"service_role\"}';";
const member = "set request.jwt.claims='{\"role\":\"authenticated\",\"sub\":\"30000000-0000-4000-8000-000000000001\"}';";
function run(command, args, timeout = 30000) {
	const result = spawnSync(command, args, { cwd: repository, encoding: "utf8", timeout, maxBuffer: 4 * 1024 ** 2 });
	assert.equal(result.status, 0, `${command} failed (${result.status}); ${String(result.error ?? result.stderr).slice(-1500)}`);
	return result.stdout.trim();
}
function child(command, args, onLine, environment = {}) {
	const processChild = spawn(command, args, { cwd: root, env: { ...process.env, ...environment }, stdio: ["ignore", "pipe", "pipe"] });
	children.add(processChild);
	let pending = "";
	processChild.stdout.on("data", (bytes) => {
		pending += bytes.toString();
		assert(pending.length < 1024 ** 2, "Child output bound exceeded");
		for (;;) { const end = pending.indexOf("\n"); if (end < 0) break; const line = pending.slice(0, end); pending = pending.slice(end + 1); if (line) onLine(line); }
	});
	// Migration and production diagnostic output can contain operational data.
	// Keep errors private and bounded; public evidence reports codes/phases only.
	let diagnostics = "";
	processChild.stderr.on("data", (bytes) => { diagnostics = (diagnostics + bytes).slice(-65536); });
	processChild.once("close", () => children.delete(processChild));
	processChild.privateDiagnostics = () => diagnostics;
	return processChild;
}
async function stop(processChild) {
	if (!processChild || processChild.exitCode !== null || processChild.signalCode !== null) return;
	processChild.kill("SIGTERM");
	await until(() => processChild.exitCode !== null || processChild.signalCode !== null, Boolean, 15000, "owned process exit");
}
async function until(read, accept, timeout, label) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) { const value = await read(); if (accept(value)) return value; await delay(1000); }
	throw new Error(`OFFICE_ACCEPTANCE_TIMEOUT: ${label}`);
}
async function query(sql, options = {}) {
	assert(pgReady, "Database not ready");
	return new Promise((resolveQuery, reject) => {
		const command = spawn("/usr/lib/postgresql/17/bin/psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-h", pgReady.socketDirectory, "-U", "postgres", "-d", "qorpera_test"],
			{ env: { PATH: "/usr/bin:/bin", LANG: "C", PGOPTIONS: "-c statement_timeout=10000 -c lock_timeout=2000" }, stdio: ["pipe", "pipe", "pipe"] });
		let output = "", error = "";
		const abort = () => command.kill("SIGKILL"), timer = setTimeout(abort, options.timeoutMs ?? 15000);
		options.signal?.addEventListener("abort", abort, { once: true });
		command.stdout.on("data", (bytes) => { output += bytes; if (output.length > (options.maxOutputBytes ?? 4 * 1024 ** 2)) abort(); });
		command.stderr.on("data", (bytes) => { error = (error + bytes).slice(-16384); });
		command.stdin.on("error", () => {});
		command.once("error", reject);
		command.once("close", (code) => {
			clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
			if (code === 0) resolveQuery(output.trim());
			else {
				void writeFile(`${root}/private-sql-error`, error, { mode: 0o600 });
				// Public diagnostics retain only SQLSTATE and a routine identifier.
				// Raw messages, argument values and statement text remain private.
				evidence.lastSqlFailure = { phase, sqlState: /ERROR:\s+([0-9A-Z]{5}):/.exec(error)?.[1] ?? "unknown",
					routine: /PL\/pgSQL function ((?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*)\(/.exec(error)?.[1] ?? null };
				reject(new Error("OFFICE_ACCEPTANCE_SQL_FAILED"));
			}
		});
		command.stdin.end(sql);
	});
}
async function protectedFile(name, value, secret = false) {
	const path = join(root, name), bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
	const temporary = `${path}.publish-${randomUUID()}`;
	try {
		await writeFile(temporary, bytes, { flag: "wx", mode: secret ? 0o440 : 0o444 });
		await chown(temporary, 0, secret ? 1100 : 0);
		// Exclusive atomic publication: a running provider cannot read a partial
		// resume plan, and an existing protected plan is never overwritten.
		await link(temporary, path);
	} finally { await unlink(temporary); }
	return { path, bytes: bytes.length, sha256: hash(bytes) };
}
function tool(action, ...args) { return run(process.execPath, [`${root}/tools.mjs`, action, ...args]); }
function startProvider(ca) {
	return child("runuser", ["-u", account, "--", "flock", "--no-fork", `${journal}/adoption.lock`, process.execPath, `${root}/tools.mjs`, "provider", `${root}/service.json`], (line) => {
		const observation = JSON.parse(line);
		if (evidence.observations.length >= 200) evidence.observations.shift();
		evidence.observations.push(observation);
		console.log(JSON.stringify({ phase, provider: observation.state, step: observation.phase, error: observation.errorCode }));
	}, { NODE_EXTRA_CA_CERTS: ca });
}
try {
	await mkdir(out, { recursive: true, mode: 0o755 });
	await mkdir(root, { mode: 0o755 });
	await mkdir(storage, { mode: 0o755 }); fixtureCreated = true;
	assert.deepEqual(JSON.parse(run("lxc", ["list", "--all-projects", "--format=json"])), [], "Refuse unrelated VMs");
	assert.equal(run("exportfs", []), "", "Refuse unrelated NFS exports");
	run("useradd", ["--uid", "1100", "--user-group", "--no-create-home", "--shell", "/usr/sbin/nologin", account]);
	assert.equal(run("id", ["-g", account]), "1100", "Fixture account must match the measured storage group");
	run("usermod", ["--append", "--groups", "lxd", account]);
	await build({ absWorkingDir: repository, entryPoints: ["scripts/acceptance/office-lifecycle-tools.ts"], outfile: `${root}/tools.mjs`, bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent",
		banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
	tool("namespace");
	for (const path of ["export", "workbench", "journal"]) await mkdir(`${storage}/${path}`, { mode: 0o700 });
	await chown(`${storage}/export`, 1100, 1100);
	await mkdir(custodyRoot, { mode: 0o700 }); await chown(custodyRoot, 1100, 1100);
	await writeFile("/etc/exports.d/qorpera-office-lifecycle-acceptance.exports", `${storage}/export 127.0.0.1(rw,sync,root_squash,no_subtree_check,fsid=0)\n`, { mode: 0o644, flag: "wx" }); exported = true;
	run("systemctl", ["start", "nfs-server"]); run("exportfs", ["-ra"]);
	run("mount", ["-t", "nfs4", "-o", "vers=4.2,proto=tcp,hard,nosuid,nodev", "127.0.0.1:/", workbench]); mounted = true;
	run("truncate", ["-s", "256M", `${storage}/journal.ext4`]); run("mkfs.ext4", ["-q", "-F", `${storage}/journal.ext4`]);
	run("mount", ["-o", "loop,nosuid,nodev", `${storage}/journal.ext4`, journal]); journalMounted = true;
	await rmdir(`${journal}/lost+found`);
	await chmod(journal, 0o700); await chown(journal, 1100, 1100);
	await writeFile(`${journal}/adoption.lock`, "", { flag: "wx", mode: 0o600 }); await chown(`${journal}/adoption.lock`, 1100, 1100);
	const journalSource = run("findmnt", ["-n", "-o", "SOURCE", "--target", journal]);
	const trust = JSON.parse(await readFile(context.trustContextPath, "utf8"));
	assert.equal(trust.retained, false, "Image listener must release its address before lifecycle acceptance");
	// The original private trust directory is intentionally not traversable by
	// provider/observer users. Only the public CA is copied out.
	const ca = await protectedFile("ca.pem", await readFile(trust.caCertificatePath));
	const tokens = { guest: randomBytes(32).toString("base64url"), provider: randomBytes(32).toString("base64url") };
	const executor = randomBytes(48).toString("base64url");
	// Stage only public SQL/helper inputs under a traversable owned fixture.
	// The dedicated UID must not require access through the runner's private home.
	const pgSource = `${root}/pg-source`;
	await mkdir(`${pgSource}/scripts/acceptance`, { recursive: true, mode: 0o755 });
	await mkdir(`${pgSource}/supabase/tests`, { recursive: true, mode: 0o755 });
	await cp(join(repository, "scripts/acceptance/native-postgres.mjs"), `${pgSource}/scripts/acceptance/native-postgres.mjs`);
	await cp(join(repository, "scripts/test-hosted-db.mjs"), `${pgSource}/scripts/test-hosted-db.mjs`);
	await cp(join(repository, "supabase/tests/bootstrap.sql"), `${pgSource}/supabase/tests/bootstrap.sql`);
	await cp(join(repository, "supabase/migrations"), `${pgSource}/supabase/migrations`, { recursive: true });
	phase = "database";
	pg = child("runuser", ["-u", account, "--", process.execPath, `${pgSource}/scripts/acceptance/native-postgres.mjs`, "--bin", "/usr/lib/postgresql/17/bin", "--serve"], (line) => { const parsed = JSON.parse(line); if (parsed.ready) pgReady = parsed; });
	await until(() => { assert(pg.exitCode === null, "Native PostgreSQL startup failed"); return pgReady; }, Boolean, 240000, "native PostgreSQL migrations");
	evidence.migrationCount = pgReady.migrationCount;
	rpc = await startOfficeRpcServer({ query, tls: { cert: await readFile(trust.serverCertificatePath), key: await readFile(trust.serverPrivateKeyPath) }, tokens, listen: { host: trust.host, port: trust.port }, onSample: (sample) => physicalSamples.push(sample) });
	const registryUrl = `https://${trust.host}:${trust.port}`;
	const wake = await readFile(join(repository, "supabase/tests/300_runtime_wake_bus.test.sql"), "utf8");
	const firstStaff = wake.indexOf("\ninsert into public.qorpera_profile_staff(");
	assert(firstStaff > 0, "Pre-run company fixture boundary missing");
	// Only the pre-run company/path setup is reused. Its object metadata is a
	// labeled SQL fixture; it is not physical guest or canonical-storage proof.
	phase = "company_bootstrap";
	await query(`${wake.slice(0, firstStaff)} commit;`);
	const scope = JSON.parse(await query(`${member} select public.qorpera_register_runtime_office('30000000-0000-4000-8000-000000000020','${randomUUID()}','${context.imageFingerprint}','${context.bootstrapSha256}',2)-'state';`));
	const measured = JSON.parse(tool("infrastructure", context.imageFingerprint));
	evidence.hostCapacity = { cpuMillis: measured.cpuMillis, memoryBytes: measured.memoryBytes };
	evidence.guestShape = { cpuMillis: guestCpuMillis, memoryBytes: 4 * 1024 ** 3 };
	phase = "host_capacity";
	assert(measured.cpuMillis >= guestCpuMillis + 1000 && measured.memoryBytes >= 6 * 1024 ** 3,
		"Office fixture requires its measured guest resources plus 1 CPU and 2 GiB host headroom");
	const providerId = randomUUID(), nodeId = randomUUID(), intentId = randomUUID();
	const policy = { schema: "qorpera.lxd-office-physical-policy/v2", guest: { ...scope, providerId, computerGeneration: 1,
		project: "default", imageFingerprint: context.imageFingerprint, bootstrapSha256: context.bootstrapSha256,
		storagePool: "default", rootDiskBytes: 30 * 1024 ** 3, workbenchSource: workbench, network: "lxdbr0", cpus: guestCpus, memoryBytes: 4 * 1024 ** 3 },
		host: measured.host, infrastructure: measured.infrastructure,
		image: { bytes: context.imageBytes, guestPackageManifestSha256: context.packageManifestSha256, statementSha256: context.statementSha256, verificationKeySpki: context.verificationKeySpki },
		workbench: { mountPoint: workbench, root: "/", filesystem: "nfs4", source: "127.0.0.1:/", serverAddress: "127.0.0.1", uid: 1100, gid: 1100 },
		journal: { mountPoint: journal, root: "/", filesystem: "ext4", source: journalSource, path: journal } };
	await protectedFile("policy.json", policy);
	const { policySha256 } = JSON.parse(tool("policy", `${root}/policy.json`));
	await protectedFile("provenance.json", await readFile(context.provenancePath));
	await protectedFile("image-manifest.json", await readFile(`${context.packageRoot}/manifest.json`));
	const inventoryPolicy = { schema: "qorpera.runtime-node-inventory-policy/v1", nodeId, host: policy.host, operatingCpuMillis: 500, operatingMemoryBytes: 1024 ** 3, infrastructure: [] };
	phase = "policy_enrollment";
	await query(`${service}
 insert into public.qorpera_company_computer_billing_modes(profile_id,mode) values('${scope.companyId}','paid');
 select public.qorpera_configure_runtime_node(${literal({ schema: "qorpera.runtime-node-policy/v1", nodeId, machineIdSha256: policy.host.machineIdSha256, label: "office-acceptance", cpuMillis: measured.cpuMillis, memoryBytes: measured.memoryBytes, headroomCpuMillis: 1000, headroomMemoryBytes: 2 * 1024 ** 3, standardCpuMillis: guestCpuMillis, standardMemoryBytes: 4 * 1024 ** 3, enabled: true })},0);
 select public.qorpera_enroll_runtime_node_inventory(${literal(inventoryPolicy)});
 select public.qorpera_set_runtime_office_provider(${literal(scope)},1,'${providerId}','${policySha256}',0,true);
 select public.qorpera_enroll_runtime_node_provider('${nodeId}','${policy.host.machineIdSha256}','office','${providerId}','${policySha256}',${guestCpuMillis},4294967296);
 insert into public.qorpera_runtime_computer_host_keys(node_id,provider_kind,provider_id,policy_sha256,machine_id_sha256,bootstrap_sha256,cpu_millis,memory_bytes,backend,key_sha256)
 values('${nodeId}','office','${providerId}','${policySha256}','${policy.host.machineIdSha256}','${context.bootstrapSha256}',${guestCpuMillis},4294967296,'lxd','${hash(executor)}');
 select public.qorpera_map_computer_billing_customer('30000000-0000-4000-8000-000000000001','cus_PhysicalAcceptance');
 do $$ declare t timestamptz:=clock_timestamp()-interval '1 day'; begin
 perform public.qorpera_reconcile_computer_subscription('evt_PhysicalAcceptance',t,jsonb_build_object('subscriptionId','sub_PhysicalAcceptance','customerId','cus_PhysicalAcceptance','userId','30000000-0000-4000-8000-000000000001','planKey','basis','planVersion',1,'status','active','periodStart',t,'periodEnd',t+interval '1 month'));
 perform public.qorpera_fund_computer_invoice(jsonb_build_object('invoiceId','in_PhysicalAcceptance','subscriptionId','sub_PhysicalAcceptance','customerId','cus_PhysicalAcceptance','planKey','basis','planVersion',1,'periodStart',t,'periodEnd',t+interval '1 month','amountPaid',18500,'billingReason','subscription_create','status','paid','currency','dkk'));
 end $$;
 ${member} select public.qorpera_set_company_computer_pool('${scope.companyId}',true);
 select public.qorpera_request_runtime_office_start(${literal(scope)},1,'${intentId}');`);
	await mkdir("/etc/qorpera", { recursive: true, mode: 0o755 });
	await writeFile("/etc/qorpera/node-observer.json", `${JSON.stringify({ registryUrl, policy: inventoryPolicy })}\n`, { flag: "wx", mode: 0o444 });
	await writeFile("/etc/qorpera/node-observer.key", tokens.provider, { flag: "wx", mode: 0o440 }); await chown("/etc/qorpera/node-observer.key", 0, 1100);
	await mkdir("/var/lib/qorpera-computer-usage", { mode: 0o700 }); await chown("/var/lib/qorpera-computer-usage", 1100, 1100);
	phase = "node_inventory";
	observer = child("runuser", ["-u", account, "--", process.execPath, `${root}/tools.mjs`, "observer"], () => {}, { NODE_EXTRA_CA_CERTS: ca.path });
	await until(() => query(`select count(*) from public.qorpera_runtime_node_observations where node_id='${nodeId}' and observation->>'state'='ready';`), (value) => value === "1", 30000, "actual node inventory");
	evidence.checks.actualNodeInventory = true;
	await build({ absWorkingDir: repository, entryPoints: ["deploy/runtime-computers/paid-computer-guard.ts"], outfile: `${root}/guard.mjs`, bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent",
		banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
	const guardSource = await readFile(join(repository, "deploy/runtime-computers/qorpera-computer-guard.service.in"), "utf8");
	const guardUnit = guardSource.replaceAll("@PROVIDER@", "office").replaceAll("@ACCOUNT@", account).replace("/usr/bin/node /opt/qorpera/computer-guard/qorpera-runtime-computer-guard.mjs", `${process.execPath} ${root}/guard.mjs`);
	await writeFile(`/etc/systemd/system/${unit}`, guardUnit, { flag: "wx", mode: 0o644 }); guardInstalled = true;
	run("systemctl", ["daemon-reload"]); run("systemctl", ["start", unit]);
	const registryCredential = await protectedFile("registry.key", tokens.provider, true);
	const executorCredential = await protectedFile("executor.key", executor, true);
	await protectedFile("service.json", { schema: "qorpera.lxd-office-provider-service/v1", policyPath: `${root}/policy.json`, provenancePath: `${root}/provenance.json`, planPath: `${root}/plan.json`, registryUrl, registryCredential,
		inventoryLimits: { maxEntries: 1000, maxDepth: 20, maxFileBytes: 1024 ** 2, maxTotalBytes: 8 * 1024 ** 2, maxManifestBytes: 1024 ** 2 }, pollIntervalMs: 1000, idleMs: 3600000,
		computerExecutorCredentialPath: executorCredential.path, outageImagePackageManifestPath: `${root}/image-manifest.json`,
		resetImagePackageManifestPath: `${root}/image-manifest.json`, codePackageLanePath: `${root}/reset-lane/lane-document.json` });
	phase = "initial_admission"; provider = startProvider(ca.path);
	const reviewed = await until(() => {
		assert(provider.exitCode === null && provider.signalCode === null, "OFFICE_ACCEPTANCE_PROVIDER_EXITED");
		assert(evidence.observations.at(-1)?.state !== "startup_failed", "OFFICE_ACCEPTANCE_PROVIDER_STARTUP_FAILED");
		return evidence.observations.at(-1);
	}, (value) => value?.state === "awaiting_review", 90000, "creation and inventory");
	const creation = JSON.parse(await readFile(`${journal}/intent-${intentId}.json`, "utf8"));
	machineName = `qorpera-office-${creation.binding.allocationId.replaceAll("-", "")}`;
	const observation = JSON.parse(await readFile(`${journal}/inventory-${reviewed.observationSha256}.json`, "utf8"));
	await protectedFile("review-input.json", { binding: creation.binding, observation });
	const review = JSON.parse(tool("review", `${root}/review-input.json`));
	await protectedFile("maintenance.json", review.maintenanceBytes); await protectedFile("review.json", review.review);
	const credentials = { registry: await protectedFile("guest-registry.key", tokens.guest, true), native: await protectedFile("native.key", randomBytes(48).toString("base64url"), true),
		objects: await protectedFile("objects.key", randomBytes(48).toString("base64url"), true), tlsCert: await protectedFile("guest.pem", await readFile(trust.serverCertificatePath), true), tlsKey: await protectedFile("guest-key.pem", await readFile(trust.serverPrivateKeyPath), true) };
	await protectedFile("bootstrap.json", { schema: "qorpera.lxd-office-service-bootstrap/v1", providerBindingSha256: review.providerBindingSha256, registryUrl, captureObjectGatewayUrl: registryUrl,
		native: { host: "0.0.0.0", port: 9443 }, viewer: { host: "0.0.0.0", port: 9444, origins: [registryUrl] }, credentials });
	await protectedFile("plan.json", { schema: "qorpera.lxd-office-lifecycle-plan/v1", request: { intentId, observationSha256: reviewed.observationSha256,
		input: review.input, reviewPath: `${root}/review.json`, writerFencePath: `${root}/maintenance.json`, serviceBootstrapPath: `${root}/bootstrap.json` } });
	await until(() => evidence.observations.at(-1), (value) => value?.state === "active", 240000, "actual guest activation");
	const activations = () => query(`select coalesce(jsonb_agg(jsonb_build_object('activationId',activation_id,'state',state,'invocation',service_invocation_id,'attestation',attestation,'superseded',superseded_at is not null) order by activated_at nulls last,activation_id),'[]') from public.qorpera_runtime_office_activations where office_id='${scope.companyComputerId}';`).then(JSON.parse);
	const before = await activations(); assert.equal(before.length, 1); assert.equal(before[0].state, "active");
	evidence.checks.initialActivation = before[0];
	const physical = JSON.parse(run("lxc", ["query", `/1.0/instances/${machineName}`]));
	evidence.physicalInstanceId = physical.config["volatile.uuid"];
	evidence.physicalInstanceIds = [evidence.physicalInstanceId];
	// Retained file goes into the adopted company-owned workbench after adoption.
	const sentinel = join(workbench, review.plan.destinationName, "workbench", "physical-acceptance.txt");
	const sentinelContents = `Company workbench retained across boot and root replacement: ${randomUUID()}`;
	const sentinelInput = await protectedFile("sentinel.txt", sentinelContents);
	run("runuser", ["-u", account, "--", "cp", sentinelInput.path, sentinel]);
	const assertWorkbench = () => assert.equal(run("runuser", ["-u", account, "--", "cat", sentinel]), sentinelContents);
	await delay(20000);
	phase = "forced_outage"; await stop(provider); provider = undefined;
	await until(() => JSON.parse(run("lxc", ["query", `/1.0/instances/${machineName}/state`])).status, (value) => value === "Stopped", 330000, "guard forced physical shutdown");
	evidence.checks.guardStoppedWithoutProvider = true;
	phase = "outage_recovery"; provider = startProvider(ca.path);
	await until(activations, (value) => value.length === 2 && value[1].state === "active" && value[0].superseded, 240000, "outage successor activation");
	const after = await activations();
	assert.notEqual(after[0].invocation, after[1].invocation); assert.notEqual(after[0].attestation.bootId, after[1].attestation.bootId);
	assert.equal(JSON.parse(run("lxc", ["query", `/1.0/instances/${machineName}`])).config["volatile.uuid"], evidence.physicalInstanceId);
	// root_squash deliberately prevents host root from traversing this export.
	assertWorkbench();
	evidence.checks.outageRecovery = { predecessorSuperseded: true, freshBoot: true, freshInvocation: true, samePhysicalVm: true, retainedWorkbench: true };
	phase = "replay"; await stop(provider); provider = startProvider(ca.path); await delay(15000);
	assert.deepEqual(await activations(), after);
	evidence.checks.providerRestartDidNotDuplicateActivation = true;
	// Author ordinary protected lifecycle plans from the actual current SQL
	// activation. Every stop acknowledgement, resume boot and reset receipt is
	// produced by the real provider/guest protocol, never inserted as a fixture.
	const currentIdentity = async () => {
		const value = JSON.parse(await query(`${service} select public.qorpera_runtime_office_provider_activation(${literal(scope)},1,'${providerId}','${policySha256}');`));
		assert.equal(value.officeState, "active"); assert(value.activation);
		return value.activation;
	};
	const balance = () => query("select jsonb_agg(jsonb_build_object('id',id,'reserved',reserved_us::text,'debited',debited_us::text) order by id) from public.qorpera_computer_allowance_buckets;");
	const lifecycleRequest = async (action) => ({ schema: "qorpera.office-lifecycle-request/v1", transitionId: randomUUID(), action, ...await currentIdentity() });
	const completedRecovery = async (request) => until(async () => {
		try { return JSON.parse(await readFile(`${journal}/recovery-active-${request.transitionId}.json`, "utf8")); }
		catch (error) { if (error.code === "ENOENT") return null; throw error; }
	}, value => isDeepStrictEqual(value, request), 30000, "durable recovery completion");
	const archivePlans = async (transitionId) => {
		for (const suffix of ["recovery", "resume"]) {
			try { await rename(`${root}/plan.json.${suffix}`, `${root}/completed-${transitionId}.${suffix}`); }
			catch (error) { if (error.code !== "ENOENT") throw error; }
		}
	};
	phase = "ordinary_power_off";
	await stop(provider); provider = undefined;
	const powerOff = await lifecycleRequest("power_off");
	await protectedFile("plan.json.recovery", { schema: "qorpera.lxd-office-recovery-plan/v1", request: powerOff });
	provider = startProvider(ca.path);
	await until(() => evidence.observations.at(-1), value => value?.state === "powered_off" && value.transitionId === powerOff.transitionId, 180000, "governed power-off");
	assert.equal(JSON.parse(run("lxc", ["query", `/1.0/instances/${machineName}/state`])).status, "Stopped");
	await until(() => query("select count(*) from public.qorpera_coding_computer_permits where state<>'closed';"), value => value === "0", 30000, "ordinary stopped settlement");
	const sleepingBalance = await balance();
	await delay(20000);
	assert.equal(await balance(), sleepingBalance, "Sleeping office changed paid balance");
	assert.equal(JSON.parse(run("lxc", ["query", `/1.0/instances/${machineName}/state`])).status, "Stopped");
	evidence.checks.ordinaryPowerOffAndSleepUncharged = true;
	phase = "ordinary_resume";
	const powerSuffix = `${powerOff.startup.allocationId}-${powerOff.transitionId}`;
	const stopHistory = await readFile(`${journal}/power-off-history-${powerSuffix}.json`);
	const powerCompletion = await readFile(`${journal}/power-off-completed-${powerSuffix}.json`);
	const resume = { schema: "qorpera.office-boot-intent-request/v1", bootIntentId: randomUUID(), activationId: randomUUID(),
		predecessor: powerOff, stopHistorySha256: hash(stopHistory), powerOffCompletionSha256: hash(powerCompletion) };
	await protectedFile("plan.json.resume", { schema: "qorpera.lxd-office-resume-plan/v1", request: resume });
	await until(activations, value => value.some(row => row.activationId === resume.activationId && row.state === "active" && !row.superseded), 240000, "ordinary resumed activation");
	const resumed = await currentIdentity();
	assert.equal(resumed.activationId, resume.activationId);
	assert.notEqual(resumed.startup.bootId, powerOff.startup.bootId);
	assert.equal(JSON.parse(run("lxc", ["query", `/1.0/instances/${machineName}`])).config["volatile.uuid"], evidence.physicalInstanceId);
	assertWorkbench();
	evidence.checks.ordinaryResumeRetainedVmAndWorkbench = true;
	await completedRecovery(powerOff);
	phase = "ordinary_service_restart";
	await stop(provider); provider = undefined;
	await archivePlans(powerOff.transitionId);
	const restart = await lifecycleRequest("service_restart");
	await protectedFile("plan.json.recovery", { schema: "qorpera.lxd-office-recovery-plan/v1", request: restart });
	provider = startProvider(ca.path);
	await until(async () => { const value = await currentIdentity().catch(() => null); return value; }, value => value && value.activationId !== restart.activationId, 180000, "ordinary service successor");
	const restarted = await currentIdentity();
	assert.equal(restarted.startup.bootId, restart.startup.bootId);
	assert.notEqual(restarted.startup.serviceInvocationId, restart.startup.serviceInvocationId);
	assert.equal(JSON.parse(run("lxc", ["query", `/1.0/instances/${machineName}`])).config["volatile.uuid"], evidence.physicalInstanceId);
	evidence.checks.ordinaryServiceRestartRetainedVm = true;
	await completedRecovery(restart);
	phase = "ordinary_root_reset";
	await stop(provider); provider = undefined;
	await archivePlans(restart.transitionId);
	const replace = await lifecycleRequest("replace");
	const predecessor = (await activations()).find(row => row.activationId === replace.activationId);
	assert(predecessor && !predecessor.superseded);
	const reset = { schema: "qorpera.lxd-office-reset-plan/v1", resetId: randomUUID(), intentId, predecessor: replace,
		preparationObservationSha256: predecessor.attestation.preparationObservationSha256, providerBindingSha256: review.providerBindingSha256,
		nodeId, predecessorRootIncarnationId: null, rootIncarnationId: randomUUID(), successorActivationId: randomUUID(),
		commands: { stopCommandId: randomUUID(), deleteCommandId: randomUUID(), createCommandId: randomUUID(), startCommandId: randomUUID() },
		custody: { archiveRoot: custodyRoot } };
	await protectedFile("plan.json.reset", reset);
	// Provision the real signed package lane, using the measured base image's
	// receipt and the exact current package. No fake installation/measurement
	// record is inserted: the worker must install and attest the new root.
	const imageWork = dirname(context.packageRoot), lane = `${root}/reset-lane`, tools = `${root}/reset-tools`;
	const bundle = JSON.parse(await query("select jsonb_build_object('version',b.version,'sha256',b.sha256) from public.qorpera_active_runtime_bundle a join public.qorpera_runtime_bundles b on b.id=a.runtime_bundle_id where a.singleton;"));
	const softwareRevision = await query(`select coalesce(software_revision::text,'null') from public.qorpera_runtime_office_activations where activation_id='${replace.activationId}';`);
	assert.equal(softwareRevision, "null", "Unexpected software update before first root reset");
	run(process.execPath, ["scripts/package-office-code-package-control.mjs", "--out", tools], 120000);
	const capability = randomBytes(32).toString("hex");
	const provision = JSON.parse(run(process.execPath, ["scripts/prepare-office-code-package-provision.mjs",
		"--base-manifest", `${context.packageRoot}/manifest.json`, "--target-package", context.packageRoot,
		"--installation-receipt", `${imageWork}/base-installation-receipt.json`, "--mount-template", `${context.packageRoot}/qorpera-office-private.mount.in`,
		"--tools", tools, "--reset-plan", `${root}/plan.json.reset`, "--policy", `${root}/policy.json`, "--private-key", `${imageWork}/reset-signing.key`,
		"--base-source-commit", process.env.GITHUB_SHA, "--target-source-commit", process.env.GITHUB_SHA,
		"--runtime-bundle-version", String(bundle.version), "--runtime-bundle-sha256", bundle.sha256,
		"--expected-software-revision", "null", "--target-revision", "1",
		"--evidence-sha256", hash(await readFile(join(dirname(context.provenancePath), "image-trust-evidence.json"))),
		"--lane-root", lane, "--capability-sha256", hash(capability), "--out", `${root}/reset-provision`], 120000));
	await mkdir(lane, { mode: 0o755 });
	await cp(context.packageRoot, `${lane}/artifacts`, { recursive: true });
	await cp(tools, `${lane}/tools`, { recursive: true });
	run("chmod", ["-R", "a+rX,go-w", lane]);
	await chmod(`${lane}/tools`, 0o755);
	for (const name of ["envelope.json", "plan.json", "lane-document.json"]) await protectedFile(`reset-lane/${name}`, await readFile(`${root}/reset-provision/${name}`));
	for (const [name, source] of [["base-manifest.json", `${context.packageRoot}/manifest.json`], ["target-manifest.json", `${context.packageRoot}/manifest.json`],
		["base-installation-receipt.json", `${imageWork}/base-installation-receipt.json`], ["base-mount-template", `${context.packageRoot}/qorpera-office-private.mount.in`]])
		await protectedFile(`reset-lane/${name}`, await readFile(source));
	await protectedFile("reset-lane/package.capability", capability, true);
	await query(`insert into public.qorpera_office_package_capabilities(allocation_id,provider_id,provider_policy_sha256,capability_sha256,revision,enabled)
		values('${replace.startup.allocationId}','${providerId}','${policySha256}','${hash(capability)}',1,true);`);
	evidence.resetProvision = { provisionId: provision.provisionId, statementSha256: provision.statementSha256, planSha256: provision.planSha256, sameCodePackage: provision.changedArtifacts.length === 0 };
	await protectedFile("plan.json.recovery", { schema: "qorpera.lxd-office-recovery-plan/v1", request: replace });
	provider = startProvider(ca.path);
	await until(activations, value => value.some(row => row.activationId === reset.successorActivationId && row.state === "active" && !row.superseded), 360000, "ordinary root replacement activation");
	const replacement = await currentIdentity();
	assert.equal(replacement.activationId, reset.successorActivationId);
	assert.notEqual(replacement.startup.bootId, replace.startup.bootId);
	const replacementPhysicalId = JSON.parse(run("lxc", ["query", `/1.0/instances/${machineName}`])).config["volatile.uuid"];
	assert.notEqual(replacementPhysicalId, evidence.physicalInstanceId);
	evidence.physicalInstanceIds.push(replacementPhysicalId);
	assertWorkbench();
	evidence.checks.ordinaryResetReplacedRootAndRetainedWorkbench = true;
	await completedRecovery(replace);
	await delay(15000);
	// Stop the ordinary provider, then transfer custody to the same real paid
	// controller under its existing flock. Settle the successor only after the
	// independent guard confirms the actual physical VM is stopped.
	await stop(provider); provider = undefined;
	phase = "successor_settlement";
	metering = child("runuser", ["-u", account, "--", "flock", "--no-fork", `${journal}/adoption.lock`, process.execPath, `${root}/tools.mjs`,
		"finish-usage", `${root}/service.json`, `${journal}/intent-${intentId}.json`], (line) => { evidence.finalPhysicalUsage = JSON.parse(line); }, { NODE_EXTRA_CA_CERTS: ca.path });
	await until(() => metering.exitCode !== null || metering.signalCode !== null, Boolean, 90000, "successor physical stop and settlement");
	assert.equal(metering.exitCode, 0, "Successor metering process failed");
	assert(evidence.finalPhysicalUsage?.closed && evidence.finalPhysicalUsage.stopReceipt, "Successor stop receipt missing");
	assert.equal(JSON.parse(run("lxc", ["query", `/1.0/instances/${machineName}/state`])).status, "Stopped");
	const permits = JSON.parse(await query("select jsonb_agg(jsonb_build_object('id',id,'state',state) order by id) from public.qorpera_coding_computer_permits;"));
	assert(permits.length >= 2 && permits.every((permit) => permit.state === "closed"), "Every physical epoch must settle");
	evidence.usageReconciliation = [];
	let totalDebit = 0n;
	for (const permit of permits) {
		const accounting = await readWorkloadUsage(query, permit.id);
		const ids = new Set(accounting.samples.map((sample) => sample.sample.observationId));
		const samples = physicalSamples.filter((entry) => entry.permitId === permit.id && ids.has(entry.sample.observationId)).map((entry) => entry.sample);
		const first = samples.find((sample) => sample.state === "running");
		assert(first, "No actual office guest clock was sampled");
		assert(evidence.physicalInstanceIds.includes(first.physicalId), "Metered VM was not independently observed by the lifecycle harness");
		evidence.usageReconciliation.push(verifyWorkloadUsage(accounting, { kind: "company_computer", shape: { cpuMillis: guestCpuMillis, memoryBytes: 4294967296 },
			shapeProvenance: { nodeId, providerKind: "office", policySha256 },
			physicalId: first.physicalId, hostBootId: first.hostBootId, guestBootId: first.guestBootId,
			physicalSamples: samples, closed: true }));
		totalDebit += BigInt(evidence.usageReconciliation.at(-1).debitedUs);
	}
	evidence.accounting = JSON.parse(await query("select jsonb_build_object('buckets',(select jsonb_agg(jsonb_build_object('issuedUs',issued_us::text,'reservedUs',reserved_us::text,'debitedUs',debited_us::text)) from public.qorpera_computer_allowance_buckets),'permits',(select count(*) from public.qorpera_coding_computer_permits));"));
	assert(evidence.accounting.buckets.every((bucket) => bucket.reservedUs === "0"), "Stopped offices retained allowance holds");
	assert.equal(evidence.accounting.buckets.reduce((sum, bucket) => sum + BigInt(bucket.debitedUs), 0n), totalDebit, "Global balance differs from all measured office epochs");
	evidence.checks.allPhysicalEpochsSettled = true;
	evidence.passed = true;
} catch (error) {
	evidence.failurePhase = phase; evidence.error = String(error); process.exitCode = 1;
	// Diagnostics remain root-private on the ephemeral runner and are never an artifact.
	if (fixtureCreated) await writeFile(`${root}/private-process-errors`, [provider, observer, metering, pg].map((processChild) => processChild?.privateDiagnostics() ?? "").join("\n"), { mode: 0o600 });
} finally {
	try {
		await stop(provider); await stop(metering); await stop(observer);
		if (guardInstalled) run("systemctl", ["stop", unit]);
		if (machineName) run("lxc", ["delete", machineName, "--force"], 60000);
		assert.deepEqual(JSON.parse(run("lxc", ["list", "--all-projects", "--format=json"])), [], "An unfinished VM must not be reported as cleaned up");
		await rpc?.close(); await stop(pg);
		if (mounted) run("umount", [workbench]);
		if (journalMounted) run("umount", [journal]);
		if (exported) { await unlink("/etc/exports.d/qorpera-office-lifecycle-acceptance.exports"); run("exportfs", ["-ra"]); }
		if (fixtureCreated) await rm(storage, { recursive: true });
		evidence.cleanup = true;
	} catch { evidence.cleanup = false; evidence.passed = false; process.exitCode = 1; }
	await writeFile(join(out, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
	console.log(JSON.stringify(evidence));
}
