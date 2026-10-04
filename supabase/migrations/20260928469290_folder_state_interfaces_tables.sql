-- Interfaces and tables on the folder core, P16a (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §8 "Plan (P16)";
-- RUNTIME-INTERFACES.md §6.1 and §7). Folder-v2 only.
--
-- 1. interfaces/order.md, interfaces/*/interface.toml, tables/*/table.toml and tables/*/rows.csv are structured by the
--    path's shape alone: every save carries the shared parser's parse (#751), checked by its shape (rule 1).
-- 2. The save check (rules 2-9): placement and the owners-only rule for every unit; one main interface per unit (no
--    lock: a rare double main is the price of no company-wide lock); a table's rows against its definition at commit,
--    its [write], definition changes, the claim rule and the areas table.
-- 3. qorpera_folder_table_index: one row per table folder, the lock a rows save and a definition change both take at
--    rank 5. Apply writes it, verify checks it.
-- 4. Coding sessions see interfaces/ and table definitions read-only; review classes for agents (§7); the recorder
--    takes save_interface; interfaces/, tables/ and the areas table are fixed paths.

create function pg_temp.p16_interfaces_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'P16 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- The table index (STATE-FILES §8 "Plan (P16)", "The index and the locks"): one row per table folder, the index of its
-- two files and the row both saves lock at rank 5, so a rows save and a definition change wait for each other. No
-- reader before I7.
create table public.qorpera_folder_table_index (
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	-- The table's id, from its table.toml; it never changes for a folder.
	id uuid not null,
	-- No foreign key to qorpera_profiles: its KEY SHARE would come in apply, after the paths (as the connection index).
	profile_id uuid not null,
	folder_path text collate "C" not null,
	folder_key text collate "C" not null,
	definition_version uuid not null,
	-- Null while the folder has no rows.csv.
	rows_version uuid,
	commit_id uuid not null,
	retired_at timestamptz,
	updated_at timestamptz not null default clock_timestamp(),
	primary key (environment_id, id)
);
-- Not unique, so apply's update of a row never needs more than its rank-5 lock.
create index qorpera_folder_table_index_key on public.qorpera_folder_table_index(environment_id, folder_key);
alter table public.qorpera_folder_table_index enable row level security;
revoke all on public.qorpera_folder_table_index from public, anon, authenticated, service_role;
grant select on public.qorpera_folder_table_index to service_role;
comment on table public.qorpera_folder_table_index is
	'P16: one row per table folder (tables/<t>/), the index of table.toml and rows.csv and the lock both saves take; '
	'rebuilt from the files.';

-- The table folder a key belongs to: tables/<t> and everything under it give tables/<t>.
create function public.qorpera_interface_table_folder(p_key text)
returns text language sql immutable parallel safe set search_path = '' as $$
	select substring(p_key from '^(tables/[^/]+)(/|$)')
$$;
revoke all on function public.qorpera_interface_table_folder(text) from public, anon, authenticated, service_role;

-- The interface folder a key belongs to: interfaces/<i> and everything under it give interfaces/<i>.
create function public.qorpera_interface_folder(p_key text)
returns text language sql immutable parallel safe set search_path = '' as $$
	select case when p_key <> 'interfaces/order.md' then substring(p_key from '^(interfaces/[^/]+)(/|$)') end
$$;
revoke all on function public.qorpera_interface_folder(text) from public, anon, authenticated, service_role;

-- The locks (rank 5): a table's row for every write of its table.toml (by the parse's id) or rows.csv (by its folder's
-- live row), a new folder holding them, and a delete or move at or above a table folder (never the seeded tables root).
create function public.qorpera_company_state_interface_targets(p_environment_id uuid, p_unit jsonb)
returns table(tbl text, key text, mode text) language plpgsql stable set search_path = '' as $$
declare v_op text := p_unit ->> 'op'; v_entry jsonb; v_key text; v_row record;
begin
	if v_op in ('write','new_folder') then
		for v_entry in select e.value from jsonb_array_elements(case when jsonb_typeof(p_unit -> 'structured') = 'array'
				then p_unit -> 'structured' else '[]'::jsonb end) e
			where e.value ->> 'kind' = 'table'
				and coalesce(e.value -> 'parse' ->> 'id', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
		loop
			tbl := 'qorpera_folder_table_index'; key := p_environment_id::text || ':' || (v_entry -> 'parse' ->> 'id');
			mode := 'nokeyupdate';
			return next;
		end loop;
	end if;
	foreach v_key in array array_remove(array[
		public.qorpera_folder_key(coalesce(case when v_op in ('move','copy') then p_unit ->> 'from' else p_unit ->> 'path' end, '')),
		case when v_op in ('move','copy') then public.qorpera_folder_key(p_unit ->> 'to') end], null)
	loop
		if v_key = 'tables' then continue; end if;
		for v_row in select i.id from public.qorpera_folder_table_index i
			where i.environment_id = p_environment_id and i.retired_at is null
				and ((v_op in ('write','new_folder') and public.qorpera_structured_path_kind(v_key) in ('table','table-rows')
						and i.folder_key = public.qorpera_interface_table_folder(v_key))
					or (v_op in ('delete','move') and (i.folder_key = v_key or i.folder_key like public.qorpera_folder_under(v_key))
						and v_key = public.qorpera_folder_key(coalesce(p_unit ->> 'from', p_unit ->> 'path'))))
		loop
			tbl := 'qorpera_folder_table_index'; key := p_environment_id::text || ':' || v_row.id; mode := 'nokeyupdate';
			return next;
		end loop;
	end loop;
end $$;
revoke all on function public.qorpera_company_state_interface_targets(uuid, jsonb) from public, anon, authenticated, service_role;

select pg_temp.p16_interfaces_replace('public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)'::regprocedure,
	$old$	v_member uuid; v_h2 record; v_f2 record;$old$,
	$new$	v_member uuid; v_h2 record; v_f2 record; v_p16 record;$new$);
select pg_temp.p16_interfaces_replace('public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)'::regprocedure,
	$old$		if v_op in ('write','new_folder') then
			for v_entry in select e.value from jsonb_array_elements(case when jsonb_typeof(v_unit -> 'structured') = 'array'
					then v_unit -> 'structured' else '[]'::jsonb end) e
				where e.value ->> 'kind' = 'agent'$old$,
	$new$		-- 20260930016000 (P16): the table rows and the company index row a unit writes or relies on, at rank 5.
		for v_p16 in select * from public.qorpera_company_state_interface_targets(p_environment_id, v_unit) loop
			rank := 5; tbl := v_p16.tbl; key := v_p16.key; mode := v_p16.mode;
			return next;
		end loop;
		if v_op in ('write','new_folder') then
			for v_entry in select e.value from jsonb_array_elements(case when jsonb_typeof(v_unit -> 'structured') = 'array'
					then v_unit -> 'structured' else '[]'::jsonb end) e
				where e.value ->> 'kind' = 'agent'$new$);

select pg_temp.p16_interfaces_replace('public.qorpera_folder_structured_lock(uuid,jsonb,smallint,smallint)'::regprocedure,
	$old$			'qorpera_folder_human_task_index',
			'qorpera_folder_contact_index'], t ->> 'tbl'), lower(t ->> 'key') collate "C"$old$,
	$new$			'qorpera_folder_human_task_index',
			'qorpera_folder_contact_index',
			'qorpera_folder_table_index' /* 20260930016000 (P16) */], t ->> 'tbl'),
			lower(t ->> 'key') collate "C"$new$);
select pg_temp.p16_interfaces_replace('public.qorpera_folder_structured_lock(uuid,jsonb,smallint,smallint)'::regprocedure,
	$old$		else
			raise exception 'Folder lock target table % is unknown', v_target.tbl using errcode = 'XX000';$old$,
	$new$		elsif v_target.tbl = 'qorpera_folder_table_index' then
			-- key: 'environment_id:id' (20260930016000, P16).
			execute 'select 1 from public.qorpera_folder_table_index where environment_id = $1 and id = $2' || v_clause
			using split_part(v_target.key, ':', 1)::uuid, split_part(v_target.key, ':', 2)::uuid;
		else
			raise exception 'Folder lock target table % is unknown', v_target.tbl using errcode = 'XX000';$new$);

-- The interface.toml files whose stored parse is main, by key (rule 3 reads them at commit).
create function public.qorpera_interface_mains(p_environment_id uuid)
returns table(key text, path text) language sql stable set search_path = '' as $$
	select e.key_text, e.path from public.qorpera_folder_entries e
		join public.qorpera_folder_path_versions v on v.version = e.version
	where e.environment_id = p_environment_id and e.kind = 'file' and e.key_text like 'interfaces/%/interface.toml'
		and v.structured ->> 'kind' = 'interface' and v.structured -> 'parse' -> 'main' = 'true'::jsonb
$$;
revoke all on function public.qorpera_interface_mains(uuid) from public, anon, authenticated, service_role;


-- 1. The four kinds, by the path's shape alone (RUNTIME-INTERFACES.md §6.1 "The kind comes from the path's shape").
select pg_temp.p16_interfaces_replace('public.qorpera_structured_path_kind(text)'::regprocedure,
	$old$when p_key ~ '^contacts/[^/]*\.md$' then 'contact'$old$,
	$new$when p_key ~ '^contacts/[^/]*\.md$' then 'contact'
		-- 20260930016000 (P16): interfaces and tables.
		when p_key = 'interfaces/order.md' then 'interface-order'
		when p_key ~ '^interfaces/[^/]+/interface\.toml$' then 'interface'
		when p_key ~ '^tables/[^/]+/table\.toml$' then 'table'
		when p_key ~ '^tables/[^/]+/rows\.csv$' then 'table-rows'$new$);

-- The two roots are places; an interface's and a table's folder are named (§6.1 rule 2, "Names").
select pg_temp.p16_interfaces_replace('public.qorpera_structured_folder_names(text)'::regprocedure,
	$old$when p_key in ('contacts', 'human-tasks') then array[]::text[]$old$,
	$new$when p_key in ('contacts', 'human-tasks') then array[]::text[]
		-- 20260930016000 (P16): interfaces and tables.
		when p_key in ('interfaces', 'tables') then array[]::text[]
		when p_key ~ '^interfaces/[^/]+$' then array['2:an interface''s folder']
		when p_key ~ '^tables/[^/]+$' then array['2:a table''s folder']$new$);

-- The folder's name in a file's path; the file's own name is fixed by the kind, so no .md rule applies.
select pg_temp.p16_interfaces_replace('public.qorpera_company_state_path_problems(text,boolean)'::regprocedure,
	$old$elsif v_kind in ('agent','routine','todo','worker-brief','worker-results') then$old$,
	$new$elsif v_kind in ('interface','table','table-rows') then -- 20260930016000 (P16)
			v_named := jsonb_build_array(jsonb_build_array(v_written[2],
				case when v_kind = 'interface' then 'an interface''s folder' else 'a table''s folder' end));
		elsif v_kind in ('agent','routine','todo','worker-brief','worker-results') then$new$);
select pg_temp.p16_interfaces_replace('public.qorpera_company_state_path_problems(text,boolean)'::regprocedure,
	$old$if not p_folder and v_kind not in ('vision','sections') and v_written[array_length(v_written, 1)] !~ '\.md$' then$old$,
	$new$if not p_folder and v_kind not in ('vision','sections','interface','interface-order','table','table-rows') -- 20260930016000 (P16)
		and v_written[array_length(v_written, 1)] !~ '\.md$' then$new$);

-- The parse of the four kinds is checked by its shape.
select pg_temp.p16_interfaces_replace('public.qorpera_company_state_checked(jsonb,text,text,jsonb)'::regprocedure,
	$old$if v_kind in ('vision','agent','group','sections','connection','rule','todo','routine','human-task','contact',
		'worker-brief','worker-results') then$old$,
	$new$if v_kind in ('vision','agent','group','sections','connection','rule','todo','routine','human-task','contact',
		'worker-brief','worker-results',
		'interface','interface-order','table','table-rows' /* 20260930016000 (P16) */) then$new$);

-- One line of text as the interface parser reads it (`Reader.text`): a JSON string of p_min to p_max characters, with
-- no control, line-separator or direction character. Unlike the state files, spaces at its ends are kept.
create function public.qorpera_interface_text(p_value jsonb, p_min integer, p_max integer)
returns boolean language sql immutable set search_path = '' as $$
	select jsonb_typeof(p_value) = 'string' and char_length(p_value #>> '{}') between p_min and p_max
		and (p_value #>> '{}') !~ '[\x01-\x1f\x7f-\x9f  ‪-‮⁦-⁩]'
$$;
revoke all on function public.qorpera_interface_text(jsonb, integer, integer) from public, anon, authenticated, service_role;

-- A list of 1 to p_max lowercase uuids, each once, by the strict pattern every uuid in the four parses follows
-- (`UUID_PATTERN`, RUNTIME-INTERFACES.md §6.1 rule 6).
create function public.qorpera_interface_ids(p_value jsonb, p_max integer)
returns boolean language sql immutable set search_path = '' as $$
	select jsonb_typeof(p_value) = 'array' and jsonb_array_length(p_value) between 1 and p_max
		and not exists (select 1 from jsonb_array_elements(p_value) x
			where jsonb_typeof(x) <> 'string' or (x #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
		and (select count(distinct x) from jsonb_array_elements(p_value) x) = jsonb_array_length(p_value)
$$;
revoke all on function public.qorpera_interface_ids(jsonb, integer) from public, anon, authenticated, service_role;

select pg_temp.p16_interfaces_replace('public.qorpera_company_state_parse_problems(text,jsonb)'::regprocedure,
	$old$	if cardinality(v_bad) = 0 and v_named is null then return '[]'::jsonb; end if;
	return case$old$,
	$new$	-- 20260930016000 (P16): interfaces and tables (RUNTIME-INTERFACES.md §6.1 rule 1). The table, its rows and the
	-- order in full; an interface by the fields the database reads (rule 3, rule 4 and review), the rest by JSON type
	-- and size (STATE-FILES §8 "Plan (P16)": readers parse the text themselves and never trust the stored parse).
	if p_kind = 'table' then
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from
			array['about','columns','holder','id','key','kind','name','rows','time','write'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if jsonb_typeof(p_parse -> 'id') is distinct from 'string' or not public.qorpera_interface_ids(jsonb_build_array(p_parse -> 'id'), 1) then
			v_bad := array_append(v_bad, 'id'); end if;
		if not public.qorpera_interface_text(p_parse -> 'name', 1, 60) then v_bad := array_append(v_bad, 'name'); end if;
		if jsonb_typeof(p_parse -> 'about') is distinct from 'null' and not public.qorpera_interface_text(p_parse -> 'about', 0, 280) then
			v_bad := array_append(v_bad, 'about'); end if;
		if p_parse -> 'rows' is distinct from '"file"'::jsonb then v_bad := array_append(v_bad, 'rows'); end if;
		-- 1 to 40 columns, each named once, its keys by its type (the parser's defaults are written out).
		if jsonb_typeof(p_parse -> 'columns') is distinct from 'array' or jsonb_array_length(p_parse -> 'columns') not between 1 and 40
			or exists (select 1 from jsonb_array_elements(p_parse -> 'columns') c
				where jsonb_typeof(c) <> 'object'
					or (select array_agg(k order by k) from jsonb_object_keys(c) k) is distinct from
						array['choices','currency','max','name','needsYes','optional','to','type']
					or jsonb_typeof(c -> 'name') <> 'string' or char_length(c ->> 'name') > 40 or (c ->> 'name') !~ '^[a-z][a-z0-9_]*$'
					or coalesce(c ->> 'type', '') not in ('text','number','money','percent','time','date','choice','yes-no','member',
						'agent','agents','id','link')
					or jsonb_typeof(c -> 'optional') <> 'boolean' or jsonb_typeof(c -> 'needsYes') <> 'boolean'
					or (c -> 'needsYes' = 'true'::jsonb and c ->> 'type' is distinct from 'member')
					-- (A CASE, so the cast runs only on what the pattern let through.)
					or case when c ->> 'type' is distinct from 'text' then jsonb_typeof(c -> 'max') <> 'null'
						when jsonb_typeof(c -> 'max') = 'number' and (c ->> 'max') ~ '^[1-9][0-9]{0,3}$' then (c ->> 'max')::integer > 4000
						else true end
					or jsonb_typeof(c -> 'choices') <> 'array'
					or case when c ->> 'type' = 'choice' then jsonb_array_length(c -> 'choices') not between 1 and 50
							or exists (select 1 from jsonb_array_elements(c -> 'choices') x
								where not public.qorpera_interface_text(x, 1, 60) or (x #>> '{}') ~ '[,"]')
							or (select count(distinct x) from jsonb_array_elements(c -> 'choices') x) <> jsonb_array_length(c -> 'choices')
						else jsonb_array_length(c -> 'choices') <> 0 end
					or case when c ->> 'type' = 'money' then coalesce(c ->> 'currency', '') !~ '^[A-Z]{3}$' or jsonb_typeof(c -> 'currency') <> 'string'
						else jsonb_typeof(c -> 'currency') <> 'null' end
					or case when c ->> 'type' = 'link' then not public.qorpera_interface_text(c -> 'to', 1, 70)
							or not ((c ->> 'to') in ('todos','contacts','human_tasks')
								or ((c ->> 'to') ~ '^table:[a-z0-9]+(-[a-z0-9]+)*$' and char_length(c ->> 'to') <= 70))
						else jsonb_typeof(c -> 'to') <> 'null' end)
			or (select count(distinct c ->> 'name') from jsonb_array_elements(p_parse -> 'columns') c)
				<> jsonb_array_length(p_parse -> 'columns') then
			v_bad := array_append(v_bad, 'columns'); end if;
		-- The key: 1 to 3 columns, each once, never optional and never a number (1.10 and 1.1 key alike in JS only).
		if jsonb_typeof(p_parse -> 'key') is distinct from 'array' or jsonb_array_length(p_parse -> 'key') not between 1 and 3
			or exists (select 1 from jsonb_array_elements(p_parse -> 'key') k
				where jsonb_typeof(k) <> 'string' or not exists (select 1 from jsonb_array_elements(
					case when jsonb_typeof(p_parse -> 'columns') = 'array' then p_parse -> 'columns' else '[]'::jsonb end) c
					where jsonb_typeof(c) = 'object' and c ->> 'name' = k #>> '{}' and c -> 'optional' = 'false'::jsonb
						and c ->> 'type' not in ('number','money','percent')))
			or (select count(distinct k) from jsonb_array_elements(p_parse -> 'key') k) <> jsonb_array_length(p_parse -> 'key') then
			v_bad := array_append(v_bad, 'key'); end if;
		if jsonb_typeof(p_parse -> 'holder') is distinct from 'null' and (jsonb_typeof(p_parse -> 'holder') is distinct from 'string'
			or not exists (select 1 from jsonb_array_elements(
				case when jsonb_typeof(p_parse -> 'columns') = 'array' then p_parse -> 'columns' else '[]'::jsonb end) c
				where jsonb_typeof(c) = 'object' and c ->> 'name' = p_parse ->> 'holder' and c -> 'needsYes' = 'true'::jsonb)) then
			v_bad := array_append(v_bad, 'holder'); end if;
		if jsonb_typeof(p_parse -> 'time') is distinct from 'null' and (jsonb_typeof(p_parse -> 'time') is distinct from 'string'
			or not exists (select 1 from jsonb_array_elements(
				case when jsonb_typeof(p_parse -> 'columns') = 'array' then p_parse -> 'columns' else '[]'::jsonb end) c
				where jsonb_typeof(c) = 'object' and c ->> 'name' = p_parse ->> 'time' and c ->> 'type' in ('time','date'))) then
			v_bad := array_append(v_bad, 'time'); end if;
		if jsonb_typeof(p_parse -> 'write') is distinct from 'object'
			or (select array_agg(k order by k) from jsonb_object_keys(p_parse -> 'write') k) is distinct from array['agents','members']
			or not (p_parse -> 'write' -> 'agents' in ('"all"'::jsonb, '"none"'::jsonb)
				or public.qorpera_interface_ids(p_parse -> 'write' -> 'agents', 100))
			or coalesce(p_parse -> 'write' ->> 'members', '') not in ('all','owners','none')
			or jsonb_typeof(p_parse -> 'write' -> 'members') is distinct from 'string' then
			v_bad := array_append(v_bad, 'write'); end if;
	elsif p_kind = 'table-rows' then
		-- The header and each row's raw fields, before any definition: what they mean is decided against the table's
		-- definition at commit (§6.1 rule 6). Within the file's 64 KiB.
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from array['header','kind','rows'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if jsonb_typeof(p_parse -> 'header') is distinct from 'array' or jsonb_array_length(p_parse -> 'header') not between 1 and 40
			or exists (select 1 from jsonb_array_elements(p_parse -> 'header') h
				where jsonb_typeof(h) <> 'string' or (h #>> '{}') !~ '^[a-z][a-z0-9_]{0,39}$')
			or (select count(distinct h) from jsonb_array_elements(p_parse -> 'header') h) <> jsonb_array_length(p_parse -> 'header') then
			v_bad := array_append(v_bad, 'header'); end if;
		if jsonb_typeof(p_parse -> 'rows') is distinct from 'array' or jsonb_array_length(p_parse -> 'rows') > 32768
			or exists (select 1 from jsonb_array_elements(p_parse -> 'rows') with ordinality r(value, n)
				where jsonb_typeof(r.value) <> 'object'
					or (select array_agg(k order by k) from jsonb_object_keys(r.value) k) is distinct from array['fields','line']
					or case when jsonb_typeof(r.value -> 'line') = 'number' and (r.value ->> 'line') ~ '^[1-9][0-9]{0,5}$'
						then (r.value ->> 'line')::integer < 2 else true end
					or jsonb_typeof(r.value -> 'fields') <> 'array'
					or jsonb_array_length(r.value -> 'fields') is distinct from jsonb_array_length(p_parse -> 'header')
					or exists (select 1 from jsonb_array_elements(r.value -> 'fields') f where jsonb_typeof(f) <> 'string'))
			-- Lines go up, one row per line.
			or exists (select 1 from (select (r.value ->> 'line')::integer - lag((r.value ->> 'line')::integer) over (order by r.n) as step
				from jsonb_array_elements(p_parse -> 'rows') with ordinality r(value, n)
				where jsonb_typeof(r.value) = 'object' and (r.value ->> 'line') ~ '^[1-9][0-9]{0,5}$') s where s.step <= 0)
			or (select coalesce(sum(octet_length(f #>> '{}')), 0) from jsonb_array_elements(p_parse -> 'rows') r,
				jsonb_array_elements(case when jsonb_typeof(r -> 'fields') = 'array' then r -> 'fields' else '[]'::jsonb end) f) > 65536 then
			v_bad := array_append(v_bad, 'rows'); end if;
	elsif p_kind = 'interface-order' then
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from array['ids','kind'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		-- (512 is above the about 420 lines the parser's 16 KiB allows.)
		if not (p_parse -> 'ids' = '[]'::jsonb or public.qorpera_interface_ids(p_parse -> 'ids', 512)) then
			v_bad := array_append(v_bad, 'ids'); end if;
	elsif p_kind = 'interface' then
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from
			array['about','access','badge','buttons','colour','emblem','id','kind','main','name','needs','status','template','views'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if jsonb_typeof(p_parse -> 'id') is distinct from 'string' or not public.qorpera_interface_ids(jsonb_build_array(p_parse -> 'id'), 1) then
			v_bad := array_append(v_bad, 'id'); end if;
		if not public.qorpera_interface_text(p_parse -> 'name', 1, 60) then v_bad := array_append(v_bad, 'name'); end if;
		if jsonb_typeof(p_parse -> 'about') is distinct from 'null' and not public.qorpera_interface_text(p_parse -> 'about', 0, 280) then
			v_bad := array_append(v_bad, 'about'); end if;
		if jsonb_typeof(p_parse -> 'main') is distinct from 'boolean' then v_bad := array_append(v_bad, 'main'); end if;
		if coalesce(p_parse ->> 'status', '') not in ('active','off') then v_bad := array_append(v_bad, 'status'); end if;
		if jsonb_typeof(p_parse -> 'emblem') is distinct from 'null' and coalesce(p_parse ->> 'emblem', '') not in
			('pulse','mail','members','coin','board','queue','calendar','hire','chart','page') then v_bad := array_append(v_bad, 'emblem'); end if;
		if jsonb_typeof(p_parse -> 'colour') is distinct from 'null' and coalesce(p_parse ->> 'colour', '') not in
			('charcoal','brown','coral','orange','gold','green','teal','blue','purple','pink','gray') then v_bad := array_append(v_bad, 'colour'); end if;
		-- Who sees it and who edits it.
		if jsonb_typeof(p_parse -> 'access') is distinct from 'object'
			or (select array_agg(k order by k) from jsonb_object_keys(p_parse -> 'access') k) is distinct from array['agents','edit','members']
			or not (p_parse -> 'access' -> 'members' in ('"all"'::jsonb, '"owners"'::jsonb)
				or public.qorpera_interface_ids(p_parse -> 'access' -> 'members', 100))
			or not (p_parse -> 'access' -> 'agents' = '"all"'::jsonb or public.qorpera_interface_ids(p_parse -> 'access' -> 'agents', 100))
			or jsonb_typeof(p_parse -> 'access' -> 'edit') is distinct from 'string'
			or coalesce(p_parse -> 'access' ->> 'edit', '') not in ('anyone','owners') then
			v_bad := array_append(v_bad, 'access'); end if;
		-- What review reads (§7): the buttons, and each block's list of buttons. The rest by JSON type and size.
		if jsonb_typeof(p_parse -> 'views') is distinct from 'array' or jsonb_array_length(p_parse -> 'views') not between 1 and 8
			or exists (select 1 from jsonb_array_elements(p_parse -> 'views') v
				where jsonb_typeof(v) <> 'object' or jsonb_typeof(v -> 'blocks') is distinct from 'array'
					or jsonb_array_length(v -> 'blocks') > 24
					or exists (select 1 from jsonb_array_elements(v -> 'blocks') b
						where jsonb_typeof(b) <> 'object' or jsonb_typeof(b -> 'buttons') is distinct from 'array'
							or exists (select 1 from jsonb_array_elements(b -> 'buttons') n where jsonb_typeof(n) <> 'string'))) then
			v_bad := array_append(v_bad, 'views'); end if;
		if jsonb_typeof(p_parse -> 'buttons') is distinct from 'array' or jsonb_array_length(p_parse -> 'buttons') > 32
			or exists (select 1 from jsonb_array_elements(p_parse -> 'buttons') b
				where jsonb_typeof(b) <> 'object' or jsonb_typeof(b -> 'id') is distinct from 'string') then
			v_bad := array_append(v_bad, 'buttons'); end if;
		if jsonb_typeof(p_parse -> 'needs') is distinct from 'array' or jsonb_array_length(p_parse -> 'needs') > 8
			or exists (select 1 from jsonb_array_elements(p_parse -> 'needs') n where jsonb_typeof(n) <> 'string') then
			v_bad := array_append(v_bad, 'needs'); end if;
		if jsonb_typeof(p_parse -> 'badge') not in ('null','object') then v_bad := array_append(v_bad, 'badge'); end if;
		if jsonb_typeof(p_parse -> 'template') is distinct from 'null' and (jsonb_typeof(p_parse -> 'template') is distinct from 'object'
			or (select array_agg(k order by k) from jsonb_object_keys(p_parse -> 'template') k) is distinct from array['from','version']
			or not public.qorpera_interface_text(p_parse -> 'template' -> 'from', 1, 81)
			or not public.qorpera_interface_text(p_parse -> 'template' -> 'version', 1, 20)) then
			v_bad := array_append(v_bad, 'template'); end if;
		if octet_length(p_parse::text) > 1048576 then v_bad := array_append(v_bad, 'size'); end if;
	end if;
	if cardinality(v_bad) = 0 and v_named is null then return '[]'::jsonb; end if;
	return case$new$);

-- §6.1 rule 6, the port of `parseTableRows`: one field read by its column. Returns {"value": v} or {"problem": text}.
-- The value is what the parser's typed row holds, so keys compare as the parser compares them: numbers as the
-- parser's 64-bit floats, times in their one canonical form (seconds always), agents as a list.
create function public.qorpera_interface_instant_ok(p_text text)
returns boolean language sql immutable set search_path = '' as $$
	-- `interfaceInstant`: a real calendar date (the parser reads years 0000-0099 as 19xx and so refuses them), an hour
	-- of at most 23, minutes and seconds of at most 59. ASCII digits only, as JavaScript's \d.
	select coalesce((select case when m is null then false
			when m[1]::integer < 100 or m[2]::integer not between 1 and 12 then false
			else m[3]::integer between 1 and extract(day from make_date(m[1]::integer, m[2]::integer, 1) + interval '1 month - 1 day')::integer
				and coalesce(nullif(m[4], '')::integer, 0) <= 23 and coalesce(nullif(m[5], '')::integer, 0) <= 59
				and coalesce(nullif(m[7], '')::integer, 0) <= 59 end
		from (select coalesce(regexp_match(p_text, '^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})(:([0-9]{2}))?Z$'),
			regexp_match(p_text, '^([0-9]{4})-([0-9]{2})-([0-9]{2})()()()()$')) as m) x), false)
$$;
revoke all on function public.qorpera_interface_instant_ok(text) from public, anon, authenticated, service_role;

-- An agents field's ids: each a strict uuid, each once.
create function public.qorpera_interface_agent_ids(p_ids text[])
returns boolean language sql immutable set search_path = '' as $$
	select not exists (select 1 from unnest(p_ids) i
			where i !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
		and (select count(distinct i) from unnest(p_ids) i) = cardinality(p_ids)
$$;
revoke all on function public.qorpera_interface_agent_ids(text[]) from public, anon, authenticated, service_role;

-- Inlined into qorpera_interface_rows' one query, since it runs once for every field of a rows file: STABLE (it calls
-- jsonb_build_object, format and to_jsonb, which are), with no search_path setting and no subquery. Its callers run with
-- an empty search_path.
create function public.qorpera_interface_cell(p_column jsonb, p_raw text)
returns jsonb language sql stable as $$
	select case
		when p_raw = '' then case when p_column -> 'optional' = 'true'::jsonb then jsonb_build_object('value', null)
			else jsonb_build_object('problem', (p_column ->> 'name') || ' is empty') end
		when p_column ->> 'type' = 'text' then case
			when char_length(p_raw) > coalesce((p_column ->> 'max')::integer, 500)
				then jsonb_build_object('problem', format('%s is longer than %s characters', p_column ->> 'name',
					coalesce((p_column ->> 'max')::integer, 500)))
			when p_raw ~ '[\x01-\x08\x0b\x0c\x0e-\x1f]' then jsonb_build_object('problem', (p_column ->> 'name') || ' holds a control character')
			else jsonb_build_object('value', p_raw) end
		when p_column ->> 'type' in ('number','money','percent') then case
			when char_length(p_raw) <= 30 and p_raw ~ '^-?(0|[1-9][0-9]{0,14})([.][0-9]{1,8})?$'
				then jsonb_build_object('value', to_jsonb(p_raw::double precision))
			else jsonb_build_object('problem', (p_column ->> 'name') || ' is not a number') end
		when p_column ->> 'type' = 'time' then case
			when char_length(p_raw) <= 25 and p_raw ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2})?Z$'
				and public.qorpera_interface_instant_ok(p_raw)
				then jsonb_build_object('value', case when char_length(p_raw) = 17 then left(p_raw, 16) || ':00Z' else p_raw end)
			else jsonb_build_object('problem', (p_column ->> 'name') || ' is not a time like 2026-10-02T09:44Z') end
		when p_column ->> 'type' = 'date' then case
			when char_length(p_raw) = 10 and public.qorpera_interface_instant_ok(p_raw) then jsonb_build_object('value', p_raw)
			else jsonb_build_object('problem', (p_column ->> 'name') || ' is not a date like 2026-10-02') end
		when p_column ->> 'type' = 'choice' then case
			when (p_column -> 'choices') ? p_raw then jsonb_build_object('value', p_raw)
			else jsonb_build_object('problem', (p_column ->> 'name') || ' is not one of its choices') end
		when p_column ->> 'type' = 'yes-no' then case p_raw
			when 'yes' then jsonb_build_object('value', true) when 'no' then jsonb_build_object('value', false)
			else jsonb_build_object('problem', (p_column ->> 'name') || ' is yes or no') end
		when p_column ->> 'type' in ('member','agent','id') then case
			when p_raw ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then jsonb_build_object('value', p_raw)
			else jsonb_build_object('problem', (p_column ->> 'name') || ' is not an id') end
		when p_column ->> 'type' = 'agents' then case
			-- Split on single spaces: 1 to 50 ids, each once.
			when cardinality(string_to_array(p_raw, ' ')) <= 50 and public.qorpera_interface_agent_ids(string_to_array(p_raw, ' '))
				then jsonb_build_object('value', to_jsonb(string_to_array(p_raw, ' ')))
			else jsonb_build_object('problem', (p_column ->> 'name') || ' is not a list of agent ids') end
		when p_column ->> 'type' = 'link' then case
			when char_length(p_raw) <= 200
				and p_raw !~ '[\x01-\x1f\x7f-\x9f  ]' then jsonb_build_object('value', p_raw)
			else jsonb_build_object('problem', (p_column ->> 'name') || ' is not a row key') end
		else jsonb_build_object('problem', (p_column ->> 'name') || ' has no type') end
$$;
revoke all on function public.qorpera_interface_cell(jsonb, text) from public, anon, authenticated, service_role;

-- A rows parse read against a table's definition (§6.1 rule 6): {"problems": [...], "rows": [{"line", "key", "values"}]}.
-- A header that doesn't fit the definition refuses the whole file at line 1; otherwise each row that doesn't fit, and
-- each row whose key an earlier fitting row has, is one problem with its line. At most 50 problems, then a count.
create function public.qorpera_interface_rows(p_table jsonb, p_rows jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
declare v_problem text; v_out jsonb; v_problems jsonb; v_more bigint;
begin
	select case
		when exists (select 1 from jsonb_array_elements_text(p_rows -> 'header') h(name)
			where not exists (select 1 from jsonb_array_elements(p_table -> 'columns') c where c.value ->> 'name' = h.name))
			then format('The first line names "%s", which is not a column of this table.', left((select h.name
				from jsonb_array_elements_text(p_rows -> 'header') with ordinality h(name, n)
				where not exists (select 1 from jsonb_array_elements(p_table -> 'columns') c where c.value ->> 'name' = h.name)
				order by h.n limit 1), 60))
		when exists (select 1 from jsonb_array_elements(p_table -> 'columns') c
			where c.value -> 'optional' = 'false'::jsonb and not (p_rows -> 'header') ? (c.value ->> 'name'))
			then 'The first line leaves out ' || (select string_agg(c.value ->> 'name', ', ' order by c.n)
				from jsonb_array_elements(p_table -> 'columns') with ordinality c(value, n)
				where c.value -> 'optional' = 'false'::jsonb and not (p_rows -> 'header') ? (c.value ->> 'name')) || ', which every row needs.'
	end into v_problem;
	if v_problem is not null then
		return jsonb_build_object('problems', jsonb_build_array(public.qorpera_company_state_problem('row', 1, null, v_problem)),
			'rows', '[]'::jsonb);
	end if;
	with r as (
		select x.n, (x.value ->> 'line')::integer as line, x.value -> 'fields' as fields
		from jsonb_array_elements(p_rows -> 'rows') with ordinality x(value, n)),
	h as (select h.name, (h.n - 1)::integer as pos from jsonb_array_elements_text(p_rows -> 'header') with ordinality h(name, n)),
	cells as (
		select r.n, r.line, c.n as cn, c.value ->> 'name' as name,
			public.qorpera_interface_cell(c.value, coalesce(r.fields ->> h.pos, '')) as out
		from r cross join jsonb_array_elements(p_table -> 'columns') with ordinality c(value, n)
			left join h on h.name = c.value ->> 'name'),
	rows as (
		-- Per row, in one pass: the first column in the definition's order that fails, and the typed values.
		select n, line, (array_agg(out ->> 'problem' order by cn) filter (where out ? 'problem'))[1] as problem,
			jsonb_object_agg(name, out -> 'value') filter (where out ? 'value') as row_values
		from cells group by n, line),
	keyed as (
		select n, line, problem, row_values,
			case when problem is null then (select jsonb_agg(row_values -> (k.value #>> '{}') order by k.n)
				from jsonb_array_elements(p_table -> 'key') with ordinality k(value, n)) end as row_key
		from rows),
	judged as (
		select n, line, problem, row_values, row_key,
			case when problem is null then row_number() over (partition by row_key, problem is null order by n) end as nth
		from keyed),
	problems as (
		select n, line, case when problem is not null
				then public.qorpera_company_state_problem('row', line, null, 'This row doesn''t fit: ' || problem || '.')
				else public.qorpera_company_state_problem('duplicate', line, null, 'Another row has the same key.') end as p
		from judged where problem is not null or nth > 1)
	select jsonb_build_object(
		'problems', coalesce((select jsonb_agg(p.p order by p.n) from (select * from problems order by n limit 50) p), '[]'::jsonb),
		'more', (select count(*) from problems) - 50,
		'moreCode', (select p.p ->> 'code' from problems p order by p.n offset 50 limit 1),
		'rows', coalesce((select jsonb_agg(jsonb_build_object('line', j.line, 'key', j.row_key, 'values', j.row_values) order by j.n)
			from judged j where j.problem is null and j.nth = 1), '[]'::jsonb))
	into v_out;
	v_more := (v_out ->> 'more')::bigint;
	v_problems := v_out -> 'problems';
	if v_more > 0 then
		-- As the parser's withMore: the code of the first problem left out.
		v_problems := v_problems || jsonb_build_array(public.qorpera_company_state_problem(v_out ->> 'moreCode', null, null,
			format('and %s more %s', v_more, case when v_more = 1 then 'problem' else 'problems' end)));
	end if;
	return jsonb_build_object('problems', v_problems, 'rows', v_out -> 'rows');
end $$;
revoke all on function public.qorpera_interface_rows(jsonb, jsonb) from public, anon, authenticated, service_role;

-- An owner or an admin of the company, or the platform (§6.1 rules 4 and 5).
create function public.qorpera_interface_owner_actor(p_profile_id uuid, p_actor jsonb)
returns boolean language sql stable set search_path = '' as $$
	select p_actor ->> 'kind' = 'platform' or (p_actor ->> 'kind' = 'member' and exists (select 1
		from public.qorpera_profile_members m
		where m.profile_id = p_profile_id and m.user_id = (p_actor ->> 'userId')::uuid and m.role::text in ('owner','admin')))
$$;
revoke all on function public.qorpera_interface_owner_actor(uuid, jsonb) from public, anon, authenticated, service_role;

-- The stored parse of a structured file, by key, as the commit sees it now (earlier units of this change set applied).
create function public.qorpera_interface_stored(p_environment_id uuid, p_key text)
returns jsonb language sql stable set search_path = '' as $$
	select v.structured -> 'parse' from public.qorpera_folder_entries e
		join public.qorpera_folder_path_versions v on v.version = e.version
	where e.environment_id = p_environment_id and e.key_sha256 = extensions.digest(p_key, 'sha256') and e.kind = 'file'
$$;
revoke all on function public.qorpera_interface_stored(uuid, text) from public, anon, authenticated, service_role;

create function public.qorpera_interface_refused(p_code text, p_message text)
returns jsonb language sql immutable set search_path = '' as $$
	select jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
		public.qorpera_company_state_problem(p_code, null, null, p_message)))
$$;
revoke all on function public.qorpera_interface_refused(text, text) from public, anon, authenticated, service_role;

-- §6.1 rules 2 and 4, for every unit whose source or target is at or under interfaces/ or tables/: what may leave and
-- what may land there, and who may change an owners-only interface. Null when the unit passes.
create function public.qorpera_company_state_interface_paths(p_environment_id uuid, p_profile_id uuid, p_actor jsonb,
	p_commit_id uuid, p_op text, p_key text, p_to_key text, p_unit jsonb, p_eff_path text, p_eff_to text)
returns jsonb language plpgsql stable set search_path = '' as $$
declare v_landing record; v_source_kind text; v_source_path text; v_folder text; v_access text; v_main record; v_name text;
begin
	-- Any other unit touches neither (a folder above the roots is the company root, which no unit removes or moves).
	if p_key !~ '^(interfaces|tables)(/|$)' and coalesce(p_to_key, '') !~ '^(interfaces|tables)(/|$)' then return null; end if;

	-- What leaves: a delete's or a move's source.
	if p_op in ('delete','move') then
		-- The main interface's folder and its interface.toml stay (the seeded roots and tables/areas/ are in the seeded list).
		if p_key ~ '^interfaces(/|$)' then
			for v_main in select m.key from public.qorpera_interface_mains(p_environment_id) m
				where m.key = p_key or m.key like public.qorpera_folder_under(p_key)
					or public.qorpera_folder_parent_path(m.key) = p_key loop
				return public.qorpera_interface_refused('placement',
					'the main interface stays where it is; make another interface main first');
			end loop;
		end if;
		if p_key ~ '^tables/[^/]+/(table\.toml|rows\.csv)$' then
			return public.qorpera_interface_refused('placement',
				'a table''s table.toml and rows.csv go or move only with its folder; to empty a table, save rows.csv with its header only');
		end if;
		-- A table row another commit wrote after this one began may not be among this commit's locks: read again (H2's guard).
		if exists (select 1 from public.qorpera_folder_table_index i where i.environment_id = p_environment_id and i.retired_at is null
			and (i.folder_key = p_key or i.folder_key like public.qorpera_folder_under(p_key))
			and public.qorpera_company_state_changed_since(p_commit_id, i.commit_id)) then
			return jsonb_build_object('ok', false, 'reason', 'version_changed');
		end if;
	end if;
	-- Rule 4: an owners-only interface (its stored parse) is changed, moved or deleted only by an owner or admin, or the
	-- platform. Every interface folder the unit changes: its target, and its source unless it is only copied.
	for v_folder in select distinct f.folder from (
		select public.qorpera_interface_folder(k.key) as folder
		from unnest(array_remove(array[case when p_op <> 'copy' then p_key end, p_to_key], null)) k(key)
		union all
		select public.qorpera_interface_folder(e.key_text) from public.qorpera_folder_entries e
		where p_op in ('delete','move') and p_key ~ '^interfaces(/|$)' and e.environment_id = p_environment_id and e.kind = 'file'
			and e.key_text like public.qorpera_folder_under(p_key) and e.key_text like 'interfaces/%/interface.toml') f
		where f.folder is not null
	loop
		v_access := public.qorpera_interface_stored(p_environment_id, v_folder || '/interface.toml') -> 'access' ->> 'edit';
		if v_access = 'owners' and not public.qorpera_interface_owner_actor(p_profile_id, p_actor) then
			return public.qorpera_interface_refused('owners', 'only owners and admins change this interface');
		end if;
	end loop;

	-- What lands: a write's file, a mkdir, a new folder and its contents, a move's or copy's target (and, for a folder
	-- landing under the roots, everything under it, which the move carries), each with its key and its spelling.
	if p_op in ('move','copy') then
		select e.kind, e.path into v_source_kind, v_source_path from public.qorpera_folder_entries e
		where e.environment_id = p_environment_id and e.key_sha256 = extensions.digest(p_key, 'sha256') and e.kind <> 'claim';
	end if;
	for v_landing in
		select p_key as key, p_eff_path as path, case when p_op in ('mkdir','new_folder') then 'folder' else 'file' end as kind
		where p_op in ('write','mkdir','new_folder')
		union all
		select public.qorpera_folder_key(s.path), s.path, s.kind from public.qorpera_folder_spelled_contents(p_eff_path, p_unit -> 'contents') s
		where p_op = 'new_folder'
		union all
		select p_to_key, p_eff_to, coalesce(v_source_kind, 'file') where p_op in ('move','copy') and p_to_key is not null
		union all
		select p_to_key || substr(e.key_text, char_length(p_key) + 1), p_eff_to || substr(e.path, char_length(v_source_path) + 1), e.kind
		from public.qorpera_folder_entries e
		where p_op in ('move','copy') and v_source_kind = 'folder' and p_to_key ~ '^(interfaces|tables)/'
			and e.environment_id = p_environment_id and e.kind <> 'claim' and e.key_text like public.qorpera_folder_under(p_key)
	loop
		v_name := regexp_replace(v_landing.path, '^.*/', '');
		if v_landing.key in ('interfaces','tables') and (v_landing.kind = 'file' or p_op in ('move','copy')) then
			return public.qorpera_interface_refused('placement', v_landing.key || '/ is a folder the company keeps; nothing lands on it');
		elsif v_landing.key like 'interfaces/%' and not (
			(v_landing.kind = 'file' and v_landing.key = 'interfaces/order.md')
			or (v_landing.kind = 'folder' and v_landing.key ~ '^interfaces/[^/]+$' and v_landing.key <> 'interfaces/order.md')
			or (v_landing.kind = 'file' and v_landing.key ~ '^interfaces/[^/]+/(interface\.toml|readme\.md)$')) then
			return public.qorpera_interface_refused('placement',
				'interfaces/ holds order.md and one folder per interface, each with interface.toml and README.md only');
		elsif v_landing.key like 'tables/%' and not (
			(v_landing.kind = 'folder' and v_landing.key ~ '^tables/[^/]+$')
			or (v_landing.kind = 'file' and v_landing.key ~ '^tables/[^/]+/(table\.toml|rows\.csv|readme\.md)$')) then
			return public.qorpera_interface_refused('placement',
				'tables/ holds one folder per table, each with table.toml, rows.csv and README.md only');
		elsif v_landing.key ~ '^(interfaces|tables)/[^/]+/readme\.md$' and v_name not in ('README.md', 'readme.md') then
			return public.qorpera_interface_refused('placement', 'write README.md or readme.md');
		end if;
	end loop;
	return null;
end $$;
revoke all on function public.qorpera_company_state_interface_paths(uuid, uuid, jsonb, uuid, text, text, text, jsonb, text, text)
	from public, anon, authenticated, service_role;

-- §6.1 rules 3 and 5-9, for one structured file a write or new folder saves. p_unit_parses holds the parses this unit
-- saves, by key, so a new table's rows read its new definition. Null when the file passes.
create function public.qorpera_company_state_interface_rules(p_environment_id uuid, p_profile_id uuid, p_actor jsonb,
	p_commit_id uuid, p_key text, p_parse jsonb, p_unit_parses jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
	v_kind text := public.qorpera_structured_path_kind(p_key); v_folder text := public.qorpera_folder_parent_path(p_key);
	v_definition jsonb; v_stored_definition jsonb; v_stored_rows jsonb; v_check jsonb; v_old jsonb; v_new jsonb;
	v_self jsonb; v_columns text[]; v_cell record; v_row public.qorpera_folder_table_index;
	v_agent boolean := p_actor ->> 'kind' = 'staff_agent';
begin
	if v_kind = 'interface' then
		-- Rule 3: never two main interfaces. A switch is two units, the old main set to false first.
		if p_parse -> 'main' = 'true'::jsonb and exists (select 1 from public.qorpera_interface_mains(p_environment_id) m
			where m.key <> p_key) then
			return public.qorpera_interface_refused('main', 'another interface is main; set its main = false first');
		end if;
		-- One interface per id.
		if exists (select 1 from public.qorpera_folder_entries e join public.qorpera_folder_path_versions v on v.version = e.version
			where e.environment_id = p_environment_id and e.kind = 'file' and e.key_text like 'interfaces/%/interface.toml'
				and e.key_text <> p_key and v.structured -> 'parse' ->> 'id' = p_parse ->> 'id') then
			return public.qorpera_interface_refused('duplicate', 'another interface has this id; give this one a new id');
		end if;
		return null;
	elsif v_kind = 'interface-order' then
		return null;
	end if;

	-- A table's two files. The definition and the rows as they are at commit, and as this unit saves them.
	v_stored_definition := public.qorpera_interface_stored(p_environment_id, v_folder || '/table.toml');
	v_stored_rows := public.qorpera_interface_stored(p_environment_id, v_folder || '/rows.csv');
	select * into v_row from public.qorpera_folder_table_index i
	where i.environment_id = p_environment_id and i.retired_at is null and i.folder_key = v_folder;
	-- A row another commit wrote after this one began may have been made after this commit named its locks, and so be
	-- unlocked here: read again (H2's guard).
	if v_row.id is not null and public.qorpera_company_state_changed_since(p_commit_id, v_row.commit_id) then
		return jsonb_build_object('ok', false, 'reason', 'version_changed');
	end if;

	if v_kind = 'table' then
		-- A table keeps its id, and one table has an id.
		if v_row.id is not null and v_row.id::text is distinct from p_parse ->> 'id' then
			return public.qorpera_interface_refused('duplicate', 'a table keeps its id; make a new folder for a new table');
		end if;
		if exists (select 1 from public.qorpera_folder_table_index i where i.environment_id = p_environment_id
			and i.retired_at is null and i.id::text = p_parse ->> 'id' and i.folder_key <> v_folder) then
			return public.qorpera_interface_refused('duplicate', 'another table has this id; give this one a new id');
		end if;
		-- Rule 9: tables/areas/ keeps its three columns.
		if v_folder = 'tables/areas' and (select count(*) from jsonb_array_elements(p_parse -> 'columns') c
			where (c ->> 'name' in ('owner','supervisor') and c ->> 'type' = 'member' and c -> 'needsYes' = 'true'::jsonb
					and c -> 'optional' = 'true'::jsonb)
				or (c ->> 'name' = 'agents' and c ->> 'type' = 'agents' and c -> 'optional' = 'true'::jsonb)) <> 3 then
			return public.qorpera_interface_refused('areas',
				'tables/areas/ keeps owner and supervisor (member, needs_yes) and agents (agents), each optional');
		end if;
		-- Rule 7: a definition change while the folder holds rows. The rows this unit saves are checked on their own.
		if v_stored_rows is not null and not (p_unit_parses ? (v_folder || '/rows.csv')) then
			v_check := public.qorpera_interface_rows(p_parse, v_stored_rows);
			if jsonb_array_length(v_check -> 'problems') > 0 then
				return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', v_check -> 'problems');
			end if;
			-- A claimed column (needs_yes) loses its claim, or a column gains one, only while no row holds a value in it. (A
			-- claimed column removed while the stored header names it is refused by the rows check above first.)
			if exists (select 1 from jsonb_array_elements(coalesce(v_stored_definition -> 'columns', '[]'::jsonb)) old_column
				left join lateral (select x.value from jsonb_array_elements(p_parse -> 'columns') x
					where x.value ->> 'name' = old_column ->> 'name') new_column on true
				where old_column -> 'needsYes' = 'true'::jsonb and new_column.value -> 'needsYes' is distinct from 'true'::jsonb
					and exists (select 1 from jsonb_array_elements(v_stored_rows -> 'rows') r
						where coalesce(r -> 'fields' ->> (select (h.pos - 1)::integer from jsonb_array_elements_text(v_stored_rows -> 'header')
							with ordinality h(name, pos) where h.name = old_column ->> 'name'), '') <> ''))
				or exists (select 1 from jsonb_array_elements(p_parse -> 'columns') new_column
					where new_column -> 'needsYes' = 'true'::jsonb and not exists (select 1
						from jsonb_array_elements(coalesce(v_stored_definition -> 'columns', '[]'::jsonb)) old_column
						where old_column ->> 'name' = new_column ->> 'name' and old_column -> 'needsYes' = 'true'::jsonb)
					and exists (select 1 from jsonb_array_elements(v_stored_rows -> 'rows') r
						where coalesce(r -> 'fields' ->> (select (h.pos - 1)::integer from jsonb_array_elements_text(v_stored_rows -> 'header')
							with ordinality h(name, pos) where h.name = new_column ->> 'name'), '') <> '')) then
				return public.qorpera_interface_refused('claim',
					'a claimed column gains or loses needs_yes, or goes, only while every row leaves it empty');
			end if;
		end if;
		return null;
	end if;

	-- v_kind = 'table-rows': rules 5, 6, 8 and 9 against the definition at commit.
	v_definition := coalesce(p_unit_parses -> (v_folder || '/table.toml'), v_stored_definition);
	if v_definition is null then
		return public.qorpera_interface_refused('placement', 'rows.csv needs its table.toml in the same folder');
	end if;
	-- Rule 5, under the stored definition's [write] (a new table's first rows are its maker's).
	if not (p_unit_parses ? (v_folder || '/table.toml')) and p_actor ->> 'kind' is distinct from 'platform' then
		if v_agent and not (v_definition -> 'write' -> 'agents' = '"all"'::jsonb
				or (jsonb_typeof(v_definition -> 'write' -> 'agents') = 'array'
					and coalesce((v_definition -> 'write' -> 'agents') ? (p_actor ->> 'staffAgentId'), false))) then
			return public.qorpera_interface_refused('write', 'this table''s [write] does not let this agent write its rows');
		elsif not v_agent and not (v_definition -> 'write' ->> 'members' = 'all'
				or (v_definition -> 'write' ->> 'members' = 'owners' and public.qorpera_interface_owner_actor(p_profile_id, p_actor))) then
			return public.qorpera_interface_refused('write', 'this table''s [write] does not let you write its rows');
		end if;
	end if;
	-- Rule 6.
	v_check := public.qorpera_interface_rows(v_definition, p_parse);
	if jsonb_array_length(v_check -> 'problems') > 0 then
		return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', v_check -> 'problems');
	end if;
	-- Rule 8, the claim rule, against the stored rows by key. The platform only clears cells (a leaving member's).
	begin
		v_columns := array(select c ->> 'name' from jsonb_array_elements(v_definition -> 'columns') c
			where c -> 'needsYes' = 'true'::jsonb
				or (v_agent and v_folder = 'tables/areas' and c ->> 'name' in ('owner','supervisor','agents')));
		-- Self: the member; an agent has none until supervision is built (I9b).
		v_self := case when p_actor ->> 'kind' = 'member' then to_jsonb(p_actor ->> 'userId') end;
		-- (A table with no claimed column has no cell to compare.)
		for v_cell in
			with old_rows as (select r -> 'key' as key, r -> 'values' as vals from jsonb_array_elements(case
					when v_stored_rows is null or cardinality(v_columns) = 0 then '[]'::jsonb
					else public.qorpera_interface_rows(v_definition, v_stored_rows) -> 'rows' end) r),
				new_rows as (select r -> 'key' as key, r -> 'values' as vals from jsonb_array_elements(v_check -> 'rows') r)
			select c.name, coalesce(o.vals -> c.name, 'null'::jsonb) as was, coalesce(n.vals -> c.name, 'null'::jsonb) as now
			from old_rows o full join new_rows n on n.key = o.key cross join unnest(v_columns) c(name)
			where cardinality(v_columns) > 0
				and coalesce(o.vals -> c.name, 'null'::jsonb) is distinct from coalesce(n.vals -> c.name, 'null'::jsonb)
		loop
			if p_actor ->> 'kind' = 'platform' then
				if v_cell.now <> 'null'::jsonb then
					return public.qorpera_interface_refused('claim', 'the platform only clears a claimed cell');
				end if;
			elsif v_agent and v_folder = 'tables/areas' and v_cell.name in ('owner','supervisor','agents') then
				return public.qorpera_interface_refused('claim', 'an agent never changes an area''s owner, supervisor or agents');
			elsif v_self is null then
				return public.qorpera_interface_refused('claim', 'nobody assigns anybody: only the member named changes ' || v_cell.name);
			elsif not ((v_cell.was = 'null'::jsonb and v_cell.now = v_self) or (v_cell.was = v_self and v_cell.now = 'null'::jsonb)) then
				return public.qorpera_interface_refused('claim',
					'nobody assigns anybody: you take an empty ' || v_cell.name || ' or release your own');
			end if;
		end loop;
	end;
	-- Rule 9: one area per agent.
	if v_folder = 'tables/areas' and exists (select 1 from jsonb_array_elements(v_check -> 'rows') r,
		jsonb_array_elements_text(case when jsonb_typeof(r -> 'values' -> 'agents') = 'array' then r -> 'values' -> 'agents'
			else '[]'::jsonb end) a(id)
		group by a.id having count(*) > 1) then
		return public.qorpera_interface_refused('areas', 'an agent is in one area only');
	end if;
	return null;
end $$;
revoke all on function public.qorpera_company_state_interface_rules(uuid, uuid, jsonb, uuid, text, jsonb, jsonb)
	from public, anon, authenticated, service_role;

select pg_temp.p16_interfaces_replace('public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$	v_own uuid; v_carried record; v_dest text; v_dest_owner uuid; v_tasks text[] := '{}'; v_contacts text[] := '{}';$old$,
	$new$	v_own uuid; v_carried record; v_dest text; v_dest_owner uuid; v_tasks text[] := '{}'; v_contacts text[] := '{}';
	v_p16 jsonb := '{}'::jsonb;$new$);
select pg_temp.p16_interfaces_replace('public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$	-- 20260930003000 (F2-5b): workers' folders and files, for every unit.$old$,
	$new$	-- 20260930016000 (P16): interfaces' and tables' folders and files, for every unit.
	v_rule := public.qorpera_company_state_interface_paths(p_environment_id, v_profile, p_actor, p_commit_id, v_op, v_key,
		case when p_eff_to is null then null else public.qorpera_folder_key(p_eff_to) end, p_unit, p_eff_path, p_eff_to);
	if v_rule is not null then return v_rule; end if;
	-- 20260930003000 (F2-5b): workers' folders and files, for every unit.$new$);
select pg_temp.p16_interfaces_replace('public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$		-- 20260930003000 (F2-5b): a worker's brief and results.
		elsif v_checked ->> 'kind' in ('worker-brief','worker-results') then$old$,
	$new$		-- 20260930016000 (P16): interfaces and tables, after every file of the unit is checked by its shape.
		elsif v_checked ->> 'kind' in ('interface','interface-order','table','table-rows') then
			v_p16 := v_p16 || jsonb_build_object(v_file.key, v_checked -> 'parse');
		-- 20260930003000 (F2-5b): a worker's brief and results.
		elsif v_checked ->> 'kind' in ('worker-brief','worker-results') then$new$);
select pg_temp.p16_interfaces_replace('public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$		end if;
	end loop;
	return jsonb_build_object('ok', true);
end$old$,
	$new$		end if;
	end loop;
	-- 20260930016000 (P16): a table's definition before its rows, so a new table's rows read the definition it brings.
	for v_file in select k.key, k.parse from jsonb_each(v_p16) k(key, parse)
		order by public.qorpera_structured_path_kind(k.key) = 'table-rows', k.key collate "C" loop
		v_rule := public.qorpera_company_state_interface_rules(p_environment_id, v_profile, p_actor, p_commit_id, v_file.key,
			v_file.parse, v_p16);
		if v_rule is not null then return v_rule; end if;
	end loop;
	return jsonb_build_object('ok', true);
end$new$);

-- Apply: a table's index row (STATE-FILES §8 "Plan (P16)", "The index and the locks").
create function public.qorpera_company_state_index_table(p_environment_id uuid, p_profile_id uuid, p_commit_id uuid,
	p_path text, p_version uuid, p_parse jsonb)
returns void language plpgsql set search_path = '' as $$
declare v_folder text := public.qorpera_folder_key(public.qorpera_folder_parent_path(p_path)); v_folder_path text; v_rows uuid;
	v_count bigint;
begin
	select e.path into v_folder_path from public.qorpera_folder_entries e
	where e.environment_id = p_environment_id and e.key_sha256 = extensions.digest(v_folder, 'sha256') and e.kind = 'folder';
	-- The folder's rows.csv as it is now (a new folder's rows.csv is applied after its definition, and sets it again).
	select e.version into v_rows from public.qorpera_folder_entries e
	where e.environment_id = p_environment_id and e.key_sha256 = extensions.digest(v_folder || '/rows.csv', 'sha256') and e.kind = 'file';
	-- A retired row of this id (a deleted table restored, or made again from its text) is reused, and the folder's own row
	-- moves on; a live row of another folder means another change set took the id meanwhile, so this one fails whole (as
	-- H2's indexes do).
	insert into public.qorpera_folder_table_index as i(environment_id, id, profile_id, folder_path, folder_key, definition_version,
		rows_version, commit_id)
	values (p_environment_id, (p_parse ->> 'id')::uuid, p_profile_id, coalesce(v_folder_path, v_folder), v_folder, p_version, v_rows,
		p_commit_id)
	on conflict (environment_id, id) do update set folder_path = excluded.folder_path, folder_key = excluded.folder_key,
		definition_version = excluded.definition_version, rows_version = excluded.rows_version, commit_id = excluded.commit_id,
		retired_at = null, updated_at = clock_timestamp()
	where i.retired_at is not null or i.folder_key = excluded.folder_key;
	get diagnostics v_count = row_count;
	if v_count = 0 then raise exception 'A table id was taken by another change set' using errcode = '23505'; end if;
end $$;
revoke all on function public.qorpera_company_state_index_table(uuid, uuid, uuid, text, uuid, jsonb)
	from public, anon, authenticated, service_role;

-- A table's definition before its rows within a unit, after the agents (todos and routines last, as before).
select pg_temp.p16_interfaces_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$			order by coalesce(public.qorpera_structured_path_kind(f.key) in ('todo','routine'), false) loop$old$,
	$new$			order by coalesce(public.qorpera_structured_path_kind(f.key) in ('todo','routine','table-rows' /* P16 */), false) loop$new$);
select pg_temp.p16_interfaces_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$			-- 20260930003000 (F2-5b): a worker's brief and results.
			elsif v_kind in ('worker-brief','worker-results') then$old$,
	$new$			-- 20260930016000 (P16): a table's definition and its rows; interfaces have no index before I7.
			elsif v_kind = 'table' then
				perform public.qorpera_company_state_index_table(p_environment_id, v_profile, p_commit_id, v_file.path, v_version,
					v_entry -> 'parse');
			elsif v_kind = 'table-rows' then
				update public.qorpera_folder_table_index i set rows_version = v_version, commit_id = p_commit_id,
					updated_at = clock_timestamp()
				where i.environment_id = p_environment_id and i.retired_at is null
					and i.folder_key = public.qorpera_interface_table_folder(v_file.key);
				if not found then raise exception 'A table''s rows have no table row' using errcode = 'XX000'; end if;
			-- 20260930003000 (F2-5b): a worker's brief and results.
			elsif v_kind in ('worker-brief','worker-results') then$new$);
-- A move repoints every table row at or under the source, with its files' new versions.
select pg_temp.p16_interfaces_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$		if v_h2_moved <> v_h2_rows then raise exception 'A moved worker folder has no version in its commit' using errcode = 'XX000'; end if;$old$,
	$new$		if v_h2_moved <> v_h2_rows then raise exception 'A moved worker folder has no version in its commit' using errcode = 'XX000'; end if;
		-- 20260930016000 (P16): table folders follow their path, with their files' new versions.
		select count(*) into v_h2_rows from public.qorpera_folder_table_index i
		where i.environment_id = p_environment_id and i.retired_at is null
			and (i.folder_key = v_key or i.folder_key like public.qorpera_folder_under(v_key));
		update public.qorpera_folder_table_index i set folder_path = e.path, folder_key = e.key_text,
			definition_version = (select v.version from public.qorpera_folder_path_versions v where v.commit_id = p_commit_id
				and v.unit_no = p_unit_no and v.op = 'move_in' and v.key_sha256 = extensions.digest(e.key_text || '/table.toml', 'sha256')),
			rows_version = case when i.rows_version is null then null
				else (select v.version from public.qorpera_folder_path_versions v where v.commit_id = p_commit_id and v.unit_no = p_unit_no
					and v.op = 'move_in' and v.key_sha256 = extensions.digest(e.key_text || '/rows.csv', 'sha256')) end,
			commit_id = p_commit_id, updated_at = clock_timestamp()
		from public.qorpera_folder_entries e
		where i.environment_id = p_environment_id and i.retired_at is null
			and (i.folder_key = v_key or i.folder_key like public.qorpera_folder_under(v_key))
			and e.environment_id = p_environment_id and e.kind = 'folder'
			and e.key_sha256 = extensions.digest(public.qorpera_folder_key(p_eff_to || substr(i.folder_path, char_length(p_eff_path) + 1)), 'sha256');
		get diagnostics v_h2_moved = row_count;
		if v_h2_moved <> v_h2_rows then raise exception 'A moved table folder has no version in its commit' using errcode = 'XX000'; end if;$new$);
-- A delete retires every table row at or under the path; a restore of the folder brings it back.
select pg_temp.p16_interfaces_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$		-- A connection's file removed (after its account was disconnected): its index row retires.$old$,
	$new$		-- 20260930016000 (P16): a table's folder removed: its row retires.
		update public.qorpera_folder_table_index i set retired_at = clock_timestamp(), commit_id = p_commit_id,
			updated_at = clock_timestamp()
		where i.environment_id = p_environment_id and i.retired_at is null
			and (i.folder_key = v_key or i.folder_key like public.qorpera_folder_under(v_key));
		-- A connection's file removed (after its account was disconnected): its index row retires.$new$);

-- Verify: every table row the commit wrote points at its files' current versions and spelling.
select pg_temp.p16_interfaces_replace('public.qorpera_folder_structured_verify(uuid,uuid)'::regprocedure,
	$old$		or exists (select 1 from public.qorpera_folder_company_index i$old$,
	$new$		-- 20260930016000 (P16): table rows, definition and rows.
		or exists (select 1 from public.qorpera_folder_table_index t
			where t.environment_id = p_environment_id and t.commit_id = p_commit_id and t.retired_at is null
				and (not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
						and e.key_sha256 = extensions.digest(t.folder_key, 'sha256') and e.kind = 'folder' and e.path = t.folder_path)
					or not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
						and e.key_sha256 = extensions.digest(t.folder_key || '/table.toml', 'sha256') and e.version = t.definition_version)
					or (t.rows_version is null) is distinct from not exists (select 1 from public.qorpera_folder_entries e
						where e.environment_id = p_environment_id and e.kind = 'file'
							and e.key_sha256 = extensions.digest(t.folder_key || '/rows.csv', 'sha256'))
					or (t.rows_version is not null and not exists (select 1 from public.qorpera_folder_entries e
						where e.environment_id = p_environment_id and e.key_sha256 = extensions.digest(t.folder_key || '/rows.csv', 'sha256')
							and e.version = t.rows_version))))
		or exists (select 1 from public.qorpera_folder_company_index i$new$);

-- Review (§7): an agent creating an interface, changing its buttons or access, or naming a button in a block that its
-- stored parse names in no block; creating a table, or changing its columns or [write].
select pg_temp.p16_interfaces_replace('public.qorpera_folder_structured_review_class(uuid,jsonb,jsonb,text,text)'::regprocedure,
	$old$		if v_kind = 'worker-brief' and public.qorpera_folder_worker_request() ->> 'action' in ('dispatch','followup') then
			return 'delegation'; end if;$old$,
	$new$		if v_kind = 'worker-brief' and public.qorpera_folder_worker_request() ->> 'action' in ('dispatch','followup') then
			return 'delegation'; end if;
		-- 20260930016000 (P16): interfaces and tables.
		if v_kind = 'interface' and (v_base is null
			or v_base -> 'buttons' is distinct from v_entry -> 'parse' -> 'buttons'
			or v_base -> 'access' is distinct from v_entry -> 'parse' -> 'access'
			or exists (select 1 from jsonb_path_query(v_entry -> 'parse', '$.views[*].blocks[*].buttons[*]') n
				where not exists (select 1 from jsonb_path_query(v_base, '$.views[*].blocks[*].buttons[*]') o where o = n))) then
			return 'delegation'; end if;
		if v_kind = 'table' and (v_base is null or v_base -> 'columns' is distinct from v_entry -> 'parse' -> 'columns'
			or v_base -> 'write' is distinct from v_entry -> 'parse' -> 'write') then
			return 'delegation'; end if;$new$);

-- The review recorder takes save_interface, for change sets under interfaces/ and tables/ only.
select pg_temp.p16_interfaces_replace('public.qorpera_folder_record_review(jsonb,jsonb)'::regprocedure,
	$old$			'manage_worker' /* 20260930003000 (F2-5b) */)$old$,
	$new$			'manage_worker' /* 20260930003000 (F2-5b) */)
			-- 20260930016000 (P16): a page or a table an agent makes or changes, only under interfaces/ and tables/.
			or (v_action.tool_name = 'save_interface' and v_action.effect = 'delegation'
				and not exists (select 1 from jsonb_array_elements(v_units) u
					where (public.qorpera_folder_key(coalesce(u ->> 'from', u ->> 'path')) ~ '^(interfaces|tables)/'
						and (u ->> 'to' is null or public.qorpera_folder_key(u ->> 'to') ~ '^(interfaces|tables)/')) is not true))$new$);

-- The fixed paths: never deleted or moved.
select pg_temp.p16_interfaces_replace('public.qorpera_company_state_seeded(text)'::regprocedure,
	$old$'human-tasks','contacts','skills','rules'])$old$,
	$new$'human-tasks','contacts','skills','rules',
		-- 20260930016000 (P16): interfaces/ and tables/, and the areas table.
		'interfaces','interfaces/order.md','tables','tables/areas','tables/areas/table.toml','tables/areas/rows.csv'])$new$);

-- Coding sessions see interfaces/ and table definitions read-only (contract 5.6).
select pg_temp.p16_interfaces_replace('public.qorpera_folder_coding_protected(text)'::regprocedure,
	$old$	select p_key in ('agents','rules') or p_key like 'agents/%' or p_key like 'rules/%'$old$,
	$new$	select p_key in ('agents','rules') or p_key like 'agents/%' or p_key like 'rules/%'
		-- 20260930016000 (P16): interfaces/ and every table's table.toml.
		or p_key = 'interfaces' or p_key like 'interfaces/%' or p_key ~ '^tables/[^/]+/table\.toml$'$new$);

-- A folder moved or copied into, within or out of interfaces/ and tables/ is checked entry by entry.
select pg_temp.p16_interfaces_replace('public.qorpera_company_state_carried(uuid,text,text,text,public.qorpera_folder_entries)'::regprocedure,
	$old$	if p_from_key !~ '^(agents|vision|connections|rules|human-tasks|contacts)(/|$)'
		and v_to_key !~ '^(agents|vision|connections|rules|human-tasks|contacts)(/|$)' then$old$,
	$new$	if p_from_key !~ '^(agents|vision|connections|rules|human-tasks|contacts|interfaces|tables)(/|$)' -- P16
		and v_to_key !~ '^(agents|vision|connections|rules|human-tasks|contacts|interfaces|tables)(/|$)' then$new$);
