-- Company state files, F2-1 (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md): the vision and agents on the folder
-- core. Seeding, the company index, the roster as the index of agent.md, the refusals of contract 5.6, the path
-- checks, and the review class.
begin;

insert into auth.users(id,email) values
	('70000000-0000-4000-8000-000000000001','state-owner@example.test'),
	('70000000-0000-4000-8000-000000000002','state-member@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('70000000-0000-4000-8000-000000000010','Nordlys Studio','70000000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('70000000-0000-4000-8000-000000000010','70000000-0000-4000-8000-000000000001','state-owner@example.test','Owner','owner'),
	('70000000-0000-4000-8000-000000000010','70000000-0000-4000-8000-000000000002','state-member@example.test','Member','contributor');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id) values
	('70000000-0000-4000-8000-000000000020','70000000-0000-4000-8000-000000000010','Environment',1,'70000000-0000-4000-8000-000000000001');

select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
select public.qorpera_folder_enable('70000000-0000-4000-8000-000000000020') \g /dev/null

-- Verified bytes for a text, as the object gateway leaves them.
create function pg_temp.stage(p_text text) returns jsonb language plpgsql security definer as $$
declare v_hash text := encode(extensions.digest(convert_to(p_text,'utf8'),'sha256'),'hex'); v_manifest text; v_manifest_hash text;
begin
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects','70000000-0000-4000-8000-000000000010/' || v_hash,
		jsonb_build_object('size',octet_length(p_text))) on conflict do nothing;
	v_manifest := jsonb_build_object('schema','qorpera.cloud-file-manifest/v1','fileSha256',v_hash,
		'bytes',octet_length(p_text),'mediaType','application/octet-stream','chunks',case when p_text = '' then '[]'::jsonb
		else jsonb_build_array(jsonb_build_object('sha256',v_hash,'bytes',octet_length(p_text))) end)::text;
	v_manifest_hash := encode(extensions.digest(convert_to(v_manifest,'utf8'),'sha256'),'hex');
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects','70000000-0000-4000-8000-000000000010/' || v_manifest_hash,
		jsonb_build_object('size',octet_length(v_manifest))) on conflict do nothing;
	perform public.qorpera_verify_company_path_file('70000000-0000-4000-8000-000000000010',v_manifest);
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
		(select version from public.qorpera_folder_entries where environment_id = '70000000-0000-4000-8000-000000000020'
			and key_text = 'vision/vision.md'))
$$;
create function pg_temp.commit(p_actor jsonb, p_key text, p_units jsonb) returns jsonb language sql as $$
	select public.qorpera_folder_commit('70000000-0000-4000-8000-000000000020', p_actor, p_key, p_units)
$$;
create function pg_temp.owner() returns jsonb language sql as $$
	select '{"kind":"member","userId":"70000000-0000-4000-8000-000000000001"}'::jsonb
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
	select version from public.qorpera_folder_entries where environment_id = '70000000-0000-4000-8000-000000000020' and key_text = p_key
$$;
create function pg_temp.seq() returns bigint language sql as $$
	select last_seq from public.qorpera_folder_clocks where environment_id = '70000000-0000-4000-8000-000000000020'
$$;
create function pg_temp.staff(p_id uuid) returns public.qorpera_profile_staff language sql as $$
	select * from public.qorpera_profile_staff where profile_id = '70000000-0000-4000-8000-000000000010' and staff_agent_id = p_id
$$;

-- 1. Seeding: the creation commit, as the platform -------------------------------------------------------------------

do $$
declare r jsonb; i integer; c public.qorpera_profile_staff; x public.qorpera_folder_company_index;
	cofounder constant uuid := '70000000-0000-4000-8000-0000000000c0';
begin
	r := pg_temp.commit('{"kind":"platform"}', 'seed-0001', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','vision'),
		pg_temp.vision('Nordlys Studio'),
		jsonb_build_object('op','mkdir','path','agents'),
		pg_temp.write('agents/sections.md', 'sections', E'# Sections\n', '{"kind":"sections","sections":[]}'),
		pg_temp.hire('co-founder', cofounder, 'Co-Founder', 'co-founder'),
		jsonb_build_object('op','mkdir','path','agents/groups'),
		jsonb_build_object('op','mkdir','path','connections'),
		jsonb_build_object('op','mkdir','path','skills'),
		jsonb_build_object('op','mkdir','path','rules')));
	for i in 1..9 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	select * into x from public.qorpera_folder_company_index where environment_id = '70000000-0000-4000-8000-000000000020';
	if x.name <> 'Nordlys Studio' or not x.vision_seeded or x.vision_path_version <> pg_temp.version('vision/vision.md') then
		raise exception 'The seeded vision must index the company name: %', to_jsonb(x); end if;
	c := pg_temp.staff(cofounder);
	if c.staff_agent_id is null or c.template_id <> 'co-founder' or c.folder_path <> 'agents/co-founder/agent.md'
		or c.folder_path_version <> pg_temp.version('agents/co-founder/agent.md') or c.employment_status <> 'active'
		or c.display_name <> 'Co-Founder' or c.charter <> 'Sell.' or c.appearance_color <> 'native' or c.source_path is not null
		or c.hire_overlay is not null or c.updated_by_user_id <> '70000000-0000-4000-8000-000000000001' then
		raise exception 'The seeded Co-Founder must be indexed: %', to_jsonb(c); end if;
	if not exists (select 1 from public.qorpera_company_cofounders where profile_id = '70000000-0000-4000-8000-000000000010'
		and staff_agent_id = cofounder and formation_id is null) then
		raise exception 'The creation commit records the Co-Founder'; end if;
	if (select count(*) from public.qorpera_folder_path_versions v where v.commit_id = (r ->> 'commitId')::uuid
		and v.structured is not null) <> 3 then
		raise exception 'Every structured file keeps its checked parse on its version'; end if;
end $$;

-- 2. The vision: a new name, and files the platform cannot read -----------------------------------------------------

do $$
declare r jsonb; u jsonb;
begin
	r := pg_temp.commit(pg_temp.owner(), 'vision-0001', jsonb_build_array(pg_temp.vision('Nordlys Health')));
	perform pg_temp.expect(r, 1, 'saved');
	if (select name from public.qorpera_folder_company_index where environment_id = '70000000-0000-4000-8000-000000000020') <> 'Nordlys Health'
		or (select vision_seeded from public.qorpera_folder_company_index where environment_id = '70000000-0000-4000-8000-000000000020') then
		raise exception 'A new vision name reaches the index, and the vision is no longer the seed'; end if;
	-- No parse: the writer could not read it.
	u := pg_temp.vision('Other') - 'structured';
	r := pg_temp.commit(pg_temp.owner(), 'vision-0002', jsonb_build_array(u));
	perform pg_temp.expect(r, 1, 'refused', 'structured_invalid');
	-- The text read is not the file saved.
	u := jsonb_set(pg_temp.vision('Other'), '{structured,0,text}', '"# Something else\n"');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'vision-0003', jsonb_build_array(u)), 1, 'refused', 'structured_invalid');
	-- The writer's own problems travel with the unit and are reported.
	u := jsonb_set(pg_temp.vision('Other') #- '{structured,0,parse}', '{structured,0,problems}',
		'[{"line":1,"key":null,"code":"body","message":"the first line must be # and the company''s name"}]');
	r := pg_temp.commit(pg_temp.owner(), 'vision-0004', jsonb_build_array(u));
	if pg_temp.expect(r, 1, 'refused', 'structured_invalid') -> 'problems' -> 0 ->> 'code' <> 'body' then
		raise exception 'A refusal carries the parser''s problems: %', r; end if;
	-- A parse of the wrong shape.
	u := jsonb_set(pg_temp.vision('Other'), '{structured,0,parse,extra}', '1');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'vision-0005', jsonb_build_array(u)), 1, 'refused', 'structured_invalid');
	-- Seeded: never deleted or moved.
	r := pg_temp.commit(pg_temp.owner(), 'vision-0006', jsonb_build_array(
		jsonb_build_object('op','delete','path','vision/vision.md','expectedVersion',pg_temp.version('vision/vision.md')),
		jsonb_build_object('op','move','from','agents/sections.md','to','agents/sections-old.md',
			'expectedVersion',pg_temp.version('agents/sections.md')),
		jsonb_build_object('op','delete','path','rules','expectedVersion',pg_temp.version('rules'),'asOfSeq',pg_temp.seq())));
	perform pg_temp.expect(r, 1, 'refused', 'seeded');
	perform pg_temp.expect(r, 2, 'refused', 'seeded');
	perform pg_temp.expect(r, 3, 'refused', 'seeded');
end $$;

-- 3. Hiring, editing, archiving -------------------------------------------------------------------------------------

do $$
declare r jsonb; s public.qorpera_profile_staff; v bigint;
	nora constant uuid := '70000000-0000-4000-8000-0000000000a1'; cofounder constant uuid := '70000000-0000-4000-8000-0000000000c0';
begin
	r := pg_temp.commit(pg_temp.owner(), 'hire-0001', jsonb_build_array(pg_temp.hire('nora-dahl', nora, 'Nora Dahl')));
	perform pg_temp.expect(r, 1, 'saved');
	s := pg_temp.staff(nora);
	if s.folder_path <> 'agents/nora-dahl/agent.md' or s.template_id is not null or s.lifecycle_state <> 'setup' or s.version <> 1 then
		raise exception 'A hire is a roster row pointing at its agent.md: %', to_jsonb(s); end if;
	-- A later hire cannot be a co-founder, nor take an id another folder holds.
	r := pg_temp.commit(pg_temp.owner(), 'hire-0002', jsonb_build_array(
		pg_temp.hire('boss', '70000000-0000-4000-8000-0000000000a2', 'Boss', 'co-founder'),
		pg_temp.hire('twin', nora, 'Twin')));
	perform pg_temp.expect(r, 1, 'refused', 'structured_rule');
	perform pg_temp.expect(r, 2, 'refused', 'structured_rule');
	-- The platform too, once a Co-Founder is recorded.
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'hire-0003', jsonb_build_array(
		pg_temp.hire('boss', '70000000-0000-4000-8000-0000000000a2', 'Boss', 'co-founder'))), 1, 'refused', 'structured_rule');
	-- An edit: the id never changes; name and status reach the roster, and the version moves.
	r := pg_temp.commit(pg_temp.owner(), 'edit-0001', jsonb_build_array(pg_temp.write('agents/nora-dahl/agent.md', 'agent',
		pg_temp.agent_text('70000000-0000-4000-8000-0000000000a9', 'Nora'), pg_temp.agent_parse('70000000-0000-4000-8000-0000000000a9', 'Nora'),
		pg_temp.version('agents/nora-dahl/agent.md'))));
	perform pg_temp.expect(r, 1, 'refused', 'structured_rule');
	r := pg_temp.commit(pg_temp.owner(), 'edit-0002', jsonb_build_array(pg_temp.write('agents/nora-dahl/agent.md', 'agent',
		pg_temp.agent_text(nora, 'Nora Skov', 'agent', 'archived'), pg_temp.agent_parse(nora, 'Nora Skov', 'agent', 'archived'),
		pg_temp.version('agents/nora-dahl/agent.md'))));
	perform pg_temp.expect(r, 1, 'saved');
	s := pg_temp.staff(nora);
	if s.display_name <> 'Nora Skov' or s.employment_status <> 'archived' or s.version <> 2
		or s.folder_path_version <> pg_temp.version('agents/nora-dahl/agent.md') then
		raise exception 'An edit reaches the roster: %', to_jsonb(s); end if;
	-- The Co-Founder keeps its kind and is never archived.
	r := pg_temp.commit(pg_temp.owner(), 'edit-0003', jsonb_build_array(
		pg_temp.write('agents/co-founder/agent.md', 'agent', pg_temp.agent_text(cofounder, 'Co-Founder', 'agent'),
			pg_temp.agent_parse(cofounder, 'Co-Founder', 'agent'), pg_temp.version('agents/co-founder/agent.md')),
		pg_temp.write('agents/co-founder/agent.md', 'agent', pg_temp.agent_text(cofounder, 'Co-Founder', 'co-founder', 'archived'),
			pg_temp.agent_parse(cofounder, 'Co-Founder', 'co-founder', 'archived'), pg_temp.version('agents/co-founder/agent.md'))));
	perform pg_temp.expect(r, 1, 'refused', 'structured_rule');
	perform pg_temp.expect(r, 2, 'refused', 'structured_rule');
end $$;

-- 4. Renaming, deleting and restoring an agent -------------------------------------------------------------------------

do $$
declare r jsonb; s public.qorpera_profile_staff; nora constant uuid := '70000000-0000-4000-8000-0000000000a1';
	moved uuid;
begin
	-- A rename: edit agent.md, then move the folder, in one change set. The id and so the thread stay.
	r := pg_temp.commit(pg_temp.owner(), 'rename-0001', jsonb_build_array(
		pg_temp.write('agents/nora-dahl/agent.md', 'agent', pg_temp.agent_text(nora, 'Nora Skov'), pg_temp.agent_parse(nora, 'Nora Skov'),
			pg_temp.version('agents/nora-dahl/agent.md')),
		jsonb_build_object('op','move','from','agents/nora-dahl','to','agents/nora-skov',
			'expectedVersion',pg_temp.version('agents/nora-dahl'),'asOfSeq',pg_temp.seq())));
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.expect(r, 2, 'saved');
	s := pg_temp.staff(nora);
	moved := pg_temp.version('agents/nora-skov/agent.md');
	if s.folder_path <> 'agents/nora-skov/agent.md' or s.folder_path_version <> moved or s.employment_status <> 'active' then
		raise exception 'A rename moves the roster row with the folder: %', to_jsonb(s); end if;
	if (select structured -> 'parse' ->> 'name' from public.qorpera_folder_path_versions where version = moved) <> 'Nora Skov' then
		raise exception 'A moved agent.md keeps its parse'; end if;
	-- agent.md never goes alone, the Co-Founder's folder is never deleted, and names follow the rule.
	r := pg_temp.commit(pg_temp.owner(), 'delete-0001', jsonb_build_array(
		jsonb_build_object('op','delete','path','agents/nora-skov/agent.md','expectedVersion',moved),
		jsonb_build_object('op','move','from','agents/nora-skov/agent.md','to','agents/nora-skov/agent-old.md','expectedVersion',moved),
		jsonb_build_object('op','delete','path','agents/co-founder','expectedVersion',pg_temp.version('agents/co-founder'),'asOfSeq',pg_temp.seq()),
		jsonb_build_object('op','move','from','agents/nora-skov','to','agents/Nora','expectedVersion',pg_temp.version('agents/nora-skov'),
			'asOfSeq',pg_temp.seq()),
		jsonb_build_object('op','move','from','agents/nora-skov','to','notes-nora','expectedVersion',pg_temp.version('agents/nora-skov'),
			'asOfSeq',pg_temp.seq())));
	perform pg_temp.expect(r, 1, 'refused', 'lone_structured_file');
	perform pg_temp.expect(r, 2, 'refused', 'lone_structured_file');
	perform pg_temp.expect(r, 3, 'refused', 'cofounder');
	perform pg_temp.expect(r, 4, 'refused', 'structured_invalid');
	perform pg_temp.expect(r, 5, 'refused', 'kind_change');
	-- Deleting the folder retires the agent; restoring the folder brings the same row back.
	r := pg_temp.commit(pg_temp.owner(), 'delete-0002', jsonb_build_array(jsonb_build_object('op','delete','path','agents/nora-skov',
		'expectedVersion',pg_temp.version('agents/nora-skov'),'asOfSeq',pg_temp.seq())));
	perform pg_temp.expect(r, 1, 'saved');
	s := pg_temp.staff(nora);
	if s.folder_retired_at is null or s.employment_status <> 'archived' or s.deleted_at is not null then
		raise exception 'Deleting the folder retires the agent: %', to_jsonb(s); end if;
	r := pg_temp.commit(pg_temp.owner(), 'restore-0001', jsonb_build_array(pg_temp.hire('nora-back', nora, 'Nora Skov')));
	perform pg_temp.expect(r, 1, 'saved');
	s := pg_temp.staff(nora);
	if s.folder_retired_at is not null or s.employment_status <> 'active' or s.folder_path <> 'agents/nora-back/agent.md' then
		raise exception 'A restored folder brings the agent back: %', to_jsonb(s); end if;
end $$;

-- 5. Kinds never change, copies never land structured files, and folder names are checked -------------------------------

do $$
declare r jsonb; i integer; nora constant uuid := '70000000-0000-4000-8000-0000000000a1';
begin
	r := pg_temp.commit(pg_temp.owner(), 'notes-0001', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','notes'),
		jsonb_build_object('op','write','path','notes/hire.md','file',pg_temp.stage('hello')),
		jsonb_build_object('op','mkdir','path','agents/empty'),
		jsonb_build_object('op','mkdir','path','agents/nora-back/routines')));
	for i in 1..4 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	r := pg_temp.commit(pg_temp.owner(), 'kinds-0001', jsonb_build_array(
		jsonb_build_object('op','move','from','notes/hire.md','to','agents/empty/agent.md','expectedVersion',pg_temp.version('notes/hire.md')),
		jsonb_build_object('op','copy','from','agents/nora-back/agent.md','to','agents/empty/agent.md'),
		jsonb_build_object('op','copy','from','agents/nora-back','to','agents/nora-copy'),
		jsonb_build_object('op','mkdir','path','agents/Anna'),
		jsonb_build_object('op','mkdir','path','agents/empty/Routines'),
		pg_temp.write('agents/nora-back/routines/Daily.md', 'routine', 'x', '{"kind":"routine"}'),
		pg_temp.write('agents/nora-back/Agent.md', 'agent', pg_temp.agent_text(nora, 'Nora'), pg_temp.agent_parse(nora, 'Nora'),
			pg_temp.version('agents/nora-back/agent.md'))));
	perform pg_temp.expect(r, 1, 'refused', 'kind_change');
	perform pg_temp.expect(r, 2, 'refused', 'structured_copy');
	perform pg_temp.expect(r, 3, 'refused', 'structured_copy');
	perform pg_temp.expect(r, 4, 'refused', 'structured_invalid');
	perform pg_temp.expect(r, 5, 'refused', 'structured_invalid');
	perform pg_temp.expect(r, 6, 'refused', 'structured_invalid');
	perform pg_temp.expect(r, 7, 'refused', 'structured_invalid');
	-- An ordinary folder moves anywhere; an ordinary copy is untouched.
	r := pg_temp.commit(pg_temp.owner(), 'kinds-0002', jsonb_build_array(
		jsonb_build_object('op','copy','from','notes','to','notes-copy'),
		jsonb_build_object('op','move','from','agents/empty','to','agents/spare','expectedVersion',pg_temp.version('agents/empty'),
			'asOfSeq',pg_temp.seq())));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved');
end $$;

-- 6. The review class of an in-house run's units ----------------------------------------------------------------------

do $$
declare nora constant uuid := '70000000-0000-4000-8000-0000000000a1'; run jsonb := '{"kind":"run","sessionKind":"in_house"}';
	env constant uuid := '70000000-0000-4000-8000-000000000020';
begin
	if public.qorpera_folder_structured_review_class(env, run, pg_temp.hire('newbie', '70000000-0000-4000-8000-0000000000a3', 'New'),
		'agents/newbie', null) <> 'delegation' then raise exception 'A hire is delegation'; end if;
	if public.qorpera_folder_structured_review_class(env, run, pg_temp.write('agents/nora-back/agent.md', 'agent',
		pg_temp.agent_text(nora, 'Nora B'), pg_temp.agent_parse(nora, 'Nora B'), pg_temp.version('agents/nora-back/agent.md')),
		'agents/nora-back/agent.md', null) <> 'plain' then raise exception 'A rename of an agent is plain'; end if;
	if public.qorpera_folder_structured_review_class(env, run, pg_temp.write('agents/nora-back/agent.md', 'agent',
		pg_temp.agent_text(nora, 'Nora', 'agent', 'archived'), pg_temp.agent_parse(nora, 'Nora', 'agent', 'archived'),
		pg_temp.version('agents/nora-back/agent.md')), 'agents/nora-back/agent.md', null) <> 'delegation' then
		raise exception 'Archiving an agent is delegation'; end if;
	if public.qorpera_folder_structured_review_class(env, run, pg_temp.vision('X'), 'vision/vision.md', null) <> 'plain'
		or public.qorpera_folder_structured_review_class(env, run, jsonb_build_object('op','mkdir','path','notes2'), 'notes2', null) <> 'plain' then
		raise exception 'The vision and ordinary paths are plain'; end if;
end $$;

-- 7. The path checks, the same list as the TS parser's companyStatePathProblems -----------------------------------------

do $$
declare t record;
begin
	for t in select * from (values
		('agents/anna/routines/daily.md', false, 0), ('agents/anna/routines/Daily report.md', false, 1),
		('agents/anna/routines/Daily.md', false, 1), ('agents/anna/Routines/daily.md', false, 1), ('sales/Leads.md', false, 0),
		('agents/anna', true, 0), ('agents/Anna', true, 1), ('agents/anna/Routines', true, 1), ('agents/anna/todos/Old Stuff', true, 1),
		('agents/groups/Launch', true, 1), ('agents/anna/Notes', true, 0), ('Sales', true, 0), ('agents/Anna/', true, 1),
		('agents/anna/Agent.md', false, 1), ('Agents/anna/agent.md', false, 1), ('rules/.md', false, 1), ('AGENTS/anna/AGENT.MD', false, 1),
		('vision/vision.md', false, 0), ('agents/groups/launch-team/group.md', false, 0)) v(path, folder, problems)
	loop
		if jsonb_array_length(public.qorpera_company_state_path_problems(t.path, t.folder)) <> t.problems then
			raise exception 'Path % (folder %) expected % problems, got %', t.path, t.folder, t.problems,
				public.qorpera_company_state_path_problems(t.path, t.folder); end if;
	end loop;
	for t in select * from (values
		('vision/vision.md', 'vision'), ('agents/sections.md', 'sections'), ('agents/a/agent.md', 'agent'),
		('agents/a/routines/r.md', 'routine'), ('agents/a/todos/t.md', 'todo'), ('agents/a/todos/t/w/brief.md', 'worker-brief'),
		('agents/a/todos/t/w/results.md', 'worker-results'), ('agents/groups/g/group.md', 'group'), ('connections/c.md', 'connection'),
		('rules/r.md', 'rule'), ('rules/.md', 'rule'), ('agents/groups/agent.md', null), ('agents/a/routines/notes/x.md', null),
		('agents/sections.md/agent.md', null), ('skills/x/SKILL.md', null)) v(key, kind)
	loop
		if public.qorpera_structured_path_kind(t.key) is distinct from t.kind then
			raise exception 'Key % expected kind %, got %', t.key, t.kind, public.qorpera_structured_path_kind(t.key); end if;
	end loop;
end $$;

rollback;
