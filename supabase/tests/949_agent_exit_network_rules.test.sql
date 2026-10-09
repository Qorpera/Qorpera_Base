-- The agent exit, E8a (deploy/first-node/RUNTIME-AGENT-EXIT.md §10): a company's network rules on the folder core.
-- rules/network.toml is its own structured kind; owners and admins write, delete and restore it, and agents read it;
-- it never moves, and no folder takes its name; the database checks its parse's shape and keeps one row per
-- environment, which verify checks; the nodes' login (qorpera_agent_exit) calls one function, the rules of the companies
-- it asks for, the latest save first.
begin;

insert into auth.users(id,email) values
	('94900000-0000-4000-8000-000000000001','exit-owner@example.test'),
	('94900000-0000-4000-8000-000000000002','exit-member@example.test'),
	('94900000-0000-4000-8000-000000000003','exit-admin@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id) values ('94900000-0000-4000-8000-000000000010','Nordlys Exit','94900000-0000-4000-8000-000000000001'), ('94900000-0000-4000-8000-000000000011','Second','94900000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('94900000-0000-4000-8000-000000000010','94900000-0000-4000-8000-000000000001','exit-owner@example.test','Owner','owner'),
	('94900000-0000-4000-8000-000000000010','94900000-0000-4000-8000-000000000002','exit-member@example.test','Member','contributor'),
	('94900000-0000-4000-8000-000000000010','94900000-0000-4000-8000-000000000003','exit-admin@example.test','Admin','admin'),
	('94900000-0000-4000-8000-000000000011','94900000-0000-4000-8000-000000000001','exit-owner@example.test','Owner','owner');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id) values
	('94900000-0000-4000-8000-000000000020','94900000-0000-4000-8000-000000000010','Environment',1,'94900000-0000-4000-8000-000000000001'), ('94900000-0000-4000-8000-000000000021','94900000-0000-4000-8000-000000000011','Environment',1,'94900000-0000-4000-8000-000000000001'), ('94900000-0000-4000-8000-000000000022','94900000-0000-4000-8000-000000000010','Other environment',1,'94900000-0000-4000-8000-000000000001');

select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
select public.qorpera_folder_enable('94900000-0000-4000-8000-000000000020') \g /dev/null
-- Verified version-2 bytes for a text, as the object gateway leaves them: the platform stages them.
create function pg_temp.manifest_v2(p_text text) returns text language sql immutable as $$
	select format('{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"%s","bytes":%s,"mediaType":"text/markdown","executable":false,"chunks":[%s]}',
		encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex'), octet_length(convert_to(p_text, 'utf8')),
		case when p_text = '' then '' else format('{"sha256":"%s","bytes":%s}', encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex'),
			octet_length(convert_to(p_text, 'utf8'))) end)
$$;
-- Opens an intent for a manifest as the actor, confirms each object the open did not report present (the manifest's
-- chunks and the manifest itself, by hash and size, as the gateway does once it has stored them), and seals it.
create function pg_temp.seal_v2(p_env uuid, p_actor jsonb, p_manifest text) returns jsonb language plpgsql as $$
declare v_open jsonb := public.qorpera_folder_open_upload(p_env, p_actor, p_manifest); v_object jsonb;
begin
	for v_object in select c from jsonb_array_elements(p_manifest::jsonb -> 'chunks') c
		union all select jsonb_build_object('sha256', encode(extensions.digest(convert_to(p_manifest, 'utf8'), 'sha256'), 'hex'),
			'bytes', octet_length(convert_to(p_manifest, 'utf8'))) loop
		if not (v_open -> 'present') ? (v_object ->> 'sha256') then
			perform public.qorpera_folder_confirm_object(p_env, p_actor, (v_open ->> 'intentId')::uuid, v_object ->> 'sha256',
				(v_object ->> 'bytes')::bigint);
		end if;
	end loop;
	return public.qorpera_folder_seal_upload(p_env, p_actor, (v_open ->> 'intentId')::uuid);
end $$;
-- The platform stages the text in each folder-v2 environment of the company (an intent is one environment's).
create function pg_temp.stage(p_text text, p_profile uuid default '94900000-0000-4000-8000-000000000010') returns jsonb language plpgsql as $$
declare v_env uuid; v_seal jsonb;
begin
	for v_env in select environment_id from public.qorpera_company_files where profile_id = p_profile and core = 'folder-v2'
		order by environment_id loop
		v_seal := pg_temp.seal_v2(v_env, '{"kind":"platform"}', pg_temp.manifest_v2(p_text));
		if v_seal ->> 'state' is distinct from 'sealed' then raise exception 'Fixture staging: %', v_seal; end if;
	end loop;
	if v_seal is null then raise exception 'Fixture staging: the company has no folder-v2 environment'; end if;
	return v_seal -> 'file';
end $$;
-- A version-2 file is held to possession (C1D §3): before an actor other than the platform commits units, it stages
-- each of their files itself, as its own upload would. An actor that may not stage (42501) or a stopped company (55000)
-- is left to the commit's own refusal; any other error is a fixture defect and surfaces.
create function pg_temp.possess(p_env uuid, p_actor jsonb, p_units jsonb) returns void language plpgsql as $$
declare v_manifest text;
begin
	if p_actor ->> 'kind' is not distinct from 'platform' or jsonb_typeof(p_units) is distinct from 'array' then return; end if;
	for v_manifest in select distinct i.manifest_text from jsonb_array_elements(p_units) u
		cross join lateral (select u -> 'file' as f union all select c -> 'file' from jsonb_array_elements(
			case when jsonb_typeof(u -> 'contents') = 'array' then u -> 'contents' else '[]'::jsonb end) c) refs
		join public.qorpera_folder_upload_intents i on i.environment_id = p_env and i.manifest_sha256 = refs.f ->> 'manifestSha256'
		where refs.f is not null loop
		begin
			perform pg_temp.seal_v2(p_env, p_actor, v_manifest);
		exception when insufficient_privilege or object_not_in_prerequisite_state then null;
		end;
	end loop;
end $$;
-- A commit in any environment, as its actor: takes possession of the actor's files first.
create function pg_temp.commit_in(p_env uuid, p_actor jsonb, p_key text, p_units jsonb) returns jsonb language plpgsql as $$
begin
	perform pg_temp.possess(p_env, p_actor, p_units);
	return public.qorpera_folder_commit(p_env, p_actor, p_key, p_units);
end $$;
create function pg_temp.commit(p_actor jsonb, p_key text, p_units jsonb) returns jsonb language sql as $$
	select pg_temp.commit_in('94900000-0000-4000-8000-000000000020', p_actor, p_key, p_units)
$$;

-- A structured entry as the TS parser sends it.
create function pg_temp.entry(p_path text, p_kind text, p_text text, p_parse jsonb) returns jsonb language sql as $$
	select jsonb_build_object('path', p_path, 'kind', p_kind, 'text', p_text, 'parse', p_parse, 'parserVersion', 1)
$$;
create function pg_temp.write(p_path text, p_kind text, p_text text, p_parse jsonb, p_expected uuid default null) returns jsonb language sql as $$
	select jsonb_build_object('op','write','path',p_path,'file',pg_temp.stage(p_text),
		'structured', jsonb_build_array(pg_temp.entry(p_path, p_kind, p_text, p_parse)))
		|| case when p_expected is not null then jsonb_build_object('expectedVersion', p_expected) else '{}'::jsonb end
$$;
create function pg_temp.agent_text(p_id uuid, p_name text, p_kind text default 'agent', p_status text default 'active')
returns text language sql as $$
	select format(E'---\nid: %s\nname: %s\nrole: Sales\nkind: %s\nstatus: %s\n---\nSell.\n', p_id, p_name, p_kind, p_status)
$$;
create function pg_temp.agent_parse(p_id uuid, p_name text, p_kind text default 'agent', p_status text default 'active')
returns jsonb language sql as $$
	select jsonb_build_object('kind','agent','id',p_id,'name',p_name,'role','Sales','agentKind',p_kind,'status',p_status,
		'colour',null,'figure',null,'model',null,'effort',null,'instructions','Sell.')
$$;
-- A new agent folder with its agent.md, as one unit.
create function pg_temp.hire(p_handle text, p_id uuid, p_name text, p_kind text default 'agent') returns jsonb language sql as $$
	select jsonb_build_object('op','new_folder','path','agents/' || p_handle,
		'contents', jsonb_build_array(
			jsonb_build_object('path','agent.md','kind','file','file',pg_temp.stage(pg_temp.agent_text(p_id, p_name, p_kind))),
			jsonb_build_object('path','memory','kind','folder'), jsonb_build_object('path','todos','kind','folder')),
		'structured', jsonb_build_array(pg_temp.entry('agents/' || p_handle || '/agent.md', 'agent',
			pg_temp.agent_text(p_id, p_name, p_kind), pg_temp.agent_parse(p_id, p_name, p_kind))))
$$;
create function pg_temp.version(p_key text, p_env uuid default '94900000-0000-4000-8000-000000000020') returns uuid language sql as $$
	select version from public.qorpera_folder_entries where environment_id = p_env and key_text = p_key
$$;
create function pg_temp.seq() returns bigint language sql as $$
	select last_seq from public.qorpera_folder_clocks where environment_id = '94900000-0000-4000-8000-000000000020'
$$;
create function pg_temp.vision(p_name text) returns jsonb language sql as $$
	select pg_temp.write('vision/vision.md', 'vision', E'# ' || p_name || E'\n\n## What we build\n',
		jsonb_build_object('kind','vision','name',p_name), pg_temp.version('vision/vision.md'))
$$;
create function pg_temp.member(p_user text) returns jsonb language sql as $$
	select jsonb_build_object('kind','member','userId','94900000-0000-4000-8000-00000000000' || p_user)
$$;
create function pg_temp.owner() returns jsonb language sql as $$ select pg_temp.member('1') $$;
create function pg_temp.expect(p_result jsonb, p_unit integer, p_outcome text, p_reason text default null)
returns jsonb language plpgsql as $$
declare v jsonb := p_result -> 'units' -> (p_unit - 1);
begin
	if v ->> 'outcome' is distinct from p_outcome or v ->> 'reason' is distinct from p_reason then
		raise exception 'Unit % expected % (%), got %', p_unit, p_outcome, p_reason, p_result using errcode = 'QTF01'; end if;
	return v;
end $$;
create function pg_temp.refused(p_result jsonb, p_reason text default 'structured_invalid') returns boolean language sql as $$
	select coalesce(p_result -> 'units' -> 0 ->> 'outcome' = 'refused' and p_result -> 'units' -> 0 ->> 'reason' = p_reason, false)
$$;
-- Refused because the parse breaks the named rules of its shape.
create function pg_temp.invalid(p_result jsonb, p_bad text) returns boolean language sql as $$
	select pg_temp.refused(p_result) and coalesce(p_result -> 'units' -> 0 -> 'problems' -> 0 ->> 'message'
		= 'the platform read this file differently from its rules (' || p_bad || ')', false)
$$;

-- The network rules: a parse, the text it was read from, and a write of the file.
create function pg_temp.rules(p_mode text, p_block jsonb, p_allow jsonb) returns jsonb language sql as $$
	select jsonb_build_object('kind','network-rules','mode',p_mode,'block',p_block,'allow',p_allow)
$$;
create function pg_temp.rules_text(p_parse jsonb) returns text language sql as $$
	select format(E'mode = %s\nblock = %s\nallow = %s\n', p_parse -> 'mode', p_parse -> 'block', p_parse -> 'allow')
$$;
create function pg_temp.network(p_parse jsonb, p_path text default 'rules/network.toml', p_kind text default 'network-rules')
returns jsonb language sql as $$
	select pg_temp.write(p_path, p_kind, pg_temp.rules_text(p_parse), p_parse, pg_temp.version('rules/network.toml'))
$$;
create function pg_temp.row(p_env uuid default '94900000-0000-4000-8000-000000000020') returns public.qorpera_company_network_rules language sql as $$
	select * from public.qorpera_company_network_rules where environment_id = p_env
$$;
create function pg_temp.commit_id(p_key text, p_env uuid default '94900000-0000-4000-8000-000000000020') returns uuid language sql as $$
	select id from public.qorpera_folder_commits where environment_id = p_env and operation_key = p_key
$$;

-- 1. The company, and an owner's rules ----------------------------------------------------------------------------------

do $$
declare r jsonb; i integer; t jsonb; x public.qorpera_company_network_rules; p jsonb;
begin
	if public.qorpera_structured_path_kind('rules/network.toml') is distinct from 'network-rules'
		or public.qorpera_structured_path_kind('rules/network.md') is distinct from 'rule'
		or public.qorpera_structured_path_kind('rules/other.toml') is not null
		or public.qorpera_structured_path_kind('rules/sub/network.toml') is not null
		or public.qorpera_structured_path_kind('network.toml') is not null then
		raise exception 'Only rules/network.toml is the network rules'; end if;
	r := pg_temp.commit('{"kind":"platform"}', 'seed-0001', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','vision'), pg_temp.vision('Nordlys Exit'),
		jsonb_build_object('op','mkdir','path','agents'),
		pg_temp.write('agents/sections.md', 'sections', E'# Sections\n', '{"kind":"sections","sections":[]}'),
		pg_temp.hire('co-founder', '94900000-0000-4000-8000-0000000000c0', 'Co-Founder', 'co-founder'),
		jsonb_build_object('op','mkdir','path','rules')));
	for i in 1..6 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	p := pg_temp.rules('only-listed', '["casino.example","*.torrents.example"]', '["github.com","*.npmjs.org","pypi.org"]');
	-- A save locks nothing before the paths: the row's one key is the folder's clock, which the commit holds.
	select coalesce(jsonb_agg(to_jsonb(y)), '[]'::jsonb) into t from public.qorpera_folder_structured_targets('94900000-0000-4000-8000-000000000020',
		pg_temp.owner(), jsonb_build_array(pg_temp.network(p))) y;
	if t is distinct from '[]'::jsonb then raise exception 'A network rules save locks nothing first: %', t; end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'exit-0001', jsonb_build_array(pg_temp.network(p))), 1, 'saved');
	x := pg_temp.row();
	if x.profile_id is distinct from '94900000-0000-4000-8000-000000000010' or x.mode is distinct from 'only-listed'
		or x.block is distinct from array['casino.example','*.torrents.example']
		or x.allow is distinct from array['github.com','*.npmjs.org','pypi.org']
		or x.folder_path_version is distinct from pg_temp.version('rules/network.toml')
		or x.commit_id is distinct from pg_temp.commit_id('exit-0001') then
		raise exception 'The file is the company''s rules, in its order: %', to_jsonb(x); end if;
	if (select structured from public.qorpera_folder_path_versions where commit_id = x.commit_id and version = x.folder_path_version)
		is distinct from jsonb_build_object('kind','network-rules','parse',p,'parserVersion',1) then
		raise exception 'The version keeps the network rules'' parse'; end if;
	if exists (select 1 from public.qorpera_review_rules where profile_id = '94900000-0000-4000-8000-000000000010') then
		raise exception 'The network rules are not a review rule'; end if;
	if exists (select 1 from public.qorpera_company_network_rules where profile_id = '94900000-0000-4000-8000-000000000011') then
		raise exception 'Another company has no rules'; end if;
end $$;

-- 2. The shape -------------------------------------------------------------------------------------------------------------

do $$
declare x public.qorpera_company_network_rules := pg_temp.row(); r jsonb;
begin
	-- The names: as the exit's resolver matches them, as the parser's isNetworkRulesName.
	if not (public.qorpera_company_network_rules_name_valid('example.com') and public.qorpera_company_network_rules_name_valid('*.example.com')
		and public.qorpera_company_network_rules_name_valid('localhost') and public.qorpera_company_network_rules_name_valid('a-b.c0.example')
		and public.qorpera_company_network_rules_name_valid('xn--bcher-kva.example') and public.qorpera_company_network_rules_name_valid('3com.example')
		and public.qorpera_company_network_rules_name_valid('example.123a')
		and public.qorpera_company_network_rules_name_valid(repeat('a',63) || '.example')
		and public.qorpera_company_network_rules_name_valid(repeat('a',63) || '.' || repeat('b',63) || '.' || repeat('c',63) || '.' || repeat('d',61))
		and public.qorpera_company_network_rules_name_valid('*.' || repeat('a',63) || '.' || repeat('b',63) || '.' || repeat('c',63) || '.' || repeat('d',61))) then
		raise exception 'Names are lowercase labels, with *. in front for the names under one'; end if;
	if public.qorpera_company_network_rules_name_valid(repeat('a',63) || '.' || repeat('b',63) || '.' || repeat('c',63) || '.' || repeat('d',62))
		or public.qorpera_company_network_rules_name_valid(repeat('a',64) || '.example')
		or public.qorpera_company_network_rules_name_valid('Example.com') or public.qorpera_company_network_rules_name_valid('example.com.')
		or public.qorpera_company_network_rules_name_valid('https://example.com') or public.qorpera_company_network_rules_name_valid('example.com/x')
		or public.qorpera_company_network_rules_name_valid('a.*.example.com') or public.qorpera_company_network_rules_name_valid('*example.com')
		or public.qorpera_company_network_rules_name_valid('*') or public.qorpera_company_network_rules_name_valid('*.')
		or public.qorpera_company_network_rules_name_valid('ex_ample.com') or public.qorpera_company_network_rules_name_valid('-example.com')
		or public.qorpera_company_network_rules_name_valid('example-.com') or public.qorpera_company_network_rules_name_valid('a..example')
		or public.qorpera_company_network_rules_name_valid('.example.com') or public.qorpera_company_network_rules_name_valid('')
		or public.qorpera_company_network_rules_name_valid('10.0.0.1') or public.qorpera_company_network_rules_name_valid('*.10.0.0.1')
		or public.qorpera_company_network_rules_name_valid('1234') or public.qorpera_company_network_rules_name_valid('example.com:443')
		or public.qorpera_company_network_rules_name_valid('[::1]') or public.qorpera_company_network_rules_name_valid(E'example.com\n')
		or public.qorpera_company_network_rules_name_valid('bücher.example') or public.qorpera_company_network_rules_name_valid(null) is not false then
		raise exception 'Anything else is not a name'; end if;
	if not public.qorpera_company_network_rules_list_valid('[]')
		or not public.qorpera_company_network_rules_list_valid((select jsonb_agg('n' || g || '.example') from generate_series(1, 1000) g))
		or public.qorpera_company_network_rules_list_valid((select jsonb_agg('n' || g || '.example') from generate_series(1, 1001) g))
		or public.qorpera_company_network_rules_list_valid('["a.example","a.example"]')
		or public.qorpera_company_network_rules_list_valid('["a.example",1]') or public.qorpera_company_network_rules_list_valid('["a.example",null]')
		or public.qorpera_company_network_rules_list_valid('[["a.example"]]') or public.qorpera_company_network_rules_list_valid('"a.example"')
		or public.qorpera_company_network_rules_list_valid('{}') or public.qorpera_company_network_rules_list_valid('null')
		or public.qorpera_company_network_rules_list_valid(null) is not false then
		raise exception 'A list is at most 1000 names, each once'; end if;
	-- A file the parse does not hold is refused, and the rules stay.
	if not pg_temp.invalid(pg_temp.commit(pg_temp.owner(), 'shape-0001', jsonb_build_array(pg_temp.network(
		pg_temp.rules('closed', '[]', '[]')))), 'mode') then raise exception 'mode is open or only-listed'; end if;
	if not pg_temp.invalid(pg_temp.commit(pg_temp.owner(), 'shape-0002', jsonb_build_array(pg_temp.network(
		jsonb_build_object('kind','network-rules','mode',1,'block','[]'::jsonb,'allow','[]'::jsonb)))), 'mode') then
		raise exception 'mode is a text'; end if;
	if not pg_temp.invalid(pg_temp.commit(pg_temp.owner(), 'shape-0003', jsonb_build_array(pg_temp.network(
		pg_temp.rules('open', '[]', '[]') || '{"extra":[]}'))), 'keys') then raise exception 'The parse has no other keys'; end if;
	if not pg_temp.invalid(pg_temp.commit(pg_temp.owner(), 'shape-0004', jsonb_build_array(pg_temp.network(
		pg_temp.rules('open', '[]', '[]') - 'allow'))), 'keys, allow') then raise exception 'The parse has every key'; end if;
	if not pg_temp.invalid(pg_temp.commit(pg_temp.owner(), 'shape-0005', jsonb_build_array(pg_temp.network(
		pg_temp.rules('open', '["Example.com"]', '[]')))), 'block') then raise exception 'A blocked entry is a name'; end if;
	if not pg_temp.invalid(pg_temp.commit(pg_temp.owner(), 'shape-0006', jsonb_build_array(pg_temp.network(
		pg_temp.rules('open', '[]', '["github.com","github.com"]')))), 'allow') then raise exception 'A list holds a name once'; end if;
	if not pg_temp.invalid(pg_temp.commit(pg_temp.owner(), 'shape-0007', jsonb_build_array(pg_temp.network(
		pg_temp.rules('only-listed', '["github.com"]', '["pypi.org","github.com"]')))), 'overlap') then
		raise exception 'A name is in one list'; end if;
	if not pg_temp.invalid(pg_temp.commit(pg_temp.owner(), 'shape-0008', jsonb_build_array(pg_temp.network(
		pg_temp.rules('open', (select jsonb_agg('n' || g || '.example') from generate_series(1, 1001) g), '[]')))), 'block') then
		raise exception 'A list holds at most 1000 names'; end if;
	if not pg_temp.invalid(pg_temp.commit(pg_temp.owner(), 'shape-0009', jsonb_build_array(pg_temp.network(
		pg_temp.rules('open', '"github.com"', '[]')))), 'block') then raise exception 'A list is a list'; end if;
	if not pg_temp.invalid(pg_temp.commit(pg_temp.owner(), 'shape-0010', jsonb_build_array(pg_temp.network(
		pg_temp.rules('open', '[]', '[443]')))), 'allow') then raise exception 'A list holds texts'; end if;
	-- The path is written in lowercase; a parse of another kind, or a writer's problems, are not the rules.
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'shape-0011', jsonb_build_array(pg_temp.network(
		pg_temp.rules('open', '[]', '[]'), 'rules/Network.toml')))) then raise exception 'The path is in lowercase'; end if;
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'shape-0012', jsonb_build_array(pg_temp.network(
		jsonb_build_object('kind','rule','id','94900000-0000-4000-8000-0000000000f1','outcome','ask-first','text','open'),
		'rules/network.toml', 'rule')))) then raise exception 'The file is not a review rule'; end if;
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'shape-0013', jsonb_build_array(pg_temp.network(
		jsonb_build_object('kind','rule','mode','open','block','[]'::jsonb,'allow','[]'::jsonb))))) then
		raise exception 'The parse is of the file''s kind'; end if;
	r := pg_temp.write('rules/network.toml', 'network-rules', E'mode = "shut"\n', null, pg_temp.version('rules/network.toml'));
	r := jsonb_set(r, '{structured,0}', (r -> 'structured' -> 0) - 'parse' || jsonb_build_object('problems', jsonb_build_array(
		jsonb_build_object('line',1,'key','mode','code','bad_value','message','mode must be one of: open, only-listed.'))));
	r := pg_temp.commit(pg_temp.owner(), 'shape-0014', jsonb_build_array(r));
	if not pg_temp.refused(r) or r -> 'units' -> 0 -> 'problems' -> 0 ->> 'message' is distinct from 'mode must be one of: open, only-listed.' then
		raise exception 'A writer''s problems refuse the file: %', r; end if;
	if to_jsonb(pg_temp.row()) is distinct from to_jsonb(x) then raise exception 'A refused file leaves the rules: %', to_jsonb(pg_temp.row()); end if;
	-- 1000 names in a list, and the same name blocked twice over by a *. entry, are fine.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'shape-0015', jsonb_build_array(pg_temp.network(pg_temp.rules('open',
		(select jsonb_agg('n' || g || '.example') from generate_series(1, 1000) g), '["example.org","*.example.org"]')))), 1, 'saved');
	if cardinality((pg_temp.row()).block) <> 1000 or (pg_temp.row()).block[1000] is distinct from 'n1000.example' then
		raise exception 'A list of 1000 names is kept whole'; end if;
end $$;

-- 3. Edits, a delete and a restore ----------------------------------------------------------------------------------

do $$
declare x public.qorpera_company_network_rules; v uuid; n integer;
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'edit-0001', jsonb_build_array(pg_temp.network(
		pg_temp.rules('open', '["ads.example"]', '["github.com"]')))), 1, 'saved');
	x := pg_temp.row();
	if x.mode is distinct from 'open' or x.block is distinct from array['ads.example'] or x.allow is distinct from array['github.com']
		or x.folder_path_version is distinct from pg_temp.version('rules/network.toml') or x.commit_id is distinct from pg_temp.commit_id('edit-0001') then
		raise exception 'An edit reaches the rules: %', to_jsonb(x); end if;
	select count(*) into n from public.qorpera_company_network_rules where profile_id = '94900000-0000-4000-8000-000000000010';
	if n <> 1 then raise exception 'One row per environment'; end if;
	if (select to_jsonb(y) - 'updated_at' from public.qorpera_agent_exit_network_rules(array['94900000-0000-4000-8000-000000000010',
		'94900000-0000-4000-8000-000000000011']::uuid[]) y) is distinct from jsonb_build_object('company_id','94900000-0000-4000-8000-000000000010',
		'version',x.folder_path_version,'mode','open','block',jsonb_build_array('ads.example'),'allow',jsonb_build_array('github.com')) then
		raise exception 'The nodes read the company''s rules, and none for a company without the file'; end if;
	v := x.folder_path_version;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'delete-0001', jsonb_build_array(jsonb_build_object('op','delete',
		'path','rules/network.toml','expectedVersion',pg_temp.version('rules/network.toml')))), 1, 'saved');
	if pg_temp.row() is not null or exists (select 1 from public.qorpera_agent_exit_network_rules(array['94900000-0000-4000-8000-000000000010']::uuid[])) then
		raise exception 'Deleting the file opens the company'; end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'restore-0001', jsonb_build_array(pg_temp.network(
		pg_temp.rules('only-listed', '["z.example","a.example","m.example"]', '[]')))), 1, 'saved');
	x := pg_temp.row();
	if x.mode is distinct from 'only-listed' or x.block is distinct from array['z.example','a.example','m.example'] or x.allow is distinct from '{}'::text[]
		or x.folder_path_version is distinct from pg_temp.version('rules/network.toml') or x.folder_path_version = v then
		raise exception 'A restore writes the rules again: %', to_jsonb(x); end if;
end $$;

-- 4. Who writes them --------------------------------------------------------------------------------------------------------

do $$
declare x public.qorpera_company_network_rules := pg_temp.row(); r jsonb; v_rules public.qorpera_company_path_resources;
begin
	r := pg_temp.commit(pg_temp.member('2'), 'member-0001', jsonb_build_array(pg_temp.network(pg_temp.rules('open', '[]', '[]'))));
	perform pg_temp.expect(r, 1, 'denied', 'denied');
	r := pg_temp.commit(pg_temp.member('2'), 'member-0002', jsonb_build_array(jsonb_build_object('op','delete',
		'path','rules/network.toml','expectedVersion',pg_temp.version('rules/network.toml'))));
	perform pg_temp.expect(r, 1, 'denied', 'denied');
	if to_jsonb(pg_temp.row()) is distinct from to_jsonb(x) then raise exception 'A contributor leaves the rules alone'; end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.member('3'), 'admin-0001', jsonb_build_array(pg_temp.network(
		pg_temp.rules('only-listed', '["z.example"]', '["github.com"]')))), 1, 'saved');
	if (pg_temp.row()).allow is distinct from array['github.com'] or (pg_temp.row()).commit_id is distinct from pg_temp.commit_id('admin-0001') then
		raise exception 'An admin writes the rules'; end if;
	-- Agents read the file and never write it (rules/ is the company_rules scope).
	v_rules := public.qorpera_folder_path_resource('94900000-0000-4000-8000-000000000020', 'rules/network.toml');
	if v_rules.scope is distinct from 'company_rules'
		or not public.qorpera_folder_principal_allowed('94900000-0000-4000-8000-000000000010', v_rules, 'staff_agent', '94900000-0000-4000-8000-0000000000c0', 'read')
		or public.qorpera_folder_principal_allowed('94900000-0000-4000-8000-000000000010', v_rules, 'staff_agent', '94900000-0000-4000-8000-0000000000c0', 'write')
		or not public.qorpera_folder_principal_allowed('94900000-0000-4000-8000-000000000010', v_rules, 'member', '94900000-0000-4000-8000-000000000002', 'read') then
		raise exception 'Agents and members read the rules; owners and admins write them'; end if;
end $$;

-- 5. The file never moves, and no folder takes its name ---------------------------------------------------------------------

do $$
declare r jsonb; x public.qorpera_company_network_rules := pg_temp.row();
begin
	r := pg_temp.commit(pg_temp.owner(), 'move-0001', jsonb_build_array(
		jsonb_build_object('op','move','from','rules/network.toml','to','rules/old.toml','expectedVersion',pg_temp.version('rules/network.toml')),
		jsonb_build_object('op','copy','from','rules/network.toml','to','rules/copy.toml'),
		jsonb_build_object('op','delete','path','rules','expectedVersion',pg_temp.version('rules'),'asOfSeq',pg_temp.seq()),
		jsonb_build_object('op','move','from','rules','to','old-rules','expectedVersion',pg_temp.version('rules'),'asOfSeq',pg_temp.seq())));
	perform pg_temp.expect(r, 1, 'refused', 'kind_change'); perform pg_temp.expect(r, 2, 'refused', 'kind_change');
	perform pg_temp.expect(r, 3, 'refused', 'seeded'); perform pg_temp.expect(r, 4, 'refused', 'seeded');
	-- Nor does another file move or copy onto the path.
	r := pg_temp.commit(pg_temp.owner(), 'move-0002', jsonb_build_array(jsonb_build_object('op','delete',
		'path','rules/network.toml','expectedVersion',pg_temp.version('rules/network.toml')),
		jsonb_build_object('op','write','path','rules/draft.toml','file',pg_temp.stage(E'mode = "open"\n'))));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved');
	r := pg_temp.commit(pg_temp.owner(), 'move-0003', jsonb_build_array(
		jsonb_build_object('op','move','from','rules/draft.toml','to','rules/network.toml','expectedVersion',pg_temp.version('rules/draft.toml')),
		jsonb_build_object('op','copy','from','rules/draft.toml','to','rules/network.toml')));
	perform pg_temp.expect(r, 1, 'refused', 'kind_change'); perform pg_temp.expect(r, 2, 'refused', 'structured_copy');
	if pg_temp.row() is not null or pg_temp.version('rules/network.toml') is not null then raise exception 'Nothing reached the path'; end if;
	-- Nor does a folder take its name: made there, or moved or copied there.
	r := pg_temp.commit(pg_temp.owner(), 'move-0004', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','rules/network.toml'),
		jsonb_build_object('op','new_folder','path','Rules/Network.TOML','contents','[]'::jsonb),
		jsonb_build_object('op','mkdir','path','rules/drafts')));
	perform pg_temp.expect(r, 1, 'refused', 'structured_invalid'); perform pg_temp.expect(r, 2, 'refused', 'structured_invalid');
	perform pg_temp.expect(r, 3, 'saved');
	if r -> 'units' -> 0 -> 'problems' is distinct from jsonb_build_array(jsonb_build_object('code','name',
		'message','rules/network.toml is the name of the network rules file, not a folder')) then
		raise exception 'A folder at the path is refused by its name: %', r; end if;
	r := pg_temp.commit(pg_temp.owner(), 'move-0005', jsonb_build_array(
		jsonb_build_object('op','move','from','rules/drafts','to','rules/network.toml','expectedVersion',pg_temp.version('rules/drafts'),
			'asOfSeq',pg_temp.seq()),
		jsonb_build_object('op','copy','from','rules/drafts','to','rules/network.toml')));
	perform pg_temp.expect(r, 1, 'refused', 'structured_invalid'); perform pg_temp.expect(r, 2, 'refused', 'structured_invalid');
	if pg_temp.version('rules/network.toml') is not null then raise exception 'No folder reached the path'; end if;
	-- Another folder in rules/ still moves, with a file of that name in it.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'move-0006', jsonb_build_array(jsonb_build_object('op','write',
		'path','rules/drafts/network.toml','file',pg_temp.stage(E'mode = "open"\n')))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'move-0007', jsonb_build_array(jsonb_build_object('op','move',
		'from','rules/drafts','to','rules/old-drafts','expectedVersion',pg_temp.version('rules/drafts'),'asOfSeq',pg_temp.seq()))), 1, 'saved');
	if pg_temp.version('rules/old-drafts/network.toml') is null or pg_temp.row() is not null then
		raise exception 'A folder with a network.toml in it moves as any folder'; end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'move-0008', jsonb_build_array(pg_temp.network(
		pg_temp.rules(x.mode, to_jsonb(x.block), to_jsonb(x.allow))))), 1, 'saved');
	if (pg_temp.row()).mode is distinct from x.mode or (pg_temp.row()).block is distinct from x.block or (pg_temp.row()).allow is distinct from x.allow then
		raise exception 'The rules are back'; end if;
end $$;

-- 6. Verify: the row points at its file's current version ------------------------------------------------------------------

do $$
declare c uuid;
begin
	update public.qorpera_company_network_rules set folder_path_version = extensions.gen_random_uuid()
	where environment_id = '94900000-0000-4000-8000-000000000020' returning commit_id into c;
	begin
		perform public.qorpera_folder_structured_verify('94900000-0000-4000-8000-000000000020', c);
		raise exception 'verify passed a network rules row off its file' using errcode = 'QTF02';
	exception when sqlstate 'XX000' then null;
	end;
	update public.qorpera_company_network_rules set folder_path_version = pg_temp.version('rules/network.toml')
	where environment_id = '94900000-0000-4000-8000-000000000020';
	perform public.qorpera_folder_structured_verify('94900000-0000-4000-8000-000000000020', c);
end $$;

-- 7. The nodes' login calls one function -------------------------------------------------------------------------------------

do $$
declare
	v_want jsonb := jsonb_build_object('company_id','94900000-0000-4000-8000-000000000010','version',pg_temp.version('rules/network.toml'),
		'mode','only-listed','block',to_jsonb((pg_temp.row()).block),'allow',to_jsonb((pg_temp.row()).allow));
	v_got jsonb; v_functions text[]; v_role text;
begin
	set local role qorpera_agent_exit;
	select jsonb_agg(to_jsonb(y) - 'updated_at') into v_got from public.qorpera_agent_exit_network_rules(array['94900000-0000-4000-8000-000000000010',
		'94900000-0000-4000-8000-000000000011', '94900000-0000-4000-8000-0000000000ff']::uuid[]) y;
	if v_got is distinct from jsonb_build_array(v_want) then raise exception 'The exit reads the rules of the companies it asks for: %', v_got; end if;
	if exists (select 1 from public.qorpera_agent_exit_network_rules('{}'::uuid[]))
		or exists (select 1 from public.qorpera_agent_exit_network_rules(array(select gen_random_uuid() from generate_series(1, 10000)))) then
		raise exception 'Unknown companies have no rules'; end if;
	begin
		perform public.qorpera_agent_exit_network_rules(null);
		raise exception 'A call names its companies' using errcode = 'QTF03';
	exception when sqlstate '22023' then null;
	end;
	begin
		perform public.qorpera_agent_exit_network_rules(array(select gen_random_uuid() from generate_series(1, 10001)));
		raise exception 'A call names at most 10000 companies' using errcode = 'QTF03';
	exception when sqlstate '22023' then null;
	end;
	begin
		perform 1 from public.qorpera_company_network_rules;
		raise exception 'The exit reads no table' using errcode = 'QTF03';
	exception when insufficient_privilege then null;
	end;
	begin
		perform public.qorpera_company_network_rules_name_valid('example.com');
		raise exception 'The exit calls one function' using errcode = 'QTF03';
	exception when insufficient_privilege then null;
	end;
	reset role;
	foreach v_role in array array['anon','authenticated','service_role'] loop
		execute format('set local role %I', v_role);
		begin
			perform public.qorpera_agent_exit_network_rules(array['94900000-0000-4000-8000-000000000010']::uuid[]);
			raise exception '% reads the nodes'' rules', v_role using errcode = 'QTF03';
		exception when insufficient_privilege then null;
		end;
		reset role;
	end loop;
	select array_agg(f.oid::regprocedure::text order by f.oid::regprocedure::text collate "C") into v_functions
	from pg_proc f join pg_namespace n on n.oid = f.pronamespace
	where n.nspname = 'public' and f.proname like 'qorpera_%' and has_function_privilege('qorpera_agent_exit', f.oid, 'EXECUTE');
	if v_functions is distinct from array['qorpera_agent_exit_network_rules(uuid[])'] then
		raise exception 'The exit calls only its one function: %', v_functions; end if;
	if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
		where n.nspname = 'public' and c.relkind in ('r','p','v','m','f')
			and has_table_privilege('qorpera_agent_exit', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) then
		raise exception 'The exit has no table'; end if;
	if has_schema_privilege('qorpera_agent_exit', 'public', 'CREATE') then raise exception 'The exit creates nothing'; end if;
	if (select rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls or rolinherit or rolcanlogin
		from pg_roles where rolname = 'qorpera_agent_exit') is not false then
		raise exception 'The exit''s role has no attributes, and no login until the rollout gives it one'; end if;
	if exists (select 1 from pg_auth_members m where m.member = 'qorpera_agent_exit'::regrole) then
		raise exception 'The exit''s role is in no other role'; end if;
	if has_function_privilege('service_role', 'public.qorpera_company_network_rules_name_valid(text)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_company_network_rules_list_valid(jsonb)', 'EXECUTE')
		or has_table_privilege('authenticated', 'public.qorpera_company_network_rules', 'SELECT')
		or not has_table_privilege('service_role', 'public.qorpera_company_network_rules', 'SELECT')
		or has_table_privilege('service_role', 'public.qorpera_company_network_rules', 'INSERT,UPDATE,DELETE') then
		raise exception 'The helpers and the table are the folder''s'; end if;
end $$;

-- 8. A company with two environments: the nodes read the latest save ------------------------------------------------------

do $$
declare v_text text; v_parse jsonb;
begin
	perform public.qorpera_folder_enable('94900000-0000-4000-8000-000000000022');
	v_parse := pg_temp.rules('open', '["other.example"]', '[]');
	v_text := pg_temp.rules_text(v_parse);
	-- A new rules/ folder with the file in it is a save too.
	perform pg_temp.expect(pg_temp.commit_in('94900000-0000-4000-8000-000000000022', pg_temp.owner(), 'other-0001', jsonb_build_array(
		jsonb_build_object('op','new_folder','path','rules','contents',jsonb_build_array(
			jsonb_build_object('path','network.toml','kind','file','file',pg_temp.stage(v_text))),
			'structured',jsonb_build_array(pg_temp.entry('rules/network.toml','network-rules',v_text,v_parse))))), 1, 'saved');
	if (pg_temp.row('94900000-0000-4000-8000-000000000022')).folder_path_version
		is distinct from pg_temp.version('rules/network.toml', '94900000-0000-4000-8000-000000000022')
		or (pg_temp.row('94900000-0000-4000-8000-000000000022')).profile_id is distinct from '94900000-0000-4000-8000-000000000010' then
		raise exception 'Each environment has its row'; end if;
	if (select y.version from public.qorpera_agent_exit_network_rules(array['94900000-0000-4000-8000-000000000010']::uuid[]) y)
		is distinct from pg_temp.version('rules/network.toml', '94900000-0000-4000-8000-000000000022') then
		raise exception 'The nodes read the latest save'; end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'latest-0001', jsonb_build_array(pg_temp.network(
		pg_temp.rules('only-listed', '["z.example"]', '["pypi.org"]')))), 1, 'saved');
	if (select array_agg(y.version) from public.qorpera_agent_exit_network_rules(array['94900000-0000-4000-8000-000000000010']::uuid[]) y)
		is distinct from array[pg_temp.version('rules/network.toml')] then
		raise exception 'One row a company, from its latest save'; end if;
end $$;

rollback;
