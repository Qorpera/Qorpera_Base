-- Company state files, F2-2 (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §2, §4): group chats and sections on
-- the folder core. group.md is the room index (a chat and its conversation), sections.md the sidebar index; the
-- database rules of §2, the lock targets, and the member RPC's refusal on folder-v2.
begin;

insert into auth.users(id,email) values
	('70200000-0000-4000-8000-000000000001','groups-owner@example.test'),
	('70200000-0000-4000-8000-000000000002','groups-member@example.test'),
	('70200000-0000-4000-8000-000000000003','groups-stranger@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id) values ('70200000-0000-4000-8000-000000000010','Nordlys Groups','70200000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('70200000-0000-4000-8000-000000000010','70200000-0000-4000-8000-000000000001','groups-owner@example.test','Owner','owner'),
	('70200000-0000-4000-8000-000000000010','70200000-0000-4000-8000-000000000002','groups-member@example.test','Member','contributor');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id) values
	('70200000-0000-4000-8000-000000000020','70200000-0000-4000-8000-000000000010','Environment',1,'70200000-0000-4000-8000-000000000001');

select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
select public.qorpera_folder_enable('70200000-0000-4000-8000-000000000020') \g /dev/null
-- Verified version-2 bytes for a text, as the object gateway leaves them: the platform stages them.
create function pg_temp.manifest_v2(p_text text) returns text language sql immutable as $$
	select format('{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"%s","bytes":%s,"mediaType":"text/markdown","executable":false,"chunks":[%s]}',
		encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex'), octet_length(convert_to(p_text, 'utf8')),
		case when p_text = '' then '' else format('{"sha256":"%s","bytes":%s}', encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex'),
			octet_length(convert_to(p_text, 'utf8'))) end)
$$;
-- Opens an intent for a manifest as the actor, confirms the objects it does not have yet (the manifest's chunks and the
-- manifest itself, by hash and size), and seals it.
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
create function pg_temp.stage(p_text text, p_profile uuid default '70200000-0000-4000-8000-000000000010') returns jsonb language plpgsql as $$
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
-- each of their files itself, as its own upload would. An actor that may not stage is left to the commit's refusal.
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
		exception when others then null;
		end;
	end loop;
end $$;
-- A commit in any environment, as its actor: takes possession of the actor's files first.
create function pg_temp.commit_in(p_env uuid, p_actor jsonb, p_key text, p_units jsonb, p_review uuid default null)
returns jsonb language plpgsql as $$
begin
	perform pg_temp.possess(p_env, p_actor, p_units);
	return public.qorpera_folder_commit(p_env, p_actor, p_key, p_units, p_review);
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
	select jsonb_build_object('op','new_folder','path','agents/' || p_handle,
		'contents', jsonb_build_array(
			jsonb_build_object('path','agent.md','kind','file','file',pg_temp.stage(pg_temp.agent_text(p_id, p_name, p_kind))),
			jsonb_build_object('path','memory','kind','folder'), jsonb_build_object('path','todos','kind','folder')),
		'structured', jsonb_build_array(pg_temp.entry('agents/' || p_handle || '/agent.md', 'agent',
			pg_temp.agent_text(p_id, p_name, p_kind), pg_temp.agent_parse(p_id, p_name, p_kind))))
$$;
create function pg_temp.vision(p_name text) returns jsonb language sql as $$
	select pg_temp.write('vision/vision.md', 'vision', E'# ' || p_name || E'\n\n## What we build\n',
		jsonb_build_object('kind','vision','name',p_name),
		(select version from public.qorpera_folder_entries where environment_id = '70200000-0000-4000-8000-000000000020'
			and key_text = 'vision/vision.md'))
$$;
create function pg_temp.commit(p_actor jsonb, p_key text, p_units jsonb) returns jsonb language plpgsql as $$
begin
	perform pg_temp.possess('70200000-0000-4000-8000-000000000020', p_actor, p_units);
	return public.qorpera_folder_commit('70200000-0000-4000-8000-000000000020', p_actor, p_key, p_units);
end $$;
create function pg_temp.owner() returns jsonb language sql as $$
	select '{"kind":"member","userId":"70200000-0000-4000-8000-000000000001"}'::jsonb
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
	select version from public.qorpera_folder_entries where environment_id = '70200000-0000-4000-8000-000000000020' and key_text = p_key
$$;
create function pg_temp.seq() returns bigint language sql as $$
	select last_seq from public.qorpera_folder_clocks where environment_id = '70200000-0000-4000-8000-000000000020'
$$;
create function pg_temp.staff(p_id uuid) returns public.qorpera_profile_staff language sql as $$
	select * from public.qorpera_profile_staff where profile_id = '70200000-0000-4000-8000-000000000010' and staff_agent_id = p_id
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
	select jsonb_build_object('op','new_folder','path','agents/groups/' || p_handle,
		'contents', jsonb_build_array(jsonb_build_object('path','group.md','kind','file',
			'file',pg_temp.stage(pg_temp.group_text(p_id, p_name, p_agents, p_people)))),
		'structured', jsonb_build_array(pg_temp.entry('agents/groups/' || p_handle || '/group.md', 'group',
			pg_temp.group_text(p_id, p_name, p_agents, p_people), pg_temp.group_parse(p_id, p_name, p_agents, p_people))))
$$;
-- An edit of a group.md, with its parse given.
create function pg_temp.edit_group(p_handle text, p_parse jsonb) returns jsonb language sql as $$
	select pg_temp.write('agents/groups/' || p_handle || '/group.md', 'group', 'group ' || p_parse::text, p_parse,
		pg_temp.version('agents/groups/' || p_handle || '/group.md'))
$$;
create function pg_temp.sections(p_parse jsonb) returns jsonb language sql as $$
	select pg_temp.write('agents/sections.md', 'sections', 'sections ' || p_parse::text, p_parse, pg_temp.version('agents/sections.md'))
$$;
create function pg_temp.room(p_id uuid) returns public.qorpera_company_rooms language sql as $$
	select * from public.qorpera_company_rooms where id = p_id
$$;
create function pg_temp.members(p_id uuid) returns text language sql as $$
	select coalesce(string_agg(principal_kind || ':' || right(principal_id::text, 2), ',' order by principal_kind, principal_id), '')
	from public.qorpera_company_room_members where room_id = p_id and status = 'active'
$$;
create function pg_temp.rule(p_result jsonb, p_unit integer) returns text language sql as $$
	select p_result -> 'units' -> (p_unit - 1) ->> 'reason'
$$;

-- 1. The company, with three agents ----------------------------------------------------------------------------------

do $$
declare r jsonb; i integer;
begin
	r := pg_temp.commit('{"kind":"platform"}', 'seed-0001', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','vision'), pg_temp.vision('Nordlys Groups'),
		jsonb_build_object('op','mkdir','path','agents'),
		pg_temp.write('agents/sections.md', 'sections', E'# Sections\n', '{"kind":"sections","sections":[]}'),
		pg_temp.hire('co-founder', '70200000-0000-4000-8000-0000000000c0', 'Co-Founder', 'co-founder'),
		jsonb_build_object('op','mkdir','path','agents/groups')));
	for i in 1..6 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	r := pg_temp.commit(pg_temp.owner(), 'hire-0001', jsonb_build_array(
		pg_temp.hire('nora', '70200000-0000-4000-8000-0000000000a1', 'Nora'), pg_temp.hire('otto', '70200000-0000-4000-8000-0000000000a2', 'Otto'), pg_temp.hire('vera', '70200000-0000-4000-8000-0000000000a3', 'Vera')));
	for i in 1..3 loop perform pg_temp.expect(r, i, 'saved'); end loop;
end $$;

-- 2. A new group.md opens the chat and its conversation ---------------------------------------------------------------

do $$
declare r jsonb; g public.qorpera_company_rooms; s public.qorpera_shared_sessions;
begin
	r := pg_temp.commit(pg_temp.owner(), 'group-0001', jsonb_build_array(
		pg_temp.new_group('launch', '70200000-0000-4000-8000-0000000000b1', 'Launch', array['70200000-0000-4000-8000-0000000000a1','70200000-0000-4000-8000-0000000000a2']::uuid[], array['70200000-0000-4000-8000-000000000001']::uuid[])));
	perform pg_temp.expect(r, 1, 'saved');
	g := pg_temp.room('70200000-0000-4000-8000-0000000000b1');
	if g.folder_path is distinct from 'agents/groups/launch/group.md' or g.folder_path_version is distinct from pg_temp.version('agents/groups/launch/group.md')
		or g.room_key is distinct from 'chat-70200000-0000-4000-8000-0000000000b1' or g.name is distinct from 'Launch' or g.subtitle is not null or g.purpose is distinct from 'Plan the launch.'
		or g.status is distinct from 'active' or g.version is distinct from 1 or g.bound_staff_agent_id is not null or g.source_snapshot_id is not null
		or g.created_by_user_id is distinct from '70200000-0000-4000-8000-000000000001' then
		raise exception 'A new group.md is a room pointing at it: %', to_jsonb(g); end if;
	select * into s from public.qorpera_shared_sessions where id = g.session_id;
	if s.status is distinct from 'open' or s.title is distinct from 'Launch' or s.staff_agent_id is not null or s.execution_scope is distinct from jsonb_build_object('roomId', g.id)
		or s.audience_kind is distinct from 'company' then
		raise exception 'A new group chat has its conversation: %', to_jsonb(s); end if;
	if pg_temp.members('70200000-0000-4000-8000-0000000000b1') is distinct from 'member:01,staff_agent:a1,staff_agent:a2' then
		raise exception 'Members follow the lists: %', pg_temp.members('70200000-0000-4000-8000-0000000000b1'); end if;
	if public.qorpera_folder_structured_review_class('70200000-0000-4000-8000-000000000020', pg_temp.owner(), pg_temp.new_group('other', '70200000-0000-4000-8000-0000000000b2', 'Other',
		array['70200000-0000-4000-8000-0000000000a1','70200000-0000-4000-8000-0000000000a2']::uuid[], null), 'agents/groups/other', null) is distinct from 'delegation' then
		raise exception 'A new group.md is delegation for an in-house run'; end if;
end $$;

-- 3. An edit: the fields, the conversation's title, and the members ---------------------------------------------------

do $$
declare r jsonb; g public.qorpera_company_rooms;
begin
	r := pg_temp.commit(pg_temp.owner(), 'group-0002', jsonb_build_array(pg_temp.edit_group('launch',
		pg_temp.group_parse('70200000-0000-4000-8000-0000000000b1', 'Launch team', array['70200000-0000-4000-8000-0000000000a1','70200000-0000-4000-8000-0000000000a3']::uuid[], array['70200000-0000-4000-8000-000000000002']::uuid[], ''))));
	perform pg_temp.expect(r, 1, 'saved');
	g := pg_temp.room('70200000-0000-4000-8000-0000000000b1');
	if g.name is distinct from 'Launch team' or g.subtitle is distinct from '' or g.version is distinct from 2 or g.folder_path_version is distinct from pg_temp.version('agents/groups/launch/group.md') then
		raise exception 'An edit reaches the room: %', to_jsonb(g); end if;
	if (select title from public.qorpera_shared_sessions where id = g.session_id) is distinct from 'Launch team' then
		raise exception 'The conversation takes the new name'; end if;
	if pg_temp.members('70200000-0000-4000-8000-0000000000b1') is distinct from 'member:02,staff_agent:a1,staff_agent:a3' then
		raise exception 'Members follow the lists: %', pg_temp.members('70200000-0000-4000-8000-0000000000b1'); end if;
	if not exists (select 1 from public.qorpera_company_room_members where room_id = '70200000-0000-4000-8000-0000000000b1' and principal_id = '70200000-0000-4000-8000-0000000000a2'
		and status = 'removed' and source_path_version = g.folder_path_version) then
		raise exception 'A member left out is removed at this version'; end if;
end $$;

-- 4. The rules of group.md --------------------------------------------------------------------------------------------

do $$
declare r jsonb; thread uuid;
begin
	-- The id never changes.
	r := pg_temp.commit(pg_temp.owner(), 'group-rule-01', jsonb_build_array(pg_temp.edit_group('launch',
		pg_temp.group_parse('70200000-0000-4000-8000-0000000000b2', 'Launch team', array['70200000-0000-4000-8000-0000000000a1','70200000-0000-4000-8000-0000000000a3']::uuid[], array['70200000-0000-4000-8000-000000000002']::uuid[], ''))));
	if pg_temp.rule(r, 1) is distinct from 'structured_rule' then raise exception 'The id never changes: %', r; end if;
	-- Added agents are active agents of this company, added people its members.
	r := pg_temp.commit(pg_temp.owner(), 'group-rule-02', jsonb_build_array(pg_temp.edit_group('launch',
		pg_temp.group_parse('70200000-0000-4000-8000-0000000000b1', 'Launch team', array['70200000-0000-4000-8000-0000000000a1','70200000-0000-4000-8000-0000000000a3','70200000-0000-4000-8000-0000000000ff']::uuid[], array['70200000-0000-4000-8000-000000000002']::uuid[], ''))));
	if pg_temp.rule(r, 1) is distinct from 'structured_rule' then raise exception 'An unknown agent is refused: %', r; end if;
	r := pg_temp.commit(pg_temp.owner(), 'group-rule-03', jsonb_build_array(pg_temp.edit_group('launch',
		pg_temp.group_parse('70200000-0000-4000-8000-0000000000b1', 'Launch team', array['70200000-0000-4000-8000-0000000000a1','70200000-0000-4000-8000-0000000000a3']::uuid[], array['70200000-0000-4000-8000-000000000002','70200000-0000-4000-8000-000000000003']::uuid[], ''))));
	if pg_temp.rule(r, 1) is distinct from 'structured_rule' then raise exception 'A person outside the company is refused: %', r; end if;
	-- A new chat's id belongs to no other conversation, agent or chat.
	select id into thread from public.qorpera_company_rooms where bound_staff_agent_id = '70200000-0000-4000-8000-0000000000a1';
	r := pg_temp.commit(pg_temp.owner(), 'group-rule-04', jsonb_build_array(
		pg_temp.new_group('thread', thread, 'Thread', array['70200000-0000-4000-8000-0000000000a1','70200000-0000-4000-8000-0000000000a2']::uuid[], null),
		pg_temp.new_group('agent', '70200000-0000-4000-8000-0000000000a2', 'Agent', array['70200000-0000-4000-8000-0000000000a1','70200000-0000-4000-8000-0000000000a2']::uuid[], null),
		pg_temp.new_group('twin', '70200000-0000-4000-8000-0000000000b1', 'Twin', array['70200000-0000-4000-8000-0000000000a1','70200000-0000-4000-8000-0000000000a2']::uuid[], null)));
	if pg_temp.rule(r, 1) is distinct from 'structured_rule' or pg_temp.rule(r, 2) is distinct from 'structured_rule' or pg_temp.rule(r, 3) is distinct from 'structured_rule' then
		raise exception 'A chat id belongs to one chat: %', r; end if;
	-- The parse's shape: at least two agents.
	r := pg_temp.commit(pg_temp.owner(), 'group-rule-06', jsonb_build_array(pg_temp.edit_group('launch',
		pg_temp.group_parse('70200000-0000-4000-8000-0000000000b1', 'Launch team', array['70200000-0000-4000-8000-0000000000a1']::uuid[], array['70200000-0000-4000-8000-000000000002']::uuid[], ''))));
	if pg_temp.rule(r, 1) is distinct from 'structured_invalid' then raise exception 'One agent is not a group chat: %', r; end if;
	-- group.md never goes alone, and the folder never leaves agents/groups/.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'group-rule-07', jsonb_build_array(jsonb_build_object('op','delete',
		'path','agents/groups/launch/group.md','expectedVersion',pg_temp.version('agents/groups/launch/group.md')))), 1, 'refused', 'lone_structured_file');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'group-rule-08', jsonb_build_array(jsonb_build_object('op','move',
		'from','agents/groups/launch','to','launch','expectedVersion',pg_temp.version('agents/groups/launch'),'asOfSeq',pg_temp.seq()))),
		1, 'refused', 'kind_change');
end $$;

-- 5. An agent's run adds only the member it works for -----------------------------------------------------------------

do $$
declare run jsonb := jsonb_build_object('kind','staff_agent','staffAgentId','70200000-0000-4000-8000-0000000000a1','requesterUserId','70200000-0000-4000-8000-000000000002');
	base jsonb := pg_temp.group_parse('70200000-0000-4000-8000-0000000000b1', 'Launch team', array['70200000-0000-4000-8000-0000000000a1','70200000-0000-4000-8000-0000000000a3']::uuid[], array['70200000-0000-4000-8000-000000000002']::uuid[], '');
begin
	if public.qorpera_company_state_group_rules('70200000-0000-4000-8000-000000000020', '70200000-0000-4000-8000-000000000010', run, 'agents/groups/launch/group.md',
		pg_temp.group_parse('70200000-0000-4000-8000-0000000000b1', 'Launch team', array['70200000-0000-4000-8000-0000000000a1','70200000-0000-4000-8000-0000000000a3']::uuid[], array['70200000-0000-4000-8000-000000000002','70200000-0000-4000-8000-000000000001']::uuid[], '')) is null then
		raise exception 'A run cannot add another member'; end if;
	if public.qorpera_company_state_group_rules('70200000-0000-4000-8000-000000000020', '70200000-0000-4000-8000-000000000010', run, 'agents/groups/launch/group.md', base) is not null then
		raise exception 'A run keeps the members already listed'; end if;
	if public.qorpera_company_state_group_rules('70200000-0000-4000-8000-000000000020', '70200000-0000-4000-8000-000000000010', run, 'agents/groups/new/group.md',
		pg_temp.group_parse('70200000-0000-4000-8000-0000000000b2', 'New', array['70200000-0000-4000-8000-0000000000a1','70200000-0000-4000-8000-0000000000a2']::uuid[], array['70200000-0000-4000-8000-000000000002']::uuid[])) is not null then
		raise exception 'A run adds the member it works for'; end if;
end $$;

-- 6. Renaming, deleting and restoring a group chat's folder ------------------------------------------------------------

do $$
declare r jsonb; g public.qorpera_company_rooms; t jsonb;
begin
	-- Moving a chat's folder takes the company row and its room, as deleting does.
	select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into t from public.qorpera_folder_structured_targets('70200000-0000-4000-8000-000000000020',
		pg_temp.owner(), jsonb_build_array(jsonb_build_object('op','move','from','agents/groups/launch','to','agents/groups/launch-team'))) x;
	if not t @> jsonb_build_array(jsonb_build_object('rank', 4, 'tbl', 'qorpera_company_rooms', 'key', '70200000-0000-4000-8000-0000000000b1', 'mode', 'nokeyupdate'))
		or not t @> '[{"rank":0,"tbl":"qorpera_profiles","mode":"keyshare"}]' then
		raise exception 'Moving a chat locks the company row and its room: %', t; end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'group-move-01', jsonb_build_array(jsonb_build_object('op','move',
		'from','agents/groups/launch','to','agents/groups/launch-team','expectedVersion',pg_temp.version('agents/groups/launch'),
		'asOfSeq',pg_temp.seq()))), 1, 'saved');
	g := pg_temp.room('70200000-0000-4000-8000-0000000000b1');
	if g.folder_path is distinct from 'agents/groups/launch-team/group.md' or g.folder_path_version is distinct from pg_temp.version('agents/groups/launch-team/group.md')
		or g.status is distinct from 'active' then
		raise exception 'A chat follows its folder: %', to_jsonb(g); end if;
	-- Deleting the folder closes the chat and its conversation; its lock target is the room.
	select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into t from public.qorpera_folder_structured_targets('70200000-0000-4000-8000-000000000020', pg_temp.owner(), jsonb_build_array(
		jsonb_build_object('op','delete','path','agents/groups/launch-team'))) x;
	if not t @> jsonb_build_array(jsonb_build_object('rank', 4, 'tbl', 'qorpera_company_rooms', 'key', '70200000-0000-4000-8000-0000000000b1', 'mode', 'nokeyupdate'))
		or not t @> '[{"rank":0,"tbl":"qorpera_profiles","mode":"keyshare"}]' then
		raise exception 'Deleting a chat locks the company row and its room: %', t; end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'group-delete-01', jsonb_build_array(jsonb_build_object('op','delete',
		'path','agents/groups/launch-team','expectedVersion',pg_temp.version('agents/groups/launch-team'),'asOfSeq',pg_temp.seq()))), 1, 'saved');
	g := pg_temp.room('70200000-0000-4000-8000-0000000000b1');
	if g.status is distinct from 'archived' or g.folder_retired_at is null
		or (select status from public.qorpera_shared_sessions where id = g.session_id) is distinct from 'closed' then
		raise exception 'Deleting the folder closes the chat: %', to_jsonb(g); end if;
	-- A restore reopens both, with the same conversation.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'group-restore-01', jsonb_build_array(
		pg_temp.new_group('launch', '70200000-0000-4000-8000-0000000000b1', 'Launch', array['70200000-0000-4000-8000-0000000000a1','70200000-0000-4000-8000-0000000000a2']::uuid[], array['70200000-0000-4000-8000-000000000001']::uuid[]))), 1, 'saved');
	if (pg_temp.room('70200000-0000-4000-8000-0000000000b1')).status is distinct from 'active' or (pg_temp.room('70200000-0000-4000-8000-0000000000b1')).folder_retired_at is not null
		or (pg_temp.room('70200000-0000-4000-8000-0000000000b1')).session_id is distinct from g.session_id
		or (select status from public.qorpera_shared_sessions where id = g.session_id) is distinct from 'open' then
		raise exception 'A restore reopens the chat: %', to_jsonb(pg_temp.room('70200000-0000-4000-8000-0000000000b1')); end if;
end $$;

-- 7. Sections: the sidebar in file order -------------------------------------------------------------------------------

do $$
declare r jsonb; sales uuid; ops uuid;
begin
	r := pg_temp.commit(pg_temp.owner(), 'sections-0001', jsonb_build_array(pg_temp.sections(jsonb_build_object('kind','sections','sections',
		jsonb_build_array(
			jsonb_build_object('name','Sales','line',3,'members',jsonb_build_array(jsonb_build_object('id','70200000-0000-4000-8000-0000000000a1','line',4),
				jsonb_build_object('id','70200000-0000-4000-8000-0000000000b1','line',5))),
			jsonb_build_object('name','Ops','line',7,'members',jsonb_build_array(jsonb_build_object('id','70200000-0000-4000-8000-0000000000a3','line',8))))))));
	perform pg_temp.expect(r, 1, 'saved');
	select id into sales from public.qorpera_company_sidebar_sections where profile_id = '70200000-0000-4000-8000-000000000010' and name = 'Sales' and position = 0;
	select id into ops from public.qorpera_company_sidebar_sections where profile_id = '70200000-0000-4000-8000-000000000010' and name = 'Ops' and position = 1;
	if sales is null or ops is null then raise exception 'Sections in file order'; end if;
	if not exists (select 1 from public.qorpera_company_sidebar_placements where staff_agent_id = '70200000-0000-4000-8000-0000000000a1' and section_id = sales and position = 0)
		or not exists (select 1 from public.qorpera_company_sidebar_room_placements where room_id = '70200000-0000-4000-8000-0000000000b1' and section_id = sales and position = 1)
		or not exists (select 1 from public.qorpera_company_sidebar_placements where staff_agent_id = '70200000-0000-4000-8000-0000000000a3' and section_id = ops and position = 0) then
		raise exception 'Agents and chats share one order in their section'; end if;
	-- A rename by case keeps the section; one left out goes, and so does the placement of what is no longer listed.
	r := pg_temp.commit(pg_temp.owner(), 'sections-0002', jsonb_build_array(pg_temp.sections(jsonb_build_object('kind','sections','sections',
		jsonb_build_array(jsonb_build_object('name','ops','line',3,'members',jsonb_build_array(jsonb_build_object('id','70200000-0000-4000-8000-0000000000a3','line',4),
			jsonb_build_object('id','70200000-0000-4000-8000-0000000000a1','line',5))))))));
	perform pg_temp.expect(r, 1, 'saved');
	if not exists (select 1 from public.qorpera_company_sidebar_sections where id = ops and name = 'ops' and position = 0)
		or exists (select 1 from public.qorpera_company_sidebar_sections where id = sales)
		or not exists (select 1 from public.qorpera_company_sidebar_placements where staff_agent_id = '70200000-0000-4000-8000-0000000000a1' and section_id = ops and position = 1)
		or exists (select 1 from public.qorpera_company_sidebar_room_placements where room_id = '70200000-0000-4000-8000-0000000000b1') then
		raise exception 'The sidebar follows the file'; end if;
	-- The Co-Founder and unknown ids are refused; two names that differ only by case are not a section each.
	r := pg_temp.commit(pg_temp.owner(), 'sections-0003', jsonb_build_array(
		pg_temp.sections(jsonb_build_object('kind','sections','sections',jsonb_build_array(jsonb_build_object('name','Top','line',3,
			'members',jsonb_build_array(jsonb_build_object('id','70200000-0000-4000-8000-0000000000c0','line',4))))))));
	if pg_temp.rule(r, 1) is distinct from 'structured_rule' then raise exception 'The Co-Founder is never in a section: %', r; end if;
	r := pg_temp.commit(pg_temp.owner(), 'sections-0004', jsonb_build_array(
		pg_temp.sections(jsonb_build_object('kind','sections','sections',jsonb_build_array(jsonb_build_object('name','Top','line',3,
			'members',jsonb_build_array(jsonb_build_object('id','70200000-0000-4000-8000-0000000000ff','line',4))))))));
	if pg_temp.rule(r, 1) is distinct from 'structured_rule' then raise exception 'An unknown id is refused: %', r; end if;
	r := pg_temp.commit(pg_temp.owner(), 'sections-0005', jsonb_build_array(
		pg_temp.sections(jsonb_build_object('kind','sections','sections',jsonb_build_array(
			jsonb_build_object('name','Top','line',3,'members','[]'::jsonb), jsonb_build_object('name','TOP','line',5,'members','[]'::jsonb))))));
	if pg_temp.rule(r, 1) is distinct from 'structured_invalid' then raise exception 'Section names are unique ignoring case: %', r; end if;
	-- An id already listed never blocks a save when its agent is gone: it keeps its place, which the sidebar hides.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'sections-0006', jsonb_build_array(jsonb_build_object('op','delete',
		'path','agents/vera','expectedVersion',pg_temp.version('agents/vera'),'asOfSeq',pg_temp.seq()))), 1, 'saved');
	r := pg_temp.commit(pg_temp.owner(), 'sections-0007', jsonb_build_array(pg_temp.sections(jsonb_build_object('kind','sections','sections',
		jsonb_build_array(jsonb_build_object('name','Ops','line',3,'members',jsonb_build_array(jsonb_build_object('id','70200000-0000-4000-8000-0000000000a3','line',4),
			jsonb_build_object('id','70200000-0000-4000-8000-0000000000a1','line',5))))))));
	perform pg_temp.expect(r, 1, 'saved');
	if not exists (select 1 from public.qorpera_company_sidebar_placements where staff_agent_id = '70200000-0000-4000-8000-0000000000a3'
			and section_id = ops and position = 0)
		or not exists (select 1 from public.qorpera_company_sidebar_placements where staff_agent_id = '70200000-0000-4000-8000-0000000000a1' and section_id = ops and position = 1) then
		raise exception 'A retired agent keeps its place'; end if;
end $$;

-- 8. Lock targets of group.md and sections.md -------------------------------------------------------------------------

do $$
declare t jsonb;
begin
	select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into t from public.qorpera_folder_structured_targets('70200000-0000-4000-8000-000000000020', pg_temp.owner(), jsonb_build_array(
		pg_temp.edit_group('launch', pg_temp.group_parse('70200000-0000-4000-8000-0000000000b1', 'Launch', array['70200000-0000-4000-8000-0000000000a1','70200000-0000-4000-8000-0000000000a2']::uuid[], array['70200000-0000-4000-8000-000000000001']::uuid[])))) x;
	if not t @> jsonb_build_array(jsonb_build_object('rank', 4, 'tbl', 'qorpera_company_rooms', 'key', '70200000-0000-4000-8000-0000000000b1', 'mode', 'nokeyupdate'))
		or not t @> '[{"rank":0,"tbl":"qorpera_profiles","key":"70200000-0000-4000-8000-000000000010","mode":"keyshare"}]' then
		raise exception 'A group edit locks the company row and its room: %', t; end if;
	select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into t from public.qorpera_folder_structured_targets('70200000-0000-4000-8000-000000000020', pg_temp.owner(), jsonb_build_array(
		pg_temp.new_group('fresh', '70200000-0000-4000-8000-0000000000b2', 'Fresh', array['70200000-0000-4000-8000-0000000000a1','70200000-0000-4000-8000-0000000000a2']::uuid[], null))) x;
	if t is distinct from '[{"rank":0,"tbl":"qorpera_profiles","key":"70200000-0000-4000-8000-000000000010","mode":"keyshare"}]' then
		raise exception 'A new chat locks the company row only: %', t; end if;
	select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into t from public.qorpera_folder_structured_targets('70200000-0000-4000-8000-000000000020', pg_temp.owner(), jsonb_build_array(
		pg_temp.sections('{"kind":"sections","sections":[]}'))) x;
	if t is distinct from '[{"rank":0,"tbl":"qorpera_profiles","key":"70200000-0000-4000-8000-000000000010","mode":"keyshare"}]' then
		raise exception 'sections.md locks the company row only: %', t; end if;
end $$;

-- 9. The member RPC's section actions refuse on folder-v2; the file is the way --------------------------------------------

do $$
begin
	perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"70200000-0000-4000-8000-000000000001"}', true);
	set local role authenticated;
	begin
		perform public.qorpera_manage_company_sidebar('70200000-0000-4000-8000-000000000010', jsonb_build_object('action','create_section',
			'sectionId','70200000-0000-4000-8000-0000000000d1','name','Direct'));
		raise exception 'A direct section must be refused' using errcode = 'QTF03';
	exception when sqlstate '55000' then null;
	end;
	reset role;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end $$;

-- 10. Ids across kinds, legacy keys, places kept while away, restores as they were, pins and hiding -------------------

do $$
declare r jsonb; ops uuid;
begin
	-- An agent never takes a conversation's id; a chat never takes a snapshot-v1 chat's key.
	r := pg_temp.commit(pg_temp.owner(), 'ids-0001', jsonb_build_array(pg_temp.hire('clash', '70200000-0000-4000-8000-0000000000b1', 'Clash')));
	if pg_temp.rule(r, 1) is distinct from 'structured_rule' then raise exception 'An agent cannot take a chat''s id: %', r; end if;
	insert into public.qorpera_company_rooms(id, profile_id, environment_id, room_key, name, purpose, status, version, source_path,
		source_path_version, source_snapshot_id, source_file_sha256, created_by_user_id)
	values ('70200000-0000-4000-8000-0000000000b4', '70200000-0000-4000-8000-000000000010', '70200000-0000-4000-8000-000000000020', 'chat-70200000-0000-4000-8000-0000000000b3', 'Legacy', 'Old.', 'active', 1, 'organization/rooms/70200000-0000-4000-8000-0000000000b4.json',
		extensions.gen_random_uuid(), extensions.gen_random_uuid(), repeat('c', 64), '70200000-0000-4000-8000-000000000001');
	r := pg_temp.commit(pg_temp.owner(), 'ids-0002', jsonb_build_array(
		pg_temp.new_group('legacy', '70200000-0000-4000-8000-0000000000b3', 'Legacy', array['70200000-0000-4000-8000-0000000000a1','70200000-0000-4000-8000-0000000000a2']::uuid[], null)));
	if pg_temp.rule(r, 1) is distinct from 'structured_rule' then raise exception 'A chat cannot take a legacy chat''s key: %', r; end if;
	-- The case rule names itself.
	r := pg_temp.commit(pg_temp.owner(), 'ids-0003', jsonb_build_array(
		pg_temp.sections(jsonb_build_object('kind','sections','sections',jsonb_build_array(
			jsonb_build_object('name','Top','line',3,'members','[]'::jsonb), jsonb_build_object('name','TOP','line',5,'members','[]'::jsonb))))));
	if coalesce(r -> 'units' -> 0 -> 'problems' -> 0 ->> 'message', '') not like '%case is ignored%' then
		raise exception 'Names equal ignoring case are named as such: %', r; end if;

	-- A crew chat and its place in a section; then its folder, and otto's, go.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'away-0001', jsonb_build_array(
		pg_temp.new_group('crew', '70200000-0000-4000-8000-0000000000b5', 'Crew', array['70200000-0000-4000-8000-0000000000a1','70200000-0000-4000-8000-0000000000a2']::uuid[], array['70200000-0000-4000-8000-000000000002']::uuid[]))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'away-0002', jsonb_build_array(pg_temp.sections(jsonb_build_object(
		'kind','sections','sections',jsonb_build_array(jsonb_build_object('name','Ops','line',3,'members',jsonb_build_array(
			jsonb_build_object('id','70200000-0000-4000-8000-0000000000a1','line',4), jsonb_build_object('id','70200000-0000-4000-8000-0000000000b5','line',5), jsonb_build_object('id','70200000-0000-4000-8000-0000000000a2','line',6)))))))),
		1, 'saved');
	select id into ops from public.qorpera_company_sidebar_sections where profile_id = '70200000-0000-4000-8000-000000000010' and lower(name) = 'ops';
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'away-0003', jsonb_build_array(
		jsonb_build_object('op','delete','path','agents/groups/crew','expectedVersion',pg_temp.version('agents/groups/crew'),'asOfSeq',pg_temp.seq()),
		jsonb_build_object('op','delete','path','agents/otto','expectedVersion',pg_temp.version('agents/otto'),'asOfSeq',pg_temp.seq()))), 2, 'saved');
	-- sections.md saved again while they are away: their places stay (the sidebar hides them).
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'away-0004', jsonb_build_array(pg_temp.sections(jsonb_build_object(
		'kind','sections','sections',jsonb_build_array(jsonb_build_object('name','Ops','line',3,'members',jsonb_build_array(
			jsonb_build_object('id','70200000-0000-4000-8000-0000000000a1','line',4), jsonb_build_object('id','70200000-0000-4000-8000-0000000000b5','line',5), jsonb_build_object('id','70200000-0000-4000-8000-0000000000a2','line',6)))))))),
		1, 'saved');
	if not exists (select 1 from public.qorpera_company_sidebar_room_placements where room_id = '70200000-0000-4000-8000-0000000000b5' and section_id = ops and position = 1)
		or not exists (select 1 from public.qorpera_company_sidebar_placements where staff_agent_id = '70200000-0000-4000-8000-0000000000a2' and section_id = ops and position = 2) then
		raise exception 'An agent or chat that is away keeps its place'; end if;
	-- Otto comes back archived, and the member leaves the company: the crew chat still restores as it was, and its
	-- members stay as written.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'away-0005', jsonb_build_array(
		pg_temp.hire('otto', '70200000-0000-4000-8000-0000000000a2', 'Otto'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'away-0006', jsonb_build_array(pg_temp.write('agents/otto/agent.md', 'agent',
		pg_temp.agent_text('70200000-0000-4000-8000-0000000000a2', 'Otto', 'agent', 'archived'), pg_temp.agent_parse('70200000-0000-4000-8000-0000000000a2', 'Otto', 'agent', 'archived'),
		pg_temp.version('agents/otto/agent.md')))), 1, 'saved');
	delete from public.qorpera_profile_members where profile_id = '70200000-0000-4000-8000-000000000010' and user_id = '70200000-0000-4000-8000-000000000002';
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'away-0007', jsonb_build_array(
		pg_temp.new_group('crew', '70200000-0000-4000-8000-0000000000b5', 'Crew', array['70200000-0000-4000-8000-0000000000a1','70200000-0000-4000-8000-0000000000a2']::uuid[], array['70200000-0000-4000-8000-000000000002']::uuid[]))), 1, 'saved');
	if (pg_temp.room('70200000-0000-4000-8000-0000000000b5')).status is distinct from 'active' or pg_temp.members('70200000-0000-4000-8000-0000000000b5') is distinct from 'member:02,staff_agent:a1,staff_agent:a2' then
		raise exception 'The crew chat restores as it was: % %', to_jsonb(pg_temp.room('70200000-0000-4000-8000-0000000000b5')), pg_temp.members('70200000-0000-4000-8000-0000000000b5'); end if;
	-- A new id in the same file would still be checked.
	r := pg_temp.commit(pg_temp.owner(), 'away-0008', jsonb_build_array(pg_temp.edit_group('crew',
		pg_temp.group_parse('70200000-0000-4000-8000-0000000000b5', 'Crew', array['70200000-0000-4000-8000-0000000000a1','70200000-0000-4000-8000-0000000000a2']::uuid[], array['70200000-0000-4000-8000-000000000002','70200000-0000-4000-8000-000000000003']::uuid[]))));
	if pg_temp.rule(r, 1) is distinct from 'structured_rule' then raise exception 'A new person is still checked: %', r; end if;
end $$;

-- Pins and hidden agents stay member settings on folder-v2.
do $$
begin
	perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"70200000-0000-4000-8000-000000000001"}', true);
	set local role authenticated;
	perform public.qorpera_manage_company_sidebar('70200000-0000-4000-8000-000000000010', jsonb_build_object('action','set_pins','order',jsonb_build_array('70200000-0000-4000-8000-0000000000a1'),
		'groupChats',true));
	reset role;
	if not exists (select 1 from public.qorpera_member_sidebar_agents where profile_id = '70200000-0000-4000-8000-000000000010' and user_id = '70200000-0000-4000-8000-000000000001'
		and staff_agent_id = '70200000-0000-4000-8000-0000000000a1' and pinned_position = 0 and not hidden) then
		raise exception 'Pins work on folder-v2'; end if;
	set local role authenticated;
	perform public.qorpera_manage_company_sidebar('70200000-0000-4000-8000-000000000010', jsonb_build_object('action','set_hidden','staffAgentId','70200000-0000-4000-8000-0000000000a1','hidden',true));
	reset role;
	if not exists (select 1 from public.qorpera_member_sidebar_agents where profile_id = '70200000-0000-4000-8000-000000000010' and user_id = '70200000-0000-4000-8000-000000000001'
		and staff_agent_id = '70200000-0000-4000-8000-0000000000a1' and hidden) then
		raise exception 'Hiding works on folder-v2'; end if;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end $$;

rollback;
