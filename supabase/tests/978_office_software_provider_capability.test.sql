-- @fixture 405_runtime_office_browser_idle_lease_reap.test.sql until "-- The office checks start here"
-- 20260912000600 on a folder-v2 company (moved from scripts/test-runtime-office-software.mjs in the legacy sweep): the
-- office-software provider capability. Only the protected office-software provider holds it; the office itself runs as
-- service_role and must not be able to use or mint it. 958 §3 pins that service_role can neither read nor write the
-- capability table nor execute the gate, and 001 that anon and authenticated execute none of the RPCs.
-- 1. The gate admits exactly the enrolled capability of a live LXD allocation under the office's provider and policy:
--    not a missing, null, malformed, wrong or disabled one, not the stored digest itself, not another allocation's,
--    and not one whose provider, policy or allocation has moved on. Only service_role claims reach it.
-- 2. A rotation keeps the allocation, provider and policy and raises the revision by exactly one; the old capability is
--    refused after it.
-- 3. Each of the 7 office-software RPCs checks the capability before it takes any lock, checks it again under its locks
--    (the gate holds the capability row FOR SHARE until commit), and passes the raw capability to nothing but the gate.
-- 4. Activating measured software is refused once the capability it was challenged under is disabled or rotated.
-- 405's office fixture on 924's folder-v2 company, with 718's start reserve: an LXD allocation on the office's provider.
-- The capability row is written as postgres, as the operator's enrolment is.
reset role;
update public.qorpera_runtime_offices set state='provisioning';
select pg_temp.base_claims('service_role');
select public.qorpera_set_runtime_office_provider(current_setting('qorpera_test.office_scope')::jsonb,1,
	'39000000-0000-4000-8000-000000000001',repeat('f',64),0,true);
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
select public.qorpera_request_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,
	'39000000-0000-4000-8000-000000000002');
select pg_temp.base_claims('service_role');
select public.qorpera_reserve_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,
	'39000000-0000-4000-8000-000000000002','39000000-0000-4000-8000-000000000003',repeat('c',64),repeat('a',64),repeat('b',64),repeat('d',64),
	'39000000-0000-4000-8000-000000000001',repeat('f',64));
select pg_temp.base_assert((select count(*)=1 from public.qorpera_runtime_machine_allocations
	where id='39000000-0000-4000-8000-000000000003' and provider_adapter='lxd' and released_at is null),
	'the office''s start holds a live LXD allocation');
create function pg_temp.os_gate(p_capability text, p_lock boolean default false,
	p_allocation uuid default '39000000-0000-4000-8000-000000000003') returns text language sql as $$
	select format('select public.qorpera_require_office_software_capability(%L::uuid, %L, %L::boolean)', p_allocation, p_capability, p_lock)
$$;

-- 1 and 2. The gate, called with service_role claims as the office-software provider does.
do $$
declare
	c_alloc constant uuid := '39000000-0000-4000-8000-000000000003';
	c_cap constant text := repeat('ab', 32);
	c_next constant text := repeat('cd', 32);
	c_required constant text := 'Office software provider capability required';
	c_unavailable constant text := 'Office software provider capability unavailable';
	c_rotate constant text := 'update public.qorpera_office_software_provider_capabilities set %s where allocation_id = ''39000000-0000-4000-8000-000000000003''';
	v_case integer; v_set text;
begin
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_error(pg_temp.os_gate(c_cap), '42501', c_unavailable);
	insert into public.qorpera_office_software_provider_capabilities
		values (c_alloc, '39000000-0000-4000-8000-000000000001', repeat('f', 64), encode(extensions.digest(c_cap, 'sha256'), 'hex'), 1, true);
	perform pg_temp.base_assert(public.qorpera_require_office_software_capability(c_alloc, c_cap, false) = 1
		and public.qorpera_require_office_software_capability(c_alloc, c_cap, true) = 1,
		'The enrolled capability is admitted before and under locks, at its revision');
	perform pg_temp.base_error(pg_temp.os_gate(null), '42501', c_required);
	perform pg_temp.base_error(pg_temp.os_gate(upper(c_cap)), '42501', c_required);
	perform pg_temp.base_error(pg_temp.os_gate(left(c_cap, 63)), '42501', c_required);
	perform pg_temp.base_error(pg_temp.os_gate(c_cap, null), '42501', c_required);
	perform pg_temp.base_error(pg_temp.os_gate(repeat('ef', 32)), '42501', c_unavailable);
	perform pg_temp.base_error(pg_temp.os_gate(encode(extensions.digest(c_cap, 'sha256'), 'hex')), '42501', c_unavailable);
	perform pg_temp.base_error(pg_temp.os_gate(c_cap, false, extensions.gen_random_uuid()), '42501', c_unavailable);
	-- Only service_role claims reach the gate: not the owner, not the publishable key, not a caller without claims.
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_error(pg_temp.os_gate(c_cap), '42501', c_required);
	perform pg_temp.base_claims('anon');
	perform pg_temp.base_error(pg_temp.os_gate(c_cap), '42501', c_required);
	perform pg_temp.base_claims(null);
	perform pg_temp.base_error(pg_temp.os_gate(c_cap), '42501', c_required);
	perform pg_temp.base_claims('service_role');
	-- The capability holds only under the office's provider and its policy, on a live allocation (each case rolled back).
	for v_case in 1..3 loop
		begin
			if v_case < 3 then
				delete from public.qorpera_office_software_provider_capabilities where allocation_id = c_alloc;
				insert into public.qorpera_office_software_provider_capabilities values (c_alloc,
					case v_case when 1 then extensions.gen_random_uuid() else '39000000-0000-4000-8000-000000000001' end,
					case v_case when 2 then repeat('e', 64) else repeat('f', 64) end, encode(extensions.digest(c_cap, 'sha256'), 'hex'), 1, true);
			else
				update public.qorpera_runtime_machine_allocations set released_at = clock_timestamp() where id = c_alloc;
			end if;
			perform pg_temp.base_error(pg_temp.os_gate(c_cap), '42501', c_unavailable);
			raise exception using errcode = 'PZ001';
		exception when sqlstate 'PZ001' then null;
		end;
	end loop;
	perform pg_temp.base_assert(public.qorpera_require_office_software_capability(c_alloc, c_cap, true) = 1,
		'The enrolled capability is admitted again once each case is rolled back');
	-- Disabling is a rotation too: the revision moves on, and the capability is refused before and under locks.
	execute format(c_rotate, 'enabled = false, revision = 2');
	perform pg_temp.base_error(pg_temp.os_gate(c_cap), '42501', c_unavailable);
	perform pg_temp.base_error(pg_temp.os_gate(c_cap, true), '42501', c_unavailable);
	-- 2. A rotation keeps the allocation, provider and policy, and raises the revision by exactly one.
	foreach v_set in array array['enabled = true', 'enabled = true, revision = 4', 'enabled = true, revision = 1',
		format('provider_id = %L, revision = 3', extensions.gen_random_uuid()), format('provider_policy_sha256 = %L, revision = 3', repeat('e', 64)),
		format('allocation_id = %L, revision = 3', extensions.gen_random_uuid())] loop
		perform pg_temp.base_error(format(c_rotate, v_set), '42501', 'Office software capability rotation differs');
	end loop;
	execute format(c_rotate, format('capability_sha256 = %L, enabled = true, revision = 3', encode(extensions.digest(c_next, 'sha256'), 'hex')));
	perform pg_temp.base_error(pg_temp.os_gate(c_cap), '42501', c_unavailable);
	perform pg_temp.base_error(pg_temp.os_gate(c_cap, true), '42501', c_unavailable);
	perform pg_temp.base_assert(public.qorpera_require_office_software_capability(c_alloc, c_next, true) = 3,
		'The rotated capability is admitted at its new revision');
end
$$;

-- 3. Each RPC's live definition: the first gate call is the lock-free precheck, and nothing before it locks or calls
-- another function; a second gate call (for an invocation ack, the invocation check) runs under the locks; and every
-- use of the raw capability is one of those calls.
do $$
declare
	f regprocedure; s text; i integer; v_head text; v_first text;
begin
	foreach f in array array['public.qorpera_enroll_office_software(jsonb,jsonb,jsonb,text,text)',
		'public.qorpera_begin_office_software(text,text,text,bigint,text,text)',
		'public.qorpera_check_office_software_install(uuid,uuid,text)',
		'public.qorpera_ack_office_software_install(uuid,uuid,text,jsonb,text,text)',
		'public.qorpera_check_office_software_invocation(jsonb,uuid,uuid,text)',
		'public.qorpera_ack_office_software_invocation(jsonb,uuid,uuid,jsonb,text,text)',
		'public.qorpera_office_software_status(jsonb,text)']::regprocedure[] loop
		select prosrc into strict s from pg_proc where oid = f;
		i := strpos(s, 'public.qorpera_require_office_software_capability(');
		v_head := left(s, greatest(i - 1, 0));
		v_first := substr(s, i, strpos(substr(s, i), ';'));
		perform pg_temp.base_assert(i > 0 and v_first ~ 'p_provider_capability\s*,\s*false\s*\)\s*;$'
			and v_head !~* '\mfor\s+(update|share|no\s+key\s+update|key\s+share)\M|advisory|\mlock\M|public\.qorpera_\w+\s*\(',
			format('%s checks the capability before it takes any lock', f));
		perform pg_temp.base_assert(s ~ 'public\.qorpera_require_office_software_capability\([^;]*p_provider_capability\s*,\s*true\s*\)'
			or s ~ 'public\.qorpera_check_office_software_invocation\([^;]*p_provider_capability\s*\)',
			format('%s checks the capability again under its locks', f));
		perform pg_temp.base_assert((select count(*) from regexp_matches(s, 'p_provider_capability', 'g'))
			= (select count(*) from regexp_matches(s, 'public\.qorpera_require_office_software_capability\([^;]*p_provider_capability\s*,\s*(false|true)\s*\)', 'g'))
			+ (select count(*) from regexp_matches(s, 'public\.qorpera_check_office_software_invocation\([^;]*p_provider_capability\s*\)', 'g')),
			format('%s passes the raw capability to nothing but the gate', f));
	end loop;
end
$$;

-- 4. Activating measured software checks again the capability that the measurement was challenged under. Activation
-- is refused once that capability is disabled, or rotated to a later revision. The baseline, challenge and
-- measurement are written as postgres with foreign keys off, and the activation is a row value, so the test does not
-- run the update flow itself.
do $$
declare
	c_alloc constant uuid := '39000000-0000-4000-8000-000000000003';
	c_activation constant uuid := '39000000-0000-4000-8000-000000000004';
	c_challenge constant uuid := '39000000-0000-4000-8000-000000000005';
	c_rotate constant text := 'update public.qorpera_office_software_provider_capabilities set %s where allocation_id = ''39000000-0000-4000-8000-000000000003''';
	c_startup constant jsonb := jsonb_build_object('serviceInvocationId', repeat('c', 32), 'bootId', '39000000-0000-4000-8000-000000000006',
		'configurationSha256', repeat('a', 64));
	v_activate text := format('select public.qorpera_assert_office_software_activation(%L::public.qorpera_runtime_office_activations)',
		jsonb_populate_record(null::public.qorpera_runtime_office_activations, jsonb_build_object('activation_id', c_activation,
			'allocation_id', c_alloc, 'state', 'active', 'software_revision', 1, 'service_invocation_id', c_startup->>'serviceInvocationId',
			'attestation', c_startup - 'serviceInvocationId')));
begin
	perform pg_temp.base_assert((select revision = 3 and enabled from public.qorpera_office_software_provider_capabilities
		where allocation_id = c_alloc), 'The capability is enabled at revision 3 after §2');
	set local session_replication_role = replica;
	insert into public.qorpera_office_software_baselines values (c_alloc, c_activation, '{}', '{}', '{}', repeat('a', 64), 1);
	insert into public.qorpera_office_software_challenges (id, allocation_id, activation_id, phase, revision, office_revision,
		privacy_version, capability_revision, issued_at, expires_at)
		values (c_challenge, c_alloc, c_activation, 'invocation', 1, 1, 1, 3, now(), now() + interval '5 seconds');
	insert into public.qorpera_office_software_measurements values (c_activation, c_challenge, c_startup, 1, '{}', repeat('b', 64), clock_timestamp());
	set local session_replication_role = origin;
	execute v_activate;
	execute format(c_rotate, 'enabled = false, revision = 4');
	perform pg_temp.base_error(v_activate, '42501', 'Office software activation capability revoked');
	execute format(c_rotate, 'enabled = true, revision = 5');
	perform pg_temp.base_error(v_activate, '42501', 'Office software activation capability revoked');
end
$$;

rollback;
