-- 20260930526000: each platform folder's README.md is an ordinary file (QORPERA-RUNTIME-CONTRACT.md 5.6). The database
-- reads it as the shared parser does (isCompanyFolderReadme): no structured kind in connections/, rules/, human-tasks/
-- or contacts/; no task's file or folder in human-tasks/; a place of its own at the roots of interfaces/ and tables/.
-- The platform seeds all eight as the creation commit does, with no parse, no index row and no wake; a member edits,
-- moves, deletes and restores them as the folder's other rules allow; a move still never changes a file's kind. The
-- fixture is test 541's.
begin;

insert into auth.users(id,email) values
	('54300000-0000-4000-8000-000000000001','readme-owner@example.test'),
	('54300000-0000-4000-8000-000000000002','readme-member@example.test'),
	('54300000-0000-4000-8000-000000000003','readme-stranger@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id) values ('54300000-0000-4000-8000-000000000010','Nordlys Notes','54300000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('54300000-0000-4000-8000-000000000010','54300000-0000-4000-8000-000000000001','readme-owner@example.test','Owner','owner'),
	('54300000-0000-4000-8000-000000000010','54300000-0000-4000-8000-000000000002','readme-member@example.test','Member','contributor');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id) values
	('54300000-0000-4000-8000-000000000020','54300000-0000-4000-8000-000000000010','Environment',1,'54300000-0000-4000-8000-000000000001');

select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
select public.qorpera_folder_enable('54300000-0000-4000-8000-000000000020') \g /dev/null
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
create function pg_temp.stage(p_text text, p_profile uuid default '54300000-0000-4000-8000-000000000010') returns jsonb language plpgsql as $$
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

create function pg_temp.commit(p_actor jsonb, p_key text, p_units jsonb) returns jsonb language plpgsql as $$
begin
	perform pg_temp.possess('54300000-0000-4000-8000-000000000020', p_actor, p_units);
	return public.qorpera_folder_commit('54300000-0000-4000-8000-000000000020', p_actor, p_key, p_units);
end $$;
create function pg_temp.platform() returns jsonb language sql as $$ select '{"kind":"platform"}'::jsonb $$;
create function pg_temp.owner() returns jsonb language sql as $$
	select '{"kind":"member","userId":"54300000-0000-4000-8000-000000000001"}'::jsonb
$$;
create function pg_temp.contributor() returns jsonb language sql as $$
	select '{"kind":"member","userId":"54300000-0000-4000-8000-000000000002"}'::jsonb
$$;
create function pg_temp.expect(p_result jsonb, p_unit integer, p_outcome text, p_reason text default null)
returns jsonb language plpgsql as $$
declare v jsonb := p_result -> 'units' -> (p_unit - 1);
begin
	if v ->> 'outcome' is distinct from p_outcome or v ->> 'reason' is distinct from p_reason then
		raise exception 'Unit % expected % (%), got %', p_unit, p_outcome, p_reason, p_result using errcode = 'QTF01'; end if;
	return v;
end $$;
-- Refused with this reason and, when given, this first problem.
create function pg_temp.refused(p_result jsonb, p_unit integer, p_reason text, p_message text default null) returns void
language plpgsql as $$
begin
	perform pg_temp.expect(p_result, p_unit, 'refused', p_reason);
	if p_message is not null and p_result -> 'units' -> (p_unit - 1) -> 'problems' -> 0 ->> 'message' is distinct from p_message then
		raise exception 'Unit % expected "%", got %', p_unit, p_message, p_result using errcode = 'QTF01'; end if;
end $$;
-- Not saved: refused, or the commit itself refused for the actor's authority (42501).
create function pg_temp.not_saved(p_actor jsonb, p_key text, p_units jsonb) returns boolean language plpgsql as $$
begin
	return pg_temp.commit(p_actor, p_key, p_units) -> 'units' -> 0 ->> 'outcome' is distinct from 'saved';
exception when insufficient_privilege then return true;
end $$;
create function pg_temp.version(p_key text) returns uuid language sql as $$
	select version from public.qorpera_folder_entries where environment_id = '54300000-0000-4000-8000-000000000020' and key_text = p_key
		and kind <> 'claim'
$$;
create function pg_temp.seq() returns bigint language sql as $$
	select last_seq from public.qorpera_folder_clocks where environment_id = '54300000-0000-4000-8000-000000000020'
$$;
-- An ordinary file's write: its bytes and no parse, as the object gateway's creation commit sends a README.
create function pg_temp.plain(p_path text, p_text text, p_expected uuid default null) returns jsonb language sql as $$
	select jsonb_build_object('op','write','path',p_path,'file',pg_temp.stage(p_text))
		|| case when p_expected is not null then jsonb_build_object('expectedVersion', p_expected) else '{}'::jsonb end
$$;
create function pg_temp.remove(p_path text) returns jsonb language sql as $$
	select jsonb_build_object('op','delete','path',p_path,'expectedVersion',pg_temp.version(public.qorpera_folder_key(p_path)),
		'asOfSeq',pg_temp.seq())
$$;
create function pg_temp.move(p_from text, p_to text) returns jsonb language sql as $$
	select jsonb_build_object('op','move','from',p_from,'to',p_to,
		'expectedVersion',pg_temp.version(public.qorpera_folder_key(p_from)),'asOfSeq',pg_temp.seq())
$$;

-- 1. Which key is a README, and the kinds and task stems around it -----------------------------------------------------

do $$
declare v_root text;
begin
	foreach v_root in array array['agents','connections','human-tasks','contacts','skills','rules','interfaces','tables'] loop
		if not public.qorpera_company_folder_readme(v_root || '/readme.md')
			or public.qorpera_structured_path_kind(v_root || '/readme.md') is not null
			or public.qorpera_structured_path_kind(public.qorpera_folder_key(v_root || '/README.md')) is not null
			or jsonb_array_length(public.qorpera_company_state_path_problems(v_root || '/README.md', false)) <> 0 then
			raise exception 'README.md in %/ is an ordinary file', v_root; end if;
	end loop;
	-- A platform folder's own README.md only.
	if public.qorpera_company_folder_readme('vision/readme.md') or public.qorpera_company_folder_readme('readme.md')
		or public.qorpera_company_folder_readme('docs/readme.md') or public.qorpera_company_folder_readme('agents/nora/readme.md')
		or public.qorpera_company_folder_readme('rules/readme.md.bak') or public.qorpera_company_folder_readme('rules/readme')
		or public.qorpera_company_folder_readme('interfaces/mailbox/readme.md') or public.qorpera_company_folder_readme(null) then
		raise exception 'Only a platform folder''s own README.md'; end if;
	-- Every other file keeps its kind.
	if public.qorpera_structured_path_kind('rules/readme-first.md') is distinct from 'rule'
		or public.qorpera_structured_path_kind('rules/network.toml') is distinct from 'network-rules'
		or public.qorpera_structured_path_kind('connections/readme-2.md') is distinct from 'connection'
		or public.qorpera_structured_path_kind('connections/hook-readme.md') is distinct from 'hook'
		or public.qorpera_structured_path_kind('human-tasks/readme-2.md') is distinct from 'human-task'
		or public.qorpera_structured_path_kind('contacts/readmes.md') is distinct from 'contact'
		or public.qorpera_structured_path_kind('agents/sections.md') is distinct from 'sections'
		or public.qorpera_structured_path_kind('interfaces/order.md') is distinct from 'interface-order' then
		raise exception 'The other files keep their kinds'; end if;
	-- human-tasks/README.md is no task's; a task's file and folder still name it.
	if public.qorpera_company_state_task_stem('human-tasks/readme.md') is not null
		or public.qorpera_company_state_task_stem('human-tasks/fit-disk.md') is distinct from 'fit-disk'
		or public.qorpera_company_state_task_stem('human-tasks/fit-disk/proof/photo-1.jpg') is distinct from 'fit-disk'
		or public.qorpera_company_state_task_stem('human-tasks/readme-2.md') is distinct from 'readme-2' then
		raise exception 'A task''s stem'; end if;
	if has_function_privilege('anon', 'public.qorpera_company_folder_readme(text)', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_company_folder_readme(text)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_company_folder_readme(text)', 'execute') then
		raise exception 'qorpera_company_folder_readme is the database''s alone'; end if;
end $$;

-- 2. The platform seeds the eight, as the creation commit does: saved, no parse, no index row, no wake -----------------

do $$
declare r jsonb; i integer; v_root text; v_units jsonb := '[]'::jsonb;
begin
	foreach v_root in array array['vision','agents','connections','human-tasks','contacts','skills','rules','interfaces','tables'] loop
		v_units := v_units || jsonb_build_array(jsonb_build_object('op','mkdir','path',v_root));
		if v_root <> 'vision' then
			v_units := v_units || jsonb_build_array(pg_temp.plain(v_root || '/README.md', 'What ' || v_root || E'/ is for.\n'));
		end if;
	end loop;
	r := pg_temp.commit(pg_temp.platform(), 'readme-seed', v_units);
	for i in 1..17 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	if (select count(*) from public.qorpera_folder_entries e join public.qorpera_folder_path_versions v on v.version = e.version
			where e.environment_id = '54300000-0000-4000-8000-000000000020' and e.kind = 'file' and e.key_text like '%/readme.md'
				and e.path like '%/README.md' and v.structured is null) <> 8 then
		raise exception 'Eight READMEs, stored as written, none with a parse'; end if;
	if exists (select 1 from public.qorpera_review_rules where folder_environment_id = '54300000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_folder_connection_index where environment_id = '54300000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_folder_human_task_index where environment_id = '54300000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_folder_contact_index where environment_id = '54300000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_folder_table_index where environment_id = '54300000-0000-4000-8000-000000000020') then
		raise exception 'No index takes a README'; end if;
	-- The human-task listener reads the change set and marks nothing.
	perform public.qorpera_folder_listener_commit('54300000-0000-4000-8000-000000000020', jsonb_build_object('commitId', r ->> 'commitId'));
	if exists (select 1 from public.qorpera_folder_human_task_wakes where environment_id = '54300000-0000-4000-8000-000000000020') then
		raise exception 'A README wakes nobody'; end if;
end $$;

-- 3. A member edits, deletes and writes them back; rules/ stays the owners' and admins' ---------------------------------

do $$
declare r jsonb;
begin
	r := pg_temp.commit(pg_temp.owner(), 'readme-edit-1', jsonb_build_array(
		pg_temp.plain('human-tasks/README.md', E'Jobs for people.\n', pg_temp.version('human-tasks/readme.md')),
		pg_temp.remove('contacts/README.md'),
		pg_temp.plain('rules/README.md', E'Rules for agents.\n', pg_temp.version('rules/readme.md'))));
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.expect(r, 2, 'saved');
	perform pg_temp.expect(r, 3, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'readme-edit-2', jsonb_build_array(
		pg_temp.plain('contacts/readme.md', E'People.\n'))), 1, 'saved');
	if exists (select 1 from public.qorpera_folder_contact_index where environment_id = '54300000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_review_rules where folder_environment_id = '54300000-0000-4000-8000-000000000020') then
		raise exception 'An edited README is still no contact and no rule'; end if;
	if not pg_temp.not_saved(pg_temp.contributor(), 'readme-edit-3', jsonb_build_array(
			pg_temp.plain('rules/README.md', E'Mine.\n', pg_temp.version('rules/readme.md')))) then
		raise exception 'rules/README.md is the owners'' and admins'''; end if;
	-- human-tasks/ still holds only task files and task folders beside it, and no link stands there.
	r := pg_temp.commit(pg_temp.owner(), 'readme-edit-4', jsonb_build_array(pg_temp.plain('human-tasks/notes.txt', E'x\n')));
	perform pg_temp.refused(r, 1, 'structured_rule', 'directly under human-tasks/ go only task files (.md) and task folders');
	if not pg_temp.not_saved(pg_temp.owner(), 'readme-edit-5', jsonb_build_array(jsonb_build_object('op','symlink',
			'path','human-tasks/README.md','target','../vision/vision.md','expectedVersion',pg_temp.version('human-tasks/readme.md')))) then
		raise exception 'No link stands directly under human-tasks/'; end if;
end $$;

-- 4. interfaces/ and tables/: each root takes README.md or readme.md beside what it held, and nothing else -------------

do $$
declare r jsonb;
begin
	r := pg_temp.commit(pg_temp.owner(), 'readme-place-1', jsonb_build_array(
		pg_temp.remove('interfaces/README.md'), pg_temp.remove('tables/README.md')));
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.expect(r, 2, 'saved');
	r := pg_temp.commit(pg_temp.owner(), 'readme-place-2', jsonb_build_array(
		pg_temp.plain('interfaces/readme.md', E'Pages.\n'), pg_temp.plain('tables/README.md', E'Tables.\n')));
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.expect(r, 2, 'saved');
	if pg_temp.version('interfaces/readme.md') is null or pg_temp.version('tables/readme.md') is null then
		raise exception 'Both roots hold their README again'; end if;
	r := pg_temp.commit(pg_temp.owner(), 'readme-place-3', jsonb_build_array(
		pg_temp.plain('tables/ReadMe.md', E'Tables.\n', pg_temp.version('tables/readme.md')),
		pg_temp.plain('interfaces/notes.md', E'Notes.\n'),
		pg_temp.plain('tables/notes.md', E'Notes.\n')));
	perform pg_temp.refused(r, 1, 'structured_rule', 'write README.md or readme.md');
	perform pg_temp.refused(r, 2, 'structured_rule',
		'interfaces/ holds README.md, order.md and one folder per interface, each with interface.toml and README.md only');
	perform pg_temp.refused(r, 3, 'structured_rule',
		'tables/ holds README.md and one folder per table, each with table.toml, rows.csv and README.md only');
end $$;

-- 5. A move never changes a file's kind; as an ordinary file a README goes where ordinary files go ---------------------

do $$
declare r jsonb;
begin
	r := pg_temp.commit(pg_temp.owner(), 'readme-move-1', jsonb_build_array(
		pg_temp.move('human-tasks/README.md', 'human-tasks/fit-disk.md'),
		pg_temp.move('rules/README.md', 'rules/ask-first.md'),
		pg_temp.move('connections/README.md', 'connections/gmail.md')));
	perform pg_temp.refused(r, 1, 'kind_change');
	perform pg_temp.refused(r, 2, 'kind_change');
	perform pg_temp.refused(r, 3, 'kind_change');
	r := pg_temp.commit(pg_temp.owner(), 'readme-move-2', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','docs'),
		jsonb_build_object('op','copy','from','connections/README.md','to','docs/connections.md'),
		pg_temp.move('agents/README.md', 'docs/agents.md'),
		pg_temp.move('skills/README.md', 'docs/skills.md')));
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.expect(r, 2, 'saved');
	perform pg_temp.expect(r, 3, 'saved');
	perform pg_temp.expect(r, 4, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'readme-move-3', jsonb_build_array(
		pg_temp.move('docs/agents.md', 'agents/README.md'))), 1, 'saved');
	if pg_temp.version('agents/readme.md') is null or pg_temp.version('docs/agents.md') is not null then
		raise exception 'agents/README.md moved back'; end if;
end $$;

rollback;
