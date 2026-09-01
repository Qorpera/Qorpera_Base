import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handleGitHubRoutineWebhook } from "../packages/runner-orchestrator/src/github-routine-listener.ts";
import { createRoutinePolicyControl, reconcileRoutinePolicy } from "../packages/runner-orchestrator/src/routine-policy-adapters.ts";
import { compileRoutineTrigger, parseRoutinePolicy, routineInstant, routineOccurrenceIdentity } from "../packages/runner-orchestrator/src/routine-policy.ts";
import { POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";

// Isolated, disposable PostgreSQL only: no host ports, network, provider calls,
// deployment credentials or live database URL. All references are hash pinned.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const componentRoot = join(root, "deploy/first-node/step8");
const baseline = JSON.parse(readFileSync(join(componentRoot, "baseline.json"), "utf8"));
const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 2 && args[0] === "--references"), "Usage: node scripts/test-runtime-scheduler-listeners.mjs [--references frozen-directory]");
const references = resolve(args[1] ?? baseline.snapshotDirectory);
const container = `qorpera-step8-test-${process.pid}-${randomBytes(4).toString("hex")}`;
const volume = `${container}-data`;
const database = "scheduler_listeners";
const service = "select set_config('request.jwt.claims','{\"role\":\"service_role\"}',false);\n";

function reference(track, path) {
	const contents = readFileSync(join(references, track, path), "utf8");
	assert.equal(createHash("sha256").update(contents).digest("hex"), baseline.references[track].files[path], `Frozen reference hash changed: ${track}/${path}`);
	return contents;
}

function docker(arguments_, input) {
	const result = spawnSync("docker", arguments_, { input, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
	if (result.error || result.status !== 0) throw new Error(result.stderr || result.error?.message || result.stdout);
	return result.stdout.trim();
}

function psqlArgs() {
	return ["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database];
}

function sql(query) {
	return docker(psqlArgs(), query);
}

function jsonLiteral(value) {
	return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
}

async function ready() {
	for (let attempt = 0; attempt < 60; attempt++) {
		if (spawnSync("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", database], { stdio: "ignore" }).status === 0) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
	}
	throw new Error("Disposable PostgreSQL did not start within 30 seconds");
}

function concurrentSql(query) {
	return new Promise((resolveResult, reject) => {
		const child = spawn("docker", psqlArgs());
		let output = "", error = "";
		child.stdout.on("data", (chunk) => { output += chunk.toString(); });
		child.stderr.on("data", (chunk) => { error += chunk.toString(); });
		child.on("error", reject);
		child.on("close", (code) => code === 0 ? resolveResult(output.trim()) : reject(new Error(error)));
		child.stdin.end(query);
	});
}

async function interruptedTransaction(query) {
	const application = `step8-crash-${randomBytes(4).toString("hex")}`;
	const child = spawn("docker", psqlArgs());
	let error = "";
	const finished = new Promise((resolveExit) => child.on("close", resolveExit));
	child.stderr.on("data", (chunk) => { error += chunk.toString(); });
	try {
		await new Promise((resolveReady, reject) => {
			const timeout = setTimeout(() => reject(new Error(`Transaction did not reach its barrier: ${error}`)), 10_000);
			let output = "";
			child.stdout.on("data", (chunk) => {
				output += chunk.toString();
				if (output.includes("STEP8_TRANSACTION_READY")) { clearTimeout(timeout); resolveReady(); }
			});
			child.on("error", (cause) => { clearTimeout(timeout); reject(cause); });
			child.on("close", (code) => { clearTimeout(timeout); if (code !== 0) reject(new Error(error)); });
			child.stdin.write(`begin; set application_name='${application}';\n${service}${query}\nselect 'STEP8_TRANSACTION_READY';\n`);
		});
		assert.equal(sql(`select pg_terminate_backend(pid) from pg_stat_activity where application_name='${application}';`), "t");
	} finally {
		child.stdin.end();
		child.kill("SIGTERM");
		await finished;
	}
}

let started = false, volumeCreated = false;
try {
	docker(["volume", "create", volume]);
	volumeCreated = true;
	docker(["run", "--detach", "--name", container, "--network", "none", "--env", "POSTGRES_PASSWORD=step8-disposable-only",
		"--env", `POSTGRES_DB=${database}`, "--mount", `type=volume,source=${volume},target=/var/lib/postgresql/data`, POSTGRES_IMAGE]);
	started = true;
	await ready();
	sql(reference("main", "supabase/tests/bootstrap.sql"));
	const migrations = sortMigrationNames(readdirSync(join(references, "main/supabase/migrations")));
	for (const migration of migrations) sql(reference("main", `supabase/migrations/${migration}`));
	const wakeTest = reference("step3", "supabase/tests/300_runtime_wake_bus.test.sql");
	assert(wakeTest.includes("-- END WAKE FIXTURE"), "Missing bounded Step 3 fixture");
	// Only fixture helper names change so fresh consumer connections can reuse
	// the same real admission/lease/publisher APIs after a process restart.
	const fixture = wakeTest.slice(0, wakeTest.indexOf("-- END WAKE FIXTURE")).replaceAll("pg_temp.", "step8_test.");
	const policy = readFileSync(join(root, "packages/runner-orchestrator/test/fixtures/routine-policy.json"), "utf8");
	sql(`create schema step8_test;\nselect set_config('qorpera_test.step8_policy','${policy.replaceAll("'", "''")}',false);\n${fixture}\n${readFileSync(join(componentRoot, "runtime-fixture.sql"), "utf8")}`);
	sql(reference("step3", "supabase/migrations/20260828020000_runtime_wake_bus.sql"));
	for (const module of ["runtime-scheduler.sql", "runtime-listener-receipts.sql"]) sql(readFileSync(join(componentRoot, module), "utf8"));
	console.log(`PASS installed ${migrations.length} frozen main migrations, Step 3, and both Step 8 modules`);
	const parsedPolicy = parseRoutinePolicy(JSON.parse(policy));
	const validation = JSON.parse(readFileSync(join(root, "packages/runner-orchestrator/test/fixtures/routine-validation.json"), "utf8"));
	assert.equal(validation.schema, "qorpera.routine-validation-fixtures/v1");
	const githubChecks = [];
	for (const { name, patch, remove = [], valid } of validation.githubCases) {
		const trigger = { ...validation.githubTrigger, ...patch };
		for (const field of remove) delete trigger[field];
		if (valid) assert.deepEqual(compileRoutineTrigger([trigger], parsedPolicy), trigger, name);
		else assert.throws(() => compileRoutineTrigger([trigger], parsedPolicy), undefined, name);
		githubChecks.push(`select step8_test.wake_assert(public.qorpera_step8_trigger_valid(${jsonLiteral([trigger])},${jsonLiteral(parsedPolicy)}) is not distinct from ${valid},${jsonLiteral(name)} #>> '{}');`);
	}
	sql(githubChecks.join("\n"));
	console.log(`PASS ${validation.githubCases.length} shared GitHub trigger validation cases in TypeScript and PostgreSQL`);
	const fileChecks = [];
	for (const { name, patch, remove = [], valid } of validation.companyFileCases) {
		const trigger = { ...validation.companyFileTrigger, ...patch };
		for (const field of remove) delete trigger[field];
		if (valid) assert.deepEqual(compileRoutineTrigger([trigger], parsedPolicy), trigger, name);
		else assert.throws(() => compileRoutineTrigger([trigger], parsedPolicy), undefined, name);
		fileChecks.push(`select step8_test.wake_assert(public.qorpera_step8_trigger_valid(${jsonLiteral([trigger])},${jsonLiteral(parsedPolicy)}) is not distinct from ${valid},${jsonLiteral(name)} #>> '{}');`);
	}
	sql(fileChecks.join("\n"));
	console.log(`PASS ${validation.companyFileCases.length} shared Company File selector validation cases in TypeScript and PostgreSQL`);
	const zoneChecks = [];
	for (const { name, value, canonical } of validation.timeZones) {
		const input = { ...parsedPolicy, timeZone: value };
		if (canonical === null) {
			assert.throws(() => parseRoutinePolicy(input), undefined, name);
			zoneChecks.push(`select step8_test.wake_assert(not public.qorpera_step8_policy_valid(${jsonLiteral(input)}),${jsonLiteral(name)} #>> '{}');`);
			continue;
		}
		const compiledPolicy = parseRoutinePolicy(input);
		assert.equal(compiledPolicy.timeZone, canonical, name);
		zoneChecks.push(`select step8_test.wake_assert(public.qorpera_step8_policy_valid(${jsonLiteral(compiledPolicy)}),${jsonLiteral(name)} #>> '{}');`);
		for (const trigger of [
			{ id: "tick", kind: "schedule", intervalMinutes: 5, localTime: "09:00", timeZone: value },
			{ id: "file", kind: "listener", source: "company-file", path: "", match: "subtree", timeZone: value },
			{ ...validation.githubTrigger, timeZone: value },
		]) {
			const compiled = compileRoutineTrigger([trigger], compiledPolicy);
			assert.equal(compiled.timeZone, canonical, name);
			zoneChecks.push(`select step8_test.wake_assert(public.qorpera_step8_trigger_valid(${jsonLiteral([compiled])},${jsonLiteral(compiledPolicy)}),${jsonLiteral(`${name}: ${trigger.source ?? trigger.kind}`)} #>> '{}');`);
		}
	}
	sql(zoneChecks.join("\n"));
	console.log(`PASS ${validation.timeZones.length} shared timezone cases; actual compiled policies and all three trigger kinds pass SQL validation`);
	const instantChecks = [];
	const anchorChecks = [];
	for (const { name, value, valid } of validation.instants) {
		if (valid) assert.equal(new Date(routineInstant(value)).toISOString(), value, name);
		else assert.throws(() => routineInstant(value), undefined, name);
		instantChecks.push(`select step8_test.wake_assert(public.qorpera_step8_instant_valid(${jsonLiteral(value)}) is not distinct from ${valid},${jsonLiteral(name)} #>> '{}');`);
		for (const trigger of [
			{ id: "tick", kind: "schedule", intervalMinutes: 5, startAt: value },
			{ id: "tick", kind: "schedule", intervalMinutes: 5, startAt: value, localTime: "09:00", timeZone: "UTC" },
		]) {
			const compiled = valid ? compileRoutineTrigger([trigger], parsedPolicy) : trigger;
			if (!valid) assert.throws(() => compileRoutineTrigger([trigger], parsedPolicy), undefined, name);
			anchorChecks.push(`select step8_test.wake_assert(public.qorpera_step8_trigger_valid(${jsonLiteral([compiled])},${jsonLiteral(parsedPolicy)}) is not distinct from ${valid},${jsonLiteral(`Schedule anchor: ${name}`)} #>> '{}');`);
		}
	}
	sql(instantChecks.join("\n"));
	console.log(`PASS ${validation.instants.length} shared canonical UTC timestamp validation cases in TypeScript and PostgreSQL`);
	sql(anchorChecks.join("\n"));
	console.log(`PASS ${anchorChecks.length} schedule anchor cases in TypeScript and PostgreSQL`);

	sql(readFileSync(join(componentRoot, "runtime-scheduler.test.sql"), "utf8"));
	console.log("PASS policy parity, atomic File projections, expiry, queued work, auth suspension and notification receipts");
	console.log("PASS missing/null/nonpositive policy bindings reject admission, expiry and recovery without state changes");
	console.log("PASS noncanonical plan timestamps leave state, cursor and queue unchanged; fresh canonical CAS and receipt replay succeed");
	sql(readFileSync(join(componentRoot, "runtime-file-listener-policy.test.sql"), "utf8"));
	console.log("PASS File epoch integration contract: real Step 3 admission, closed missing attachment, identity, pause/resume, expiry and terminal evidence");
	sql(readFileSync(join(componentRoot, "runtime-listener-receipts.test.sql"), "utf8"));
	console.log("PASS external duplicate/reordered receipts and missing Step 3/7 adapters fail closed");
	console.log("PASS malformed normalized events reject before fresh/duplicate receipts and preserve both clocks and ledgers");
	console.log("PASS listener clock rollback, future-only resume, duplicate observations and provider/clock separation");
	const envelopeValidation = `begin;\n${service}select step8_test.restore();\nselect step8_test.assert_external_envelope(${jsonLiteral(validation.instants)});\nrollback;`;
	sql(envelopeValidation);
	console.log("PASS typed hashes and canonical receivedAt reject malformed fresh/duplicate envelopes without changing clocks, receipts or queue");
	sql(readFileSync(join(componentRoot, "runtime-scheduler-expiry.test.sql"), "utf8"));
	console.log("PASS public schedule expiry with empty/populated queues, sticky expiry, exact boundary, clock rollback, pause/resume and receipt replay");

	// Further recovery/concurrency assertions are kept in this script so every
	// consumer uses a new backend, including after the database itself restarts.
	await interruptedTransaction("select step8_test.commit_expired_schedule();");
	sql("select step8_test.assert_schedule_expiry_rollback();");
	const expiry = await Promise.allSettled([
		concurrentSql(service + "select step8_test.commit_expired_schedule();"),
		concurrentSql(service + "select step8_test.commit_expired_schedule();"),
	]);
	const expiryStatuses = [];
	for (const result of expiry) {
		assert.equal(result.status, "fulfilled", result.status === "rejected" ? String(result.reason) : undefined);
		expiryStatuses.push(JSON.parse(result.value.split("\n").at(-1)).status);
	}
	assert.deepEqual(expiryStatuses.sort(), ["committed", "duplicate"]);
	sql("select step8_test.assert_schedule_expiry_committed();");
	console.log("PASS interrupted public expiry rolls back the complete transition; concurrent callers commit once and replay once");
	for (const stage of ["materialized", "queued"]) {
		for (const change of ["staff-grant-revoked", "intent-made-private"]) {
			sql(service + `select step8_test.check_intent_authority('${stage}','${change}');`);
		}
	}
	assert.equal(sql("select count(*) from step8_test.saved where key like 'intent-authority:%';"), "4");
	const intentAuthorityRecheck = service + "select step8_test.assert_intent_authority(value,false) from step8_test.saved where key like 'intent-authority:%' order by key;";
	sql(intentAuthorityRecheck);
	console.log("PASS four queued/materialized intent-path revocation/private-scope cases, two authorized grant restorations and unchanged identities in fresh backends");
	await interruptedTransaction("select step8_test.crash_schedule();");
	assert.equal(sql("select step8_test.assert_crash_rolled_back();"), "");
	await interruptedTransaction("select step8_test.concurrent_external(interval '20 minutes');");
	assert.equal(sql("select step8_test.assert_external_crash_rolled_back();"), "");
	const concurrency = await Promise.allSettled([
		concurrentSql(service + "select step8_test.concurrent_schedule();"),
		concurrentSql(service + "select step8_test.concurrent_schedule();"),
	]);
	for (const result of concurrency) assert.equal(result.status, "fulfilled", result.status === "rejected" ? String(result.reason) : undefined);
	sql("select step8_test.assert_concurrent_schedule();");
	const external = await Promise.allSettled([
		concurrentSql(service + "select step8_test.concurrent_external(interval '10 minutes');"),
		concurrentSql(service + "select step8_test.concurrent_external();"),
	]);
	for (const result of external) assert.equal(result.status, "fulfilled", result.status === "rejected" ? String(result.reason) : undefined);
	const suspensions = await Promise.allSettled([
		concurrentSql(service + "select step8_test.concurrent_auth();"),
		concurrentSql(service + "select step8_test.concurrent_auth();"),
	]);
	for (const result of suspensions) assert.equal(result.status, "fulfilled", result.status === "rejected" ? String(result.reason) : undefined);
	sql("select step8_test.assert_concurrent_auth();");
	console.log("PASS backend interruption rolls back queue/cursors; concurrent identical plans admit once");

	docker(["restart", container]);
	await ready();
	sql(intentAuthorityRecheck);
	console.log("PASS database restart preserves all four intent-path denials and complete occurrence, epoch, state, cursor and projection snapshots");
	sql(service + "select step8_test.assert_schedule_expiry_restart();");
	console.log("PASS public expiry receipt replay after database restart preserves suspension, cancelled identities, epochs, cursor and timestamps");
	sql(service + "select step8_test.assert_restart();");
	sql(service + "select step8_test.assert_external_restart();");
	sql(envelopeValidation);
	console.log("PASS envelope validation and valid epoch/digit-only hash receipt replay after database restart");
	console.log("PASS persistent-volume restart and fresh consumers preserve queue, receipts and notification deduplication");
	console.log("PASS listener clock/receipt atomic rollback, maximum concurrent clock, restart and rollback pause/resume");
	const control = createRoutinePolicyControl(async (name, parameters) => {
		const argument = name === "qorpera_step8_read_schedule_context" ? parameters.p_routine_id : JSON.stringify(parameters.p_plan);
		assert.equal(typeof argument, "string");
		return JSON.parse(sql(service + `select public.${name}('${argument.replaceAll("'", "''")}');`).split("\n").at(-1));
	});
	const routine = JSON.parse(sql("select value from step8_test.saved where key='recovery-routine';"));
	const plan = await reconcileRoutinePolicy(control, routine, new Date().toISOString());
	for (const occurrence of plan.occurrences) {
		assert.deepEqual(routineOccurrenceIdentity(routine, plan.version, "tick", occurrence.scheduledFor), { occurrenceId: occurrence.occurrenceId, occurrenceKey: occurrence.occurrenceKey });
		assert.equal(sql(`select occurrence_key from public.qorpera_wake_occurrences where id='${occurrence.occurrenceId}';`), occurrence.occurrenceKey);
	}
	console.log("PASS concrete TypeScript control adapter plans and commits through real PostgreSQL RPC entrypoints");
	const externalBinding = JSON.parse(sql(`select jsonb_build_object('routineId',r.id,'version',s.routine_version,'epoch',s.epoch,
		'activeSince',step8_test.instant(s.active_since),'status',r.status,'suspended',s.suspension is not null,'trigger',v.triggers -> 0,'policy',p.policy)
		from public.qorpera_cloud_routines r join public.qorpera_step8_routine_state s on s.routine_id=r.id
		join public.qorpera_step8_routine_policies p on p.routine_id=r.id and p.routine_version=s.routine_version
		join public.qorpera_cloud_routine_versions v on v.routine_id=r.id and v.version=s.routine_version
		where r.id=(select (value ->> 'routine_id')::uuid from step8_test.saved where key='external-routine');`));
	const rawFixture = readFileSync(join(root, "packages/runner-orchestrator/test/fixtures/github-pull-request.json"), "utf8");
	const fixturePayload = JSON.parse(rawFixture);
	const webhookBodies = [rawFixture, ...[
		{ state: "open", merged: false }, { state: "closed", merged: false }, { state: "closed", merged: true },
	].map(({ state, merged }) => JSON.stringify({ ...fixturePayload, action: "edited",
		changes: { title: { from: "Previous title" }, body: { from: "Previous description" } },
		pull_request: { ...fixturePayload.pull_request, state, merged,
			closed_at: state === "closed" ? "2026-08-28T09:30:00Z" : null, merged_at: merged ? "2026-08-28T09:30:00Z" : null },
	}))];
	const webhookFixtureSecret = Buffer.from("step8-disposable-hmac-fixture-only");
	const receipts = [];
	const listenerAdapters = {
		resolveWebhookSecret: async () => webhookFixtureSecret,
		admit: async (delivery) => {
			const receipt = JSON.parse(sql(service + `select public.qorpera_step8_ingest_github('${JSON.stringify(delivery).replaceAll("'", "''")}');`).split("\n").at(-1));
			receipts.push(receipt.status);
			return receipt;
		},
	};
	for (let attempt = 0; attempt < 2; attempt++) {
		if (attempt === 1) { docker(["restart", container]); await ready(); }
		for (const [index, body] of webhookBodies.entries()) {
			const request = new Request("https://hooks.example.test/step8-fixture", { method: "POST", body, headers: {
				"content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": `72d3162e-cc78-11e3-81ab-4c9367dc${9900 + index}`,
				"x-hub-signature-256": `sha256=${createHmac("sha256", webhookFixtureSecret).update(body).digest("hex")}`,
			} });
			assert.equal((await handleGitHubRoutineWebhook(request, externalBinding, listenerAdapters, new Date().toISOString())).status, 202);
		}
	}
	assert.deepEqual(receipts, [...webhookBodies.map(() => "ignored"), ...webhookBodies.map(() => "duplicate")]);
	console.log("PASS raw GitHub opened/open-edit/closed-edit/merged-edit HMAC -> SQL ignored receipt -> duplicate after database restart (no external admission adapter)");
	const current = await control.readScheduleContext(routine);
	const transitionAt = new Date(Date.parse(current.observedThrough) + 5 * 60_000).toISOString();
	const racePlan = sql(`select step8_test.plan('${routine}','${transitionAt}',array['${plan.nextDueAt}'::timestamptz]);`);
	const transitions = await Promise.allSettled([
		concurrentSql(service + `select step8_test.concurrent_transition('${racePlan.replaceAll("'", "''")}');`),
		concurrentSql(service + "select step8_test.concurrent_pause();"),
	]);
	for (const result of transitions) assert.equal(result.status, "fulfilled", result.status === "rejected" ? String(result.reason) : undefined);
	assert.equal(sql(`select count(*) from public.qorpera_wake_occurrences where routine_id='${routine}' and status='queued';`), "0");
	assert.equal(sql(`select status from public.qorpera_cloud_routines where id='${routine}';`), "paused");
	console.log("PASS concurrent pause/admission cancels or rejects work; duplicate auth failure creates one notification intent");
} finally {
	if (started) docker(["rm", "--force", container]);
	if (volumeCreated) docker(["volume", "rm", volume]);
}
