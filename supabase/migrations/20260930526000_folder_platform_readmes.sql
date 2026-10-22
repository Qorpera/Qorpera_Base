-- 20260930526000: each platform folder says what it is for in a README.md (Jonas, 21 October 2026: "Layout A ... The
-- rules are OK. Go ahead and build it."; QORPERA-RUNTIME-CONTRACT.md 5.6). A new company's folder is seeded with
-- agents/, connections/, human-tasks/, contacts/, skills/, rules/, interfaces/ and tables/ each holding a README.md
-- (packages/cloud-client/src/company-state-files.ts, COMPANY_FOLDER_READMES). Such a file is a note for people and
-- agents, never data, and the database now reads it that way, as the shared parser does (isCompanyFolderReadme):
-- 1. qorpera_company_folder_readme(key): whether a key is `<platform folder>/readme.md`, any spelling with that key.
-- 2. The structured kinds (qorpera_structured_path_kind): connections/README.md, rules/README.md, human-tasks/README.md
--    and contacts/README.md are ordinary files, not a connection, a rule, a human task or a contact, so a save carries
--    no parse for them and no index takes them. The other four roots never made them structured.
-- 3. human-tasks/ (qorpera_company_state_task_stem, qorpera_company_state_task_paths): README.md there is no task's file
--    and names no task's folder, so it is written, moved and deleted as any ordinary file; a link there is still refused.
-- 4. interfaces/ and tables/ (qorpera_company_state_interface_paths): each root takes its README.md (spelled README.md
--    or readme.md) beside what it held. An agent still changes nothing there (20260930510000's layout_authoring).
-- Not protected: the READMEs are not seeded paths (qorpera_company_state_seeded is unchanged), so a member may edit or
-- delete them as the folder's other rules allow.
-- Existing companies are test companies and keep their files; nothing is migrated. The apply refuses if a live index row
-- (a rule, a connection, a human task or a contact) sits at one of these paths, since that file would stop updating it.
--
-- Deploy order: this migration, then the object gateway (its creation worker seeds the READMEs; before this migration the
-- database refuses them). The runtime and the web share the parser and follow with their own releases.

set local lock_timeout = '3s';

create function pg_temp.folder_readmes_526000_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930526000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 0. No live index row at a README's path ----------------------------------------------------------------------------

do $guard$
begin
	if exists (select 1 from public.qorpera_review_rules r where r.folder_path is not null and r.archived_at is null
			and public.qorpera_folder_key(r.folder_path) = 'rules/readme.md')
		or exists (select 1 from public.qorpera_folder_connection_index c where c.retired_at is null
			and public.qorpera_folder_key(c.folder_path) = 'connections/readme.md')
		or exists (select 1 from public.qorpera_folder_human_task_index t where t.retired_at is null
			and t.folder_key = 'human-tasks/readme.md')
		or exists (select 1 from public.qorpera_folder_contact_index c where c.retired_at is null
			and c.folder_key = 'contacts/readme.md') then
		raise exception '20260930526000: a rule, connection, human task or contact is stored at a platform folder''s README.md; rename that file first';
	end if;
end $guard$;

-- 1. Which key is a platform folder's README -------------------------------------------------------------------------

-- The TS twin is isCompanyFolderReadme (COMPANY_FOLDER_README_ROOTS).
create function public.qorpera_company_folder_readme(p_key text)
returns boolean language sql immutable parallel safe set search_path = '' as $$
	-- 20260930526000
	select coalesce(p_key ~ '^(agents|connections|human-tasks|contacts|skills|rules|interfaces|tables)/readme\.md$', false)
$$;
revoke all on function public.qorpera_company_folder_readme(text) from public, anon, authenticated, service_role;

-- 2. The structured kinds --------------------------------------------------------------------------------------------

select pg_temp.folder_readmes_526000_replace('public.qorpera_structured_path_kind(text)'::regprocedure,
	$old$when p_key = 'agents/sections.md' then 'sections'$old$,
	$new$when p_key = 'agents/sections.md' then 'sections'
		-- 20260930526000: a platform folder's README.md is an ordinary file.
		when public.qorpera_company_folder_readme(p_key) then null$new$);

-- 3. human-tasks/ ----------------------------------------------------------------------------------------------------

-- The task a key belongs to: human-tasks/<t>.md, human-tasks/<t> and everything under it give <t>; README.md none.
create or replace function public.qorpera_company_state_task_stem(p_key text)
returns text language sql immutable parallel safe set search_path = '' as $$
	-- 20260930526000: human-tasks/README.md belongs to no task.
	select case when public.qorpera_company_folder_readme(p_key) then null
		when p_key ~ '^human-tasks/[^/]+\.md$' then substring(p_key from '^human-tasks/([^/]+)\.md$')
		when p_key ~ '^human-tasks/[^/]+(/|$)' then substring(p_key from '^human-tasks/([^/]+)') end
$$;

-- What leaves: README.md is no task's file, so it goes as any ordinary file.
select pg_temp.folder_readmes_526000_replace(
	'public.qorpera_company_state_task_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text)'::regprocedure,
	$old$if p_key ~ '^human-tasks/[^/]+\.md$' then$old$,
	$new$if p_key ~ '^human-tasks/[^/]+\.md$' and not public.qorpera_company_folder_readme(p_key) /* 20260930526000 */ then$new$);
-- What lands: README.md as a file is taken as it is (a link there is still refused below).
select pg_temp.folder_readmes_526000_replace(
	'public.qorpera_company_state_task_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text)'::regprocedure,
	$old$elsif v_landing.key ~ '^human-tasks/[^/]+\.md$' then$old$,
	$new$elsif v_landing.kind = 'file' and public.qorpera_company_folder_readme(v_landing.key) then
			-- 20260930526000: human-tasks/README.md says what the folder is for; no task's rule holds for it.
			null;
		elsif v_landing.key ~ '^human-tasks/[^/]+\.md$' then$new$);

-- 4. interfaces/ and tables/ -----------------------------------------------------------------------------------------

select pg_temp.folder_readmes_526000_replace(
	'public.qorpera_company_state_interface_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text,text)'::regprocedure,
	$old$(v_landing.kind = 'file' and v_landing.key = 'interfaces/order.md')$old$,
	$new$(v_landing.kind = 'file' and v_landing.key = 'interfaces/order.md')
			-- 20260930526000: the root's README.md.
			or (v_landing.kind = 'file' and v_landing.key = 'interfaces/readme.md')$new$);
select pg_temp.folder_readmes_526000_replace(
	'public.qorpera_company_state_interface_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text,text)'::regprocedure,
	$old$(v_landing.kind = 'folder' and v_landing.key ~ '^tables/[^/]+$')$old$,
	$new$(v_landing.kind = 'folder' and v_landing.key ~ '^tables/[^/]+$')
			-- 20260930526000: the root's README.md.
			or (v_landing.kind = 'file' and v_landing.key = 'tables/readme.md')$new$);
select pg_temp.folder_readmes_526000_replace(
	'public.qorpera_company_state_interface_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text,text)'::regprocedure,
	$old$'interfaces/ holds order.md and one folder per interface, each with interface.toml and README.md only'$old$,
	$new$'interfaces/ holds README.md, order.md and one folder per interface, each with interface.toml and README.md only'$new$);
select pg_temp.folder_readmes_526000_replace(
	'public.qorpera_company_state_interface_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text,text)'::regprocedure,
	$old$'tables/ holds one folder per table, each with table.toml, rows.csv and README.md only'$old$,
	$new$'tables/ holds README.md and one folder per table, each with table.toml, rows.csv and README.md only'$new$);
-- A README is spelled README.md or readme.md, at the root as in a page's or a table's folder.
select pg_temp.folder_readmes_526000_replace(
	'public.qorpera_company_state_interface_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text,text)'::regprocedure,
	$old$elsif v_landing.key ~ '^(interfaces|tables)/[^/]+/readme\.md$' and v_name not in ('README.md', 'readme.md') then$old$,
	$new$elsif v_landing.key ~ '^(interfaces|tables)/([^/]+/)?readme\.md$' /* 20260930526000 */ and v_name not in ('README.md', 'readme.md') then$new$);

drop function pg_temp.folder_readmes_526000_replace(regprocedure, text, text);

-- 5. The deploy guard ------------------------------------------------------------------------------------------------

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_company_folder_readme(text)',
		'public.qorpera_structured_path_kind(text)',
		'public.qorpera_company_state_task_stem(text)',
		'public.qorpera_company_state_task_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text)',
		'public.qorpera_company_state_interface_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text,text)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930526000') = 0 then
			raise exception '20260930526000 marker is missing in %', v_function; end if;
	end loop;
end $guard$;
