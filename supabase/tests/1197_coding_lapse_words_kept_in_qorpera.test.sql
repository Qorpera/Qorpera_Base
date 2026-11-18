-- @fixture 1170_own_code_repositories.test.sql until "-- 4. The completion"
-- A turn whose executor stopped while it handed in a commit, on a repository kept in Qorpera (migration
-- 20260930707000): the agent reads that the commit may or may not have reached main, never of a pull request. 1170's
-- fixture: the company's own repository company/shop, Alice's queued session b1 on it, enrolled with exec-1170.

set local session_replication_role = replica;
insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
values ('91197000-0000-4000-8000-0000000000d1', 'member', '92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020', '92400000-0000-4000-8000-000000000001', 'exec-1170', repeat('7', 64), '{}');
set local session_replication_role = origin;
create function pg_temp.lapse_github(p_publishing boolean) returns jsonb language plpgsql as $f$
declare v_pass jsonb; v_turn jsonb; v_token uuid;
begin
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_claim_coding_session('exec-1170', 60);
	v_token := (pg_temp.c3_session('91170000-0000-4000-8000-0000000000b1')).lease_token;
	perform public.qorpera_begin_coding_turn('91170000-0000-4000-8000-0000000000b1', v_token, '{}');
	v_pass := pg_temp.base_materialize();
	v_turn := pg_temp.base_start((v_pass -> 'run_ids' ->> 0)::uuid);
	update public.qorpera_coding_sessions set vm_allocation_id = '91197000-0000-4000-8000-0000000000d2'
	where worker_id = '91170000-0000-4000-8000-0000000000b1';
	perform public.qorpera_authorize_coding_turn(v_turn);
	perform public.qorpera_submit_coding_turn(v_turn, jsonb_build_object('kind', 'finish', 'operationKey', 'lapse-finish-1',
		'summary', 'The shop has a cart.', 'headSha', repeat('b', 40)));
	perform pg_temp.base_claims('service_role');
	if p_publishing then
		perform public.qorpera_record_coding_progress('91170000-0000-4000-8000-0000000000b1', v_token, 'publishing', 'Publishing');
	end if;
	perform set_config('session_replication_role', 'replica', true);
	update public.qorpera_coding_sessions set lease_until = clock_timestamp() - interval '1 second', repository = pg_temp.c3_repo()
	where worker_id = '91170000-0000-4000-8000-0000000000b1';
	perform set_config('session_replication_role', 'origin', true);
	perform public.qorpera_claim_coding_session('exec-1170', 60);
	return (pg_temp.c3_worker('91170000-0000-4000-8000-0000000000b1')).result;
end $f$;
savepoint lapse_github;
select pg_temp.base_assert(pg_temp.lapse_github(true) ->> 'summary' = 'The coding executor stopped responding; the workspace is '
	|| 'kept. Commit bbbbbbbbbbbb was being published; the draft pull request may exist. A follow-up publishes or confirms it.',
	'a GitHub repository''s lapse while publishing');
rollback to savepoint lapse_github;
select pg_temp.base_assert(pg_temp.lapse_github(false) ->> 'summary' = 'The coding executor stopped responding; the workspace is '
	|| 'kept. Commit bbbbbbbbbbbb was submitted but not published; a follow-up can publish it.',
	'a GitHub repository''s lapse before publishing');
rollback to savepoint lapse_github;
do $$
declare v_claim jsonb; v_begin jsonb; v_pass jsonb; v_turn jsonb; v_token uuid;
	w public.qorpera_runtime_workers%rowtype; s public.qorpera_coding_sessions%rowtype;
begin
	-- The turn as 928 runs one: claimed, begun, its run started, its machine ready, its finish submitted.
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-1170', 60);
	perform pg_temp.base_assert(v_claim ->> 'workerId' = '91170000-0000-4000-8000-0000000000b1'
		and v_claim -> 'repository' = pg_temp.own_repo(), 'the claim: ' || coalesce(v_claim::text, 'none'));
	v_token := (pg_temp.c3_session('91170000-0000-4000-8000-0000000000b1')).lease_token;
	v_begin := public.qorpera_begin_coding_turn('91170000-0000-4000-8000-0000000000b1', v_token, '{}');
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and jsonb_array_length(v_pass -> 'run_ids') = 1, 'the turn''s run: ' || v_pass::text);
	v_turn := pg_temp.base_start((v_pass -> 'run_ids' ->> 0)::uuid);
	update public.qorpera_coding_sessions set vm_allocation_id = '91197000-0000-4000-8000-0000000000d2'
	where worker_id = '91170000-0000-4000-8000-0000000000b1';
	perform public.qorpera_authorize_coding_turn(v_turn);
	perform public.qorpera_submit_coding_turn(v_turn, jsonb_build_object('kind', 'finish', 'operationKey', 'lapse-finish-1',
		'summary', 'The shop has a cart.', 'headSha', repeat('b', 40)));
	-- The executor was handing the commit in when it stopped.
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_record_coding_progress('91170000-0000-4000-8000-0000000000b1', v_token, 'publishing', 'Landing the change');
	perform set_config('session_replication_role', 'replica', true);
	update public.qorpera_coding_sessions set lease_until = clock_timestamp() - interval '1 second'
	where worker_id = '91170000-0000-4000-8000-0000000000b1';
	perform set_config('session_replication_role', 'origin', true);
	perform pg_temp.base_assert(public.qorpera_claim_coding_session('exec-1170', 60) is null, 'the lapse''s call claims nothing');
	w := pg_temp.c3_worker('91170000-0000-4000-8000-0000000000b1'); s := pg_temp.c3_session(w.id);
	perform pg_temp.base_assert(w.state = 'failed' and s.phase = 'failed' and w.result ->> 'reason' = 'executor-lease-expired'
		and w.result ->> 'summary' = 'The coding executor stopped responding; the workspace is kept. Commit bbbbbbbbbbbb was '
			|| 'being handed in and may or may not have reached main. A follow-up hands it in again or confirms it.',
		'the lapsed hand-in: ' || coalesce(w.result::text, 'none'));
end $$;
