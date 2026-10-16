-- Test machine reads: F3 step 6, slice 6a, part 3 (deploy/first-node/RUNTIME-FOLDER-TEST-MACHINES.md, "Reads"), the read
-- set of a test machine's view (RUNTIME-COMPANY-FOLDER-C1B.md "C1b-3: views" §6 and §8). One command can read through
-- /company for another, so a read reaches every run with a command running on the machine.
-- 1. Fan-out: a test machine's release writes the view's read set and, besides the live run's, the read set of every
--    run with a command running on the view's machine and placement (not ended) whose job is leased. Those jobs are
--    taken KEY SHARE with the live run's, in id order, before the view row, so a job's completion waits for the
--    release. A run whose command ended, or whose job is not leased, gets nothing (its output takes in the view's reads
--    instead, 6d). The runs are written in run id order. A run other than the live one gets the reads checked for its
--    own authority, as a take-in does (its agent's grant, without the company-wide restriction); a path it can no
--    longer read refuses the release ("A released read is no longer readable"). The result lists the runs written
--    (runIds), for a test machine's view only.
-- 2. Rank 10: every commit of a test machine's view already rechecks the view's read set under the view's actor, as
--    every staff_agent view's commit does (20260928259230), and besides it one run's set: the live run's, or, detached,
--    the starter's run (20260930420000). This adds no recheck. The fanned-out runs' sets are not rechecked at the
--    machine's commits: each pair fanned out is in the view's set from the same release, so the view's recheck covers
--    every read the machine made, and those reads rest on the root, which the starter must keep reading for the view
--    to stand. Each fanned-out run's set is rechecked under its own authority at its own effects, as any run's is (C1B-2
--    §3). Checking those sets at the machine's commit would block the machine on another run's unrelated narrowing.
-- 3. The read set carries to the next view of the same placement (20260930420000), unchanged.
-- 4. Take-in: a run takes in a test machine's view when the view is its own agent's and member's, as today, or when the
--    run has the company audience and its agent and member read the root now (qorpera_folder_reads_root). Otherwise it
--    is refused ("A run inherits a test machine's reads only with the company-wide view", 42501). Other kinds keep
--    today's rule. A take-in that finds a read no longer readable still raises.
-- The crashed service refusal (part 4, on 5a's served_by) comes later.
--
-- On top of 20260930445000 (step 5a, the coding machine's read set), which patches the same release: a coding view's
-- reads go to its machine's set and reach every turn leased on the machine, those turns' jobs KEY SHARE in id order.
-- Both fan-outs stay: 5a's for a coding view, this one for a test machine's, so a release holds the jobs of one of
-- them at most. One loop writes the view's run, a coding machine's turns and a test machine's runs, each once, in run
-- id order. The view's run and the turns get the view's pairs, as in 5a; a test machine's other runs get them checked
-- for their own authority.
-- And on top of 20260930446000 (step 5a, the code host's view): its take-in compares the view's agent and member with
-- "is distinct from", so a code host's view, which has neither, is no run's own. Part 4 keeps that comparison.
--
-- Exact-text patches: each fails unless the function has the text given exactly once; each function is replaced once,
-- after the last. Body marker "20260930480000".

set local lock_timeout = '3s';

do $$ begin
	if strpos(pg_get_functiondef(
		'public.qorpera_folder_record_view_release(uuid,uuid,jsonb,uuid,jsonb,text,text)'::regprocedure), '20260930480000') > 0 then
		raise exception 'Test machine reads (20260930480000) are already applied'; end if;
end $$;

-- The patches edit the definition's text in order; each function is replaced once, after the last one (the release's
-- declarations and its loop come in separate patches).
create temporary table folder_test_machine_reads_defs (fn regprocedure not null, def text not null);
create function pg_temp.folder_test_machine_reads_patch(p_function regprocedure, p_old text, p_new text) returns void
language plpgsql as $patch$
declare v_definition text;
begin
	select def into v_definition from pg_temp.folder_test_machine_reads_defs where fn = p_function;
	if v_definition is null then
		v_definition := pg_get_functiondef(p_function);
		insert into pg_temp.folder_test_machine_reads_defs(fn, def) values (p_function, v_definition);
	end if;
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '% does not have the text this migration expects: %', p_function, left(p_old, 80); end if;
	update pg_temp.folder_test_machine_reads_defs set def = replace(v_definition, p_old, p_new) where fn = p_function;
end
$patch$;
create function pg_temp.folder_test_machine_reads_apply() returns void language plpgsql as $apply$
declare v_fn regprocedure; v_def text; v_context text;
begin
	for v_fn, v_def in select fn, def from pg_temp.folder_test_machine_reads_defs loop
		begin
			execute v_def;
		exception when others then
			-- A short message: the statement's own text would be the whole function.
			get stacked diagnostics v_context = pg_exception_context;
			raise exception '% does not compile after the patches: % (%)', v_fn, sqlerrm, split_part(v_context, E'\n', 1);
		end;
	end loop;
	drop table pg_temp.folder_test_machine_reads_defs;
end
$apply$;

-- 1. The release: its own variables, after 5a's.
select pg_temp.folder_test_machine_reads_patch(
	'public.qorpera_folder_record_view_release(uuid,uuid,jsonb,uuid,jsonb,text,text)'::regprocedure,
	$old$	v_machine uuid; v_machine_jobs uuid[]; v_turns uuid[]; v_unlocked boolean; v_turn uuid;
$old$,
	$new$	v_machine uuid; v_machine_jobs uuid[]; v_turns uuid[]; v_unlocked boolean; v_turn uuid;
	-- 20260930480000: a test machine's machine and placement; the jobs held for its fan-out (null for other kinds); the
	-- runs it fans out to; the pairs of the run being written; the runs written.
	v_test_machine uuid; v_test_placement uuid; v_fan_jobs uuid[]; v_fan_runs uuid[] := '{}'; v_run_pairs jsonb;
	v_written uuid[] := '{}';
$new$);

-- 1. The jobs, KEY SHARE in id order, with the live run's, before the view row; after 5a's coding turns' jobs.
select pg_temp.folder_test_machine_reads_patch(
	'public.qorpera_folder_record_view_release(uuid,uuid,jsonb,uuid,jsonb,text,text)'::regprocedure,
	$old$		if v_machine is not null then
			select coalesce(array_agg(locked.id order by locked.id), '{}') into v_machine_jobs
			from (select j.id from public.qorpera_runner_jobs j
				where j.id in (select t.job_id from public.qorpera_coding_machine_turns(v_machine) t) order by j.id for key share) locked;
		end if;
$old$,
	$new$		if v_machine is not null then
			select coalesce(array_agg(locked.id order by locked.id), '{}') into v_machine_jobs
			from (select j.id from public.qorpera_runner_jobs j
				where j.id in (select t.job_id from public.qorpera_coding_machine_turns(v_machine) t) order by j.id for key share) locked;
		end if;
		-- 20260930480000: a test machine's release reaches every run with a command running on the view's machine and
		-- placement whose job is leased. Those jobs and the live run's are taken KEY SHARE in one statement, in id order;
		-- the live run's own statement below finds its job held already. A coding view holds none of these (above).
		if v_early -> 'view' ->> 'kind' = 'test_machine' then
			select v.company_machine_id, v.placement_id into v_test_machine, v_test_placement
			from public.qorpera_folder_views v where v.id = v_view_id;
			select coalesce(array_agg(x.id order by x.id), '{}') into v_fan_jobs
			from (select j.id from public.qorpera_runner_jobs j
				where j.id in (select r.job_id from public.qorpera_company_machine_commands c
						join public.qorpera_execution_runs r on r.id = c.run_id
						where c.machine_id = v_test_machine and c.placement_id = v_test_placement and c.ended_at is null
						union all select (v_run_actor ->> 'jobId')::uuid)
					and (j.id = (v_run_actor ->> 'jobId')::uuid or (j.status = 'leased' and j.lease_expires_at > clock_timestamp()))
				order by j.id for key share of j) x;
		end if;
$new$);

-- 1. The runs: 5a's loop over the view's run and the coding machine's turns takes in the test machine's runs too, each
-- run once, in run id order.
select pg_temp.folder_test_machine_reads_patch(
	'public.qorpera_folder_record_view_release(uuid,uuid,jsonb,uuid,jsonb,text,text)'::regprocedure,
	$old$	-- The view's run, and (20260930445000) every turn leased on its machine, in id order.
	for v_turn in select distinct turn.id from unnest(coalesce(v_turns, '{}') || (v_run_actor ->> 'runId')::uuid) turn(id)
		where turn.id is not null order by turn.id loop
		-- The run's records are keyed by release id too: an id the run already used is refused, never half-filed.
		if exists (select 1 from public.qorpera_folder_run_releases where run_id = v_turn and release_id = p_release_id)
			or exists (select 1 from public.qorpera_folder_run_read_records where run_id = v_turn and release_id = p_release_id) then
			raise exception 'Release id was used for other reads' using errcode = '22023'; end if;
		perform public.qorpera_folder_write_read_set(p_environment_id, v_turn, v_pairs -> 'upserts', null, null);
		insert into public.qorpera_folder_run_read_records(run_id, release_id, environment_id, resource_id, reads, output_sha256)
		select v_turn, p_release_id, p_environment_id, (f -> 'authority' ->> 'resourceId')::uuid,
			jsonb_agg(f order by public.qorpera_folder_key(f ->> 'path')), p_output_sha256
		from jsonb_array_elements(v_pairs -> 'filed') f group by 4;
	end loop;
	v_result := jsonb_build_object('schema','qorpera.folder-release/v1','releaseId',p_release_id,
		'reads',jsonb_array_length(p_reads),'replay',false,'runId',v_run_actor ->> 'runId');$old$,
	$new$	-- 20260930480000: on a test machine, the runs with a command running on the view's placement whose job is leased
	-- and held above (this statement sees a command that ended or a job that let go while the release waited).
	if v_fan_jobs is not null then
		select coalesce(array_agg(distinct c.run_id order by c.run_id), '{}') into v_fan_runs
		from public.qorpera_company_machine_commands c
		join public.qorpera_execution_runs r on r.id = c.run_id
		join public.qorpera_runner_jobs j on j.id = r.job_id
		where c.machine_id = v_test_machine and c.placement_id = v_test_placement and c.ended_at is null
			and j.id = any (v_fan_jobs) and j.status = 'leased' and j.lease_expires_at > clock_timestamp();
	end if;
	-- The view's run, every turn leased on its machine (20260930445000) and every run a test machine's release reaches
	-- (20260930480000): each once, in run id order, so two releases write the same runs' read sets in one order. The
	-- view's run and a coding machine's turns get the view's pairs; a test machine's other runs get them checked for
	-- each run's own authority, as a take-in does.
	for v_turn in select distinct turn.id
		from unnest(coalesce(v_turns, '{}') || v_fan_runs || (v_run_actor ->> 'runId')::uuid) turn(id)
		where turn.id is not null order by turn.id loop
		if v_turn = any (v_fan_runs) and v_turn is distinct from (v_run_actor ->> 'runId')::uuid then
			v_run_pairs := public.qorpera_folder_release_pairs(p_environment_id, p_profile_id,
				public.qorpera_folder_run_reader(p_profile_id, v_turn), v_pairs -> 'filed');
		else
			v_run_pairs := v_pairs;
		end if;
		-- The run's records are keyed by release id too: an id the run already used is refused, never half-filed.
		if exists (select 1 from public.qorpera_folder_run_releases where run_id = v_turn and release_id = p_release_id)
			or exists (select 1 from public.qorpera_folder_run_read_records where run_id = v_turn and release_id = p_release_id) then
			raise exception 'Release id was used for other reads' using errcode = '22023'; end if;
		perform public.qorpera_folder_write_read_set(p_environment_id, v_turn, v_run_pairs -> 'upserts', null, null);
		insert into public.qorpera_folder_run_read_records(run_id, release_id, environment_id, resource_id, reads, output_sha256)
		select v_turn, p_release_id, p_environment_id, (f -> 'authority' ->> 'resourceId')::uuid,
			jsonb_agg(f order by public.qorpera_folder_key(f ->> 'path')), p_output_sha256
		from jsonb_array_elements(v_run_pairs -> 'filed') f group by 4;
		v_written := v_written || v_turn;
	end loop;
	v_result := jsonb_build_object('schema','qorpera.folder-release/v1','releaseId',p_release_id,
		'reads',jsonb_array_length(p_reads),'replay',false,'runId',v_run_actor ->> 'runId')
		|| case when v_fan_jobs is not null then jsonb_build_object('runIds', to_jsonb(v_written)) else '{}'::jsonb end;$new$);

-- 4. The take-in: a test machine's view for a company-audience run whose agent and member read the root.
select pg_temp.folder_test_machine_reads_patch(
	'public.qorpera_folder_run_inherit_view_reads(uuid,jsonb,uuid,uuid)'::regprocedure,
	$old$	if not found or v_view.environment_id <> p_environment_id or v_view.staff_agent_id is distinct from (v_resolved ->> 'staffAgentId')::uuid
		or v_view.member_user_id is distinct from (v_resolved ->> 'requesterUserId')::uuid then
		raise exception 'A run inherits only its own agent''s and member''s views' using errcode = '42501'; end if;$old$,
	$new$	if not found or v_view.environment_id <> p_environment_id then
		raise exception 'A run inherits only its own agent''s and member''s views' using errcode = '42501';
	elsif v_view.staff_agent_id is not distinct from (v_resolved ->> 'staffAgentId')::uuid
		and v_view.member_user_id is not distinct from (v_resolved ->> 'requesterUserId')::uuid then
		null; -- Its own agent's and member's view, of any kind (20260930446000: a code host's view has neither).
	elsif v_view.kind = 'test_machine' then
		-- 20260930480000: a test machine's output can show what any command on it read, so any run that sees it takes in
		-- the machine's reads: a company-audience run whose agent and member read the root now.
		if v_resolved -> 'audience' ->> 'kind' is distinct from 'company'
			or not public.qorpera_folder_reads_root(p_environment_id, v_file.profile_id, (v_resolved ->> 'staffAgentId')::uuid,
				(v_resolved ->> 'requesterUserId')::uuid) then
			raise exception 'A run inherits a test machine''s reads only with the company-wide view' using errcode = '42501'; end if;
	else
		raise exception 'A run inherits only its own agent''s and member''s views' using errcode = '42501';
	end if;$new$);
select pg_temp.folder_test_machine_reads_apply();

-- The functions may have a private owner in production: the release reaches the commands and the runs it finds their
-- jobs with (it locks the jobs already), and the run reader and the receipt check; the take-in reaches the root check.
do $$ declare v_owner name; begin
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_folder_record_view_release(uuid,uuid,jsonb,uuid,jsonb,text,text)'::regprocedure,
		'public.qorpera_folder_run_inherit_view_reads(uuid,jsonb,uuid,uuid)'::regprocedure)) loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'Test machine read function has an API owner'; end if;
	end loop;
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_folder_record_view_release(uuid,uuid,jsonb,uuid,jsonb,text,text)'::regprocedure)) loop
		if v_owner is distinct from current_user then
			execute format('grant select on public.qorpera_company_machine_commands, public.qorpera_execution_runs, '
				'public.qorpera_runner_jobs to %I', v_owner);
			execute format('grant execute on function public.qorpera_folder_run_reader(uuid, uuid), '
				'public.qorpera_folder_release_pairs(uuid, uuid, jsonb, jsonb) to %I', v_owner);
		end if;
	end loop;
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_folder_run_inherit_view_reads(uuid,jsonb,uuid,uuid)'::regprocedure)) loop
		if v_owner is distinct from current_user then
			execute format('grant execute on function public.qorpera_folder_reads_root(uuid, uuid, uuid, uuid) to %I', v_owner);
		end if;
	end loop;
end $$;
