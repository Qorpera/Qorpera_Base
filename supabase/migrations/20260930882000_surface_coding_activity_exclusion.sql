-- WHY: Code-backed interface turns run as surface-backed coding workers under the Co-Founder's
-- staff_agent_id via worker-dispatch wakes. Exclude them from qorpera_list_staff_execution_activity
-- so interface work stays on its interface card while chat-dispatched coding turns remain visible.
set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_list_staff_execution_activity(uuid)') is null
		or position('20260930855000' in pg_get_functiondef(
			'public.qorpera_list_staff_execution_activity(uuid)'::regprocedure)) = 0
		or not exists (
			select 1 from information_schema.columns
			where table_schema = 'public' and table_name = 'qorpera_runtime_workers'
				and column_name = 'surface_backed'
		) then
		raise exception '20260930882000 requires 20260930855000 and 20260930857000';
	end if;
	if position('20260930882000' in pg_get_functiondef(
		'public.qorpera_list_staff_execution_activity(uuid)'::regprocedure)) > 0 then
		raise exception '20260930882000 is already applied';
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
			raise exception '20260930882000 empty anchor for %', p_target;
		end if;
		v_matches := (length(v_definition) - length(replace(v_definition, p_pairs[v_index], ''))) / length(p_pairs[v_index]);
		if v_matches <> 1 then
			raise exception '20260930882000 anchor found % time(s) in %, expected 1: %',
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
$old$				-- WHY: 20260930855000 keeps surface-session runs on their surface card rather than Co-Founder chat activity.
				(job.status in ('queued', 'leased') and not (run.source_kind = 'wake' and exists (
					select 1 from public.qorpera_wake_occurrences as occurrence
					where occurrence.id = run.source_id and occurrence.source_kind = 'surface-session'
				)))$old$,
$new$				-- WHY: 20260930855000 + 20260930882000 keep surface-session and surface-backed coding runs on their surface card.
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
$old$							and not ((exists (select 1 from public.qorpera_coding_session_turns as coding
									where coding.occurrence_id = occurrence.id)
								or occurrence.source_kind = 'surface-session')$old$,
$new$							and not ((exists (select 1 from public.qorpera_coding_session_turns as coding
									where coding.occurrence_id = occurrence.id)
								or occurrence.source_kind = 'surface-session'
								or (occurrence.source_kind = 'worker-dispatch' and exists (
									select 1 from public.qorpera_runtime_workers as worker
									where worker.id = occurrence.source_id and worker.surface_backed
								)))$new$
	]
);

do $guard$
declare
	v_activity text := pg_get_functiondef('public.qorpera_list_staff_execution_activity(uuid)'::regprocedure);
begin
	if strpos(v_activity, '20260930882000') = 0
		or strpos(v_activity, '20260930855000') = 0
		or strpos(v_activity, '20260930751000') = 0
		or strpos(v_activity, '20260930542000') = 0
		or strpos(v_activity, 'when job.cancelled_by_user_id is not null then 0') = 0
		or strpos(v_activity, 'worker.surface_backed') = 0 then
		raise exception '20260930882000 guard failed for qorpera_list_staff_execution_activity';
	end if;
end $guard$;

do $$
declare
	v_expected constant regprocedure[] := array[
		'public.qorpera_list_staff_execution_activity(uuid)'::regprocedure
	];
begin
	if (select count(*) from pg_temp.scae_before as prior join pg_proc as patched on patched.oid = prior.oid
			where md5(patched.prosrc) is distinct from prior.source) <> cardinality(v_expected)
		or exists (select 1 from pg_temp.scae_before as prior left join pg_proc as patched on patched.oid = prior.oid
			where patched.oid is null or to_jsonb(patched) - 'prosrc' is distinct from prior.fields
				or (md5(patched.prosrc) is distinct from prior.source and not (prior.oid = any(v_expected))))
		or exists (select 1 from pg_proc as p where p.pronamespace = 'public'::regnamespace
			and p.oid not in (select prior.oid from pg_temp.scae_before as prior)) then
		raise exception '20260930882000: catalog changed unexpectedly';
	end if;
end $$;

drop function pg_temp.scae_patch(regprocedure, text[]);
drop table pg_temp.scae_before;
