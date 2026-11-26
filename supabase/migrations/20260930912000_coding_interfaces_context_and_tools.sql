set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_native_list_company_interfaces(jsonb)') is not null then
		raise exception '20260930912000 is already applied';
	end if;
	if to_regclass('public.qorpera_surfaces') is null
		or to_regprocedure('public.qorpera_surface_studio_ops_coding_ready()') is null
		or to_regprocedure('public.qorpera_describe_native_tool_authority(jsonb)') is null
		or to_regprocedure('public.qorpera_begin_native_coding_execution(jsonb,text,text,text,text,text,integer)') is null
		or to_regprocedure('public.qorpera_record_coding_context_view(jsonb,jsonb)') is null then
		raise exception '20260930912000 requires 20260930910000';
	end if;
end $$;

create temporary table cict_before as
select oid, prosecdef, proconfig, provolatile, proacl from pg_proc
where oid in (
	'public.qorpera_begin_native_coding_execution(jsonb,text,text,text,text,text,integer)'::regprocedure,
	'public.qorpera_record_coding_context_view(jsonb,jsonb)'::regprocedure
);

create function pg_temp.cict_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930912000: invalid replacement pairs for %', p_target;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930912000: anchor matched % time(s) in %: %', v_hits, p_target, left(p_pairs[v_i], 120);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

create function public.qorpera_native_list_company_interfaces(p_binding jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_authority jsonb;
	v_company_id uuid;
begin
	v_authority := public.qorpera_describe_native_tool_authority(p_binding);
	v_company_id := (v_authority #>> '{identity,companyId}')::uuid;
	return jsonb_build_object(
		'schema', 'qorpera.company-interfaces/v1',
		'interfaces', coalesce((
			select jsonb_agg(
				jsonb_build_object(
					'slug', s.slug,
					'title', s.title,
					'kind', s.surface_kind,
					'archetype', s.archetype,
					'sourceKind', s.source_kind,
					'folderRoot', s.folder_root,
					'repositoryKey', s.repository_key,
					'briefSummary', s.brief_summary,
					'isGlobal', s.is_global
				)
				order by s.sort_order asc, s.created_at asc
			)
			from (
				select slug, title, surface_kind, archetype, source_kind, folder_root, repository_key, brief_summary, is_global, sort_order, created_at
				from public.qorpera_surfaces
				where profile_id = v_company_id and status = 'active'
				order by sort_order asc, created_at asc
				limit 64
			) s
		), '[]'::jsonb)
	);
end $$;

revoke all on function public.qorpera_native_list_company_interfaces(jsonb)
	from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_native_list_company_interfaces(jsonb) to service_role;

insert into public.qorpera_native_host_calls(name, scope) values
	('qorpera_native_list_company_interfaces', 'binding');

select pg_temp.cict_patch(
	'public.qorpera_begin_native_coding_execution(jsonb,text,text,text,text,text,integer)'::regprocedure,
	array[
$old$	if v_workspace_kind = 'surface_folder' then
		if jsonb_array_length(v_catalog -> 'tools') not between (case when v_is_claude then 2 else 5 end) and 16
			or exists (
				select 1 from jsonb_array_elements(v_catalog -> 'tools') tool
				where tool ->> 'name' not in (
					'stage_surface_patch','narrate_explainer','make_picture','coding_view_attachment',
					'company_read','company_list','company_write','company_edit','company_mkdir',
					'read_skill','search_skills','coding_finish','coding_ask'
				)
					and not (not v_is_claude and tool ->> 'name' in ('coding_run_command','coding_read_command','coding_cancel_command'))
			) then
			raise exception 'Coding catalog must contain only coding tools' using errcode = '42501';
		end if;
	elsif v_workspace_kind = 'surface_ops' then
		if jsonb_array_length(v_catalog -> 'tools') not between (case when v_is_claude then 2 else 5 end) and 10
			or exists (
				select 1 from jsonb_array_elements(v_catalog -> 'tools') tool
				where tool ->> 'name' not in (
					'stage_surface_ops_action','coding_view_attachment',
					'company_read','company_list','coding_finish','coding_ask'
				)
					and not (not v_is_claude and tool ->> 'name' in ('coding_run_command','coding_read_command','coding_cancel_command'))
			) then
			raise exception 'Coding catalog must contain only coding tools' using errcode = '42501';
		end if;
	elsif jsonb_array_length(v_catalog -> 'tools') not between (case when v_is_claude then 1 else 4 end) and (case when v_is_surface then 8 else 6 end)
		or exists (
			select 1 from jsonb_array_elements(v_catalog -> 'tools') tool
			where tool ->> 'name' not in ('coding_run_command','coding_read_command','coding_cancel_command','coding_finish','coding_ask','make_picture')
				and not (v_is_surface and tool ->> 'name' in ('coding_record_change', 'coding_view_attachment'))
		) then
		raise exception 'Coding catalog must contain only coding tools' using errcode = '42501';
	end if;$old$,
$new$	if v_workspace_kind = 'surface_folder' then
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
		end if;
	elsif v_workspace_kind = 'surface_ops' then
		if jsonb_array_length(v_catalog -> 'tools') not between (case when v_is_claude then 2 else 5 end) and 13
			or exists (
				select 1 from jsonb_array_elements(v_catalog -> 'tools') tool
				where tool ->> 'name' not in (
					'stage_surface_ops_action','coding_view_attachment',
					'company_read','company_list','company_search','data_describe','data_query','coding_finish','coding_ask'
				)
					and not (not v_is_claude and tool ->> 'name' in ('coding_run_command','coding_read_command','coding_cancel_command'))
			) then
			raise exception 'Coding catalog must contain only coding tools' using errcode = '42501';
		end if;
	elsif jsonb_array_length(v_catalog -> 'tools') not between (case when v_is_claude then 1 else 4 end) and (case when v_is_surface then 9 else 7 end)
		or exists (
			select 1 from jsonb_array_elements(v_catalog -> 'tools') tool
			where tool ->> 'name' not in ('coding_run_command','coding_read_command','coding_cancel_command','coding_finish','coding_ask','make_picture','company_search')
				and not (v_is_surface and tool ->> 'name' in ('coding_record_change', 'coding_view_attachment'))
		) then
		raise exception 'Coding catalog must contain only coding tools' using errcode = '42501';
	end if;$new$
	]
);

select pg_temp.cict_patch(
	'public.qorpera_record_coding_context_view(jsonb,jsonb)'::regprocedure,
	array[
$old$	if exists (
		select 1 from jsonb_array_elements(p_view -> 'outputs') output
		where output ? 'capture'
			or (coalesce(v_authority #>> '{coding,workspaceKind}', 'git_repo') = 'git_repo'
				and output -> 'readId' is distinct from 'null'::jsonb)
	) then
		raise exception 'Coding context cannot introduce Company File reads' using errcode = '42501'; end if;$old$,
$new$	if exists (
		select 1 from jsonb_array_elements(p_view -> 'outputs') output
		where output ? 'capture'
	) then
		raise exception 'Coding context cannot introduce Company File reads' using errcode = '42501'; end if;$new$
	]
);

do $$ begin
	if exists (
		select 1 from pg_temp.cict_before as prior
		join pg_proc as patched on patched.oid = prior.oid
		where patched.prosecdef is distinct from prior.prosecdef
			or patched.proconfig is distinct from prior.proconfig
			or patched.provolatile is distinct from prior.provolatile
			or patched.proacl::text is distinct from prior.proacl::text
	) or (select count(*) from pg_temp.cict_before) <> 2 then
		raise exception '20260930912000: patched function attributes or grants drifted';
	end if;
end $$;
