-- 20260930721000: a repository's checks before a change goes into main (own code storage, step 3; 11 Nov 2026).
--
-- A repository kept in Qorpera now says what its checks are, in .qorpera/checks.json, and the coding executor runs them
-- on what would go into main before it moves main there. A change whose checks fail goes nowhere: the session's turn
-- fails with what failed. This migration is the kernel's side of that. It is inert until an executor that knows it is
-- rolled: an executor of before sends v1 reports (rows with no checks, read as unknown) and no failure code of the
-- checks.
--
-- 1. qorpera_code_repositories gets checks_enabled, an operator's switch per repository (on by default). Off, the
--    executor lands changes as before this step and their rows say `off`. It is switched by the database owner alone:
--      update public.qorpera_code_repositories set checks_enabled = false
--      where environment_id = '…' and owner = '…' and name = '…';
-- 2. qorpera_code_changes gets checks_state and checks: what the checks said of the files the row put in main.
--    passed (with the checks that passed, on main_after), none (no checks file), off (switched off), inherited (an undo
--    or a restore whose main has exactly the files of a row whose checks passed or that inherited them: checks names
--    it), not_run (an undo or a restore with no such row). Null: a row of before this step, a filler, a refusal.
--    A release later reads one rule from them: commit X is ready when the newest row whose main_after is X is passed or
--    inherited.
-- 3. qorpera_code_checks_switch(worker, lease token): the executor that holds the turn's lease asks whether the checks
--    run for the session's repository. Read-only.
-- 4. Seven existing functions change, each by anchors on its definition as it is (an anchor that is not found exactly
--    once fails the migration), and each changed body carries the marker 20260930721000:
--    * qorpera_code_change_report_valid and qorpera_record_code_change take qorpera.code-change-report/v2, a v1 report
--      with `checks`: null for every state but landed, and for a landing {"state":"none"}, {"state":"off"} or
--      {"state":"passed","result":…}. The appended row, or the filler a turn takes over, gets the state and the result
--      (a turn only takes a filler that ends at its own commit, so the row ends with the files that were checked).
--      A v1 report is recorded as before, with neither.
--    * qorpera_code_change_files: each change also says checksState and checks, for its record file.
--    * qorpera_code_request_finish: an undo's row is not_run, or inherited when it takes main back with every later
--      change (andLater) to a commit a row put main at whose checks passed or that inherited them, and the row ends
--      where the undo's own commit is (a filler it took over that also covers later movements is not_run).
--    * qorpera_code_restore_record: a restore's row is inherited when the restored main is where the newest row of its
--      history put main and that row passed or inherited; else not_run.
--    * qorpera_complete_coding_turn: the platform's line on a landing ends with what the checks said (passed with their
--      names, no checks file, or switched off), when the turn's row says it.
--    * qorpera_coding_turn_failure: the executor's four codes of the checks (CODING_CHECKS_FAILED, _REFUSED,
--      _DID_NOT_RUN, _MAIN_MOVED) keep the executor's words, which say what failed and that the work is kept, and keep
--      the code as the reason. A failed or refused check file also counts the session's failures in a row, and from the
--      third the words say to narrow the change or drop it.
--
-- Who may call: the switch the service role only, as the coding executor under the turn's lease. Locks: the switch
-- takes the coding session's row (the lease check) and reads the registry row; nothing else takes a lock it did not.

set local lock_timeout = '3s';

-- 1. The switch and what the checks said ---------------------------------------------------------------------------------

alter table public.qorpera_code_repositories
	-- An operator's switch (step 3). Off: landings go in as before step 3 and their rows say 'off'.
	add column checks_enabled boolean not null default true;

alter table public.qorpera_code_changes
	-- passed: a gated landing whose every check passed on main_after. none: no checks file. off: checks switched off.
	-- inherited: an undo or restore whose main has exactly the files of row (checks ->> 'as'), whose checks passed.
	-- not_run: an undo or a restore that has no such row. Null: before step 3, or a movement nobody saw (found).
	add column checks_state text check (checks_state is null
		or checks_state in ('passed','none','off','inherited','not_run')),
	add column checks jsonb check (checks is null
		or (jsonb_typeof(checks) = 'object' and pg_column_size(checks) <= 8192)),
	-- passed and inherited carry their checks; every other state, and null, carries none.
	add check (coalesce(checks_state in ('passed','inherited'), false) = (checks is not null));

-- 2. What a report says of the checks ------------------------------------------------------------------------------------

-- Whether p_result is what passed, as a passed landing's row keeps it (its `checks`), for a landing that moved main to
-- p_commit by p_how:
-- {"schema":"qorpera.code-checks/v1","commit":<p_commit>,"how":<p_how>,"file":"<the checks file's blob, 40 hex>",
--  "ms":<int>,"copyMs":<int>,"checks":[{"name":"install","run":"npm ci","ms":38012},…],
--  "changed":null|{"added":[…],"removed":[…],"run":[…]},"tries":1|2}
-- Exactly those keys; 1 to 20 checks, each exactly its three keys, a name a check may have (unique in the list) and a
-- command of 1 to 200 bytes; each list of changed at most 20 such names; all of it at most 8 KiB.
create function public.qorpera_code_checks_passed_valid(p_result jsonb, p_commit text, p_how text)
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(case when jsonb_typeof(p_result) = 'object' then pg_column_size(p_result) <= 8192
		and p_result - array['schema','commit','how','file','ms','copyMs','checks','changed','tries'] = '{}'::jsonb
		and p_result -> 'schema' = '"qorpera.code-checks/v1"'::jsonb
		and p_result ->> 'commit' = p_commit and p_result ->> 'how' = p_how
		and public.qorpera_code_json_text(p_result -> 'file', '^[0-9a-f]{40}$')
		and public.qorpera_code_json_count(p_result -> 'ms') and public.qorpera_code_json_count(p_result -> 'copyMs')
		and jsonb_typeof(p_result -> 'tries') = 'number' and p_result ->> 'tries' in ('1','2')
		and case when jsonb_typeof(p_result -> 'checks') = 'array' then jsonb_array_length(p_result -> 'checks') between 1 and 20
				and not exists (select 1 from jsonb_array_elements(p_result -> 'checks') item
					where case when jsonb_typeof(item) = 'object' then item - array['name','run','ms'] <> '{}'::jsonb
						or not public.qorpera_code_json_text(item -> 'name', '^[a-z0-9][a-z0-9._-]{0,39}$')
						or not public.qorpera_code_json_text(item -> 'run', '.') or octet_length(item ->> 'run') > 200
						or not public.qorpera_code_json_count(item -> 'ms')
						else true end)
				and (select count(distinct item ->> 'name') = count(*) from jsonb_array_elements(p_result -> 'checks') item)
			else false end
		and case jsonb_typeof(p_result -> 'changed') when 'null' then true
			when 'object' then (p_result -> 'changed') - array['added','removed','run'] = '{}'::jsonb
				and not exists (select 1 from unnest(array['added','removed','run']) list(key)
					where case when public.qorpera_code_json_strings(p_result -> 'changed' -> list.key, 20)
						then exists (select 1 from jsonb_array_elements_text(p_result -> 'changed' -> list.key) named(name)
							where named.name !~ '^[a-z0-9][a-z0-9._-]{0,39}$')
						else true end)
			else false end
		else false end, false)
$$;

-- Whether a report of schema v2 says what the checks did as its state asks: JSON null for every state but landed; for a
-- landing exactly {"state":"none"}, {"state":"off"}, or {"state":"passed","result":<what passed on mainAfter>}.
create function public.qorpera_code_change_checks_valid(p_change jsonb)
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(case when p_change -> 'state' = '"landed"'::jsonb then case p_change -> 'checks' -> 'state'
				when '"none"'::jsonb then p_change -> 'checks' = '{"state":"none"}'::jsonb
				when '"off"'::jsonb then p_change -> 'checks' = '{"state":"off"}'::jsonb
				when '"passed"'::jsonb then (p_change -> 'checks') - array['state','result'] = '{}'::jsonb
					and public.qorpera_code_checks_passed_valid(p_change -> 'checks' -> 'result', p_change ->> 'mainAfter',
						p_change ->> 'how')
				else false end
		else p_change -> 'checks' = 'null'::jsonb end, false)
$$;

-- 3. The switch --------------------------------------------------------------------------------------------------------

-- Whether Qorpera runs the checks of the session's repository, for the executor that holds the turn's lease: the
-- registry row's switch, on when the repository has no row. Only for a repository kept in Qorpera. Read-only.
create function public.qorpera_code_checks_switch(p_worker_id uuid, p_lease_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_session public.qorpera_coding_sessions%rowtype;
begin
	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);
	if v_session.repository ->> 'host' is distinct from 'qorpera' then
		raise exception 'Code repository is not kept in Qorpera' using errcode = '22023'; end if;
	return jsonb_build_object('schema', 'qorpera.code-checks-switch/v1', 'enabled', coalesce((select repository.checks_enabled
		from public.qorpera_code_repositories repository
		where repository.environment_id = v_session.environment_id and repository.owner = v_session.repository ->> 'owner'
			and repository.name = v_session.repository ->> 'name'), true));
end $$;

-- 4. Seven existing functions ---------------------------------------------------------------------------------------------

-- Applies each (old, new) pair in turn, each old text exactly once, then runs the result.
create or replace function pg_temp.code_checks_patch(p_target regprocedure, p_edits text[]) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_found integer;
begin
	if position('20260930721000' in v_definition) > 0 then
		raise exception '20260930721000 is already in %', p_target; end if;
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception '20260930721000 anchor found % time(s) in %, expected 1: %', v_found, p_target, left(p_edits[2 * i - 1], 80);
		end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

-- A report may say what the checks did: v2.
select pg_temp.code_checks_patch('public.qorpera_code_change_report_valid(jsonb)'::regprocedure, array[
	$old$		and p_change - array['schema','state','inLine','how','headSha','mainBefore','mainAfter','filesChanged','paths',
			'pathsMore','picture','refusal'] = '{}'::jsonb
		and p_change -> 'schema' = '"qorpera.code-change-report/v1"'::jsonb$old$,
	$new$		-- 20260930721000: v2 is v1 with what the repository's checks did (checks), as its state asks.
		and p_change - array['schema','state','inLine','how','headSha','mainBefore','mainAfter','filesChanged','paths',
			'pathsMore','picture','refusal','checks'] = '{}'::jsonb
		and case p_change -> 'schema' when '"qorpera.code-change-report/v1"'::jsonb then not (p_change ? 'checks')
			when '"qorpera.code-change-report/v2"'::jsonb then public.qorpera_code_change_checks_valid(p_change)
			else false end$new$]);

-- The row a report appends, or the filler a turn takes over, keeps what the checks did.
select pg_temp.code_checks_patch('public.qorpera_record_code_change(uuid,uuid,jsonb)'::regprocedure, array[
	$old$		'picture', v_picture, 'picture_problem', v_problem);$old$,
	$new$		'picture', v_picture, 'picture_problem', v_problem,
		-- 20260930721000: what the repository's checks did, from a v2 report of a landing (none from v1, or another state).
		'checks_state', p_change -> 'checks' ->> 'state', 'checks', p_change -> 'checks' -> 'result');$new$,
	$old$			how = coalesce(p_change ->> 'how', change.how), picture = v_picture, picture_problem = v_problem,$old$,
	$new$			how = coalesce(p_change ->> 'how', change.how), picture = v_picture, picture_problem = v_problem,
			-- 20260930721000: and what the repository's checks did, as the report says (none from v1). The filler ends at
			-- the turn's own commit (it is taken by that), so these are the checks of the files the row ends with.
			checks_state = p_change -> 'checks' ->> 'state', checks = p_change -> 'checks' -> 'result',$new$]);

-- A record file says what the checks said.
select pg_temp.code_checks_patch('public.qorpera_code_change_files(text,text,uuid,text,text,integer)'::regprocedure, array[
	$old$				'restoredFrom', due.restored_from) order by due.n), '[]'::jsonb) into v_changes$old$,
	$new$				'restoredFrom', due.restored_from,
				-- 20260930721000: what the repository's checks said of the files the row put in main.
				'checksState', due.checks_state, 'checks', due.checks) order by due.n), '[]'::jsonb) into v_changes$new$]);

-- An undo is not checked: its row is not_run, or inherited when it takes main back with every later change to a commit
-- a row put main at whose checks passed. (After the rows are taken out: the undo's own row is written by then.)
select pg_temp.code_checks_patch('public.qorpera_code_request_finish(text,text,uuid,uuid,jsonb)'::regprocedure, array[
	$old$			update public.qorpera_code_changes change set undoes = v_undoes$old$,
	$new$			update public.qorpera_code_changes change set undoes = v_undoes,
				-- 20260930721000: no machine is there to run the checks of an undo. With andLater main has exactly the files of
				-- the commit the job went back to (what the claim gave it: the target's own beginning, else where its span
				-- began): the newest row that put main there and passed its checks, or inherited them, vouches for them.
				-- Only for a row that ends at the undo's own commit: a filler the undo took over late, which also covers
				-- what moved main after it, ends with files nobody checked.
				(checks_state, checks) = (select case when kept.n is null then 'not_run' else 'inherited' end,
						case when kept.n is not null then jsonb_build_object('schema', 'qorpera.code-checks/v1', 'as', kept.n) end
					from (select max(back.n) as n from public.qorpera_code_changes back
						where v_later and change.main_after = p_outcome ->> 'mainAfter'
							and back.environment_id = v_repository.environment_id and back.owner = v_repository.owner
							and back.name = v_repository.name and back.checks_state in ('passed','inherited')
							and back.main_after = v_request.progress -> 'begun' ->> 'mainBefore') kept)$new$]);

-- A restore is not checked: its row inherits from the newest row of its history when main is where that row put it.
select pg_temp.code_checks_patch('public.qorpera_code_restore_record(text,text,uuid,uuid,jsonb)'::regprocedure, array[
	$old$				'summary', v_request.input ->> 'note', 'owner_user_id', v_request.by_user_id));$old$,
	$new$				'summary', v_request.input ->> 'note', 'owner_user_id', v_request.by_user_id)
				-- 20260930721000: the restored main's files are those of the history's newest row (keptThrough, from the
				-- rows as qorpera_code_changes_restored left them) when that row put main exactly there: its checks passed,
				-- or it inherited them, and the restore inherits them. Else nothing checked them.
				|| coalesce((select jsonb_build_object('checks_state', 'inherited', 'checks',
						jsonb_build_object('schema', 'qorpera.code-checks/v1', 'as', kept.n))
					from public.qorpera_code_changes kept
					where kept.environment_id = v_repository.environment_id and kept.owner = v_repository.owner
						and kept.name = v_repository.name and kept.n = (v_recorded ->> 'keptThrough')::integer
						and kept.checks_state in ('passed','inherited')),
					'{"checks_state":"not_run"}'::jsonb));$new$]);

-- The platform's line on a landing says what the checks said, when the turn's row says it.
select pg_temp.code_checks_patch(
	'public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)'::regprocedure, array[
	$old$				where change.worker_id = v_worker.id and change.sequence = v_worker.sequence and change.state = 'landed'), '');$old$,
	$new$				where change.worker_id = v_worker.id and change.sequence = v_worker.sequence and change.state = 'landed'), '')
			-- 20260930721000: what the repository's checks said of the change: their names when they passed, or why none ran.
			|| coalesce((select case change.checks_state
					when 'passed' then ' Its checks passed: ' || (select string_agg(listed.item ->> 'name', ', ' order by listed.place)
						from jsonb_array_elements(change.checks -> 'checks') with ordinality listed(item, place)) || '.'
					when 'none' then ' The repository has no checks file (.qorpera/checks.json), so nothing checked this '
						|| 'change: have the next change add one.'
					when 'off' then ' Checks are switched off for this repository, so nothing checked this change.' end
				from public.qorpera_code_changes change
				where change.worker_id = v_worker.id and change.sequence = v_worker.sequence and change.state = 'landed'), '');$new$]);

-- The checks' failures keep the executor's words and their code, and count the session's rounds.
select pg_temp.code_checks_patch('public.qorpera_coding_turn_failure(public.qorpera_runtime_workers,text)'::regprocedure, array[
	$old$	v_run public.qorpera_execution_runs%rowtype; v_report text := p_summary; v_outage boolean;$old$,
	$new$	v_run public.qorpera_execution_runs%rowtype; v_report text := p_summary; v_outage boolean;
	-- 20260930721000: the session's failed checks in a row, and the sentence that counts them.
	v_rounds integer; v_round text;$new$,
	$old$	elsif v_job.id is not null and v_code ~ '^[A-Z0-9_]{1,42}(:[A-Z0-9_]{1,42})?$'$old$,
	$new$	-- 20260930721000: the repository's checks stopped the change (the executor's CODING_CHECKS_ codes, read at the very
	-- end of its words: the end of a check's output in them may hold any text). The executor's words are the report: they
	-- say what failed and that the work is kept, so the line on kept files is not added. The code stays the reason. A
	-- failed check or a refused checks file counts the session's rounds: this turn, and its turns before it, newest
	-- first, that ended so, passing over turns whose checks could not run or met a moving main, and stopping at any
	-- other. From the second the words count them; from the third they say to stop trying the same.
	elsif substring(p_summary from '\[code=(CODING_CHECKS_[A-Z_]{1,40})\]\s*$') in ('CODING_CHECKS_FAILED',
		'CODING_CHECKS_REFUSED', 'CODING_CHECKS_DID_NOT_RUN', 'CODING_CHECKS_MAIN_MOVED') then
		v_code := substring(p_summary from '\[code=(CODING_CHECKS_[A-Z_]{1,40})\]\s*$');
		v_report := coalesce(nullif(regexp_replace(p_summary, '\s*\[code=CODING_CHECKS_[A-Z_]{1,40}\]\s*$', ''), ''), p_summary);
		if v_code in ('CODING_CHECKS_FAILED', 'CODING_CHECKS_REFUSED') then
			select 1 + count(*) into v_rounds from public.qorpera_coding_session_turns as turn
			where turn.worker_id = p_worker.id and turn.sequence < p_worker.sequence
				and turn.outcome ->> 'reason' in ('CODING_CHECKS_FAILED', 'CODING_CHECKS_REFUSED')
				and turn.sequence > coalesce((select max(other.sequence) from public.qorpera_coding_session_turns as other
					where other.worker_id = p_worker.id and other.sequence < p_worker.sequence
						and coalesce(other.outcome ->> 'reason', '') not in ('CODING_CHECKS_FAILED', 'CODING_CHECKS_REFUSED',
							'CODING_CHECKS_DID_NOT_RUN', 'CODING_CHECKS_MAIN_MOVED')), 0);
			v_round := case when v_rounds = 2 then ' The checks failed for this session 2 times in a row.'
				when v_rounds >= 3 then ' The checks failed for this session ' || v_rounds || ' times in a row: instead of '
					|| 'another follow-up that tries again, narrow the change or drop it.' end;
			-- Only within the 4000 bytes the results file keeps, one more per line (20260930670000's rule).
			if v_round is not null and octet_length(v_report || v_round)
				+ cardinality(string_to_array(v_report || v_round, E'\n')) <= 4000 then
				v_report := v_report || v_round; end if;
		end if;
	elsif v_job.id is not null and v_code ~ '^[A-Z0-9_]{1,42}(:[A-Z0-9_]{1,42})?$'$new$]);

-- 5. Grants, and the deploy guard ----------------------------------------------------------------------------------------

revoke all on function public.qorpera_code_checks_passed_valid(jsonb, text, text),
	public.qorpera_code_change_checks_valid(jsonb),
	public.qorpera_code_checks_switch(uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_code_checks_switch(uuid, uuid) to service_role;

-- Every changed body carries the marker.
do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_code_change_report_valid(jsonb)',
		'public.qorpera_record_code_change(uuid,uuid,jsonb)',
		'public.qorpera_code_change_files(text,text,uuid,text,text,integer)',
		'public.qorpera_code_request_finish(text,text,uuid,uuid,jsonb)',
		'public.qorpera_code_restore_record(text,text,uuid,uuid,jsonb)',
		'public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)',
		'public.qorpera_coding_turn_failure(public.qorpera_runtime_workers,text)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930721000') = 0 then
			raise exception '20260930721000 is missing from %', v_function; end if;
	end loop;
end $guard$;
