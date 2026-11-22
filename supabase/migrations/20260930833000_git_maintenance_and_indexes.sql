set local lock_timeout = '3s';

create or replace function pg_temp.git_maint_patch(p_target regprocedure, p_edits text[]) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_found integer;
begin
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception '20260930833000 anchor found % time(s) in %, expected 1: %', v_found, p_target, left(p_edits[2 * i - 1], 80);
		end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

create or replace function public.qorpera_folder_git_object(p_key text)
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(p_key ~ ('^code/[^/]+/[^/]+/repo\.git/objects/('
		|| '[0-9a-f]{2}/[0-9a-f]{38}([0-9a-f]{24})?'
		|| '|pack/pack-[0-9a-f]{40}([0-9a-f]{24})?\.(pack|idx|rev|bitmap|mtimes|promisor)'
		|| '|info/commit-graph'
		|| '|info/commit-graphs/(commit-graph-chain|graph-[0-9a-f]{40}([0-9a-f]{24})?\.graph)'
		|| '|pack/multi-pack-index(-[0-9a-f]{40}([0-9a-f]{24})?\.bitmap)?'
		|| ')$'), false)
$$;

alter table public.qorpera_code_repositories
	alter column gc_enabled set default true,
	alter column retire_enabled set default true;

select pg_temp.git_maint_patch('public.qorpera_code_change_files(text,text,uuid,text,text,integer)'::regprocedure, array[
	$old$declare v_repository public.qorpera_code_repositories%rowtype; v_changes jsonb := '[]'::jsonb; v_index jsonb;$old$,
	$new$declare v_repository public.qorpera_code_repositories%rowtype; v_changes jsonb := '[]'::jsonb; v_index jsonb;
	v_has_more boolean := false; v_total integer := 0;$new$,
	$old$		or p_limit not between 1 and 20 then$old$,
	$new$		or p_limit not between 1 and 200 then$new$,
	$old$			order by change.n limit p_limit) due;
		if v_repository.index_written < v_repository.index_version then
			select jsonb_build_object('version', v_repository.index_version, 'lines', coalesce(jsonb_agg(jsonb_build_object($old$,
	$new$			order by change.n limit p_limit) due;
		select exists (select 1 from public.qorpera_code_changes change
			where change.environment_id = p_environment_id and change.owner = p_repository_owner and change.name = p_name
				and change.file_written < change.file_version
			order by change.n offset p_limit limit 1) into v_has_more;
		if v_repository.index_written < v_repository.index_version then
			select count(*)::integer into v_total from public.qorpera_code_changes change
			where change.environment_id = p_environment_id and change.owner = p_repository_owner and change.name = p_name;
			select jsonb_build_object('version', v_repository.index_version, 'total', v_total, 'lines', coalesce(jsonb_agg(jsonb_build_object($new$,
	$old$	return jsonb_build_object('schema', 'qorpera.code-change-files/v1', 'repository', jsonb_build_object(
		'companyId', v_repository.profile_id, 'environmentId', p_environment_id, 'owner', p_repository_owner, 'name', p_name),
		'changes', v_changes, 'index', v_index);$old$,
	$new$	return jsonb_build_object('schema', 'qorpera.code-change-files/v1', 'repository', jsonb_build_object(
		'companyId', v_repository.profile_id, 'environmentId', p_environment_id, 'owner', p_repository_owner, 'name', p_name),
		'changes', v_changes, 'index', v_index)
		|| case when v_has_more then '{"hasMore":true}'::jsonb else '{}'::jsonb end;$new$]);

select pg_temp.git_maint_patch('public.qorpera_code_change_files_written_valid(jsonb)'::regprocedure, array[
	$old$		and case when jsonb_typeof(p_written -> 'changes') = 'array' then jsonb_array_length(p_written -> 'changes') <= 50$old$,
	$new$		and case when jsonb_typeof(p_written -> 'changes') = 'array' then jsonb_array_length(p_written -> 'changes') <= 200$new$]);

create function public.qorpera_code_change_archive(p_owner text, p_machine_id_sha256 text, p_environment_id uuid,
	p_repository_owner text, p_name text, p_from integer, p_to integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_repository public.qorpera_code_repositories%rowtype; v_lines jsonb := '[]'::jsonb;
begin
	perform public.qorpera_code_executor_custody(p_owner, p_machine_id_sha256);
	if p_environment_id is null or p_repository_owner is null or p_name is null
		or p_from is null or p_to is null or p_from < 1 or p_to < p_from or (p_to - p_from) >= 250 then
		raise exception 'Code change archive request invalid' using errcode = '22023'; end if;
	select * into v_repository from public.qorpera_code_repositories
	where environment_id = p_environment_id and owner = p_repository_owner and name = p_name;
	if found and public.qorpera_code_care_holder(p_environment_id, p_owner, p_machine_id_sha256)
		and not exists (select 1 from public.qorpera_company_deletions deletion
			where deletion.profile_id = v_repository.profile_id) then
		select coalesce(jsonb_agg(jsonb_build_object(
			'n', line.n, 'createdAt', line.created_at, 'state', line.state, 'kind', line.kind,
			'line', coalesce(line.notice, line.title)) order by line.n asc), '[]'::jsonb) into v_lines
		from public.qorpera_code_changes line
		where line.environment_id = p_environment_id and line.owner = p_repository_owner and line.name = p_name
			and line.n between p_from and p_to;
	else
		v_repository := null;
	end if;
	return jsonb_build_object('schema', 'qorpera.code-change-archive/v1', 'repository', jsonb_build_object(
		'companyId', v_repository.profile_id, 'environmentId', p_environment_id, 'owner', p_repository_owner, 'name', p_name),
		'from', p_from, 'to', p_to, 'lines', v_lines);
end $$;

revoke all on function public.qorpera_folder_git_object(text),
	public.qorpera_code_change_archive(text, text, uuid, text, text, integer, integer)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_code_change_archive(text, text, uuid, text, text, integer, integer)
	to service_role;
comment on function public.qorpera_code_change_archive(text, text, uuid, text, text, integer, integer) is
	'Bounded slice of compact change-index lines (at most 250 rows) for writing immutable changes/archive rollups (20260930833000).';

do $guard$
begin
	if position('multi-pack-index' in pg_get_functiondef('public.qorpera_folder_git_object(text)'::regprocedure)) = 0 then
		raise exception '20260930833000 missing from qorpera_folder_git_object'; end if;
	if position('not between 1 and 200' in pg_get_functiondef('public.qorpera_code_change_files(text,text,uuid,text,text,integer)'::regprocedure)) = 0 then
		raise exception '20260930833000 missing from qorpera_code_change_files'; end if;
	if position('<= 200' in pg_get_functiondef('public.qorpera_code_change_files_written_valid(jsonb)'::regprocedure)) = 0 then
		raise exception '20260930833000 missing from qorpera_code_change_files_written_valid'; end if;
end $guard$;
