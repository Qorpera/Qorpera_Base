import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

/** Real SQL revocation, admission races and restart recovery. Physical stop
 * is deliberately unconfirmed: no VM, systemd or NAS observation is forged. */
export async function testOfficeLifecycleRevocation({ scope, binding, startup, attestation, setup, service, owner,
	execute, race, session, until, literal, restartDatabase, LxdOfficeLifecycleControl, action = "service_restart" }) {
	const request = { schema: "qorpera.office-lifecycle-request/v1", transitionId: randomUUID(), action,
		activationId: attestation.activationId, providerId: binding.providerId, providerPolicySha256: binding.providerPolicySha256, startup };
	const begin = value => `select public.qorpera_begin_runtime_office_lifecycle(${literal(value)});`;
	const status = value => `select public.qorpera_runtime_office_lifecycle_status(${literal(value)});`;
	const call = (sql, role = service) => JSON.parse(execute(`${role} ${sql}`).split("\n").at(-1));
	const deny = async (sql, role = service) => { const [r] = await race([`${role} ${sql}`]); assert.notEqual(r.code, 0, "Unexpected lifecycle admission"); };
	const snapshot = () => execute(`select jsonb_build_object('office',to_jsonb(o),'screens',(select jsonb_agg(s order by s.ordinal) from public.qorpera_runtime_office_screens s),
		'allocations',(select jsonb_agg(a) from public.qorpera_runtime_machine_allocations a),'activations',(select jsonb_agg(a) from public.qorpera_runtime_office_activations a)) from public.qorpera_runtime_offices o;`);
	await deny(status(request)); await deny(begin(request), owner); await deny(status(request), owner);
	const before = snapshot();
	for (const change of [{ extra: true }, { action: "suspend" }, { action: null }, { transitionId: null }, { activationId: randomUUID() }, { providerId: randomUUID() }, { providerPolicySha256: "0".repeat(64) }, { startup: null }]) await deny(begin({ ...request, ...change }));
	for (const change of [{ scope: { ...scope, companyId: randomUUID() } }, { extra: true }, { computerGeneration: 2 }, { computerGeneration: "1" }, { computerGeneration: 9007199254740992 }, { bootId: randomUUID() }, { configurationSha256: "0".repeat(64) }, { allocationId: randomUUID() }, { instanceSha256: "0".repeat(64) }, { imageSha256: "0".repeat(64) }, { bootstrapSha256: "0".repeat(64) }, { serviceInvocationId: "0".repeat(32) }, { serviceInvocationId: "c".repeat(32) }]) await deny(begin({ ...request, startup: { ...startup, ...change } }));
	assert.equal(snapshot(), before);
	console.log("PASS: lifecycle request validates every retained authority field and refuses member/malformed calls without changes");
	const lease = call(`select public.qorpera_native_office_screen(${literal(setup.binding)},${literal(scope)},'acquire');`).lease;
	assert(lease);
	const viewer = call(`select public.qorpera_create_runtime_office_viewer(${literal(lease.binding)},${lease.epoch},'watch');`, owner);
	assert.equal(viewer.state, "issued");
	// A viewer ticket is a bearer secret that works once: two redemptions queued behind the computer's lock both read
	// it as issued before they wait, and exactly one wins.
	const viewerLock = session();
	viewerLock.child.stdin.write(`begin; select id from public.qorpera_runtime_offices where id='${scope.companyComputerId}' for update; select 'VIEWER_LOCKED';\n`);
	await until(() => viewerLock.output().includes("VIEWER_LOCKED"));
	const redeemers = [0, 1].map(() => session());
	for (const redeemer of redeemers) redeemer.child.stdin.end(`${service} set application_name='office-viewer-redeem-race'; select public.qorpera_redeem_runtime_office_viewer(${literal(scope)},'${createHash('sha256').update(viewer.capability).digest('hex')}');`);
	await until(() => execute("select count(*) from pg_stat_activity where application_name='office-viewer-redeem-race' and wait_event_type='Lock';") === "2");
	viewerLock.child.stdin.end("rollback;");
	assert.equal((await viewerLock.done).code, 0);
	const redemptions = await Promise.all(redeemers.map(redeemer => redeemer.done));
	assert.equal(redemptions.filter(r => r.code === 0).length, 1, "Exactly one of two queued viewer ticket redemptions must win");
	assert.match(redemptions.find(r => r.code !== 0).error, /Viewer ticket consumed/);
	const viewerGrant = JSON.parse(redemptions.find(r => r.code === 0).output.split("\n").at(-1));
	call(`select public.qorpera_check_runtime_office_viewer(${literal(viewerGrant)});`);
	// One explicitly synthetic unresolved physical effect, tied to a real receipt.
	execute(`insert into public.qorpera_runtime_office_resources(office_id,screen_id,receipt_id,run_id,native_binding,screen_lease,input_sha256,downstream_idempotency_sha256,state,expires_at)
		select '${scope.companyComputerId}','${lease.binding.screenId}',id,run_id,${literal(setup.binding)},${literal(lease)},repeat('1',64),repeat('2',64),'active',clock_timestamp()+interval '5 minutes'
		from public.qorpera_run_operation_receipts order by created_at limit 1;`);
	const preserved = snapshot();
	// Roll back each variant so one actual final transition can be raced below.
	for (const action of ["service_restart", "reboot", "power_off", "replace"]) {
		const value = call(`begin; ${begin({ ...request, action })} rollback;`);
		assert.equal(value.request.action, action); assert.equal(value.state, "draining");
	}
	assert.equal(snapshot(), preserved);
	const existingDrain = call(`begin; ${owner} select public.qorpera_request_runtime_office_drain(${literal(scope)},'${lease.binding.screenId}',1,${lease.binding.screenGeneration},${lease.epoch},true); ${service} reset role;
		select jsonb_build_object('prior',(select jsonb_build_object('drainId',drain_id,'epoch',epoch) from public.qorpera_runtime_office_screens where id='${lease.binding.screenId}'),'transition',public.qorpera_begin_runtime_office_lifecycle(${literal(request)})); rollback;`);
	assert.equal(existingDrain.transition.drains[0].drainId, existingDrain.prior.drainId);
	assert.equal(existingDrain.transition.drains[0].epoch, existingDrain.prior.epoch);
	const privateChallenge = { schema: "synthetic-private-state-for-revocation", retained: true };
	const privacy = call(`begin; reset role; update public.qorpera_runtime_offices set privacy_state='private',privacy_challenge=${literal(privateChallenge)},privacy_version=7; ${service} ${begin(request)} reset role;
		select jsonb_build_object('state',privacy_state,'version',privacy_version,'challenge',privacy_challenge) from public.qorpera_runtime_offices; rollback;`, "");
	assert.deepEqual(privacy, { state: "private", version: 7, challenge: privateChallenge });
	const paused = call(`begin; reset role; insert into public.qorpera_company_execution_pauses(profile_id,paused_by_user_id) values('${scope.companyId}','92400000-0000-4000-8000-000000000001'); ${service} ${begin(request)} rollback;`, "");
	assert.equal(paused.state, "draining");
	assert.equal(snapshot(), preserved);
	console.log("PASS: every action revokes only admission; pending drains, private state and all machine allocations are preserved");
	const blocker = session();
	blocker.child.stdin.write(`begin; select public.qorpera_lock_profile_gc_fence('${scope.companyId}'); select id from public.qorpera_runtime_offices where id='${scope.companyComputerId}' for update; select 'LIFECYCLE_LOCKED';\n`);
	await until(() => blocker.output().includes("LIFECYCLE_LOCKED"));
	const waiting = session(); waiting.child.stdin.end(`${service} set application_name='office-lifecycle-admission-race'; select public.qorpera_native_office_screen(${literal(setup.binding)},${literal(scope)},'renew',${literal(lease)});`);
	await until(() => execute("select count(*) from pg_stat_activity where application_name='office-lifecycle-admission-race' and wait_event_type='Lock';") === "1");
	blocker.child.stdin.end(`${service} ${begin(request)} commit;`);
	const committed = await blocker.done; assert.equal(committed.code, 0, committed.error);
	const denied = await waiting.done; assert.notEqual(denied.code, 0, "Queued renewal crossed lifecycle revocation");
	const expected = call(status(request));
	assert.equal(expected.state, "draining"); assert.equal(expected.drains.length, 1);
	assert.equal(expected.drains[0].epoch, lease.epoch + 1);
	assert.equal(execute("select state from public.qorpera_runtime_offices;"), "maintenance");
	assert.equal(execute("select state from public.qorpera_runtime_office_resources;"), "draining");
	assert.equal(execute("select state from public.qorpera_runtime_office_viewers;"), "draining");
	assert.equal(execute("select count(*) from public.qorpera_runtime_machine_allocations where released_at is null;"), "1");
	for (const sql of [
		`select public.qorpera_check_runtime_office_startup(${literal(startup)});`,
		`select public.qorpera_report_runtime_office_ready(${literal(startup)},'${attestation.activationId}',9443,9444);`,
		`select public.qorpera_check_runtime_office_startup(${literal({ ...startup, serviceInvocationId: "f".repeat(32) })});`,
		`select public.qorpera_activate_runtime_office(${literal(scope)},1,(select '${execute("select intent_id from public.qorpera_runtime_office_activations;")}')::uuid,'${attestation.activationId}','${binding.providerId}','${binding.providerPolicySha256}','${startup.serviceInvocationId}');`,
		`select public.qorpera_check_runtime_office_shared_surface(${literal(lease.binding)});`,
		`select public.qorpera_check_runtime_office_viewer(${literal(viewerGrant)});`,
		`select public.qorpera_create_runtime_office_viewer(${literal(lease.binding)},${lease.epoch},'watch');`,
	]) await deny(sql, sql.includes('create_runtime_office_viewer') ? owner : service);
	assert.equal(call(`select public.qorpera_native_office_screen(${literal(setup.binding)},${literal(scope)},'acquire');`).state, "refused");
	// Native/viewer grant data remains a bounded capability, not stop evidence.
	assert(viewer); await deny(`select * from public.qorpera_runtime_office_lifecycle_transitions;`);
	console.log("PASS: an in-flight admission waits for revocation and fails; old activation, readiness, new screens and viewers stay fenced");
	const contenders = await race([request, request, { ...request, transitionId: randomUUID() }, { ...request, action: action === "replace" ? "service_restart" : "replace" }].map(value => `${service} ${begin(value)}`));
	assert.equal(contenders.filter(r => r.code === 0).length, 2);
	for (const result of contenders.filter(r => r.code === 0)) assert.deepEqual(JSON.parse(result.output), expected);
	const methods = [];
	let loseReply = true;
	const control = new LxdOfficeLifecycleControl(request, { call: async (method, args, signal) => {
		signal.throwIfAborted(); methods.push(method); assert.deepEqual(args, { p_request: request });
		const result = call(method === "qorpera_begin_runtime_office_lifecycle" ? begin(args.p_request) : status(args.p_request));
		if (loseReply) { loseReply = false; throw new Error("Synthetic lost committed revocation reply"); }
		return result;
	} });
	await assert.rejects(control.begin(new AbortController().signal), /UNCONFIRMED/);
	assert.deepEqual(await control.status(new AbortController().signal), expected);
	await restartDatabase();
	assert.deepEqual(await control.status(new AbortController().signal), expected);
	assert.deepEqual(await control.begin(new AbortController().signal), expected);
	for (const drain of expected.drains) call(`select public.qorpera_ack_runtime_office_drain(${literal(scope)},'${drain.binding.screenId}',1,${drain.binding.screenGeneration},${drain.epoch},'${drain.drainId}');`);
	assert.deepEqual(call(status(request)), expected);
	assert.equal(execute("select state from public.qorpera_runtime_office_lifecycle_transitions;"), "draining");
	assert.equal(execute("select count(*) from public.qorpera_runtime_machine_allocations where released_at is null;"), "1");
	assert.equal(execute("select count(*) from public.qorpera_runtime_office_lifecycle_transitions;"), "1");
	assert.deepEqual(methods, ["qorpera_begin_runtime_office_lifecycle", "qorpera_runtime_office_lifecycle_status", "qorpera_runtime_office_lifecycle_status", "qorpera_begin_runtime_office_lifecycle"]);
	console.log("PASS: competing transitions cannot replace identity; committed-reply loss and database restart recover exactly, and screen acknowledgements never imply physical stop or capacity release");
	return { request, revocation: expected, lease, viewerGrant };
}
