-- 20260930519000: agents/sections.md orders the agents and group chats in no section (deploy/first-node/
-- RUNTIME-COMPANY-STATE-FILES.md §2 "agents/sections.md"). The id lines before the first section come in the parse as
-- `unassigned`; the parse's shape, the database rules and the sidebar index take them, and the member's sidebar says it
-- keeps that order. The fixture is test 702's.
begin;

insert into auth.users(id,email) values
	('54100000-0000-4000-8000-000000000001','order-owner@example.test'),
	('54100000-0000-4000-8000-000000000002','order-member@example.test'),
	('54100000-0000-4000-8000-000000000003','order-stranger@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id) values ('54100000-0000-4000-8000-000000000010','Nordlys Order','54100000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('54100000-0000-4000-8000-000000000010','54100000-0000-4000-8000-000000000001','order-owner@example.test','Owner','owner'),
	('54100000-0000-4000-8000-000000000010','54100000-0000-4000-8000-000000000002','order-member@example.test','Member','contributor');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id) values
	('54100000-0000-4000-8000-000000000020','54100000-0000-4000-8000-000000000010','Environment',1,'54100000-0000-4000-8000-000000000001');

select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
select public.qorpera_folder_enable('54100000-0000-4000-8000-000000000020') \g /dev/null
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
create function pg_temp.stage(p_text text, p_profile uuid default '54100000-0000-4000-8000-000000000010') returns jsonb language plpgsql as $$
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
	select jsonb_build_object('op','new_folder','path','QorperaOS/agents/' || p_handle,
		'contents', jsonb_build_array(
			jsonb_build_object('path','agent.md','kind','file','file',pg_temp.stage(pg_temp.agent_text(p_id, p_name, p_kind))),
			jsonb_build_object('path','memory','kind','folder'), jsonb_build_object('path','todos','kind','folder')),
		'structured', jsonb_build_array(pg_temp.entry('QorperaOS/agents/' || p_handle || '/agent.md', 'agent',
			pg_temp.agent_text(p_id, p_name, p_kind), pg_temp.agent_parse(p_id, p_name, p_kind))))
$$;
create function pg_temp.vision(p_name text) returns jsonb language sql as $$
	select pg_temp.write('QorperaOS/vision/vision.md', 'vision', E'# ' || p_name || E'\n\n## What we build\n',
		jsonb_build_object('kind','vision','name',p_name),
		(select version from public.qorpera_folder_entries where environment_id = '54100000-0000-4000-8000-000000000020'
			and key_text = 'qorperaos/vision/vision.md'))
$$;
create function pg_temp.commit(p_actor jsonb, p_key text, p_units jsonb) returns jsonb language plpgsql as $$
begin
	perform pg_temp.possess('54100000-0000-4000-8000-000000000020', p_actor, p_units);
	return public.qorpera_folder_commit('54100000-0000-4000-8000-000000000020', p_actor, p_key, p_units);
end $$;
create function pg_temp.owner() returns jsonb language sql as $$
	select '{"kind":"member","userId":"54100000-0000-4000-8000-000000000001"}'::jsonb
$$;
create function pg_temp.expect(p_result jsonb, p_unit integer, p_outcome text, p_reason text default null)
returns jsonb language plpgsql as $$
declare v jsonb := p_result -> 'units' -> (p_unit - 1);
begin
	if v ->> 'outcome' is distinct from p_outcome or v ->> 'reason' is distinct from p_reason then
		raise exception 'Unit % expected % (%), got %', p_unit, p_outcome, p_reason, p_result using errcode = 'QTF01'; end if;
	return v;
end $$;
create function pg_temp.version(p_key text) returns uuid language sql as $$
	select version from public.qorpera_folder_entries where environment_id = '54100000-0000-4000-8000-000000000020' and key_text = public.qorpera_folder_key(p_key)
$$;
create function pg_temp.seq() returns bigint language sql as $$
	select last_seq from public.qorpera_folder_clocks where environment_id = '54100000-0000-4000-8000-000000000020'
$$;
create function pg_temp.staff(p_id uuid) returns public.qorpera_profile_staff language sql as $$
	select * from public.qorpera_profile_staff where profile_id = '54100000-0000-4000-8000-000000000010' and staff_agent_id = p_id
$$;

create function pg_temp.group_text(p_id uuid, p_name text, p_agents uuid[], p_people uuid[], p_subtitle text default null)
returns text language sql as $$
	select format(E'---\nid: %s\nname: %s\n%sagents:\n%speople:\n%s---\nPlan the launch.\n', p_id, p_name,
		case when p_subtitle is null then '' else format(E'subtitle: "%s"\n', p_subtitle) end,
		(select string_agg(format(E'  - %s\n', a), '') from unnest(p_agents) a),
		coalesce((select string_agg(format(E'  - %s\n', a), '') from unnest(p_people) a), ''))
$$;
create function pg_temp.group_parse(p_id uuid, p_name text, p_agents uuid[], p_people uuid[], p_subtitle text default null)
returns jsonb language sql as $$
	select jsonb_build_object('kind','group','id',p_id,'name',p_name,'subtitle',p_subtitle,'agents',to_jsonb(p_agents),
		'people',to_jsonb(coalesce(p_people, '{}'::uuid[])),'purpose','Plan the launch.')
$$;
-- A new group chat folder with its group.md, as one unit.
create function pg_temp.new_group(p_handle text, p_id uuid, p_name text, p_agents uuid[], p_people uuid[]) returns jsonb language sql as $$
	select jsonb_build_object('op','new_folder','path','QorperaOS/agents/groups/' || p_handle,
		'contents', jsonb_build_array(jsonb_build_object('path','group.md','kind','file',
			'file',pg_temp.stage(pg_temp.group_text(p_id, p_name, p_agents, p_people)))),
		'structured', jsonb_build_array(pg_temp.entry('QorperaOS/agents/groups/' || p_handle || '/group.md', 'group',
			pg_temp.group_text(p_id, p_name, p_agents, p_people), pg_temp.group_parse(p_id, p_name, p_agents, p_people))))
$$;
-- An edit of a group.md, with its parse given.
create function pg_temp.edit_group(p_handle text, p_parse jsonb) returns jsonb language sql as $$
	select pg_temp.write('QorperaOS/agents/groups/' || p_handle || '/group.md', 'group', 'group ' || p_parse::text, p_parse,
		pg_temp.version('QorperaOS/agents/groups/' || p_handle || '/group.md'))
$$;
create function pg_temp.sections(p_parse jsonb) returns jsonb language sql as $$
	select pg_temp.write('QorperaOS/agents/sections.md', 'sections', 'sections ' || p_parse::text, p_parse, pg_temp.version('QorperaOS/agents/sections.md'))
$$;
create function pg_temp.rule(p_result jsonb, p_unit integer) returns text language sql as $$
	select p_result -> 'units' -> (p_unit - 1) ->> 'reason'
$$;

-- 1. The company, with three agents ----------------------------------------------------------------------------------

do $$
declare r jsonb; i integer;
begin
	r := pg_temp.commit('{"kind":"platform"}', 'seed-0001', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','QorperaOS'), jsonb_build_object('op','mkdir','path','QorperaOS/vision'), pg_temp.vision('Nordlys Order'),
		jsonb_build_object('op','mkdir','path','QorperaOS/agents'),
		pg_temp.write('QorperaOS/agents/sections.md', 'sections', E'# Sections\n', '{"kind":"sections","sections":[]}'),
		pg_temp.hire('co-founder', '54100000-0000-4000-8000-0000000000c0', 'Co-Founder', 'co-founder'),
		jsonb_build_object('op','mkdir','path','QorperaOS/agents/groups')));
	for i in 1..7 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	r := pg_temp.commit(pg_temp.owner(), 'hire-0001', jsonb_build_array(
		pg_temp.hire('nora', '54100000-0000-4000-8000-0000000000a1', 'Nora'), pg_temp.hire('otto', '54100000-0000-4000-8000-0000000000a2', 'Otto'), pg_temp.hire('vera', '54100000-0000-4000-8000-0000000000a3', 'Vera')));
	for i in 1..3 loop perform pg_temp.expect(r, i, 'saved'); end loop;
end $$;


-- 2. A group chat, then the order of what is in no section -------------------------------------------------------------

do $$
declare r jsonb; sales uuid; v jsonb;
begin
	r := pg_temp.commit(pg_temp.owner(), 'group-0001', jsonb_build_array(
		pg_temp.new_group('launch', '54100000-0000-4000-8000-0000000000b1', 'Launch', array['54100000-0000-4000-8000-0000000000a1','54100000-0000-4000-8000-0000000000a2']::uuid[], array['54100000-0000-4000-8000-000000000001']::uuid[])));
	perform pg_temp.expect(r, 1, 'saved');
	-- Vera, the group chat and Otto in no section, in that order; Nora in Sales.
	r := pg_temp.commit(pg_temp.owner(), 'order-0001', jsonb_build_array(pg_temp.sections(jsonb_build_object('kind','sections',
		'unassigned', jsonb_build_array(jsonb_build_object('id','54100000-0000-4000-8000-0000000000a3','line',4),
			jsonb_build_object('id','54100000-0000-4000-8000-0000000000b1','line',5),
			jsonb_build_object('id','54100000-0000-4000-8000-0000000000a2','line',6)),
		'sections', jsonb_build_array(jsonb_build_object('name','Sales','line',8,'members',
			jsonb_build_array(jsonb_build_object('id','54100000-0000-4000-8000-0000000000a1','line',9))))))));
	perform pg_temp.expect(r, 1, 'saved');
	select id into sales from public.qorpera_company_sidebar_sections where profile_id = '54100000-0000-4000-8000-000000000010' and name = 'Sales' and position = 0;
	if sales is null then raise exception 'The section comes first in its own order: %', r; end if;
	if not exists (select 1 from public.qorpera_company_sidebar_placements where staff_agent_id = '54100000-0000-4000-8000-0000000000a3' and section_id is null and position = 0)
		or not exists (select 1 from public.qorpera_company_sidebar_room_placements where room_id = '54100000-0000-4000-8000-0000000000b1' and section_id is null and position = 1)
		or not exists (select 1 from public.qorpera_company_sidebar_placements where staff_agent_id = '54100000-0000-4000-8000-0000000000a2' and section_id is null and position = 2)
		or not exists (select 1 from public.qorpera_company_sidebar_placements where staff_agent_id = '54100000-0000-4000-8000-0000000000a1' and section_id = sales and position = 0) then
		raise exception 'What is in no section keeps the file''s order, agents and chats together'; end if;
	-- The member's sidebar says so, with the positions.
	v := public.qorpera_sidebar_state('54100000-0000-4000-8000-000000000010', '54100000-0000-4000-8000-000000000001');
	if v -> 'unassignedOrder' is distinct from 'true'::jsonb
		or not (v -> 'placements') @> jsonb_build_array(jsonb_build_object('staffAgentId','54100000-0000-4000-8000-0000000000a2','sectionId',null,'position',2))
		or not (v -> 'roomPlacements') @> jsonb_build_array(jsonb_build_object('roomId','54100000-0000-4000-8000-0000000000b1','sectionId',null,'position',1)) then
		raise exception 'The sidebar keeps the order of what is in no section: %', v; end if;
	-- Reordered: the positions follow.
	r := pg_temp.commit(pg_temp.owner(), 'order-0002', jsonb_build_array(pg_temp.sections(jsonb_build_object('kind','sections',
		'unassigned', jsonb_build_array(jsonb_build_object('id','54100000-0000-4000-8000-0000000000a2','line',4),
			jsonb_build_object('id','54100000-0000-4000-8000-0000000000a3','line',5)),
		'sections', jsonb_build_array(jsonb_build_object('name','Sales','line',7,'members',
			jsonb_build_array(jsonb_build_object('id','54100000-0000-4000-8000-0000000000a1','line',8))))))));
	perform pg_temp.expect(r, 1, 'saved');
	if not exists (select 1 from public.qorpera_company_sidebar_placements where staff_agent_id = '54100000-0000-4000-8000-0000000000a2' and section_id is null and position = 0)
		or not exists (select 1 from public.qorpera_company_sidebar_placements where staff_agent_id = '54100000-0000-4000-8000-0000000000a3' and section_id is null and position = 1)
		or exists (select 1 from public.qorpera_company_sidebar_room_placements where room_id = '54100000-0000-4000-8000-0000000000b1') then
		raise exception 'A new order replaces the old, and what is listed nowhere has no place'; end if;
	-- A file without them keeps its exact old shape, and lists no one with a place outside the sections.
	r := pg_temp.commit(pg_temp.owner(), 'order-0003', jsonb_build_array(pg_temp.sections(jsonb_build_object('kind','sections',
		'sections', jsonb_build_array(jsonb_build_object('name','Sales','line',3,'members',
			jsonb_build_array(jsonb_build_object('id','54100000-0000-4000-8000-0000000000a1','line',4))))))));
	perform pg_temp.expect(r, 1, 'saved');
	if exists (select 1 from public.qorpera_company_sidebar_placements where profile_id = '54100000-0000-4000-8000-000000000010' and section_id is null) then
		raise exception 'No order line, no place in no section'; end if;
end $$;

-- 3. The rules and the shape hold for them too ------------------------------------------------------------------------

do $$
declare r jsonb;
begin
	-- The Co-Founder is never listed, and an unknown id is refused.
	r := pg_temp.commit(pg_temp.owner(), 'rules-0001', jsonb_build_array(pg_temp.sections(jsonb_build_object('kind','sections',
		'unassigned', jsonb_build_array(jsonb_build_object('id','54100000-0000-4000-8000-0000000000c0','line',1)), 'sections', '[]'::jsonb))));
	if pg_temp.rule(r, 1) is distinct from 'structured_rule' then raise exception 'The Co-Founder is in no list: %', r; end if;
	r := pg_temp.commit(pg_temp.owner(), 'rules-0002', jsonb_build_array(pg_temp.sections(jsonb_build_object('kind','sections',
		'unassigned', jsonb_build_array(jsonb_build_object('id','54100000-0000-4000-8000-0000000000ff','line',1)), 'sections', '[]'::jsonb))));
	if pg_temp.rule(r, 1) is distinct from 'structured_rule' then raise exception 'An unknown id is refused: %', r; end if;
	-- An id is listed once in the whole file; the list is never empty, and holds {id, line} only.
	r := pg_temp.commit(pg_temp.owner(), 'rules-0003', jsonb_build_array(pg_temp.sections(jsonb_build_object('kind','sections',
		'unassigned', jsonb_build_array(jsonb_build_object('id','54100000-0000-4000-8000-0000000000a1','line',1)),
		'sections', jsonb_build_array(jsonb_build_object('name','Sales','line',3,'members',
			jsonb_build_array(jsonb_build_object('id','54100000-0000-4000-8000-0000000000a1','line',4))))))));
	if pg_temp.rule(r, 1) is distinct from 'structured_invalid' then raise exception 'An id is listed once: %', r; end if;
	r := pg_temp.commit(pg_temp.owner(), 'rules-0004', jsonb_build_array(pg_temp.sections(jsonb_build_object('kind','sections',
		'unassigned', '[]'::jsonb, 'sections', '[]'::jsonb))));
	if pg_temp.rule(r, 1) is distinct from 'structured_invalid' then raise exception 'An empty list is not sent: %', r; end if;
	r := pg_temp.commit(pg_temp.owner(), 'rules-0005', jsonb_build_array(pg_temp.sections(jsonb_build_object('kind','sections',
		'unassigned', jsonb_build_array(jsonb_build_object('id','54100000-0000-4000-8000-0000000000a2','line',1,'name','Otto')),
		'sections', '[]'::jsonb))));
	if pg_temp.rule(r, 1) is distinct from 'structured_invalid' then raise exception 'An entry is {id, line}: %', r; end if;
	r := pg_temp.commit(pg_temp.owner(), 'rules-0006', jsonb_build_array(pg_temp.sections(jsonb_build_object('kind','sections',
		'order', jsonb_build_array(jsonb_build_object('id','54100000-0000-4000-8000-0000000000a2','line',1)), 'sections', '[]'::jsonb))));
	if pg_temp.rule(r, 1) is distinct from 'structured_invalid' then raise exception 'No other key: %', r; end if;
	-- An agent that is gone keeps its place in the order: an id already saved never blocks a save.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'rules-0007', jsonb_build_array(pg_temp.sections(jsonb_build_object('kind','sections',
		'unassigned', jsonb_build_array(jsonb_build_object('id','54100000-0000-4000-8000-0000000000a3','line',1),
			jsonb_build_object('id','54100000-0000-4000-8000-0000000000a2','line',2)), 'sections', '[]'::jsonb)))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'rules-0008', jsonb_build_array(jsonb_build_object('op','delete',
		'path','QorperaOS/agents/vera','expectedVersion',pg_temp.version('QorperaOS/agents/vera'),'asOfSeq',pg_temp.seq()))), 1, 'saved');
	r := pg_temp.commit(pg_temp.owner(), 'rules-0009', jsonb_build_array(pg_temp.sections(jsonb_build_object('kind','sections',
		'unassigned', jsonb_build_array(jsonb_build_object('id','54100000-0000-4000-8000-0000000000a2','line',1),
			jsonb_build_object('id','54100000-0000-4000-8000-0000000000a3','line',2)), 'sections', '[]'::jsonb))));
	perform pg_temp.expect(r, 1, 'saved');
	if not exists (select 1 from public.qorpera_company_sidebar_placements where staff_agent_id = '54100000-0000-4000-8000-0000000000a3'
			and section_id is null and position = 1) then
		raise exception 'A retired agent keeps its place in the order'; end if;
end $$;

rollback;
