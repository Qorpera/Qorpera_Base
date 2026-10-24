-- @fixture 704_folder_state_connections.test.sql until "-- 1. The company, and the platform writing its first connection file"
-- The company bank connection, part 3 (migration 20260930528000): a company whose bank summary the folder lacks is due
-- to the object gateway's writer, which claims it (its own lease), makes bank/ and writes bank/summary.json as the platform
-- under the claim's operation key, and finishes the claim. A newer summary is due again and reads the file's version; a
-- problem backs off; a claim another writer took over is finished false. Here one session plays the writer through the
-- folder core's commit, on 704's folder-v2 company.

create function pg_temp.bank_check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
	if p_ok is not true then raise exception 'Failed: %', p_what; end if;
end $$;
create function pg_temp.bank_refused(p_sql text, p_state text) returns void language plpgsql as $$
begin
	begin execute p_sql; exception when others then
		if sqlstate = p_state then return; end if;
		raise exception 'Expected %, got %: %', p_state, sqlstate, sqlerrm;
	end;
	raise exception 'Not refused: %', p_sql;
end $$;
-- A JSON file's verified version-2 bytes, staged by the platform as the gateway stages them.
create function pg_temp.bank_stage(p_text text) returns jsonb language plpgsql as $$
declare
	v_bytes bytea := convert_to(p_text, 'utf8');
	v_manifest text := format('{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"%s","bytes":%s,"mediaType":"application/json","executable":false,"chunks":[{"sha256":"%s","bytes":%s}]}',
		encode(extensions.digest(v_bytes, 'sha256'), 'hex'), octet_length(v_bytes),
		encode(extensions.digest(v_bytes, 'sha256'), 'hex'), octet_length(v_bytes));
	v_seal jsonb := pg_temp.seal_v2('70400000-0000-4000-8000-000000000020', pg_temp.platform(), v_manifest);
begin
	if v_seal ->> 'state' is distinct from 'sealed' then raise exception 'Staging: %', v_seal; end if;
	return v_seal -> 'file';
end $$;
create function pg_temp.bank_sync() returns public.qorpera_bank_syncs language sql as $$
	select * from public.qorpera_bank_syncs where profile_id = '70400000-0000-4000-8000-000000000010'
$$;
create function pg_temp.bank_summary(p_saldo integer) returns jsonb language sql as $$
	select jsonb_build_object('schema', 'qorpera.bank-summary/v1', 'bank', 'Danske Bank', 'pausedSince', null, 'saldo', p_saldo)
$$;
-- The vault records a summary, as qorpera_finish_bank_sync does.
create function pg_temp.bank_record(p_saldo integer) returns void language sql as $$
	update public.qorpera_bank_syncs
	set summary = pg_temp.bank_summary(p_saldo), summary_generation = summary_generation + 1, summary_at = clock_timestamp(),
		status = 'current', due_at = clock_timestamp() + interval '6 hours'
	where profile_id = '70400000-0000-4000-8000-000000000010'
$$;
create function pg_temp.bank_claim(p_worker uuid default '68200000-0000-4000-8000-00000000000a') returns jsonb language sql as $$
	select public.qorpera_claim_bank_summary_file(p_worker, 60)
$$;
create function pg_temp.bank_finish(p_claim jsonb, p_problem text default null,
	p_worker uuid default '68200000-0000-4000-8000-00000000000a') returns boolean language sql as $$
	select (public.qorpera_finish_bank_summary_file(p_worker, (p_claim ->> 'profileId')::uuid,
		(p_claim ->> 'generation')::bigint, p_problem) ->> 'finished')::boolean
$$;

-- 1. Only the gateway's service role may claim and finish.
do $$
declare v_role text; v_function text;
begin
	foreach v_function in array array['public.qorpera_claim_bank_summary_file(uuid,integer)',
		'public.qorpera_finish_bank_summary_file(uuid,uuid,bigint,text)'] loop
		foreach v_role in array array['anon', 'authenticated', 'qorpera_secret_broker'] loop
			perform pg_temp.bank_check(not has_function_privilege(v_role, v_function, 'execute'), v_role || ' may not call ' || v_function);
		end loop;
		perform pg_temp.bank_check(has_function_privilege('service_role', v_function, 'execute'), 'the gateway calls ' || v_function);
	end loop;
end $$;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true) \g /dev/null
select pg_temp.bank_refused($$select pg_temp.bank_claim()$$, '42501');
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null

-- 2. A connected bank without a summary is not due; a recorded summary is, with bank/ missing and no file yet.
insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind, connector_id, secret_name,
	purpose, current_version, created_by_user_id, account_label)
values ('68200000-0000-4000-8000-0000000000b1', '70400000-0000-4000-8000-000000000010', '70400000-0000-4000-8000-000000000020',
	'70400000-0000-4000-8000-0000000000d1', 'company', 'bank', 'primary', 'Company bank', 1,
	'70400000-0000-4000-8000-000000000001', '••6243');
select pg_temp.bank_check(pg_temp.bank_claim() is null, 'no summary, nothing due');
select pg_temp.bank_record(1000);
do $$
declare v jsonb := pg_temp.bank_claim(); v_file jsonb; r jsonb;
begin
	perform pg_temp.bank_check(v ->> 'schema' = 'qorpera.bank-summary-claim/v1'
		and v ->> 'profileId' = '70400000-0000-4000-8000-000000000010'
		and v ->> 'environmentId' = '70400000-0000-4000-8000-000000000020'
		and (v ->> 'generation')::bigint = 1 and (v ->> 'attempt')::integer = 1
		and v ->> 'operationKey' = 'bank-summary:70400000-0000-4000-8000-000000000010:1:1'
		and not (v ->> 'folderPresent')::boolean and v -> 'currentVersion' = 'null'::jsonb
		and (v -> 'summary' ->> 'saldo')::integer = 1000, 'the first claim: ' || v::text);
	perform pg_temp.bank_check(pg_temp.bank_claim() is null, 'a leased company is not claimed twice');
	-- The writer: bank/, then the file, as the platform under the claim's keys.
	r := public.qorpera_folder_commit('70400000-0000-4000-8000-000000000020', pg_temp.platform(), (v ->> 'operationKey') || ':folder',
		jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', 'bank')));
	perform pg_temp.expect(r, 1, 'saved');
	v_file := pg_temp.bank_stage(jsonb_pretty(v -> 'summary') || E'\n');
	r := public.qorpera_folder_commit('70400000-0000-4000-8000-000000000020', pg_temp.platform(), v ->> 'operationKey',
		jsonb_build_array(jsonb_build_object('op', 'write', 'path', 'bank/summary.json', 'file', v_file)));
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.bank_check(pg_temp.bank_finish(v), 'the claim finishes');
	perform pg_temp.bank_check((pg_temp.bank_sync()).written_generation = 1 and (pg_temp.bank_sync()).write_lease_owner is null
		and (pg_temp.bank_sync()).write_attempts = 0, 'the folder has generation 1');
	perform pg_temp.bank_check(pg_temp.bank_claim() is null, 'nothing due once written');
end $$;

-- 3. A newer summary is due again with bank/ present and the file's version; a problem backs off; a claim another
-- writer took over is finished false.
select pg_temp.bank_record(2000);
do $$
declare v jsonb := pg_temp.bank_claim(); v_again jsonb;
begin
	perform pg_temp.bank_check((v ->> 'generation')::bigint = 2 and (v ->> 'folderPresent')::boolean
		and (v ->> 'currentVersion')::uuid = pg_temp.version('bank/summary.json'), 'the second claim: ' || v::text);
	perform pg_temp.bank_check(pg_temp.bank_finish(v, 'stale'), 'a problem finishes the claim');
	perform pg_temp.bank_check((pg_temp.bank_sync()).written_generation = 1 and (pg_temp.bank_sync()).write_problem = 'stale'
		and (pg_temp.bank_sync()).write_not_before > clock_timestamp(), 'a problem backs off');
	perform pg_temp.bank_check(pg_temp.bank_claim() is null, 'nothing due while backing off');
	update public.qorpera_bank_syncs set write_not_before = clock_timestamp() - interval '1 second'
	where profile_id = '70400000-0000-4000-8000-000000000010';
	v_again := pg_temp.bank_claim();
	perform pg_temp.bank_check((v_again ->> 'attempt')::integer = 2
		and v_again ->> 'operationKey' = 'bank-summary:70400000-0000-4000-8000-000000000010:2:2', 'claimed again: ' || v_again::text);
	-- Another writer takes the company over after this lease ran out: the first writer's finish changes nothing.
	update public.qorpera_bank_syncs set write_lease_until = clock_timestamp() - interval '1 second'
	where profile_id = '70400000-0000-4000-8000-000000000010';
	perform pg_temp.bank_check(pg_temp.bank_claim('68200000-0000-4000-8000-00000000000b') is not null, 'the second writer claims');
	perform pg_temp.bank_check(not pg_temp.bank_finish(v_again), 'the first writer''s finish is not its own any more');
	perform pg_temp.bank_check((pg_temp.bank_sync()).write_lease_owner = '68200000-0000-4000-8000-00000000000b',
		'the second writer still holds it');
	perform pg_temp.bank_check(pg_temp.bank_finish(v_again, null, '68200000-0000-4000-8000-00000000000b')
		and (pg_temp.bank_sync()).written_generation = 2, 'the second writer finishes');
end $$;
select pg_temp.bank_refused($$select public.qorpera_finish_bank_summary_file('68200000-0000-4000-8000-00000000000a',
	'70400000-0000-4000-8000-000000000010', 2, 'Not A Code')$$, '22023');

rollback;
