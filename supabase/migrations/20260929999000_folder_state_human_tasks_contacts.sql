-- Company state files, H1b (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §2 "human-tasks/<name>.md" and
-- "contacts/<name>.md", §8 "Plan (H1)"): the database learns the two formats. Inert until H2.
--
-- 1. human-tasks/<name>.md is a human task and contacts/<name>.md a contact: structured paths, so every save carries the
--    shared parser's parse (H1a, released first) and the parse is checked by its shape, limits and cross-key rules, as
--    for the kinds already indexed, so H2's index can trust what is stored.
-- 2. The folders human-tasks and contacts are places with no name of their own; human-tasks/<t> and
--    human-tasks/<t>/proof are a task's folder, and <t> follows the naming rule.
-- 3. A folder move or copy into or out of human-tasks/ and contacts/ is checked as one under agents/ is (kind_change,
--    structured_copy).
-- 4. One rule: only the platform marks a task's secret saved, unless the file the save replaces already had it saved for
--    the same task id and label.
-- No index, lock target, verify row or review class: the files are stored and checked, and nothing reads them yet.

create function pg_temp.h1_human_tasks_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'H1 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The two kinds, by key.
select pg_temp.h1_human_tasks_replace('public.qorpera_structured_path_kind(text)'::regprocedure,
	$old$when p_key ~ '^rules/[^/]*\.md$' then 'rule'$old$,
	$new$when p_key ~ '^rules/[^/]*\.md$' then 'rule'
		-- 20260929999000 (H1): a human task and a contact.
		when p_key ~ '^human-tasks/[^/]*\.md$' then 'human-task'
		when p_key ~ '^contacts/[^/]*\.md$' then 'contact'$new$);

-- 2. The folder places.
select pg_temp.h1_human_tasks_replace('public.qorpera_structured_folder_names(text)'::regprocedure,
	$old$when p_key = 'agents/groups' then array[]::text[]$old$,
	$new$-- 20260929999000 (H1): the two roots are places, and a task's folder is named.
		when p_key in ('contacts', 'human-tasks') then array[]::text[]
		when p_key ~ '^human-tasks/[^/]+(/proof)?$' then array['2:a human task''s folder']
		when p_key = 'agents/groups' then array[]::text[]$new$);

-- The file's own name, at position 2 as for rules and connections.
select pg_temp.h1_human_tasks_replace('public.qorpera_company_state_path_problems(text,boolean)'::regprocedure,
	$old$elsif v_kind in ('rule','connection') then$old$,
	$new$elsif v_kind in ('rule','connection','human-task','contact') then -- 20260929999000 (H1)$new$);

-- 1. The parse of both kinds is checked by its shape.
select pg_temp.h1_human_tasks_replace('public.qorpera_company_state_checked(jsonb,text,text,jsonb)'::regprocedure,
	$old$if v_kind in ('vision','agent','group','sections','connection','rule','todo','routine') then$old$,
	$new$-- 20260929999000 (H1): a human task's and a contact's parse are checked too.
	if v_kind in ('vision','agent','group','sections','connection','rule','todo','routine','human-task','contact') then$new$);

select pg_temp.h1_human_tasks_replace('public.qorpera_company_state_parse_problems(text,jsonb)'::regprocedure,
	$old$if cardinality(v_bad) = 0 and v_named is null then return '[]'::jsonb; end if;$old$,
	$new$-- 20260929999000 (H1): a human task and a contact (§2), with the parser's limits and cross-key rules.
	if p_kind = 'human-task' then
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from
			array['connection','contact','due','files','from','id','instructions','kind','member','minutes','proof','reason','secret',
				'secretState','status','step','steps','title','todo'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if coalesce(p_parse ->> 'id', '') !~ c_uuid then v_bad := array_append(v_bad, 'id'); end if;
		if not public.qorpera_company_state_one_line(p_parse -> 'title', 1, 200, true) then v_bad := array_append(v_bad, 'title'); end if;
		if coalesce(p_parse ->> 'status', '') not in ('open','done','accepted','returned','declined','cancelled') then
			v_bad := array_append(v_bad, 'status'); end if;
		-- Exactly one person: a member or a contact.
		if (jsonb_typeof(p_parse -> 'member') = 'null') is not distinct from (jsonb_typeof(p_parse -> 'contact') = 'null')
			or (jsonb_typeof(p_parse -> 'member') <> 'null' and coalesce(p_parse ->> 'member', '') !~ c_uuid)
			or (jsonb_typeof(p_parse -> 'contact') <> 'null' and coalesce(p_parse ->> 'contact', '') !~ c_uuid) then
			v_bad := array_append(v_bad, 'member'); end if;
		if coalesce(p_parse ->> 'from', '') !~ c_uuid then v_bad := array_append(v_bad, 'from'); end if;
		if jsonb_typeof(p_parse -> 'todo') is distinct from 'null' and coalesce(p_parse ->> 'todo', '') !~ c_uuid then
			v_bad := array_append(v_bad, 'todo'); end if;
		if not coalesce(public.qorpera_company_state_instant(p_parse -> 'due'), false) then v_bad := array_append(v_bad, 'due'); end if;
		if jsonb_typeof(p_parse -> 'minutes') is distinct from 'null' and (jsonb_typeof(p_parse -> 'minutes') is distinct from 'number'
			or case when (p_parse ->> 'minutes') ~ '^[1-9][0-9]{0,2}$' then (p_parse ->> 'minutes')::integer > 480 else true end) then
			v_bad := array_append(v_bad, 'minutes'); end if;
		if jsonb_typeof(p_parse -> 'proof') is distinct from 'array'
			or exists (select 1 from jsonb_array_elements(p_parse -> 'proof') x
				where jsonb_typeof(x) <> 'string' or (x #>> '{}') not in ('photo','file','signature','note'))
			or (select count(distinct x) from jsonb_array_elements(p_parse -> 'proof') x) <> jsonb_array_length(p_parse -> 'proof') then
			v_bad := array_append(v_bad, 'proof'); end if;
		-- Literal paths the company folder can hold (the core's path rule), one line, at most 20, each once by key; on a
		-- contact's task, none under the roots outside readers may not see.
		if jsonb_typeof(p_parse -> 'files') is distinct from 'array' or jsonb_array_length(p_parse -> 'files') > 20
			or exists (select 1 from jsonb_array_elements(p_parse -> 'files') f
				where jsonb_typeof(f) <> 'string' or (f #>> '{}') ~ '[\x01-\x1f\x7f-\x9f\u2028\u2029]'
					or not public.qorpera_company_path_valid(f #>> '{}')
					or (jsonb_typeof(p_parse -> 'contact') = 'string'
						and public.qorpera_folder_key(f #>> '{}') ~ '^(agents|contacts|human-tasks|connections|rules|hooks)/'))
			or (select count(distinct public.qorpera_folder_key(f #>> '{}')) from jsonb_array_elements(p_parse -> 'files') f)
				<> jsonb_array_length(p_parse -> 'files') then
			v_bad := array_append(v_bad, 'files'); end if;
		-- Why: with returned and declined, allowed with cancelled, and only then.
		if (jsonb_typeof(p_parse -> 'reason') is distinct from 'null'
				and not public.qorpera_company_state_one_line(p_parse -> 'reason', 1, 500, true))
			or (p_parse ->> 'status' in ('returned','declined') and jsonb_typeof(p_parse -> 'reason') is distinct from 'string')
			or (p_parse ->> 'status' not in ('returned','declined','cancelled') and jsonb_typeof(p_parse -> 'reason') is distinct from 'null') then
			v_bad := array_append(v_bad, 'reason'); end if;
		-- A secret's label and its state go together, on a member's task only.
		if (jsonb_typeof(p_parse -> 'secret') = 'null') is distinct from (jsonb_typeof(p_parse -> 'secretState') = 'null')
			or (jsonb_typeof(p_parse -> 'secret') is distinct from 'null'
				and not public.qorpera_company_state_one_line(p_parse -> 'secret', 1, 100, true))
			or (jsonb_typeof(p_parse -> 'secretState') is distinct from 'null'
				and coalesce(p_parse ->> 'secretState', '') not in ('asked','saved'))
			or (jsonb_typeof(p_parse -> 'contact') = 'string' and jsonb_typeof(p_parse -> 'secret') is distinct from 'null') then
			v_bad := array_append(v_bad, 'secret'); end if;
		if jsonb_typeof(p_parse -> 'connection') is distinct from 'null' and coalesce(p_parse ->> 'connection', '') !~ c_uuid then
			v_bad := array_append(v_bad, 'connection'); end if;
		if jsonb_typeof(p_parse -> 'step') is distinct from 'null' and coalesce(p_parse ->> 'step', '') not in
			('sign_in','captcha','phone_code','id_check','payment','create_account','other') then
			v_bad := array_append(v_bad, 'step'); end if;
		if jsonb_typeof(p_parse -> 'instructions') is distinct from 'string'
			or octet_length(p_parse ->> 'instructions') not between 1 and 32768
			or (p_parse ->> 'instructions') <> btrim(p_parse ->> 'instructions', E' \t\n\r') then
			v_bad := array_append(v_bad, 'instructions'); end if;
		-- The checklist: at most 50 steps, each with its line, one line of text and its box.
		if jsonb_typeof(p_parse -> 'steps') is distinct from 'array' or jsonb_array_length(p_parse -> 'steps') > 50
			or exists (select 1 from jsonb_array_elements(p_parse -> 'steps') s
				where jsonb_typeof(s) <> 'object'
					or (select array_agg(k order by k) from jsonb_object_keys(s) k) is distinct from array['done','line','text']
					or jsonb_typeof(s -> 'line') <> 'number' or (s ->> 'line') !~ '^[1-9][0-9]{0,8}$'
					or jsonb_typeof(s -> 'done') <> 'boolean'
					or not public.qorpera_company_state_one_line(s -> 'text', 1, 500, true)) then
			v_bad := array_append(v_bad, 'steps'); end if;
	elsif p_kind = 'contact' then
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from
			array['asks','email','id','kind','name','notes','organization','phone'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if coalesce(p_parse ->> 'id', '') !~ c_uuid then v_bad := array_append(v_bad, 'id'); end if;
		if not public.qorpera_company_state_one_line(p_parse -> 'name', 1, 200, true) then v_bad := array_append(v_bad, 'name'); end if;
		if jsonb_typeof(p_parse -> 'organization') is distinct from 'null'
			and not public.qorpera_company_state_one_line(p_parse -> 'organization', 1, 200, true) then
			v_bad := array_append(v_bad, 'organization'); end if;
		-- An address: printable ASCII without spaces, one @, a domain that neither starts nor ends with a dot.
		if jsonb_typeof(p_parse -> 'email') is distinct from 'null'
			and (not public.qorpera_company_state_one_line(p_parse -> 'email', 3, 254, true)
				or (p_parse ->> 'email') !~ '^[!-?A-~]+@[!-?A-~]+$' or split_part(p_parse ->> 'email', '@', 2) ~ '^[.]|[.]$') then
			v_bad := array_append(v_bad, 'email'); end if;
		if jsonb_typeof(p_parse -> 'phone') is distinct from 'null' and (jsonb_typeof(p_parse -> 'phone') <> 'string'
			or (p_parse ->> 'phone') !~ '^[+][0-9]( ?[0-9]){5,19}$') then
			v_bad := array_append(v_bad, 'phone'); end if;
		if jsonb_typeof(p_parse -> 'asks') is distinct from 'array' or jsonb_array_length(p_parse -> 'asks') > 50
			or exists (select 1 from jsonb_array_elements(p_parse -> 'asks') a
				where not public.qorpera_company_state_one_line(a, 1, 100, true))
			or (select count(distinct a) from jsonb_array_elements(p_parse -> 'asks') a) <> jsonb_array_length(p_parse -> 'asks') then
			v_bad := array_append(v_bad, 'asks'); end if;
		if jsonb_typeof(p_parse -> 'notes') is distinct from 'string' or octet_length(p_parse ->> 'notes') > 32768
			or (p_parse ->> 'notes') <> btrim(p_parse ->> 'notes', E' \t\n\r') then
			v_bad := array_append(v_bad, 'notes'); end if;
	end if;
	if cardinality(v_bad) = 0 and v_named is null then return '[]'::jsonb; end if;$new$);

-- 3. A folder moved or copied into or out of the two roots is checked entry by entry.
select pg_temp.h1_human_tasks_replace('public.qorpera_company_state_carried(uuid,text,text,text,public.qorpera_folder_entries)'::regprocedure,
	$old$-- A folder: nothing below a root outside agents/, vision/, connections/ and rules/ can be structured, on either side.$old$,
	$new$-- A folder: nothing below a root outside agents/, vision/, connections/, rules/, human-tasks/ and contacts/ can be
	-- structured, on either side (20260929999000, H1).$new$);
select pg_temp.h1_human_tasks_replace('public.qorpera_company_state_carried(uuid,text,text,text,public.qorpera_folder_entries)'::regprocedure,
	$old$if p_from_key !~ '^(agents|vision|connections|rules)(/|$)' and v_to_key !~ '^(agents|vision|connections|rules)(/|$)' then$old$,
	$new$if p_from_key !~ '^(agents|vision|connections|rules|human-tasks|contacts)(/|$)'
		and v_to_key !~ '^(agents|vision|connections|rules|human-tasks|contacts)(/|$)' then$new$);

-- 4. Only the platform marks a secret saved. Anyone else keeps the mark only over a file that already had it, for the
-- same task and label: the value is bound to the task's id in the vault (H2), so a save cannot claim a value it never had.
select pg_temp.h1_human_tasks_replace('public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$		end if;
	end loop;
	return jsonb_build_object('ok', true);
end$old$,
	$new$		elsif v_checked ->> 'kind' = 'human-task' then
			-- 20260929999000 (H1): only the platform marks a secret saved.
			if v_checked -> 'parse' ->> 'secretState' = 'saved' and p_actor ->> 'kind' is distinct from 'platform'
				and not exists (select 1 from public.qorpera_folder_entries e
					join public.qorpera_folder_path_versions v on v.version = e.version
					where e.environment_id = p_environment_id and e.key_sha256 = extensions.digest(v_file.key, 'sha256')
						and e.kind = 'file' and v.structured ->> 'kind' = 'human-task'
						and v.structured -> 'parse' ->> 'secretState' = 'saved'
						and v.structured -> 'parse' ->> 'id' = v_checked -> 'parse' ->> 'id'
						and v.structured -> 'parse' ->> 'secret' = v_checked -> 'parse' ->> 'secret') then
				return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', null, 'secret_state',
						'only the platform marks a secret saved; write secret_state: asked'))); end if;
		end if;
	end loop;
	return jsonb_build_object('ok', true);
end$new$);
