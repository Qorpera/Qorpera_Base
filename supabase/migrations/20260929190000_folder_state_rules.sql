-- Company state files, F2-4: rules (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §2, §4).
--
-- Inert for today's companies: everything here runs only inside the folder core's commit, which only folder-v2
-- companies reach, and only an operator makes one (qorpera_folder_enable) until the reset (core C5). The rules table
-- gains nullable columns that today's rows never set.
--
-- rules/<name>.md is one company review rule: its id (review records cite it), its outcome (ask-first, allow) and its
-- text (how "When an agent wants to ..." ends). The index is the reviewer's own table, qorpera_review_rules, company
-- scope, so the reviewer reads file rules with no change. Personal rules stay rows.
-- * Who writes: the core's company_rules resource scope (C1b-1) lets only owners and admins write rules/. A card's
--   "Always allow" writing the file is core C3's writer; until then that path still saves a row.
-- * Rules: the id never changes and belongs to this file's rule only; the company budget (48 KiB of rule text,
--   qorpera_review_rules_assert_room) holds after the save. It is checked in decide against the rules as they are, with
--   the unit's rule files counted by their new text, so two concurrent saves of different files can each pass it and
--   overshoot by at most one unit each: serializing them would take a company-wide lock. Never reviewed.
-- * Index: a new rule inserts a row (created_via 'folder'), an edit updates it, deleting the file archives it and a
--   restore brings it back; a move repoints it. The row's foreign key to the company row takes it KEY SHARE, so every
--   rule save takes the company row at rank 2 first, as the roster and group chats do.
-- * Settings refuses saving a company rule, and removing a rule that comes from a file, for folder-v2 companies: their
--   rules change as file edits. A company rule saved as a row (the card, until C3) can still be removed there.
--
-- Builds on F2-3 (20260929140000) and replaces the hook functions with the rule branches added.

-- 1. The rules table as the index of rules/ -------------------------------------------------------------------------

alter table public.qorpera_review_rules
	add column folder_environment_id uuid,
	add column folder_path text collate "C",
	add column folder_path_version uuid,
	add column folder_commit_id uuid,
	add constraint qorpera_review_rules_folder_complete check (
		(folder_path is null) = (folder_environment_id is null)
		and (folder_path is null) = (folder_path_version is null)
		and (folder_path is null) = (folder_commit_id is null)
		and (folder_path is null or (scope = 'company' and created_via = 'folder'))),
	drop constraint qorpera_review_rules_created_via_check,
	add constraint qorpera_review_rules_created_via_check check (created_via in ('settings', 'card', 'agent', 'folder'));
create index qorpera_review_rules_folder_path on public.qorpera_review_rules(folder_environment_id, folder_path collate "C")
	where folder_path is not null;

-- 2. The parse's shape, now for rules too --------------------------------------------------------------------------

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
	elsif p_kind = 'rule' then
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from array['id','kind','outcome','text'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if coalesce(p_parse ->> 'id', '') !~ c_uuid then v_bad := array_append(v_bad, 'id'); end if;
		if coalesce(p_parse ->> 'outcome', '') not in ('ask-first','allow') then v_bad := array_append(v_bad, 'outcome'); end if;
		-- One line of 1-280 characters, trimmed, no controls: the rule table's own check on when_text.
		if not public.qorpera_company_state_one_line(p_parse -> 'text', 1, 280) then v_bad := array_append(v_bad, 'text'); end if;
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
	if v_kind in ('vision','agent','group','sections','connection','rule') then
		v_problems := public.qorpera_company_state_parse_problems(v_kind, v_entry -> 'parse');
		if jsonb_array_length(v_problems) > 0 then return jsonb_build_object('ok', false, 'problems', v_problems); end if;
	elsif jsonb_typeof(v_entry -> 'parse') is distinct from 'object' or v_entry -> 'parse' ->> 'kind' is distinct from v_kind then
		return jsonb_build_object('ok', false, 'problems', public.qorpera_company_state_parse_problems(v_kind, v_entry -> 'parse'));
	end if;
	return jsonb_build_object('ok', true, 'kind', v_kind, 'parse', v_entry -> 'parse', 'parserVersion', v_entry -> 'parserVersion');
end $$;

-- 3. The rules of a rule file ----------------------------------------------------------------------------------------

-- One rules/<name>.md (§2): the id never changes and belongs to this file's rule only (never a personal rule, a row
-- saved outside the folder, another company's rule or another file's); the company's rule text stays within its budget.
-- A file saved before this slice is the saved version only when the index points at its path.
create function public.qorpera_company_state_rule_rules(p_environment_id uuid, p_profile_id uuid, p_key text, p_parse jsonb,
	p_unit_ids text[], p_unit_bytes bigint)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
	v_base jsonb := public.qorpera_company_state_base(p_environment_id, p_key); v_row public.qorpera_review_rules%rowtype;
	v_exists boolean; v_problem text; v_bytes bigint;
begin
	if v_base is not null and (jsonb_array_length(public.qorpera_company_state_parse_problems('rule', v_base)) > 0
		or not exists (select 1 from public.qorpera_review_rules r
			where r.id = (v_base ->> 'id')::uuid and r.folder_environment_id = p_environment_id
				and public.qorpera_folder_key(r.folder_path) = p_key)) then
		v_base := null; end if;
	select * into v_row from public.qorpera_review_rules where id = (p_parse ->> 'id')::uuid;
	v_exists := found;
	if v_base is not null and v_base ->> 'id' is distinct from p_parse ->> 'id' then
		v_problem := 'id never changes; it is ' || (v_base ->> 'id');
	elsif v_exists and (v_row.profile_id <> p_profile_id or v_row.folder_path is null
		or v_row.folder_environment_id is distinct from p_environment_id) then
		v_problem := 'this id belongs to another rule; give this rule a new id';
	elsif v_exists and v_row.archived_at is null and public.qorpera_folder_key(v_row.folder_path) <> p_key then
		v_problem := 'this id belongs to the rule at ' || left(v_row.folder_path, 100) || '; give this rule a new id';
	else
		-- The rules as they are, with the ones this unit writes (earlier files, and this one) counted by their new text.
		select coalesce(sum(octet_length(r.when_text)), 0) into v_bytes from public.qorpera_review_rules r
		where r.profile_id = p_profile_id and r.scope = 'company' and r.archived_at is null
			and not (r.id::text = any (p_unit_ids) or r.id = (p_parse ->> 'id')::uuid);
		if v_bytes + p_unit_bytes + octet_length(p_parse ->> 'text') > 49152 then
			v_problem := 'the company''s rules are too long to review an action (48 KiB); remove some first';
		end if;
	end if;
	if v_problem is null then return null; end if;
	return jsonb_build_object('ok', false, 'reason', 'structured_rule',
		'problems', jsonb_build_array(public.qorpera_company_state_problem('value', null, null, v_problem)));
end $$;

-- One rule file's row in the reviewer's table. A second change set that wrote another file with the same new id first
-- makes this one abort (its retry is refused by decide).
create function public.qorpera_company_state_index_rule(p_environment_id uuid, p_profile_id uuid, p_commit_id uuid,
	p_user uuid, p_path text, p_version uuid, p_parse jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_count bigint; v_outcome text := case p_parse ->> 'outcome' when 'allow' then 'allow_automatically' else 'ask_first' end;
begin
	insert into public.qorpera_review_rules as r(id, profile_id, scope, member_user_id, when_text, outcome, created_via,
		created_by_user_id, folder_environment_id, folder_path, folder_path_version, folder_commit_id)
	values ((p_parse ->> 'id')::uuid, p_profile_id, 'company', null, p_parse ->> 'text', v_outcome, 'folder', p_user,
		p_environment_id, p_path, p_version, p_commit_id)
	on conflict (id) do update set when_text = excluded.when_text, outcome = excluded.outcome, archived_at = null,
		folder_path = excluded.folder_path, folder_path_version = excluded.folder_path_version,
		folder_commit_id = excluded.folder_commit_id, updated_at = clock_timestamp()
	where r.profile_id = excluded.profile_id and r.folder_environment_id = excluded.folder_environment_id
		and (r.archived_at is not null or public.qorpera_folder_key(r.folder_path) = public.qorpera_folder_key(excluded.folder_path));
	get diagnostics v_count = row_count;
	if v_count = 0 then raise exception 'A rule id was taken by another change set' using errcode = '23505'; end if;
end $$;

-- 4. The hooks, with the rule branches ------------------------------------------------------------------------------

-- F2-2's targets, with a rule file's save taking the company row at rank 2 (its new row's foreign key would take it
-- after the paths).
create or replace function public.qorpera_folder_structured_targets(p_environment_id uuid, p_actor jsonb, p_units jsonb)
returns table(rank smallint, tbl text, key text, mode text) language plpgsql stable set search_path = '' as $$
declare
	v_profile uuid; v_unit jsonb; v_op text; v_key text; v_entry jsonb; v_staff record; v_room uuid;
	c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id;
	if v_profile is null then return; end if;
	for v_unit in select value from jsonb_array_elements(p_units) loop
		v_op := v_unit ->> 'op';
		if v_op in ('write','new_folder') then
			for v_entry in select e.value from jsonb_array_elements(case when jsonb_typeof(v_unit -> 'structured') = 'array'
					then v_unit -> 'structured' else '[]'::jsonb end) e
				where e.value ->> 'kind' = 'agent' and coalesce(e.value -> 'parse' ->> 'id', '') ~ c_uuid
			loop
				rank := 2; tbl := 'qorpera_profile_staff'; key := v_profile::text || ':' || (v_entry -> 'parse' ->> 'id'); mode := 'nokeyupdate';
				return next;
				rank := 2; tbl := 'qorpera_profiles'; key := v_profile::text; mode := 'keyshare';
				return next;
				select s.display_name, s.employment_status, s.folder_retired_at into v_staff from public.qorpera_profile_staff s
				where s.profile_id = v_profile and s.staff_agent_id = (v_entry -> 'parse' ->> 'id')::uuid;
				if found and (v_staff.display_name is distinct from v_entry -> 'parse' ->> 'name'
					or v_staff.employment_status is distinct from v_entry -> 'parse' ->> 'status' or v_staff.folder_retired_at is not null) then
					for v_room in select r.id from public.qorpera_company_rooms r
						where r.profile_id = v_profile and r.bound_staff_agent_id = (v_entry -> 'parse' ->> 'id')::uuid loop
						rank := 4; tbl := 'qorpera_company_rooms'; key := v_room::text; mode := 'update';
						return next;
					end loop;
				end if;
			end loop;
			for v_entry in select e.value from jsonb_array_elements(case when jsonb_typeof(v_unit -> 'structured') = 'array'
					then v_unit -> 'structured' else '[]'::jsonb end) e
				where e.value ->> 'kind' in ('group','sections','rule')
			loop
				rank := 2; tbl := 'qorpera_profiles'; key := v_profile::text; mode := 'keyshare';
				return next;
				if v_entry ->> 'kind' = 'group' and coalesce(v_entry -> 'parse' ->> 'id', '') ~ c_uuid then
					for v_room in select r.id from public.qorpera_company_rooms r
						where r.id = (v_entry -> 'parse' ->> 'id')::uuid and r.profile_id = v_profile and r.folder_path is not null loop
						rank := 4; tbl := 'qorpera_company_rooms'; key := v_room::text; mode := 'nokeyupdate';
						return next;
					end loop;
				end if;
			end loop;
		elsif v_op in ('delete','move') then
			v_key := public.qorpera_folder_key(case when v_op = 'move' then v_unit ->> 'from' else v_unit ->> 'path' end);
			if v_key like 'agents/%' then
				for v_staff in select s.staff_agent_id, s.employment_status from public.qorpera_profile_staff s
					where s.folder_environment_id = p_environment_id and s.folder_path is not null and s.deleted_at is null
						and (public.qorpera_folder_key(s.folder_path) = v_key
							or public.qorpera_folder_key(s.folder_path) like public.qorpera_folder_under(v_key))
				loop
					rank := 2; tbl := 'qorpera_profile_staff'; key := v_profile::text || ':' || v_staff.staff_agent_id::text; mode := 'nokeyupdate';
					return next;
					rank := 2; tbl := 'qorpera_profiles'; key := v_profile::text; mode := 'keyshare';
					return next;
					if v_op = 'delete' and v_staff.employment_status = 'active' then
						for v_room in select r.id from public.qorpera_company_rooms r
							where r.profile_id = v_profile and r.bound_staff_agent_id = v_staff.staff_agent_id loop
							rank := 4; tbl := 'qorpera_company_rooms'; key := v_room::text; mode := 'update';
							return next;
						end loop;
					end if;
				end loop;
				for v_room in select r.id from public.qorpera_company_rooms r
					where r.folder_environment_id = p_environment_id and r.folder_path is not null and r.folder_retired_at is null
						and (public.qorpera_folder_key(r.folder_path) = v_key
							or public.qorpera_folder_key(r.folder_path) like public.qorpera_folder_under(v_key))
				loop
					rank := 2; tbl := 'qorpera_profiles'; key := v_profile::text; mode := 'keyshare';
					return next;
					rank := 4; tbl := 'qorpera_company_rooms'; key := v_room::text; mode := 'nokeyupdate';
					return next;
				end loop;
			end if;
		end if;
	end loop;
end $$;

create or replace function public.qorpera_folder_structured_decide(p_environment_id uuid, p_actor jsonb, p_commit_id uuid, p_unit_no integer,
	p_unit jsonb, p_eff_path text, p_eff_to text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_op text := p_unit ->> 'op'; v_profile uuid; v_key text; v_row public.qorpera_folder_entries%rowtype;
	v_file record; v_checked jsonb; v_rule jsonb; v_problems jsonb; v_cofounder_path text; v_content jsonb;
	v_entries jsonb; v_ids text[] := '{}'; v_cofounders integer := 0; v_groups text[] := '{}'; v_connections text[] := '{}';
	v_rules text[] := '{}'; v_rule_bytes bigint := 0;
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
		elsif v_checked ->> 'kind' = 'rule' then
			-- One file per rule within the unit too.
			if (v_checked -> 'parse' ->> 'id') = any (v_rules) then
				return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', null, null, 'two rule files in one change carry the same id'))); end if;
			v_rule := public.qorpera_company_state_rule_rules(p_environment_id, v_profile, v_file.key, v_checked -> 'parse',
				v_rules, v_rule_bytes);
			if v_rule is not null then return v_rule; end if;
			v_rules := array_append(v_rules, v_checked -> 'parse' ->> 'id');
			v_rule_bytes := v_rule_bytes + octet_length(v_checked -> 'parse' ->> 'text');
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
			elsif v_kind = 'rule' then
				perform public.qorpera_company_state_index_rule(p_environment_id, v_profile, p_commit_id, v_user, v_file.path, v_version,
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
		-- Rule files follow their path; the rule keeps its id, so review records still cite it.
		for v_connection in select r.id, r.folder_path from public.qorpera_review_rules r
			where r.profile_id = v_profile and r.folder_environment_id = p_environment_id and r.archived_at is null
				and (public.qorpera_folder_key(r.folder_path) = v_key
					or public.qorpera_folder_key(r.folder_path) like public.qorpera_folder_under(v_key))
		loop
			v_new_path := p_eff_to || substr(v_connection.folder_path, char_length(p_eff_path) + 1);
			select version into v_version from public.qorpera_folder_path_versions
			where commit_id = p_commit_id and unit_no = p_unit_no and op = 'move_in'
				and key_sha256 = extensions.digest(public.qorpera_folder_key(v_new_path), 'sha256');
			if v_version is null then raise exception 'A moved rule file has no version in its commit' using errcode = 'XX000'; end if;
			update public.qorpera_review_rules set folder_path = (select e.path from public.qorpera_folder_entries e
					where e.environment_id = p_environment_id
						and e.key_sha256 = extensions.digest(public.qorpera_folder_key(v_new_path), 'sha256')),
				folder_path_version = v_version, folder_commit_id = p_commit_id, updated_at = clock_timestamp()
			where id = v_connection.id;
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
		-- A rule file removed: the rule is archived (review records keep citing it); a restore brings it back.
		update public.qorpera_review_rules r set archived_at = clock_timestamp(), folder_commit_id = p_commit_id, updated_at = clock_timestamp()
		where r.profile_id = v_profile and r.folder_environment_id = p_environment_id and r.archived_at is null
			and (public.qorpera_folder_key(r.folder_path) = v_key
				or public.qorpera_folder_key(r.folder_path) like public.qorpera_folder_under(v_key));
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
		or exists (select 1 from public.qorpera_review_rules r
			where r.folder_environment_id = p_environment_id and r.folder_commit_id = p_commit_id and r.archived_at is null
				and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.key_sha256 = extensions.digest(public.qorpera_folder_key(r.folder_path), 'sha256')
					and e.version = r.folder_path_version and e.path = r.folder_path))
		or exists (select 1 from public.qorpera_folder_company_index i
			where i.environment_id = p_environment_id and i.commit_id = p_commit_id
				and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.key_sha256 = extensions.digest('vision/vision.md', 'sha256') and e.version = i.vision_path_version)) then
		raise exception 'A structured index row does not point at its file''s current version' using errcode = 'XX000';
	end if;
end $$;

-- 5. The Settings RPCs on folder-v2 ------------------------------------------------------------------------------------

-- A folder-v2 company's rules live in rules/: saving a company rule through Settings refuses, and so does removing a rule
-- that comes from a file. A company rule saved as a row (a card's "Always allow" until core C3, or one from before the
-- company became folder-v2) can still be removed there. Personal rules stay rows.
do $$
declare v_definition text;
	v_old constant text := $old$	if p_scope = 'company' and not public.qorpera_can_authorize_profile(p_profile_id) then
		raise exception 'Only owners and admins write company rules' using errcode = '42501'; end if;$old$;
	v_new constant text := $new$	if p_scope = 'company' and not public.qorpera_can_authorize_profile(p_profile_id) then
		raise exception 'Only owners and admins write company rules' using errcode = '42501'; end if;
	if p_scope = 'company'
		and exists (select 1 from public.qorpera_company_files f where f.profile_id = p_profile_id and f.core = 'folder-v2') then
		raise exception 'This company keeps its rules in rules/; edit those files' using errcode = '55000'; end if;$new$;
begin
	v_definition := pg_get_functiondef('public.qorpera_save_review_rule(uuid,uuid,text,text,text)'::regprocedure);
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Rule save guard anchor differs'; end if;
	execute replace(v_definition, v_old, v_new);
end
$$;
do $$
declare v_definition text;
	v_old constant text := $old$		raise exception 'This rule cannot be removed here' using errcode = '42501'; end if;$old$;
	v_new constant text := $new$		raise exception 'This rule cannot be removed here' using errcode = '42501'; end if;
	if v_rule.folder_path is not null then
		raise exception 'This rule comes from a file in rules/; delete the file' using errcode = '55000'; end if;$new$;
begin
	v_definition := pg_get_functiondef('public.qorpera_archive_review_rule(uuid,uuid)'::regprocedure);
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Rule archive guard anchor differs'; end if;
	execute replace(v_definition, v_old, v_new);
end
$$;

-- 6. Grants ------------------------------------------------------------------------------------------------------------

revoke all on function public.qorpera_company_state_rule_rules(uuid, uuid, text, jsonb, text[], bigint) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_company_state_index_rule(uuid, uuid, uuid, uuid, text, uuid, jsonb) from public, anon, authenticated, service_role;
