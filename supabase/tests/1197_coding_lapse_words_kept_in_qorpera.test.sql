-- @fixture 1170_own_code_repositories.test.sql until "-- 4. The completion"
-- A turn whose executor stopped while it handed in a commit, on a repository kept in Qorpera (migration
-- 20260930707000): the agent reads that the commit may or may not have reached main, never of a pull request. 1170's
-- fixture: the company's own repository company/shop, Alice's queued session b1 on it, enrolled with exec-1170.

set local session_replication_role = replica;
insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
values ('91197000-0000-4000-8000-0000000000d1', 'member', '92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020', '92400000-0000-4000-8000-000000000001', 'exec-1170', repeat('7', 64), '{}');
set local session_replication_role = origin;
do $$
declare v_claim jsonb; w public.qorpera_runtime_workers%rowtype; s public.qorpera_coding_sessions%rowtype;
	v_def text := pg_get_functiondef('public.qorpera_claim_coding_session(text,integer)'::regprocedure);
begin
	-- GitHub's words stay for GitHub's repositories.
	perform pg_temp.base_assert(strpos(v_def, '20260930707000') > 0
		and strpos(v_def, ' was being published; the draft pull request may exist. A follow-up publishes or confirms it.') > 0
		and strpos(v_def, ' was submitted but not published; a follow-up can publish it.') > 0
		and strpos(v_def, ' was handed in but had not reached main; a follow-up hands it in again.') > 0, 'the claim''s words');
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-1170', 60);
	perform pg_temp.base_assert(v_claim ->> 'workerId' = '91170000-0000-4000-8000-0000000000b1'
		and v_claim -> 'repository' = pg_temp.own_repo(), 'the claim: ' || coalesce(v_claim::text, 'none'));
	-- The turn finished and was being handed in when its executor stopped.
	perform set_config('session_replication_role', 'replica', true);
	update public.qorpera_coding_session_turns set submission = jsonb_build_object('kind', 'finish', 'headSha', repeat('b', 40),
		'summary', 'The shop has a cart.') where worker_id = '91170000-0000-4000-8000-0000000000b1' and sequence = 1;
	update public.qorpera_coding_sessions set phase = 'publishing', lease_until = clock_timestamp() - interval '1 second'
	where worker_id = '91170000-0000-4000-8000-0000000000b1';
	perform set_config('session_replication_role', 'origin', true);
	perform pg_temp.base_assert(public.qorpera_claim_coding_session('exec-1170', 60) is null, 'the lapse''s call claims nothing');
	w := pg_temp.c3_worker('91170000-0000-4000-8000-0000000000b1'); s := pg_temp.c3_session(w.id);
	perform pg_temp.base_assert(w.state = 'failed' and s.phase = 'failed' and w.result ->> 'reason' = 'executor-lease-expired'
		and w.result ->> 'summary' = 'The coding executor stopped responding; the workspace is kept. Commit bbbbbbbbbbbb was '
			|| 'being handed in and may or may not have reached main. A follow-up hands it in again or confirms it.',
		'the lapsed hand-in: ' || coalesce(w.result::text, 'none'));
end $$;
