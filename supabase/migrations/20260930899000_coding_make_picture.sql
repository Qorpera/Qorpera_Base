set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_begin_native_coding_execution(jsonb,text,text,text,text,text,integer)') is null
		or to_regprocedure('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)') is null then
		raise exception '20260930899000 requires qorpera_begin_native_coding_execution and qorpera_folder_commit';
	end if;
end $$;

create function pg_temp.cmp_patch(p_target regprocedure, p_edits text[])
returns void language plpgsql as $$
declare
	v_definition text := pg_get_functiondef(p_target);
	v_hits integer;
	v_i integer := 1;
begin
	if coalesce(array_length(p_edits, 1), 0) = 0 or array_length(p_edits, 1) % 2 <> 0 then
		raise exception '20260930899000 invalid replacement pairs for %', p_target;
	end if;
	while v_i <= array_length(p_edits, 1) loop
		v_hits := (length(v_definition) - length(replace(v_definition, p_edits[v_i], ''))) / length(p_edits[v_i]);
		if v_hits <> 1 then
			raise exception '20260930899000 anchor matched % time(s) in %: %', v_hits, p_target, left(p_edits[v_i], 100);
		end if;
		v_definition := replace(v_definition, p_edits[v_i], p_edits[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_definition;
end $$;

select pg_temp.cmp_patch('public.qorpera_begin_native_coding_execution(jsonb,text,text,text,text,text,integer)'::regprocedure, array[
	$old$not between 4 and (case when v_is_surface then 7 else 5 end)$old$,
	$new$not between 4 and (case when v_is_surface then 8 else 6 end)$new$,
	$old$where tool ->> 'name' not in ('coding_run_command','coding_read_command','coding_cancel_command','coding_finish','coding_ask')$old$,
	$new$where tool ->> 'name' not in ('coding_run_command','coding_read_command','coding_cancel_command','coding_finish','coding_ask','make_picture')$new$
]);

-- WHY: A live coding turn run writing generated assets via make_picture must be scoped strictly to its own worktrees/<workerId>/ subtree while keeping repo.git/worktrees/<workerId>/ and all other git paths refused.
select pg_temp.cmp_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure, array[
	$old$	v_git_worker := case when v_view.kind = 'coding_session' then v_view.worker_id end;$old$,
	$new$	v_git_worker := case when v_view.kind = 'coding_session' then v_view.worker_id
		when v_actor_kind = 'run' and v_resolved ->> 'sessionKind' = 'coding'
			then (public.qorpera_run_worker((v_resolved ->> 'runId')::uuid)).id end;$new$,
	$old$			v_reason := public.qorpera_folder_git_unit_refusal(p_environment_id, v_unit, v_key, v_to_key, v_git_class, v_git_worker);$old$,
	$new$			v_reason := public.qorpera_folder_git_unit_refusal(p_environment_id, v_unit, v_key, v_to_key, v_git_class,
				case when v_actor_kind = 'run'
					and (split_part(v_key, '/', 4) <> 'worktrees' or (v_to_key is not null and split_part(v_to_key, '/', 4) <> 'worktrees'))
					then null else v_git_worker end);$new$
]);

drop function pg_temp.cmp_patch(regprocedure, text[]);

do $guard$
declare
	v_begin text := pg_get_functiondef('public.qorpera_begin_native_coding_execution(jsonb,text,text,text,text,text,integer)'::regprocedure);
	v_commit text := pg_get_functiondef('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure);
begin
	if strpos(v_begin, '''make_picture''') = 0 or strpos(v_begin, 'case when v_is_surface then 8 else 6 end') = 0 then
		raise exception '20260930899000 missing from qorpera_begin_native_coding_execution';
	end if;
	if strpos(v_commit, 'qorpera_run_worker((v_resolved ->> ''runId'')::uuid)') = 0
		or strpos(v_commit, 'split_part(v_key, ''/'', 4) <> ''worktrees''') = 0
		or strpos(v_commit, '20260930446200') = 0
		or strpos(v_commit, '20260930446000') = 0
		or strpos(v_commit, '20260930445000') = 0 then
		raise exception '20260930899000 missing or dropped markers in qorpera_folder_commit';
	end if;
end $guard$;
