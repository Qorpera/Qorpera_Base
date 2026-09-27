// Disposable PostgreSQL only. Tests real native admission and office claims;
// guest readiness is a fixture, never a claim of Linux/provider acceptance.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";
import { testOfficeFileExport } from "./test-runtime-office-file-export.mjs";
import { testOfficeDesktop } from "./test-runtime-office-desktop.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const container = `qorpera-office-registry-${randomBytes(6).toString("hex")}`;
const psql = ["exec", "-i", container, "psql", "-X", "-qAt", "-U", "postgres", "-d", "office", "-v", "ON_ERROR_STOP=1"];
function docker(args, input) {
	const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
	assert(!result.error && result.status === 0, `${result.stderr || String(result.error ?? "Disposable database command failed")}\n${result.stdout?.slice(-2500) ?? ""}`);
	return result.stdout.trim();
}
function session() {
	const child = spawn("docker", psql);
	let output = "", error = "";
	child.stdout.on("data", (chunk) => { output += chunk; });
	child.stderr.on("data", (chunk) => { error += chunk; });
	const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
	const done = new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code) => { clearTimeout(timer); resolve({ code, output: output.trim(), error }); });
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
const literal = (value) => value === null ? "null" : `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
const service = `set request.jwt.claims='{"role":"service_role"}'; set role service_role;`;
let started = false;
try {
	docker(["run", "-d", "--rm", "--name", container, "--network", "none",
		"-e", "POSTGRES_PASSWORD=disposable-office-only", "-e", "POSTGRES_DB=office", POSTGRES_IMAGE]);
	started = true;
	let consecutive = 0;
	for (let attempt = 0; attempt < 60 && consecutive < 2; attempt++) {
		const result = spawnSync("docker", ["exec", container, "pg_isready", "-U", "postgres", "-d", "office"], { timeout: 2000 });
		consecutive = result.status === 0 ? consecutive + 1 : 0;
		if (consecutive < 2) await new Promise((resolve) => setTimeout(resolve, 500));
	}
	assert.equal(consecutive, 2);
	docker(psql, readFileSync(join(root, "supabase/tests/bootstrap.sql"), "utf8"));
	const migrations = sortMigrationNames(readdirSync(join(root, "supabase/migrations")));
	for (const name of migrations) docker(psql, readFileSync(join(root, "supabase/migrations", name), "utf8"));
	const fixtureParts = readFileSync(join(root, "supabase/tests/300_runtime_wake_bus.test.sql"), "utf8").split("-- END WAKE FIXTURE");
	assert.equal(fixtureParts.length, 2);
	const cases = readFileSync(join(root, "supabase/tests/fixtures/runtime-office-registry-cases.sql"), "utf8");
	docker(psql, `${fixtureParts[0]}\n${cases}\nrollback;`);
	console.log("PASS: real native authority, private SQL grants, immutable office binding, bounded leases, revocation, exact cleanup and expiry fences");
	const setupParts = cases.split("set local role service_role;\nselect set_config('qorpera_test.office_lease'");
	assert.equal(setupParts.length, 2);
	docker(psql, `${fixtureParts[0]}\n${setupParts[0]}\n${readFileSync(join(root, "supabase/tests/fixtures/runtime-office-start-cases.sql"), "utf8")}\nrollback;`);
	console.log("PASS: durable member/native start intents, exact native receipts, shared reservations, cancellation/generation/grant fences and no premature activation");
	docker(psql, `${fixtureParts[0]}\n${setupParts[0]}\n${readFileSync(join(root, "supabase/tests/fixtures/runtime-office-provider-cases.sql"), "utf8")}\nrollback;`);
	console.log("PASS: immutable provider host/policy enrollment, restart discovery, preparation disable, private legacy APIs and retained capacity");
	docker(psql, `${fixtureParts[0]}\n${setupParts[0]}\n${readFileSync(join(root, "supabase/tests/fixtures/runtime-office-idle-cases.sql"), "utf8")}\nrollback;`);
	console.log("PASS: server idle demand, shared viewers, ordinary turns, repeated member/native wake, operator maintenance and retained allocation");
	docker(psql, `${fixtureParts[0]}\n${setupParts[0]}\n${readFileSync(join(root, "supabase/tests/fixtures/runtime-office-effects-cases.sql"), "utf8")}\nrollback;`);
	console.log("PASS: exact native effect receipts, one attempt, resource expiry, unresolved work, takeover fencing and guest drain acknowledgements");
	docker(psql, `${fixtureParts[0]}\n${setupParts[0]}\n${readFileSync(join(root, "supabase/tests/fixtures/runtime-office-file-exports-cases.sql"), "utf8")}\nrollback;`);
	console.log("PASS: typed workbench export, exact original receipt, distinct realms, immutable asset provenance, retention and revocation");
	docker(psql, `${fixtureParts[0]}\n${setupParts[0]}\n${readFileSync(join(root,"supabase/tests/fixtures/runtime-office-file-exports-cases.sql"),"utf8")}\n${readFileSync(join(root,"supabase/tests/fixtures/runtime-company-file-asset-writes-cases.sql"),"utf8")}\nrollback;`);
	console.log("PASS: shared export to Company File, exact destination versions, canonical source provenance, retention and human-approved proposals");
	docker(psql, `${fixtureParts[0]}\n${setupParts[0]}\n${readFileSync(join(root, "supabase/tests/fixtures/runtime-office-file-exports-cases.sql"), "utf8")}\n${readFileSync(join(root, "supabase/tests/fixtures/runtime-office-file-imports-cases.sql"), "utf8")}\nrollback;`);
	console.log("PASS: explicit imports, completed shared source, exact receipt/provenance, retention and source/grant revocation");
	docker(psql, `${fixtureParts[0]}\n${setupParts[0]}\n${readFileSync(join(root,"supabase/tests/fixtures/runtime-office-file-exports-cases.sql"),"utf8")}\n${readFileSync(join(root,"supabase/tests/fixtures/runtime-office-file-imports-cases.sql"),"utf8")}\n${readFileSync(join(root,"supabase/tests/fixtures/runtime-office-company-file-source.sql"),"utf8")}\n${readFileSync(join(root,"supabase/tests/fixtures/runtime-office-company-file-imports-cases.sql"),"utf8")}\nrollback;`);
	console.log("PASS: exact Company File version import, current path grants, immutable manifest/chunk closure and one source receipt");
	docker(psql, `${fixtureParts[0]}\n${setupParts[0]}\n${readFileSync(join(root, "supabase/tests/fixtures/runtime-office-desktop-cases.sql"), "utf8")}\nrollback;`);
	console.log("PASS: closed desktop actions and desktop screenshots, independent capability admission, exact receipts and privacy/revocation fences");
	docker(psql, `${fixtureParts[0]}\n${setupParts[0]}\n${readFileSync(join(root, "supabase/tests/fixtures/runtime-office-browser-privacy-cases.sql"), "utf8")}\nrollback;`);
	console.log("PASS: owner-only browser consent, closed effect schema, sign-in privacy barriers, exact physical acknowledgements, revocation and owner departure");
	const captureSetup = readFileSync(join(root, "supabase/tests/fixtures/runtime-office-browser-privacy-cases.sql"), "utf8").split("select set_config('qorpera_test.browser_envelope',");
	assert.equal(captureSetup.length, 2);
	docker(psql, `${fixtureParts[0]}\n${setupParts[0]}\n${captureSetup[0]}\n${readFileSync(join(root, "supabase/tests/fixtures/runtime-office-captures-cases.sql"), "utf8")}\nrollback;`);
	console.log("PASS: immutable screenshot publication, exact capture receipt, artifact retention, completed-result read authority and revocation");
	docker(psql, `${fixtureParts[0]}\n${setupParts[0]}\n${readFileSync(join(root, "supabase/tests/fixtures/runtime-office-viewer-cases.sql"), "utf8")}\nrollback;`);
	console.log("PASS: single-use member viewing, takeover ownership, input sequencing, revocation, drain/reconnect and owner-only private handoff");
	docker(psql, `${fixtureParts[0]}\n${setupParts[0]}\n${readFileSync(join(root, "supabase/tests/fixtures/runtime-office-shared-viewer-cases.sql"), "utf8")}\nrollback;`);
	console.log("PASS: shared member input, independent agent leases, stable viewer epochs, audit sequencing, role checks and physical fences");
	docker(psql, `${fixtureParts[0]}\n${setupParts[0]}\n${readFileSync(join(root, "supabase/tests/fixtures/runtime-office-screen-browser-cases.sql"), "utf8")}\nrollback;`);
	console.log("PASS: screen-owned browser authority from an agent lease or a live input viewer, company-owned profile for members alone, recorded opens and revocation");
	docker(psql, `${fixtureParts[0]}\n${setupParts[0]}\n${readFileSync(join(root, "supabase/tests/fixtures/runtime-office-member-views-cases.sql"), "utf8")}\nrollback;`);
	console.log("PASS: member screen discovery, exact owner cancellation, ambiguous/expired ticket recovery and retained physical drain");
	docker(psql, `${fixtureParts[0]}\n${setupParts[0]}\n${readFileSync(join(root, "supabase/tests/fixtures/runtime-machine-capacity-cases.sql"), "utf8")}\nrollback;`);
	console.log("PASS: native and office machines with no company limit, operator stop, exact deletion proof, no expiry-based capacity release");
	const lines = docker(psql, `${fixtureParts[0]}\n${setupParts[0]}\n${readFileSync(join(root,"supabase/tests/fixtures/runtime-office-company-file-source.sql"),"utf8")}
		select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress');
		select jsonb_build_object('binding',current_setting('qorpera_test.wake_binding')::jsonb,'companyFile',current_setting('qorpera_test.company_import_source')::jsonb,
			'scope',current_setting('qorpera_test.office_scope')::jsonb,
			'identity',public.qorpera_describe_native_tool_authority(current_setting('qorpera_test.wake_binding')::jsonb)->'identity',
			'resources',public.qorpera_native_office_descriptor(current_setting('qorpera_test.wake_binding')::jsonb)->'resources',
			'runner',(select jsonb_build_object('allocationId',client_runner_id,'provider',provider_adapter) from public.qorpera_runners
				where id=(current_setting('qorpera_test.wake_binding')::jsonb->>'runnerId')::uuid)); commit;`).split("\n");
	const setup = JSON.parse(lines.at(-1));
	const call = (action, lease = null) => `select public.qorpera_native_office_screen(${literal(setup.binding)},${literal(setup.scope)},'${action}',${literal(lease)});`;
	const contenders = [session(), session()];
	for (const contender of contenders) contender.child.stdin.end(`${service}\n${call("acquire")}`);
	const results = await Promise.all(contenders.map((contender) => contender.done));
	for (const result of results) assert.equal(result.code, 0, result.error);
	const responses = results.map((result) => JSON.parse(result.output));
	assert.deepEqual(responses.map((response) => response.state).sort(), ["admitted", "refused"]);
	const lease = responses.find((response) => response.state === "admitted").lease;
	assert.equal(docker(psql, "select count(*) from public.qorpera_runtime_office_screens where lease_id is not null;"), "1");
	console.log("PASS: two concurrent claims admit exactly one driver with one persisted lease");

	// Hold the office lock until the screen has expired. A renewal waiting on
	// that lock must use the post-wait clock and cannot resurrect the lease.
	const blocker = session();
	blocker.child.stdin.write(`begin; select id from public.qorpera_runtime_offices for update;
		update public.qorpera_runtime_office_screens set lease_expires_at=clock_timestamp()-interval '1 second';
		select 'OFFICE_LOCKED';\n`);
	await until(() => blocker.output().includes("OFFICE_LOCKED"));
	const renewal = session();
	renewal.child.stdin.end(`${service} set application_name='office-expiry-race'; ${call("renew", lease)}`);
	await until(() => docker(psql, "select count(*) from pg_stat_activity where application_name='office-expiry-race' and wait_event_type='Lock';") === "1");
	blocker.child.stdin.end("commit;\n");
	assert.equal((await blocker.done).code, 0);
	const expired = await renewal.done;
	assert.notEqual(expired.code, 0);
	assert.match(expired.error, /Office screen lease expired/);
	console.log("PASS: renewal blocked behind a transaction cannot resurrect an expired lease");

	const cleanup = JSON.parse(docker(psql, `${service}\n${call("release", lease)}`));
	assert.equal(cleanup.state, "released");
	assert.equal(docker(psql, "select count(*) from public.qorpera_runtime_office_screens where lease_id is not null;"), "0");
	await testOfficeFileExport({root,query:sql=>docker(psql,sql),setup});
	await testOfficeDesktop({root,query:sql=>docker(psql,sql),setup});

	const effectLease = JSON.parse(docker(psql, `${service} ${call("acquire")}`)).lease;
	const principals = Object.fromEntries(Object.entries(setup.identity).filter(([key]) => !["assignmentId","runnerId","leaseId","sponsorVersion","providerConnectionId","providerConnectionVersion"].includes(key)));
	const envelope = JSON.stringify({ schema: "qorpera.cloud-tool-operation/v2", principals, operation: {
		tool: "computer_shell", toolVersion: "qorpera.company-computer-tools/v2", logicalOperationKey: "concurrent-effect",
		arguments: { kind: "shell", command: "printf race", timeoutMs: 1000 },
		target: { realm: "company_computer", binding: effectLease.binding, resources: setup.resources }, requiresCompanyRevision: false,
	} });
	const receiptId = randomUUID();
	const digest = createHash("sha256").update(envelope).digest("hex");
	const sqlText = (value) => `'${value.replaceAll("'", "''")}'`;
	docker(psql, `${service} select public.qorpera_begin_native_tool_operation(${literal(setup.binding)},'${receiptId}',
		'computer_shell:concurrent-effect','${digest}',repeat('d',64),false);`);
	const effectCall = (action) => `select public.qorpera_native_office_operation(${literal(setup.binding)},${literal(setup.scope)},
		${literal(effectLease)},${sqlText(envelope)},'${action}','${receiptId}',repeat('d',64));`;
	const effects = [session(), session()];
	for (const contender of effects) contender.child.stdin.end(`${service} ${effectCall("begin")}`);
	const attempts = await Promise.all(effects.map((contender) => contender.done));
	assert.equal(attempts.filter((result) => result.code === 0).length, 1);
	assert.match(attempts.find((result) => result.code !== 0).error, /Office effect attempt already consumed/);
	assert.equal(docker(psql, "select count(*) from public.qorpera_runtime_office_resources where state='active';"), "1");
	docker(psql, `${service} ${effectCall("finish")} ${call("release", effectLease)}`);
	console.log("PASS: two guest dispatches consume one real native receipt exactly once");

	// No company machine limit (runtime v92): concurrent office and native starts both get a machine.
	const machines = [session(), session()];
	machines[0].child.stdin.end(`${service} select public.qorpera_reserve_runtime_machine('${setup.runner.allocationId}',
		${sqlText(setup.runner.provider)},repeat('a',64),'${setup.binding.runId}','${setup.binding.runnerId}');`);
	machines[1].child.stdin.end(`${service} select public.qorpera_reserve_runtime_machine('34000000-0000-4000-8000-000000000088',
		'lxd',repeat('b',64),null,null,'${setup.scope.companyComputerId}',1);`);
	const allocations = await Promise.all(machines.map((contender) => contender.done));
	for (const allocation of allocations) assert.equal(allocation.code, 0, allocation.error);
	assert.deepEqual(allocations.map((result) => JSON.parse(result.output).state).sort(), ["reserved", "reserved"]);
	assert.equal(docker(psql, "select count(*) from public.qorpera_runtime_machine_allocations where released_at is null;"), "2");
	console.log("PASS: concurrent office/native starts both get a machine with no company limit");

	const viewerOwner = `set request.jwt.claims='{"role":"authenticated","sub":"30000000-0000-4000-8000-000000000001"}'; set role authenticated;`;
	const viewerEpoch = () => Number(docker(psql, `select epoch from public.qorpera_runtime_office_screens where id='${effectLease.binding.screenId}';`));
	const requestDrain = (takeover) => JSON.parse(docker(psql, `${viewerOwner} select public.qorpera_request_runtime_office_drain(${literal(setup.scope)},
		'${effectLease.binding.screenId}',${effectLease.binding.computerGeneration},${effectLease.binding.screenGeneration},${viewerEpoch()},${takeover});`));
	const acknowledgeDrain = (drain) => docker(psql, `${service} select public.qorpera_ack_runtime_office_drain(${literal(setup.scope)},
		'${drain.binding.screenId}',${drain.binding.computerGeneration},${drain.binding.screenGeneration},${drain.epoch},'${drain.drainId}');`);
	const sharedLease = JSON.parse(docker(psql, `${service} ${call("acquire")}`)).lease;
	const sharedTicket = JSON.parse(docker(psql, `${viewerOwner} select public.qorpera_create_runtime_office_viewer(${literal(sharedLease.binding)},${viewerEpoch()},'shared');`));
	const sharedDigest = createHash("sha256").update(sharedTicket.capability).digest("hex");
	const sharedGrant = JSON.parse(docker(psql, `${service} select public.qorpera_redeem_runtime_office_viewer(${literal(setup.scope)},'${sharedDigest}');`));
	const sharing = [session(), session()];
	sharing[0].child.stdin.end(`${service} ${call("renew", sharedLease)}`);
	sharing[1].child.stdin.end(`${service} select public.qorpera_admit_runtime_office_viewer_input(${literal(sharedGrant)},1,repeat('e',64));`);
	for (const result of await Promise.all(sharing.map((contender) => contender.done))) {
		assert.equal(result.code, 0, result.error);
		assert.equal(JSON.parse(result.output).state, "admitted");
	}
	const closingShared = [session(), session()];
	closingShared[0].child.stdin.end(`${service} ${call("renew", sharedLease)}`);
	closingShared[1].child.stdin.end(`${service} select public.qorpera_release_runtime_office_viewer(${literal(sharedGrant)});`);
	const closeResults = await Promise.all(closingShared.map((contender) => contender.done));
	for (const result of closeResults) assert.equal(result.code, 0, result.error);
	assert.deepEqual(closeResults.map((result) => JSON.parse(result.output).state).sort(), ["admitted", "released"]);
	assert.equal(JSON.parse(docker(psql, `${service} ${call("check", sharedLease)}`)).state, "admitted");
	assert.equal(docker(psql, "select count(*) from public.qorpera_runtime_office_screens where drain_pending;"), "0");
	docker(psql, `${service} ${call("release", sharedLease)}`);
	console.log("PASS: shared input and disconnect race agent renewal without taking, fencing or draining its lease");
	acknowledgeDrain(requestDrain(true));
	const memberClaims = [session(), session()];
	const memberEpoch = viewerEpoch();
	for (const claimant of memberClaims) claimant.child.stdin.end(`${viewerOwner} select public.qorpera_create_runtime_office_viewer(${literal(effectLease.binding)},${memberEpoch},'control');`);
	const memberResults = await Promise.all(memberClaims.map((claimant) => claimant.done));
	for (const result of memberResults) assert.equal(result.code, 0, result.error);
	const memberTickets = memberResults.map((result) => JSON.parse(result.output));
	assert.deepEqual(memberTickets.map((ticket) => ticket.state).sort(), ["issued", "refused"]);
	const memberTicket = memberTickets.find((ticket) => ticket.state === "issued");
	const ticketDigest = createHash("sha256").update(memberTicket.capability).digest("hex");
	const redeemers = [session(), session()];
	for (const redeemer of redeemers) redeemer.child.stdin.end(`${service} select public.qorpera_redeem_runtime_office_viewer(${literal(setup.scope)},'${ticketDigest}');`);
	const redemptions = await Promise.all(redeemers.map((redeemer) => redeemer.done));
	assert.equal(redemptions.filter((result) => result.code === 0).length, 1);
	assert.match(redemptions.find((result) => result.code !== 0).error, /Viewer ticket consumed/);
	const memberGrant = JSON.parse(redemptions.find((result) => result.code === 0).output);
	const inputs = [session(), session()];
	for (const input of inputs) input.child.stdin.end(`${service} select public.qorpera_admit_runtime_office_viewer_input(${literal(memberGrant)},1,repeat('c',64));`);
	const inputResults = await Promise.all(inputs.map((input) => input.done));
	assert.equal(inputResults.filter((result) => result.code === 0).length, 1);
	assert.match(inputResults.find((result) => result.code !== 0).error, /Viewer input already consumed or out of order/);
	assert.equal(docker(psql, `select count(*) from public.qorpera_runtime_office_viewer_inputs where viewer_id='${memberGrant.viewerSessionId}';`), "1");
	docker(psql, `${service} select public.qorpera_release_runtime_office_viewer(${literal(memberGrant)});`);
	acknowledgeDrain(requestDrain(false));
	console.log("PASS: concurrent member claims, ticket redemptions and duplicate input admit one driver and one dispatch");

	// An effect authority check waiting behind entry must see the private state
	// after the lock wait, rather than releasing a cached shared authorization.
	const privacyMember = `set request.jwt.claims='{"role":"authenticated","sub":"30000000-0000-4000-8000-000000000002"}'; set role authenticated;`;
	const privacyProfile = randomUUID();
	docker(psql, `${privacyMember} select public.qorpera_register_runtime_browser_profile(${literal(setup.scope)},'${privacyProfile}');`);
	const privacyLease = JSON.parse(docker(psql, `${service} ${call("acquire")}`)).lease;
	const privacyBlocker = session();
	privacyBlocker.child.stdin.write(`begin; select id from public.qorpera_runtime_offices for update; select 'PRIVACY_LOCKED';\n`);
	await until(() => privacyBlocker.output().includes("PRIVACY_LOCKED"));
	const privacyCheck = session();
	privacyCheck.child.stdin.end(`${service} set application_name='office-privacy-race'; ${call("check", privacyLease)}`);
	await until(() => docker(psql, "select count(*) from pg_stat_activity where application_name='office-privacy-race' and wait_event_type='Lock';") === "1");
	privacyBlocker.child.stdin.end(`${privacyMember} select public.qorpera_request_runtime_office_privacy(${literal(setup.scope)},'${privacyProfile}','${privacyLease.binding.screenId}',0,true); commit;`);
	const entry = await privacyBlocker.done;
	assert.equal(entry.code, 0, entry.error);
	const privateResult = await privacyCheck.done;
	assert.notEqual(privateResult.code, 0);
	assert.match(privateResult.error, /Office is private/);
	assert.equal(docker(psql, "select count(*) from public.qorpera_runtime_office_screens where lease_id is not null;"), "0");
	console.log("PASS: a native check waiting on privacy entry cannot release old shared authority");
	console.log(`PASS: office registry after ${migrations.length} migrations; no hosted database, provider, NAS or canonical file access`);
} finally {
	if (started) docker(["rm", "-f", "-v", container]);
}
