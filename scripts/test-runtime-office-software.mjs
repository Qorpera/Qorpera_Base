// Fresh, network-disabled PostgreSQL only. Protected filesystem/signature and
// invocation measurements are explicit synthetic inputs, never live evidence.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
assert(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--unenrolled"), "Usage: test-runtime-office-software.mjs [--unenrolled]");
const container = `qorpera-office-software-${randomBytes(6).toString("hex")}`;
const psql = ["exec", "-i", container, "psql", "-X", "-qAt", "-U", "postgres", "-d", "software", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"];
const text = (value) => `'${String(value).replaceAll("'", "''")}'`;
const json = (value) => `${text(JSON.stringify(value))}::jsonb`;
const canonical = (value) => JSON.stringify(value, function (_key, next) {
	return next && typeof next === "object" && !Array.isArray(next) ? Object.fromEntries(Object.keys(next).sort().map(key => [key, next[key]])) : next;
});
const digest = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const hash = () => randomBytes(32).toString("hex");
let capability = hash();
const service = `set request.jwt.claims='{"role":"service_role"}'; set role service_role;`;
const owner = `set request.jwt.claims='{"role":"authenticated","sub":"30000000-0000-4000-8000-000000000001"}'; set role authenticated;`;
const children = new Set();
function docker(args, input) {
	const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 ** 2 });
	assert(!result.error && result.status === 0, `${result.stderr || result.error}\n${result.stdout ?? ""}`);
	return result.stdout.trim();
}
const query = sql => docker(psql, sql);
const call = (sql, actor = service) => JSON.parse(query(`${actor} ${sql}`).split("\n").at(-1));
function session() {
	const child = spawn("docker", psql); children.add(child);
	let output = "", error = "";
	child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { error += chunk; });
	const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
	const done = new Promise((resolve, reject) => {
		child.on("error", reject); child.on("close", code => { clearTimeout(timer); children.delete(child); resolve({ code, output: output.trim(), error }); });
	});
	return { child, done, output: () => output };
}
async function until(predicate) {
	const end = Date.now() + 8000;
	while (!predicate()) { assert(Date.now() < end, "Software SQL barrier timed out"); await new Promise(resolve => setTimeout(resolve, 25)); }
}
async function deny(sql, pattern = /42501|QRC01|22023|23505/, actor = service) {
	const next = session(); next.child.stdin.end(`${actor} ${sql}`); const result = await next.done;
	assert.notEqual(result.code, 0, "Unexpected software admission"); assert.match(result.error, pattern);
	assert.doesNotMatch(result.error, /does not exist|syntax error/); return result;
}
let started = false;
try {
	docker(["run", "-d", "--rm", "--name", container, "--network", "none", "--pull", "never", "-e", "POSTGRES_PASSWORD=disposable-only", "-e", "POSTGRES_DB=software", POSTGRES_IMAGE]); started = true;
	let ready = 0;
	for (let i = 0; i < 60 && ready < 2; i++) {
		ready = spawnSync("docker", ["exec", container, "pg_isready", "-U", "postgres", "-d", "software"], { timeout: 2000 }).status === 0 ? ready + 1 : 0;
		if (ready < 2) await new Promise(resolve => setTimeout(resolve, 500));
	}
	assert.equal(ready, 2); query(readFileSync(join(root, "supabase/tests/bootstrap.sql"), "utf8"));
	const migrations = sortMigrationNames(readdirSync(join(root, "supabase/migrations")));
	for (const name of migrations) query(readFileSync(join(root, "supabase/migrations", name), "utf8"));
	console.log(`PASS ${migrations.length} migrations in fresh network-disabled PostgreSQL`);
	const wake = readFileSync(join(root, "supabase/tests/300_runtime_wake_bus.test.sql"), "utf8").split("-- END WAKE FIXTURE");
	const office = readFileSync(join(root, "supabase/tests/fixtures/runtime-office-registry-cases.sql"), "utf8").split("-- Synthetic guest readiness only.");
	assert.equal(wake.length, 2); assert.equal(office.length, 2);
	const setup = JSON.parse(query(`${wake[0]} ${office[0]}
		set local role service_role; select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress');
		select jsonb_build_object('scope',current_setting('qorpera_test.office_scope')::jsonb,'binding',current_setting('qorpera_test.wake_binding')::jsonb); commit;`).split("\n").at(-1));
	const scope = setup.scope;
	const providerId = randomUUID(), policy = "f".repeat(64), allocationId = randomUUID(), instance = hash(), binding = hash();
	call(`select public.qorpera_set_runtime_office_provider(${json(scope)},1,'${providerId}','${policy}',0,true);`);
	const intent = call(`select public.qorpera_request_runtime_office_start(${json(scope)},1,'${randomUUID()}');`, owner).intentId;
	call(`select public.qorpera_reserve_runtime_office_start(${json(scope)},1,'${intent}','${allocationId}','${instance}','${"a".repeat(64)}','${"b".repeat(64)}','${binding}','${providerId}','${policy}');`);
	const attestation = { schema: "qorpera.office-activation-attestation/v1", activationId: randomUUID(), bootId: randomUUID(), preparationObservationSha256: hash(), configurationObservationSha256: hash(), configurationSha256: hash(), adoptionReceiptSha256: hash(), nativePort: 9443, viewerPort: 9444 };
	let startup = { scope, computerGeneration: 1, allocationId, instanceSha256: instance, imageSha256: "a".repeat(64), bootstrapSha256: "b".repeat(64), bootId: attestation.bootId, configurationSha256: attestation.configurationSha256, serviceInvocationId: randomBytes(16).toString("hex") };
	const readySql = (value = startup, id = attestation.activationId) => `select public.qorpera_report_runtime_office_ready(${json(value)},'${id}',9443,9444);`;
	const activateSql = (id, value = startup) => `select public.qorpera_activate_runtime_office(${json(scope)},1,'${intent}','${id}','${providerId}','${policy}','${value.serviceInvocationId}');`;
	call(`select public.qorpera_prepare_runtime_office_activation(${json(scope)},1,'${intent}','${allocationId}','${instance}','${binding}','${providerId}','${policy}','[]',${json(attestation)});`);
	call(readySql()); assert.equal(call(activateSql(attestation.activationId)).state, "active");
	call(`select public.qorpera_native_office_screen(${json(setup.binding)},${json(scope)},'acquire',null);`);
	const profileId = randomUUID();
	query(`insert into public.qorpera_runtime_browser_profiles(id,office_id,owner_user_id,prepared,verified_version) values('${profileId}','${scope.companyComputerId}','30000000-0000-4000-8000-000000000001',true,1);`);
	const preservedProfile = query(`select to_jsonb(p) from public.qorpera_runtime_browser_profiles p where id='${profileId}';`);
	console.log("PASS ordinary unenrolled activation retains its existing semantics");
	const stop = (activationId, value, action = "service_restart") => {
		const predecessor = { schema: "qorpera.office-lifecycle-request/v1", transitionId: randomUUID(), action, activationId, providerId, providerPolicySha256: policy, startup: value };
		const transition = call(`select public.qorpera_begin_runtime_office_lifecycle(${json(predecessor)});`);
		const command = { commandId: randomUUID(), requestSha256: digest(predecessor), bootId: value.bootId }, nonce = randomUUID(), startHash = hash();
		call(`select public.qorpera_prepare_runtime_office_stop(${json(predecessor)},${json(command)},'${nonce}','${startHash}');`);
		const inspection = { schema: "qorpera.office-service-stop-inspection/v1", inspectionId: nonce, cgroupState: "empty", stop: {
			schema: "qorpera.office-service-stop-completion/v1", command, transitionId: predecessor.transitionId, activationId, revocationRevision: transition.revocationRevision,
			configurationSha256: value.configurationSha256, startCompletionSha256: startHash, fromServiceInvocationId: value.serviceInvocationId,
			observedInvocationId: value.serviceInvocationId, stoppedInvocationId: value.serviceInvocationId, controlGroup: "/system.slice/qorpera-company-computer.service", cgroupState: "empty",
		} };
		return { predecessor, acknowledgement: call(`select public.qorpera_ack_runtime_office_stop(${json(predecessor)},${json(inspection)});`) };
	};
	if (process.argv[2] === "--unenrolled") {
		let previous = attestation;
		for (const boot of [false, true]) {
			const stopped = stop(previous.activationId, startup, boot ? "reboot" : "service_restart");
			const next = { ...previous, activationId: randomUUID(), ...(boot ? { bootId: randomUUID(), configurationSha256: hash(), configurationObservationSha256: hash(), adoptionReceiptSha256: hash() } : {}) };
			const request = { schema: boot ? "qorpera.office-boot-successor-request/v1" : "qorpera.office-service-successor-request/v1", predecessor: stopped.predecessor, attestation: next };
			if (boot) {
				Object.assign(request, { bootIntentId: randomUUID(), stopHistorySha256: hash(), powerOffCompletionSha256: hash(), bootObservationSha256: hash() });
				call(`select public.qorpera_prepare_runtime_office_boot_intent(${json({ schema: "qorpera.office-boot-intent-request/v1", bootIntentId: request.bootIntentId, activationId: next.activationId, predecessor: request.predecessor, stopHistorySha256: request.stopHistorySha256, powerOffCompletionSha256: request.powerOffCompletionSha256 })});`);
			}
			call(`select public.qorpera_prepare_runtime_office_${boot ? "boot_" : ""}successor(${json(request)});`);
			startup = { ...startup, bootId: next.bootId, configurationSha256: next.configurationSha256, serviceInvocationId: randomBytes(16).toString("hex") };
			call(readySql(startup, next.activationId)); assert.equal(call(activateSql(next.activationId)).state, "active"); previous = next;
		}
		assert.equal(query("select count(*) from public.qorpera_runtime_office_activations where software_revision is null;"), "3");
		assert.equal(query("select count(*) from public.qorpera_office_software_provider_capabilities;"), "0");
		assert.equal(query("select count(*) from public.qorpera_office_software_baselines;"), "0");
		assert.equal(query(`select to_jsonb(p) from public.qorpera_runtime_browser_profiles p where id='${profileId}';`), preservedProfile);
		console.log("PASS unenrolled same-boot and new-boot successors remain callable without software enrollment/capability/measurement; original profile and one allocation retained");
	} else {
	const stopped = stop(attestation.activationId, startup);
	const original = JSON.parse(query(`select to_jsonb(a) from public.qorpera_runtime_office_activations a where activation_id='${attestation.activationId}';`));
	const artifact = { path: "/opt/qorpera-office/qorpera-company-computer-service.mjs", bytes: 123456, sha256: hash() };
	const current = { packageManifestSha256: hash(), sourceCommit: "1".repeat(40), service: artifact };
	const base = { imageSha256: startup.imageSha256, bootstrapSha256: startup.bootstrapSha256, packageManifestSha256: current.packageManifestSha256, sourceCommit: current.sourceCommit };
	const enrollmentHash = hash();
	const enroll = (b = base, cap = capability) => `select public.qorpera_enroll_office_software(${json(stopped.predecessor)},${json(b)},${json(current)},'${enrollmentHash}',${cap === null ? "null" : text(cap)});`;
	await deny(enroll(), /capability unavailable/);
	// Protected operator-only capability enrollment; ordinary service_role has
	// neither table access nor a provisioning RPC. Only the digest is retained.
	const capHash = createHash("sha256").update(capability).digest("hex");
	const provision = `insert into public.qorpera_office_software_provider_capabilities values('${allocationId}','${providerId}','${policy}','${capHash}',1,true);`;
	await deny(provision, /42501/); query(provision);
	await deny(enroll(base, null), /capability required/); await deny(enroll(base, hash()), /capability unavailable/);
	await deny(`select public.qorpera_require_office_software_capability('${allocationId}','${capability}',false);`, /42501/);
	await deny(enroll(), /42501/, owner); await deny(enroll({ ...base, imageSha256: hash() }));
	assert.equal(call(enroll()).revision, 0); assert.equal(call(enroll()).revision, 0);
	const statement = { schema: "qorpera.office-service-software-statement/v1", base, previous: current, next: { packageManifestSha256: hash(), service: { ...artifact, bytes: 123457, sha256: hash() } }, source: { repository: "https://github.com/Qorpera/Qorpera_Base/", commit: "2".repeat(40), tree: "clean" }, acceptance: { testedAt: new Date(Date.now() - 1000).toISOString(), evidenceSha256: hash(), change: "service-only" } };
	const plan = { schema: "qorpera.office-service-software-plan/v1", updateId: randomUUID(), predecessor: stopped.predecessor, stopAcknowledgementSha256: digest(stopped.acknowledgement), successorActivationId: randomUUID(), statementSha256: digest(statement) };
	const begin = (p = plan, s = statement, revision = 0, ack = stopped.acknowledgement) => `select public.qorpera_begin_office_software(${text(canonical(p))},${text(canonical(s))},'${digest(p)}',${revision},${text(canonical(ack))},'${capability}');`;
	for (const changed of [{ ...plan, extra: true }, { ...plan, stopAcknowledgementSha256: hash() }, { ...plan, statementSha256: hash() }, { ...plan, successorActivationId: plan.predecessor.activationId }]) await deny(begin(changed));
	await deny(begin(plan, statement, 1), /QRC01/);
	for (const s of [
		{ ...statement, previous: { ...current, sourceCommit: "9".repeat(40) } },
		{ ...statement, next: { ...statement.next, service: artifact } },
		{ ...statement, source: { ...statement.source, tree: "dirty" } },
		{ ...statement, base: { ...base, packageManifestSha256: hash() } },
		{ ...statement, next: { ...statement.next, service: { ...statement.next.service, bytes: "123457" } } },
	]) await deny(begin({ ...plan, statementSha256: digest(s) }, s));
	await deny(begin(plan, statement, 0, { ...stopped.acknowledgement, acknowledgedAtMs: 1 }));
	// Guest-code revisions: both inventories list the same closed entries; the declared change kind and the
	// "something must change" rule follow the lists; unknown entries, foreign paths or modes are refused.
	const entry = (file, path, mode, bytes = 100, sha256 = hash()) => ({ file, path, bytes, sha256, mode });
	const prevFiles = [entry("qorpera-company-computer-configuration-control.mjs", "/opt/qorpera-office/qorpera-company-computer-configuration-control.mjs", 292), entry("qorpera-screen-session", "/usr/local/bin/qorpera-screen-session", 365)];
	const nextFiles = prevFiles.map(f => ({ ...f, bytes: 101, sha256: hash() }));
	const guest = { ...statement, previous: { ...current, files: prevFiles }, next: { ...statement.next, files: nextFiles }, acceptance: { ...statement.acceptance, change: "guest-code" } };
	const guestPlan = (s) => ({ ...plan, updateId: randomUUID(), successorActivationId: randomUUID(), statementSha256: digest(s) });
	assert.match(query(`${service} begin; ${begin(guestPlan(guest), guest)} rollback;`), /"begun"/);
	const sameService = { ...guest, next: { ...guest.next, service: artifact } };
	assert.match(query(`${service} begin; ${begin(guestPlan(sameService), sameService)} rollback;`), /"begun"/);
	for (const s of [
		{ ...guest, acceptance: statement.acceptance },
		{ ...guest, previous: current },
		{ ...guest, next: { ...guest.next, files: [nextFiles[0]] } },
		{ ...guest, next: { ...guest.next, files: [{ ...nextFiles[0], path: "/opt/qorpera-office/other.mjs" }, nextFiles[1]] } },
		{ ...guest, next: { ...guest.next, files: [{ ...nextFiles[0], mode: 420 }, nextFiles[1]] } },
		{ ...guest, next: { ...guest.next, files: [{ ...nextFiles[0], file: "qorpera-company-computer.service", path: "/etc/systemd/system/qorpera-company-computer.service", mode: 420 }, nextFiles[1]] } },
		{ ...guest, next: { ...guest.next, files: [nextFiles[0], nextFiles[0]] } },
		{ ...sameService, next: { ...sameService.next, files: prevFiles } },
		{ ...statement, acceptance: { ...statement.acceptance, change: "guest-code" } },
	]) await deny(begin(guestPlan(s), s));
	console.log("PASS guest-code statements are accepted only with matching closed file lists on both inventories and a real change");
	const holder = session(); holder.child.stdin.write(`begin; select public.qorpera_lock_profile_gc_fence('${scope.companyId}'); select 'SOFTWARE_LOCKED';\n`);
	await until(() => holder.output().includes("SOFTWARE_LOCKED"));
	await deny(`set statement_timeout='1s'; ${begin().replaceAll(text(capability), "null")}`, /42501/);
	const first = session(); first.child.stdin.end(`set application_name='software-begin-first'; ${service} ${begin()}`);
	await until(() => query("select count(*) from pg_stat_activity where application_name='software-begin-first' and wait_event_type='Lock';") === "1");
	const second = session(); second.child.stdin.end(`${service} ${begin({ ...plan, updateId: randomUUID(), successorActivationId: randomUUID() })}`);
	holder.child.stdin.end("commit;"); assert.equal((await holder.done).code, 0); assert.equal((await first.done).code, 0); assert.notEqual((await second.done).code, 0);
	assert.equal(call(begin()).state, "begun");
	const successor = { schema: "qorpera.office-service-successor-request/v1", predecessor: stopped.predecessor, attestation: { ...attestation, activationId: plan.successorActivationId } };
	const prepare = r => `select public.qorpera_prepare_runtime_office_successor(${json(r)});`;
	await deny(prepare(successor));
	const receipt = { schema: "qorpera.office-service-software-receipt/v1", plan, planSha256: digest(plan), state: "installed", service: statement.next.service, installedAt: new Date().toISOString() };
	const installHash = hash(); let nonce = randomUUID();
	const inspectInstall = id => `select public.qorpera_check_office_software_install('${plan.updateId}','${id}','${capability}');`;
	const install = (id = nonce, measured = statement.next.service, r = receipt) => `select public.qorpera_ack_office_software_install('${plan.updateId}','${id}',${text(canonical(r))},${json(measured)},'${installHash}','${capability}');`;
	for (const mutation of [
		"update public.qorpera_runtime_office_providers set preparation_enabled=false;",
		"update public.qorpera_runtime_offices set revision=revision+1;",
		"update public.qorpera_runtime_offices set privacy_version=privacy_version+1;",
		"update public.qorpera_runtime_offices set privacy_challenge='{}'::jsonb;",
		"update public.qorpera_runtime_office_screens set drain_pending=true,drain_id=extensions.gen_random_uuid(),drain_acknowledged_at=null;",
	]) await deny(`begin; reset role; ${mutation} ${service} ${inspectInstall(randomUUID())}`);
	const pause = session(); pause.child.stdin.write(`begin; select public.qorpera_lock_profile_gc_fence('${scope.companyId}'); select 'SOFTWARE_PAUSE_LOCKED';\n`);
	await until(() => pause.output().includes("SOFTWARE_PAUSE_LOCKED"));
	const waiting = session(); waiting.child.stdin.end(`set application_name='software-paused-dispatch'; ${service} ${inspectInstall(randomUUID())}`);
	await until(() => query("select count(*) from pg_stat_activity where application_name='software-paused-dispatch' and wait_event_type='Lock';") === "1");
	pause.child.stdin.end(`insert into public.qorpera_company_execution_pauses(profile_id,paused_by_user_id) values('${scope.companyId}','30000000-0000-4000-8000-000000000001'); commit;`);
	assert.equal((await pause.done).code, 0); const refused = await waiting.done; assert.notEqual(refused.code, 0); assert.match(refused.error, /42501/);
	query("delete from public.qorpera_company_execution_pauses;");
	assert.equal(call(`select public.qorpera_office_software_status(${json(plan)},'${capability}');`).state, "begun");
	await deny(install());
	for (const sql of [inspectInstall(nonce), install(), `select public.qorpera_office_software_status(${json(plan)},'${capability}');`]) {
		await deny(sql.replaceAll(text(capability), "null"), /42501/);
		await deny(sql.replaceAll(text(capability), text(hash())), /42501/);
	}
	assert.equal(call(inspectInstall(nonce)).capabilityRevision, 1);
	const previousCapability = capability, rotatedCapability = hash();
	const rotating = session(); rotating.child.stdin.write(`begin; select public.qorpera_lock_profile_gc_fence('${scope.companyId}'); select 'CAPABILITY_ROTATION_LOCKED';\n`);
	await until(() => rotating.output().includes("CAPABILITY_ROTATION_LOCKED"));
	const staleCapability = session(); staleCapability.child.stdin.end(`set application_name='software-capability-rotation'; ${service} ${inspectInstall(nonce)}`);
	await until(() => query("select count(*) from pg_stat_activity where application_name='software-capability-rotation' and wait_event_type='Lock';") === "1");
	rotating.child.stdin.end(`update public.qorpera_office_software_provider_capabilities set capability_sha256='${createHash("sha256").update(rotatedCapability).digest("hex")}',revision=revision+1; commit;`);
	assert.equal((await rotating.done).code, 0); const staleResult = await staleCapability.done;
	assert.notEqual(staleResult.code, 0); assert.match(staleResult.error, /capability unavailable/);
	await deny(install(), /capability unavailable/); capability = rotatedCapability;
	await deny(inspectInstall(nonce), /challenge cannot be rebound/); await deny(install(), /challenge differs/);
	await deny(enroll(base, previousCapability), /capability unavailable/);
	nonce = randomUUID(); assert.equal(call(inspectInstall(nonce)).capabilityRevision, 2); await deny(install(nonce, artifact));
	await deny(install(nonce, statement.next.service, { ...receipt, planSha256: hash() }));
	await deny(`begin; reset role; update public.qorpera_office_software_challenges set issued_at=issued_at-interval '6 seconds',expires_at=expires_at-interval '6 seconds' where id='${nonce}'; ${service} ${install()}`);
	assert.equal(call(install()).state, "installed"); assert.equal(call(install()).state, "installed");
	await deny(`begin; reset role; update public.qorpera_runtime_office_providers set preparation_enabled=false; ${service} ${install()}`);
	await deny(inspectInstall(randomUUID())); await deny(prepare({ ...successor, attestation: { ...successor.attestation, activationId: randomUUID() } }));
	assert.equal(call(prepare(successor)).state, "prepared");
	startup = { ...startup, serviceInvocationId: randomBytes(16).toString("hex") };
	assert.equal(call(`select public.qorpera_check_runtime_office_startup(${json(startup)});`).state, "prepared");
	call(readySql(startup, plan.successorActivationId)); await deny(activateSql(plan.successorActivationId), /measurement unavailable/);
	console.log("PASS exact baseline/plan/stop CAS and install challenge; receipt permits closed startup/readiness but cannot activate");
	const measure = async (activationId, value, expectedService, revision) => {
		const id = randomUUID(), evidence = hash();
		const check = `select public.qorpera_check_office_software_invocation(${json(value)},'${activationId}','${id}','${capability}');`;
		const ack = measured => `select public.qorpera_ack_office_software_invocation(${json(value)},'${activationId}','${id}',${json(measured)},'${evidence}','${capability}');`;
		await deny(ack(expectedService), /challenge absent/);
		await deny(check.replace(text(activationId), "null"), /invocation not ready/);
		for (const sql of [check, ack(expectedService)]) {
			await deny(sql.replaceAll(text(capability), "null"), /42501/);
			await deny(sql.replaceAll(text(capability), text(hash())), /42501/);
		}
		const challenge = call(check); assert.equal(challenge.revision, revision); assert.deepEqual(challenge.service, expectedService); assert.equal(challenge.capabilityRevision, 2);
		await deny(ack(expectedService).replace(text(activationId), "null"), /invocation not ready/);
		await deny(ack({ ...expectedService, sha256: hash() }), /bytes differ/);
		await deny(`select public.qorpera_ack_office_software_invocation(${json({ ...value, serviceInvocationId: randomBytes(16).toString("hex") })},'${activationId}','${id}',${json(expectedService)},'${evidence}','${capability}');`);
		assert.equal(call(ack(expectedService)).state, "measured"); assert.equal(call(ack(expectedService)).state, "measured");
		await deny(`begin; reset role; update public.qorpera_office_software_challenges set issued_at=issued_at-interval '6 seconds',expires_at=expires_at-interval '6 seconds' where id='${id}'; ${service} ${activateSql(activationId, value)}`, /measurement unavailable/);
		await deny(`begin; reset role; update public.qorpera_runtime_office_providers set preparation_enabled=false; ${service} ${activateSql(activationId, value)}`);
		await deny(`begin; reset role; update public.qorpera_office_software_provider_capabilities set enabled=false,revision=revision+1; ${service} ${activateSql(activationId, value)}`, /capability revoked/);
		return id;
	};
	await measure(plan.successorActivationId, startup, statement.next.service, 1);
	assert.equal(call(activateSql(plan.successorActivationId)).state, "active");
	assert.equal(call(activateSql(plan.successorActivationId)).state, "active");
	const historical = JSON.parse(query(`select to_jsonb(a) from public.qorpera_runtime_office_activations a where activation_id='${original.activation_id}';`));
	assert.deepEqual({ ...historical, software_revision: null, superseded_at: null }, original);
	let latest = successor;
	for (const boot of [false, true]) {
		const nextStop = stop(latest.attestation.activationId, startup, boot ? "reboot" : "service_restart");
		const nextAttestation = { ...latest.attestation, activationId: randomUUID(), ...(boot ? { bootId: randomUUID(), configurationSha256: hash(), configurationObservationSha256: hash(), adoptionReceiptSha256: hash() } : {}) };
		latest = { schema: boot ? "qorpera.office-boot-successor-request/v1" : "qorpera.office-service-successor-request/v1", predecessor: nextStop.predecessor, attestation: nextAttestation };
		if (boot) {
			Object.assign(latest, { bootIntentId: randomUUID(), stopHistorySha256: hash(), powerOffCompletionSha256: hash(), bootObservationSha256: hash() });
			call(`select public.qorpera_prepare_runtime_office_boot_intent(${json({ schema: "qorpera.office-boot-intent-request/v1", bootIntentId: latest.bootIntentId, activationId: nextAttestation.activationId, predecessor: latest.predecessor, stopHistorySha256: latest.stopHistorySha256, powerOffCompletionSha256: latest.powerOffCompletionSha256 })});`);
		}
		call(boot ? `select public.qorpera_prepare_runtime_office_boot_successor(${json(latest)});` : prepare(latest));
		startup = { ...startup, bootId: nextAttestation.bootId, configurationSha256: nextAttestation.configurationSha256, serviceInvocationId: randomBytes(16).toString("hex") };
		call(readySql(startup, nextAttestation.activationId));
		await deny(activateSql(nextAttestation.activationId), /measurement unavailable/);
		await measure(nextAttestation.activationId, startup, statement.next.service, 1);
		assert.equal(call(activateSql(nextAttestation.activationId)).state, "active");
	}
	assert.equal(query("select count(*) from public.qorpera_runtime_machine_allocations where released_at is null;"), "1");
	assert.equal(query("select count(*) from public.qorpera_office_software_measurements;"), "3");
	assert.equal(query("select count(*) from public.qorpera_runtime_office_activations where software_revision=1;"), "3");
	assert.deepEqual(JSON.parse(query("select base from public.qorpera_office_software_baselines;")), base);
	assert.equal(query(`select to_jsonb(p) from public.qorpera_runtime_browser_profiles p where id='${profileId}';`), preservedProfile);
	const recovered = call(`select public.qorpera_office_software_status(${json(plan)},'${capability}');`);
	assert.equal(recovered.state, "installed"); assert.equal(recovered.currentRevision, 1); assert.deepEqual(recovered.receipt, receipt);
	await deny(begin()); await deny(inspectInstall(randomUUID())); await deny(install());
	await deny(`select public.qorpera_office_software_status(${json({ ...plan, successorActivationId: randomUUID() })},'${capability}');`);
	await deny(`select public.qorpera_office_software_status(${json(plan)},'${capability}');`, /42501/, owner);
	const privileges = JSON.parse(query(`select jsonb_object_agg(role,has_function_privilege(role,'public.qorpera_ack_office_software_invocation(jsonb,uuid,uuid,jsonb,text,text)','EXECUTE')) from unnest(array['service_role','anon','authenticated','qorpera_secret_broker']) role;`));
	assert.deepEqual(privileges, { service_role: true, anon: false, authenticated: false, qorpera_secret_broker: false });
	assert.equal(query(`select count(*) from public.qorpera_office_software_updates where plan::text like '%${capability}%' or statement::text like '%${capability}%' or receipt::text like '%${capability}%';`), "0");
	for (const table of ["provider_capabilities", "baselines", "revisions", "updates", "challenges", "measurements"]) await deny(`select * from public.qorpera_office_software_${table};`, /42501/);
	console.log("PASS update activation and ordinary service/new-boot successors retain original base/allocation/history, inherit revision and require fresh invocation measurement");
	console.log("PASS ordinary service_role forgery is denied; operator-only capability rotation fences waiting dispatch and old challenges without leaking raw capability into history");
	}
} finally {
	for (const child of children) child.kill("SIGKILL");
	if (started) docker(["rm", "-f", "-v", container]);
}
