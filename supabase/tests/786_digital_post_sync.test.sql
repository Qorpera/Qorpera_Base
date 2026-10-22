-- Digital Post in the company folder, part 2 (migration 20260930529000): the vault's Digital Post sync follows the
-- company's Digital Post secret, is claimed by the company's own authority, keeps a letter once by its message id,
-- stages its files in chunks and seals it only when each file is whole, holds a letter it could not read, records
-- the pass and its receipts, backs off after a failure, stops when Digital Post refuses the key, starts again on a
-- new key, refuses a late answer from an earlier claim, and stops on a Disconnect. The shared vault asks which of its
-- companies are due. A member reads the connection's state; nothing else reaches the tables.
begin;

insert into auth.users(id, email) values
	('78600000-0000-4000-8000-000000000001', 'post-owner@example.test'),
	('78600000-0000-4000-8000-000000000002', 'stranger@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id) values
	('78600000-0000-4000-8000-000000000010', 'Nordlys Post', '78600000-0000-4000-8000-000000000001'),
	('78600000-0000-4000-8000-000000000011', 'Shared Vault Post', '78600000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('78600000-0000-4000-8000-000000000010', '78600000-0000-4000-8000-000000000001', 'post-owner@example.test', 'Owner', 'owner'),
	('78600000-0000-4000-8000-000000000011', '78600000-0000-4000-8000-000000000001', 'post-owner@example.test', 'Owner', 'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id) values
	('78600000-0000-4000-8000-000000000020', '78600000-0000-4000-8000-000000000010', 'Environment', 1, '78600000-0000-4000-8000-000000000001'),
	('78600000-0000-4000-8000-000000000021', '78600000-0000-4000-8000-000000000011', 'Environment', 1, '78600000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_broker_principals(id, service_origin, key_id, capability_sha256, registers_companies_created_after)
values ('78600000-0000-4000-8000-000000000050', 'https://vault.qorpera.test', 'vault-root-1', repeat('a', 64), '2099-01-01 00:00:00+00');
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256, principal_id) values
	('78600000-0000-4000-8000-0000000000d1', '78600000-0000-4000-8000-000000000010', 'https://broker.example.test', 'key-1', repeat('1', 64), null),
	('78600000-0000-4000-8000-0000000000d2', '78600000-0000-4000-8000-000000000011', 'https://vault.qorpera.test', 'vault-root-1', repeat('2', 64),
		'78600000-0000-4000-8000-000000000050');

create function pg_temp.refused(p_sql text, p_state text) returns void language plpgsql as $$
begin
	begin execute p_sql; exception when others then
		if sqlstate = p_state then return; end if;
		raise exception 'Expected %, got %: %', p_state, sqlstate, sqlerrm;
	end;
	raise exception 'Not refused: %', p_sql;
end
$$;
create function pg_temp.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
	if p_ok is not true then raise exception 'Failed: %', p_what; end if;
end
$$;
-- A sealed version as the capture leaves it.
create function pg_temp.seal_secret(p_secret uuid, p_version bigint, p_authority uuid) returns void language plpgsql as $$
declare v_envelope bytea := extensions.gen_random_bytes(64) || convert_to(p_secret::text || p_version, 'UTF8');
begin
	insert into public.qorpera_cloud_secret_versions(secret_id, version, broker_authority_id, key_id, encrypted_envelope,
		envelope_sha256, created_by_user_id)
	values (p_secret, p_version, p_authority, (select key_id from public.qorpera_cloud_secret_broker_authorities where id = p_authority),
		v_envelope, encode(extensions.digest(v_envelope, 'sha256'), 'hex'), '78600000-0000-4000-8000-000000000001');
end
$$;
create function pg_temp.connect(p_secret uuid, p_profile uuid, p_environment uuid, p_authority uuid,
	p_owner_kind text default 'company', p_connector text default 'digital_post') returns void language plpgsql as $$
begin
	insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind, owner_user_id,
		connector_id, secret_name, purpose, current_version, created_by_user_id, account_label)
	values (p_secret, p_profile, p_environment, p_authority, p_owner_kind,
		case when p_owner_kind = 'member' then '78600000-0000-4000-8000-000000000001'::uuid end,
		p_connector, 'primary', 'Digital Post', 1, '78600000-0000-4000-8000-000000000001',
		'e545b339-8542-4a30-ae75-c67e4d2a7b99');
	perform pg_temp.seal_secret(p_secret, 1, p_authority);
end
$$;
-- The broker's calls, under its own database login. The lease is the current claim's unless a test names another.
create function pg_temp.lease(p_secret uuid) returns uuid language sql as $$
	select lease_id from public.qorpera_digital_post_syncs where secret_id = p_secret
$$;
create function pg_temp.claim(p_authority uuid, p_capability text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	set local session authorization qorpera_secret_broker;
	v := public.qorpera_claim_digital_post_sync(p_authority, p_capability);
	reset session authorization;
	return v;
end
$$;
create function pg_temp.keep(p_secret uuid, p_memo uuid, p_summary jsonb, p_files jsonb, p_lease uuid default null)
returns jsonb language plpgsql as $$
declare v jsonb; v_lease uuid := coalesce(p_lease, pg_temp.lease(p_secret));
begin
	set local session authorization qorpera_secret_broker;
	v := public.qorpera_keep_digital_post_letter('78600000-0000-4000-8000-0000000000d1', repeat('1', 64), p_secret, 1,
		v_lease, p_memo, p_summary, p_files);
	reset session authorization;
	return v;
end
$$;
create function pg_temp.stage(p_secret uuid, p_letter uuid, p_file integer, p_chunk integer, p_content bytea,
	p_lease uuid default null) returns jsonb language plpgsql as $$
declare v jsonb; v_lease uuid := coalesce(p_lease, pg_temp.lease(p_secret));
begin
	set local session authorization qorpera_secret_broker;
	v := public.qorpera_stage_digital_post_chunk('78600000-0000-4000-8000-0000000000d1', repeat('1', 64), p_secret, 1,
		v_lease, p_letter, p_file, p_chunk, p_content);
	reset session authorization;
	return v;
end
$$;
create function pg_temp.seal(p_secret uuid, p_letter uuid) returns jsonb language plpgsql as $$
declare v jsonb; v_lease uuid := pg_temp.lease(p_secret);
begin
	set local session authorization qorpera_secret_broker;
	v := public.qorpera_seal_digital_post_letter('78600000-0000-4000-8000-0000000000d1', repeat('1', 64), p_secret, 1,
		v_lease, p_letter);
	reset session authorization;
	return v;
end
$$;
create function pg_temp.hold(p_secret uuid, p_memo uuid, p_reason text) returns jsonb language plpgsql as $$
declare v jsonb; v_lease uuid := pg_temp.lease(p_secret);
begin
	set local session authorization qorpera_secret_broker;
	v := public.qorpera_hold_digital_post_letter('78600000-0000-4000-8000-0000000000d1', repeat('1', 64), p_secret, 1,
		v_lease, p_memo, p_reason);
	reset session authorization;
	return v;
end
$$;
create function pg_temp.finish(p_secret uuid, p_outcome text, p_receipted jsonb default '[]', p_error text default null,
	p_lease uuid default null, p_version bigint default 1) returns jsonb language plpgsql as $$
declare v jsonb; v_lease uuid := coalesce(p_lease, pg_temp.lease(p_secret));
begin
	set local session authorization qorpera_secret_broker;
	v := public.qorpera_finish_digital_post_sync('78600000-0000-4000-8000-0000000000d1', repeat('1', 64), p_secret,
		p_version, v_lease, p_outcome, 'e545b339-8542-4a30-ae75-c67e4d2a7b99', p_receipted, p_error);
	reset session authorization;
	return v;
end
$$;
create function pg_temp.due(p_principal uuid, p_capability text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	set local session authorization qorpera_secret_broker;
	v := public.qorpera_broker_principal_digital_post_syncs_due(p_principal, p_capability);
	reset session authorization;
	return v;
end
$$;
grant execute on function pg_temp.claim(uuid, text), pg_temp.keep(uuid, uuid, jsonb, jsonb, uuid),
	pg_temp.stage(uuid, uuid, integer, integer, bytea, uuid), pg_temp.seal(uuid, uuid), pg_temp.hold(uuid, uuid, text),
	pg_temp.finish(uuid, text, jsonb, text, uuid, bigint), pg_temp.due(uuid, text), pg_temp.lease(uuid)
	to qorpera_secret_broker;
-- A member's read, signed in, then as the service again; an error answers its SQLSTATE.
create function pg_temp.member(p_user uuid, p_environment uuid) returns jsonb language plpgsql as $$
declare r jsonb;
begin
	perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user)::text, true);
	r := public.qorpera_member_digital_post(p_environment);
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	return r;
exception when others then
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	return jsonb_build_object('error', sqlstate);
end
$$;
create function pg_temp.sync() returns public.qorpera_digital_post_syncs language sql as $$
	select * from public.qorpera_digital_post_syncs where profile_id = '78600000-0000-4000-8000-000000000010'
$$;
create function pg_temp.past() returns void language sql as $$
	update public.qorpera_digital_post_syncs set due_at = clock_timestamp() - interval '1 second'
	where profile_id = '78600000-0000-4000-8000-000000000010'
$$;
-- A letter's summary and files as the vault lays them out (digital-post-letter-files.ts).
create function pg_temp.summary(p_message uuid, p_folder text default null) returns jsonb language sql as $$
	select jsonb_build_object('messageUuid', p_message,
		'folder', coalesce(p_folder, 'digital-post/2026/2026-10-22 Skattestyrelsen - Årsopgørelse 2025 (' || p_message || ')'),
		'title', 'Årsopgørelse 2025', 'sender', 'Skattestyrelsen', 'senderId', '19552101', 'created', '2026-10-21T23:30:00Z',
		'received', '2026-10-22T06:00:00.000Z', 'mandatory', false, 'legalNotification', true, 'replyBy', null,
		'caseId', 'SAG-778', 'files', 1, 'text', true, 'snippet', 'Kære Testfirma')
$$;
create function pg_temp.file(p_name text, p_media text, p_content bytea) returns jsonb language sql as $$
	select jsonb_build_object('name', p_name, 'mediaType', p_media, 'bytes', octet_length(p_content),
		'sha256', encode(sha256(p_content), 'hex'))
$$;
create function pg_temp.big() returns bytea language sql as $$
	select decode(repeat('ab', 1048576 + 10), 'hex')
$$;
create function pg_temp.files() returns jsonb language sql as $$
	select jsonb_build_array(pg_temp.file('letter.md', 'text/markdown', convert_to('# Brev', 'UTF8')),
		pg_temp.file('letter.json', 'application/json', convert_to('{}', 'UTF8')),
		pg_temp.file('brev.pdf', 'application/pdf', pg_temp.big()))
$$;

-- 1. Only the broker's own functions reach the tables, and only the broker may call them; a member reads the state.
do $$
declare v_role text; v_function text; v_table text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		foreach v_table in array array['public.qorpera_digital_post_syncs', 'public.qorpera_digital_post_letters',
			'public.qorpera_digital_post_chunks', 'public.qorpera_digital_post_held'] loop
			perform pg_temp.check(not has_table_privilege(v_role, v_table, 'select'), v_role || ' reads nothing of ' || v_table);
		end loop;
	end loop;
	foreach v_function in array array['public.qorpera_claim_digital_post_sync(uuid,text)',
		'public.qorpera_keep_digital_post_letter(uuid,text,uuid,bigint,uuid,uuid,jsonb,jsonb)',
		'public.qorpera_stage_digital_post_chunk(uuid,text,uuid,bigint,uuid,uuid,integer,integer,bytea)',
		'public.qorpera_seal_digital_post_letter(uuid,text,uuid,bigint,uuid,uuid)',
		'public.qorpera_hold_digital_post_letter(uuid,text,uuid,bigint,uuid,uuid,text)',
		'public.qorpera_finish_digital_post_sync(uuid,text,uuid,bigint,uuid,text,uuid,jsonb,text)',
		'public.qorpera_broker_principal_digital_post_syncs_due(uuid,text)'] loop
		foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
			perform pg_temp.check(not has_function_privilege(v_role, v_function, 'execute'), v_role || ' may not call ' || v_function);
		end loop;
		perform pg_temp.check(has_function_privilege('qorpera_secret_broker', v_function, 'execute'), 'the broker calls ' || v_function);
	end loop;
	foreach v_function in array array['public.qorpera_digital_post_authority(uuid,text)',
		'public.qorpera_digital_post_leased(uuid,uuid,bigint,uuid)', 'public.qorpera_digital_post_summary_valid(jsonb)'] loop
		foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
			perform pg_temp.check(not has_function_privilege(v_role, v_function, 'execute'), v_function || ' is internal');
		end loop;
	end loop;
	perform pg_temp.check(has_function_privilege('authenticated', 'public.qorpera_member_digital_post(uuid)', 'execute'),
		'members read the state');
	foreach v_role in array array['anon', 'service_role', 'qorpera_secret_broker'] loop
		perform pg_temp.check(not has_function_privilege(v_role, 'public.qorpera_member_digital_post(uuid)', 'execute'),
			v_role || ' reads no member state');
	end loop;
end $$;

-- 2. A company Digital Post secret makes the sync, due at once; a member's or another connector's does not. Before it,
-- the member reads "not connected".
do $$
begin
	perform pg_temp.check(pg_temp.member('78600000-0000-4000-8000-000000000001', '78600000-0000-4000-8000-000000000020')
		@> '{"connected": false, "status": "disconnected", "letters": 0}', 'not connected yet');
	perform pg_temp.connect('78600000-0000-4000-8000-0000000000e9', '78600000-0000-4000-8000-000000000010',
		'78600000-0000-4000-8000-000000000020', '78600000-0000-4000-8000-0000000000d1', 'member');
	perform pg_temp.connect('78600000-0000-4000-8000-0000000000e8', '78600000-0000-4000-8000-000000000010',
		'78600000-0000-4000-8000-000000000020', '78600000-0000-4000-8000-0000000000d1', 'company', 'gmail');
	perform pg_temp.check(pg_temp.sync() is null, 'no sync for a member secret or another connector');
	perform pg_temp.connect('78600000-0000-4000-8000-0000000000e1', '78600000-0000-4000-8000-000000000010',
		'78600000-0000-4000-8000-000000000020', '78600000-0000-4000-8000-0000000000d1');
	perform pg_temp.check((pg_temp.sync()).status = 'waiting' and (pg_temp.sync()).due_at <= clock_timestamp()
		and (pg_temp.sync()).environment_id = '78600000-0000-4000-8000-000000000020', 'a connect is due at once');
	perform pg_temp.check(pg_temp.member('78600000-0000-4000-8000-000000000001', '78600000-0000-4000-8000-000000000020')
		@> '{"connected": true, "status": "waiting", "systemId": null}', 'the member sees it waiting');
	perform pg_temp.check(pg_temp.member('78600000-0000-4000-8000-000000000002', '78600000-0000-4000-8000-000000000020')
		= '{"error": "42501"}', 'a stranger reads nothing');
end $$;

-- 3. The claim: only the broker, only the company's own authority, then leased; it carries the sealed key and no held
-- letters.
do $$
declare v jsonb;
begin
	perform pg_temp.refused($q$select public.qorpera_claim_digital_post_sync('78600000-0000-4000-8000-0000000000d1', repeat('1', 64))$q$,
		'42501');
	perform pg_temp.refused($q$select pg_temp.claim('78600000-0000-4000-8000-0000000000d1', repeat('9', 64))$q$, '42501');
	v := pg_temp.claim('78600000-0000-4000-8000-0000000000d1', repeat('1', 64));
	perform pg_temp.check(v->>'schema' = 'qorpera.digital-post-sync-claim/v1'
		and v->>'secretId' = '78600000-0000-4000-8000-0000000000e1' and (v->>'secretVersion')::int = 1
		and v->'held' = '[]'::jsonb and v->>'keyId' = 'key-1' and v->>'encryptedEnvelopeBase64' !~ E'\n'
		and v->>'lease' = pg_temp.lease('78600000-0000-4000-8000-0000000000e1')::text, 'the claim');
	perform pg_temp.check(pg_temp.claim('78600000-0000-4000-8000-0000000000d1', repeat('1', 64)) is null,
		'a leased sync is not claimed twice');
end $$;

-- 4. A letter is kept by its message id: the shape is checked; its files are staged in whole chunks and sealed only
-- when each one is whole; the same letter again is already kept.
do $$
declare
	v_memo uuid := '0a000000-0000-4000-8000-000000000001';
	v_message uuid := '6f1d3c2a-9b8e-4d7c-8a6b-5e4f3d2c1b0a';
	v jsonb;
	v_letter uuid;
	v_big bytea := pg_temp.big();
begin
	perform pg_temp.refused(format('select pg_temp.keep(%L, %L, %L, %L)', '78600000-0000-4000-8000-0000000000e1', v_memo,
		pg_temp.summary(v_message) - 'snippet', pg_temp.files()), '22023');
	perform pg_temp.refused(format('select pg_temp.keep(%L, %L, %L, %L)', '78600000-0000-4000-8000-0000000000e1', v_memo,
		pg_temp.summary(v_message, 'elsewhere/2026/x'), pg_temp.files()), '22023');
	perform pg_temp.refused(format('select pg_temp.keep(%L, %L, %L, %L)', '78600000-0000-4000-8000-0000000000e1', v_memo,
		pg_temp.summary(v_message, 'digital-post/2026/bad: name'), pg_temp.files()), '22023');
	perform pg_temp.refused(format('select pg_temp.keep(%L, %L, %L, %L)', '78600000-0000-4000-8000-0000000000e1', v_memo,
		pg_temp.summary(v_message), pg_temp.files() - 0), '22023');
	perform pg_temp.refused(format('select pg_temp.keep(%L, %L, %L, %L)', '78600000-0000-4000-8000-0000000000e1', v_memo,
		pg_temp.summary(v_message), pg_temp.files() || jsonb_build_array(pg_temp.file('BREV.PDF', 'application/pdf', '\x00'))),
		'22023');
	perform pg_temp.refused(format('select pg_temp.keep(%L, %L, %L, %L)', '78600000-0000-4000-8000-0000000000e1', v_memo,
		pg_temp.summary(v_message), pg_temp.files() || jsonb_build_array(pg_temp.file('a/b.pdf', 'application/pdf', '\x00'))),
		'22023');
	perform pg_temp.refused(format('select pg_temp.keep(%L, %L, %L, %L, %L)', '78600000-0000-4000-8000-0000000000e1', v_memo,
		pg_temp.summary(v_message), pg_temp.files(), '78600000-0000-4000-8000-0000000000ff'), '55000');
	v := pg_temp.keep('78600000-0000-4000-8000-0000000000e1', v_memo, pg_temp.summary(v_message),
		pg_temp.files() || jsonb_build_array(pg_temp.file('empty.txt', 'text/plain', ''::bytea)));
	v_letter := (v->>'letterId')::uuid;
	perform pg_temp.check(v->>'state' = 'staging', 'a new letter stages');
	perform pg_temp.stage('78600000-0000-4000-8000-0000000000e1', v_letter, 0, 0, convert_to('# Brev', 'UTF8'));
	perform pg_temp.stage('78600000-0000-4000-8000-0000000000e1', v_letter, 1, 0, convert_to('{}', 'UTF8'));
	-- The chunk must be a whole MiB but for the last, and within the file.
	perform pg_temp.refused(format('select pg_temp.stage(%L, %L, 2, 0, %L)', '78600000-0000-4000-8000-0000000000e1',
		v_letter, substring(v_big from 1 for 1000)), '22023');
	perform pg_temp.refused(format('select pg_temp.stage(%L, %L, 2, 2, %L)', '78600000-0000-4000-8000-0000000000e1',
		v_letter, '\x00'::bytea), '22023');
	perform pg_temp.refused(format('select pg_temp.stage(%L, %L, 9, 0, %L)', '78600000-0000-4000-8000-0000000000e1',
		v_letter, '\x00'::bytea), '22023');
	perform pg_temp.stage('78600000-0000-4000-8000-0000000000e1', v_letter, 2, 0, substring(v_big from 1 for 1048576));
	perform pg_temp.refused(format('select pg_temp.seal(%L, %L)', '78600000-0000-4000-8000-0000000000e1', v_letter), '22023');
	-- A wrong last chunk of the right size is staged, but the seal refuses it; staging it again replaces it.
	perform pg_temp.stage('78600000-0000-4000-8000-0000000000e1', v_letter, 2, 1, decode(repeat('cd', 10), 'hex'));
	perform pg_temp.refused(format('select pg_temp.seal(%L, %L)', '78600000-0000-4000-8000-0000000000e1', v_letter), '22023');
	perform pg_temp.stage('78600000-0000-4000-8000-0000000000e1', v_letter, 2, 1, substring(v_big from 1048577));
	perform pg_temp.check(pg_temp.seal('78600000-0000-4000-8000-0000000000e1', v_letter)->>'state' = 'kept', 'sealed whole');
	perform pg_temp.check((select status = 'kept' and kept_at is not null and bytes = octet_length(v_big) + 8
		from public.qorpera_digital_post_letters where id = v_letter), 'kept with its size');
	perform pg_temp.refused(format('select pg_temp.stage(%L, %L, 0, 0, %L)', '78600000-0000-4000-8000-0000000000e1',
		v_letter, convert_to('# Brev', 'UTF8')), '55000');
	-- Delivered again (another Digital Post id): kept once, only the receipt is owed.
	v := pg_temp.keep('78600000-0000-4000-8000-0000000000e1', '0a000000-0000-4000-8000-000000000002',
		pg_temp.summary(v_message), pg_temp.files());
	perform pg_temp.check(v->>'state' = 'kept' and (v->>'letterId')::uuid = v_letter, 'a duplicate is kept once');
	perform pg_temp.check((select memo_id from public.qorpera_digital_post_letters where id = v_letter)
		= '0a000000-0000-4000-8000-000000000002', 'the newest Digital Post id is kept');
	-- Another letter whose folder has the same key is refused.
	perform pg_temp.refused(format('select pg_temp.keep(%L, %L, %L, %L)', '78600000-0000-4000-8000-0000000000e1',
		'0a000000-0000-4000-8000-000000000003', pg_temp.summary('6f1d3c2a-0000-4000-8000-000000000009',
			'digital-post/2026/' || upper('2026-10-22 Skattestyrelsen - Årsopgørelse 2025 (' || v_message || ')')),
			pg_temp.files()),
		'23505');
end $$;

-- 5. A letter left staging starts again when kept again; a held letter is listed in the next claim.
do $$
declare v jsonb; v_letter uuid;
begin
	v := pg_temp.keep('78600000-0000-4000-8000-0000000000e1', '0a000000-0000-4000-8000-000000000004',
		pg_temp.summary('7a000000-0000-4000-8000-000000000004'), pg_temp.files());
	v_letter := (v->>'letterId')::uuid;
	perform pg_temp.stage('78600000-0000-4000-8000-0000000000e1', v_letter, 0, 0, convert_to('# Brev', 'UTF8'));
	v := pg_temp.keep('78600000-0000-4000-8000-0000000000e1', '0a000000-0000-4000-8000-000000000004',
		pg_temp.summary('7a000000-0000-4000-8000-000000000004'), pg_temp.files());
	perform pg_temp.check(v->>'state' = 'staging' and (v->>'letterId')::uuid = v_letter
		and not exists (select 1 from public.qorpera_digital_post_chunks where letter_id = v_letter), 'staging starts again');
	perform pg_temp.check(pg_temp.hold('78600000-0000-4000-8000-0000000000e1', '0a000000-0000-4000-8000-000000000005',
		'the letter''s XML is malformed')->>'held' = 'true', 'held');
	perform pg_temp.refused(format('select pg_temp.hold(%L, %L, %L)', '78600000-0000-4000-8000-0000000000e1',
		'0a000000-0000-4000-8000-000000000006', '  '), '22023');
end $$;

-- 6. The finish: current records the receipts and the system id and is due in ten minutes; the member sees it.
do $$
declare v jsonb; v_kept uuid := (select id from public.qorpera_digital_post_letters
	where message_uuid = '6f1d3c2a-9b8e-4d7c-8a6b-5e4f3d2c1b0a');
	v_staging uuid := (select id from public.qorpera_digital_post_letters
	where message_uuid = '7a000000-0000-4000-8000-000000000004');
begin
	perform pg_temp.refused(format('select pg_temp.finish(%L, %L)', '78600000-0000-4000-8000-0000000000e1', 'done'), '22023');
	perform pg_temp.refused(format('select pg_temp.finish(%L, %L, %L, %L)', '78600000-0000-4000-8000-0000000000e1',
		'current', '[]', 'an error with current'), '22023');
	perform pg_temp.refused(format('select pg_temp.finish(%L, %L)', '78600000-0000-4000-8000-0000000000e1', 'failed'), '22023');
	perform pg_temp.refused(format('select pg_temp.finish(%L, %L, %L, %L, %L)', '78600000-0000-4000-8000-0000000000e1',
		'current', '[]', null, '78600000-0000-4000-8000-0000000000ff'), '55000');
	v := pg_temp.finish('78600000-0000-4000-8000-0000000000e1', 'current', jsonb_build_array(v_kept, v_staging));
	perform pg_temp.check(v->>'status' = 'current', 'current');
	perform pg_temp.check((pg_temp.sync()).due_at between clock_timestamp() + interval '9 minutes'
		and clock_timestamp() + interval '11 minutes' and (pg_temp.sync()).lease_id is null
		and (pg_temp.sync()).system_id = 'e545b339-8542-4a30-ae75-c67e4d2a7b99' and (pg_temp.sync()).fetched_at is not null,
		'due in ten minutes, with its system id');
	perform pg_temp.check((select receipted_at is not null from public.qorpera_digital_post_letters where id = v_kept)
		and (select receipted_at is null from public.qorpera_digital_post_letters where id = v_staging),
		'only a kept letter is receipted');
	perform pg_temp.refused(format('select pg_temp.finish(%L, %L)', '78600000-0000-4000-8000-0000000000e1', 'current'), '55000');
	perform pg_temp.check(pg_temp.member('78600000-0000-4000-8000-000000000001', '78600000-0000-4000-8000-000000000020')
		@> '{"connected": true, "status": "current", "systemId": "e545b339-8542-4a30-ae75-c67e4d2a7b99", "letters": 1,
			"waitingForFolder": 1, "held": 1, "lastError": null}', 'the member sees the letter and the held one');
end $$;

-- 7. The next claim lists the held letter; more is due at once; a failure backs off; a refused key stops the sync.
do $$
declare v jsonb;
begin
	perform pg_temp.past();
	v := pg_temp.claim('78600000-0000-4000-8000-0000000000d1', repeat('1', 64));
	perform pg_temp.check(v->'held' = '["0a000000-0000-4000-8000-000000000005"]'::jsonb, 'the held letter is listed');
	perform pg_temp.finish('78600000-0000-4000-8000-0000000000e1', 'more');
	perform pg_temp.check((pg_temp.sync()).due_at <= clock_timestamp() + interval '31 seconds', 'more is due at once');
	perform pg_temp.past();
	perform pg_temp.claim('78600000-0000-4000-8000-0000000000d1', repeat('1', 64));
	perform pg_temp.finish('78600000-0000-4000-8000-0000000000e1', 'failed', '[]', 'Digital Post asked us to wait');
	perform pg_temp.check((pg_temp.sync()).status = 'failed' and (pg_temp.sync()).attempts = 1
		and (pg_temp.sync()).due_at between clock_timestamp() + interval '4 minutes' and clock_timestamp() + interval '6 minutes',
		'a failure is tried again in five minutes');
	perform pg_temp.check(pg_temp.member('78600000-0000-4000-8000-000000000001', '78600000-0000-4000-8000-000000000020')
		->>'lastError' = 'Digital Post asked us to wait', 'the member sees why');
	perform pg_temp.past();
	perform pg_temp.claim('78600000-0000-4000-8000-0000000000d1', repeat('1', 64));
	perform pg_temp.finish('78600000-0000-4000-8000-0000000000e1', 'failed', '[]', 'Digital Post did not answer as expected');
	perform pg_temp.check((pg_temp.sync()).attempts = 2
		and (pg_temp.sync()).due_at between clock_timestamp() + interval '9 minutes' and clock_timestamp() + interval '11 minutes',
		'then in ten');
	perform pg_temp.past();
	perform pg_temp.claim('78600000-0000-4000-8000-0000000000d1', repeat('1', 64));
	perform pg_temp.finish('78600000-0000-4000-8000-0000000000e1', 'refused', '[]', 'Digital Post refused the company''s key');
	perform pg_temp.check((pg_temp.sync()).status = 'refused' and (pg_temp.sync()).due_at is null, 'a refused key stops it');
	perform pg_temp.check(pg_temp.claim('78600000-0000-4000-8000-0000000000d1', repeat('1', 64)) is null, 'nothing is due');
end $$;

-- 8. A new key starts it again; a claim of the old version is late; a Disconnect stops it; a secret sealed for
-- another authority or replaced behind the sync's back stops it at the claim.
do $$
declare v jsonb; v_old uuid;
begin
	perform pg_temp.seal_secret('78600000-0000-4000-8000-0000000000e1', 2, '78600000-0000-4000-8000-0000000000d1');
	update public.qorpera_cloud_secrets set current_version = 2 where id = '78600000-0000-4000-8000-0000000000e1';
	perform pg_temp.check((pg_temp.sync()).status = 'waiting' and (pg_temp.sync()).secret_version = 2
		and (pg_temp.sync()).system_id is null, 'a new key is due at once');
	v := pg_temp.claim('78600000-0000-4000-8000-0000000000d1', repeat('1', 64));
	perform pg_temp.check((v->>'secretVersion')::int = 2, 'the new version is claimed');
	perform pg_temp.refused(format('select pg_temp.finish(%L, %L, %L, %L, %L, %L)', '78600000-0000-4000-8000-0000000000e1',
		'current', '[]', null, null, 1), '55000');
	update public.qorpera_cloud_secrets set status = 'revoked', revoked_at = statement_timestamp()
	where id = '78600000-0000-4000-8000-0000000000e1';
	perform pg_temp.check((pg_temp.sync()).status = 'disconnected' and (pg_temp.sync()).due_at is null, 'a Disconnect stops it');
	perform pg_temp.check(pg_temp.member('78600000-0000-4000-8000-000000000001', '78600000-0000-4000-8000-000000000020')
		@> '{"connected": false, "status": "disconnected"}', 'the member sees it disconnected');
	-- Connected again, then its version swapped under the sync: the claim stops it.
	perform pg_temp.connect('78600000-0000-4000-8000-0000000000e2', '78600000-0000-4000-8000-000000000010',
		'78600000-0000-4000-8000-000000000020', '78600000-0000-4000-8000-0000000000d1');
	perform pg_temp.check((pg_temp.sync()).status = 'waiting' and (pg_temp.sync()).secret_id = '78600000-0000-4000-8000-0000000000e2',
		'connecting again replaces the key');
	update public.qorpera_digital_post_syncs set secret_version = 9 where profile_id = '78600000-0000-4000-8000-000000000010';
	perform pg_temp.check(pg_temp.claim('78600000-0000-4000-8000-0000000000d1', repeat('1', 64)) is null
		and (pg_temp.sync()).status = 'disconnected', 'a version that is not current stops it');
end $$;

-- 9. The shared vault asks which of its companies are due: only its own, only when due.
do $$
declare v jsonb;
begin
	perform pg_temp.connect('78600000-0000-4000-8000-0000000000e3', '78600000-0000-4000-8000-000000000011',
		'78600000-0000-4000-8000-000000000021', '78600000-0000-4000-8000-0000000000d2');
	v := pg_temp.due('78600000-0000-4000-8000-000000000050', repeat('a', 64));
	perform pg_temp.check(v = '{"schema": "qorpera.broker-principal-digital-post-syncs/v1",
		"companyIds": ["78600000-0000-4000-8000-000000000011"]}'::jsonb, 'only the shared vault''s due company');
	perform pg_temp.refused($q$select pg_temp.due('78600000-0000-4000-8000-000000000050', repeat('b', 64))$q$, '42501');
end $$;

rollback;
