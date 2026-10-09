-- The agent exit, E8a: a company's network rules (deploy/first-node/RUNTIME-AGENT-EXIT.md §10; plan agreed with the
-- coordinator on 9 October 2026).
--
-- rules/network.toml says which names the exit refuses for the company's machines, and whether they reach only listed
-- names. The folder is its authority; the nodes read a copy of it.
-- * A structured kind, 'network-rules', at that one path. It is not a review rule (rules/*.md): the reviewer never reads
--   it. The parser (packages/cloud-client/src/network-rules.ts) reads the TOML; the database checks the parse's shape
--   again: exactly mode, block and allow; mode 'open' or 'only-listed'; each list at most 1000 distinct names as the
--   exit's resolver matches them (qorpera_company_network_rules_name_valid); no name in both lists.
-- * Who writes it: rules/ is the core's company_rules scope, so owners and admins write it and agents only read it.
--   The file never moves (decide refuses it, onto its own path too), a move of another file onto its path changes that
--   file's kind, and rules/ is seeded. No folder takes its name.
-- * qorpera_company_network_rules, one row per environment whose folder has the file: apply writes it on a save or a
--   restore and deletes it with the file, and verify checks it. A company without a row is open. No row is ever
--   retired, so erasure (RUNTIME-COMPANY-FOLDER-ERASURE.md §5: retired rows only) has nothing here.
-- * qorpera_agent_exit, a role of its own for the nodes, created without a login (the coordinator gives it one and its
--   secret at rollout; none is here), which may call one function: qorpera_agent_exit_network_rules, the rules of the
--   companies a node asks for.
-- Every inserted text names this migration (20260930230000), for the deploy guards.

do $$ begin
	if to_regclass('public.qorpera_company_network_rules') is not null then
		raise exception 'E8a (20260930230000) is already applied'; end if;
end $$;

set local lock_timeout = '3s';

create function pg_temp.e8a_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'E8a anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. Where the file sits -------------------------------------------------------------------------------------------------

select pg_temp.e8a_replace('public.qorpera_structured_path_kind(text)'::regprocedure,
	$old$		when p_key ~ '^rules/[^/]*\.md$' then 'rule'$old$,
	$new$		-- 20260930230000 (E8a): the company's network rules.
		when p_key = 'rules/network.toml' then 'network-rules'
		when p_key ~ '^rules/[^/]*\.md$' then 'rule'$new$);

-- Named by its kind, as interface.toml is: not a .md file.
select pg_temp.e8a_replace('public.qorpera_company_state_path_problems(text,boolean)'::regprocedure,
	$old$		'memory-tree','memory-block' /* 20260930111000 (M1a) */)$old$,
	$new$		'memory-tree','memory-block' /* 20260930111000 (M1a) */, 'network-rules' /* 20260930230000 (E8a) */)$new$);

-- The path is the file's: a folder by that name is refused (mkdir, new_folder, and a folder moved or copied there).
select pg_temp.e8a_replace('public.qorpera_company_state_path_problems(text,boolean)'::regprocedure,
	$old$v_places := public.qorpera_structured_folder_names(v_key);$old$,
	$new$-- 20260930230000 (E8a): the network rules' path is a file's.
		if v_key = 'rules/network.toml' then
			return jsonb_build_array(public.qorpera_company_state_problem('name', null, null,
				'rules/network.toml is the name of the network rules file, not a folder')); end if;
		v_places := public.qorpera_structured_folder_names(v_key);$new$);

-- The file never moves, onto its own path either (the core takes that as a rename): decide refuses it as a rule. A move
-- of another file onto the path changes its kind, which carried refuses.
select pg_temp.e8a_replace('public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$if public.qorpera_company_state_seeded(v_key) then return jsonb_build_object('ok', false, 'reason', 'seeded'); end if;$old$,
	$new$if public.qorpera_company_state_seeded(v_key) then return jsonb_build_object('ok', false, 'reason', 'seeded'); end if;
		-- 20260930230000 (E8a): the network rules file never moves.
		if v_op = 'move' and v_key = 'rules/network.toml' then
			return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
				public.qorpera_company_state_problem('value', null, null, 'rules/network.toml does not move; edit it where it is')));
		end if;$new$);

-- 2. What the file says --------------------------------------------------------------------------------------------------

-- A name as the exit's resolver matches it, as the parser's isNetworkRulesName: lowercase labels of 1–63 letters, digits
-- and inner hyphens, at most 253 characters, and *. in front for the names under it alone; the last label is never all
-- digits, so an address is not read as a name.
create function public.qorpera_company_network_rules_name_valid(p_name text)
returns boolean language sql immutable set search_path = '' as $$
	-- 20260930230000 (E8a).
	select p_name is not null and char_length(regexp_replace(p_name, '^\*\.', '')) <= 253
		and p_name ~ '^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
		and p_name !~ '(^|\.)[0-9]+$'
$$;
revoke all on function public.qorpera_company_network_rules_name_valid(text) from public, anon, authenticated, service_role;

-- A list: a JSON array of at most 1000 names, none twice.
create function public.qorpera_company_network_rules_list_valid(p_list jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
	-- 20260930230000 (E8a).
	if jsonb_typeof(p_list) is distinct from 'array' or jsonb_array_length(p_list) > 1000 then return false; end if;
	return not exists (select 1 from jsonb_array_elements(p_list) e(item)
			where jsonb_typeof(e.item) <> 'string' or not public.qorpera_company_network_rules_name_valid(e.item #>> '{}'))
		and (select count(distinct e.item) from jsonb_array_elements(p_list) e(item)) = jsonb_array_length(p_list);
end $$;
revoke all on function public.qorpera_company_network_rules_list_valid(jsonb) from public, anon, authenticated, service_role;

-- The parse's shape (the parser's own, checked again here).
select pg_temp.e8a_replace('public.qorpera_company_state_parse_problems(text,jsonb)'::regprocedure,
	$old$	if cardinality(v_bad) = 0 and v_named is null then return '[]'::jsonb; end if;$old$,
	$new$	-- 20260930230000 (E8a): the company's network rules.
	if p_kind = 'network-rules' then
		if (select array_agg(k order by k collate "C") from jsonb_object_keys(p_parse) k) is distinct from
			array['allow','block','kind','mode'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if jsonb_typeof(p_parse -> 'mode') is distinct from 'string' or (p_parse ->> 'mode') not in ('open','only-listed') then
			v_bad := array_append(v_bad, 'mode'); end if;
		if not public.qorpera_company_network_rules_list_valid(p_parse -> 'block') then
			v_bad := array_append(v_bad, 'block'); end if;
		if not public.qorpera_company_network_rules_list_valid(p_parse -> 'allow') then
			v_bad := array_append(v_bad, 'allow'); end if;
		if jsonb_typeof(p_parse -> 'block') = 'array' and jsonb_typeof(p_parse -> 'allow') = 'array'
			and exists (select 1 from jsonb_array_elements(p_parse -> 'block') b(item)
				join jsonb_array_elements(p_parse -> 'allow') a(item) on a.item = b.item) then
			v_bad := array_append(v_bad, 'overlap'); end if;
	end if;
	if cardinality(v_bad) = 0 and v_named is null then return '[]'::jsonb; end if;$new$);

select pg_temp.e8a_replace('public.qorpera_company_state_checked(jsonb,text,text,jsonb)'::regprocedure,
	$old$'interface','interface-order','table','table-rows' /* 20260930016000 (P16) */) then$old$,
	$new$'interface','interface-order','table','table-rows' /* 20260930016000 (P16) */,
		'network-rules' /* 20260930230000 (E8a) */) then$new$);

-- 3. The rules the nodes read ------------------------------------------------------------------------------------------

create table public.qorpera_company_network_rules (
	environment_id uuid primary key references public.qorpera_folder_clocks(environment_id) on delete cascade,
	-- No foreign key to qorpera_profiles: its KEY SHARE would come in apply, after the paths (as the hook index).
	profile_id uuid not null,
	mode text not null check (mode in ('open','only-listed')),
	-- In the file's order.
	block text[] not null,
	allow text[] not null,
	-- The version of rules/network.toml this row was read from.
	folder_path_version uuid not null,
	commit_id uuid not null,
	updated_at timestamptz not null default clock_timestamp()
);
create index qorpera_company_network_rules_profile on public.qorpera_company_network_rules(profile_id);
alter table public.qorpera_company_network_rules enable row level security;
revoke all on public.qorpera_company_network_rules from public, anon, authenticated, service_role;
grant select on public.qorpera_company_network_rules to service_role;
comment on table public.qorpera_company_network_rules is
	'E8a: a company''s network rules (rules/network.toml), one row per environment whose folder has the file; read by the agent exit on every node.';

-- Apply: a save or a restore writes the row; a delete removes it; the file never moves.
select pg_temp.e8a_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$			elsif v_kind = 'rule' then$old$,
	$new$			-- 20260930230000 (E8a): the company's network rules.
			elsif v_kind = 'network-rules' then
				insert into public.qorpera_company_network_rules as r(environment_id, profile_id, mode, block, allow,
					folder_path_version, commit_id)
				values (p_environment_id, v_profile, v_entry -> 'parse' ->> 'mode',
					array(select x.item from jsonb_array_elements_text(v_entry -> 'parse' -> 'block') with ordinality x(item, ord)
						order by x.ord),
					array(select x.item from jsonb_array_elements_text(v_entry -> 'parse' -> 'allow') with ordinality x(item, ord)
						order by x.ord),
					v_version, p_commit_id)
				on conflict (environment_id) do update set profile_id = excluded.profile_id, mode = excluded.mode,
					block = excluded.block, allow = excluded.allow, folder_path_version = excluded.folder_path_version,
					commit_id = excluded.commit_id, updated_at = clock_timestamp();
			elsif v_kind = 'rule' then$new$);
select pg_temp.e8a_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$		-- 20260930111000 (M1a): summary trees follow their files.$old$,
	$new$		-- 20260930230000 (E8a): the network rules file never moves, and no file moves onto its path; decide refuses both,
		-- so this is a guard only.
		if exists (select 1 from public.qorpera_folder_path_versions v
			where v.environment_id = p_environment_id and v.key_sha256 = extensions.digest('rules/network.toml', 'sha256')
				and v.commit_id = p_commit_id and v.unit_no = p_unit_no and v.op in ('move_out','move_in') and v.kind = 'file') then
			raise exception 'The network rules file cannot move' using errcode = 'XX000'; end if;
		-- 20260930111000 (M1a): summary trees follow their files.$new$);
select pg_temp.e8a_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$		-- A connection's file removed (after its account was disconnected): its index row retires.$old$,
	$new$		-- 20260930230000 (E8a): the network rules removed: the company is open (a restore writes the row again).
		delete from public.qorpera_company_network_rules r
		where r.environment_id = p_environment_id
			and ('rules/network.toml' = v_key or 'rules/network.toml' like public.qorpera_folder_under(v_key));
		-- A connection's file removed (after its account was disconnected): its index row retires.$new$);

-- Verify: the row this commit wrote points at the file's current version.
select pg_temp.e8a_replace('public.qorpera_folder_structured_verify(uuid,uuid)'::regprocedure,
	$old$		or exists (select 1 from public.qorpera_folder_company_index i$old$,
	$new$		-- 20260930230000 (E8a): the network rules' row.
		or exists (select 1 from public.qorpera_company_network_rules n
			where n.environment_id = p_environment_id and n.commit_id = p_commit_id
				and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.key_sha256 = extensions.digest('rules/network.toml', 'sha256') and e.version = n.folder_path_version
					and e.path = 'rules/network.toml'))
		or exists (select 1 from public.qorpera_folder_company_index i$new$);

-- 4. The nodes' login ----------------------------------------------------------------------------------------------------

-- The agent exit on each node reads the rules with a login of its own, as the secret broker does: no password here (the
-- coordinator sets it on each node at rollout), and one function it may call.
do $$
begin
	if not exists (select 1 from pg_roles where rolname = 'qorpera_agent_exit') then
		create role qorpera_agent_exit nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
	end if;
	if exists (select 1 from pg_roles where rolname = 'qorpera_agent_exit'
		and (rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)) then
		raise exception 'The agent exit role has unsafe attributes'; end if;
end
$$;
grant usage on schema public to qorpera_agent_exit;

-- The rules of the companies a node asks for (its machines' companies): one row per company that has the file, from its
-- latest save when it has more than one environment. A company without a row is open. `version` changes with every
-- save, so a node rebuilds only what changed.
create function public.qorpera_agent_exit_network_rules(p_companies uuid[])
returns table (company_id uuid, version uuid, mode text, block text[], allow text[], updated_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
	-- 20260930230000 (E8a).
	if p_companies is null or cardinality(p_companies) > 10000 then
		raise exception 'At most 10000 companies a call' using errcode = '22023'; end if;
	return query
	select distinct on (r.profile_id) r.profile_id, r.folder_path_version, r.mode, r.block, r.allow, r.updated_at
	from public.qorpera_company_network_rules r
	where r.profile_id = any (p_companies)
	order by r.profile_id, r.updated_at desc, r.environment_id;
end $$;
revoke all on function public.qorpera_agent_exit_network_rules(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_agent_exit_network_rules(uuid[]) to qorpera_agent_exit;
comment on function public.qorpera_agent_exit_network_rules(uuid[]) is
	'E8a: the network rules of the given companies, for the agent exit on each node (login qorpera_agent_exit).';

-- 5. The deploy guard: every patched body carries the marker -------------------------------------------------------------

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_structured_path_kind(text)', 'public.qorpera_company_state_path_problems(text,boolean)',
		'public.qorpera_company_state_parse_problems(text,jsonb)', 'public.qorpera_company_state_checked(jsonb,text,text,jsonb)',
		'public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)',
		'public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)',
		'public.qorpera_folder_structured_verify(uuid,uuid)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930230000') = 0 then
			raise exception 'E8a marker is missing in %', v_function; end if;
	end loop;
end $guard$;
