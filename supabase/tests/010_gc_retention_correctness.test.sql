insert into auth.users (id, email)
values ('20000000-0000-4000-8000-000000000001', 'gc-owner@example.test');

insert into public.qorpera_profiles (id, name, created_by_user_id)
values
	('20000000-0000-4000-8000-000000000010', 'Expired plan profile', '20000000-0000-4000-8000-000000000001'),
	('30000000-0000-4000-8000-000000000010', 'Claim fence profile', '20000000-0000-4000-8000-000000000001'),
	('40000000-0000-4000-8000-000000000010', 'Write fence profile', '20000000-0000-4000-8000-000000000001');

insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role)
values
	('20000000-0000-4000-8000-000000000010', '20000000-0000-4000-8000-000000000001', 'gc-owner@example.test', 'GC owner', 'owner'),
	('30000000-0000-4000-8000-000000000010', '20000000-0000-4000-8000-000000000001', 'gc-owner@example.test', 'GC owner', 'owner'),
	('40000000-0000-4000-8000-000000000010', '20000000-0000-4000-8000-000000000001', 'gc-owner@example.test', 'GC owner', 'owner');

insert into public.qorpera_company_environments (
	id, profile_id, name, contract_version, created_by_user_id
)
values
	('20000000-0000-4000-8000-000000000020', '20000000-0000-4000-8000-000000000010', 'Expired', 1, '20000000-0000-4000-8000-000000000001'),
	('30000000-0000-4000-8000-000000000020', '30000000-0000-4000-8000-000000000010', 'Claim', 1, '20000000-0000-4000-8000-000000000001'),
	('40000000-0000-4000-8000-000000000020', '40000000-0000-4000-8000-000000000010', 'Write', 1, '20000000-0000-4000-8000-000000000001');

insert into storage.objects (bucket_id, name, metadata)
values
	('qorpera-profile-objects', '20000000-0000-4000-8000-000000000010/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '{"size":"42"}'),
	('qorpera-profile-objects', '30000000-0000-4000-8000-000000000010/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '{"size":"42"}'),
	('qorpera-profile-objects', '30000000-0000-4000-8000-000000000010/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', '{"size":"21"}');

select set_config(
	'request.jwt.claims',
	'{"sub":"20000000-0000-4000-8000-000000000001","email":"gc-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);

insert into public.qorpera_artifacts (
	id, profile_id, environment_id, client_artifact_id, artifact_type, name,
	root_object_sha256, content_sha256, bytes, media_type, created_by_user_id,
	created_at, eligible_for_gc_at, root_contract
)
values
	(
		'20000000-0000-4000-8000-000000000030', '20000000-0000-4000-8000-000000000010',
		'20000000-0000-4000-8000-000000000020', '20000000-0000-4000-8000-000000000031',
		'fixture', 'expired.bin', repeat('a', 64), repeat('a', 64), 42, 'application/octet-stream',
		'20000000-0000-4000-8000-000000000001', statement_timestamp() - interval '40 days',
		statement_timestamp() - interval '10 days', 'qorpera.object/v1'
	),
	(
		'30000000-0000-4000-8000-000000000030', '30000000-0000-4000-8000-000000000010',
		'30000000-0000-4000-8000-000000000020', '30000000-0000-4000-8000-000000000031',
		'fixture', 'candidate.bin', repeat('b', 64), repeat('b', 64), 42, 'application/octet-stream',
		'20000000-0000-4000-8000-000000000001', statement_timestamp() - interval '40 days',
		statement_timestamp() - interval '10 days', 'qorpera.object/v1'
	),
	(
		'30000000-0000-4000-8000-000000000032', '30000000-0000-4000-8000-000000000010',
		'30000000-0000-4000-8000-000000000020', '30000000-0000-4000-8000-000000000033',
		'fixture', 'retained.bin', repeat('c', 64), repeat('c', 64), 21, 'application/octet-stream',
		'20000000-0000-4000-8000-000000000001', statement_timestamp() - interval '20 days',
		statement_timestamp() + interval '10 days', 'qorpera.object/v1'
	);

insert into public.qorpera_object_reachability_graphs (
	id, profile_id, environment_id, root_kind, root_id, client_graph_id,
	root_object_sha256, contract_version, content_sha256, object_count,
	storage_bytes, status, created_by_user_id, completed_at, closure_verified
)
values
	(
		'20000000-0000-4000-8000-000000000040', '20000000-0000-4000-8000-000000000010',
		'20000000-0000-4000-8000-000000000020', 'artifact', '20000000-0000-4000-8000-000000000030',
		'20000000-0000-4000-8000-000000000041', repeat('a', 64), 1,
		encode(extensions.digest(convert_to(repeat('a', 64) || ':42', 'utf8'), 'sha256'), 'hex'), 1, 42,
		'uploading', '20000000-0000-4000-8000-000000000001', null, false
	),
	(
		'30000000-0000-4000-8000-000000000040', '30000000-0000-4000-8000-000000000010',
		'30000000-0000-4000-8000-000000000020', 'artifact', '30000000-0000-4000-8000-000000000030',
		'30000000-0000-4000-8000-000000000041', repeat('b', 64), 1,
		encode(extensions.digest(convert_to(repeat('b', 64) || ':42', 'utf8'), 'sha256'), 'hex'), 1, 42,
		'uploading', '20000000-0000-4000-8000-000000000001', null, false
	),
	(
		'30000000-0000-4000-8000-000000000042', '30000000-0000-4000-8000-000000000010',
		'30000000-0000-4000-8000-000000000020', 'artifact', '30000000-0000-4000-8000-000000000032',
		'30000000-0000-4000-8000-000000000043', repeat('c', 64), 1,
		encode(extensions.digest(convert_to(repeat('c', 64) || ':21', 'utf8'), 'sha256'), 'hex'), 1, 21,
		'uploading', '20000000-0000-4000-8000-000000000001', null, false
	);

insert into public.qorpera_object_reachability_entries (graph_id, object_sha256, bytes)
values
	('20000000-0000-4000-8000-000000000040', repeat('a', 64), 42),
	('30000000-0000-4000-8000-000000000040', repeat('b', 64), 42),
	('30000000-0000-4000-8000-000000000042', repeat('c', 64), 21);

update public.qorpera_object_reachability_graphs
set status = 'complete', completed_at = statement_timestamp()
where id in (
	'20000000-0000-4000-8000-000000000040',
	'30000000-0000-4000-8000-000000000040',
	'30000000-0000-4000-8000-000000000042'
);

insert into public.qorpera_object_restore_proofs (
	id, graph_id, profile_id, client_proof_id, restored_content_sha256,
	restored_bytes, verified_by_user_id
)
values
	(
		'20000000-0000-4000-8000-000000000050', '20000000-0000-4000-8000-000000000040',
		'20000000-0000-4000-8000-000000000010', '20000000-0000-4000-8000-000000000051',
		repeat('a', 64), 42, '20000000-0000-4000-8000-000000000001'
	),
	(
		'30000000-0000-4000-8000-000000000050', '30000000-0000-4000-8000-000000000040',
		'30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000051',
		repeat('b', 64), 42, '20000000-0000-4000-8000-000000000001'
	);

insert into public.qorpera_artifact_gc_plans (
	id, profile_id, artifact_id, graph_id, restore_proof_id, client_plan_id,
	status, object_count, storage_bytes, not_before, next_attempt_at, attempt_count,
	lease_id, lease_expires_at, created_by_user_id, created_at, started_at
)
values
	(
		'20000000-0000-4000-8000-000000000060', '20000000-0000-4000-8000-000000000010',
		'20000000-0000-4000-8000-000000000030', '20000000-0000-4000-8000-000000000040',
		'20000000-0000-4000-8000-000000000050', '20000000-0000-4000-8000-000000000061',
		'deleting', 1, 42, statement_timestamp() - interval '1 minute', statement_timestamp() - interval '1 minute',
		1, '20000000-0000-4000-8000-000000000062', statement_timestamp() - interval '2 minutes',
		'20000000-0000-4000-8000-000000000001', statement_timestamp() - interval '25 hours',
		statement_timestamp() - interval '10 minutes'
	),
	(
		'30000000-0000-4000-8000-000000000060', '30000000-0000-4000-8000-000000000010',
		'30000000-0000-4000-8000-000000000030', '30000000-0000-4000-8000-000000000040',
		'30000000-0000-4000-8000-000000000050', '30000000-0000-4000-8000-000000000061',
		'waiting', 1, 42, statement_timestamp() - interval '1 minute', statement_timestamp() - interval '1 minute',
		0, null, null, '20000000-0000-4000-8000-000000000001', statement_timestamp() - interval '25 hours', null
	);

insert into public.qorpera_artifact_gc_plan_entries (plan_id, object_sha256, bytes)
values
	('20000000-0000-4000-8000-000000000060', repeat('a', 64), 42),
	('30000000-0000-4000-8000-000000000060', repeat('b', 64), 42);

select set_config(
	'request.jwt.claims',
	'{"sub":"20000000-0000-4000-8000-000000000001","email":"gc-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);

select public.qorpera_cancel_artifact_gc_plan('20000000-0000-4000-8000-000000000060');

do $$
begin
	if (select status from public.qorpera_artifact_gc_plans where id = '20000000-0000-4000-8000-000000000060') <> 'cancelled' then
		raise exception 'expired deleting plan was not recoverable';
	end if;
	if not public.qorpera_profile_reachability_coverage_ready('30000000-0000-4000-8000-000000000010') then
		raise exception 'closure coverage incorrectly requires a proof for every historical root';
	end if;
	if not public.qorpera_artifact_gc_initial_guard_ready('30000000-0000-4000-8000-000000000030') then
		raise exception 'candidate guard rejected verified closure coverage without unrelated proofs';
	end if;
end
$$;

select dblink_connect('gc_locker', 'dbname=qorpera_test');
select dblink_connect('gc_worker', 'dbname=qorpera_test');
select dblink_exec('gc_locker', 'begin');
select * from dblink(
	'gc_locker',
	$$select id from public.qorpera_profiles where id = '30000000-0000-4000-8000-000000000010' for update$$
) as locked_profile(id uuid);
select dblink_exec(
	'gc_worker',
	$$set request.jwt.claims = '{"role":"service_role"}'$$
);
select dblink_send_query(
	'gc_worker',
	$$select public.qorpera_claim_artifact_gc_plans(1, '30000000-0000-4000-8000-000000000062')$$
);
select pg_sleep(0.2);

do $$
begin
	if dblink_is_busy('gc_worker') <> 1 then
		raise exception 'GC claim did not wait for the shared profile fence';
	end if;
end
$$;

select dblink_exec('gc_locker', 'commit');
select * from dblink_get_result('gc_worker') as claimed(result jsonb);
select dblink_disconnect('gc_worker');
select dblink_disconnect('gc_locker');

select set_config('request.jwt.claims', '{"role":"service_role"}', false);
select public.qorpera_renew_artifact_gc_lease(
	'30000000-0000-4000-8000-000000000060',
	'30000000-0000-4000-8000-000000000062',
	array[repeat('b', 64)]
);

do $$
begin
	if (
		select lease_expires_at < statement_timestamp() + interval '4 minutes'
		from public.qorpera_artifact_gc_plans
		where id = '30000000-0000-4000-8000-000000000060'
	) then
		raise exception 'GC removal lease was not renewed immediately before deletion';
	end if;
	begin
		perform public.qorpera_renew_artifact_gc_lease(
			'30000000-0000-4000-8000-000000000060',
			'30000000-0000-4000-8000-000000000063',
			array[repeat('b', 64)]
		);
		raise exception 'stale GC lease was accepted';
	exception when serialization_failure then
		null;
	end;
end
$$;

select dblink_connect('write_locker', 'dbname=qorpera_test');
select dblink_connect('root_writer', 'dbname=qorpera_test');
select dblink_exec('write_locker', 'begin');
select * from dblink(
	'write_locker',
	$$select id from public.qorpera_profiles where id = '40000000-0000-4000-8000-000000000010' for update$$
) as locked_profile(id uuid);
select dblink_send_query(
	'root_writer',
	$$
		insert into public.qorpera_artifacts (
			id, profile_id, environment_id, client_artifact_id, artifact_type, name,
			root_object_sha256, content_sha256, bytes, media_type, created_by_user_id,
			created_at, eligible_for_gc_at, root_contract
		)
		values (
			'40000000-0000-4000-8000-000000000030', '40000000-0000-4000-8000-000000000010',
			'40000000-0000-4000-8000-000000000020', '40000000-0000-4000-8000-000000000031',
			'fixture', 'write.bin', repeat('d', 64), repeat('d', 64), 1, 'application/octet-stream',
			'20000000-0000-4000-8000-000000000001', statement_timestamp(),
			statement_timestamp() + interval '30 days', 'qorpera.object/v1'
		)
		returning id
	$$
);
select pg_sleep(0.2);

do $$
begin
	if dblink_is_busy('root_writer') <> 1 then
		raise exception 'profile root write did not wait for the shared GC fence';
	end if;
end
$$;

select dblink_exec('write_locker', 'commit');
select * from dblink_get_result('root_writer') as inserted_artifact(id uuid);
select dblink_disconnect('root_writer');
select dblink_disconnect('write_locker');

-- A partially-deleted plan whose candidate proof has expired must remain
-- resumable: the proof cannot be re-minted once bytes are gone, so requiring
-- it would strand the plan (and the profile fence) forever. A fresh plan with
-- an expired proof must instead park in 'retrying' without aborting the batch.
insert into public.qorpera_profiles (id, name, created_by_user_id)
values ('50000000-0000-4000-8000-000000000010', 'Resume liveness profile', '20000000-0000-4000-8000-000000000001');

insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role)
values ('50000000-0000-4000-8000-000000000010', '20000000-0000-4000-8000-000000000001', 'gc-owner@example.test', 'GC owner', 'owner');

insert into public.qorpera_company_environments (
	id, profile_id, name, contract_version, created_by_user_id
)
values ('50000000-0000-4000-8000-000000000020', '50000000-0000-4000-8000-000000000010', 'Resume', 1, '20000000-0000-4000-8000-000000000001');

insert into storage.objects (bucket_id, name, metadata)
values
	('qorpera-profile-objects', '50000000-0000-4000-8000-000000000010/' || repeat('e', 64), '{"size":"42"}'),
	('qorpera-profile-objects', '50000000-0000-4000-8000-000000000010/' || repeat('f', 64), '{"size":"21"}');

select set_config(
	'request.jwt.claims',
	'{"sub":"20000000-0000-4000-8000-000000000001","email":"gc-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);

insert into public.qorpera_artifacts (
	id, profile_id, environment_id, client_artifact_id, artifact_type, name,
	root_object_sha256, content_sha256, bytes, media_type, created_by_user_id,
	created_at, eligible_for_gc_at, root_contract
)
values
	(
		'50000000-0000-4000-8000-000000000030', '50000000-0000-4000-8000-000000000010',
		'50000000-0000-4000-8000-000000000020', '50000000-0000-4000-8000-000000000031',
		'fixture', 'resumed.bin', repeat('e', 64), repeat('e', 64), 42, 'application/octet-stream',
		'20000000-0000-4000-8000-000000000001', statement_timestamp() - interval '40 days',
		statement_timestamp() - interval '10 days', 'qorpera.object/v1'
	),
	(
		'50000000-0000-4000-8000-000000000032', '50000000-0000-4000-8000-000000000010',
		'50000000-0000-4000-8000-000000000020', '50000000-0000-4000-8000-000000000033',
		'fixture', 'fresh.bin', repeat('f', 64), repeat('f', 64), 21, 'application/octet-stream',
		'20000000-0000-4000-8000-000000000001', statement_timestamp() - interval '40 days',
		statement_timestamp() - interval '10 days', 'qorpera.object/v1'
	);

insert into public.qorpera_object_reachability_graphs (
	id, profile_id, environment_id, root_kind, root_id, client_graph_id,
	root_object_sha256, contract_version, content_sha256, object_count,
	storage_bytes, status, created_by_user_id, completed_at, closure_verified
)
values
	(
		'50000000-0000-4000-8000-000000000040', '50000000-0000-4000-8000-000000000010',
		'50000000-0000-4000-8000-000000000020', 'artifact', '50000000-0000-4000-8000-000000000030',
		'50000000-0000-4000-8000-000000000041', repeat('e', 64), 1,
		encode(extensions.digest(convert_to(repeat('e', 64) || ':42', 'utf8'), 'sha256'), 'hex'), 1, 42,
		'uploading', '20000000-0000-4000-8000-000000000001', null, false
	),
	(
		'50000000-0000-4000-8000-000000000042', '50000000-0000-4000-8000-000000000010',
		'50000000-0000-4000-8000-000000000020', 'artifact', '50000000-0000-4000-8000-000000000032',
		'50000000-0000-4000-8000-000000000043', repeat('f', 64), 1,
		encode(extensions.digest(convert_to(repeat('f', 64) || ':21', 'utf8'), 'sha256'), 'hex'), 1, 21,
		'uploading', '20000000-0000-4000-8000-000000000001', null, false
	);

insert into public.qorpera_object_reachability_entries (graph_id, object_sha256, bytes)
values
	('50000000-0000-4000-8000-000000000040', repeat('e', 64), 42),
	('50000000-0000-4000-8000-000000000042', repeat('f', 64), 21);

update public.qorpera_object_reachability_graphs
set status = 'complete', completed_at = statement_timestamp()
where id in ('50000000-0000-4000-8000-000000000040', '50000000-0000-4000-8000-000000000042');

insert into public.qorpera_object_restore_proofs (
	id, graph_id, profile_id, client_proof_id, restored_content_sha256,
	restored_bytes, verified_by_user_id
)
values
	(
		'50000000-0000-4000-8000-000000000050', '50000000-0000-4000-8000-000000000040',
		'50000000-0000-4000-8000-000000000010', '50000000-0000-4000-8000-000000000051',
		repeat('e', 64), 42, '20000000-0000-4000-8000-000000000001'
	),
	(
		'50000000-0000-4000-8000-000000000052', '50000000-0000-4000-8000-000000000042',
		'50000000-0000-4000-8000-000000000010', '50000000-0000-4000-8000-000000000053',
		repeat('f', 64), 21, '20000000-0000-4000-8000-000000000001'
	);

insert into public.qorpera_artifact_gc_plans (
	id, profile_id, artifact_id, graph_id, restore_proof_id, client_plan_id,
	status, object_count, storage_bytes, not_before, next_attempt_at, attempt_count,
	lease_id, lease_expires_at, created_by_user_id, created_at, started_at
)
values
	(
		'50000000-0000-4000-8000-000000000060', '50000000-0000-4000-8000-000000000010',
		'50000000-0000-4000-8000-000000000030', '50000000-0000-4000-8000-000000000040',
		'50000000-0000-4000-8000-000000000050', '50000000-0000-4000-8000-000000000061',
		'retrying', 1, 42, statement_timestamp() - interval '1 hour', statement_timestamp() - interval '2 minutes',
		1, null, null, '20000000-0000-4000-8000-000000000001', statement_timestamp() - interval '26 hours',
		statement_timestamp() - interval '30 minutes'
	),
	(
		'50000000-0000-4000-8000-000000000062', '50000000-0000-4000-8000-000000000010',
		'50000000-0000-4000-8000-000000000032', '50000000-0000-4000-8000-000000000042',
		'50000000-0000-4000-8000-000000000052', '50000000-0000-4000-8000-000000000063',
		'waiting', 1, 21, statement_timestamp() - interval '1 hour', statement_timestamp() - interval '1 minute',
		0, null, null, '20000000-0000-4000-8000-000000000001', statement_timestamp() - interval '26 hours', null
	);

insert into public.qorpera_artifact_gc_plan_entries (plan_id, object_sha256, bytes)
values
	('50000000-0000-4000-8000-000000000060', repeat('e', 64), 42),
	('50000000-0000-4000-8000-000000000062', repeat('f', 64), 21);

update public.qorpera_object_restore_proofs
set valid_until = statement_timestamp() - interval '1 minute'
where id in ('50000000-0000-4000-8000-000000000050', '50000000-0000-4000-8000-000000000052');

select set_config('request.jwt.claims', '{"role":"service_role"}', false);
select public.qorpera_claim_artifact_gc_plans(2, '50000000-0000-4000-8000-000000000064');

do $$
declare
	v_resumed public.qorpera_artifact_gc_plans%rowtype;
	v_fresh public.qorpera_artifact_gc_plans%rowtype;
begin
	select plan.* into v_resumed
	from public.qorpera_artifact_gc_plans as plan
	where plan.id = '50000000-0000-4000-8000-000000000060';
	if v_resumed.status <> 'deleting' or v_resumed.attempt_count <> 2
		or v_resumed.lease_id is distinct from '50000000-0000-4000-8000-000000000064'
		or v_resumed.restore_proof_id is distinct from '50000000-0000-4000-8000-000000000050' then
		raise exception 'started plan with an expired proof was not resumable';
	end if;
	select plan.* into v_fresh
	from public.qorpera_artifact_gc_plans as plan
	where plan.id = '50000000-0000-4000-8000-000000000062';
	if v_fresh.status <> 'retrying' or v_fresh.started_at is not null then
		raise exception 'fresh plan with an expired proof did not park in retrying';
	end if;
end
$$;
