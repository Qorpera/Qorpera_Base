-- Event intake, step W1a (20260929260000): hooks, the intake door, duplicates, limits, retention
-- and who may do what.
begin;

create function pg_temp.hook_claims(p_role text, p_user uuid default null)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', p_role, 'sub', p_user)::text, true)::text::void
$$;
create function pg_temp.hook_assert(p_value boolean, p_message text)
returns void language plpgsql as $$
begin if p_value is distinct from true then raise exception '%', p_message; end if; end
$$;
create function pg_temp.hook_error(p_statement text, p_code text)
returns void language plpgsql as $$
begin
	begin execute p_statement;
	exception when others then
		if sqlstate = p_code then return; end if;
		raise exception 'Expected % from %, got %: %', p_code, p_statement, sqlstate, sqlerrm;
	end;
	raise exception 'Expected % from %, but it succeeded', p_code, p_statement;
end
$$;
create function pg_temp.receive(p_address text, p_body text, p_headers jsonb default '{}'::jsonb)
returns jsonb language sql as $$
	select public.qorpera_receive_event(p_address, 'application/json', p_headers,
		encode(convert_to(p_body, 'UTF8'), 'base64'))
$$;

insert into auth.users(id, email) values
	('73000000-0000-4000-8000-000000000001', 'hook-owner@example.test'),
	('73000000-0000-4000-8000-000000000002', 'hook-admin@example.test'),
	('73000000-0000-4000-8000-000000000003', 'hook-contributor@example.test'),
	('73000000-0000-4000-8000-000000000004', 'hook-viewer@example.test'),
	('73000000-0000-4000-8000-000000000005', 'hook-outsider@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id) values
	('73000000-0000-4000-8000-000000000010', 'Hook company', '73000000-0000-4000-8000-000000000001'),
	('73000000-0000-4000-8000-000000000011', 'Other company', '73000000-0000-4000-8000-000000000005');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('73000000-0000-4000-8000-000000000010', '73000000-0000-4000-8000-000000000001', 'hook-owner@example.test', 'Owner', 'owner'),
	('73000000-0000-4000-8000-000000000010', '73000000-0000-4000-8000-000000000002', 'hook-admin@example.test', 'Admin', 'admin'),
	('73000000-0000-4000-8000-000000000010', '73000000-0000-4000-8000-000000000003', 'hook-contributor@example.test', 'Contributor', 'contributor'),
	('73000000-0000-4000-8000-000000000010', '73000000-0000-4000-8000-000000000004', 'hook-viewer@example.test', 'Viewer', 'viewer'),
	('73000000-0000-4000-8000-000000000011', '73000000-0000-4000-8000-000000000005', 'hook-outsider@example.test', 'Outsider', 'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id) values
	('73000000-0000-4000-8000-000000000020', '73000000-0000-4000-8000-000000000010', 'Environment', 1, '73000000-0000-4000-8000-000000000001'),
	('73000000-0000-4000-8000-000000000021', '73000000-0000-4000-8000-000000000011', 'Environment', 1, '73000000-0000-4000-8000-000000000005');

-- Privileges: the tables are closed to every client role; each function has exactly its callers.
do $$
declare v_role text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		if has_table_privilege(v_role, 'public.qorpera_event_hooks', 'SELECT,INSERT,UPDATE,DELETE')
			or has_table_privilege(v_role, 'public.qorpera_event_deliveries', 'SELECT,INSERT,UPDATE,DELETE') then
			raise exception 'Event intake tables are exposed to %', v_role;
		end if;
		if has_function_privilege(v_role, 'public.qorpera_event_hook_descriptor(public.qorpera_event_hooks,boolean)', 'EXECUTE')
			or has_function_privilege(v_role, 'public.qorpera_event_kept_headers()', 'EXECUTE') then
			raise exception 'A private event intake helper is exposed to %', v_role;
		end if;
	end loop;
	foreach v_role in array array['anon', 'authenticated', 'qorpera_secret_broker'] loop
		if has_function_privilege(v_role, 'public.qorpera_receive_event(text,text,jsonb,text)', 'EXECUTE')
			or has_function_privilege(v_role, 'public.qorpera_purge_event_deliveries(integer)', 'EXECUTE') then
			raise exception 'The intake door is exposed to %', v_role;
		end if;
	end loop;
	foreach v_role in array array['anon', 'service_role', 'qorpera_secret_broker'] loop
		if has_function_privilege(v_role, 'public.qorpera_create_event_hook(uuid,uuid,text,text,text,integer,integer)', 'EXECUTE')
			or has_function_privilege(v_role, 'public.qorpera_set_event_hook_status(uuid,text)', 'EXECUTE')
			or has_function_privilege(v_role, 'public.qorpera_list_event_hooks(uuid,uuid)', 'EXECUTE')
			or has_function_privilege(v_role, 'public.qorpera_list_event_deliveries(uuid,integer)', 'EXECUTE') then
			raise exception 'A member hook function is exposed to %', v_role;
		end if;
	end loop;
	if not has_function_privilege('service_role', 'public.qorpera_receive_event(text,text,jsonb,text)', 'EXECUTE')
		or not has_function_privilege('service_role', 'public.qorpera_purge_event_deliveries(integer)', 'EXECUTE')
		or not has_function_privilege('authenticated', 'public.qorpera_create_event_hook(uuid,uuid,text,text,text,integer,integer)', 'EXECUTE')
		or not has_function_privilege('authenticated', 'public.qorpera_list_event_hooks(uuid,uuid)', 'EXECUTE') then
		raise exception 'An event intake function lost its caller';
	end if;
end
$$;

-- Only owners and admins create hooks, and only address-proven ones in this step.
select pg_temp.hook_claims('authenticated', '73000000-0000-4000-8000-000000000003');
set local role authenticated;
select pg_temp.hook_error($q$select public.qorpera_create_event_hook('73000000-0000-4000-8000-000000000010',
	'73000000-0000-4000-8000-000000000020', 'forms', 'Website form')$q$, '42501');
reset role;
select pg_temp.hook_claims('authenticated', '73000000-0000-4000-8000-000000000004');
set local role authenticated;
select pg_temp.hook_error($q$select public.qorpera_create_event_hook('73000000-0000-4000-8000-000000000010',
	'73000000-0000-4000-8000-000000000020', 'forms', 'Website form')$q$, '42501');
reset role;
select pg_temp.hook_claims('authenticated', '73000000-0000-4000-8000-000000000005');
set local role authenticated;
select pg_temp.hook_error($q$select public.qorpera_create_event_hook('73000000-0000-4000-8000-000000000010',
	'73000000-0000-4000-8000-000000000020', 'forms', 'Website form')$q$, '42501');
-- An owner of another company cannot use this company's environment.
select pg_temp.hook_error($q$select public.qorpera_create_event_hook('73000000-0000-4000-8000-000000000011',
	'73000000-0000-4000-8000-000000000020', 'forms', 'Website form')$q$, '22023');
reset role;

select pg_temp.hook_claims('authenticated', '73000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.hook_error($q$select public.qorpera_create_event_hook('73000000-0000-4000-8000-000000000010',
	'73000000-0000-4000-8000-000000000020', 'Forms', 'Website form')$q$, '22023');
select pg_temp.hook_error($q$select public.qorpera_create_event_hook('73000000-0000-4000-8000-000000000010',
	'73000000-0000-4000-8000-000000000020', 'forms', '   ')$q$, '22023');
select pg_temp.hook_error($q$select public.qorpera_create_event_hook('73000000-0000-4000-8000-000000000010',
	'73000000-0000-4000-8000-000000000020', 'stripe', 'Payments', 'stripe')$q$, '0A000');
select pg_temp.hook_error($q$select public.qorpera_create_event_hook('73000000-0000-4000-8000-000000000010',
	'73000000-0000-4000-8000-000000000020', 'forms', 'Website form', 'address', 512)$q$, '22023');
select pg_temp.hook_error($q$select public.qorpera_create_event_hook('73000000-0000-4000-8000-000000000010',
	'73000000-0000-4000-8000-000000000020', 'forms', 'Website form', 'address', null, 601)$q$, '22023');
select set_config('qorpera_test.forms', public.qorpera_create_event_hook('73000000-0000-4000-8000-000000000010',
	'73000000-0000-4000-8000-000000000020', 'forms', ' Website contact form ', 'address', 2048, 3)::text, true);
select pg_temp.hook_error($q$select public.qorpera_create_event_hook('73000000-0000-4000-8000-000000000010',
	'73000000-0000-4000-8000-000000000020', 'forms', 'Again')$q$, '23505');
reset role;

select pg_temp.hook_assert(
	(current_setting('qorpera_test.forms')::jsonb ->> 'address') ~ '^[A-Za-z0-9_-]{43}$'
	and current_setting('qorpera_test.forms')::jsonb ->> 'path'
		= '/functions/v1/event-intake/' || (current_setting('qorpera_test.forms')::jsonb ->> 'address')
	and current_setting('qorpera_test.forms')::jsonb ->> 'purpose' = 'Website contact form'
	and current_setting('qorpera_test.forms')::jsonb ->> 'proof' = 'address'
	and current_setting('qorpera_test.forms')::jsonb ->> 'status' = 'active'
	and (current_setting('qorpera_test.forms')::jsonb ->> 'maxBodyBytes')::integer = 2048
	and (current_setting('qorpera_test.forms')::jsonb ->> 'perMinute')::integer = 3,
	'The created hook descriptor differs');
select set_config('qorpera_test.address', current_setting('qorpera_test.forms')::jsonb ->> 'address', true);
select set_config('qorpera_test.hook', current_setting('qorpera_test.forms')::jsonb ->> 'id', true);

-- Every member lists hooks; only owners and admins see addresses.
select pg_temp.hook_claims('authenticated', '73000000-0000-4000-8000-000000000003');
set local role authenticated;
select pg_temp.hook_assert(
	jsonb_array_length(public.qorpera_list_event_hooks('73000000-0000-4000-8000-000000000010', '73000000-0000-4000-8000-000000000020')) = 1
	and not (public.qorpera_list_event_hooks('73000000-0000-4000-8000-000000000010', '73000000-0000-4000-8000-000000000020') -> 0 ? 'address')
	and not (public.qorpera_list_event_hooks('73000000-0000-4000-8000-000000000010', '73000000-0000-4000-8000-000000000020') -> 0 ? 'path'),
	'A contributor saw a hook address');
select pg_temp.hook_error(format('select public.qorpera_list_event_deliveries(%L)', current_setting('qorpera_test.hook')), '42501');
select pg_temp.hook_error(format('select public.qorpera_set_event_hook_status(%L, %L)', current_setting('qorpera_test.hook'), 'paused'), '42501');
reset role;
select pg_temp.hook_claims('authenticated', '73000000-0000-4000-8000-000000000005');
set local role authenticated;
select pg_temp.hook_error($q$select public.qorpera_list_event_hooks('73000000-0000-4000-8000-000000000010',
	'73000000-0000-4000-8000-000000000020')$q$, '42501');
reset role;
select pg_temp.hook_claims('authenticated', '73000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.hook_assert(
	public.qorpera_list_event_hooks('73000000-0000-4000-8000-000000000010', '73000000-0000-4000-8000-000000000020') -> 0 ->> 'address'
		= current_setting('qorpera_test.address'),
	'An admin did not see the hook address');
reset role;

-- The intake door belongs to service_role.
select pg_temp.hook_claims('authenticated', '73000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.hook_error(format($q$select public.qorpera_receive_event(%L, null, '{}', '')$q$,
	current_setting('qorpera_test.address')), '42501');
reset role;

select pg_temp.hook_claims('service_role');
set local role service_role;
-- Malformed input from the function raises; unknown addresses are an outcome.
select pg_temp.hook_error(format($q$select public.qorpera_receive_event(%L, null, '{"authorization":"Bearer x"}', '')$q$,
	current_setting('qorpera_test.address')), '22023');
select pg_temp.hook_error(format($q$select public.qorpera_receive_event(%L, null, '{"Content-Type":"text/plain"}', '')$q$,
	current_setting('qorpera_test.address')), '22023');
select pg_temp.hook_error(format($q$select public.qorpera_receive_event(%L, null, '{}', '***')$q$,
	current_setting('qorpera_test.address')), '22023');
select pg_temp.hook_assert(pg_temp.receive('not-an-address', '{}') ->> 'outcome' = 'unknown', 'A malformed address was not unknown');
select pg_temp.hook_assert(pg_temp.receive(repeat('A', 43), '{}') ->> 'outcome' = 'unknown', 'A missing hook was not unknown');

-- An address-proven delivery is verified at once and keyed by the sender's id.
select set_config('qorpera_test.first', pg_temp.receive(current_setting('qorpera_test.address'),
	'{"name":"Ada","message":"Hello"}',
	'{"x-qorpera-delivery":"form-1","x-qorpera-event":"contact.submitted","user-agent":"forms/1"}')::text, true);
select pg_temp.hook_assert(current_setting('qorpera_test.first')::jsonb ->> 'outcome' = 'accepted', 'The first delivery was not accepted');
-- The same sender id again is a duplicate, whatever its body.
select pg_temp.hook_assert(pg_temp.receive(current_setting('qorpera_test.address'), '{"name":"Ada","message":"Hello again"}',
	'{"x-qorpera-delivery":"form-1"}') ->> 'outcome' = 'duplicate', 'A repeated sender id was not a duplicate');
-- Without a sender id, the body's hash is the key.
select pg_temp.hook_assert(pg_temp.receive(current_setting('qorpera_test.address'), 'plain body') ->> 'outcome' = 'accepted',
	'A delivery without a sender id was not accepted');
reset role;

select pg_temp.hook_assert((
	select delivery.status = 'verified' and delivery.delivery_key = 'form-1' and delivery.event_type = 'contact.submitted'
		and delivery.content_type = 'application/json'
		and delivery.headers = '{"x-qorpera-delivery":"form-1","x-qorpera-event":"contact.submitted","user-agent":"forms/1"}'::jsonb
		and convert_from(delivery.body, 'UTF8') = '{"name":"Ada","message":"Hello"}'
		and delivery.body_bytes = octet_length('{"name":"Ada","message":"Hello"}')
		and delivery.body_sha256 = encode(extensions.digest('{"name":"Ada","message":"Hello"}', 'sha256'), 'hex')
		and delivery.verified_at is not null
	from public.qorpera_event_deliveries as delivery
	where delivery.id = (current_setting('qorpera_test.first')::jsonb ->> 'deliveryId')::uuid),
	'The verified delivery row differs');
select pg_temp.hook_assert((
	select count(*) = 1 from public.qorpera_event_deliveries
	where hook_id = current_setting('qorpera_test.hook')::uuid and status = 'duplicate' and body is null
		and delivery_key = 'form-1'),
	'The duplicate was not recorded without its body');
select pg_temp.hook_assert((
	select delivery_key = 'sha256:' || encode(extensions.digest('plain body', 'sha256'), 'hex') and event_type is null
	from public.qorpera_event_deliveries
	where hook_id = current_setting('qorpera_test.hook')::uuid and status = 'verified' and delivery_key like 'sha256:%'),
	'A delivery without a sender id was not keyed by its body');

-- Limits: the hook takes 3 a minute and bodies of at most 2 KiB.
select pg_temp.hook_claims('service_role');
set local role service_role;
select pg_temp.hook_assert(pg_temp.receive(current_setting('qorpera_test.address'), repeat('x', 2049)) ->> 'outcome' = 'too_large',
	'An oversized body was accepted');
select pg_temp.hook_assert(pg_temp.receive(current_setting('qorpera_test.address'), 'fourth') ->> 'outcome' = 'limited',
	'The per-minute limit did not hold');
reset role;
update public.qorpera_event_deliveries set received_at = received_at - interval '2 minutes'
where hook_id = current_setting('qorpera_test.hook')::uuid;
select pg_temp.hook_claims('service_role');
set local role service_role;
select pg_temp.hook_assert(pg_temp.receive(current_setting('qorpera_test.address'), 'after a minute') ->> 'outcome' = 'accepted',
	'The limit did not roll over');
reset role;
select pg_temp.hook_assert((
	select received_count = 4 and refused_count = 2 and last_received_at is not null
	from public.qorpera_event_hooks where id = current_setting('qorpera_test.hook')::uuid),
	'The hook counters differ');

-- Paused hooks refuse; resumed ones take deliveries again; removed ones are unknown and free the name.
select pg_temp.hook_claims('authenticated', '73000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.hook_assert(public.qorpera_set_event_hook_status(current_setting('qorpera_test.hook')::uuid, 'paused') ->> 'status' = 'paused',
	'The hook did not pause');
select pg_temp.hook_error(format('select public.qorpera_set_event_hook_status(%L, %L)', current_setting('qorpera_test.hook'), 'gone'), '22023');
reset role;
select pg_temp.hook_claims('service_role');
set local role service_role;
select pg_temp.hook_assert(pg_temp.receive(current_setting('qorpera_test.address'), 'while paused') ->> 'outcome' = 'paused',
	'A paused hook took a delivery');
reset role;
select pg_temp.hook_claims('authenticated', '73000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.hook_assert(public.qorpera_set_event_hook_status(current_setting('qorpera_test.hook')::uuid, 'active') ->> 'status' = 'active',
	'The hook did not resume');
select pg_temp.hook_assert(jsonb_array_length(public.qorpera_list_event_deliveries(current_setting('qorpera_test.hook')::uuid)) = 4
	and not (public.qorpera_list_event_deliveries(current_setting('qorpera_test.hook')::uuid) -> 0 ? 'body'),
	'The delivery list differs');
select pg_temp.hook_assert(public.qorpera_set_event_hook_status(current_setting('qorpera_test.hook')::uuid, 'removed') ->> 'status' = 'removed',
	'The hook was not removed');
select pg_temp.hook_error(format('select public.qorpera_set_event_hook_status(%L, %L)', current_setting('qorpera_test.hook'), 'active'), '55000');
select set_config('qorpera_test.forms2', public.qorpera_create_event_hook('73000000-0000-4000-8000-000000000010',
	'73000000-0000-4000-8000-000000000020', 'forms', 'Website contact form, again')::text, true);
reset role;
select pg_temp.hook_claims('service_role');
set local role service_role;
select pg_temp.hook_assert(pg_temp.receive(current_setting('qorpera_test.address'), 'after removal') ->> 'outcome' = 'unknown',
	'A removed hook took a delivery');
select pg_temp.hook_assert(pg_temp.receive(current_setting('qorpera_test.forms2')::jsonb ->> 'address', 'new hook') ->> 'outcome' = 'accepted',
	'The new hook with a freed name did not take a delivery');
reset role;

-- A company being deleted stops receiving at once, and its members lose the functions.
insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
values ('73000000-0000-4000-8000-000000000010', '73000000-0000-4000-8000-000000000001');
select pg_temp.hook_claims('service_role');
set local role service_role;
select pg_temp.hook_assert(pg_temp.receive(current_setting('qorpera_test.forms2')::jsonb ->> 'address', 'while deleting') ->> 'outcome' = 'unknown',
	'A company being deleted took a delivery');
reset role;
select pg_temp.hook_claims('authenticated', '73000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.hook_error($q$select public.qorpera_list_event_hooks('73000000-0000-4000-8000-000000000010',
	'73000000-0000-4000-8000-000000000020')$q$, '42501');
reset role;
delete from public.qorpera_company_deletions where profile_id = '73000000-0000-4000-8000-000000000010';

-- A company has at most 50 live hooks.
select pg_temp.hook_claims('authenticated', '73000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.hook_assert(count(*) = 49, 'The numbered hooks were not created')
from (
	select public.qorpera_create_event_hook('73000000-0000-4000-8000-000000000010', '73000000-0000-4000-8000-000000000020',
		'hook-' || number, 'Numbered hook')
	from generate_series(1, 49) as number
) as created;
select pg_temp.hook_error($q$select public.qorpera_create_event_hook('73000000-0000-4000-8000-000000000010',
	'73000000-0000-4000-8000-000000000020', 'one-too-many', 'Over the limit')$q$, '54000');
reset role;

-- Retention: waiting deliveries are refused after 24 hours, bodies cleared after 7 days, rows gone after 30.
insert into public.qorpera_event_deliveries(hook_id, profile_id, received_at, status, body, body_bytes, body_sha256)
values ((current_setting('qorpera_test.forms2')::jsonb ->> 'id')::uuid, '73000000-0000-4000-8000-000000000010',
	clock_timestamp() - interval '25 hours', 'received', '\x01'::bytea, 1, repeat('0', 64));
update public.qorpera_event_deliveries set received_at = clock_timestamp() - interval '8 days'
where hook_id = (current_setting('qorpera_test.forms2')::jsonb ->> 'id')::uuid and status = 'verified';
update public.qorpera_event_deliveries set received_at = clock_timestamp() - interval '31 days'
where hook_id = current_setting('qorpera_test.hook')::uuid;
select pg_temp.hook_claims('service_role');
set local role service_role;
select pg_temp.hook_assert(public.qorpera_purge_event_deliveries() = '{"expired":1,"cleared":1,"deleted":4}'::jsonb,
	'The purge counts differ');
reset role;
select pg_temp.hook_assert((
	select status = 'refused' and reason = 'Not verified in time' and body is not null
	from public.qorpera_event_deliveries
	where hook_id = (current_setting('qorpera_test.forms2')::jsonb ->> 'id')::uuid and body_bytes = 1),
	'A waiting delivery was not refused in time');
select pg_temp.hook_assert((
	select body is null and body_sha256 is not null
	from public.qorpera_event_deliveries
	where hook_id = (current_setting('qorpera_test.forms2')::jsonb ->> 'id')::uuid and status = 'verified'),
	'An old body was not cleared');
select pg_temp.hook_assert(not exists (
	select 1 from public.qorpera_event_deliveries where hook_id = current_setting('qorpera_test.hook')::uuid),
	'Old deliveries were not deleted');

-- The company purge removes hooks and deliveries with the company: every reference cascades.
select pg_temp.hook_assert((
	select count(*) = 4 and bool_and(constraint_row.confdeltype = 'c')
	from pg_catalog.pg_constraint as constraint_row
	where constraint_row.contype = 'f'
		and constraint_row.conrelid in ('public.qorpera_event_hooks'::regclass, 'public.qorpera_event_deliveries'::regclass)
		and constraint_row.confrelid in ('public.qorpera_profiles'::regclass, 'public.qorpera_company_environments'::regclass,
			'public.qorpera_event_hooks'::regclass)),
	'A hook or delivery reference does not cascade with its company');

rollback;
