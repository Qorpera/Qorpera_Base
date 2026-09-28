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
-- Verified bytes for a text, as the object gateway leaves them.
create function pg_temp.stage(p_text text, p_profile uuid default '70200000-0000-4000-8000-000000000010')
returns jsonb language plpgsql security definer as $$
declare v_hash text := encode(extensions.digest(convert_to(p_text,'utf8'),'sha256'),'hex'); v_manifest text; v_manifest_hash text;
begin
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects',p_profile::text || '/' || v_hash,
		jsonb_build_object('size',octet_length(p_text))) on conflict do nothing;
	v_manifest := jsonb_build_object('schema','qorpera.cloud-file-manifest/v1','fileSha256',v_hash,
		'bytes',octet_length(p_text),'mediaType','application/octet-stream','chunks',case when p_text = '' then '[]'::jsonb
		else jsonb_build_array(jsonb_build_object('sha256',v_hash,'bytes',octet_length(p_text))) end)::text;
	v_manifest_hash := encode(extensions.digest(convert_to(v_manifest,'utf8'),'sha256'),'hex');
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects',p_profile::text || '/' || v_manifest_hash,
		jsonb_build_object('size',octet_length(v_manifest))) on conflict do nothing;
	perform public.qorpera_verify_company_path_file(p_profile,v_manifest);
	return jsonb_build_object('manifestSha256',v_manifest_hash,'fileSha256',v_hash,'bytes',octet_length(p_text),
		'mediaType','text/markdown','executable',false);
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
create function pg_temp.commit(p_actor jsonb, p_key text, p_units jsonb) returns jsonb language sql as $$
	select public.qorpera_folder_commit('70200000-0000-4000-8000-000000000020', p_actor, p_key, p_units)
$$;
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
	if g.folder_path <> 'agents/groups/launch/group.md' or g.folder_path_version <> pg_temp.version('agents/groups/launch/group.md')
		or g.room_key <> 'chat-70200000-0000-4000-8000-0000000000b1' or g.name <> 'Launch' or g.subtitle is not null or g.purpose <> 'Plan the launch.'
		or g.status <> 'active' or g.version <> 1 or g.bound_staff_agent_id is not null or g.source_snapshot_id is not null
		or g.created_by_user_id <> '70200000-0000-4000-8000-000000000001' then
		raise exception 'A new group.md is a room pointing at it: %', to_jsonb(g); end if;
	select * into s from public.qorpera_shared_sessions where id = g.session_id;
	if s.status <> 'open' or s.title <> 'Launch' or s.staff_agent_id is not null or s.execution_scope <> jsonb_build_object('roomId', g.id)
		or s.audience_kind <> 'company' then
		raise exception 'A new group chat has its conversation: %', to_jsonb(s); end if;
	if pg_temp.members('70200000-0000-4000-8000-0000000000b1') <> 'member:01,staff_agent:a1,staff_agent:a2' then
		raise exception 'Members follow the lists: %', pg_temp.members('70200000-0000-4000-8000-0000000000b1'); end if;
	if public.qorpera_folder_structured_review_class('70200000-0000-4000-8000-000000000020', pg_temp.owner(), pg_temp.new_group('other', '70200000-0000-4000-8000-0000000000b2', 'Other',
		array['70200000-0000-4000-8000-0000000000a1','70200000-0000-4000-8000-0000000000a2']::uuid[], null), 'agents/groups/other', null) <> 'delegation' then
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
	if g.name <> 'Launch team' or g.subtitle <> '' or g.version <> 2 or g.folder_path_version <> pg_temp.version('agents/groups/launch/group.md') then
		raise exception 'An edit reaches the room: %', to_jsonb(g); end if;
	if (select title from public.qorpera_shared_sessions where id = g.session_id) <> 'Launch team' then
		raise exception 'The conversation takes the new name'; end if;
	if pg_temp.members('70200000-0000-4000-8000-0000000000b1') <> 'member:02,staff_agent:a1,staff_agent:a3' then
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
	if pg_temp.rule(r, 1) <> 'structured_rule' then raise exception 'The id never changes: %', r; end if;
	-- Added agents are active agents of this company, added people its members.
	r := pg_temp.commit(pg_temp.owner(), 'group-rule-02', jsonb_build_array(pg_temp.edit_group('launch',
		pg_temp.group_parse('70200000-0000-4000-8000-0000000000b1', 'Launch team', array['70200000-0000-4000-8000-0000000000a1','70200000-0000-4000-8000-0000000000a3','70200000-0000-4000-8000-0000000000ff']::uuid[], array['70200000-0000-4000-8000-000000000002']::uuid[], ''))));
	if pg_temp.rule(r, 1) <> 'structured_rule' then raise exception 'An unknown agent is refused: %', r; end if;
	r := pg_temp.commit(pg_temp.owner(), 'group-rule-03', jsonb_build_array(pg_temp.edit_group('launch',
		pg_temp.group_parse('70200000-0000-4000-8000-0000000000b1', 'Launch team', array['70200000-0000-4000-8000-0000000000a1','70200000-0000-4000-8000-0000000000a3']::uuid[], array['70200000-0000-4000-8000-000000000002','70200000-0000-4000-8000-000000000003']::uuid[], ''))));
	if pg_temp.rule(r, 1) <> 'structured_rule' then raise exception 'A person outside the company is refused: %', r; end if;
	-- A new chat's id belongs to no other conversation, agent or chat.
	select id into thread from public.qorpera_company_rooms where bound_staff_agent_id = '70200000-0000-4000-8000-0000000000a1';
	r := pg_temp.commit(pg_temp.owner(), 'group-rule-04', jsonb_build_array(
		pg_temp.new_group('thread', thread, 'Thread', array['70200000-0000-4000-8000-0000000000a1','70200000-0000-4000-8000-0000000000a2']::uuid[], null),
		pg_temp.new_group('agent', '70200000-0000-4000-8000-0000000000a2', 'Agent', array['70200000-0000-4000-8000-0000000000a1','70200000-0000-4000-8000-0000000000a2']::uuid[], null),
		pg_temp.new_group('twin', '70200000-0000-4000-8000-0000000000b1', 'Twin', array['70200000-0000-4000-8000-0000000000a1','70200000-0000-4000-8000-0000000000a2']::uuid[], null)));
	if pg_temp.rule(r, 1) <> 'structured_rule' or pg_temp.rule(r, 2) <> 'structured_rule' or pg_temp.rule(r, 3) <> 'structured_rule' then
		raise exception 'A chat id belongs to one chat: %', r; end if;
	-- The parse's shape: at least two agents.
	r := pg_temp.commit(pg_temp.owner(), 'group-rule-06', jsonb_build_array(pg_temp.edit_group('launch',
		pg_temp.group_parse('70200000-0000-4000-8000-0000000000b1', 'Launch team', array['70200000-0000-4000-8000-0000000000a1']::uuid[], array['70200000-0000-4000-8000-000000000002']::uuid[], ''))));
	if pg_temp.rule(r, 1) <> 'structured_invalid' then raise exception 'One agent is not a group chat: %', r; end if;
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
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'group-move-01', jsonb_build_array(jsonb_build_object('op','move',
		'from','agents/groups/launch','to','agents/groups/launch-team','expectedVersion',pg_temp.version('agents/groups/launch'),
		'asOfSeq',pg_temp.seq()))), 1, 'saved');
	g := pg_temp.room('70200000-0000-4000-8000-0000000000b1');
	if g.folder_path <> 'agents/groups/launch-team/group.md' or g.folder_path_version <> pg_temp.version('agents/groups/launch-team/group.md')
		or g.status <> 'active' then
		raise exception 'A chat follows its folder: %', to_jsonb(g); end if;
	-- Deleting the folder closes the chat and its conversation; its lock target is the room.
	select jsonb_agg(to_jsonb(x)) into t from public.qorpera_folder_structured_targets('70200000-0000-4000-8000-000000000020', pg_temp.owner(), jsonb_build_array(
		jsonb_build_object('op','delete','path','agents/groups/launch-team'))) x;
	if not t @> jsonb_build_array(jsonb_build_object('rank', 4, 'tbl', 'qorpera_company_rooms', 'key', '70200000-0000-4000-8000-0000000000b1', 'mode', 'nokeyupdate'))
		or not t @> '[{"rank":2,"tbl":"qorpera_profiles","mode":"keyshare"}]' then
		raise exception 'Deleting a chat locks the company row and its room: %', t; end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'group-delete-01', jsonb_build_array(jsonb_build_object('op','delete',
		'path','agents/groups/launch-team','expectedVersion',pg_temp.version('agents/groups/launch-team'),'asOfSeq',pg_temp.seq()))), 1, 'saved');
	g := pg_temp.room('70200000-0000-4000-8000-0000000000b1');
	if g.status <> 'archived' or g.folder_retired_at is null
		or (select status from public.qorpera_shared_sessions where id = g.session_id) <> 'closed' then
		raise exception 'Deleting the folder closes the chat: %', to_jsonb(g); end if;
	-- A restore reopens both, with the same conversation.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'group-restore-01', jsonb_build_array(
		pg_temp.new_group('launch', '70200000-0000-4000-8000-0000000000b1', 'Launch', array['70200000-0000-4000-8000-0000000000a1','70200000-0000-4000-8000-0000000000a2']::uuid[], array['70200000-0000-4000-8000-000000000001']::uuid[]))), 1, 'saved');
	if (pg_temp.room('70200000-0000-4000-8000-0000000000b1')).status <> 'active' or (pg_temp.room('70200000-0000-4000-8000-0000000000b1')).folder_retired_at is not null
		or (pg_temp.room('70200000-0000-4000-8000-0000000000b1')).session_id <> g.session_id
		or (select status from public.qorpera_shared_sessions where id = g.session_id) <> 'open' then
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
	if pg_temp.rule(r, 1) <> 'structured_rule' then raise exception 'The Co-Founder is never in a section: %', r; end if;
	r := pg_temp.commit(pg_temp.owner(), 'sections-0004', jsonb_build_array(
		pg_temp.sections(jsonb_build_object('kind','sections','sections',jsonb_build_array(jsonb_build_object('name','Top','line',3,
			'members',jsonb_build_array(jsonb_build_object('id','70200000-0000-4000-8000-0000000000ff','line',4))))))));
	if pg_temp.rule(r, 1) <> 'structured_rule' then raise exception 'An unknown id is refused: %', r; end if;
	r := pg_temp.commit(pg_temp.owner(), 'sections-0005', jsonb_build_array(
		pg_temp.sections(jsonb_build_object('kind','sections','sections',jsonb_build_array(
			jsonb_build_object('name','Top','line',3,'members','[]'::jsonb), jsonb_build_object('name','TOP','line',5,'members','[]'::jsonb))))));
	if pg_temp.rule(r, 1) <> 'structured_invalid' then raise exception 'Section names are unique ignoring case: %', r; end if;
	-- An id already listed never blocks a save when its agent is gone: the index skips it.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'sections-0006', jsonb_build_array(jsonb_build_object('op','delete',
		'path','agents/vera','expectedVersion',pg_temp.version('agents/vera'),'asOfSeq',pg_temp.seq()))), 1, 'saved');
	r := pg_temp.commit(pg_temp.owner(), 'sections-0007', jsonb_build_array(pg_temp.sections(jsonb_build_object('kind','sections','sections',
		jsonb_build_array(jsonb_build_object('name','Ops','line',3,'members',jsonb_build_array(jsonb_build_object('id','70200000-0000-4000-8000-0000000000a3','line',4),
			jsonb_build_object('id','70200000-0000-4000-8000-0000000000a1','line',5))))))));
	perform pg_temp.expect(r, 1, 'saved');
	if exists (select 1 from public.qorpera_company_sidebar_placements where staff_agent_id = '70200000-0000-4000-8000-0000000000a3')
		or not exists (select 1 from public.qorpera_company_sidebar_placements where staff_agent_id = '70200000-0000-4000-8000-0000000000a1' and section_id = ops and position = 0) then
		raise exception 'A retired agent is skipped'; end if;
end $$;

-- 8. Lock targets of group.md and sections.md -------------------------------------------------------------------------

do $$
declare t jsonb;
begin
	select jsonb_agg(to_jsonb(x)) into t from public.qorpera_folder_structured_targets('70200000-0000-4000-8000-000000000020', pg_temp.owner(), jsonb_build_array(
		pg_temp.edit_group('launch', pg_temp.group_parse('70200000-0000-4000-8000-0000000000b1', 'Launch', array['70200000-0000-4000-8000-0000000000a1','70200000-0000-4000-8000-0000000000a2']::uuid[], array['70200000-0000-4000-8000-000000000001']::uuid[])))) x;
	if not t @> jsonb_build_array(jsonb_build_object('rank', 4, 'tbl', 'qorpera_company_rooms', 'key', '70200000-0000-4000-8000-0000000000b1', 'mode', 'nokeyupdate'))
		or not t @> '[{"rank":2,"tbl":"qorpera_profiles","key":"70200000-0000-4000-8000-000000000010","mode":"keyshare"}]' then
		raise exception 'A group edit locks the company row and its room: %', t; end if;
	select jsonb_agg(to_jsonb(x)) into t from public.qorpera_folder_structured_targets('70200000-0000-4000-8000-000000000020', pg_temp.owner(), jsonb_build_array(
		pg_temp.new_group('fresh', '70200000-0000-4000-8000-0000000000b2', 'Fresh', array['70200000-0000-4000-8000-0000000000a1','70200000-0000-4000-8000-0000000000a2']::uuid[], null))) x;
	if t <> '[{"rank":2,"tbl":"qorpera_profiles","key":"70200000-0000-4000-8000-000000000010","mode":"keyshare"}]' then
		raise exception 'A new chat locks the company row only: %', t; end if;
	select jsonb_agg(to_jsonb(x)) into t from public.qorpera_folder_structured_targets('70200000-0000-4000-8000-000000000020', pg_temp.owner(), jsonb_build_array(
		pg_temp.sections('{"kind":"sections","sections":[]}'))) x;
	if t <> '[{"rank":2,"tbl":"qorpera_profiles","key":"70200000-0000-4000-8000-000000000010","mode":"keyshare"}]' then
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

rollback;
