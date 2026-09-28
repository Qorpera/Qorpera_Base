-- Company state files, F2-3: connections (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §2, §4).
--
-- Inert for today's companies: everything here runs only inside the folder core's commit, which only folder-v2
-- companies reach, and only an operator makes one (qorpera_folder_enable) until the reset (core C5).
--
-- connections/<name>.md describes one account the company's vault holds (qorpera_cloud_secrets): its settings (id,
-- service, account, status, actions, connected_by, connected_at) are the platform's, written by the vault (core C3,
-- "the vault writes connection files"); its body, what the account is for, is the company's. This slice adds the
-- parse's shape, the rules and the index; it never writes a vault row.
-- * Rules: only the platform creates the file or changes its settings; a member or an agent edits the body. The id is
--   a company-owned vault row of this company and environment, and one file holds one account. Only the platform
--   deletes the file, and only once the account is revoked (disconnecting removes it). A move within connections/
--   repoints the index (the kind rule refuses a move out). A file saved before this slice is not trusted until the
--   index points at it. Never reviewed.
-- * Index: qorpera_folder_connection_index, one row per account, keyed by the vault row's id, with the path, its
--   version and the body copy, and no foreign key to the company row (its KEY SHARE would come after the paths). It is
--   its own table, so a connection save never writes or locks a vault row and needs no lock target.
--
-- Builds on F2-2 (20260929100000) and replaces its hook functions (parse shape, checked parse, decide, apply,
-- verify) with the connection branches added.

-- 1. The connection index ----------------------------------------------------------------------------------------------

create table public.qorpera_folder_connection_index (
	secret_id uuid primary key,
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	-- No foreign key to qorpera_profiles: its KEY SHARE would come in apply, after the paths, where the company row
	-- must never be taken (doc §4). The rows go with the company through the environment's folder clock.
	profile_id uuid not null,
	folder_path text collate "C" not null,
	folder_path_version uuid not null,
	commit_id uuid not null,
	-- The body: what the account is for, as the company wrote it (may be empty).
	purpose text not null check (octet_length(purpose) <= 32768),
	retired_at timestamptz,
	updated_at timestamptz not null default clock_timestamp()
);
create index qorpera_folder_connection_index_path on public.qorpera_folder_connection_index(environment_id, folder_path collate "C");
alter table public.qorpera_folder_connection_index enable row level security;
revoke all on public.qorpera_folder_connection_index from public, anon, authenticated, service_role;
grant select on public.qorpera_folder_connection_index to service_role;

-- 2. The parse's shape, now for connections too --------------------------------------------------------------------

create or replace function public.qorpera_company_state_parse_problems(p_kind text, p_parse jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
	v_bad text[] := '{}'; v_named jsonb;
	c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
	if jsonb_typeof(p_parse) is distinct from 'object' or p_parse ->> 'kind' is distinct from p_kind then
		return jsonb_build_array(public.qorpera_company_state_problem('value', null, null, 'the parse does not match the file''s kind'));
	end if;
	if p_kind = 'vision' then
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from array['kind','name'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if not public.qorpera_company_state_one_line(p_parse -> 'name', 1, 120) then v_bad := array_append(v_bad, 'name'); end if;
	elsif p_kind = 'agent' then
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from
			array['agentKind','colour','effort','figure','id','instructions','kind','model','name','role','status'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if coalesce(p_parse ->> 'id', '') !~ c_uuid then v_bad := array_append(v_bad, 'id'); end if;
		if not public.qorpera_company_state_one_line(p_parse -> 'name', 1, 160) then v_bad := array_append(v_bad, 'name'); end if;
		if not public.qorpera_company_state_one_line(p_parse -> 'role', 1, 320) then v_bad := array_append(v_bad, 'role'); end if;
		if coalesce(p_parse ->> 'agentKind', '') not in ('co-founder','agent') then v_bad := array_append(v_bad, 'agentKind'); end if;
		if coalesce(p_parse ->> 'status', '') not in ('active','archived') then v_bad := array_append(v_bad, 'status'); end if;
		if jsonb_typeof(p_parse -> 'colour') <> 'null' and coalesce(p_parse ->> 'colour', '') not in
			('charcoal','brown','coral','orange','gold','green','teal','blue','purple','pink','gray') then v_bad := array_append(v_bad, 'colour'); end if;
		if jsonb_typeof(p_parse -> 'figure') <> 'null' and coalesce(p_parse ->> 'figure', '') not in
			('planet','acorn','flame','rocket','crown','heart','ghost') then v_bad := array_append(v_bad, 'figure'); end if;
		if jsonb_typeof(p_parse -> 'model') <> 'null' and coalesce(p_parse ->> 'model', '') not in
			('gpt-6-astra','gpt-6-sol','gpt-6-luna') then v_bad := array_append(v_bad, 'model'); end if;
		if jsonb_typeof(p_parse -> 'effort') <> 'null' and coalesce(p_parse ->> 'effort', '') not in ('low','medium','high') then
			v_bad := array_append(v_bad, 'effort'); end if;
		if jsonb_typeof(p_parse -> 'instructions') is distinct from 'string'
			or octet_length(p_parse ->> 'instructions') not between 1 and 32768
			or (p_parse ->> 'instructions') <> btrim(p_parse ->> 'instructions', E' \t\n\r')
			or (p_parse ->> 'instructions') ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' then
			v_bad := array_append(v_bad, 'instructions'); end if;
	elsif p_kind = 'group' then
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from
			array['agents','id','kind','name','people','purpose','subtitle'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if coalesce(p_parse ->> 'id', '') !~ c_uuid then v_bad := array_append(v_bad, 'id'); end if;
		if not public.qorpera_company_state_one_line(p_parse -> 'name', 1, 256) then v_bad := array_append(v_bad, 'name'); end if;
		if jsonb_typeof(p_parse -> 'subtitle') <> 'null' and not public.qorpera_company_state_one_line(p_parse -> 'subtitle', 0, 256) then
			v_bad := array_append(v_bad, 'subtitle'); end if;
		-- At least two agents, and no id twice in a list.
		if jsonb_typeof(p_parse -> 'agents') is distinct from 'array' or jsonb_array_length(p_parse -> 'agents') < 2
			or exists (select 1 from jsonb_array_elements(p_parse -> 'agents') a where jsonb_typeof(a) <> 'string' or (a #>> '{}') !~ c_uuid)
			or (select count(distinct a #>> '{}') from jsonb_array_elements(p_parse -> 'agents') a) <> jsonb_array_length(p_parse -> 'agents') then
			v_bad := array_append(v_bad, 'agents'); end if;
		if jsonb_typeof(p_parse -> 'people') is distinct from 'array'
			or exists (select 1 from jsonb_array_elements(p_parse -> 'people') a where jsonb_typeof(a) <> 'string' or (a #>> '{}') !~ c_uuid)
			or (select count(distinct a #>> '{}') from jsonb_array_elements(p_parse -> 'people') a) <> jsonb_array_length(p_parse -> 'people') then
			v_bad := array_append(v_bad, 'people'); end if;
		if jsonb_typeof(p_parse -> 'purpose') is distinct from 'string'
			or octet_length(p_parse ->> 'purpose') not between 1 and 32768
			or (p_parse ->> 'purpose') <> btrim(p_parse ->> 'purpose', E' \t\n\r') then
			v_bad := array_append(v_bad, 'purpose'); end if;
	elsif p_kind = 'sections' then
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from array['kind','sections'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if jsonb_typeof(p_parse -> 'sections') is distinct from 'array'
			or exists (select 1 from jsonb_array_elements(p_parse -> 'sections') s
				where jsonb_typeof(s) <> 'object'
					or (select array_agg(k order by k) from jsonb_object_keys(s) k) is distinct from array['line','members','name']
					or not public.qorpera_company_state_one_line(s -> 'name', 1, 60)
					or jsonb_typeof(s -> 'line') <> 'number' or (s ->> 'line') !~ '^[1-9][0-9]{0,8}$'
					or jsonb_typeof(s -> 'members') <> 'array'
					or exists (select 1 from jsonb_array_elements(s -> 'members') m
						where jsonb_typeof(m) <> 'object'
							or (select array_agg(k order by k) from jsonb_object_keys(m) k) is distinct from array['id','line']
							or jsonb_typeof(m -> 'id') <> 'string' or (m ->> 'id') !~ c_uuid
							or jsonb_typeof(m -> 'line') <> 'number' or (m ->> 'line') !~ '^[1-9][0-9]{0,8}$')) then
			v_bad := array_append(v_bad, 'sections');
		-- Names are unique ignoring case as the database compares them (lower(), the index's unique key), which can
		-- join two names the parser keeps apart; and an id is listed once in the whole file.
		else
			if (select count(distinct lower(s ->> 'name')) from jsonb_array_elements(p_parse -> 'sections') s)
					<> jsonb_array_length(p_parse -> 'sections') then
				v_named := public.qorpera_company_state_problem('value', null, null,
					'two sections have the same name when case is ignored; rename one');
			end if;
			if (select count(*) <> count(distinct m ->> 'id') from jsonb_array_elements(p_parse -> 'sections') s,
					jsonb_array_elements(s -> 'members') m) then
				v_bad := array_append(v_bad, 'sections');
			end if;
		end if;
	elsif p_kind = 'connection' then
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from
			array['account','actions','connectedAt','connectedBy','id','kind','purpose','service','status'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if coalesce(p_parse ->> 'id', '') !~ c_uuid then v_bad := array_append(v_bad, 'id'); end if;
		if jsonb_typeof(p_parse -> 'service') is distinct from 'string' or (p_parse ->> 'service') !~ '^[a-z][a-z0-9_-]{0,63}$' then
			v_bad := array_append(v_bad, 'service'); end if;
		if not public.qorpera_company_state_one_line(p_parse -> 'account', 1, 254) then v_bad := array_append(v_bad, 'account'); end if;
		if coalesce(p_parse ->> 'status', '') not in ('connected','broken') then v_bad := array_append(v_bad, 'status'); end if;
		if jsonb_typeof(p_parse -> 'actions') is distinct from 'array'
			or exists (select 1 from jsonb_array_elements(p_parse -> 'actions') a
				where jsonb_typeof(a) <> 'string' or (a #>> '{}') !~ '^[a-z][a-z0-9_]{0,63}$')
			or (select count(distinct a #>> '{}') from jsonb_array_elements(p_parse -> 'actions') a) <> jsonb_array_length(p_parse -> 'actions') then
			v_bad := array_append(v_bad, 'actions'); end if;
		if coalesce(p_parse ->> 'connectedBy', '') !~ c_uuid then v_bad := array_append(v_bad, 'connectedBy'); end if;
		-- The parser's canonical instant: seconds always, a fraction without trailing zeros, UTC.
		if jsonb_typeof(p_parse -> 'connectedAt') is distinct from 'string'
			or (p_parse ->> 'connectedAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{0,5}[1-9])?Z$' then
			v_bad := array_append(v_bad, 'connectedAt');
		else
			begin
				perform (p_parse ->> 'connectedAt')::timestamptz;
			exception when others then v_bad := array_append(v_bad, 'connectedAt');
			end;
		end if;
		if jsonb_typeof(p_parse -> 'purpose') is distinct from 'string' or octet_length(p_parse ->> 'purpose') > 32768
			or (p_parse ->> 'purpose') <> btrim(p_parse ->> 'purpose', E' \t\n\r') then
			v_bad := array_append(v_bad, 'purpose'); end if;
	end if;
	if cardinality(v_bad) = 0 and v_named is null then return '[]'::jsonb; end if;
	return case when v_named is null then '[]'::jsonb else jsonb_build_array(v_named) end
		|| case when cardinality(v_bad) = 0 then '[]'::jsonb else jsonb_build_array(public.qorpera_company_state_problem('value', null, null,
			'the platform read this file differently from its rules (' || array_to_string(v_bad, ', ') || ')')) end;
end $$;

create or replace function public.qorpera_company_state_checked(p_entry jsonb, p_path text, p_key text, p_file jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_kind text := public.qorpera_structured_path_kind(p_key); v_entry jsonb := p_entry; v_problems jsonb;
begin
	v_problems := public.qorpera_company_state_path_problems(p_path, false);
	if jsonb_array_length(v_problems) > 0 then return jsonb_build_object('ok', false, 'problems', v_problems); end if;
	if v_entry is null or v_entry ->> 'kind' is distinct from v_kind then
		return jsonb_build_object('ok', false, 'problems', jsonb_build_array(public.qorpera_company_state_problem('front_matter', null, null,
			'the platform could not read this file; save it again')));
	end if;
	if jsonb_typeof(v_entry -> 'problems') = 'array' then
		return jsonb_build_object('ok', false, 'problems', (select coalesce(jsonb_agg(p.value), '[]'::jsonb)
			from (select value from jsonb_array_elements(v_entry -> 'problems') limit 51) p));
	end if;
	if jsonb_typeof(v_entry -> 'text') is distinct from 'string' or jsonb_typeof(v_entry -> 'parserVersion') is distinct from 'number'
		or encode(extensions.digest(convert_to(v_entry ->> 'text', 'utf8'), 'sha256'), 'hex') is distinct from p_file ->> 'fileSha256' then
		return jsonb_build_object('ok', false, 'problems', jsonb_build_array(public.qorpera_company_state_problem('front_matter', null, null,
			'the text read does not match the saved file; save it again')));
	end if;
	if v_kind in ('vision','agent','group','sections','connection') then
		v_problems := public.qorpera_company_state_parse_problems(v_kind, v_entry -> 'parse');
		if jsonb_array_length(v_problems) > 0 then return jsonb_build_object('ok', false, 'problems', v_problems); end if;
	elsif jsonb_typeof(v_entry -> 'parse') is distinct from 'object' or v_entry -> 'parse' ->> 'kind' is distinct from v_kind then
		return jsonb_build_object('ok', false, 'problems', public.qorpera_company_state_parse_problems(v_kind, v_entry -> 'parse'));
	end if;
	return jsonb_build_object('ok', true, 'kind', v_kind, 'parse', v_entry -> 'parse', 'parserVersion', v_entry -> 'parserVersion');
end $$;

-- 3. The rules of a connection file -----------------------------------------------------------------------------------

-- One connections/<name>.md (§2): the id never changes and is a company-owned vault row of this company and
-- environment; only the platform (the vault's writer) creates the file or changes its settings, and then they match
-- the vault's row; a member or an agent changes the body only; one file holds one account.
create function public.qorpera_company_state_connection_rules(p_environment_id uuid, p_profile_id uuid, p_actor jsonb,
	p_key text, p_parse jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
	v_base jsonb := public.qorpera_company_state_base(p_environment_id, p_key); v_secret record; v_index record;
	v_problem text;
begin
	-- The saved version is trusted only when the index points at this path for its account: a file saved before this
	-- slice (F2-1 or F2-2 alone) was never checked, so a member could have written it.
	if v_base is not null and (jsonb_array_length(public.qorpera_company_state_parse_problems('connection', v_base)) > 0
		or not exists (select 1 from public.qorpera_folder_connection_index i
			where i.secret_id = (v_base ->> 'id')::uuid and i.environment_id = p_environment_id and i.retired_at is null
				and public.qorpera_folder_key(i.folder_path) = p_key)) then
		v_base := null; end if;
	select s.id, s.profile_id, s.environment_id, s.owner_kind, s.connector_id, s.status into v_secret
	from public.qorpera_cloud_secrets s where s.id = (p_parse ->> 'id')::uuid;
	if v_base is not null and v_base ->> 'id' is distinct from p_parse ->> 'id' then
		v_problem := 'id never changes; it is ' || (v_base ->> 'id');
	elsif v_secret.id is null or v_secret.profile_id is distinct from p_profile_id
		or v_secret.environment_id is distinct from p_environment_id or v_secret.owner_kind is distinct from 'company' then
		v_problem := 'no connected account of this company has the id ' || (p_parse ->> 'id');
	elsif p_actor ->> 'kind' is distinct from 'platform' and (v_base is null or (v_base - 'purpose') <> (p_parse - 'purpose')) then
		v_problem := 'the settings of a connection are the platform''s; change only the text below them';
	elsif p_actor ->> 'kind' = 'platform' and (v_secret.status <> 'active' or v_secret.connector_id <> p_parse ->> 'service') then
		v_problem := 'the settings must match the connected account';
	else
		select i.folder_path, i.retired_at into v_index from public.qorpera_folder_connection_index i where i.secret_id = v_secret.id;
		if found and v_index.retired_at is null and public.qorpera_folder_key(v_index.folder_path) <> p_key then
			v_problem := 'this account already has the file ' || left(v_index.folder_path, 100);
		end if;
	end if;
	if v_problem is null then return null; end if;
	return jsonb_build_object('ok', false, 'reason', 'structured_rule',
		'problems', jsonb_build_array(public.qorpera_company_state_problem('value', null, null, v_problem)));
end $$;

-- One connection file's index row. A second change set that wrote another file for the same account first makes this
-- one abort (its retry is refused by decide).
create function public.qorpera_company_state_index_connection(p_environment_id uuid, p_profile_id uuid, p_commit_id uuid,
	p_path text, p_version uuid, p_parse jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_count bigint;
begin
	insert into public.qorpera_folder_connection_index as i(secret_id, environment_id, profile_id, folder_path, folder_path_version,
		commit_id, purpose)
	values ((p_parse ->> 'id')::uuid, p_environment_id, p_profile_id, p_path, p_version, p_commit_id, p_parse ->> 'purpose')
	on conflict (secret_id) do update set folder_path = excluded.folder_path, folder_path_version = excluded.folder_path_version,
		commit_id = excluded.commit_id, purpose = excluded.purpose, retired_at = null, updated_at = clock_timestamp()
	where i.environment_id = excluded.environment_id
		and (i.retired_at is not null or public.qorpera_folder_key(i.folder_path) = public.qorpera_folder_key(excluded.folder_path));
	get diagnostics v_count = row_count;
	if v_count = 0 then raise exception 'A connection file was written by another change set' using errcode = '23505'; end if;
end $$;

-- 4. The hooks, with the connection branches ------------------------------------------------------------------------

create or replace function public.qorpera_folder_structured_decide(p_environment_id uuid, p_actor jsonb, p_commit_id uuid, p_unit_no integer,
	p_unit jsonb, p_eff_path text, p_eff_to text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_op text := p_unit ->> 'op'; v_profile uuid; v_key text; v_row public.qorpera_folder_entries%rowtype;
	v_file record; v_checked jsonb; v_rule jsonb; v_problems jsonb; v_cofounder_path text; v_content jsonb;
	v_entries jsonb; v_ids text[] := '{}'; v_cofounders integer := 0; v_groups text[] := '{}'; v_connections text[] := '{}';
begin
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id;
	v_key := public.qorpera_folder_key(p_eff_path);

	if v_op in ('delete','move') then
		if public.qorpera_company_state_seeded(v_key) then return jsonb_build_object('ok', false, 'reason', 'seeded'); end if;
		select s.folder_path into v_cofounder_path from public.qorpera_company_cofounders c
			join public.qorpera_profile_staff s on s.profile_id = c.profile_id and s.staff_agent_id = c.staff_agent_id
		where c.profile_id = v_profile and s.folder_environment_id = p_environment_id;
		-- The Co-Founder's agent.md and its folder are never deleted; the folder only moves within agents/ (the
		-- kind-change rule refuses anywhere else), and the file never moves alone.
		if v_cofounder_path is not null and v_op = 'delete'
			and (public.qorpera_folder_key(v_cofounder_path) = v_key
				or public.qorpera_folder_key(v_cofounder_path) like public.qorpera_folder_under(v_key)) then
			return jsonb_build_object('ok', false, 'reason', 'cofounder'); end if;
		select * into v_row from public.qorpera_folder_entries
		where environment_id = p_environment_id and key_sha256 = extensions.digest(v_key, 'sha256') and kind <> 'claim';
		-- An agent.md or group.md never goes alone: its folder is deleted or moved instead.
		if v_row.kind = 'file' and public.qorpera_structured_path_kind(v_key) in ('agent','group') then
			return jsonb_build_object('ok', false, 'reason', 'lone_structured_file'); end if;
		-- A connection's file goes only when the platform removes it after a disconnect.
		if v_op = 'delete' and v_row.kind = 'file' and public.qorpera_structured_path_kind(v_key) = 'connection'
			and (p_actor ->> 'kind' is distinct from 'platform'
				or exists (select 1 from public.qorpera_folder_connection_index i
					join public.qorpera_cloud_secrets s on s.id = i.secret_id
					where i.environment_id = p_environment_id and i.retired_at is null
						and public.qorpera_folder_key(i.folder_path) = v_key and s.status = 'active')) then
			return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
				public.qorpera_company_state_problem('value', null, null,
					'a connection''s file goes when its account is disconnected in Settings'))); end if;
		if v_op = 'move' then return public.qorpera_company_state_carried(p_environment_id, v_op, v_key, p_eff_to, v_row); end if;
		return jsonb_build_object('ok', true);
	end if;

	if v_op = 'copy' then
		select * into v_row from public.qorpera_folder_entries
		where environment_id = p_environment_id and key_sha256 = extensions.digest(v_key, 'sha256') and kind <> 'claim';
		return public.qorpera_company_state_carried(p_environment_id, v_op, v_key, p_eff_to, v_row);
	end if;

	if v_op = 'mkdir' then
		v_problems := public.qorpera_company_state_path_problems(p_eff_path, true);
		if jsonb_array_length(v_problems) > 0 then
			return jsonb_build_object('ok', false, 'reason', 'structured_invalid', 'problems', v_problems); end if;
		return jsonb_build_object('ok', true);
	end if;

	-- write or new_folder: the folders a new folder brings are checked by name; every structured file it writes
	-- is checked, then its database rules.
	if v_op = 'new_folder' then
		for v_content in select to_jsonb(c) from (select p_eff_path as path union all
			select s.path from public.qorpera_folder_spelled_contents(p_eff_path, p_unit -> 'contents') s where s.kind = 'folder') c loop
			v_problems := public.qorpera_company_state_path_problems(v_content ->> 'path', true);
			if jsonb_array_length(v_problems) > 0 then
				return jsonb_build_object('ok', false, 'reason', 'structured_invalid', 'problems', v_problems); end if;
		end loop;
	end if;
	v_entries := public.qorpera_company_state_entries(p_unit);
	for v_file in select * from public.qorpera_company_state_unit_files(p_unit, p_eff_path) loop
		if public.qorpera_structured_path_kind(v_file.key) is null then continue; end if;
		v_checked := public.qorpera_company_state_checked(v_entries -> v_file.key, v_file.path, v_file.key, v_file.file);
		if not (v_checked ->> 'ok')::boolean then
			return jsonb_build_object('ok', false, 'reason', 'structured_invalid', 'problems', v_checked -> 'problems'); end if;
		if v_checked ->> 'kind' = 'agent' then
			-- One id per agent, and one Co-Founder, within the unit too.
			if (v_checked -> 'parse' ->> 'id') = any (v_ids) or (v_checked -> 'parse' ->> 'agentKind' = 'co-founder' and v_cofounders > 0) then
				return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', null, null, 'two agent.md files in one change carry the same id or kind'))); end if;
			v_ids := array_append(v_ids, v_checked -> 'parse' ->> 'id');
			if v_checked -> 'parse' ->> 'agentKind' = 'co-founder' then v_cofounders := v_cofounders + 1; end if;
			v_rule := public.qorpera_company_state_agent_rules(p_environment_id, v_profile, p_actor, v_file.path, v_file.key,
				v_checked -> 'parse');
			if v_rule is not null then return v_rule; end if;
			-- An agent never takes a conversation's id: sections.md lists both kinds by id.
			if exists (select 1 from public.qorpera_company_rooms r where r.id = (v_checked -> 'parse' ->> 'id')::uuid) then
				return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', null, null, 'this id belongs to a conversation; give this agent a new id'))); end if;
		elsif v_checked ->> 'kind' = 'group' then
			-- One id per group chat within the unit too.
			if (v_checked -> 'parse' ->> 'id') = any (v_groups) then
				return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', null, null, 'two group.md files in one change carry the same id'))); end if;
			v_groups := array_append(v_groups, v_checked -> 'parse' ->> 'id');
			v_rule := public.qorpera_company_state_group_rules(p_environment_id, v_profile, p_actor, v_file.key, v_checked -> 'parse');
			if v_rule is not null then return v_rule; end if;
		elsif v_checked ->> 'kind' = 'sections' then
			v_rule := public.qorpera_company_state_sections_rules(p_environment_id, v_profile, v_file.key, v_checked -> 'parse');
			if v_rule is not null then return v_rule; end if;
		elsif v_checked ->> 'kind' = 'connection' then
			-- One file per connection within the unit too.
			if (v_checked -> 'parse' ->> 'id') = any (v_connections) then
				return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', null, null, 'two connection files in one change carry the same id'))); end if;
			v_connections := array_append(v_connections, v_checked -> 'parse' ->> 'id');
			v_rule := public.qorpera_company_state_connection_rules(p_environment_id, v_profile, p_actor, v_file.key, v_checked -> 'parse');
			if v_rule is not null then return v_rule; end if;
		end if;
	end loop;
	return jsonb_build_object('ok', true);
end $$;

create or replace function public.qorpera_folder_structured_apply(p_environment_id uuid, p_commit_id uuid, p_unit_no integer,
	p_unit jsonb, p_eff_path text, p_eff_to text)
returns void language plpgsql security definer set search_path = '' as $$
declare
	v_op text := p_unit ->> 'op'; v_profile uuid; v_user uuid; v_file record; v_kind text; v_entry jsonb; v_version uuid;
	v_key text; v_staff record; v_room record; v_connection record; v_new_path text; v_actor jsonb; v_entries jsonb;
begin
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id;
	select jsonb_build_object('kind', c.actor_kind, 'requesterUserId', c.requester_id) into v_actor
	from public.qorpera_folder_commits c where c.id = p_commit_id;
	v_user := public.qorpera_company_state_actor_user(v_profile, case v_actor ->> 'kind'
		when 'member' then jsonb_build_object('kind', 'member', 'userId', v_actor ->> 'requesterUserId') else v_actor end);

	if v_op in ('write','new_folder') then
		v_entries := public.qorpera_company_state_entries(p_unit);
		for v_file in select * from public.qorpera_company_state_unit_files(p_unit, p_eff_path) loop
			v_kind := public.qorpera_structured_path_kind(v_file.key);
			if v_kind is null then continue; end if;
			v_entry := v_entries -> v_file.key;
			update public.qorpera_folder_path_versions set structured = jsonb_build_object('kind', v_kind, 'parse', v_entry -> 'parse',
				'parserVersion', v_entry -> 'parserVersion')
			where commit_id = p_commit_id and unit_no = p_unit_no and key_sha256 = extensions.digest(v_file.key, 'sha256')
			returning version into v_version;
			if v_version is null then raise exception 'A structured file has no version in its commit' using errcode = 'XX000'; end if;
			if v_kind = 'vision' then
				insert into public.qorpera_folder_company_index(environment_id, profile_id, name, vision_path_version, vision_seeded, commit_id)
				values (p_environment_id, v_profile, v_entry -> 'parse' ->> 'name', v_version, v_actor ->> 'kind' = 'platform', p_commit_id)
				on conflict (environment_id) do update set name = excluded.name, vision_path_version = excluded.vision_path_version,
					vision_seeded = false, commit_id = excluded.commit_id, updated_at = clock_timestamp();
			elsif v_kind = 'agent' then
				perform public.qorpera_company_state_index_agent(p_environment_id, v_profile, p_commit_id, v_user, v_file.path,
					v_version, v_entry -> 'parse', v_actor);
			elsif v_kind = 'group' then
				perform public.qorpera_company_state_index_group(p_environment_id, v_profile, p_commit_id, v_user, v_file.path,
					v_version, v_entry -> 'parse');
			elsif v_kind = 'sections' then
				perform public.qorpera_company_state_index_sections(v_profile, v_user, v_entry -> 'parse');
			elsif v_kind = 'connection' then
				perform public.qorpera_company_state_index_connection(p_environment_id, v_profile, p_commit_id, v_file.path, v_version,
					v_entry -> 'parse');
			end if;
		end loop;
		return;
	end if;

	if v_op = 'move' then
		-- Moved structured files keep their parse on their new versions.
		update public.qorpera_folder_path_versions v set structured = p.structured
		from public.qorpera_folder_path_versions p
		where v.commit_id = p_commit_id and v.unit_no = p_unit_no and v.op = 'move_in' and v.prior_version = p.version
			and p.structured is not null;
		-- The roster and the group chats follow their folders: a rename keeps the id, and so the thread and history.
		v_key := public.qorpera_folder_key(p_eff_path);
		for v_staff in select s.staff_agent_id, s.folder_path from public.qorpera_profile_staff s
			where s.profile_id = v_profile and s.folder_environment_id = p_environment_id and s.folder_retired_at is null
				and s.deleted_at is null
				and (public.qorpera_folder_key(s.folder_path) = v_key
					or public.qorpera_folder_key(s.folder_path) like public.qorpera_folder_under(v_key))
		loop
			v_new_path := p_eff_to || substr(v_staff.folder_path, char_length(p_eff_path) + 1);
			select version into v_version from public.qorpera_folder_path_versions
			where commit_id = p_commit_id and unit_no = p_unit_no and op = 'move_in'
				and key_sha256 = extensions.digest(public.qorpera_folder_key(v_new_path), 'sha256');
			if v_version is null then raise exception 'A moved agent.md has no version in its commit' using errcode = 'XX000'; end if;
			update public.qorpera_profile_staff set folder_path = (select e.path from public.qorpera_folder_entries e
					where e.environment_id = p_environment_id
						and e.key_sha256 = extensions.digest(public.qorpera_folder_key(v_new_path), 'sha256')),
				folder_path_version = v_version, folder_commit_id = p_commit_id, version = version + 1,
				updated_at = greatest(clock_timestamp(), created_at), updated_by_user_id = v_user
			where profile_id = v_profile and staff_agent_id = v_staff.staff_agent_id;
		end loop;
		for v_room in select r.id, r.folder_path from public.qorpera_company_rooms r
			where r.folder_environment_id = p_environment_id and r.folder_path is not null and r.folder_retired_at is null
				and (public.qorpera_folder_key(r.folder_path) = v_key
					or public.qorpera_folder_key(r.folder_path) like public.qorpera_folder_under(v_key))
		loop
			v_new_path := p_eff_to || substr(v_room.folder_path, char_length(p_eff_path) + 1);
			select version into v_version from public.qorpera_folder_path_versions
			where commit_id = p_commit_id and unit_no = p_unit_no and op = 'move_in'
				and key_sha256 = extensions.digest(public.qorpera_folder_key(v_new_path), 'sha256');
			if v_version is null then raise exception 'A moved group.md has no version in its commit' using errcode = 'XX000'; end if;
			update public.qorpera_company_rooms set folder_path = (select e.path from public.qorpera_folder_entries e
					where e.environment_id = p_environment_id
						and e.key_sha256 = extensions.digest(public.qorpera_folder_key(v_new_path), 'sha256')),
				folder_path_version = v_version, folder_commit_id = p_commit_id, version = version + 1, updated_at = clock_timestamp()
			where id = v_room.id;
		end loop;
		-- Connection files follow their path; the vault row is never touched.
		for v_connection in select i.secret_id, i.folder_path from public.qorpera_folder_connection_index i
			where i.environment_id = p_environment_id and i.retired_at is null
				and (public.qorpera_folder_key(i.folder_path) = v_key
					or public.qorpera_folder_key(i.folder_path) like public.qorpera_folder_under(v_key))
		loop
			v_new_path := p_eff_to || substr(v_connection.folder_path, char_length(p_eff_path) + 1);
			select version into v_version from public.qorpera_folder_path_versions
			where commit_id = p_commit_id and unit_no = p_unit_no and op = 'move_in'
				and key_sha256 = extensions.digest(public.qorpera_folder_key(v_new_path), 'sha256');
			if v_version is null then raise exception 'A moved connection file has no version in its commit' using errcode = 'XX000'; end if;
			update public.qorpera_folder_connection_index set folder_path = (select e.path from public.qorpera_folder_entries e
					where e.environment_id = p_environment_id
						and e.key_sha256 = extensions.digest(public.qorpera_folder_key(v_new_path), 'sha256')),
				folder_path_version = v_version, commit_id = p_commit_id, updated_at = clock_timestamp()
			where secret_id = v_connection.secret_id;
		end loop;
		return;
	end if;

	if v_op = 'delete' then
		-- Deleting an agent's folder retires it: its runs are fenced (archived), its conversations stay, and a restore
		-- of the folder brings the row back.
		v_key := public.qorpera_folder_key(p_eff_path);
		for v_staff in select s.staff_agent_id, s.employment_status from public.qorpera_profile_staff s
			where s.profile_id = v_profile and s.folder_environment_id = p_environment_id and s.folder_retired_at is null
				and s.deleted_at is null
				and (public.qorpera_folder_key(s.folder_path) = v_key
					or public.qorpera_folder_key(s.folder_path) like public.qorpera_folder_under(v_key))
		loop
			update public.qorpera_profile_staff set folder_retired_at = clock_timestamp(), folder_commit_id = p_commit_id,
				version = version + 1, updated_at = greatest(clock_timestamp(), created_at), updated_by_user_id = v_user
			where profile_id = v_profile and staff_agent_id = v_staff.staff_agent_id;
			if v_staff.employment_status = 'active' then
				update public.qorpera_profile_staff set employment_status = 'archived'
				where profile_id = v_profile and staff_agent_id = v_staff.staff_agent_id;
			end if;
		end loop;
		-- Deleting a group chat's folder closes the chat; its conversation stays, and a restore reopens both.
		for v_room in select r.id, r.session_id from public.qorpera_company_rooms r
			where r.folder_environment_id = p_environment_id and r.folder_path is not null and r.folder_retired_at is null
				and (public.qorpera_folder_key(r.folder_path) = v_key
					or public.qorpera_folder_key(r.folder_path) like public.qorpera_folder_under(v_key))
		loop
			update public.qorpera_company_rooms set status = 'archived', folder_retired_at = clock_timestamp(),
				folder_commit_id = p_commit_id, version = version + 1, updated_at = clock_timestamp()
			where id = v_room.id;
			update public.qorpera_shared_sessions set status = 'closed', updated_at = statement_timestamp()
			where id = v_room.session_id and status <> 'closed';
		end loop;
		-- A connection's file removed (after its account was disconnected): its index row retires.
		update public.qorpera_folder_connection_index i set retired_at = clock_timestamp(), commit_id = p_commit_id, updated_at = clock_timestamp()
		where i.environment_id = p_environment_id and i.retired_at is null
			and (public.qorpera_folder_key(i.folder_path) = v_key
				or public.qorpera_folder_key(i.folder_path) like public.qorpera_folder_under(v_key));
	end if;
end $$;

create or replace function public.qorpera_folder_structured_verify(p_environment_id uuid, p_commit_id uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
	if exists (select 1 from public.qorpera_profile_staff s
		where s.folder_environment_id = p_environment_id and s.folder_commit_id = p_commit_id and s.folder_retired_at is null
			and s.deleted_at is null and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
				and e.key_sha256 = extensions.digest(public.qorpera_folder_key(s.folder_path), 'sha256')
				and e.version = s.folder_path_version and e.path = s.folder_path))
		or exists (select 1 from public.qorpera_company_rooms r
			where r.folder_environment_id = p_environment_id and r.folder_commit_id = p_commit_id and r.folder_retired_at is null
				and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.key_sha256 = extensions.digest(public.qorpera_folder_key(r.folder_path), 'sha256')
					and e.version = r.folder_path_version and e.path = r.folder_path))
		or exists (select 1 from public.qorpera_folder_connection_index c
			where c.environment_id = p_environment_id and c.commit_id = p_commit_id and c.retired_at is null
				and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.key_sha256 = extensions.digest(public.qorpera_folder_key(c.folder_path), 'sha256')
					and e.version = c.folder_path_version and e.path = c.folder_path))
		or exists (select 1 from public.qorpera_folder_company_index i
			where i.environment_id = p_environment_id and i.commit_id = p_commit_id
				and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.key_sha256 = extensions.digest('vision/vision.md', 'sha256') and e.version = i.vision_path_version)) then
		raise exception 'A structured index row does not point at its file''s current version' using errcode = 'XX000';
	end if;
end $$;

-- 5. Grants ------------------------------------------------------------------------------------------------------------

revoke all on function public.qorpera_company_state_connection_rules(uuid, uuid, jsonb, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_company_state_index_connection(uuid, uuid, uuid, text, uuid, jsonb) from public, anon, authenticated, service_role;
