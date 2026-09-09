import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/** Real SQL authority/concurrency with explicit synthetic physical readiness.
 * This does not attest a service, boot a guest or contact a hosted database. */
export async function testOfficeActivation({ scope, binding, instanceSha256, providerBindingSha256, intent, service, owner, execute, race, session, until, literal, CompanyComputerStartupControl, LxdOfficeActivationControl }) {
	const attestation = { schema: "qorpera.office-activation-attestation/v1", activationId: randomUUID(), bootId: randomUUID(), preparationObservationSha256: "1".repeat(64), configurationObservationSha256: "2".repeat(64), configurationSha256: "3".repeat(64), adoptionReceiptSha256: "4".repeat(64), nativePort: 9443, viewerPort: 9444 };
	const startup = { scope, computerGeneration: 1, allocationId: binding.allocationId, instanceSha256, imageSha256: "a".repeat(64), bootstrapSha256: "b".repeat(64), bootId: attestation.bootId, configurationSha256: attestation.configurationSha256, serviceInvocationId: "a".repeat(32) };
	const prepare = (value = attestation) => `select public.qorpera_prepare_runtime_office_activation(${literal(scope)},1,'${intent}','${binding.allocationId}','${instanceSha256}','${providerBindingSha256}','${binding.providerId}','${binding.providerPolicySha256}','[]',${literal(value)});`;
	const check = (value = startup) => `select public.qorpera_check_runtime_office_startup(${literal(value)});`;
	const ready = (value = startup, activation = attestation.activationId, native = 9443, viewer = 9444) => `select public.qorpera_report_runtime_office_ready(${literal(value)},'${activation}',${native},${viewer});`;
	const activate = (invocation = startup.serviceInvocationId, activation = attestation.activationId) => `select public.qorpera_activate_runtime_office(${literal(scope)},1,'${intent}','${activation}','${binding.providerId}','${binding.providerPolicySha256}','${invocation}');`;
	const status = `select public.qorpera_runtime_office_activation_status(${literal(scope)},1,'${intent}','${attestation.activationId}','${binding.providerId}','${binding.providerPolicySha256}');`;
	const guest = `select public.qorpera_check_runtime_office_guest_binding(${literal(scope)},1,'${binding.allocationId}','${instanceSha256}','${startup.imageSha256}','${startup.bootstrapSha256}');`;
	const call = sql => JSON.parse(execute(`${service} ${sql}`));
	const signal = new AbortController().signal;
	const providerCalls = [];
	const provider = new LxdOfficeActivationControl(intent, binding, attestation, [], { call: async (method, args, checked) => {
		checked.throwIfAborted(); providerCalls.push(method);
		assert(["qorpera_prepare_runtime_office_activation", "qorpera_runtime_office_activation_status", "qorpera_activate_runtime_office"].includes(method));
		const parameters = Object.entries(args).map(([key, value]) => {
			assert(/^p_[a-z0-9_]+$/.test(key));
			return `${key} => ${key === "p_computer_generation" ? String(value) : literal(value) + (typeof value === "string" ? " #>> '{}'" : "")}`;
		});
		// Named arguments need UUID/text typing; JSON scalar extraction is text,
		// so add the exact PostgreSQL types for the three public provider RPCs.
		const typed = Object.entries(args).map(([key, value], index) => typeof value === "string" && ["p_intent_id", "p_provider_id", "p_allocation_id", "p_activation_id"].includes(key)
			? `${key} => (${literal(value)} #>> '{}')::uuid` : parameters[index]);
		return call(`select public.${method}(${typed.join(",")});`);
	} });
	const deny = async (sql, role = service) => {
		const [result] = await race([`${role} ${sql}`]); assert.notEqual(result.code, 0, "unexpected SQL admission");
	};
	await deny(check()); await deny(activate());
	await deny(prepare(), owner);
	const prepared = call(prepare());
	assert.equal(prepared.state, "prepared"); assert.equal(prepared.serviceInvocationId, null); assert.equal(prepared.readinessFresh, false);
	assert.deepEqual(call(prepare()), prepared); assert.deepEqual(call(status), prepared);
	assert.deepEqual(await provider.prepare(signal), { state: "prepared", serviceInvocationId: null, readinessFresh: false });
	assert.deepEqual(await provider.status(signal), { state: "prepared", serviceInvocationId: null, readinessFresh: false });
	assert.equal(execute("select state from public.qorpera_runtime_offices;"), "provisioning");
	await deny(guest); await deny(activate());
	for (const change of [ { schema: "old" }, { activationId: randomUUID() }, { bootId: randomUUID() }, { preparationObservationSha256: "5".repeat(64) }, { configurationObservationSha256: "6".repeat(64) }, { configurationSha256: "7".repeat(64) }, { adoptionReceiptSha256: "8".repeat(64) }, { nativePort: 9445 }, { viewerPort: 9445 }, { nativePort: 9444 }, { viewerPort: 0 }, { extra: true }, { activationId: null } ]) await deny(prepare({ ...attestation, ...change }));
	await deny(prepare({ ...attestation, nativePort: "9443" }));
	assert.equal(call(check()).state, "prepared");
	for (const change of [ { computerGeneration: 2 }, { allocationId: randomUUID() }, { instanceSha256: "9".repeat(64) }, { imageSha256: "c".repeat(64) }, { bootstrapSha256: "d".repeat(64) }, { bootId: randomUUID() }, { configurationSha256: "e".repeat(64) }, { serviceInvocationId: "invalid" }, { serviceInvocationId: "0".repeat(32) }, { extra: true }, { scope: { ...scope, companyId: randomUUID() } } ]) {
		await deny(check({ ...startup, ...change })); await deny(ready({ ...startup, ...change }));
	}
	await deny(ready(startup, randomUUID())); await deny(ready(startup, attestation.activationId, 9445)); await deny(ready(startup, attestation.activationId, 9443, 9445));
	await deny(ready(), owner);
	console.log("PASS: configuration prepares immutable startup identity without active work; altered evidence, bindings, listeners and member calls refused");
	const invocations = ["a".repeat(32), "b".repeat(32)];
	const competing = await race(invocations.map(serviceInvocationId => `${service} ${ready({ ...startup, serviceInvocationId })}`));
	assert.equal(competing.filter(r => r.code === 0).length, 1);
	startup.serviceInvocationId = invocations[competing.findIndex(r => r.code === 0)];
	assert.equal(call(check()).state, "ready"); assert.equal(call(status).serviceInvocationId, startup.serviceInvocationId);
	await deny(guest); await deny(activate("c".repeat(32))); await deny(activate(startup.serviceInvocationId, randomUUID()));
	execute("update public.qorpera_runtime_office_activations set ready_at=clock_timestamp()-interval '6 seconds';");
	assert.equal(call(status).readinessFresh, false); await deny(activate());
	await deny(ready({ ...startup, serviceInvocationId: "c".repeat(32) }));
	assert.equal(call(ready()).state, "ready");
	console.log("PASS: competing service invocations have one winner; expired readiness cannot activate or reassign its invocation");
	// Cancellation is visible inside the same transaction and rolls back so this
	// fixture can also exercise the final successful activation of this office.
	const cancelled = await race([`begin; ${owner} select public.qorpera_cancel_runtime_office_start(${literal(scope)},1,'${intent}'); ${service} ${activate()} rollback;`]);
	assert.notEqual(cancelled[0].code, 0); assert.match(cancelled[0].error, /Office start reservation differs/);
	const blocking = session();
	blocking.child.stdin.write(`begin; select public.qorpera_lock_profile_gc_fence('${scope.companyId}'); select id from public.qorpera_runtime_offices where id='${scope.companyComputerId}' for update; select 'ACTIVATION_LOCKED';\n`);
	await until(() => blocking.output().includes("ACTIVATION_LOCKED"));
	const waiting = session();
	waiting.child.stdin.end(`${service} set application_name='office-activation-disable-race'; ${activate()}`);
	await until(() => execute("select count(*) from pg_stat_activity where application_name='office-activation-disable-race' and wait_event_type='Lock';") === "1");
	blocking.child.stdin.end(`${service} select public.qorpera_set_runtime_office_provider(${literal(scope)},1,'${binding.providerId}','${binding.providerPolicySha256}',1,false); commit;`);
	assert.equal((await blocking.done).code, 0);
	const refused = await waiting.done; assert.notEqual(refused.code, 0); assert.match(refused.error, /Office provider authority unavailable/);
	assert.equal(call(status).state, "ready"); await deny(check()); await deny(ready());
	assert.equal(execute("select count(*) from public.qorpera_runtime_machine_allocations where released_at is null;"), "1");
	execute(`${service} select public.qorpera_set_runtime_office_provider(${literal(scope)},1,'${binding.providerId}','${binding.providerPolicySha256}',2,true);`);
	call(ready());
	console.log("PASS: cancellation and provider-disable lock races fence activation while retaining allocation and readiness identity");
	let reportCount = 0, physicalCount = 0;
	const runtime = new CompanyComputerStartupControl(startup, { call: async (method, args, checked) => {
		checked.throwIfAborted();
		assert.deepEqual(args.p_startup, startup);
		if (method === "qorpera_check_runtime_office_startup") return call(check(args.p_startup));
		assert.equal(method, "qorpera_report_runtime_office_ready");
		const result = call(ready(args.p_startup, args.p_activation_id, args.p_native_port, args.p_viewer_port));
		if (++reportCount === 1) {
			assert.equal(result.state, "ready");
			assert.equal(execute("select state from public.qorpera_runtime_offices;"), "provisioning");
			assert.equal((await provider.status(checked)).readinessFresh, true);
			const contenders = await race([`${service} ${activate()}`, `${service} ${activate()}`]);
			for (const result of contenders) assert.equal(result.code, 0, result.error);
			assert.deepEqual(JSON.parse(contenders[0].output), JSON.parse(contenders[1].output));
			assert.equal((await provider.activate(startup.serviceInvocationId, checked)).state, "active");
		}
		return result;
	} });
	assert.equal((await runtime.check(signal)).state, "ready");
	await runtime.waitForActivation({ nativePort: 9443, viewerPort: 9444 }, async () => { physicalCount++; }, signal);
	assert.equal(reportCount, 2); assert.equal(physicalCount, 2);
	assert.equal((await provider.status(signal)).state, "active");
	assert.deepEqual(providerCalls, ["qorpera_prepare_runtime_office_activation", "qorpera_runtime_office_activation_status", "qorpera_runtime_office_activation_status", "qorpera_activate_runtime_office", "qorpera_runtime_office_activation_status"]);
	console.log("PASS: actual runtime startup and provider activation adapters agree with real SQL; waiting runtime admits no work before provider activation");
	const active = await race([`${service} ${activate()}`, `${service} ${activate()}`]);
	for (const result of active) assert.equal(result.code, 0, result.error);
	assert.deepEqual(JSON.parse(active[0].output), JSON.parse(active[1].output));
	assert.equal(call(activate()).state, "active"); assert.equal(call(status).state, "active");
	assert.equal(call(check()).state, "active"); assert.equal(call(ready()).state, "active");
	assert.equal(call(guest).state, "authorized"); await deny(prepare());
	await deny(check({ ...startup, serviceInvocationId: "c".repeat(32) }));
	execute(`${service} select public.qorpera_set_runtime_office_provider(${literal(scope)},1,'${binding.providerId}','${binding.providerPolicySha256}',3,false);`);
	assert.equal(call(check()).state, "active");
	assert.equal(execute("select count(*) from public.qorpera_runtime_machine_allocations where released_at is null;"), "1");
	for (const sql of ["select * from public.qorpera_runtime_office_activations;", `select public.qorpera_assert_runtime_office_activation_attestation(${literal(attestation)});`, `select public.qorpera_lock_runtime_office_startup(${literal(startup)});`]) await deny(sql);
	console.log("PASS: matching activation commits once and recovers lost replies without re-preparation; active work and private RPC permissions remain fenced");
	return { activated: true, physicalReadiness: "synthetic", serviceInvocationId: startup.serviceInvocationId, startup, attestation };
}
