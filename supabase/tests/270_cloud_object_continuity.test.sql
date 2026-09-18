-- Synthetic transaction only. No production tenant, identity, or object data.
-- Transport outages are injected in the gateway tests; this fixture exercises
-- the real role grants, exact delegation limits, and late-copy database fence.
begin;

insert into auth.users (id, email, email_confirmed_at) values
	('87000000-0000-4000-8000-000000000001', 'continuity-owner@example.test', statement_timestamp()),
	('87000000-0000-4000-8000-000000000002', 'continuity-member@example.test', statement_timestamp());

select set_config('qorpera_test.continuity_owner', jsonb_build_object(
	'sub', '87000000-0000-4000-8000-000000000001', 'role', 'authenticated',
	'email', 'continuity-owner@example.test', 'user_metadata', '{}'::jsonb,
	'session_id', '87000000-0000-4000-8000-000000000003',
	'exp', floor(extract(epoch from statement_timestamp()))::bigint + 300
)::text, true);
select set_config('request.jwt.claims', current_setting('qorpera_test.continuity_owner'), true);
set local role authenticated;
select set_config('qorpera_test.continuity_profile',
	public.qorpera_create_hosted_profile('Continuity fixture', 'main', 1) ->> 'profile_id', true);
reset role;

insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role)
values (current_setting('qorpera_test.continuity_profile')::uuid,
	'87000000-0000-4000-8000-000000000002', 'continuity-member@example.test', 'Read-only fixture', 'viewer');

-- An ordinary Storage insert remains supported. A later NAS confirmation may
-- switch this catalog entry but may never create a missing one.
insert into storage.objects (bucket_id, name, metadata) values (
	'qorpera-profile-objects', current_setting('qorpera_test.continuity_profile') || '/' || repeat('a', 64), '{"size":"5"}'
);

do $$
begin
	if not has_function_privilege('authenticated', 'public.qorpera_issue_profile_object_read_lease(uuid,text,integer)', 'EXECUTE')
		or has_function_privilege('anon', 'public.qorpera_issue_profile_object_read_lease(uuid,text,integer)', 'EXECUTE')
		or has_function_privilege('service_role', 'public.qorpera_issue_profile_object_read_lease(uuid,text,integer)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_confirm_profile_object_replica(uuid,text,bigint)', 'EXECUTE')
		or has_function_privilege('anon', 'public.qorpera_authorize_profile_object_replication(uuid,text,bigint)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_guard_nas_replica_insert()', 'EXECUTE')
		or not has_function_privilege('service_role', 'public.qorpera_authorize_profile_object_replication(uuid,text,bigint)', 'EXECUTE') then
		raise exception 'continuity function ACLs are invalid';
	end if;
end
$$;

set local role authenticated;
do $$
declare
	v_result jsonb;
	v_lease jsonb;
	v_query text;
	v_denied boolean;
begin
	v_result := public.qorpera_issue_profile_object_read_lease(current_setting('qorpera_test.continuity_profile')::uuid, repeat('a', 64), 60);
	v_lease := v_result -> 'read_lease';
	if v_result ->> 'backend' <> 'supabase-storage' or (v_result ->> 'bytes')::bigint <> 5
		or v_lease ->> 'profileId' <> current_setting('qorpera_test.continuity_profile')
		or v_lease ->> 'sha256' <> repeat('a', 64)
		or v_lease ->> 'subjectId' <> auth.uid()::text
		or v_lease ->> 'sessionId' <> auth.jwt() ->> 'session_id'
		or (v_lease ->> 'leaseId')::uuid is null
		or (v_lease ->> 'expiresAt')::timestamptz <= (v_lease ->> 'issuedAt')::timestamptz
		or (v_lease ->> 'expiresAt')::timestamptz > (v_lease ->> 'issuedAt')::timestamptz + interval '60 seconds' then
		raise exception 'read delegation changed its tenant/object/session or exceeded its lifetime: %', v_result;
	end if;
	foreach v_query in array array[
		format('select public.qorpera_issue_profile_object_read_lease(%L, %L, 61)', current_setting('qorpera_test.continuity_profile'), repeat('a', 64)),
		format('select public.qorpera_issue_profile_object_read_lease(%L, %L, 0)', current_setting('qorpera_test.continuity_profile'), repeat('a', 64)),
		format('select public.qorpera_issue_profile_object_read_lease(null, %L, 60)', repeat('a', 64)),
		format('select public.qorpera_issue_profile_object_read_lease(%L, null, 60)', current_setting('qorpera_test.continuity_profile')),
		format('select public.qorpera_issue_profile_object_read_lease(%L, %L, 60)', '87000000-0000-4000-8000-000000000099', repeat('a', 64)),
		format('select public.qorpera_confirm_profile_object_replica(%L, %L, 5)', current_setting('qorpera_test.continuity_profile'), repeat('a', 64))
	] loop
		v_denied := false;
		begin execute v_query;
		exception when insufficient_privilege then v_denied := true;
		end;
		if not v_denied then raise exception 'invalid read authority was accepted: %', v_query; end if;
	end loop;

	-- Near-expiry JWTs shorten, never extend, the delegation.
	perform set_config('request.jwt.claims', (auth.jwt() || jsonb_build_object('exp', floor(extract(epoch from statement_timestamp()))::bigint + 10))::text, true);
	v_lease := public.qorpera_issue_profile_object_read_lease(current_setting('qorpera_test.continuity_profile')::uuid, repeat('a', 64), 60) -> 'read_lease';
	if (v_lease ->> 'expiresAt')::timestamptz <> to_timestamp((auth.jwt() ->> 'exp')::double precision) then
		raise exception 'read delegation outlives its JWT';
	end if;
	foreach v_query in array array[
		(auth.jwt() || '{"exp":1}'::jsonb)::text,
		(auth.jwt() - 'exp')::text,
		(auth.jwt() - 'session_id')::text,
		(auth.jwt() || '{"session_id":"another-session"}'::jsonb)::text,
		(auth.jwt() - 'sub')::text
	] loop
		perform set_config('request.jwt.claims', v_query, true);
		v_denied := false;
		begin
			perform public.qorpera_issue_profile_object_read_lease(current_setting('qorpera_test.continuity_profile')::uuid, repeat('a', 64), 60);
		exception when insufficient_privilege then v_denied := true;
		end;
		if not v_denied then raise exception 'missing or expired session authority was accepted'; end if;
	end loop;
end
$$;
reset role;

-- A viewer can obtain read-only delegation, but removing membership stops new
-- grants immediately. An already installed grant's bounded delay is tested at
-- the gateway; SQL deliberately does not claim remote instant revocation.
select set_config('request.jwt.claims', (current_setting('qorpera_test.continuity_owner')::jsonb || jsonb_build_object(
	'sub', '87000000-0000-4000-8000-000000000002', 'session_id', '87000000-0000-4000-8000-000000000004'
))::text, true);
set local role authenticated;
select public.qorpera_issue_profile_object_read_lease(current_setting('qorpera_test.continuity_profile')::uuid, repeat('a', 64), 60);
reset role;
delete from public.qorpera_profile_members where profile_id = current_setting('qorpera_test.continuity_profile')::uuid
	and user_id = '87000000-0000-4000-8000-000000000002';
set local role authenticated;
do $$
declare v_denied boolean := false;
begin
	begin
		perform public.qorpera_issue_profile_object_read_lease(current_setting('qorpera_test.continuity_profile')::uuid, repeat('a', 64), 60);
	exception when insufficient_privilege then v_denied := true;
	end;
	if not v_denied then raise exception 'revoked member obtained a new read delegation'; end if;
end
$$;
reset role;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select public.qorpera_confirm_profile_object_replica(current_setting('qorpera_test.continuity_profile')::uuid, repeat('a', 64), 5);
select public.qorpera_confirm_profile_object_replica(current_setting('qorpera_test.continuity_profile')::uuid, repeat('a', 64), 5);
do $$
declare v_query text; v_denied boolean;
begin
	foreach v_query in array array[
		format('select public.qorpera_authorize_profile_object_replication(%L, %L, 6)', current_setting('qorpera_test.continuity_profile'), repeat('a', 64)),
		format('select public.qorpera_confirm_profile_object_replica(%L, %L, 5)', current_setting('qorpera_test.continuity_profile'), repeat('b', 64)),
		format('select public.qorpera_issue_profile_object_read_lease(%L, %L, 60)', current_setting('qorpera_test.continuity_profile'), repeat('a', 64))
	] loop
		v_denied := false;
		begin execute v_query;
		exception when insufficient_privilege then v_denied := true;
		end;
		if not v_denied then raise exception 'replication enlarged authority: %', v_query; end if;
	end loop;
end
$$;

-- A retry against the same immutable object is legal; the marker is checked
-- inside the actual Storage transaction, not merely before issuing a POST.
delete from storage.objects where bucket_id = 'qorpera-profile-objects'
	and name = current_setting('qorpera_test.continuity_profile') || '/' || repeat('a', 64);
insert into storage.objects (bucket_id, name, metadata, user_metadata) values (
	'qorpera-profile-objects', current_setting('qorpera_test.continuity_profile') || '/' || repeat('a', 64),
	'{"contentLength":5}', '{"qorpera_nas_replica":true,"qorpera_nas_replica_bytes":5}'
);
update storage.objects set metadata = '{"size":"5"}'
	where bucket_id = 'qorpera-profile-objects' and name = current_setting('qorpera_test.continuity_profile') || '/' || repeat('a', 64);
do $$
declare v_denied boolean := false;
begin
	begin
		update storage.objects set metadata = '{"size":"6"}'
		where bucket_id = 'qorpera-profile-objects' and name = current_setting('qorpera_test.continuity_profile') || '/' || repeat('a', 64);
	exception when insufficient_privilege then v_denied := true;
	end;
	if not v_denied then raise exception 'replica completion changed its preflight byte commitment'; end if;
end
$$;
reset role;

insert into public.qorpera_company_object_gc_leases (profile_id, lease_id, lease_expires_at)
values (current_setting('qorpera_test.continuity_profile')::uuid, '87000000-0000-4000-8000-000000000005', statement_timestamp() + interval '10 minutes');
set local role service_role;
do $$
declare v_denied boolean := false;
begin
	begin
		update storage.objects set metadata = '{"size":"5"}'
		where bucket_id = 'qorpera-profile-objects' and name = current_setting('qorpera_test.continuity_profile') || '/' || repeat('a', 64);
	exception when sqlstate 'PGRST' then v_denied := true;
	end;
	if not v_denied then raise exception 'late replica write crossed an active cleanup fence'; end if;
end
$$;
reset role;

-- Simulate cleanup completion before a timed-out copy finally reaches Storage.
-- No fresh catalog row may be invented by its metadata insert/mirror trigger.
delete from storage.objects where bucket_id = 'qorpera-profile-objects'
	and name = current_setting('qorpera_test.continuity_profile') || '/' || repeat('a', 64);
delete from public.qorpera_profile_objects where profile_id = current_setting('qorpera_test.continuity_profile')::uuid and sha256 = repeat('a', 64);
delete from public.qorpera_company_object_gc_leases where profile_id = current_setting('qorpera_test.continuity_profile')::uuid;
set local role service_role;
do $$
declare v_denied boolean := false;
begin
	begin
		insert into storage.objects (bucket_id, name, metadata, user_metadata) values (
			'qorpera-profile-objects', current_setting('qorpera_test.continuity_profile') || '/' || repeat('a', 64),
			'{"size":"5"}', '{"qorpera_nas_replica":true,"qorpera_nas_replica_bytes":5}'
		);
	exception when insufficient_privilege then v_denied := true;
	end;
	if not v_denied then raise exception 'late replica resurrected a cleaned object'; end if;
end
$$;
reset role;
do $$
begin
	if exists (select 1 from public.qorpera_profile_objects where profile_id = current_setting('qorpera_test.continuity_profile')::uuid)
		or exists (select 1 from storage.objects where bucket_id = 'qorpera-profile-objects' and name like current_setting('qorpera_test.continuity_profile') || '/%') then
		raise exception 'replication left duplicate or resurrected catalog/storage rows';
	end if;
end
$$;

rollback;
