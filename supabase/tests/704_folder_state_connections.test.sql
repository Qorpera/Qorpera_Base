-- Company state files, F2-3 (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §2, §4): connections on the folder core.
-- The settings are the platform's (the vault's writer), the body is the company's; one file per account; the file
-- stays while the account is connected; the index is its own table and no vault row is ever written by a save.
begin;

insert into auth.users(id,email) values
	('70400000-0000-4000-8000-000000000001','conn-owner@example.test'),
	('70400000-0000-4000-8000-000000000002','conn-member@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id) values
	('70400000-0000-4000-8000-000000000010','Nordlys Connections','70400000-0000-4000-8000-000000000001'), ('70400000-0000-4000-8000-000000000011','Other','70400000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('70400000-0000-4000-8000-000000000010','70400000-0000-4000-8000-000000000001','conn-owner@example.test','Owner','owner'),
	('70400000-0000-4000-8000-000000000010','70400000-0000-4000-8000-000000000002','conn-member@example.test','Member','contributor'),
	('70400000-0000-4000-8000-000000000011','70400000-0000-4000-8000-000000000001','conn-owner@example.test','Owner','owner');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id) values
	('70400000-0000-4000-8000-000000000020','70400000-0000-4000-8000-000000000010','Environment',1,'70400000-0000-4000-8000-000000000001'), ('70400000-0000-4000-8000-000000000021','70400000-0000-4000-8000-000000000011','Environment',1,'70400000-0000-4000-8000-000000000001'),
	('70400000-0000-4000-8000-000000000022','70400000-0000-4000-8000-000000000010','Second environment',1,'70400000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256) values
	('70400000-0000-4000-8000-0000000000d1','70400000-0000-4000-8000-000000000010','https://broker.example.test','key-1',repeat('1',64)),
	('70400000-0000-4000-8000-0000000000d2','70400000-0000-4000-8000-000000000011','https://broker.example.test','key-2',repeat('2',64));
insert into public.qorpera_cloud_secrets(id,profile_id,environment_id,broker_authority_id,owner_kind,connector_id,secret_name,purpose,
	status,current_version,created_by_user_id,revoked_at,revoked_by_user_id,account_label,available_to_all_agents) values
	('70400000-0000-4000-8000-0000000000e1','70400000-0000-4000-8000-000000000010','70400000-0000-4000-8000-000000000020','70400000-0000-4000-8000-0000000000d1','company','gmail','primary','Gmail account','active',1,'70400000-0000-4000-8000-000000000001',null,null,'hello@nordlys.test',true),
	('70400000-0000-4000-8000-0000000000e2','70400000-0000-4000-8000-000000000010','70400000-0000-4000-8000-000000000020','70400000-0000-4000-8000-0000000000d1','company','github','primary','GitHub account','active',1,'70400000-0000-4000-8000-000000000001',null,null,'nordlys',true),
	('70400000-0000-4000-8000-0000000000e3','70400000-0000-4000-8000-000000000010','70400000-0000-4000-8000-000000000020','70400000-0000-4000-8000-0000000000d1','company','google_drive','primary','Drive account','revoked',1,'70400000-0000-4000-8000-000000000001',
		statement_timestamp(),'70400000-0000-4000-8000-000000000001','drive@nordlys.test',true),
	('70400000-0000-4000-8000-0000000000e4','70400000-0000-4000-8000-000000000011','70400000-0000-4000-8000-000000000021','70400000-0000-4000-8000-0000000000d2','company','gmail','primary','Gmail account','active',1,'70400000-0000-4000-8000-000000000001',null,null,'x@other.test',true),
	('70400000-0000-4000-8000-0000000000e5','70400000-0000-4000-8000-000000000010','70400000-0000-4000-8000-000000000022','70400000-0000-4000-8000-0000000000d1','company','gmail','primary','Gmail account','active',1,'70400000-0000-4000-8000-000000000001',null,null,'e3@nordlys.test',true);
insert into public.qorpera_cloud_secrets(id,profile_id,environment_id,broker_authority_id,owner_kind,owner_user_id,connector_id,secret_name,
	purpose,status,current_version,created_by_user_id,account_label) values
	('70400000-0000-4000-8000-0000000000e6','70400000-0000-4000-8000-000000000010','70400000-0000-4000-8000-000000000020','70400000-0000-4000-8000-0000000000d1','member','70400000-0000-4000-8000-000000000001','gmail','mine','My Gmail','active',1,'70400000-0000-4000-8000-000000000001','owner@nordlys.test');

select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
select public.qorpera_folder_enable('70400000-0000-4000-8000-000000000020') \g /dev/null
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
create function pg_temp.stage(p_text text, p_profile uuid default '70400000-0000-4000-8000-000000000010') returns jsonb language plpgsql as $$
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
		(select version from public.qorpera_folder_entries where environment_id = '70400000-0000-4000-8000-000000000020'
			and key_text = 'vision/vision.md'))
$$;
create function pg_temp.commit(p_actor jsonb, p_key text, p_units jsonb) returns jsonb language plpgsql as $$
begin
	perform pg_temp.possess('70400000-0000-4000-8000-000000000020', p_actor, p_units);
	return public.qorpera_folder_commit('70400000-0000-4000-8000-000000000020', p_actor, p_key, p_units);
end $$;
create function pg_temp.owner() returns jsonb language sql as $$
	select '{"kind":"member","userId":"70400000-0000-4000-8000-000000000001"}'::jsonb
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
	select version from public.qorpera_folder_entries where environment_id = '70400000-0000-4000-8000-000000000020' and key_text = p_key
$$;
create function pg_temp.seq() returns bigint language sql as $$
	select last_seq from public.qorpera_folder_clocks where environment_id = '70400000-0000-4000-8000-000000000020'
$$;
create function pg_temp.staff(p_id uuid) returns public.qorpera_profile_staff language sql as $$
	select * from public.qorpera_profile_staff where profile_id = '70400000-0000-4000-8000-000000000010' and staff_agent_id = p_id
$$;

create function pg_temp.conn_text(p_id uuid, p_service text, p_account text, p_purpose text default '') returns text language sql as $$
	select format(E'---\nid: %s\nservice: %s\naccount: %s\nstatus: connected\nactions:\n  - send_message\nconnected_by: 70400000-0000-4000-8000-000000000001\nconnected_at: 2026-09-28T12:00:00Z\n---\n%s', p_id, p_service, p_account, p_purpose)
$$;
create function pg_temp.conn_parse(p_id uuid, p_service text, p_account text, p_purpose text default '') returns jsonb language sql as $$
	select jsonb_build_object('kind','connection','id',p_id,'service',p_service,'account',p_account,'status','connected',
		'actions',jsonb_build_array('send_message'),'connectedBy','70400000-0000-4000-8000-000000000001','connectedAt','2026-09-28T12:00:00Z','purpose',p_purpose)
$$;
create function pg_temp.conn(p_name text, p_id uuid, p_service text, p_account text, p_purpose text default '') returns jsonb language sql as $$
	select pg_temp.write('connections/' || p_name || '.md', 'connection', pg_temp.conn_text(p_id, p_service, p_account, p_purpose),
		pg_temp.conn_parse(p_id, p_service, p_account, p_purpose), pg_temp.version('connections/' || p_name || '.md'))
$$;
create function pg_temp.platform() returns jsonb language sql as $$ select '{"kind":"platform"}'::jsonb $$;
create function pg_temp.member() returns jsonb language sql as $$
	select '{"kind":"member","userId":"70400000-0000-4000-8000-000000000002"}'::jsonb
$$;
create function pg_temp.idx(p_id uuid) returns public.qorpera_folder_connection_index language sql as $$
	select * from public.qorpera_folder_connection_index where secret_id = p_id
$$;
create function pg_temp.refused(p_result jsonb, p_unit integer default 1) returns boolean language sql as $$
	select coalesce(p_result -> 'units' -> (p_unit - 1) ->> 'outcome' = 'refused'
		and p_result -> 'units' -> (p_unit - 1) ->> 'reason' = 'structured_rule', false)
$$;

-- 1. The company, and the platform writing its first connection file ---------------------------------------------------

-- The vault row's place: an update in this same transaction keeps xmin but moves the row (ctid).
select set_config('qorpera_test.vault_ctid', (select ctid::text from public.qorpera_cloud_secrets where id = '70400000-0000-4000-8000-0000000000e1'), true) \g /dev/null

do $$
declare r jsonb; i integer; x public.qorpera_folder_connection_index;
begin
	r := pg_temp.commit(pg_temp.platform(), 'seed-0001', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','vision'), pg_temp.vision('Nordlys Connections'),
		jsonb_build_object('op','mkdir','path','agents'),
		pg_temp.write('agents/sections.md', 'sections', E'# Sections\n', '{"kind":"sections","sections":[]}'),
		pg_temp.hire('co-founder', '70400000-0000-4000-8000-0000000000c0', 'Co-Founder', 'co-founder'),
		jsonb_build_object('op','mkdir','path','connections')));
	for i in 1..6 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	perform pg_temp.expect(pg_temp.commit(pg_temp.platform(), 'conn-0001', jsonb_build_array(
		pg_temp.conn('hello', '70400000-0000-4000-8000-0000000000e1', 'gmail', 'hello@nordlys.test'))), 1, 'saved');
	x := pg_temp.idx('70400000-0000-4000-8000-0000000000e1');
	if x.secret_id is null or x.folder_path is distinct from 'connections/hello.md' or x.purpose is distinct from ''
		or x.folder_path_version is distinct from pg_temp.version('connections/hello.md') or x.retired_at is not null then
		raise exception 'The platform''s connection file is indexed: %', to_jsonb(x); end if;
	if (select ctid::text from public.qorpera_cloud_secrets where id = '70400000-0000-4000-8000-0000000000e1') is distinct from current_setting('qorpera_test.vault_ctid') then
		raise exception 'A save never writes the vault row'; end if;
end $$;

-- 2. The body is the company's; the settings are the platform's ----------------------------------------------------------

do $$
declare r jsonb;
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(), 'body-0001', jsonb_build_array(
		pg_temp.conn('hello', '70400000-0000-4000-8000-0000000000e1', 'gmail', 'hello@nordlys.test', 'Customer mail. Answer within a day.'))), 1, 'saved');
	if (pg_temp.idx('70400000-0000-4000-8000-0000000000e1')).purpose is distinct from 'Customer mail. Answer within a day.' then
		raise exception 'The body reaches the index'; end if;
	-- A member changes a setting, creates a file, or changes the id: refused.
	if not pg_temp.refused(pg_temp.commit(pg_temp.member(), 'set-0001', jsonb_build_array(
		pg_temp.conn('hello', '70400000-0000-4000-8000-0000000000e1', 'gmail', 'support@nordlys.test', 'Customer mail. Answer within a day.')))) then
		raise exception 'A member cannot change a connection''s settings'; end if;
	if not pg_temp.refused(pg_temp.commit(pg_temp.member(), 'set-0002', jsonb_build_array(
		pg_temp.conn('code', '70400000-0000-4000-8000-0000000000e2', 'github', 'nordlys')))) then
		raise exception 'Only the platform creates a connection file'; end if;
	if not pg_temp.refused(pg_temp.commit(pg_temp.platform(), 'set-0003', jsonb_build_array(
		pg_temp.conn('hello', '70400000-0000-4000-8000-0000000000e2', 'github', 'nordlys')))) then
		raise exception 'A connection file''s id never changes'; end if;
end $$;

-- 3. The platform writes only what the vault holds, one file per account ---------------------------------------------------

do $$
declare r jsonb;
begin
	if not pg_temp.refused(pg_temp.commit(pg_temp.platform(), 'vault-0001', jsonb_build_array(
		pg_temp.conn('other', '70400000-0000-4000-8000-0000000000e4', 'gmail', 'x@other.test')))) then
		raise exception 'Another company''s account is refused'; end if;
	if not pg_temp.refused(pg_temp.commit(pg_temp.platform(), 'vault-0002', jsonb_build_array(
		pg_temp.conn('drive', '70400000-0000-4000-8000-0000000000e3', 'google_drive', 'drive@nordlys.test')))) then
		raise exception 'A disconnected account gets no file'; end if;
	if not pg_temp.refused(pg_temp.commit(pg_temp.platform(), 'vault-0003', jsonb_build_array(
		pg_temp.conn('code', '70400000-0000-4000-8000-0000000000e2', 'gmail', 'nordlys')))) then
		raise exception 'The service matches the account'; end if;
	if not pg_temp.refused(pg_temp.commit(pg_temp.platform(), 'vault-0004', jsonb_build_array(
		pg_temp.conn('hello-again', '70400000-0000-4000-8000-0000000000e1', 'gmail', 'hello@nordlys.test')))) then
		raise exception 'One file per account'; end if;
	-- Two units of one change set: the second file for the same account is refused.
	r := pg_temp.commit(pg_temp.platform(), 'vault-0005', jsonb_build_array(
		pg_temp.conn('code', '70400000-0000-4000-8000-0000000000e2', 'github', 'nordlys'), pg_temp.conn('code-two', '70400000-0000-4000-8000-0000000000e2', 'github', 'nordlys')));
	perform pg_temp.expect(r, 1, 'saved');
	if not pg_temp.refused(r, 2) then raise exception 'One file per account, across units too: %', r; end if;
	-- An account of the company's other environment, or a member's own account, gets no company file.
	if not pg_temp.refused(pg_temp.commit(pg_temp.platform(), 'vault-0007', jsonb_build_array(
		pg_temp.conn('elsewhere', '70400000-0000-4000-8000-0000000000e5', 'gmail', 'e3@nordlys.test')))) then
		raise exception 'An account of another environment is refused'; end if;
	if not pg_temp.refused(pg_temp.commit(pg_temp.platform(), 'vault-0008', jsonb_build_array(
		pg_temp.conn('mine', '70400000-0000-4000-8000-0000000000e6', 'gmail', 'owner@nordlys.test')))) then
		raise exception 'A member''s own account gets no company file'; end if;
	-- The shape: a clock past 23:59:59 and an action listed twice are not a connection.
	perform pg_temp.expect(pg_temp.commit(pg_temp.platform(), 'vault-0009', jsonb_build_array(pg_temp.write('connections/code.md', 'connection',
		pg_temp.conn_text('70400000-0000-4000-8000-0000000000e2', 'github', 'nordlys') || '  ', pg_temp.conn_parse('70400000-0000-4000-8000-0000000000e2', 'github', 'nordlys') || '{"connectedAt":"2026-09-28T24:00:00Z"}',
		pg_temp.version('connections/code.md')))), 1, 'refused', 'structured_invalid');
	perform pg_temp.expect(pg_temp.commit(pg_temp.platform(), 'vault-0010', jsonb_build_array(pg_temp.write('connections/code.md', 'connection',
		pg_temp.conn_text('70400000-0000-4000-8000-0000000000e2', 'github', 'nordlys') || '   ', pg_temp.conn_parse('70400000-0000-4000-8000-0000000000e2', 'github', 'nordlys') || '{"actions":["send_message","send_message"]}',
		pg_temp.version('connections/code.md')))), 1, 'refused', 'structured_invalid');
	-- The shape: an unknown status is not a connection.
	r := pg_temp.commit(pg_temp.platform(), 'vault-0006', jsonb_build_array(pg_temp.write('connections/code.md', 'connection',
		pg_temp.conn_text('70400000-0000-4000-8000-0000000000e2', 'github', 'nordlys') || ' ', pg_temp.conn_parse('70400000-0000-4000-8000-0000000000e2', 'github', 'nordlys') || '{"status":"up"}',
		pg_temp.version('connections/code.md'))));
	perform pg_temp.expect(r, 1, 'refused', 'structured_invalid');
	-- Never reviewed.
	if public.qorpera_folder_structured_review_class('70400000-0000-4000-8000-000000000020', jsonb_build_object('kind','staff_agent','requesterUserId','70400000-0000-4000-8000-000000000002'),
		pg_temp.conn('code', '70400000-0000-4000-8000-0000000000e2', 'github', 'nordlys', 'Code.'), 'connections/code.md', null) is distinct from 'plain' then
		raise exception 'A connection file is never reviewed'; end if;
end $$;

-- 4. Moving, and the file staying while the account is connected -------------------------------------------------------

do $$
declare r jsonb; x public.qorpera_folder_connection_index;
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(), 'move-0001', jsonb_build_array(jsonb_build_object('op','move',
		'from','connections/hello.md','to','connections/support.md','expectedVersion',pg_temp.version('connections/hello.md')))), 1, 'saved');
	x := pg_temp.idx('70400000-0000-4000-8000-0000000000e1');
	if x.folder_path is distinct from 'connections/support.md' or x.folder_path_version is distinct from pg_temp.version('connections/support.md') then
		raise exception 'The index follows a move: %', to_jsonb(x); end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(), 'move-0002', jsonb_build_array(jsonb_build_object('op','move',
		'from','connections/support.md','to','support.md','expectedVersion',pg_temp.version('connections/support.md')))), 1, 'refused', 'kind_change');
	-- Deleting is refused while the account is connected, for the platform too.
	if not pg_temp.refused(pg_temp.commit(pg_temp.platform(), 'delete-0001', jsonb_build_array(jsonb_build_object('op','delete',
		'path','connections/support.md','expectedVersion',pg_temp.version('connections/support.md'))))) then
		raise exception 'A connected account''s file stays'; end if;
	-- Disconnected: a member still does not delete it; the platform removes the file, and the index row retires.
	update public.qorpera_cloud_secrets set status = 'revoked', revoked_at = statement_timestamp(), revoked_by_user_id = '70400000-0000-4000-8000-000000000001'
	where id = '70400000-0000-4000-8000-0000000000e1';
	if not pg_temp.refused(pg_temp.commit(pg_temp.member(), 'delete-0003', jsonb_build_array(jsonb_build_object('op','delete',
		'path','connections/support.md','expectedVersion',pg_temp.version('connections/support.md'))))) then
		raise exception 'Only the platform removes a connection''s file'; end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.platform(), 'delete-0002', jsonb_build_array(jsonb_build_object('op','delete',
		'path','connections/support.md','expectedVersion',pg_temp.version('connections/support.md')))), 1, 'saved');
	if (pg_temp.idx('70400000-0000-4000-8000-0000000000e1')).retired_at is null then raise exception 'Removing the file retires its index row'; end if;
end $$;

-- 5. A file saved before this slice is not trusted; two files for one account in one unit ---------------------------------

do $$
declare r jsonb;
begin
	-- As if connections/code.md had been saved before F2-3 (no index row points at it): a member's edit is a new file.
	delete from public.qorpera_folder_connection_index where secret_id = '70400000-0000-4000-8000-0000000000e2';
	if not pg_temp.refused(pg_temp.commit(pg_temp.member(), 'old-0001', jsonb_build_array(
		pg_temp.conn('code', '70400000-0000-4000-8000-0000000000e2', 'github', 'nordlys', 'Code.')))) then
		raise exception 'An unindexed file is not the saved version'; end if;
	-- And it never blocks the platform's real file for that account.
	perform pg_temp.expect(pg_temp.commit(pg_temp.platform(), 'old-0002', jsonb_build_array(
		pg_temp.conn('github', '70400000-0000-4000-8000-0000000000e2', 'github', 'nordlys'))), 1, 'saved');
	-- The other company's creation commit: one new folder carrying two files for one account.
	perform public.qorpera_folder_enable('70400000-0000-4000-8000-000000000021');
	r := pg_temp.commit_in('70400000-0000-4000-8000-000000000021', pg_temp.platform(), 'pair-0001', jsonb_build_array(jsonb_build_object('op','new_folder',
		'path','connections','contents',jsonb_build_array(
			jsonb_build_object('path','a.md','kind','file','file',pg_temp.stage(pg_temp.conn_text('70400000-0000-4000-8000-0000000000e4', 'gmail', 'x@other.test'), '70400000-0000-4000-8000-000000000011')),
			jsonb_build_object('path','b.md','kind','file','file',pg_temp.stage(pg_temp.conn_text('70400000-0000-4000-8000-0000000000e4', 'gmail', 'x@other.test'), '70400000-0000-4000-8000-000000000011'))),
		'structured',jsonb_build_array(
			pg_temp.entry('connections/a.md','connection',pg_temp.conn_text('70400000-0000-4000-8000-0000000000e4', 'gmail', 'x@other.test'),pg_temp.conn_parse('70400000-0000-4000-8000-0000000000e4', 'gmail', 'x@other.test')),
			pg_temp.entry('connections/b.md','connection',pg_temp.conn_text('70400000-0000-4000-8000-0000000000e4', 'gmail', 'x@other.test'),pg_temp.conn_parse('70400000-0000-4000-8000-0000000000e4', 'gmail', 'x@other.test'))))));
	if not pg_temp.refused(r) then raise exception 'Two files for one account in one unit are refused: %', r; end if;
end $$;

rollback;
