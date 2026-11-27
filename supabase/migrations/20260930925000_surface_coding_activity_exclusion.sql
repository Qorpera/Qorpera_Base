-- WHY: Interface coding sessions run as surface-backed workers under Co-Founder via worker-dispatch wakes.
-- Exclude them alongside surface-session wakes from staff execution activity and activity live hints.
set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_list_staff_execution_activity(uuid)') is null
		or to_regprocedure('public.qorpera_activity_hint()') is null
		or position('20260930855000' in pg_get_functiondef(
			'public.qorpera_list_staff_execution_activity(uuid)'::regprocedure)) = 0
		or position('20260930904500' in pg_get_functiondef(
			'public.qorpera_list_staff_execution_activity(uuid)'::regprocedure)) = 0
		or position('20260930904500' in pg_get_functiondef(
			'public.qorpera_activity_hint()'::regprocedure)) = 0
		or not exists (
			select 1 from information_schema.columns
			where table_schema = 'public' and table_name = 'qorpera_runtime_workers'
				and column_name = 'surface_backed'
		) then
		raise exception '20260930925000 requires 20260930855000, 20260930857000, and 20260930904500';
	end if;
	if position('20260930925000' in pg_get_functiondef(
		'public.qorpera_list_staff_execution_activity(uuid)'::regprocedure)) > 0
		or position('20260930925000' in pg_get_functiondef(
			'public.qorpera_activity_hint()'::regprocedure)) > 0 then
		raise exception '20260930925000 is already applied';
	end if;
end $$;

create temporary table scae_before as
select p.oid, to_jsonb(p) - 'prosrc' as fields, md5(p.prosrc) as source
from pg_proc as p where p.pronamespace = 'public'::regnamespace;

create function pg_temp.scae_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_definition text := pg_get_functiondef(p_target);
	v_index integer;
	v_matches integer;
begin
	for v_index in 1 .. coalesce(array_length(p_pairs, 1), 0) by 2 loop
		if p_pairs[v_index] = '' then
			raise exception '20260930925000 empty anchor for %', p_target;
		end if;
		v_matches := (length(v_definition) - length(replace(v_definition, p_pairs[v_index], ''))) / length(p_pairs[v_index]);
		if v_matches <> 1 then
			raise exception '20260930925000 anchor found % time(s) in %, expected 1: %',
				v_matches, p_target, left(p_pairs[v_index], 120);
		end if;
		v_definition := replace(v_definition, p_pairs[v_index], p_pairs[v_index + 1]);
	end loop;
	execute v_definition;
end $$;

select pg_temp.scae_patch(
	'public.qorpera_list_staff_execution_activity(uuid)'::regprocedure,
	array[
$old$						and not (newer.source_kind = 'wake' and exists (
							select 1 from public.qorpera_wake_occurrences as newer_occ
							where newer_occ.id = newer.source_id and newer_occ.source_kind = 'surface-session'
						))$old$,
$new$						and not (newer.source_kind = 'wake' and exists (
							select 1 from public.qorpera_wake_occurrences as newer_occ
							where newer_occ.id = newer.source_id and (
								newer_occ.source_kind = 'surface-session'
								or (newer_occ.source_kind = 'worker-dispatch' and exists (
									select 1 from public.qorpera_runtime_workers as newer_worker
									where newer_worker.id = newer_occ.source_id and newer_worker.surface_backed
								))
							)
						))$new$,
$old$						and newer_wake.wake_kind in ('room', 'agent', 'routine')
						and newer_wake.source_kind <> 'surface-session'$old$,
$new$						and newer_wake.wake_kind in ('room', 'agent', 'routine')
						and newer_wake.source_kind <> 'surface-session'
						and not (newer_wake.source_kind = 'worker-dispatch' and exists (
							select 1 from public.qorpera_runtime_workers as newer_worker
							where newer_worker.id = newer_wake.source_id and newer_worker.surface_backed
						))$new$,
$old$				-- WHY: 20260930855000 keeps surface-session runs on their surface card rather than Co-Founder chat activity.
				(job.status in ('queued', 'leased') and not (run.source_kind = 'wake' and exists (
					select 1 from public.qorpera_wake_occurrences as occurrence
					where occurrence.id = run.source_id and occurrence.source_kind = 'surface-session'
				)))$old$,
$new$				-- WHY: 20260930855000 + 20260930925000 keep surface-session and surface-backed coding runs out of chat activity.
				(job.status in ('queued', 'leased') and not (run.source_kind = 'wake' and exists (
					select 1 from public.qorpera_wake_occurrences as occurrence
					where occurrence.id = run.source_id and (
						occurrence.source_kind = 'surface-session'
						or (occurrence.source_kind = 'worker-dispatch' and exists (
							select 1 from public.qorpera_runtime_workers as worker
							where worker.id = occurrence.source_id and worker.surface_backed
						))
					)
				)))$new$,
$old$				and wake.wake_kind in ('room', 'agent', 'routine')
				and wake.source_kind <> 'surface-session'$old$,
$new$				and wake.wake_kind in ('room', 'agent', 'routine')
				and wake.source_kind <> 'surface-session'
				and not (wake.source_kind = 'worker-dispatch' and exists (
					select 1 from public.qorpera_runtime_workers as worker
					where worker.id = wake.source_id and worker.surface_backed
				))$new$
	]
);

select pg_temp.scae_patch(
	'public.qorpera_activity_hint()'::regprocedure,
	array[
$old$		if tg_table_name = 'qorpera_runtime_observations' then
			select run.profile_id into v_profile_id
			from public.qorpera_execution_runs as run
			where run.id = new.run_id;
		else
			v_profile_id := new.profile_id;
		end if;$old$,
$new$		-- WHY: 20260930925000 skips activity hints for surface-session and surface-backed coding work unless recovery or a proposal is open.
		if tg_table_name = 'qorpera_runtime_observations' then
			select run.profile_id into v_profile_id
			from public.qorpera_execution_runs as run
			where run.id = new.run_id
				and not (run.source_kind = 'wake' and exists (
					select 1 from public.qorpera_wake_occurrences as occ
					where occ.id = run.source_id and (
						occ.source_kind = 'surface-session'
						or (occ.source_kind = 'worker-dispatch' and exists (
							select 1 from public.qorpera_runtime_workers as worker
							where worker.id = occ.source_id and worker.surface_backed
						))
					)
				));
		elsif tg_table_name = 'qorpera_wake_occurrences' then
			if new.source_kind = 'surface-session'
				or (new.source_kind = 'worker-dispatch' and exists (
					select 1 from public.qorpera_runtime_workers as worker
					where worker.id = new.source_id and worker.surface_backed
				)) then
				return null;
			end if;
			v_profile_id := new.profile_id;
		elsif tg_table_name = 'qorpera_runner_jobs' then
			if exists (
				select 1
				from public.qorpera_execution_runs as run
				join public.qorpera_wake_occurrences as occ on occ.id = run.source_id
				where run.job_id = new.id and run.source_kind = 'wake' and (
					occ.source_kind = 'surface-session'
					or (occ.source_kind = 'worker-dispatch' and exists (
						select 1 from public.qorpera_runtime_workers as worker
						where worker.id = occ.source_id and worker.surface_backed
					))
				)
				and not (
					new.status in ('failed', 'cancelled')
					and (
						exists (
							select 1 from public.qorpera_run_operation_receipts as receipt
							where receipt.run_id = run.id and receipt.status in ('executing', 'ambiguous')
						)
						or position('[code=RUN_COMPLETION_REFUSED]' in coalesce(new.last_error, '')) > 0
					)
				)
				and not exists (
					select 1 from public.qorpera_company_proposals as proposal
					where proposal.execution_kind = 'run' and proposal.execution_id = run.id
						and proposal.status = 'open'
				)
			) then
				return null;
			end if;
			v_profile_id := new.profile_id;
		else
			v_profile_id := new.profile_id;
		end if;$new$
	]
);

do $guard$
declare
	v_activity text := pg_get_functiondef('public.qorpera_list_staff_execution_activity(uuid)'::regprocedure);
	v_hint text := pg_get_functiondef('public.qorpera_activity_hint()'::regprocedure);
	v_owner name;
	v_expected constant regprocedure[] := array[
		'public.qorpera_list_staff_execution_activity(uuid)'::regprocedure,
		'public.qorpera_activity_hint()'::regprocedure
	];
begin
	if strpos(v_activity, '20260930925000') = 0
		or strpos(v_activity, '20260930904500') = 0
		or strpos(v_activity, '20260930855000') = 0
		or strpos(v_activity, '20260930751000') = 0
		or strpos(v_activity, '20260930542000') = 0
		or strpos(v_activity, 'when job.cancelled_by_user_id is not null then 0') = 0
		or strpos(v_activity, 'worker.surface_backed') = 0 then
		raise exception '20260930925000 guard failed for qorpera_list_staff_execution_activity';
	end if;
	if strpos(v_hint, '20260930925000') = 0
		or strpos(v_hint, '20260930904500') = 0
		or strpos(v_hint, 'worker.surface_backed') = 0 then
		raise exception '20260930925000 guard failed for qorpera_activity_hint';
	end if;

	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = any(v_expected)
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception '20260930925000 function has an API owner: %', v_owner;
		end if;
		execute format(
			'grant select on public.qorpera_runtime_workers, public.qorpera_wake_occurrences, '
			|| 'public.qorpera_execution_runs, public.qorpera_run_operation_receipts, '
			|| 'public.qorpera_company_proposals to %I',
			v_owner
		);
	end loop;

	if (select count(*) from pg_temp.scae_before as prior join pg_proc as patched on patched.oid = prior.oid
			where md5(patched.prosrc) is distinct from prior.source) <> cardinality(v_expected)
		or exists (select 1 from pg_temp.scae_before as prior left join pg_proc as patched on patched.oid = prior.oid
			where patched.oid is null or to_jsonb(patched) - 'prosrc' is distinct from prior.fields
				or (md5(patched.prosrc) is distinct from prior.source and not (prior.oid = any(v_expected))))
		or exists (select 1 from pg_proc as p where p.pronamespace = 'public'::regnamespace
			and p.oid not in (select prior.oid from pg_temp.scae_before as prior)) then
		raise exception '20260930925000: catalog changed unexpectedly';
	end if;
end $guard$;

drop function pg_temp.scae_patch(regprocedure, text[]);
drop table pg_temp.scae_before;
