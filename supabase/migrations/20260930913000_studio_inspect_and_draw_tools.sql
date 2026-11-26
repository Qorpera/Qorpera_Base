set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_begin_native_coding_execution(jsonb,text,text,text,text,text,integer)') is null
		or to_regprocedure('public.qorpera_record_runtime_observation(uuid,jsonb)') is null
		or to_regprocedure('public.qorpera_native_list_company_interfaces(jsonb)') is null then
		raise exception '20260930913000 requires 20260930912000';
	end if;
	if strpos(pg_get_functiondef('public.qorpera_begin_native_coding_execution(jsonb,text,text,text,text,text,integer)'::regprocedure), '''inspect_surface''') > 0 then
		raise exception '20260930913000 is already applied';
	end if;
end $$;

create temporary table sidt_before as
select oid, prosecdef, proconfig, provolatile, proacl from pg_proc
where oid in (
	'public.qorpera_begin_native_coding_execution(jsonb,text,text,text,text,text,integer)'::regprocedure,
	'public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure
);

create function pg_temp.sidt_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930913000: invalid replacement pairs for %', p_target;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930913000: expected 1 match in % for pair %, got %', p_target, v_i, v_hits;
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

select pg_temp.sidt_patch(
	'public.qorpera_begin_native_coding_execution(jsonb,text,text,text,text,text,integer)'::regprocedure,
	array[
$old$	if v_workspace_kind = 'surface_folder' then
		if jsonb_array_length(v_catalog -> 'tools') not between (case when v_is_claude then 2 else 5 end) and 19
			or exists (
				select 1 from jsonb_array_elements(v_catalog -> 'tools') tool
				where tool ->> 'name' not in (
					'stage_surface_patch','narrate_explainer','make_picture','coding_view_attachment',
					'company_read','company_list','company_search','company_write','company_edit','company_mkdir',
					'data_describe','data_query','read_skill','search_skills','coding_finish','coding_ask'
				)
					and not (not v_is_claude and tool ->> 'name' in ('coding_run_command','coding_read_command','coding_cancel_command'))
			) then
			raise exception 'Coding catalog must contain only coding tools' using errcode = '42501';
		end if;$old$,
$new$	if v_workspace_kind = 'surface_folder' then
		if jsonb_array_length(v_catalog -> 'tools') not between (case when v_is_claude then 2 else 5 end) and 22
			or exists (
				select 1 from jsonb_array_elements(v_catalog -> 'tools') tool
				where tool ->> 'name' not in (
					'stage_surface_patch','compose_surface_layout','stage_surface_artifact','inspect_surface',
					'narrate_explainer','make_picture','coding_view_attachment',
					'company_read','company_list','company_search','company_write','company_edit','company_mkdir',
					'data_describe','data_query','read_skill','search_skills','coding_finish','coding_ask'
				)
					and not (not v_is_claude and tool ->> 'name' in ('coding_run_command','coding_read_command','coding_cancel_command'))
			) then
			raise exception 'Coding catalog must contain only coding tools' using errcode = '42501';
		end if;$new$
	]
);

select pg_temp.sidt_patch(
	'public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	array[
$old$'surface_reply','surface_ask',/* 20260930887000 */'narrate_explainer',$old$,
$new$'surface_reply','surface_ask',/* 20260930887000 */'narrate_explainer',/* 20260930913000 */'inspect_surface','stage_surface_artifact','compose_surface_layout',$new$
	]
);

drop function pg_temp.sidt_patch(regprocedure, text[]);

do $$ begin
	if exists (
		select 1 from sidt_before b
		join pg_proc p on p.oid = b.oid
		where p.prosecdef is distinct from b.prosecdef
			or p.proconfig is distinct from b.proconfig
			or p.provolatile is distinct from b.provolatile
			or p.proacl is distinct from b.proacl
	) then
		raise exception '20260930913000: patched function attributes or ACL changed';
	end if;
end $$;
