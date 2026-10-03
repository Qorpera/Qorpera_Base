-- @fixture 704_folder_state_connections.test.sql until "-- 1. The company, and the platform writing its first connection file"
-- Company folder core C3, P22a (migration 20260930006000; deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §2, §8): the
-- vault marks a connection file due, and a writer claims it, commits the file as the platform and finishes the claim.
-- Here one session plays the writer (P22b's object gateway) through the folder core's commit; 853 races it.

-- The company's folder as 704 seeds it: the Co-Founder (c0) is its one agent.
do $$
declare r jsonb; i integer;
begin
	r := pg_temp.commit(pg_temp.platform(), 'seed-0001', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','vision'), pg_temp.vision('Nordlys Connections'),
		jsonb_build_object('op','mkdir','path','agents'),
		pg_temp.write('agents/sections.md', 'sections', E'# Sections\n', '{"kind":"sections","sections":[]}'),
		pg_temp.hire('co-founder', '70400000-0000-4000-8000-0000000000c0', 'Co-Founder', 'co-founder'),
		jsonb_build_object('op','mkdir','path','connections')));
	for i in 1..6 loop perform pg_temp.expect(r, i, 'saved'); end loop;
end $$;

create function pg_temp.marks(p_secret uuid) returns bigint language sql as $$
	select count(*) from public.qorpera_folder_connection_file_marks where secret_id = p_secret
$$;
create function pg_temp.work(p_secret uuid) returns public.qorpera_folder_connection_file_work language sql as $$
	select * from public.qorpera_folder_connection_file_work where secret_id = p_secret
$$;
-- Every claim answered in this test, for the last section's check that no secret ever leaves.
create temp table claims_seen(answer jsonb) on commit drop;
create function pg_temp.claim(p_worker uuid default '85200000-0000-4000-8000-00000000000a') returns jsonb language plpgsql as $$
declare v jsonb := public.qorpera_claim_connection_file(p_worker, 60);
begin
	insert into claims_seen values (v);
	return v;
end $$;
create function pg_temp.finish(p_claim jsonb, p_problem text default null, p_worker uuid default '85200000-0000-4000-8000-00000000000a')
returns boolean language sql as $$
	select (public.qorpera_finish_connection_file(p_worker, (p_claim ->> 'secretId')::uuid, (p_claim ->> 'generation')::bigint,
		p_problem) ->> 'finished')::boolean
$$;
create function pg_temp.operation(p_connector text, p_position integer) returns public.qorpera_cloud_connector_operations language sql as $$
	select * from public.qorpera_cloud_connector_operations where connector_id = p_connector and status = 'active'
	order by operation_id collate "C" offset p_position limit 1
$$;
create function pg_temp.grant_op(p_id uuid, p_secret uuid, p_connector text, p_position integer) returns void language sql as $$
	insert into public.qorpera_cloud_secret_operation_grants(id, profile_id, environment_id, secret_id, staff_agent_id, connector_id,
		operation_id, operation_version, tool_name, issued_by_user_id)
	select p_id, secret.profile_id, secret.environment_id, p_secret, '70400000-0000-4000-8000-0000000000c0', op.connector_id,
		op.operation_id, op.version, op.tool_name, '70400000-0000-4000-8000-000000000001'
	from public.qorpera_cloud_secrets as secret, pg_temp.operation(p_connector, p_position) as op where secret.id = p_secret
$$;
-- The writer: the claim's settings and the file's own text below them, committed as the platform in one unit with the
-- claim's operation key and the version the claim saw. The database checks the parse; the text is only hashed.
create function pg_temp.file_parse(p_claim jsonb, p_purpose text default '') returns jsonb language sql as $$
	select (p_claim -> 'settings') || jsonb_build_object('kind', 'connection', 'purpose', p_purpose)
$$;
create function pg_temp.write_claim(p_claim jsonb, p_purpose text default '', p_path text default null) returns jsonb language sql as $$
	select pg_temp.commit(pg_temp.platform(), p_claim ->> 'operationKey', jsonb_build_array(pg_temp.write(
		coalesce(p_path, p_claim -> 'current' ->> 'path', p_claim ->> 'path'), 'connection',
		E'---\n' || (pg_temp.file_parse(p_claim, p_purpose) - 'purpose' - 'kind')::text || E'\n---\n' || p_purpose,
		pg_temp.file_parse(p_claim, p_purpose), (p_claim -> 'current' ->> 'version')::uuid)))
$$;
create function pg_temp.delete_claim(p_claim jsonb) returns jsonb language sql as $$
	select pg_temp.commit(pg_temp.platform(), p_claim ->> 'operationKey', jsonb_build_array(jsonb_build_object('op', 'delete',
		'path', p_claim -> 'current' ->> 'path', 'expectedVersion', p_claim -> 'current' ->> 'version')))
$$;
create function pg_temp.expect_claim(p_claim jsonb, p_secret uuid, p_generation bigint, p_marks bigint) returns jsonb language plpgsql as $$
begin
	if p_claim ->> 'schema' is distinct from 'qorpera.connection-file-claim/v1' or (p_claim ->> 'secretId')::uuid is distinct from p_secret
		or (p_claim ->> 'generation')::bigint is distinct from p_generation
		or (p_marks is not null and (p_claim ->> 'marks')::bigint is distinct from p_marks)
		or p_claim ->> 'operationKey' is distinct from 'connection-file:' || p_secret || ':' || p_generation
		or (p_claim ->> 'environmentId')::uuid is distinct from '70400000-0000-4000-8000-000000000020' then
		raise exception 'Expected the claim of % (generation %, % marks), got %', p_secret, p_generation, p_marks, p_claim
			using errcode = 'QTF01'; end if;
	return p_claim;
end $$;

-- 1. The marks: a company connection in a folder-v2 environment, and only a field its file shows --------------------------

-- 704's secrets were written before the folder was enabled; the Co-Founder's hire then received a grant of every
-- operation of the two shared connections (Gmail e1, GitHub e2), and each grant marked its connection.
do $$
begin
	if pg_temp.marks('70400000-0000-4000-8000-0000000000e1') = 0
		or pg_temp.marks('70400000-0000-4000-8000-0000000000e1') <> (select count(*) from public.qorpera_cloud_secret_operation_grants
			where secret_id = '70400000-0000-4000-8000-0000000000e1' and status = 'active')
		or pg_temp.marks('70400000-0000-4000-8000-0000000000e2') = 0
		or pg_temp.marks('70400000-0000-4000-8000-0000000000e2') <> (select count(*) from public.qorpera_cloud_secret_operation_grants
			where secret_id = '70400000-0000-4000-8000-0000000000e2' and status = 'active')
		or exists (select 1 from public.qorpera_folder_connection_file_marks
			where secret_id not in ('70400000-0000-4000-8000-0000000000e1', '70400000-0000-4000-8000-0000000000e2')) then
		raise exception 'A hire''s grants mark the shared connections, and only them: %',
			(select jsonb_object_agg(secret_id, n) from (select secret_id, count(*) n from public.qorpera_folder_connection_file_marks
				group by secret_id) m); end if;
	-- The rest of this test starts with nothing due.
	delete from public.qorpera_folder_connection_file_marks;
end $$;

do $$
begin
	-- A second Gmail account of the company (e7); a member's own (e8); the company's in its environment that is not
	-- folder-v2 (e9); the other company's (ea).
	insert into public.qorpera_cloud_secrets(id,profile_id,environment_id,broker_authority_id,owner_kind,owner_user_id,connector_id,
		secret_name,purpose,status,current_version,created_by_user_id,account_label) values
		('85200000-0000-4000-8000-0000000000e7','70400000-0000-4000-8000-000000000010','70400000-0000-4000-8000-000000000020','70400000-0000-4000-8000-0000000000d1','company',null,'gmail','b','sentinel-purpose-e7','active',1,'70400000-0000-4000-8000-000000000001','sales@nordlys.test'),
		('85200000-0000-4000-8000-0000000000e8','70400000-0000-4000-8000-000000000010','70400000-0000-4000-8000-000000000020','70400000-0000-4000-8000-0000000000d1','member','70400000-0000-4000-8000-000000000002','gmail','mine','sentinel-purpose-e8','active',1,'70400000-0000-4000-8000-000000000002','me@nordlys.test'),
		('85200000-0000-4000-8000-0000000000e9','70400000-0000-4000-8000-000000000010','70400000-0000-4000-8000-000000000022','70400000-0000-4000-8000-0000000000d1','company',null,'gmail','second','sentinel-purpose-e9','active',1,'70400000-0000-4000-8000-000000000001','two@nordlys.test'),
		('85200000-0000-4000-8000-0000000000ea','70400000-0000-4000-8000-000000000011','70400000-0000-4000-8000-000000000021','70400000-0000-4000-8000-0000000000d2','company',null,'gmail','b','sentinel-purpose-ea','active',1,'70400000-0000-4000-8000-000000000001','y@other.test');
	if pg_temp.marks('85200000-0000-4000-8000-0000000000e7') <> 1 then raise exception 'A new company connection is due'; end if;
	if pg_temp.marks('85200000-0000-4000-8000-0000000000e8') + pg_temp.marks('85200000-0000-4000-8000-0000000000e9')
		+ pg_temp.marks('85200000-0000-4000-8000-0000000000ea') <> 0 then
		raise exception 'A member''s own secret, a snapshot environment''s and another company''s are never due'; end if;
	-- The vault's own text and versions are not in the file; the account is, once it changes.
	update public.qorpera_cloud_secrets set purpose = 'Changed purpose', current_version = 2, updated_at = clock_timestamp()
	where id = '70400000-0000-4000-8000-0000000000e1';
	update public.qorpera_cloud_secrets set account_label = 'hello@nordlys.test' where id = '70400000-0000-4000-8000-0000000000e1';
	if pg_temp.marks('70400000-0000-4000-8000-0000000000e1') <> 0 then raise exception 'Only a field the file shows marks it'; end if;
	update public.qorpera_cloud_secrets set account_label = 'team@nordlys.test' where id = '70400000-0000-4000-8000-0000000000e1';
	if pg_temp.marks('70400000-0000-4000-8000-0000000000e1') <> 1 then raise exception 'A new account name is due'; end if;
	-- A withdrawal of the Co-Founder's grant marks the connection; a grant on a member's own secret, and its withdrawal,
	-- mark nothing; a new grant and its withdrawal each mark it.
	update public.qorpera_cloud_secret_operation_grants set status = 'revoked', revoked_at = clock_timestamp(),
		revoked_by_user_id = '70400000-0000-4000-8000-000000000001'
	where secret_id = '70400000-0000-4000-8000-0000000000e1' and operation_id = (pg_temp.operation('gmail', 1)).operation_id
		and status = 'active';
	if pg_temp.marks('70400000-0000-4000-8000-0000000000e1') <> 2 then raise exception 'A withdrawal marks its connection'; end if;
	perform pg_temp.grant_op('85200000-0000-4000-8000-0000000000f3', '85200000-0000-4000-8000-0000000000e8', 'gmail', 1);
	update public.qorpera_cloud_secret_operation_grants set status = 'revoked', revoked_at = clock_timestamp(),
		revoked_by_user_id = '70400000-0000-4000-8000-000000000001' where id = '85200000-0000-4000-8000-0000000000f3';
	if pg_temp.marks('85200000-0000-4000-8000-0000000000e8') <> 0 then raise exception 'A member''s own grant marks nothing'; end if;
	perform pg_temp.grant_op('85200000-0000-4000-8000-0000000000f1', '70400000-0000-4000-8000-0000000000e1', 'gmail', 1);
	update public.qorpera_cloud_secret_operation_grants set status = 'revoked', revoked_at = clock_timestamp(),
		revoked_by_user_id = '70400000-0000-4000-8000-000000000001' where id = '85200000-0000-4000-8000-0000000000f1';
	if pg_temp.marks('70400000-0000-4000-8000-0000000000e1') <> 4 then raise exception 'Grants mark their connection'; end if;
	-- A website account: its secret and its row each mark it; its use does not; its two-step does.
	insert into public.qorpera_cloud_secrets(id,profile_id,environment_id,broker_authority_id,owner_kind,connector_id,secret_name,purpose,
		status,current_version,created_by_user_id,account_label) values
		('85200000-0000-4000-8000-0000000000eb','70400000-0000-4000-8000-000000000010','70400000-0000-4000-8000-000000000020','70400000-0000-4000-8000-0000000000d1','company','website','portal','sentinel-purpose-eb','active',1,'70400000-0000-4000-8000-000000000001','ops+portal@nordlys.test');
	insert into public.qorpera_company_accounts(secret_id, profile_id, environment_id, site, sign_in_hosts, login, status, opened_by_user_id)
	values ('85200000-0000-4000-8000-0000000000eb','70400000-0000-4000-8000-000000000010','70400000-0000-4000-8000-000000000020',
		'portal.example.com', '{sentinel-signin.example}', 'ops+portal@nordlys.test', 'pending', '70400000-0000-4000-8000-000000000001');
	update public.qorpera_company_accounts set last_used_at = clock_timestamp(),
		last_used_by_staff_agent_id = '70400000-0000-4000-8000-0000000000c0' where secret_id = '85200000-0000-4000-8000-0000000000eb';
	if pg_temp.marks('85200000-0000-4000-8000-0000000000eb') <> 2 then raise exception 'A website account is due once per change'; end if;
	update public.qorpera_company_accounts set two_step = 'authenticator' where secret_id = '85200000-0000-4000-8000-0000000000eb';
	if pg_temp.marks('85200000-0000-4000-8000-0000000000eb') <> 3 then raise exception 'Its two-step method is in its file'; end if;
	-- A Disconnect marks it.
	update public.qorpera_cloud_secrets set status = 'revoked', revoked_at = clock_timestamp(),
		revoked_by_user_id = '70400000-0000-4000-8000-000000000001' where id = '70400000-0000-4000-8000-0000000000e2';
	-- (Its grants may be withdrawn with it, each marking it too.)
	if pg_temp.marks('70400000-0000-4000-8000-0000000000e2') < 1 then raise exception 'A Disconnect is due'; end if;
end $$;

-- A vault version with a sealed envelope and a key, which must never reach a claim.
insert into public.qorpera_cloud_secret_versions(secret_id, version, broker_authority_id, key_id, encrypted_envelope, envelope_sha256,
	created_by_user_id)
values ('85200000-0000-4000-8000-0000000000e7', 1, '70400000-0000-4000-8000-0000000000d1', 'sentinelkey', decode('deadbeef', 'hex'),
	repeat('9', 64), '70400000-0000-4000-8000-000000000001');

-- 2. Who may claim and finish ---------------------------------------------------------------------------------------------

do $$
declare v_role text;
begin
	foreach v_role in array array['anon','authenticated'] loop
		if has_function_privilege(v_role, 'public.qorpera_claim_connection_file(uuid,integer)', 'EXECUTE')
			or has_function_privilege(v_role, 'public.qorpera_finish_connection_file(uuid,uuid,bigint,text)', 'EXECUTE') then
			raise exception 'Only the platform claims and finishes (%)', v_role; end if;
	end loop;
	if has_table_privilege('service_role', 'public.qorpera_folder_connection_file_marks', 'SELECT')
		or has_table_privilege('service_role', 'public.qorpera_folder_connection_file_work', 'SELECT')
		or has_function_privilege('service_role', 'public.qorpera_folder_connection_file_state(uuid)', 'EXECUTE') then
		raise exception 'The tables and the state are reached only through claim and finish'; end if;
	perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"70400000-0000-4000-8000-000000000001"}', true);
	begin
		perform public.qorpera_claim_connection_file('85200000-0000-4000-8000-00000000000a', 60);
		raise exception 'A member must not claim' using errcode = 'QTF01';
	exception when insufficient_privilege then null;
	end;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	begin
		perform public.qorpera_claim_connection_file('85200000-0000-4000-8000-00000000000a', 5);
		raise exception 'A lease is 30 to 900 seconds' using errcode = 'QTF01';
	exception when invalid_parameter_value then null;
	end;
end $$;

-- 3. Claims, oldest mark first, each answering what its file should say ---------------------------------------------------

do $$
declare c jsonb; w public.qorpera_folder_connection_file_work; e1 public.qorpera_cloud_secrets; account public.qorpera_company_accounts;
begin
	-- e7 was marked first.
	c := pg_temp.expect_claim(pg_temp.claim(), '85200000-0000-4000-8000-0000000000e7', 1, 1);
	if c -> 'settings' is distinct from jsonb_build_object('id', '85200000-0000-4000-8000-0000000000e7', 'service', 'gmail',
			'account', 'sales@nordlys.test', 'status', 'connected', 'actions', '[]'::jsonb,
			'connectedBy', '70400000-0000-4000-8000-000000000001',
			'connectedAt', public.qorpera_company_state_instant_text((select created_at from public.qorpera_cloud_secrets
				where id = '85200000-0000-4000-8000-0000000000e7')))
		or c ->> 'present' <> 'true' or c ->> 'path' <> 'connections/gmail-b.md' or c -> 'current' <> 'null'::jsonb then
		raise exception 'A new Gmail connection''s file: %', c; end if;
	w := pg_temp.work('85200000-0000-4000-8000-0000000000e7');
	if not w.dirty or w.lease_owner <> '85200000-0000-4000-8000-00000000000a' or w.lease_until <= clock_timestamp()
		or w.attempts <> 1 or pg_temp.marks('85200000-0000-4000-8000-0000000000e7') <> 0 then
		raise exception 'The claim consumed its marks and holds the lease: %', to_jsonb(w); end if;
	-- Another writer gets the next one: e1, with its new account name and the one operation still granted.
	c := pg_temp.expect_claim(pg_temp.claim('85200000-0000-4000-8000-00000000000b'), '70400000-0000-4000-8000-0000000000e1', 1, 4);
	select * into e1 from public.qorpera_cloud_secrets where id = '70400000-0000-4000-8000-0000000000e1';
	if c -> 'settings' is distinct from jsonb_build_object('id', e1.id, 'service', 'gmail', 'account', 'team@nordlys.test',
			'status', 'connected', 'actions', (select jsonb_agg(operation_id order by operation_id collate "C")
				from public.qorpera_cloud_connector_operations where connector_id = 'gmail' and status = 'active'
					and operation_id <> (pg_temp.operation('gmail', 1)).operation_id),
			'connectedBy', '70400000-0000-4000-8000-000000000001', 'connectedAt', public.qorpera_company_state_instant_text(e1.created_at))
		or c ->> 'path' <> 'connections/gmail.md' then
		raise exception 'The primary Gmail connection''s file: %', c; end if;
	perform set_config('qorpera_test.claim_e1', c::text, true);
	-- The website account, by the vault's account row.
	c := pg_temp.expect_claim(pg_temp.claim(), '85200000-0000-4000-8000-0000000000eb', 1, 3);
	select * into account from public.qorpera_company_accounts where secret_id = '85200000-0000-4000-8000-0000000000eb';
	if c -> 'settings' is distinct from jsonb_build_object('id', '85200000-0000-4000-8000-0000000000eb', 'service', 'website',
			'account', 'ops+portal@nordlys.test', 'status', 'pending', 'actions', '[]'::jsonb,
			'connectedBy', '70400000-0000-4000-8000-000000000001', 'connectedAt', public.qorpera_company_state_instant_text(account.created_at),
			'site', 'portal.example.com', 'twoStep', 'authenticator', 'openedFor', null)
		or c ->> 'path' <> 'connections/portal-example-com.md' then
		raise exception 'A website account''s file: %', c; end if;
	perform set_config('qorpera_test.claim_eb', c::text, true);
	-- The disconnected GitHub connection has no file, and none to delete.
	c := pg_temp.expect_claim(pg_temp.claim(), '70400000-0000-4000-8000-0000000000e2', 1, null);
	if c ->> 'present' <> 'false' or c -> 'settings' <> 'null'::jsonb or c -> 'path' <> 'null'::jsonb or c -> 'current' <> 'null'::jsonb then
		raise exception 'A revoked connection has no file: %', c; end if;
	perform set_config('qorpera_test.claim_e2', c::text, true);
	-- Everything due is leased now.
	if pg_temp.claim() is not null then raise exception 'Nothing else is due'; end if;
	perform set_config('qorpera_test.claim_e7', (select answer::text from claims_seen
		where answer ->> 'secretId' = '85200000-0000-4000-8000-0000000000e7'), true);
end $$;

-- 4. The writer commits each file as the platform and finishes ------------------------------------------------------------

do $$
declare c jsonb;
begin
	c := current_setting('qorpera_test.claim_e7')::jsonb;
	perform pg_temp.expect(pg_temp.write_claim(c), 1, 'saved');
	if not pg_temp.finish(c) or (pg_temp.work('85200000-0000-4000-8000-0000000000e7')).dirty
		or (pg_temp.work('85200000-0000-4000-8000-0000000000e7')).lease_owner is not null then
		raise exception 'A finished claim is clean and free: %', to_jsonb(pg_temp.work('85200000-0000-4000-8000-0000000000e7')); end if;
	c := current_setting('qorpera_test.claim_e1')::jsonb;
	perform pg_temp.expect(pg_temp.write_claim(c), 1, 'saved');
	if pg_temp.finish(c) then raise exception 'Only the writer holding the lease finishes it'; end if;
	if pg_temp.finish(c || '{"generation":2}', null, '85200000-0000-4000-8000-00000000000b') then
		raise exception 'Only the claim''s own generation finishes it'; end if;
	if not pg_temp.finish(c, null, '85200000-0000-4000-8000-00000000000b') then raise exception 'Its writer finishes it'; end if;
	c := current_setting('qorpera_test.claim_eb')::jsonb;
	perform pg_temp.expect(pg_temp.write_claim(c), 1, 'saved');
	if not pg_temp.finish(c) then raise exception 'The website account''s file is written'; end if;
	if not pg_temp.finish(current_setting('qorpera_test.claim_e2')::jsonb) then raise exception 'Nothing to delete is done too'; end if;
	if exists (select 1 from public.qorpera_folder_connection_file_work where dirty or lease_owner is not null)
		or pg_temp.claim() is not null then
		raise exception 'All files match the vault'; end if;
	if (pg_temp.idx('70400000-0000-4000-8000-0000000000e1')).folder_path is distinct from 'connections/gmail.md'
		or (pg_temp.idx('85200000-0000-4000-8000-0000000000eb')).folder_path is distinct from 'connections/portal-example-com.md' then
		raise exception 'The files are indexed for their accounts'; end if;
end $$;

-- 5. A file that exists: the claim names its version, a member's text is kept, a stale version backs off -----------------

do $$
declare c jsonb; r jsonb; w public.qorpera_folder_connection_file_work; v_before uuid;
begin
	-- A member writes the text below the settings.
	c := current_setting('qorpera_test.claim_e1')::jsonb;
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(), 'member-0001', jsonb_build_array(pg_temp.write('connections/gmail.md',
		'connection', 'The team inbox.', pg_temp.file_parse(c, 'The team inbox.'), pg_temp.version('connections/gmail.md')))), 1, 'saved');
	-- A new grant: the claim names the file and its current version.
	perform pg_temp.grant_op('85200000-0000-4000-8000-0000000000f4', '70400000-0000-4000-8000-0000000000e1', 'gmail', 1);
	c := pg_temp.expect_claim(pg_temp.claim(), '70400000-0000-4000-8000-0000000000e1', 2, 1);
	if c -> 'current' ->> 'path' <> 'connections/gmail.md'
		or (c -> 'current' ->> 'version')::uuid is distinct from pg_temp.version('connections/gmail.md')
		or c -> 'current' ->> 'fileSha256' is distinct from encode(extensions.digest(convert_to('The team inbox.', 'utf8'), 'sha256'), 'hex')
		or c -> 'settings' -> 'actions' <> (select jsonb_agg(operation_id order by operation_id collate "C")
			from public.qorpera_cloud_connector_operations where connector_id = 'gmail' and status = 'active') then
		raise exception 'The claim names the current file: %', c; end if;
	-- Meanwhile the member edits the text again: the writer's version is stale, so it backs off with the reason.
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(), 'member-0002', jsonb_build_array(pg_temp.write('connections/gmail.md',
		'connection', 'The team''s inbox.', pg_temp.file_parse(current_setting('qorpera_test.claim_e1')::jsonb, 'The team''s inbox.'),
		pg_temp.version('connections/gmail.md')))), 1, 'saved');
	r := pg_temp.write_claim(c, 'The team inbox.');
	perform pg_temp.expect(r, 1, 'conflict', 'version_changed');
	begin
		perform pg_temp.finish(c, 'Version changed!');
		raise exception 'A problem is a code' using errcode = 'QTF01';
	exception when invalid_parameter_value then null;
	end;
	if not pg_temp.finish(c, 'version_changed') then raise exception 'A writer reports its problem'; end if;
	w := pg_temp.work('70400000-0000-4000-8000-0000000000e1');
	if not w.dirty or w.lease_owner is not null or w.last_problem <> 'version_changed' or w.not_before <= clock_timestamp()
		or w.attempts <> 1 then
		raise exception 'A problem backs the claim off: %', to_jsonb(w); end if;
	if pg_temp.claim() is not null then raise exception 'A backed-off claim waits'; end if;
	-- After the back-off the writer reads the file again and keeps the member's text.
	update public.qorpera_folder_connection_file_work set not_before = clock_timestamp() - interval '1 second'
	where secret_id = '70400000-0000-4000-8000-0000000000e1';
	c := pg_temp.expect_claim(pg_temp.claim(), '70400000-0000-4000-8000-0000000000e1', 3, 0);
	if (c -> 'current' ->> 'version')::uuid is distinct from pg_temp.version('connections/gmail.md') or (c ->> 'attempt')::integer <> 2 then
		raise exception 'The retry sees the member''s version: %', c; end if;
	perform pg_temp.expect(pg_temp.write_claim(c, 'The team''s inbox.'), 1, 'saved');
	if not pg_temp.finish(c) or (pg_temp.work('70400000-0000-4000-8000-0000000000e1')).dirty then
		raise exception 'The retry finishes'; end if;
	if (pg_temp.idx('70400000-0000-4000-8000-0000000000e1')).purpose <> 'The team''s inbox.' then
		raise exception 'The member''s text is kept'; end if;
end $$;

-- 6. A lease another writer took, and a change during a lease -------------------------------------------------------------

do $$
declare a jsonb; b jsonb;
begin
	update public.qorpera_cloud_secrets set account_label = 'sales-team@nordlys.test' where id = '85200000-0000-4000-8000-0000000000e7';
	a := pg_temp.expect_claim(pg_temp.claim(), '85200000-0000-4000-8000-0000000000e7', 2, 1);
	-- Writer A is slow: its lease runs out, and writer B claims the next generation.
	update public.qorpera_folder_connection_file_work set lease_until = clock_timestamp() - interval '1 second'
	where secret_id = '85200000-0000-4000-8000-0000000000e7';
	b := pg_temp.expect_claim(pg_temp.claim('85200000-0000-4000-8000-00000000000b'), '85200000-0000-4000-8000-0000000000e7', 3, 0);
	if (b -> 'current' ->> 'version')::uuid is distinct from pg_temp.version('connections/gmail-b.md')
		or b -> 'current' <> a -> 'current' then
		raise exception 'B sees the file A saw: %', b; end if;
	-- A commits first; B's version is then stale and it backs off; A's late finish is refused.
	perform pg_temp.expect(pg_temp.write_claim(a), 1, 'saved');
	perform pg_temp.expect(pg_temp.write_claim(b), 1, 'conflict', 'version_changed');
	if pg_temp.finish(a) then raise exception 'A writer whose lease another took is told so'; end if;
	if not pg_temp.finish(b, 'version_changed', '85200000-0000-4000-8000-00000000000b') then raise exception 'B backs off'; end if;
	update public.qorpera_folder_connection_file_work set not_before = clock_timestamp() - interval '1 second'
	where secret_id = '85200000-0000-4000-8000-0000000000e7';
	b := pg_temp.expect_claim(pg_temp.claim('85200000-0000-4000-8000-00000000000b'), '85200000-0000-4000-8000-0000000000e7', 4, 0);
	if b -> 'settings' ->> 'account' <> 'sales-team@nordlys.test'
		or (b -> 'current' ->> 'version')::uuid is distinct from pg_temp.version('connections/gmail-b.md') then
		raise exception 'The next claim is the current state: %', b; end if;
	-- A change while B holds the lease: B's finish leaves the secret due for the next claim.
	update public.qorpera_cloud_secrets set account_label = 'sales@nordlys.test' where id = '85200000-0000-4000-8000-0000000000e7';
	perform pg_temp.expect(pg_temp.write_claim(b), 1, 'saved');
	if not pg_temp.finish(b, null, '85200000-0000-4000-8000-00000000000b') then raise exception 'B finishes'; end if;
	if (pg_temp.work('85200000-0000-4000-8000-0000000000e7')).dirty is distinct from false then
		raise exception 'The work row stays for the new mark'; end if;
	b := pg_temp.expect_claim(pg_temp.claim(), '85200000-0000-4000-8000-0000000000e7', 5, 1);
	if b -> 'settings' ->> 'account' <> 'sales@nordlys.test' then raise exception 'The new mark''s state: %', b; end if;
	perform pg_temp.expect(pg_temp.write_claim(b), 1, 'saved');
	if not pg_temp.finish(b) then raise exception 'Finished'; end if;
end $$;

-- 7. A Disconnect and a closed account remove their files -----------------------------------------------------------------

do $$
declare c jsonb; v_secret uuid;
begin
	update public.qorpera_cloud_secrets set status = 'revoked', revoked_at = clock_timestamp(),
		revoked_by_user_id = '70400000-0000-4000-8000-000000000001' where id = '70400000-0000-4000-8000-0000000000e1';
	-- A1 closes an account and revokes its vault row at once.
	update public.qorpera_company_accounts set status = 'closed', closed_at = clock_timestamp()
	where secret_id = '85200000-0000-4000-8000-0000000000eb';
	update public.qorpera_cloud_secrets set status = 'revoked', revoked_at = clock_timestamp(),
		revoked_by_user_id = '70400000-0000-4000-8000-000000000001' where id = '85200000-0000-4000-8000-0000000000eb';
	foreach v_secret in array array['70400000-0000-4000-8000-0000000000e1', '85200000-0000-4000-8000-0000000000eb']::uuid[] loop
		c := pg_temp.claim();
		if (c ->> 'secretId')::uuid is distinct from v_secret or c ->> 'present' <> 'false' or c -> 'current' = 'null'::jsonb then
			raise exception 'A revoked connection''s file is deleted: %', c; end if;
		perform pg_temp.expect(pg_temp.delete_claim(c), 1, 'saved');
		if not pg_temp.finish(c) then raise exception 'The delete finishes'; end if;
	end loop;
	if pg_temp.version('connections/gmail.md') is not null or pg_temp.version('connections/portal-example-com.md') is not null
		or (pg_temp.idx('70400000-0000-4000-8000-0000000000e1')).retired_at is null then
		raise exception 'No file says a connection that is gone'; end if;
	if pg_temp.claim() is not null then raise exception 'Nothing else is due'; end if;
end $$;

-- 7b. A new file's name follows the folder's name rule, whatever the site or the vault calls the connection -------------

do $$
declare v_site text := repeat('a', 60) || '.' || repeat('b', 60) || '.example.com'; v_state jsonb;
begin
	insert into public.qorpera_cloud_secrets(id,profile_id,environment_id,broker_authority_id,owner_kind,connector_id,secret_name,purpose,
		status,current_version,created_by_user_id,account_label) values
		('85200000-0000-4000-8000-0000000000ec','70400000-0000-4000-8000-000000000010','70400000-0000-4000-8000-000000000020','70400000-0000-4000-8000-0000000000d1','company','website','long','Long','active',1,'70400000-0000-4000-8000-000000000001','ops@nordlys.test'),
		('85200000-0000-4000-8000-0000000000ed','70400000-0000-4000-8000-000000000010','70400000-0000-4000-8000-000000000020','70400000-0000-4000-8000-0000000000d1','company','google_drive','team__files','Files','active',1,'70400000-0000-4000-8000-000000000001','files@nordlys.test');
	insert into public.qorpera_company_accounts(secret_id, profile_id, environment_id, site, login, status, opened_by_user_id)
	values ('85200000-0000-4000-8000-0000000000ec','70400000-0000-4000-8000-000000000010','70400000-0000-4000-8000-000000000020',
		v_site, 'ops+long@nordlys.test', 'pending', '70400000-0000-4000-8000-000000000001');
	v_state := public.qorpera_folder_connection_file_state('85200000-0000-4000-8000-0000000000ec');
	if v_state ->> 'path' <> 'connections/' || repeat('a', 60) || '-bbb.md' then
		raise exception 'A long site is cut to 64 characters, never ending in a hyphen: %', v_state ->> 'path'; end if;
	v_state := public.qorpera_folder_connection_file_state('85200000-0000-4000-8000-0000000000ed');
	if v_state ->> 'path' <> 'connections/google-drive-team-files.md' then
		raise exception 'Underscores become single hyphens: %', v_state ->> 'path'; end if;
end $$;

-- 7c. Review round 1: instants, which connections have files, website states, expiries, back-off and marking all -------

do $$
declare v_state jsonb; w public.qorpera_folder_connection_file_work; c jsonb; v_op0 text; v_op1 text; v_count integer;
begin
	-- The parser's one instant form, by value.
	if public.qorpera_company_state_instant_text('2026-10-03 08:00:00.5+00') <> '2026-10-03T08:00:00.5Z'
		or public.qorpera_company_state_instant_text('2026-10-03 10:00:00+02') <> '2026-10-03T08:00:00Z'
		or public.qorpera_company_state_instant_text('2026-10-03 08:00:00.000001+00') <> '2026-10-03T08:00:00.000001Z' then
		raise exception 'Instants are written in the parser''s form'; end if;
	-- A hook's signing secret and a secret card are not connections with a file: no mark, no file.
	insert into public.qorpera_cloud_secrets(id,profile_id,environment_id,broker_authority_id,owner_kind,connector_id,secret_name,purpose,
		status,current_version,created_by_user_id) values
		('85200000-0000-4000-8000-0000000000f8','70400000-0000-4000-8000-000000000010','70400000-0000-4000-8000-000000000020','70400000-0000-4000-8000-0000000000d1','company','event_hook','hook-orders','Hook','active',1,'70400000-0000-4000-8000-000000000001'),
		('85200000-0000-4000-8000-0000000000f9','70400000-0000-4000-8000-000000000010','70400000-0000-4000-8000-000000000020','70400000-0000-4000-8000-0000000000d1','company','vault','card','Card','active',1,'70400000-0000-4000-8000-000000000001');
	if pg_temp.marks('85200000-0000-4000-8000-0000000000f8') + pg_temp.marks('85200000-0000-4000-8000-0000000000f9') <> 0
		or public.qorpera_folder_connection_file_state('85200000-0000-4000-8000-0000000000f8') ->> 'present' <> 'false'
		or public.qorpera_folder_connection_file_state('85200000-0000-4000-8000-0000000000f9') ->> 'present' <> 'false' then
		raise exception 'Only catalog connectors and website accounts have files'; end if;
	-- An agent's connected website account: the agent connected it, when the account says, for its todo.
	insert into public.qorpera_cloud_secrets(id,profile_id,environment_id,broker_authority_id,owner_kind,connector_id,secret_name,purpose,
		status,current_version,created_by_user_id) values
		('85200000-0000-4000-8000-0000000000ef','70400000-0000-4000-8000-000000000010','70400000-0000-4000-8000-000000000020','70400000-0000-4000-8000-0000000000d1','company','website','agent-portal','Portal','active',1,'70400000-0000-4000-8000-000000000001'),
		('85200000-0000-4000-8000-0000000000fa','70400000-0000-4000-8000-000000000010','70400000-0000-4000-8000-000000000020','70400000-0000-4000-8000-0000000000d1','company','website','closed-portal','Portal','active',1,'70400000-0000-4000-8000-000000000001');
	insert into public.qorpera_company_accounts(secret_id, profile_id, environment_id, site, login, status, opened_by_user_id,
		created_at, connected_at, closed_at) values
		('85200000-0000-4000-8000-0000000000ef','70400000-0000-4000-8000-000000000010','70400000-0000-4000-8000-000000000020',
			'agent.example.com', 'agents+agent.example.com@nordlys.test', 'connected', '70400000-0000-4000-8000-000000000001',
			'2026-10-02T09:00:00Z', '2026-10-02T09:30:00.25Z', null),
		('85200000-0000-4000-8000-0000000000fa','70400000-0000-4000-8000-000000000010','70400000-0000-4000-8000-000000000020',
			'closed.example.com', 'ops+closed@nordlys.test', 'closed', '70400000-0000-4000-8000-000000000001',
			'2026-10-02T09:00:00Z', null, '2026-10-02T10:00:00Z');
	-- The agent who opened it, for its todo (set after the insert: the tagged-login rule of an agent's insert is A1-4b's,
	-- and 813 tests it).
	update public.qorpera_company_accounts set opened_for_todo_id = '85200000-0000-4000-8000-0000000000d7',
		opened_by_staff_agent_id = '70400000-0000-4000-8000-0000000000c0', opened_receipt_id = '85200000-0000-4000-8000-0000000000d8'
	where secret_id = '85200000-0000-4000-8000-0000000000ef';
	v_state := public.qorpera_folder_connection_file_state('85200000-0000-4000-8000-0000000000ef');
	if v_state -> 'settings' ->> 'connectedBy' <> '70400000-0000-4000-8000-0000000000c0'
		or v_state -> 'settings' ->> 'connectedAt' <> '2026-10-02T09:30:00.25Z'
		or v_state -> 'settings' ->> 'openedFor' <> '85200000-0000-4000-8000-0000000000d7'
		or v_state -> 'settings' ->> 'status' <> 'connected' or v_state ->> 'path' <> 'connections/agent-example-com.md' then
		raise exception 'An agent''s connected account: %', v_state; end if;
	-- A closed account on a secret not yet revoked has no file.
	if public.qorpera_folder_connection_file_state('85200000-0000-4000-8000-0000000000fa') ->> 'present' <> 'false' then
		raise exception 'A closed account has no file'; end if;
	-- An expired grant is not among the actions.
	v_op0 := (pg_temp.operation('google_drive', 0)).operation_id; v_op1 := (pg_temp.operation('google_drive', 1)).operation_id;
	insert into public.qorpera_cloud_secret_operation_grants(id, profile_id, environment_id, secret_id, staff_agent_id, connector_id,
		operation_id, operation_version, tool_name, issued_by_user_id, expires_at)
	select g.id, '70400000-0000-4000-8000-000000000010', '70400000-0000-4000-8000-000000000020', '85200000-0000-4000-8000-0000000000ed',
		'70400000-0000-4000-8000-0000000000c0', op.connector_id, op.operation_id, op.version, op.tool_name,
		'70400000-0000-4000-8000-000000000001', g.expires_at
	from (values ('85200000-0000-4000-8000-0000000000fb'::uuid, 0, statement_timestamp() + interval '1 millisecond'),
			('85200000-0000-4000-8000-0000000000fc'::uuid, 1, null::timestamptz)) as g(id, position, expires_at)
	cross join lateral pg_temp.operation('google_drive', g.position) as op;
	perform pg_sleep(0.01);
	if public.qorpera_folder_connection_file_state('85200000-0000-4000-8000-0000000000ed') -> 'settings' -> 'actions'
		<> jsonb_build_array(v_op1) then
		raise exception 'Only unexpired grants are actions: %', public.qorpera_folder_connection_file_state('85200000-0000-4000-8000-0000000000ed'); end if;
	-- Back-off: 2^attempts seconds after a problem, at most ten minutes.
	update public.qorpera_folder_connection_file_marks set created_at = '2000-01-01' where secret_id = '85200000-0000-4000-8000-0000000000ef';
	c := pg_temp.claim();
	if c ->> 'secretId' <> '85200000-0000-4000-8000-0000000000ef' then raise exception 'The oldest mark is claimed first: %', c; end if;
	perform pg_temp.finish(c, 'unavailable');
	w := pg_temp.work('85200000-0000-4000-8000-0000000000ef');
	if w.not_before - w.updated_at not between interval '1.9 seconds' and interval '2.1 seconds' then
		raise exception 'A first problem backs off two seconds: %', w.not_before - w.updated_at; end if;
	-- Due again first (older than every mark of this block), with many attempts behind it.
	update public.qorpera_folder_connection_file_work set not_before = clock_timestamp() - interval '1 second',
		updated_at = '2000-01-01' where secret_id = '85200000-0000-4000-8000-0000000000ef';
	c := pg_temp.claim();
	if c ->> 'secretId' <> '85200000-0000-4000-8000-0000000000ef' then raise exception 'The retry is claimed: %', c; end if;
	update public.qorpera_folder_connection_file_work set attempts = 20 where secret_id = '85200000-0000-4000-8000-0000000000ef';
	perform pg_temp.finish(c, 'unavailable');
	w := pg_temp.work('85200000-0000-4000-8000-0000000000ef');
	if w.not_before - w.updated_at not between interval '599.9 seconds' and interval '600.1 seconds' then
		raise exception 'A back-off is at most ten minutes: %', w.not_before - w.updated_at; end if;
	-- Marking every connection of an environment due at once: the active company connections that have files.
	select count(*) into v_count from public.qorpera_cloud_secrets as secret
	where secret.environment_id = '70400000-0000-4000-8000-000000000020' and secret.owner_kind = 'company' and secret.status = 'active'
		and (secret.connector_id = 'website' or secret.connector_id in ('gmail','github','google_drive'));
	if public.qorpera_mark_connection_files('70400000-0000-4000-8000-000000000020') <> v_count or v_count < 4
		or pg_temp.marks('85200000-0000-4000-8000-0000000000f8') <> 0 then
		raise exception 'Every connection with a file is marked once'; end if;
	begin
		perform public.qorpera_mark_connection_files('70400000-0000-4000-8000-000000000022');
		raise exception 'Only a folder-v2 environment' using errcode = 'QTF01';
	exception when insufficient_privilege then null;
	end;
end $$;

-- 8. Nothing but the allow-list ever leaves the vault, and the company's purge removes marks and work ---------------------

do $$
declare v_all text := (select string_agg(answer::text, ' ') from claims_seen where answer is not null);
	v_word text;
begin
	if (select count(*) from claims_seen where answer is not null) < 12 then raise exception 'The claims were recorded'; end if;
	foreach v_word in array array['sentinel', repeat('9', 64), 'deadbeef', '\xdeadbeef', repeat('1', 64), 'key-1', 'Gmail account',
		'GitHub account', 'Changed purpose', 'broker.example.test', '70400000-0000-4000-8000-0000000000d1'] loop
		if strpos(v_all, v_word) > 0 then raise exception 'A claim carried %', v_word; end if;
	end loop;
	if exists (select 1 from claims_seen, jsonb_object_keys(coalesce(nullif(answer -> 'settings', 'null'::jsonb), '{}'::jsonb)) k
		where k not in ('id','service','account','status','actions','connectedBy','connectedAt','site','twoStep','openedFor')) then
		raise exception 'The settings are the allow-list only'; end if;
	if (select count(*) from pg_constraint where confrelid = 'public.qorpera_profiles'::regclass and confdeltype = 'c'
		and conrelid in ('public.qorpera_folder_connection_file_marks'::regclass, 'public.qorpera_folder_connection_file_work'::regclass)) <> 2
		or (select count(*) from pg_constraint where contype = 'f'
			and conrelid in ('public.qorpera_folder_connection_file_marks'::regclass, 'public.qorpera_folder_connection_file_work'::regclass)) <> 2 then
		raise exception 'Marks and work reference only the company row, and go with it'; end if;
end $$;

rollback;
