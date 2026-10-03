-- @fixture 648_folder_core_run_fence_concurrency.test.sql until "-- A. Two tool calls of one run"
-- Company folder core, C1c-3d-1 under concurrency (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6.5): a join by
-- someone other than the invitee of a live invitation refuses without the folder fence (#581 N1); a join beside a
-- post waits at the thread room in its prelude, holding no invitation, and lands; an answer to a card and a member
-- change wait for each other at the thread room (#581 N2); a job queued for a member's login after its removal read
-- the jobs refuses the removal retryably, without waiting, while a Disconnect still waits for it; an account deletion
-- beside a post refuses retryably, without waiting; an existing member's join waits at its member row before any
-- thread room; the founding lobby's edit does not wait for a company-row KEY SHARE holder, a seat taken waits at the
-- fence behind a member change and at the thread room beside a post, and removing a founder takes the founder's job
-- before the fence and the founding row (a caller the table refuses never waits there); a company login's status
-- change waits for its job. 648's committed fixture, removed at the end.

-- The company's login pays for unattended work (as 663's).
set session_replication_role = replica;
update public.qorpera_provider_connection_versions set allow_autonomous = true where connection_id = '64800000-0000-4000-8000-0000000000b3';
update public.qorpera_execution_sponsor_versions set allow_autonomous = true where binding_id = '64800000-0000-4000-8000-0000000000b1';
set session_replication_role = origin;
select set_config('qorpera_test.cf_room', id::text, false), set_config('qorpera_test.cf_thread', session_id::text, false)
from public.qorpera_company_rooms where profile_id = '64800000-0000-4000-8000-000000000010'
	and bound_staff_agent_id = '64800000-0000-4000-8000-0000000000c0' \g /dev/null

-- People (committed): 03 invited (and 0a), 04 a stranger with an expired invitation of its own; members 05 (its own
-- login c5, binding b5), 06, 07 (its own login c7, binding b7, and a queued run it pays for), 09, 0b and 0c; 08 and 0d
-- are invited to a founding table later.
insert into auth.users(id, email, email_confirmed_at) values
	('81800000-0000-4000-8000-000000000003', 'n1-invitee@example.test', clock_timestamp()),
	('81800000-0000-4000-8000-000000000004', 'n1-stranger@example.test', clock_timestamp()),
	('81800000-0000-4000-8000-000000000005', 'late-job@example.test', clock_timestamp()),
	('81800000-0000-4000-8000-000000000006', 'deleted-account@example.test', clock_timestamp()),
	('81800000-0000-4000-8000-000000000007', 'lobby-founder@example.test', clock_timestamp()),
	('81800000-0000-4000-8000-000000000008', 'lobby-seat@example.test', clock_timestamp()),
	('81800000-0000-4000-8000-000000000009', 'answer-removed@example.test', clock_timestamp()),
	('81800000-0000-4000-8000-00000000000a', 'post-joiner@example.test', clock_timestamp()),
	('81800000-0000-4000-8000-00000000000b', 'answer-demoted@example.test', clock_timestamp()),
	('81800000-0000-4000-8000-00000000000c', 'lobby-removed@example.test', clock_timestamp()),
	('81800000-0000-4000-8000-00000000000d', 'lobby-seat-post@example.test', clock_timestamp()),
	('81800000-0000-4000-8000-00000000000f', 'member-invited@example.test', clock_timestamp());
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
select '64800000-0000-4000-8000-000000000010', id, email, split_part(email, '@', 1), 'contributor' from auth.users
where id in ('81800000-0000-4000-8000-000000000005', '81800000-0000-4000-8000-000000000006', '81800000-0000-4000-8000-000000000007',
	'81800000-0000-4000-8000-000000000009', '81800000-0000-4000-8000-00000000000b', '81800000-0000-4000-8000-00000000000c',
	'81800000-0000-4000-8000-00000000000f');
insert into public.qorpera_profile_invitations(id, profile_id, email, role, invited_by_user_id, created_at, expires_at) values
	('81800000-0000-4000-8000-0000000000e1', '64800000-0000-4000-8000-000000000010', 'n1-invitee@example.test', 'contributor',
		'64800000-0000-4000-8000-000000000001', clock_timestamp(), clock_timestamp() + interval '1 day'),
	('81800000-0000-4000-8000-0000000000e2', '64800000-0000-4000-8000-000000000010', 'n1-stranger@example.test', 'contributor',
		'64800000-0000-4000-8000-000000000001', clock_timestamp() - interval '2 days', clock_timestamp() - interval '1 day'),
	('81800000-0000-4000-8000-0000000000e3', '64800000-0000-4000-8000-000000000010', 'post-joiner@example.test', 'contributor',
		'64800000-0000-4000-8000-000000000001', clock_timestamp(), clock_timestamp() + interval '1 day'),
	-- 0f is a member already, with a live invitation from before it joined.
	('81800000-0000-4000-8000-0000000000e4', '64800000-0000-4000-8000-000000000010', 'member-invited@example.test', 'contributor',
		'64800000-0000-4000-8000-000000000001', clock_timestamp(), clock_timestamp() + interval '1 day');
set session_replication_role = replica;
insert into public.qorpera_provider_connections(id, profile_id, client_connection_id, owner_user_id, provider, created_by_user_id) values
	('81800000-0000-4000-8000-0000000000c5', '64800000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
		'81800000-0000-4000-8000-000000000005', 'openai', '81800000-0000-4000-8000-000000000005'),
	('81800000-0000-4000-8000-0000000000c7', '64800000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
		'81800000-0000-4000-8000-000000000007', 'openai', '81800000-0000-4000-8000-000000000007');
insert into public.qorpera_execution_sponsor_bindings(id, profile_id, client_binding_id, created_by_user_id) values
	('81800000-0000-4000-8000-0000000000b5', '64800000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
		'81800000-0000-4000-8000-000000000005'),
	('81800000-0000-4000-8000-0000000000b7', '64800000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
		'81800000-0000-4000-8000-000000000007');
insert into public.qorpera_execution_sponsor_versions(binding_id, version, sponsor_kind, provider_connection_id, provider_connection_version,
	created_by_user_id) values
	('81800000-0000-4000-8000-0000000000b5', 1, 'member_connection', '81800000-0000-4000-8000-0000000000c5', 1,
		'81800000-0000-4000-8000-000000000005'),
	('81800000-0000-4000-8000-0000000000b7', 1, 'member_connection', '81800000-0000-4000-8000-0000000000c7', 1,
		'81800000-0000-4000-8000-000000000007');
set session_replication_role = origin;
-- A queued run of Ada paid by a member's own login (binding), as 665's fixture builds one; triggers off while it goes in.
create function pg_temp.queue_run(p_job uuid, p_run uuid, p_binding uuid, p_requester uuid) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability, job_type,
		payload, created_by_user_id, status, run_id)
	values (p_job, '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', extensions.gen_random_uuid(),
		extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}', p_requester, 'queued', p_run);
	insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
		company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type, payload_sha256,
		transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection, audience_kind,
		runtime_bundle_id, runtime_bundle_sha256, input_ids)
	values (p_run, '64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000020', 'wake', extensions.gen_random_uuid(),
		p_job, extensions.gen_random_uuid(), extensions.gen_random_uuid(), '64800000-0000-4000-8000-0000000000a1', 1, p_binding, 1,
		'agent_turn', 'agent_turn', repeat('c', 64), 0, p_requester, p_requester, 'openai', 'gpt-test', 'provider_default', 'company',
		extensions.gen_random_uuid(), repeat('b', 64), '{}');
	set local session_replication_role = origin;
end $$;
select pg_temp.queue_run('81800000-0000-4000-8000-0000000000f7', '81800000-0000-4000-8000-0000000000f8',
	'81800000-0000-4000-8000-0000000000b7', '81800000-0000-4000-8000-000000000007');

-- Claims on a connection: the service role, or a member (with its email, which joins and seats check).
create function pg_temp.claims(p_conn text, p_user uuid default null) returns void language plpgsql as $$
begin
	perform dblink_exec(p_conn, format('set request.jwt.claims = %L', case when p_user is null then '{"role":"service_role"}'
		else jsonb_build_object('role', 'authenticated', 'sub', p_user, 'email', (select email from auth.users where id = p_user))::text end));
end $$;
-- Whether a connection waits at a row of a table: it holds or queues for that row's tuple lock while blocked.
create function pg_temp.waits_at(p_conn text, p_table regclass) returns boolean language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.pid_' || p_conn)::integer; v_until timestamptz := clock_timestamp() + interval '60 seconds';
begin
	loop
		if exists (select 1 from pg_locks where pid = v_pid and locktype = 'tuple' and relation = p_table)
			and cardinality(pg_blocking_pids(v_pid)) > 0 then return true; end if;
		exit when clock_timestamp() > v_until;
		perform pg_sleep(0.02);
	end loop;
	return false;
end $$;
-- Whether a row is free: a NOWAIT lock on fence_four (idle, outside a transaction), released at once.
create function pg_temp.row_free(p_sql text) returns boolean language plpgsql as $$
begin
	perform * from dblink('fence_four', p_sql || ' nowait') as t(x integer);
	return true;
exception when lock_not_available then return false;
end $$;
create function pg_temp.hold(p_conn text, p_sql text) returns void language plpgsql as $$
begin
	perform dblink_exec(p_conn, 'begin');
	perform * from dblink(p_conn, p_sql) as t(x integer);
end $$;
create function pg_temp.hold_clock() returns void language sql as $$
	select pg_temp.hold('fence_three', $q$select 1 from public.qorpera_profile_operation_clocks
		where profile_id = '64800000-0000-4000-8000-000000000010' for update$q$)
$$;
create function pg_temp.member(p_user uuid) returns boolean language sql as $$
	select exists (select 1 from public.qorpera_profile_members where profile_id = '64800000-0000-4000-8000-000000000010' and user_id = p_user)
$$;
create function pg_temp.in_thread(p_user uuid) returns boolean language sql as $$
	select exists (select 1 from public.qorpera_company_room_members where room_id = current_setting('qorpera_test.cf_room')::uuid
		and principal_kind = 'member' and principal_id = p_user and status = 'active')
$$;
create function pg_temp.sql_post(p_text text) returns text language sql as $$
	select format('select public.qorpera_post_company_room_message(%L, %L, %L, %L, 1)::text', current_setting('qorpera_test.cf_room'),
		extensions.gen_random_uuid(), jsonb_build_object('schema', 'qorpera.session-prompt/v1', 'text', p_text),
		'64800000-0000-4000-8000-0000000000b1')
$$;
create function pg_temp.sql_remove(p_user uuid) returns text language sql as $$
	select format('select public.qorpera_remove_profile_member(%L, %L)::text', '64800000-0000-4000-8000-000000000010', p_user)
$$;
create function pg_temp.sql_accept(p_invitation uuid) returns text language sql as $$
	select format('select public.qorpera_accept_profile_invitation(%L)::text', p_invitation)
$$;
-- A card in the Co-Founder's thread, raised for the owner (by hand, committed), and an answer to it.
create function pg_temp.raise_card(p_event uuid) returns void language plpgsql as $$
begin
	insert into public.qorpera_session_events(session_id, sequence, event_id, event_type, actor_user_id, body, event_hash, created_at)
	select current_setting('qorpera_test.cf_thread')::uuid, coalesce(max(sequence), 0) + 1, p_event, 'interaction_request',
		'64800000-0000-4000-8000-000000000001', jsonb_build_object('entry', jsonb_build_object('data',
			'{"schema":"qorpera.interaction/v1","surface":"question","title":"Which channel?","payload":{"options":[{"label":"#general","value":"general"},{"label":"#finance","value":"finance"}]}}'::jsonb)),
		repeat('c', 64), statement_timestamp()
	from public.qorpera_session_events where session_id = current_setting('qorpera_test.cf_thread')::uuid;
end $$;
create function pg_temp.sql_answer(p_event uuid) returns text language sql as $$
	select format('select public.qorpera_answer_interaction(%L, %L, %L, %L, %L, %L, 1)::text', current_setting('qorpera_test.cf_thread'),
		extensions.gen_random_uuid(), p_event, 'answered', jsonb_build_object('values', jsonb_build_array('general')),
		'64800000-0000-4000-8000-0000000000b1')
$$;

-- A. #581 N1. With the folder fence held FOR UPDATE (as stop's second phase holds it), someone who is not the invitee,
-- and the invitee of an expired invitation, are refused at once, without waiting for the fence; the invitee of a live
-- invitation waits there, then joins.
do $$
declare v_state text; v_invitation uuid;
begin
	perform pg_temp.hold('fence_four', $q$select 1 from public.qorpera_folder_fences where profile_id = '64800000-0000-4000-8000-000000000010'
		for update$q$);
	perform pg_temp.claims('fence_two', '81800000-0000-4000-8000-000000000004');
	foreach v_invitation in array array['81800000-0000-4000-8000-0000000000e1', '81800000-0000-4000-8000-0000000000e2']::uuid[] loop
		perform dblink_send_query('fence_two', pg_temp.sql_accept(v_invitation));
		if not pg_temp.finishes_unblocked('fence_two', 'fence_four') then
			raise exception 'A: a join the invitation refuses (%) must not wait for the fence', v_invitation; end if;
		v_state := pg_temp.outcome('fence_two');
		if v_state not like 'P0002 profile invitation was not found%' then raise exception 'A: the refused join: %', v_state; end if;
	end loop;
	perform pg_temp.claims('fence_one', '81800000-0000-4000-8000-000000000003');
	perform dblink_send_query('fence_one', pg_temp.sql_accept('81800000-0000-4000-8000-0000000000e1'));
	if not pg_temp.waits_at('fence_one', 'public.qorpera_folder_fences') then raise exception 'A: the invitee''s join must wait at the fence'; end if;
	perform dblink_exec('fence_four', 'rollback');
	v_state := pg_temp.outcome('fence_one');
	if v_state <> 'ok' or not pg_temp.member('81800000-0000-4000-8000-000000000003') then
		raise exception 'A: the invitee''s join after the fence: %', v_state; end if;
end $$;

-- B. A join beside a post: the post holds the Co-Founder's thread room (FOR SHARE) and its conversation and waits at the
-- clock; the join waits at the thread room in its prelude, holding no invitation, and lands after the post (the
-- trigger's NOWAIT finds the rows held, so it does not refuse).
do $$
declare v_post text; v_join text;
begin
	perform pg_temp.hold_clock();
	perform pg_temp.claims('fence_two', '64800000-0000-4000-8000-000000000001');
	perform dblink_send_query('fence_two', pg_temp.sql_post('Before the join'));
	if not pg_temp.waits_at('fence_two', 'public.qorpera_profile_operation_clocks') then raise exception 'B: the post must wait at the clock'; end if;
	perform pg_temp.claims('fence_one', '81800000-0000-4000-8000-00000000000a');
	perform dblink_send_query('fence_one', pg_temp.sql_accept('81800000-0000-4000-8000-0000000000e3'));
	if not pg_temp.waits_at('fence_one', 'public.qorpera_company_rooms') then raise exception 'B: the join must wait at the thread room'; end if;
	if not pg_temp.row_free($q$select 1 from public.qorpera_profile_invitations where id = '81800000-0000-4000-8000-0000000000e3'
			for update$q$) then
		raise exception 'B: the join must hold no invitation while it waits at the room'; end if;
	perform dblink_exec('fence_three', 'rollback');
	v_post := pg_temp.outcome('fence_two');
	v_join := pg_temp.outcome('fence_one');
	if v_post <> 'ok' or v_join <> 'ok' or not pg_temp.in_thread('81800000-0000-4000-8000-00000000000a') then
		raise exception 'B: the post % and the join %', v_post, v_join; end if;
end $$;

-- C. #581 N2: an answer to a card and a member change meet at the thread room. (i) The answer holds the room (FOR SHARE)
-- and its conversation and waits at the clock; a removal waits at the room before it writes; both land. (ii) A role
-- change in flight holds the rooms; the answer waits at the room, before its conversation, and lands after.
select pg_temp.raise_card('81800000-0000-4000-8000-0000000000d1') \g /dev/null
select pg_temp.raise_card('81800000-0000-4000-8000-0000000000d2') \g /dev/null
do $$
declare v_answer text; v_change text;
begin
	perform pg_temp.claims('fence_one', '64800000-0000-4000-8000-000000000001');
	perform pg_temp.claims('fence_two', '64800000-0000-4000-8000-000000000001');
	perform pg_temp.hold_clock();
	perform dblink_send_query('fence_two', pg_temp.sql_answer('81800000-0000-4000-8000-0000000000d1'));
	if not pg_temp.waits_at('fence_two', 'public.qorpera_profile_operation_clocks') then raise exception 'C: the answer must wait at the clock'; end if;
	perform dblink_send_query('fence_one', pg_temp.sql_remove('81800000-0000-4000-8000-000000000009'));
	if not pg_temp.waits_for('fence_one', 'fence_two') or not pg_temp.waits_at('fence_one', 'public.qorpera_company_rooms') then
		raise exception 'C: the removal must wait at the room for the answer'; end if;
	perform dblink_exec('fence_three', 'rollback');
	v_answer := pg_temp.outcome('fence_two');
	v_change := pg_temp.outcome('fence_one');
	if v_answer <> 'ok' or v_change <> 'ok' or pg_temp.member('81800000-0000-4000-8000-000000000009') then
		raise exception 'C: the answer % and the removal %', v_answer, v_change; end if;
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', format('select public.qorpera_update_profile_member_role(%L, %L, %L)::text',
		'64800000-0000-4000-8000-000000000010', '81800000-0000-4000-8000-00000000000b', 'viewer')) as t(x text);
	perform dblink_send_query('fence_two', pg_temp.sql_answer('81800000-0000-4000-8000-0000000000d2'));
	if not pg_temp.waits_for('fence_two', 'fence_one') or not pg_temp.waits_at('fence_two', 'public.qorpera_company_rooms') then
		raise exception 'C: the answer must wait at the room for the role change'; end if;
	perform dblink_exec('fence_one', 'commit');
	v_answer := pg_temp.outcome('fence_two');
	if v_answer <> 'ok' then raise exception 'C: the answer after the role change: %', v_answer; end if;
end $$;

-- D. A job queued for a member's own login after the member's removal read its jobs (the removal waits at the fence,
-- held FOR UPDATE elsewhere, meanwhile), held by a tool call of that run: the connection cascade's NOWAIT refuses the
-- removal as a retryable conflict, without waiting for the call. A status change of the login while its owner is still
-- a member (a Disconnect) waits for the call as before, then ends the job; the removal's retry lands.
do $$
begin
	perform pg_temp.hold('fence_four', $q$select 1 from public.qorpera_folder_fences where profile_id = '64800000-0000-4000-8000-000000000010'
		for update$q$);
	perform dblink_send_query('fence_one', pg_temp.sql_remove('81800000-0000-4000-8000-000000000005'));
	if not pg_temp.waits_at('fence_one', 'public.qorpera_folder_fences') then raise exception 'D: the removal must wait at the fence'; end if;
end $$;
select pg_temp.queue_run('81800000-0000-4000-8000-0000000000f5', '81800000-0000-4000-8000-0000000000f6',
	'81800000-0000-4000-8000-0000000000b5', '81800000-0000-4000-8000-000000000005');
do $$
declare v_state text;
begin
	perform pg_temp.hold('fence_three', $q$select 1 from public.qorpera_runner_jobs where id = '81800000-0000-4000-8000-0000000000f5'
		for key share$q$);
	perform dblink_exec('fence_four', 'rollback');
	if not pg_temp.finishes_unblocked('fence_one', 'fence_three') then raise exception 'D: the removal must not wait at the late job'; end if;
	v_state := pg_temp.outcome('fence_one');
	if v_state not like 'PGRST %"QRC01"%A run this login pays for is busy; try again%' then raise exception 'D: the removal: %', v_state; end if;
	if not pg_temp.member('81800000-0000-4000-8000-000000000005') then raise exception 'D: the refused removal must change nothing'; end if;
	-- A status change of a member's own login (a Disconnect, a switch-off) still waits for the job, and ends it after.
	perform dblink_send_query('fence_two', $q$update public.qorpera_provider_connections set status = 'disabled'
		where id = '81800000-0000-4000-8000-0000000000c5' returning 'ok'::text$q$);
	if not pg_temp.waits_for('fence_two', 'fence_three') or not pg_temp.waits_at('fence_two', 'public.qorpera_runner_jobs') then
		raise exception 'D: a Disconnect must wait for the job'; end if;
	perform dblink_exec('fence_three', 'rollback');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' or (select status from public.qorpera_runner_jobs where id = '81800000-0000-4000-8000-0000000000f5')
			not in ('failed','cancelled') then
		raise exception 'D: the Disconnect after the job: %', v_state; end if;
	select x into v_state from dblink('fence_one', pg_temp.sql_remove('81800000-0000-4000-8000-000000000005')) as t(x text);
	if v_state <> 'true' or pg_temp.member('81800000-0000-4000-8000-000000000005')
		or (select status from public.qorpera_runner_jobs where id = '81800000-0000-4000-8000-0000000000f5') not in ('failed','cancelled') then
		raise exception 'D: the retried removal % (job %)', v_state,
			(select status from public.qorpera_runner_jobs where id = '81800000-0000-4000-8000-0000000000f5'); end if;
end $$;

-- E. An account deletion beside a post: the deletion runs no prelude, so the thread trigger takes the thread rooms
-- NOWAIT and refuses the deletion as a retryable conflict, without waiting for the post; after the post, it lands.
do $$
declare v_post text; v_delete text;
	c_delete constant text := $q$with gone as (delete from auth.users where id = '81800000-0000-4000-8000-000000000006' returning 1)
		select count(*)::text from gone$q$;
begin
	perform pg_temp.hold_clock();
	perform dblink_send_query('fence_two', pg_temp.sql_post('Beside the account deletion'));
	if not pg_temp.waits_at('fence_two', 'public.qorpera_profile_operation_clocks') then raise exception 'E: the post must wait at the clock'; end if;
	perform dblink_send_query('fence_one', c_delete);
	if not pg_temp.finishes_unblocked('fence_one', 'fence_two') then raise exception 'E: the account deletion must not wait for the post'; end if;
	v_delete := pg_temp.outcome('fence_one');
	if v_delete not like 'PGRST %"QRC01"%An agent thread is busy; try again%' then raise exception 'E: the account deletion: %', v_delete; end if;
	perform dblink_exec('fence_three', 'rollback');
	v_post := pg_temp.outcome('fence_two');
	select x into v_delete from dblink('fence_one', c_delete) as t(x text);
	if v_post <> 'ok' or v_delete <> '1' or pg_temp.member('81800000-0000-4000-8000-000000000006') then
		raise exception 'E: the post % and the retried deletion %', v_post, v_delete; end if;
end $$;


-- E3. An existing member accepts an invitation while its member row is held FOR SHARE, as a thread's model change
-- holds it before that thread's room: the join takes the member row (rank 1) before the thread rooms, so it waits
-- there holding no room (the model change then takes its room and lands), and lands after.
do $$
declare v_state text;
begin
	perform pg_temp.hold('fence_three', $q$select 1 from public.qorpera_profile_members where profile_id = '64800000-0000-4000-8000-000000000010'
		and user_id = '81800000-0000-4000-8000-00000000000f' for share$q$);
	perform pg_temp.claims('fence_two', '81800000-0000-4000-8000-00000000000f');
	perform dblink_send_query('fence_two', pg_temp.sql_accept('81800000-0000-4000-8000-0000000000e4'));
	if not pg_temp.waits_for('fence_two', 'fence_three') or not pg_temp.waits_at('fence_two', 'public.qorpera_profile_members') then
		raise exception 'E3: the existing member''s join must wait at its member row'; end if;
	if not pg_temp.row_free(format('select 1 from public.qorpera_company_rooms where id = %L for key share',
			current_setting('qorpera_test.cf_room'))) then
		raise exception 'E3: the join must hold no thread room while it waits at its member row'; end if;
	perform dblink_exec('fence_three', 'rollback');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' or exists (select 1 from public.qorpera_profile_invitations where id = '81800000-0000-4000-8000-0000000000e4') then
		raise exception 'E3: the existing member''s join: %', v_state; end if;
end $$;

-- F. The founding lobby (the company becomes an open table by hand: 01 opened it, 07 sits at it, 08 and 0d are invited).
update auth.users set email_confirmed_at = clock_timestamp() where id = '64800000-0000-4000-8000-000000000001';
insert into public.qorpera_company_foundings(profile_id, created_by_user_id, vision_draft)
values ('64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000001', '');
insert into public.qorpera_company_founder_seats(profile_id, user_id, invited_by_user_id, state, joined_at) values
	('64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000001', '64800000-0000-4000-8000-000000000001', 'joined', clock_timestamp()),
	('64800000-0000-4000-8000-000000000010', '81800000-0000-4000-8000-000000000007', '64800000-0000-4000-8000-000000000001', 'joined', clock_timestamp()),
	('64800000-0000-4000-8000-000000000010', '81800000-0000-4000-8000-000000000008', '64800000-0000-4000-8000-000000000001', 'invited', null),
	('64800000-0000-4000-8000-000000000010', '81800000-0000-4000-8000-00000000000d', '64800000-0000-4000-8000-000000000001', 'invited', null);
create function pg_temp.sql_seat() returns text language sql as $$
	select format('select public.qorpera_respond_company_founding(%L, true)::text', '64800000-0000-4000-8000-000000000010')
$$;
create function pg_temp.sql_remove_founder(p_user uuid) returns text language sql as $$
	select format('select public.qorpera_remove_company_founder(%L, %L)::text', '64800000-0000-4000-8000-000000000010', p_user)
$$;
do $$
declare v_state text; v_post text;
begin
	perform pg_temp.claims('fence_one', '64800000-0000-4000-8000-000000000001');
	perform pg_temp.claims('fence_two', '64800000-0000-4000-8000-000000000001');
	-- (i) A lobby edit takes the company row FOR NO KEY UPDATE, so it does not wait for a KEY SHARE holder (any effect).
	perform pg_temp.hold('fence_three', $q$select 1 from public.qorpera_profiles where id = '64800000-0000-4000-8000-000000000010'
		for key share$q$);
	perform dblink_send_query('fence_two', format('select public.qorpera_update_company_founding(%L, %s, %L, %L)::text',
		'64800000-0000-4000-8000-000000000010', (select revision from public.qorpera_company_foundings
			where profile_id = '64800000-0000-4000-8000-000000000010'), 'Run fence lobby', 'We race.'));
	if not pg_temp.finishes_unblocked('fence_two', 'fence_three') then raise exception 'F: the lobby edit must not wait for a KEY SHARE holder'; end if;
	v_state := pg_temp.outcome('fence_two');
	perform dblink_exec('fence_three', 'rollback');
	if v_state <> 'ok' then raise exception 'F: the lobby edit: %', v_state; end if;
	-- (ii) A seat taken waits at the fence behind a member change in flight, then lands.
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', pg_temp.sql_remove('81800000-0000-4000-8000-00000000000c')) as t(x text);
	perform pg_temp.claims('fence_two', '81800000-0000-4000-8000-000000000008');
	perform dblink_send_query('fence_two', pg_temp.sql_seat());
	if not pg_temp.waits_for('fence_two', 'fence_one') or not pg_temp.waits_at('fence_two', 'public.qorpera_folder_fences') then
		raise exception 'F: the seat must wait at the fence'; end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' or not pg_temp.member('81800000-0000-4000-8000-000000000008')
		or not pg_temp.in_thread('81800000-0000-4000-8000-000000000008') then
		raise exception 'F: the seat after the member change: %', v_state; end if;
	-- (iii) A seat taken beside a post: it waits at the thread room (as a join does, before its member row) and lands
	-- after the post, not refused.
	perform pg_temp.hold_clock();
	perform dblink_send_query('fence_one', pg_temp.sql_post('Beside the seat'));
	if not pg_temp.waits_at('fence_one', 'public.qorpera_profile_operation_clocks') then raise exception 'F: the post must wait at the clock'; end if;
	perform pg_temp.claims('fence_two', '81800000-0000-4000-8000-00000000000d');
	perform dblink_send_query('fence_two', pg_temp.sql_seat());
	if not pg_temp.waits_at('fence_two', 'public.qorpera_company_rooms') then raise exception 'F: the seat must wait at the thread room'; end if;
	perform dblink_exec('fence_three', 'rollback');
	v_post := pg_temp.outcome('fence_one');
	v_state := pg_temp.outcome('fence_two');
	if v_post <> 'ok' or v_state <> 'ok' or not pg_temp.in_thread('81800000-0000-4000-8000-00000000000d') then
		raise exception 'F: the post % and the seat beside it %', v_post, v_state; end if;
	-- (iv) Removing founder 07 while a tool call of its run holds the job. The prelude's 'jobs' mode takes that job and
	-- no fence. A founder who may not remove 07 is refused at once, without waiting at the job. The opener's removal
	-- waits at the job, holding neither the fence nor the founding row, then lands and ends the run.
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', format('select public.qorpera_folder_member_change_enter(%L, %L, %L)::text',
		'64800000-0000-4000-8000-000000000010', '81800000-0000-4000-8000-000000000007', 'jobs')) as t(x text);
	if pg_temp.row_free($q$select 1 from public.qorpera_runner_jobs where id = '81800000-0000-4000-8000-0000000000f7' for key share$q$)
		or not pg_temp.row_free($q$select 1 from public.qorpera_folder_fences where profile_id = '64800000-0000-4000-8000-000000000010'
			for no key update$q$) then
		raise exception 'F: the jobs mode must take the founder''s job and no fence'; end if;
	perform dblink_exec('fence_one', 'rollback');
	perform pg_temp.hold('fence_three', $q$select 1 from public.qorpera_runner_jobs where id = '81800000-0000-4000-8000-0000000000f7'
		for key share$q$);
	perform pg_temp.claims('fence_two', '81800000-0000-4000-8000-000000000008');
	perform dblink_send_query('fence_two', pg_temp.sql_remove_founder('81800000-0000-4000-8000-000000000007'));
	if not pg_temp.finishes_unblocked('fence_two', 'fence_three') then
		raise exception 'F: a founder''s removal the table refuses must not wait at the job'; end if;
	v_state := pg_temp.outcome('fence_two');
	if v_state not like '42501 You cannot remove this seat%' then raise exception 'F: the refused founder''s removal: %', v_state; end if;
	perform dblink_send_query('fence_one', pg_temp.sql_remove_founder('81800000-0000-4000-8000-000000000007'));
	if not pg_temp.waits_at('fence_one', 'public.qorpera_runner_jobs') then raise exception 'F: the founder''s removal must wait at the job'; end if;
	if not pg_temp.row_free($q$select 1 from public.qorpera_folder_fences where profile_id = '64800000-0000-4000-8000-000000000010'
			for no key update$q$)
		or not pg_temp.row_free($q$select 1 from public.qorpera_company_foundings where profile_id = '64800000-0000-4000-8000-000000000010'
			for update$q$) then
		raise exception 'F: the founder''s removal must hold neither the fence nor the founding row while it waits at the job'; end if;
	perform dblink_exec('fence_three', 'rollback');
	v_state := pg_temp.outcome('fence_one');
	if v_state <> 'ok' or pg_temp.member('81800000-0000-4000-8000-000000000007')
		or (select status from public.qorpera_runner_jobs where id = '81800000-0000-4000-8000-0000000000f7') not in ('failed','cancelled') then
		raise exception 'F: the founder''s removal after the job: % (job %)', v_state,
			(select status from public.qorpera_runner_jobs where id = '81800000-0000-4000-8000-0000000000f7'); end if;
end $$;

-- G. A status change of the company's own login (no owner) waits for a held job of a run it pays for, as before (the
-- cascade's NOWAIT is for a departed owner's login only). Rolled back.
do $$
declare v_state text;
begin
	perform pg_temp.hold('fence_three', $q$select 1 from public.qorpera_runner_jobs where id = '64800000-0000-4000-8000-0000000000f2'
		for key share$q$);
	perform dblink_exec('fence_two', 'begin');
	perform dblink_send_query('fence_two', $q$update public.qorpera_provider_connections set status = 'disabled'
		where id = '64800000-0000-4000-8000-0000000000b3' returning 'ok'::text$q$);
	if not pg_temp.waits_for('fence_two', 'fence_three') or not pg_temp.waits_at('fence_two', 'public.qorpera_runner_jobs') then
		raise exception 'G: a status change of the company''s login must wait for the job'; end if;
	perform dblink_exec('fence_three', 'rollback');
	v_state := pg_temp.outcome('fence_two');
	perform dblink_exec('fence_two', 'rollback');
	if v_state <> 'ok' then raise exception 'G: the company login''s status change: %', v_state; end if;
end $$;

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture (as 648 does).
set session_replication_role = replica;
do $$
declare
	v_profiles uuid[] := array['64800000-0000-4000-8000-000000000010', '64800000-0000-4000-8000-000000000011']::uuid[];
	v_envs uuid[] := array['64800000-0000-4000-8000-000000000020', '64800000-0000-4000-8000-000000000021']::uuid[];
	v_runs uuid[]; v_jobs uuid[]; v_sessions uuid[]; v_rooms uuid[]; v_table record;
begin
	select array_agg(id) into v_runs from public.qorpera_execution_runs where profile_id = any (v_profiles);
	select array_agg(id) into v_jobs from public.qorpera_runner_jobs where profile_id = any (v_profiles);
	select array_agg(id) into v_sessions from public.qorpera_shared_sessions where profile_id = any (v_profiles);
	select array_agg(id) into v_rooms from public.qorpera_company_rooms where profile_id = any (v_profiles);
	delete from public.qorpera_company_path_grants where resource_id in
		(select id from public.qorpera_company_path_resources where environment_id = any (v_envs));
	for v_table in select c.table_name, c.column_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name in ('profile_id','environment_id','run_id','job_id','session_id','room_id')
			and c.data_type = 'uuid' loop
		execute format('delete from public.%I where %I = any ($1)', v_table.table_name, v_table.column_name)
		using case v_table.column_name when 'profile_id' then v_profiles when 'environment_id' then v_envs
			when 'run_id' then v_runs when 'job_id' then v_jobs when 'session_id' then v_sessions else v_rooms end;
	end loop;
	delete from public.qorpera_provider_connection_versions where connection_id = '64800000-0000-4000-8000-0000000000b3';
	delete from public.qorpera_execution_sponsor_versions where binding_id in ('64800000-0000-4000-8000-0000000000b1',
		'81800000-0000-4000-8000-0000000000b5', '81800000-0000-4000-8000-0000000000b7');
	delete from public.qorpera_shared_sessions where id = any (v_sessions);
	delete from public.qorpera_runner_jobs where id = any (v_jobs);
	delete from public.qorpera_execution_runs where id = any (v_runs);
	delete from public.qorpera_profiles where id = any (v_profiles);
end $$;
set session_replication_role = origin;
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '64800000-0000-4000-8000-000000000010/%';
delete from auth.users where id in ('64800000-0000-4000-8000-000000000001','64800000-0000-4000-8000-000000000002',
	'64800000-0000-4000-8000-000000000003') or id::text like '81800000-0000-4000-8000-0000000000%';
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id in ('64800000-0000-4000-8000-000000000020',
			'64800000-0000-4000-8000-000000000021'))
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_profile_members where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from auth.users where id::text like '81800000-%') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
