set local lock_timeout = '3s';

create or replace function pg_temp.quiet_approvals_patch(p_target regprocedure, p_edits text[]) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_found integer;
begin
	if position('20260930892000' in v_definition) > 0 then
		raise exception '20260930892000 is already in %', p_target; end if;
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception '20260930892000 anchor found % time(s) in %, expected 1: %', v_found, p_target, left(p_edits[2 * i - 1], 80); end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

select pg_temp.quiet_approvals_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)', array[
	$old$			-- 20260930619000: a test machine's or run box's delete or move of a file it wrote itself, outside QorperaOS/, takes
			-- the hook's class.
			v_class := case when v_op in ('delete','move') and not (v_actor_kind = 'view' and v_view.kind in ('test_machine','run_box')
					and v_row.kind = 'file'
					and v_key not like 'qorperaos/%' and coalesce(v_to_key, '') not like 'qorperaos/%'
					and exists (select 1 from public.qorpera_folder_commits c where c.id = v_row.commit_id
						and c.view_id = v_view.id)) then 'deletion'
				else public.qorpera_folder_structured_review_class(p_environment_id, v_hook_actor, v_unit, v_eff_path, v_eff_to) end;$old$,
	$new$			-- 20260930892000: every unit takes the structured hook's review class; plain company file deletes and moves are versioned and need no review.
			v_class := public.qorpera_folder_structured_review_class(p_environment_id, v_hook_actor, v_unit, v_eff_path, v_eff_to);$new$
]);

create or replace function public.qorpera_folder_structured_review_class(p_environment_id uuid, p_actor jsonb, p_unit jsonb,
	p_eff_path text, p_eff_to text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
	v_op text := p_unit ->> 'op';
	v_file record;
	v_kind text;
	v_base jsonb;
	v_entry jsonb;
	v_entries jsonb := public.qorpera_company_state_entries(p_unit);
	v_rel text;
	v_to_rel text;
begin
	if v_op in ('delete', 'move') then
		v_rel := public.qorpera_os_relative(public.qorpera_folder_key(p_eff_path));
		v_to_rel := case when p_eff_to is not null then public.qorpera_os_relative(public.qorpera_folder_key(p_eff_to)) end;
		if (v_rel is not null and (
				v_rel ~ '^agents/groups/[^/]+(/group\.md)?$'
				or (v_rel ~ '^agents/[^/]+(/agent\.md)?$' and v_rel !~ '^agents/(groups|sections\.md)(/|$)')))
			or (v_to_rel is not null and (
				v_to_rel ~ '^agents/groups/[^/]+(/group\.md)?$'
				or (v_to_rel ~ '^agents/[^/]+(/agent\.md)?$' and v_to_rel !~ '^agents/(groups|sections\.md)(/|$)'))) then
			return 'delegation';
		end if;
		return 'plain';
	end if;

	for v_file in select * from public.qorpera_company_state_unit_files(p_unit, p_eff_path) loop
		v_kind := public.qorpera_structured_path_kind(v_file.key);
		if v_kind is null then continue; end if;
		select v.structured -> 'parse' into v_base
		from public.qorpera_folder_entries e join public.qorpera_folder_path_versions v on v.version = e.version
		where e.environment_id = p_environment_id and e.key_sha256 = extensions.digest(v_file.key, 'sha256') and e.kind = 'file';
		v_entry := v_entries -> v_file.key;
		if v_kind = 'agent' and (v_base is null
			or v_base ->> 'status' is distinct from v_entry -> 'parse' ->> 'status') then return 'delegation'; end if;
		if v_kind = 'group' and v_base is null then return 'delegation'; end if;
	end loop;
	return 'plain';
end $$;

select pg_temp.quiet_approvals_patch('public.qorpera_record_action_review(jsonb,jsonb)', array[
	$old$	if not v_card and v_decision = 'ask' and p_review ->> 'tool' <> 'decide_routine'
		and public.qorpera_environment_is_folder_v2(v_run.environment_id)
		and v_run.audience_kind = 'company'$old$,
	$new$	if not v_card and v_decision = 'ask' and p_review ->> 'tool' <> 'decide_routine'
		and public.qorpera_environment_is_folder_v2(v_run.environment_id)
		and v_run.audience_kind = 'company'
		-- 20260930892000: background workers never drop raw approval cards into agent threads; they report blocked to their parent.
		and not exists (select 1 from public.qorpera_wake_occurrences as wake
			where wake.run_id = v_run.id and wake.source_kind = 'worker-dispatch')$new$
]);

drop function pg_temp.quiet_approvals_patch(regprocedure, text[]);
