// Called inside the disposable office start SQL proof. Synthetic pre-existing
// prepared profiles stand in for a previous guest sign-in; authority checks,
// ownership revocation and database locks are real. No physical copy occurs.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export async function testOfficeAdoptionAuthority({ scope, control, service, owner, sqlCall, race, session, until, execute, literal }) {
	await control.checkAdoption([], new AbortController().signal);
	const screenId = randomUUID(), profileId = randomUUID(), grantId = randomUUID(), memberId = randomUUID();
	const staffAgentId = "30000000-0000-4000-8000-000000000030";
	const binding = { ...scope, computerGeneration: 1, screenId, screenOrdinal: 1, screenGeneration: 1, staffAgentId };
	const mapping = { binding, browserProfile: { profileId, grantId, version: 1 } };
	// The existing adapter calls a registry that translates these arguments.
	// Reconstruct from retained SQL identity for transactional negative cases.
	const args = JSON.parse(execute(`select jsonb_build_object('p_scope',${literal(scope)},'p_computer_generation',1,
		'p_intent_id',i.id,'p_allocation_id',i.allocation_id,'p_instance_sha256',i.instance_sha256,
		'p_provider_binding_sha256',i.provider_binding_sha256,'p_provider_id',p.provider_id,'p_provider_policy_sha256',p.policy_sha256)
		from public.qorpera_runtime_office_start_intents i join public.qorpera_runtime_office_providers p
		on p.office_id=i.office_id and p.computer_generation=i.computer_generation where i.office_id='${scope.companyComputerId}';`));
	const call = (mappings) => sqlCall("qorpera_check_runtime_office_adoption", { ...args, p_mappings: mappings });
	const deny = async (change, mappings = [mapping], expected = /Office adoption/, role = service) => {
		const [result] = await race([`begin; ${change} ${role} ${call(mappings)} rollback;`]);
		assert.notEqual(result.code, 0, "Adoption unexpectedly authorized");
		assert.match(result.error, expected);
	};
	execute(`insert into auth.users(id) values('${memberId}');
		insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values('${scope.companyId}','${memberId}','fixture@example.test','Fixture','contributor');
		insert into public.qorpera_runtime_office_screens(office_id,id,ordinal,staff_agent_id)
		values('${scope.companyComputerId}','${screenId}',1,'${staffAgentId}');
		-- The company browser (2026-09-17 amendment) already gives this agent a company-owned profile and an active
		-- grant, and one agent drives one profile. The synthetic member-owned profile below stands in for it so the
		-- membership-bound adoption refusals stay proven; the company grant is retired first.
		update public.qorpera_runtime_browser_grants g set state='revoked',version=g.version+1
		where g.office_id='${scope.companyComputerId}' and g.staff_agent_id='${staffAgentId}' and g.state='active'
			and exists(select 1 from public.qorpera_runtime_browser_profiles p where p.id=g.profile_id and p.company_owned);
		insert into public.qorpera_runtime_browser_profiles(id,office_id,owner_user_id,prepared,verified_version)
		values('${profileId}','${scope.companyComputerId}','${memberId}',true,1);
		insert into public.qorpera_runtime_browser_grants(id,profile_id,office_id,staff_agent_id,profile_version,owner_membership_version,state)
		values('${grantId}','${profileId}','${scope.companyComputerId}','${staffAgentId}',1,0,'active');`);
	const grant = await control.checkAdoption([mapping], new AbortController().signal);
	assert(grant.validForMs > 0 && !grant.signal.aborted);
	await control.checkAdoption([{ binding, browserProfile: null }], new AbortController().signal);
	assert.equal(JSON.parse(execute(`begin; update public.qorpera_runtime_offices set state='recovering'; ${service} ${call([mapping])} rollback;`)).state, "authorized");
	for (const field of Object.keys(binding)) {
		await deny("", [{ ...mapping, binding: { ...binding, [field]: typeof binding[field] === "number" ? 99 : randomUUID() } }], /Office adoption screen differs/);
	}
	for (const field of Object.keys(mapping.browserProfile)) {
		await deny("", [{ ...mapping, browserProfile: { ...mapping.browserProfile, [field]: field === "version" ? 99 : randomUUID() } }], /Office adoption browser grant unavailable/);
	}
	await deny("", [mapping, mapping], /Office adoption screen differs/);
	await deny("", [{ ...mapping, extra: true }], /Invalid office adoption mapping/);
	await deny("", [{ binding }], /Invalid office adoption mapping/);
	await deny("", Array.from({ length: 33 }, () => mapping), /Invalid office adoption mappings/);
	await deny("", null, /Invalid office adoption mappings/);
	await deny("", [], /permission denied for function/, owner);
	await deny(`update public.qorpera_runtime_office_access set state='revoked';`, [mapping], /Office adoption staff access unavailable/);
	await deny(`update public.qorpera_profile_staff set employment_status='archived' where staff_agent_id='${staffAgentId}';`, [mapping], /Office adoption staff access unavailable/);
	await deny(`update public.qorpera_runtime_browser_grants set state='revoked';`, [mapping], /Office adoption browser grant unavailable/);
	await deny(`update public.qorpera_runtime_browser_profiles set version=2,prepared=false,verified_version=null;`, [mapping], /Office adoption browser grant unavailable/);
	await deny(`update public.qorpera_runtime_browser_grants set profile_version=2;`, [mapping], /Office adoption browser grant unavailable/);
	await deny(`delete from public.qorpera_profile_members where profile_id='${scope.companyId}' and user_id='${memberId}';`, [mapping], /Office adoption browser grant unavailable/);
	await deny(`delete from public.qorpera_profile_members where profile_id='${scope.companyId}' and user_id='${memberId}';
		insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values('${scope.companyId}','${memberId}','fixture@example.test','Fixture','contributor');`, [mapping], /Office adoption browser grant unavailable/);
	await deny(`update public.qorpera_runtime_office_screens set power='open';`, [], /Office adoption surfaces not drained/);
	await deny(`update public.qorpera_runtime_office_screens set drain_pending=true,drain_id='${randomUUID()}';`, [], /Office adoption surfaces not drained/);
	await deny(`update public.qorpera_runtime_office_screens set takeover_user_id='${memberId}';`, [], /Office adoption surfaces not drained/);
	for (const state of ["active", "draining"]) {
		await deny(`insert into public.qorpera_runtime_office_resources(office_id,screen_id,receipt_id,run_id,native_binding,screen_lease,
			input_sha256,downstream_idempotency_sha256,state,expires_at)
			select '${scope.companyComputerId}','${screenId}',id,run_id,'{}','{}',repeat('a',64),repeat('b',64),'${state}',clock_timestamp()-interval '1 hour'
			from public.qorpera_run_operation_receipts limit 1;`, [], /Office adoption surfaces not drained/);
	}
	for (const state of ["issued", "active", "draining"]) {
		await deny(`insert into public.qorpera_runtime_office_viewers(office_id,screen_id,member_id,membership_version,binding,screen_epoch,
			privacy_version,mode,capability_sha256,state,expires_at,absolute_deadline)
			values('${scope.companyComputerId}','${screenId}','${memberId}',0,'{}',0,1,'watch',repeat('c',64),'${state}',
			clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 hour');`, [], /Office adoption surfaces not drained/);
	}
	await deny(`update public.qorpera_runtime_offices set state='active';`, [mapping], /Office start authority unavailable/);
	// A revoked mapping cannot be resurrected by restoring the old directory;
	// explicit quarantine (null browser grant) remains possible.
	assert.equal(JSON.parse(execute(`begin; update public.qorpera_runtime_browser_grants set state='revoked';
		${service} ${call([{ binding, browserProfile: null }])} rollback;`)).state, "authorized");
	assert.equal(execute("select state from public.qorpera_runtime_offices;"), "provisioning");
	const revoker = session();
	revoker.child.stdin.write(`begin; select public.qorpera_lock_profile_gc_fence('${scope.companyId}');
		select id from public.qorpera_runtime_offices where id='${scope.companyComputerId}' for update; select 'ADOPTION_LOCKED';\n`);
	await until(() => revoker.output().includes("ADOPTION_LOCKED"));
	const waiting = session();
	waiting.child.stdin.end(`${service} set application_name='office-adoption-owner-race'; ${call([mapping])}`);
	await until(() => execute("select count(*) from pg_stat_activity where application_name='office-adoption-owner-race' and wait_event_type='Lock';") === "1");
	revoker.child.stdin.end(`delete from public.qorpera_profile_members where profile_id='${scope.companyId}' and user_id='${memberId}';
		insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
		values('${scope.companyId}','${memberId}','fixture@example.test','Fixture','contributor'); commit;`);
	const revoked = await revoker.done;
	assert.equal(revoked.code, 0, revoked.error);
	const denied = await waiting.done;
	assert.notEqual(denied.code, 0);
	assert.match(denied.error, /Office adoption browser grant unavailable/);
	await control.checkAdoption([{ binding, browserProfile: null }], new AbortController().signal);
	console.log("PASS: adoption waiting behind owner removal/rejoin sees the new membership incarnation and refuses the old grant");
	console.log("PASS: adoption authority binds exact screens, current prepared grants, membership incarnation and drained surfaces; quarantine grants no browser access");
}
