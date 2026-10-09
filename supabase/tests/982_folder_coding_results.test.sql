-- @fixture 928_folder_coding_dispatch.test.sql until "-- 1. The refusals"
-- C3d (migration 20260930108000, deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §8 "Plan (C3)"): a coding turn's
-- results.md on folder-v2, which the platform writes as the gateway writes a connection's file (P22b). A turn's report
-- (the executor's completion, or the failure of a lost executor's lease) marks its worker due; the gateway's claim leases
-- the row under a new generation and answers what results.md is rendered from; the platform's commit under the claim's
-- operation key writes it, exactly as the turn reported it, and its index removes the row; a problem backs the row off.
-- A decision waits for the file. The agent's revival waits for it too, for at most a minute and not after a problem, and
-- a batch sibling waits with it. A later turn's report takes the row over under a new generation, so an earlier claim's
-- key writes nothing. 928's helpers on 924's base: Alice's run, four coding sessions under her todo, on executor exec-982.

do $$
declare v_alice jsonb := pg_temp.c3_alice(); v_titles text[] := array['Fix the login page', 'Choose the sign-in provider',
	'Fix the logout page', 'Fix the signup page'];
begin
	perform public.qorpera_configure_coding_executor('92400000-0000-4000-8000-000000000020', 'exec-982', true, array['codex']);
	perform public.qorpera_set_coding_repository_grant('92400000-0000-4000-8000-000000000020',
		'92400000-0000-4000-8000-000000000030', pg_temp.c3_repo(), true);
	for i in 1 .. 4 loop
		perform pg_temp.base_assert(pg_temp.c3_dispatch(v_alice, 'c3d-dispatch-' || i, 'agents/alice/todos/fix-login/session-' || i,
			pg_temp.c3_brief(('98200000-0000-4000-8000-0000000000b' || i)::uuid, p_title => v_titles[i]))
			-> 'units' -> 0 ->> 'outcome' = 'saved', 'dispatch ' || i);
	end loop;
end $$;
-- The owner's coding machine is on exec-982, so the fleet picks it for the owner's sessions (as in 928).
set local session_replication_role = replica;
insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
values ('98200000-0000-4000-8000-0000000000d1', 'member', '92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020', '92400000-0000-4000-8000-000000000001', 'exec-982', repeat('8', 64), '{}');
set local session_replication_role = origin;

-- The executor claims the oldest claimable session, which must be p_worker's, and completes its turn.
create function pg_temp.cr_turn(p_worker uuid, p_outcome text, p_summary text, p_needs text default null,
	p_pull_request jsonb default null, p_options jsonb default null) returns jsonb language plpgsql as $$
declare v_claim jsonb;
begin
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-982', 60);
	perform pg_temp.base_assert(v_claim ->> 'workerId' = p_worker::text, 'the session''s claim: ' || coalesce(v_claim::text, 'none'));
	return public.qorpera_complete_coding_turn(p_worker, (v_claim ->> 'leaseToken')::uuid, p_outcome, p_summary, p_needs,
		p_pull_request, p_options => p_options);
end $$;
-- The gateway's claim and finish, as writer …e1 (or another writer) calls them.
create function pg_temp.cr_claim(p_lease integer default 60) returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_claim_coding_results_file('98200000-0000-4000-8000-0000000000e1', p_lease);
end $$;
create function pg_temp.cr_finish(p_claim jsonb, p_problem text default null,
	p_writer uuid default '98200000-0000-4000-8000-0000000000e1') returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_finish_coding_results_file(p_writer, (p_claim ->> 'codingWorkerId')::uuid,
		(p_claim ->> 'generation')::bigint, p_problem);
end $$;
create function pg_temp.cr_due(p_worker uuid) returns public.qorpera_coding_results_files language sql as $$
	select * from public.qorpera_coding_results_files where worker_id = p_worker
$$;
-- A claim that met a problem ends with it; its row is claimed again at once (its pause skipped), under the next generation.
create function pg_temp.cr_again(p_claim jsonb) returns jsonb language plpgsql as $$
declare v_claim jsonb;
begin
	perform pg_temp.base_assert((pg_temp.cr_finish(p_claim, 'file_invalid') ->> 'finished')::boolean, 'a problem ends the claim');
	update public.qorpera_coding_results_files set not_before = null where worker_id = (p_claim ->> 'codingWorkerId')::uuid;
	v_claim := pg_temp.cr_claim();
	perform pg_temp.base_assert(v_claim ->> 'codingWorkerId' = p_claim ->> 'codingWorkerId'
		and (v_claim ->> 'generation')::bigint = (p_claim ->> 'generation')::bigint + 1, 'claimed again: ' || coalesce(v_claim::text, 'none'));
	return v_claim;
end $$;
-- results.md as the gateway renders it from a claim: the pull request after the summary, the options after what it needs.
create function pg_temp.cr_parse(p_claim jsonb) returns jsonb language sql as $$
	select jsonb_build_object('kind', 'worker-results', 'outcome', p_claim ->> 'outcome', 'reportedAt', p_claim ->> 'reportedAt',
		'decision', null, 'note', null, 'files', '[]'::jsonb,
		'summary', (p_claim ->> 'summary') || coalesce(E'\n\nPull request: ' || (p_claim ->> 'pullRequest'), ''),
		'needs', (p_claim ->> 'needs') || coalesce((select E'\n\nOptions:\n' || string_agg('- ' || (o.value #>> '{}'), E'\n' order by o.n)
			from jsonb_array_elements(case when jsonb_typeof(p_claim -> 'options') = 'array' then p_claim -> 'options'
				else '[]'::jsonb end) with ordinality o(value, n)), ''))
$$;
-- One results.md write without a worker request, by the platform or a member (who takes possession of its bytes); the
-- follow-up queue runs after it. Answers the commit's result, saved or not.
create function pg_temp.cr_write(p_actor jsonb, p_key text, p_path text, p_parse jsonb, p_expected uuid default null)
returns jsonb language plpgsql as $$
declare v_unit jsonb; v_result jsonb;
begin
	perform pg_temp.base_claims('service_role');
	v_unit := pg_temp.base_write(p_path, 'worker-results', p_parse::text, p_parse, p_expected);
	if p_actor ->> 'kind' <> 'platform' then
		perform pg_temp.base_assert(pg_temp.base_seal(p_actor, pg_temp.base_manifest(p_parse::text)) ->> 'state' = 'sealed', 'staged');
	end if;
	v_result := public.qorpera_folder_commit('92400000-0000-4000-8000-000000000020', p_actor, p_key, jsonb_build_array(v_unit));
	perform pg_temp.base_follow_ups();
	return v_result;
end $$;
create function pg_temp.cr_refused(p_result jsonb, p_words text) returns void language plpgsql as $$
begin
	perform pg_temp.base_assert(p_result -> 'units' -> 0 ->> 'outcome' = 'refused'
		and p_result -> 'units' -> 0 ->> 'reason' = 'structured_rule'
		and p_result -> 'units' -> 0 -> 'problems' -> 0 ->> 'message' = p_words, format('refused with "%s": %s', p_words, p_result));
end $$;
-- Alice's decision on a worker's results, as manage_worker sends it.
create function pg_temp.cr_decide(p_key text, p_folder text, p_decision text, p_note text, p_parse jsonb, p_expected uuid)
returns jsonb language plpgsql as $$
begin
	return pg_temp.c3_commit(pg_temp.c3_alice(), p_key, jsonb_build_array(jsonb_build_object('op', 'write', 'path', p_folder || '/results.md',
		'file', pg_temp.c3_stage(pg_temp.c3_alice(), p_parse::text),
		'structured', jsonb_build_array(pg_temp.c3_entry(p_folder || '/results.md', p_parse)))
		|| case when p_expected is not null then jsonb_build_object('expectedVersion', p_expected) else '{}'::jsonb end),
		jsonb_build_object('action', 'decide', 'folder', p_folder, 'decision', p_decision, 'note', p_note), null);
end $$;

-- 1. Session 1's report marks it due; a decision waits; the claim and finish take only the gateway, with valid input ----
do $$
declare v_folder text := 'agents/alice/todos/fix-login/session-1'; w public.qorpera_runtime_workers%rowtype;
	d public.qorpera_coding_results_files%rowtype; v_result jsonb;
begin
	perform pg_temp.cr_turn('98200000-0000-4000-8000-0000000000b1', 'succeeded', 'The login page accepts a pasted code.', null,
		jsonb_build_object('url', 'https://github.com/Qorpera/Qorpera_Base/pull/7', 'number', 7, 'headSha', repeat('a', 40)));
	w := pg_temp.c3_worker('98200000-0000-4000-8000-0000000000b1'); d := pg_temp.cr_due(w.id);
	perform pg_temp.base_assert(w.state = 'succeeded' and w.completion_state = 'waiting' and w.folder_results_version is null,
		'the reported worker: ' || to_jsonb(w)::text);
	perform pg_temp.base_assert(d.sequence = 1 and d.generation = 0 and d.lease_owner is null and d.lease_until is null
		and d.attempts = 0 and d.not_before is null and d.last_problem is null
		and d.profile_id = '92400000-0000-4000-8000-000000000010' and d.environment_id = '92400000-0000-4000-8000-000000000020',
		'the due row: ' || to_jsonb(d)::text);
	perform pg_temp.base_assert(public.qorpera_coding_results_held(w), 'its revival waits for the file');
	-- The agent cannot decide on results that are not written yet.
	v_result := pg_temp.cr_decide('c3d-decide-early', v_folder, 'accepted', null, jsonb_build_object('kind', 'worker-results',
		'outcome', 'succeeded', 'reportedAt', public.qorpera_company_state_instant_text(w.reported_at), 'decision', 'accepted',
		'note', null, 'summary', 'Done.', 'needs', null, 'files', '[]'::jsonb), null);
	perform pg_temp.cr_refused(v_result, 'this coding session''s results are still being written; try again in a moment');
	-- Only the folder core's authority claims and finishes, with a writer, a lease of 30 s to 15 min and a problem's slug.
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_error($q$select public.qorpera_claim_coding_results_file('98200000-0000-4000-8000-0000000000e1', 60)$q$,
		'42501', 'Folder core authority is required');
	perform pg_temp.base_error($q$select public.qorpera_finish_coding_results_file('98200000-0000-4000-8000-0000000000e1',
		'98200000-0000-4000-8000-0000000000b1', 1)$q$, '42501', 'Folder core authority is required');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_error($q$select public.qorpera_claim_coding_results_file('98200000-0000-4000-8000-0000000000e1', 29)$q$,
		'22023', 'Coding results claim is invalid');
	perform pg_temp.base_error($q$select public.qorpera_claim_coding_results_file('98200000-0000-4000-8000-0000000000e1', 901)$q$,
		'22023', 'Coding results claim is invalid');
	perform pg_temp.base_error($q$select public.qorpera_claim_coding_results_file(null, 60)$q$, '22023', 'Coding results claim is invalid');
	perform pg_temp.base_error($q$select public.qorpera_finish_coding_results_file('98200000-0000-4000-8000-0000000000e1',
		'98200000-0000-4000-8000-0000000000b1', 1, 'File invalid')$q$, '22023', 'Coding results finish is invalid');
	perform pg_temp.base_error($q$select public.qorpera_finish_coding_results_file('98200000-0000-4000-8000-0000000000e1',
		'98200000-0000-4000-8000-0000000000b1', null)$q$, '22023', 'Coding results finish is invalid');
	perform pg_temp.base_assert(pg_temp.cr_due(w.id) = d, 'nothing claimed');
end $$;

-- 2. The claims of session 1: only its current generation's key writes, only as the turn reported; then the decision ----
do $$
declare v_folder text := 'agents/alice/todos/fix-login/session-1'; v_path text := 'agents/alice/todos/fix-login/session-1/results.md';
	v_writes text := 'the platform writes a coding session''s results as its turn reported them';
	v_restore text := 'only manage_worker and report_work write a worker''s files';
	w public.qorpera_runtime_workers%rowtype := pg_temp.c3_worker('98200000-0000-4000-8000-0000000000b1');
	d public.qorpera_coding_results_files%rowtype; v_claim jsonb; v_parse jsonb; v_result jsonb; v_base jsonb; v_unit jsonb;
begin
	-- The claim: the row's next generation, leased, and what the file is rendered from.
	v_claim := pg_temp.cr_claim();
	perform pg_temp.base_assert(v_claim ->> 'schema' = 'qorpera.coding-results-claim/v1' and v_claim ->> 'codingWorkerId' = w.id::text
		and v_claim ->> 'environmentId' = '92400000-0000-4000-8000-000000000020' and (v_claim ->> 'sequence')::integer = 1
		and (v_claim ->> 'generation')::bigint = 1 and (v_claim ->> 'attempt')::integer = 1
		and v_claim ->> 'operationKey' = 'coding-results:98200000-0000-4000-8000-0000000000b1:1:1' and v_claim ->> 'path' = v_path
		and v_claim -> 'currentVersion' = 'null'::jsonb and v_claim ->> 'outcome' = 'succeeded'
		and v_claim ->> 'reportedAt' = public.qorpera_company_state_instant_text(w.reported_at)
		and v_claim ->> 'summary' = 'The login page accepts a pasted code.' and v_claim -> 'needs' = 'null'::jsonb
		and v_claim ->> 'pullRequest' = 'https://github.com/Qorpera/Qorpera_Base/pull/7' and v_claim -> 'options' = 'null'::jsonb
		and (v_claim ->> 'leaseUntil')::timestamptz > clock_timestamp(), 'the claim: ' || coalesce(v_claim::text, 'none'));
	d := pg_temp.cr_due(w.id);
	perform pg_temp.base_assert(d.lease_owner = '98200000-0000-4000-8000-0000000000e1' and d.generation = 1 and d.attempts = 1,
		'the leased row: ' || to_jsonb(d)::text);
	perform pg_temp.base_assert(pg_temp.cr_claim() is null, 'a leased row is not claimed again');
	v_parse := pg_temp.cr_parse(v_claim);
	-- An earlier generation's key is no claim's: the platform has no other way to write a live worker's files.
	perform pg_temp.cr_refused(pg_temp.cr_write('{"kind":"platform"}', 'coding-results:98200000-0000-4000-8000-0000000000b1:1:0',
		v_path, v_parse), v_restore);
	-- The claim's key, with what the turn did not report: another outcome; another time; a decision; files.
	perform pg_temp.cr_refused(pg_temp.cr_write('{"kind":"platform"}', v_claim ->> 'operationKey', v_path,
		v_parse || '{"outcome":"failed"}'), v_writes);
	-- A problem ends the claim: the row backs off (2 s after one attempt), and the revival stops waiting for it.
	perform pg_temp.base_assert((pg_temp.cr_finish(v_claim, 'file_invalid') ->> 'finished')::boolean, 'the problem''s finish');
	d := pg_temp.cr_due(w.id);
	perform pg_temp.base_assert(d.lease_owner is null and d.lease_until is null and d.last_problem = 'file_invalid'
		and d.not_before > clock_timestamp() + interval '1 second' and d.not_before <= clock_timestamp() + interval '2 seconds',
		'the row backs off: ' || to_jsonb(d)::text);
	perform pg_temp.base_assert(not public.qorpera_coding_results_held(w), 'a problem releases the revival');
	perform pg_temp.base_assert(pg_temp.cr_claim() is null, 'nothing is claimed during the pause');
	update public.qorpera_coding_results_files set not_before = null where worker_id = w.id;
	v_claim := pg_temp.cr_claim();
	perform pg_temp.base_assert((v_claim ->> 'generation')::bigint = 2 and (v_claim ->> 'attempt')::integer = 2,
		'the second claim: ' || coalesce(v_claim::text, 'none'));
	perform pg_temp.cr_refused(pg_temp.cr_write('{"kind":"platform"}', v_claim ->> 'operationKey', v_path,
		v_parse || jsonb_build_object('reportedAt', public.qorpera_company_state_instant_text(w.reported_at - interval '1 second'))), v_writes);
	v_claim := pg_temp.cr_again(v_claim);
	perform pg_temp.cr_refused(pg_temp.cr_write('{"kind":"platform"}', v_claim ->> 'operationKey', v_path,
		v_parse || '{"decision":"accepted"}'), v_writes);
	v_claim := pg_temp.cr_again(v_claim);
	perform pg_temp.cr_refused(pg_temp.cr_write('{"kind":"platform"}', v_claim ->> 'operationKey', v_path,
		v_parse || '{"files":["agents/alice/todos/fix-login/session-1/brief.md"]}'), v_writes);
	v_claim := pg_temp.cr_again(v_claim);
	-- The key is the platform's: a member under it writes nothing, and keeps the key from the platform's change.
	perform pg_temp.cr_refused(pg_temp.cr_write(pg_temp.base_owner(), v_claim ->> 'operationKey', v_path,
		v_parse || '{"summary":"Written by the owner."}'), v_restore);
	v_unit := pg_temp.base_write(v_path, 'worker-results', v_parse::text, v_parse);
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_error(format('select public.qorpera_folder_commit(%L, %L, %L, %L)', '92400000-0000-4000-8000-000000000020',
		'{"kind":"platform"}', v_claim ->> 'operationKey', jsonb_build_array(v_unit)), '22023',
		'Operation key was used for a different change set');
	v_claim := pg_temp.cr_again(v_claim);
	perform pg_temp.base_assert((v_claim ->> 'generation')::bigint = 6, 'six claims: ' || v_claim::text);
	-- Only the claim's writer at the claim's generation finishes it.
	perform pg_temp.base_assert(not (pg_temp.cr_finish(v_claim, null, '98200000-0000-4000-8000-0000000000e2') ->> 'finished')::boolean
		and not (pg_temp.cr_finish(v_claim || '{"generation":5}') ->> 'finished')::boolean
		and (pg_temp.cr_due(w.id)).lease_owner = '98200000-0000-4000-8000-0000000000e1', 'another claim''s finish changes nothing');
	-- A finish without a problem whose commit did not write the file (it replayed another) pauses the row as well.
	perform pg_temp.base_assert((pg_temp.cr_finish(v_claim) ->> 'finished')::boolean, 'the finish');
	d := pg_temp.cr_due(w.id);
	perform pg_temp.base_assert(d.lease_owner is null and d.not_before > clock_timestamp() + interval '1 minute',
		'paused for 64 s after six attempts: ' || to_jsonb(d)::text);
	perform pg_temp.base_assert(pg_temp.cr_claim() is null, 'nothing during the pause');
	update public.qorpera_coding_results_files set not_before = null where worker_id = w.id;
	v_claim := pg_temp.cr_claim();
	perform pg_temp.base_assert((pg_temp.c3_worker(w.id)).folder_results_version is null and (v_claim ->> 'generation')::bigint = 7,
		'nothing written yet: ' || coalesce(v_claim::text, 'none'));
	-- The write as the turn reported it: the worker points at it and its row is gone, so the finish finds nothing.
	v_result := pg_temp.cr_write('{"kind":"platform"}', v_claim ->> 'operationKey', v_path, v_parse);
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', 'the platform''s write: ' || v_result::text);
	w := pg_temp.c3_worker(w.id);
	perform pg_temp.base_assert(w.folder_results_version = pg_temp.base_version(v_path)
		and w.folder_commit_id = (v_result ->> 'commitId')::uuid and w.state = 'succeeded' and w.completion_state = 'waiting'
		and pg_temp.cr_due(w.id) is null and not public.qorpera_coding_results_held(w), 'the written results: ' || to_jsonb(w)::text);
	perform pg_temp.base_assert((select v.structured -> 'parse' from public.qorpera_folder_path_versions v
		where v.version = w.folder_results_version) = v_parse, 'its parse');
	perform pg_temp.base_assert(not (pg_temp.cr_finish(v_claim) ->> 'finished')::boolean and pg_temp.cr_claim() is null,
		'the written claim finishes nothing');
	-- Now Alice decides: only decision and note change.
	v_base := v_parse || jsonb_build_object('decision', 'accepted', 'note', 'Merged after review.');
	v_result := pg_temp.cr_decide('c3d-decide-1', v_folder, 'accepted', 'Merged after review.', v_base, pg_temp.base_version(v_path));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', 'the decision: ' || v_result::text);
	w := pg_temp.c3_worker(w.id);
	perform pg_temp.base_assert(w.acceptance = 'accepted' and w.acceptance_note = 'Merged after review.'
		and w.accepted_by_run_id = (pg_temp.c3_alice() ->> 'runId')::uuid and w.completion_state = 'suppressed'
		and w.folder_results_version = pg_temp.base_version(v_path), 'the decided worker: ' || to_jsonb(w)::text);
end $$;

-- 3. A blocked turn's results carry what it needs and its options; a plain one's, its summary ---------------------------
do $$
declare v_claim jsonb; v_parse jsonb; v_result jsonb;
begin
	perform pg_temp.cr_turn('98200000-0000-4000-8000-0000000000b2', 'blocked', 'The page needs a sign-in provider.',
		'Which sign-in provider should the page offer?', p_options => '["Google","GitHub"]');
	v_claim := pg_temp.cr_claim();
	perform pg_temp.base_assert(v_claim ->> 'codingWorkerId' = '98200000-0000-4000-8000-0000000000b2' and v_claim ->> 'outcome' = 'blocked'
		and v_claim ->> 'needs' = 'Which sign-in provider should the page offer?' and v_claim -> 'options' = '["Google","GitHub"]'
		and v_claim -> 'pullRequest' = 'null'::jsonb and v_claim ->> 'path' = 'agents/alice/todos/fix-login/session-2/results.md'
		and (v_claim ->> 'generation')::bigint = 1, 'the blocked claim: ' || coalesce(v_claim::text, 'none'));
	v_parse := pg_temp.cr_parse(v_claim);
	perform pg_temp.base_assert(v_parse ->> 'needs' = E'Which sign-in provider should the page offer?\n\nOptions:\n- Google\n- GitHub'
		and v_parse ->> 'summary' = 'The page needs a sign-in provider.', 'the rendered parse: ' || v_parse::text);
	v_result := pg_temp.cr_write('{"kind":"platform"}', v_claim ->> 'operationKey', v_claim ->> 'path', v_parse);
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved'
		and pg_temp.cr_due('98200000-0000-4000-8000-0000000000b2') is null, 'the blocked results: ' || v_result::text);
	perform pg_temp.cr_turn('98200000-0000-4000-8000-0000000000b3', 'succeeded', 'The logout page signs out everywhere.');
	v_claim := pg_temp.cr_claim();
	perform pg_temp.base_assert(v_claim ->> 'codingWorkerId' = '98200000-0000-4000-8000-0000000000b3'
		and v_claim -> 'pullRequest' = 'null'::jsonb and v_claim -> 'options' = 'null'::jsonb, 'the plain claim: ' || coalesce(v_claim::text, 'none'));
	v_parse := pg_temp.cr_parse(v_claim);
	perform pg_temp.base_assert(v_parse ->> 'summary' = 'The logout page signs out everywhere.' and v_parse -> 'needs' = 'null'::jsonb,
		'the plain parse: ' || v_parse::text);
	v_result := pg_temp.cr_write('{"kind":"platform"}', v_claim ->> 'operationKey', v_claim ->> 'path', v_parse);
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved'
		and pg_temp.cr_due('98200000-0000-4000-8000-0000000000b3') is null, 'the plain results: ' || v_result::text);
end $$;

-- 4. A lost executor's failure is due too. The parent's revival waits for it, and its batch sibling with it, for a minute;
--    one carrying the others leaves it out ---------------------------------------------------------------------------
do $$
declare v_claim jsonb; v_drain jsonb; w public.qorpera_runtime_workers%rowtype; d public.qorpera_coding_results_files%rowtype;
	v_wake public.qorpera_wake_occurrences%rowtype;
begin
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-982', 60);
	perform pg_temp.base_assert(v_claim ->> 'workerId' = '98200000-0000-4000-8000-0000000000b4', 'session 4''s claim: ' || coalesce(v_claim::text, 'none'));
	perform set_config('session_replication_role', 'replica', true);
	update public.qorpera_coding_sessions set lease_until = clock_timestamp() - interval '1 second'
	where worker_id = '98200000-0000-4000-8000-0000000000b4';
	perform set_config('session_replication_role', 'origin', true);
	perform pg_temp.base_assert(public.qorpera_claim_coding_session('exec-982', 60) is null, 'the expiry''s call claims nothing');
	w := pg_temp.c3_worker('98200000-0000-4000-8000-0000000000b4'); d := pg_temp.cr_due(w.id);
	perform pg_temp.base_assert(w.state = 'failed' and w.completion_state = 'waiting' and w.result ->> 'reason' = 'executor-lease-expired'
		and (pg_temp.c3_session(w.id)).phase = 'failed', 'the failed worker: ' || to_jsonb(w)::text);
	perform pg_temp.base_assert(d.sequence = 1 and d.generation = 0 and d.lease_owner is null and public.qorpera_coding_results_held(w),
		'its due row: ' || to_jsonb(d)::text);
	-- The parent's own turn ends (its runner's completion is 658's, as in 928).
	perform set_config('session_replication_role', 'replica', true);
	update public.qorpera_runner_jobs set status = 'completed', result = '{}', finished_at = clock_timestamp(),
		lease_token_sha256 = null, lease_expires_at = null where id = (pg_temp.c3_alice() ->> 'jobId')::uuid;
	perform set_config('session_replication_role', 'origin', true);
	-- Session 4 waits for its file; session 3 (a batch sibling, not blocked) waits with it; blocked session 2 does not.
	perform pg_temp.base_assert(not public.qorpera_folder_worker_due(pg_temp.c3_worker('98200000-0000-4000-8000-0000000000b4'))
		and not public.qorpera_folder_worker_due(pg_temp.c3_worker('98200000-0000-4000-8000-0000000000b3'))
		and public.qorpera_folder_worker_due(pg_temp.c3_worker('98200000-0000-4000-8000-0000000000b2')), 'the held batch');
	-- After a minute neither waits.
	update public.qorpera_coding_results_files set created_at = created_at - interval '61 seconds' where worker_id = w.id;
	perform pg_temp.base_assert(not public.qorpera_coding_results_held(w)
		and public.qorpera_folder_worker_due(pg_temp.c3_worker('98200000-0000-4000-8000-0000000000b4'))
		and public.qorpera_folder_worker_due(pg_temp.c3_worker('98200000-0000-4000-8000-0000000000b3')), 'a minute''s hold');
	update public.qorpera_coding_results_files set created_at = clock_timestamp() where worker_id = w.id;
	-- The drain revives the parent once, with sessions 2 and 3; session 4 waits for its own revival.
	v_drain := public.qorpera_folder_workers_company('92400000-0000-4000-8000-000000000020', 32);
	perform pg_temp.base_assert(v_drain ->> 'state' = 'done' and (v_drain ->> 'revivals')::integer = 1, 'the revival: ' || v_drain::text);
	select * into strict v_wake from public.qorpera_wake_occurrences
	where id = (pg_temp.c3_worker('98200000-0000-4000-8000-0000000000b2')).completion_occurrence_id;
	perform pg_temp.base_assert(v_wake.source_kind = 'worker-completion' and v_wake.status = 'queued'
		and v_wake.parent_run_id = (pg_temp.c3_alice() ->> 'runId')::uuid
		and (pg_temp.c3_worker('98200000-0000-4000-8000-0000000000b2')).completion_state = 'delivered'
		and (pg_temp.c3_worker('98200000-0000-4000-8000-0000000000b3')).completion_occurrence_id = v_wake.id
		and (pg_temp.c3_worker('98200000-0000-4000-8000-0000000000b4')).completion_state = 'waiting'
		and (pg_temp.c3_worker('98200000-0000-4000-8000-0000000000b4')).completion_occurrence_id is null, 'the wake: ' || to_jsonb(v_wake)::text);
	perform pg_temp.base_assert((select jsonb_agg(c ->> 'title' order by n) from jsonb_array_elements(v_wake.payload -> 'completions')
			with ordinality x(c, n)) = '["Choose the sign-in provider","Fix the logout page"]'
		and (v_wake.payload ->> 'stillActive')::integer = 1, 'the wake''s payload: ' || v_wake.payload::text);
end $$;

-- 5. Session 4's file: a problem; then the owner's answer and a new turn take the row over, so the earlier claim's key
--    writes nothing and the new claim's does --------------------------------------------------------------------------
do $$
declare v_path text := 'agents/alice/todos/fix-login/session-4/results.md'; v_claim jsonb; v_stale jsonb; v_result jsonb;
	w public.qorpera_runtime_workers%rowtype; d public.qorpera_coding_results_files%rowtype;
begin
	v_claim := pg_temp.cr_claim();
	perform pg_temp.base_assert(v_claim ->> 'codingWorkerId' = '98200000-0000-4000-8000-0000000000b4' and v_claim ->> 'outcome' = 'failed'
		and v_claim ->> 'summary' = 'The coding executor stopped responding; the workspace is kept.'
		and v_claim -> 'needs' = 'null'::jsonb and v_claim -> 'pullRequest' = 'null'::jsonb and v_claim ->> 'path' = v_path,
		'the failure''s claim: ' || coalesce(v_claim::text, 'none'));
	v_stale := pg_temp.cr_again(v_claim);
	-- The owner answers in the session's thread; the executor turns it, and the turn reports.
	perform pg_temp.c3_answer('98200000-0000-4000-8000-0000000000b4', 'Try again on the same branch.');
	w := pg_temp.c3_worker('98200000-0000-4000-8000-0000000000b4');
	perform pg_temp.base_assert(w.state = 'active' and w.sequence = 2 and (pg_temp.c3_session(w.id)).phase = 'input_ready'
		and not public.qorpera_coding_results_held(w), 'the answered session: ' || to_jsonb(w)::text);
	perform pg_temp.base_assert(pg_temp.cr_claim() is null, 'an earlier sequence''s row is not claimed');
	perform pg_temp.cr_turn(w.id, 'succeeded', 'The signup page works again.');
	d := pg_temp.cr_due(w.id);
	perform pg_temp.base_assert(d.sequence = 2 and d.generation = 3 and d.lease_owner is null and d.lease_until is null and d.attempts = 0
		and d.not_before is null and d.last_problem is null and public.qorpera_coding_results_held(pg_temp.c3_worker(w.id)),
		'the row taken over: ' || to_jsonb(d)::text);
	-- The earlier claim writes nothing and finishes nothing.
	perform pg_temp.cr_refused(pg_temp.cr_write('{"kind":"platform"}', v_stale ->> 'operationKey', v_path, pg_temp.cr_parse(v_stale)),
		'only manage_worker and report_work write a worker''s files');
	perform pg_temp.base_assert(not (pg_temp.cr_finish(v_stale) ->> 'finished')::boolean and pg_temp.cr_due(w.id) = d,
		'the earlier claim''s finish');
	v_claim := pg_temp.cr_claim();
	perform pg_temp.base_assert(v_claim ->> 'operationKey' = 'coding-results:98200000-0000-4000-8000-0000000000b4:2:4'
		and (v_claim ->> 'sequence')::integer = 2 and (v_claim ->> 'attempt')::integer = 1 and v_claim ->> 'outcome' = 'succeeded'
		and v_claim ->> 'summary' = 'The signup page works again.' and v_claim -> 'currentVersion' = 'null'::jsonb,
		'the new claim: ' || coalesce(v_claim::text, 'none'));
	v_result := pg_temp.cr_write('{"kind":"platform"}', v_claim ->> 'operationKey', v_path, pg_temp.cr_parse(v_claim));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', 'the new turn''s results: ' || v_result::text);
	w := pg_temp.c3_worker(w.id);
	perform pg_temp.base_assert(w.folder_results_version = pg_temp.base_version(v_path) and pg_temp.cr_due(w.id) is null,
		'session 4''s results: ' || to_jsonb(w)::text);
end $$;

-- 6. The gateway's pair is the service role's alone; the due mark and the hold are the database's own -------------------
do $$
declare v_fn text;
begin
	foreach v_fn in array array['public.qorpera_claim_coding_results_file(uuid,integer)',
		'public.qorpera_finish_coding_results_file(uuid,uuid,bigint,text)'] loop
		perform pg_temp.base_assert(not has_function_privilege('anon', v_fn, 'execute')
			and not has_function_privilege('authenticated', v_fn, 'execute')
			and has_function_privilege('service_role', v_fn, 'execute'), v_fn || ' is the service role''s');
	end loop;
	foreach v_fn in array array['public.qorpera_coding_results_due(uuid,integer)',
		'public.qorpera_coding_results_held(public.qorpera_runtime_workers)'] loop
		perform pg_temp.base_assert(not has_function_privilege('anon', v_fn, 'execute')
			and not has_function_privilege('authenticated', v_fn, 'execute')
			and not has_function_privilege('service_role', v_fn, 'execute'), v_fn || ' is postgres-only');
	end loop;
	perform pg_temp.base_assert(not has_table_privilege('service_role', 'public.qorpera_coding_results_files', 'select')
		and not has_table_privilege('authenticated', 'public.qorpera_coding_results_files', 'select'), 'the table is the database''s');
end $$;

rollback;
