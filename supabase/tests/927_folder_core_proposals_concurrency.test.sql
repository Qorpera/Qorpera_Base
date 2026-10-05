-- @fixture 770_folder_core_review_recorder_concurrency.test.sql until "-- A. A begin in flight on the approval"
-- Company folder core, P40a under concurrency (deploy/first-node/RUNTIME-COMPANY-FOLDER-C2.md §8 "Locks"): a proposal
-- row is rank 7c. Two applies of one proposal take turns there and the second applies nothing; a member's discard and an
-- apply take turns in both orders; an erasure and an apply take turns in both orders; a proposal parked under a root
-- while an erasure waited for the root makes the erasure retry; and a parking commit passes the authority check, so a
-- narrowing that commits while it decides leaves no proposal. Run f1 of 648's committed fixture (Ada, for the member)
-- applies; its run box parks. Waits are detected with pg_blocking_pids. The fixture is removed at the end, as 770's.

select set_config('qorpera_test.actor', jsonb_build_object('kind','run','runId','64800000-0000-4000-8000-0000000000f1',
	'jobId','64800000-0000-4000-8000-0000000000f2','runnerId','64800000-0000-4000-8000-0000000000f4',
	'assignmentId','64800000-0000-4000-8000-0000000000f5')::text, false) \g /dev/null
select set_config('qorpera_test.box', public.qorpera_folder_view_open('64800000-0000-4000-8000-000000000020',
	current_setting('qorpera_test.actor')::jsonb, 'run_box', '{}')::text, false) \g /dev/null

create function pg_temp.vactor() returns jsonb language sql as $$
	select jsonb_build_object('kind','view','viewId',current_setting('qorpera_test.box')::jsonb ->> 'viewId',
		'pass',current_setting('qorpera_test.box')::jsonb ->> 'pass')
$$;
create function pg_temp.owner() returns jsonb language sql as $$
	select '{"kind":"member","userId":"64800000-0000-4000-8000-000000000001"}'::jsonb
$$;
create function pg_temp.del(p_path text) returns jsonb language sql as $$
	select jsonb_build_object('op','delete','path',p_path,'expectedVersion',pg_temp.version(p_path))
$$;
create function pg_temp.sql_park(p_key text, p_path text) returns text language sql as $$
	select format('select public.qorpera_folder_commit(%L, %L, %L, %L)::text', '64800000-0000-4000-8000-000000000020',
		pg_temp.vactor()::text, p_key, jsonb_build_array(pg_temp.del(p_path))::text)
$$;
-- Parks the delete of a path through the run box, committed; returns the proposal.
create function pg_temp.park(p_key text, p_path text) returns uuid language plpgsql as $$
declare r jsonb := public.qorpera_folder_commit('64800000-0000-4000-8000-000000000020', pg_temp.vactor(), p_key,
	jsonb_build_array(pg_temp.del(p_path)));
begin
	if r -> 'units' -> 0 ->> 'reason' is distinct from 'parked' then raise exception 'Fixture park: %', r; end if;
	return (select id from public.qorpera_folder_proposals where commit_id = (r ->> 'commitId')::uuid);
end $$;
-- Run f1's approval of a proposal: the reviewer's allow of apply_proposal, recorded for the proposal. Returns the review.
create function pg_temp.approval(p_call text, p_proposal uuid) returns uuid language plpgsql as $$
declare v_action uuid;
begin
	v_action := (public.qorpera_record_action_review(current_setting('qorpera_test.binding')::jsonb, jsonb_build_object('callId', p_call,
		'tool', 'apply_proposal', 'effect', 'destructive', 'argumentSha256', public.qorpera_folder_proposal_call_sha256(p_proposal),
		'action', jsonb_build_object('title', 'Apply the changes', 'arguments', '{"proposalId":"' || p_proposal || '"}'),
		'decision', 'allow', 'ruleIds', '[]'::jsonb, 'builtIn', 'none', 'reason', 'Fixture verdict.', 'proposedRule', null,
		'reviewerModel', 'gpt-6-luna')) ->> 'reviewId')::uuid;
	return (public.qorpera_folder_record_review(current_setting('qorpera_test.binding')::jsonb, jsonb_build_object('actionReviewId', v_action,
		'tool', 'apply_proposal', 'argumentSha256', public.qorpera_folder_proposal_call_sha256(p_proposal), 'proposalId', p_proposal))
		->> 'reviewId')::uuid;
end $$;
create function pg_temp.sql_apply(p_key text, p_proposal uuid, p_review uuid) returns text language sql as $$
	select format('select public.qorpera_folder_apply_proposal(%L, %L, %L, %L, %L)::text', '64800000-0000-4000-8000-000000000020',
		current_setting('qorpera_test.actor'), p_key, p_proposal, p_review)
$$;
create function pg_temp.sql_discard(p_proposal uuid) returns text language sql as $$
	select format('select public.qorpera_folder_member_discard_proposal(%L, %L, %L)::text', '64800000-0000-4000-8000-000000000020',
		pg_temp.owner()::text, p_proposal)
$$;
create function pg_temp.sql_erase(p_path text, p_key text) returns text language sql as $$
	select format('select public.qorpera_folder_erase(%L, %L, %L, %L)::text', '64800000-0000-4000-8000-000000000020',
		pg_temp.owner()::text, jsonb_build_array(p_path)::text, p_key)
$$;
create function pg_temp.status(p_proposal uuid) returns text language sql as $$
	select status from public.qorpera_folder_proposals where id = p_proposal
$$;
-- The outcome of the commit with this operation key (its first unit).
create function pg_temp.unit_of(p_key text) returns text language sql as $$
	select c.units -> 0 ->> 'outcome' || ':' || coalesce(c.units -> 0 ->> 'reason', '') from public.qorpera_folder_commits c
	where c.environment_id = '64800000-0000-4000-8000-000000000020' and c.operation_key = p_key
$$;
create function pg_temp.present(p_path text) returns boolean language sql as $$
	select exists (select 1 from public.qorpera_folder_entries where environment_id = '64800000-0000-4000-8000-000000000020'
		and key_text = p_path and kind <> 'claim')
$$;

-- The files, committed: each to be parked and decided once; c and c2 have an earlier life (written, deleted, written
-- again), so an erasure of them has history to erase while their proposals stay in the current life.
select pg_temp.commit(pg_temp.owner(), 'p40-race-files-1', (select jsonb_agg(jsonb_build_object('op','write','path',p,
	'file',pg_temp.stage('p40 race ' || p))) from unnest(array['p40-a.txt','p40-b.txt','p40-b2.txt','p40-c.txt','p40-c2.txt',
	'p40-e.txt']) p) || '[{"op":"mkdir","path":"p40-d"},{"op":"mkdir","path":"p40-narrow"}]'::jsonb) \g /dev/null
select pg_temp.commit(pg_temp.owner(), 'p40-race-files-2', jsonb_build_array(pg_temp.del('p40-c.txt'), pg_temp.del('p40-c2.txt'),
	jsonb_build_object('op','write','path','p40-d/x.txt','file',pg_temp.stage('p40 race d')))) \g /dev/null
select pg_temp.commit(pg_temp.owner(), 'p40-race-files-3', (select jsonb_agg(jsonb_build_object('op','write','path',p,
	'file',pg_temp.stage('p40 race again ' || p))) from unnest(array['p40-c.txt','p40-c2.txt']) p)) \g /dev/null
do $$
begin
	perform set_config('qorpera_test.pa', pg_temp.park('p40-park-a', 'p40-a.txt')::text, false);
	perform set_config('qorpera_test.pb', pg_temp.park('p40-park-b', 'p40-b.txt')::text, false);
	perform set_config('qorpera_test.pb2', pg_temp.park('p40-park-b2', 'p40-b2.txt')::text, false);
	perform set_config('qorpera_test.pc', pg_temp.park('p40-park-c', 'p40-c.txt')::text, false);
	perform set_config('qorpera_test.pc2', pg_temp.park('p40-park-c2', 'p40-c2.txt')::text, false);
end $$;
do $$
begin
	perform set_config('qorpera_test.ra', pg_temp.approval('p40-apply-a', current_setting('qorpera_test.pa')::uuid)::text, false);
	perform set_config('qorpera_test.rb', pg_temp.approval('p40-apply-b', current_setting('qorpera_test.pb')::uuid)::text, false);
	perform set_config('qorpera_test.rb2', pg_temp.approval('p40-apply-b2', current_setting('qorpera_test.pb2')::uuid)::text, false);
	perform set_config('qorpera_test.rc', pg_temp.approval('p40-apply-c', current_setting('qorpera_test.pc')::uuid)::text, false);
	perform set_config('qorpera_test.rc2', pg_temp.approval('p40-apply-c2', current_setting('qorpera_test.pc2')::uuid)::text, false);
end $$;

-- A. Two applies of one proposal: the second waits at the proposal row, then finds it applied and applies nothing.
do $$
declare v_state text; pa uuid := current_setting('qorpera_test.pa')::uuid; ra uuid := current_setting('qorpera_test.ra')::uuid;
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', pg_temp.sql_apply('p40-race-a-1', pa, ra)) as t(r text);
	perform dblink_send_query('fence_two', pg_temp.sql_apply('p40-race-a-2', pa, ra));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'A: the second apply must wait for the first'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_folder_proposals'::regclass then
		raise exception 'A: the second apply must wait at the proposal, not on %', pg_temp.queued_on('fence_two'); end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' or pg_temp.status(pa) <> 'applied' or pg_temp.present('p40-a.txt')
		or pg_temp.unit_of('p40-race-a-1') <> 'saved:' or pg_temp.unit_of('p40-race-a-2') <> 'denied:review_required'
		or (select apply_commit_id from public.qorpera_folder_proposals where id = pa) is distinct from
			(select id from public.qorpera_folder_commits where operation_key = 'p40-race-a-1') then
		raise exception 'A: % % % %', v_state, pg_temp.status(pa), pg_temp.unit_of('p40-race-a-1'), pg_temp.unit_of('p40-race-a-2'); end if;
end $$;

-- B. A member's discard in flight: the apply waits at the proposal, then finds it discarded and applies nothing. Then the
-- other order: an apply in flight, and the discard waits and answers the proposal as applied.
do $$
declare v_state text; pb uuid := current_setting('qorpera_test.pb')::uuid; pb2 uuid := current_setting('qorpera_test.pb2')::uuid;
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', pg_temp.sql_discard(pb)) as t(r text);
	perform dblink_send_query('fence_two', pg_temp.sql_apply('p40-race-b-1', pb, current_setting('qorpera_test.rb')::uuid));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'B: the apply must wait for the discard'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_folder_proposals'::regclass then
		raise exception 'B: the apply must wait at the proposal, not on %', pg_temp.queued_on('fence_two'); end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' or pg_temp.status(pb) <> 'discarded' or not pg_temp.present('p40-b.txt')
		or pg_temp.unit_of('p40-race-b-1') <> 'denied:review_required' then
		raise exception 'B: % % %', v_state, pg_temp.status(pb), pg_temp.unit_of('p40-race-b-1'); end if;
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', pg_temp.sql_apply('p40-race-b2-1', pb2, current_setting('qorpera_test.rb2')::uuid)) as t(r text);
	perform dblink_send_query('fence_two', pg_temp.sql_discard(pb2));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'B: the discard must wait for the apply'; end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' or pg_temp.status(pb2) <> 'applied' or pg_temp.present('p40-b2.txt') then
		raise exception 'B: the discard after the apply: % %', v_state, pg_temp.status(pb2); end if;
end $$;

-- C. An erasure in flight that holds a proposal at 7c (its path is under the root, in the root's current life, so the
-- proposal stays): the apply waits there, then applies. Then the other order: an apply in flight, and the erasure waits at
-- the proposal and then finishes.
do $$
declare v_state text; pc uuid := current_setting('qorpera_test.pc')::uuid; pc2 uuid := current_setting('qorpera_test.pc2')::uuid;
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', pg_temp.sql_erase('p40-c.txt', 'p40-race-erase-c')) as t(r text);
	perform dblink_send_query('fence_two', pg_temp.sql_apply('p40-race-c-1', pc, current_setting('qorpera_test.rc')::uuid));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'C: the apply must wait for the erasure'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_folder_proposals'::regclass then
		raise exception 'C: the apply must wait at the proposal, not on %', pg_temp.queued_on('fence_two'); end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' or pg_temp.status(pc) <> 'applied' or pg_temp.present('p40-c.txt') then
		raise exception 'C: the apply after the erasure: % %', v_state, pg_temp.status(pc); end if;
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', pg_temp.sql_apply('p40-race-c2-1', pc2, current_setting('qorpera_test.rc2')::uuid)) as t(r text);
	perform dblink_send_query('fence_two', pg_temp.sql_erase('p40-c2.txt', 'p40-race-erase-c2'));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'C: the erasure must wait for the apply'; end if;
	if pg_temp.queued_on('fence_two') is distinct from 'public.qorpera_folder_proposals'::regclass then
		raise exception 'C: the erasure must wait at the proposal, not on %', pg_temp.queued_on('fence_two'); end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state <> 'ok' or pg_temp.status(pc2) <> 'applied' then
		raise exception 'C: the erasure after the apply: % %', v_state, pg_temp.status(pc2); end if;
end $$;

-- D. A proposal parked under a root while an erasure of it waited for the root's lock: the erasure's plain read did not
-- lock it at 7c, so it asks for a retry; the retry erases it.
do $$
declare v_state text; p uuid; r text;
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', pg_temp.sql_park('p40-race-park-d', 'p40-d/x.txt')) as t(r text);
	perform dblink_send_query('fence_two', pg_temp.sql_erase('p40-d', 'p40-race-erase-d'));
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'D: the erasure must wait for the root'; end if;
	perform dblink_exec('fence_one', 'commit');
	v_state := pg_temp.outcome('fence_two');
	if v_state not like 'PGRST %Company folder changed while the erasure began%' then
		raise exception 'D: the erasure must ask for a retry, got %', v_state; end if;
	select id into p from public.qorpera_folder_proposals where commit_id = (select id from public.qorpera_folder_commits
		where operation_key = 'p40-race-park-d');
	if pg_temp.status(p) <> 'open' then raise exception 'D: the parked proposal is open'; end if;
end $$;

-- E. A commit that only parks publishes nothing yet keeps derived content, so it passes the authority check: a narrowing
-- that commits while it decides refuses it (folder_authority_changed) and no proposal is left; a retry with the same
-- operation key parks. The commit is held at rank 1 by a connection holding the member row.
do $$
declare v_state text; v_sql text := pg_temp.sql_park('p40-race-park-e', 'p40-e.txt');
begin
	perform dblink_exec('fence_one', 'begin');
	perform * from dblink('fence_one', $q$select 1 from public.qorpera_profile_members
		where user_id = '64800000-0000-4000-8000-000000000002' for update$q$) as t(x integer);
	perform dblink_send_query('fence_two', v_sql);
	if not pg_temp.waits_for('fence_two', 'fence_one') then raise exception 'E: the parking commit did not reach rank 1'; end if;
	perform dblink_send_query('fence_three', format('select public.qorpera_folder_set_resource(%L, %L, %L, %L, %L, %L)::text',
		'64800000-0000-4000-8000-000000000020', pg_temp.owner()::text, 'p40-narrow', 'subtree', 'company_shared', 'normal'));
	if not pg_temp.finishes_unblocked('fence_three', 'fence_two') then raise exception 'E: a narrowing waited for a parking commit'; end if;
	v_state := pg_temp.outcome('fence_three');
	if v_state <> 'ok' then raise exception 'E: the narrowing: %', v_state; end if;
	perform dblink_exec('fence_one', 'rollback');
	v_state := pg_temp.outcome('fence_two');
	if v_state not like 'PGRST %folder_authority_changed%' then
		raise exception 'E: a parking commit must refuse with folder_authority_changed, got %', v_state; end if;
	if exists (select 1 from public.qorpera_folder_proposal_paths q where q.environment_id = '64800000-0000-4000-8000-000000000020'
		and q.path = 'p40-e.txt') then raise exception 'E: the refused commit left a proposal'; end if;
	perform * from dblink('fence_two', v_sql) as t(r text);
	if not exists (select 1 from public.qorpera_folder_proposal_paths q where q.environment_id = '64800000-0000-4000-8000-000000000020'
		and q.path = 'p40-e.txt') then raise exception 'E: the retry parks'; end if;
end $$;

select dblink_disconnect(name) from unnest(array['fence_one','fence_two','fence_three','fence_four']) name;

-- Remove the fixture (as 770 does).
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
	delete from public.qorpera_folder_proposal_paths where environment_id = any (v_envs);
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
	delete from public.qorpera_execution_sponsor_versions where binding_id = '64800000-0000-4000-8000-0000000000b1';
	delete from public.qorpera_shared_sessions where id = any (v_sessions);
	delete from public.qorpera_runner_jobs where id = any (v_jobs);
	delete from public.qorpera_execution_runs where id = any (v_runs);
	delete from public.qorpera_profiles where id = any (v_profiles);
end $$;
set session_replication_role = origin;
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '64800000-0000-4000-8000-000000000010/%';
delete from auth.users where id in ('64800000-0000-4000-8000-000000000001','64800000-0000-4000-8000-000000000002',
	'64800000-0000-4000-8000-000000000003');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id in ('64800000-0000-4000-8000-000000000020',
			'64800000-0000-4000-8000-000000000021'))
		or exists (select 1 from public.qorpera_folder_proposals where environment_id = '64800000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from storage.objects where name like '64800000-0000-4000-8000-000000000010/%')
		or exists (select 1 from public.qorpera_profile_objects where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_upload_intents where profile_id = '64800000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_verified_company_file_objects where profile_id = '64800000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
