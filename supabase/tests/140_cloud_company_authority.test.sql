-- Canonical Company File creation, revision CAS, quota, and session pinning.

insert into auth.users (id, email, raw_user_meta_data)
values (
	'14000000-0000-4000-8000-000000000001',
	'cloud-company-owner@example.test',
	'{"full_name":"Cloud Company Owner"}'
);

select set_config(
	'request.jwt.claims',
	'{"sub":"14000000-0000-4000-8000-000000000001","email":"cloud-company-owner@example.test","role":"authenticated","user_metadata":{"full_name":"Cloud Company Owner"}}',
	false
);
set role authenticated;

select set_config(
	'qorpera_test.cloud_company',
	public.qorpera_create_cloud_company(
		'14000000-0000-4000-8000-000000000010', 'Canonical Company', 2
	)::text,
	false
);

do $$
declare
	v_first jsonb := current_setting('qorpera_test.cloud_company')::jsonb;
	v_second jsonb;
	v_file jsonb;
	v_rebound boolean := false;
begin
	v_second := public.qorpera_create_cloud_company(
		'14000000-0000-4000-8000-000000000010', 'Canonical Company', 2
	);
	if v_first ->> 'profile_id' is distinct from v_second ->> 'profile_id'
		or v_first ->> 'environment_id' is distinct from v_second ->> 'environment_id' then
		raise exception 'cloud company creation is not idempotent';
	end if;
	begin
		perform public.qorpera_create_cloud_company(
			'14000000-0000-4000-8000-000000000010', 'Different Company', 2
		);
	exception when unique_violation then
		v_rebound := true;
	end;
	if not v_rebound then
		raise exception 'cloud company creation id accepted different request content';
	end if;
	begin
		perform public.qorpera_create_cloud_company(
			'14000000-0000-4000-8000-000000000011', 'Canonical Company', 3
		);
		raise exception 'unsupported company creation contract was accepted';
	exception when sqlstate '22023' then null;
	end;
	v_file := public.qorpera_get_company_file((v_first ->> 'environment_id')::uuid);
	if v_file ->> 'state' is distinct from 'provisioning'
		or (v_file ->> 'head_snapshot_id') is not null
		or (v_file ->> 'storage_limit_bytes')::bigint <> 53687091200 then
		raise exception 'new Company File is not a provisioned 50 GiB cloud authority: %', v_file;
	end if;
end
$$;

do $$
declare v_rejected boolean := false;
begin
	begin
		perform public.qorpera_prepare_company_file_revision(
			(current_setting('qorpera_test.cloud_company')::jsonb ->> 'environment_id')::uuid,
			'14000000-0000-4000-8000-000000000020', null,
			repeat('a', 64), 128, 3, 1, 4
		);
	exception when sqlstate '22023' then v_rejected := true;
	end;
	if not v_rejected then
		raise exception 'revision was prepared without its exact manifest object';
	end if;
end
$$;

reset role;
insert into storage.objects (bucket_id, name, metadata)
values (
	'qorpera-profile-objects',
	(current_setting('qorpera_test.cloud_company')::jsonb ->> 'profile_id') || '/' || repeat('a', 64),
	'{"size":128}'
);
set role authenticated;

select set_config('qorpera_test.cloud_company_snapshot',
	public.qorpera_prepare_company_file_revision(
		(current_setting('qorpera_test.cloud_company')::jsonb ->> 'environment_id')::uuid,
		'14000000-0000-4000-8000-000000000020', null,
		repeat('a', 64), 128, 3, 1, 4
	)::text, false);

do $$
declare v_rejected boolean := false;
begin
	begin
		perform public.qorpera_publish_company_file_revision(
			(current_setting('qorpera_test.cloud_company')::jsonb ->> 'environment_id')::uuid,
			(current_setting('qorpera_test.cloud_company_snapshot')::jsonb ->> 'snapshot_id')::uuid,
			null
		);
	exception when sqlstate '55000' then v_rejected := true;
	end;
	if not v_rejected then
		raise exception 'revision advanced the head without a verified reachable restore';
	end if;
end
$$;

select set_config('qorpera_test.cloud_company_graph',
	public.qorpera_begin_object_reachability_graph(
		'company_snapshot',
		(current_setting('qorpera_test.cloud_company_snapshot')::jsonb ->> 'snapshot_id')::uuid,
		'14000000-0000-4000-8000-000000000022', repeat('a', 64), 1,
		encode(extensions.digest(convert_to(repeat('a', 64) || ':128', 'utf8'), 'sha256'), 'hex'),
		1, 128
	) ->> 'graph_id', false);
select public.qorpera_append_object_reachability_entries(
	current_setting('qorpera_test.cloud_company_graph')::uuid,
	jsonb_build_array(jsonb_build_object('sha256', repeat('a', 64), 'bytes', 128))
);
select public.qorpera_complete_object_reachability_graph(
	current_setting('qorpera_test.cloud_company_graph')::uuid
);
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}', false);
set role service_role;
select public.qorpera_verify_company_snapshot_closure(
	(current_setting('qorpera_test.cloud_company_snapshot')::jsonb ->> 'snapshot_id')::uuid,
	current_setting('qorpera_test.cloud_company_graph')::uuid,
	'14000000-0000-4000-8000-000000000001',
	encode(extensions.digest(convert_to(repeat('a', 64) || ':128', 'utf8'), 'sha256'), 'hex'),
	1, 128, repeat('a', 64), 4,
	'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
);
reset role;
select set_config(
	'request.jwt.claims',
	'{"sub":"14000000-0000-4000-8000-000000000001","email":"cloud-company-owner@example.test","role":"authenticated","user_metadata":{"full_name":"Cloud Company Owner"}}',
	false
);
set role authenticated;
select public.qorpera_create_object_restore_proof(
	current_setting('qorpera_test.cloud_company_graph')::uuid,
	'14000000-0000-4000-8000-000000000023', repeat('a', 64), 4
);
select public.qorpera_publish_company_file_revision(
	(current_setting('qorpera_test.cloud_company')::jsonb ->> 'environment_id')::uuid,
	(current_setting('qorpera_test.cloud_company_snapshot')::jsonb ->> 'snapshot_id')::uuid,
	null
);

reset role;
insert into storage.objects (bucket_id, name, metadata)
values (
	'qorpera-profile-objects',
	(current_setting('qorpera_test.cloud_company')::jsonb ->> 'profile_id') || '/' || repeat('b', 64),
	'{"size":128}'
);
set role authenticated;

do $$
declare
	v_company jsonb := current_setting('qorpera_test.cloud_company')::jsonb;
	v_snapshot jsonb := current_setting('qorpera_test.cloud_company_snapshot')::jsonb;
	v_file jsonb;
	v_session jsonb;
	v_pinned uuid;
	v_conflicted boolean := false;
begin
	v_file := public.qorpera_get_company_file((v_company ->> 'environment_id')::uuid);
	if v_file ->> 'state' is distinct from 'ready'
		or v_file ->> 'head_snapshot_id' is distinct from v_snapshot ->> 'snapshot_id'
		or (v_file ->> 'logical_bytes')::bigint <> 4 then
		raise exception 'canonical head did not advance: %', v_file;
	end if;

	begin
		perform public.qorpera_prepare_company_file_revision(
			(v_company ->> 'environment_id')::uuid,
			'14000000-0000-4000-8000-000000000021',
			null,
			repeat('b', 64),
			128,
			3,
			1,
			4
		);
	exception when sqlstate 'PT409' then
		v_conflicted := true;
	end;
	if not v_conflicted then
		raise exception 'stale Company File head was accepted';
	end if;

	begin
		perform public.qorpera_prepare_company_file_revision(
			(v_company ->> 'environment_id')::uuid,
			'14000000-0000-4000-8000-000000000024',
			(v_snapshot ->> 'snapshot_id')::uuid,
			repeat('b', 64), 128, 999, 1, 4
		);
		raise exception 'unsupported Company File contract version was accepted';
	exception when sqlstate '22023' then null;
	end;

	v_session := public.qorpera_create_shared_session_v2(
		(v_company ->> 'environment_id')::uuid,
		'14000000-0000-4000-8000-000000000030',
		'Pinned session',
		null,
		null
	);
	select session.company_snapshot_id into v_pinned
	from public.qorpera_shared_sessions as session
	where session.id = (v_session ->> 'session_id')::uuid;
	if v_pinned::text is distinct from v_snapshot ->> 'snapshot_id' then
		raise exception 'session did not pin the canonical Company File revision';
	end if;
end
$$;

reset role;
select set_config('request.jwt.claims', '', false);

-- Review-required work is persisted as a verified immutable proposal before
-- the turn leaves its live lease. Uploading it does not advance the canonical
-- head; an authorized reviewer must perform the final CAS publication.
insert into auth.users (id, email, raw_user_meta_data)
values (
	'14000000-0000-4000-8000-000000000002',
	'cloud-company-member@example.test',
	'{"full_name":"Cloud Company Member"}'
);
insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role)
values (
	(current_setting('qorpera_test.cloud_company')::jsonb ->> 'profile_id')::uuid,
	'14000000-0000-4000-8000-000000000002',
	'cloud-company-member@example.test', 'Cloud Company Member', 'contributor'
);
insert into public.qorpera_profile_staff (
	profile_id, staff_agent_id, display_name, role, charter,
	appearance_color, appearance_shape, employment_status, lifecycle_state,
	created_at, updated_at, updated_by_user_id
) values (
	(current_setting('qorpera_test.cloud_company')::jsonb ->> 'profile_id')::uuid,
	'14000000-0000-4000-8000-000000000101',
	'Financial Analyst', 'Finance', 'Prepare reviewable company research.',
	'blue', 'round', 'active', 'active', statement_timestamp(), statement_timestamp(),
	'14000000-0000-4000-8000-000000000001'
);

select set_config(
	'request.jwt.claims',
	'{"sub":"14000000-0000-4000-8000-000000000001","email":"cloud-company-owner@example.test","role":"authenticated","user_metadata":{"full_name":"Cloud Company Owner"}}',
	false
);
set role authenticated;

select set_config('qorpera_test.cloud_company_proposal_snapshot',
	public.qorpera_prepare_company_file_proposal(
		(current_setting('qorpera_test.cloud_company')::jsonb ->> 'environment_id')::uuid,
		'14000000-0000-4000-8000-000000000102',
		(current_setting('qorpera_test.cloud_company_snapshot')::jsonb ->> 'snapshot_id')::uuid,
		repeat('b', 64), 128, 3, 1, 4
	)::text, false);
select set_config('qorpera_test.cloud_company_proposal_graph',
	public.qorpera_begin_object_reachability_graph(
		'company_snapshot',
		(current_setting('qorpera_test.cloud_company_proposal_snapshot')::jsonb ->> 'snapshot_id')::uuid,
		'14000000-0000-4000-8000-000000000103', repeat('b', 64), 1,
		encode(extensions.digest(convert_to(repeat('b', 64) || ':128', 'utf8'), 'sha256'), 'hex'),
		1, 128
	) ->> 'graph_id', false);
select public.qorpera_append_object_reachability_entries(
	current_setting('qorpera_test.cloud_company_proposal_graph')::uuid,
	jsonb_build_array(jsonb_build_object('sha256', repeat('b', 64), 'bytes', 128))
);
select public.qorpera_complete_object_reachability_graph(
	current_setting('qorpera_test.cloud_company_proposal_graph')::uuid
);

reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}', false);
set role service_role;
select public.qorpera_verify_company_snapshot_closure(
	(current_setting('qorpera_test.cloud_company_proposal_snapshot')::jsonb ->> 'snapshot_id')::uuid,
	current_setting('qorpera_test.cloud_company_proposal_graph')::uuid,
	'14000000-0000-4000-8000-000000000001',
	encode(extensions.digest(convert_to(repeat('b', 64) || ':128', 'utf8'), 'sha256'), 'hex'),
	1, 128, repeat('b', 64), 4,
	'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
);

reset role;
select set_config(
	'request.jwt.claims',
	'{"sub":"14000000-0000-4000-8000-000000000001","email":"cloud-company-owner@example.test","role":"authenticated","user_metadata":{"full_name":"Cloud Company Owner"}}',
	false
);
set role authenticated;
select public.qorpera_create_object_restore_proof(
	current_setting('qorpera_test.cloud_company_proposal_graph')::uuid,
	'14000000-0000-4000-8000-000000000104', repeat('b', 64), 4
);
select set_config('qorpera_test.cloud_company_proposal_session',
	public.qorpera_ensure_staff_session(
		(current_setting('qorpera_test.cloud_company')::jsonb ->> 'environment_id')::uuid,
		'14000000-0000-4000-8000-000000000101',
		'14000000-0000-4000-8000-000000000105',
		'Financial Analyst'
	) ->> 'session_id', false);
select public.qorpera_append_session_input(
	current_setting('qorpera_test.cloud_company_proposal_session')::uuid,
	'14000000-0000-4000-8000-000000000106', 'user_message',
	'{"schema":"qorpera.session-prompt/v1","text":"Prepare the pricing analysis.","images":[]}'
);
select set_config('qorpera_test.cloud_company_proposal_claim',
	public.qorpera_claim_session_turn(
		current_setting('qorpera_test.cloud_company_proposal_session')::uuid,
		'14000000-0000-4000-8000-000000000107', 900,
		(current_setting('qorpera_test.cloud_company_snapshot')::jsonb ->> 'snapshot_id')::uuid,
		1
	)::text, false);
select public.qorpera_append_account_event(
	current_setting('qorpera_test.cloud_company_proposal_session')::uuid,
	'14000000-0000-4000-8000-000000000108', 'message',
	jsonb_build_object(
		'schema', 'qorpera.shared-trail-entry-part/v1',
		'entryId', 'pricing-analysis-output',
		'entryType', 'message',
		'partIndex', 0,
		'partCount', 1,
		'payloadBase64', replace(encode(convert_to(jsonb_build_object(
			'type', 'message',
			'id', 'pricing-analysis-output',
			'parentId', null,
			'timestamp', '2026-08-20T00:00:00.000Z',
			'execution', jsonb_build_object(
				'kind', 'turn',
				'id', current_setting('qorpera_test.cloud_company_proposal_claim')::jsonb ->> 'turn_id',
				'claimantId', '14000000-0000-4000-8000-000000000107'
			),
			'message', jsonb_build_object(
				'role', 'assistant',
				'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'Pricing analysis ready for review.'))
			)
		)::text, 'utf8'), 'base64'), E'\n', '')
	), 0,
	'turn',
	(current_setting('qorpera_test.cloud_company_proposal_claim')::jsonb ->> 'turn_id')::uuid,
	'14000000-0000-4000-8000-000000000107'
);
select set_config('qorpera_test.cloud_company_proposal',
	public.qorpera_submit_company_proposal(
		(current_setting('qorpera_test.cloud_company')::jsonb ->> 'environment_id')::uuid,
		'14000000-0000-4000-8000-000000000109',
		(current_setting('qorpera_test.cloud_company_proposal_snapshot')::jsonb ->> 'snapshot_id')::uuid,
		'turn',
		(current_setting('qorpera_test.cloud_company_proposal_claim')::jsonb ->> 'turn_id')::uuid,
		'14000000-0000-4000-8000-000000000107',
		current_setting('qorpera_test.cloud_company_proposal_session')::uuid,
		1, 'policy', 'research.financial-review', 'Review pricing analysis',
		array['14000000-0000-4000-8000-000000000101'::uuid]
	)::text, false);

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.cloud_company_proposal_claim')::jsonb;
	v_proposal jsonb := current_setting('qorpera_test.cloud_company_proposal')::jsonb;
	v_replay jsonb;
	v_page jsonb;
	v_turn_status jsonb;
	v_pending jsonb;
begin
	v_replay := public.qorpera_submit_company_proposal(
		(current_setting('qorpera_test.cloud_company')::jsonb ->> 'environment_id')::uuid,
		'14000000-0000-4000-8000-000000000109',
		(current_setting('qorpera_test.cloud_company_proposal_snapshot')::jsonb ->> 'snapshot_id')::uuid,
		'turn', (v_claim ->> 'turn_id')::uuid,
		'14000000-0000-4000-8000-000000000107',
		current_setting('qorpera_test.cloud_company_proposal_session')::uuid,
		1, 'policy', 'research.financial-review', 'Review pricing analysis',
		array['14000000-0000-4000-8000-000000000101'::uuid]
	);
	if v_replay ->> 'proposal_id' is distinct from v_proposal ->> 'proposal_id' then
		raise exception 'proposal replay after turn transition was not idempotent';
	end if;
	v_turn_status := public.qorpera_get_session_turn_status(
		current_setting('qorpera_test.cloud_company_proposal_session')::uuid,
		(v_claim ->> 'turn_id')::uuid,
		'14000000-0000-4000-8000-000000000107'
	);
	if v_turn_status ->> 'status' is distinct from 'review_pending' then
		raise exception 'review proposal did not preserve the turn in review_pending';
	end if;
	v_pending := public.qorpera_list_session_inputs(
		current_setting('qorpera_test.cloud_company_proposal_session')::uuid,
		0, 10
	);
	if jsonb_array_length(v_pending -> 'items') <> 0 then
		raise exception 'review proposal did not durably consume its queued inputs';
	end if;
	v_page := public.qorpera_list_company_proposals(
		(current_setting('qorpera_test.cloud_company')::jsonb ->> 'environment_id')::uuid,
		'open', null, null, 10
	);
	if jsonb_array_length(v_page -> 'items') <> 1
		or v_page -> 'items' -> 0 ->> 'proposal_id' is distinct from v_proposal ->> 'proposal_id' then
		raise exception 'open proposal was not team-visible: %', v_page;
	end if;
	begin
		perform public.qorpera_publish_company_file_revision(
			(current_setting('qorpera_test.cloud_company')::jsonb ->> 'environment_id')::uuid,
			(current_setting('qorpera_test.cloud_company_proposal_snapshot')::jsonb ->> 'snapshot_id')::uuid,
			(current_setting('qorpera_test.cloud_company_snapshot')::jsonb ->> 'snapshot_id')::uuid
		);
		raise exception 'an open proposal advanced the canonical Company File without review';
	exception when sqlstate '55000' then null;
	end;
end
$$;

reset role;
select set_config(
	'request.jwt.claims',
	'{"sub":"14000000-0000-4000-8000-000000000002","email":"cloud-company-member@example.test","role":"authenticated","user_metadata":{"full_name":"Cloud Company Member"}}',
	false
);
set role authenticated;
select public.qorpera_append_company_proposal_comment(
	(current_setting('qorpera_test.cloud_company_proposal')::jsonb ->> 'proposal_id')::uuid,
	'14000000-0000-4000-8000-000000000110',
	'Please verify the volume assumptions.'
);
do $$
declare
	v_comments jsonb;
begin
	v_comments := public.qorpera_list_company_proposal_comments(
		(current_setting('qorpera_test.cloud_company_proposal')::jsonb ->> 'proposal_id')::uuid,
		null, null, 10
	);
	if v_comments -> 'items' -> 0 ->> 'author_name' is distinct from 'Cloud Company Member' then
		raise exception 'proposal review comment was not shared with the company: %', v_comments;
	end if;
	begin
		perform public.qorpera_accept_company_proposal(
			(current_setting('qorpera_test.cloud_company_proposal')::jsonb ->> 'proposal_id')::uuid,
			(current_setting('qorpera_test.cloud_company_proposal')::jsonb -> 'proposal_snapshot' ->> 'snapshot_id')::uuid
		);
		raise exception 'contributor accepted a Company File proposal without authorize access';
	exception when insufficient_privilege then null;
	end;
end
$$;

reset role;
select set_config(
	'request.jwt.claims',
	'{"sub":"14000000-0000-4000-8000-000000000001","email":"cloud-company-owner@example.test","role":"authenticated","user_metadata":{"full_name":"Cloud Company Owner"}}',
	false
);
set role authenticated;
do $$
declare
	v_accepted jsonb;
	v_file jsonb;
begin
	begin
		perform public.qorpera_accept_company_proposal(
			(current_setting('qorpera_test.cloud_company_proposal')::jsonb ->> 'proposal_id')::uuid,
			'14000000-0000-4000-8000-000000000099'
		);
		raise exception 'stale proposal revision was accepted';
	exception when serialization_failure then null;
	end;
	begin
		perform public.qorpera_reject_company_proposal(
			(current_setting('qorpera_test.cloud_company_proposal')::jsonb ->> 'proposal_id')::uuid,
			'14000000-0000-4000-8000-000000000099'
		);
		raise exception 'stale proposal revision was rejected';
	exception when serialization_failure then null;
	end;
	v_accepted := public.qorpera_accept_company_proposal(
		(current_setting('qorpera_test.cloud_company_proposal')::jsonb ->> 'proposal_id')::uuid,
		(current_setting('qorpera_test.cloud_company_proposal')::jsonb -> 'proposal_snapshot' ->> 'snapshot_id')::uuid
	);
	v_file := public.qorpera_get_company_file(
		(current_setting('qorpera_test.cloud_company')::jsonb ->> 'environment_id')::uuid
	);
	if v_accepted ->> 'status' is distinct from 'accepted'
		or v_file ->> 'head_snapshot_id' is distinct from
			current_setting('qorpera_test.cloud_company_proposal_snapshot')::jsonb ->> 'snapshot_id' then
		raise exception 'authorized proposal acceptance did not CAS the canonical head: %, %', v_accepted, v_file;
	end if;
	begin
		perform public.qorpera_reject_company_proposal(
			(current_setting('qorpera_test.cloud_company_proposal')::jsonb ->> 'proposal_id')::uuid,
			(current_setting('qorpera_test.cloud_company_proposal')::jsonb -> 'proposal_snapshot' ->> 'snapshot_id')::uuid
		);
		raise exception 'accepted proposal was later reported as rejected';
	exception when serialization_failure then null;
	end;
end
$$;

reset role;
select set_config('request.jwt.claims', '', false);

do $$
begin
	if has_function_privilege(
		'authenticated',
		'public.qorpera_create_shared_session_v3(uuid, uuid, text, text, uuid, jsonb)',
		'execute'
	) then
		raise exception 'authenticated clients can bypass revision-pinned session creation';
	end if;
end
$$;

-- The object catalog counts content-addressed bytes once and refuses a new
-- object that would cross the allowance before Storage records it.
update public.qorpera_company_files
set storage_limit_bytes = 261
where environment_id = (current_setting('qorpera_test.cloud_company')::jsonb ->> 'environment_id')::uuid;

insert into storage.objects (bucket_id, name, metadata)
values (
	'qorpera-profile-objects',
	(current_setting('qorpera_test.cloud_company')::jsonb ->> 'profile_id') || '/' || repeat('c', 64),
	'{"size":4}'
);

do $$
declare
	v_blocked boolean := false;
	v_file public.qorpera_company_files%rowtype;
begin
	begin
		insert into storage.objects (bucket_id, name, metadata)
		values (
			'qorpera-profile-objects',
			(current_setting('qorpera_test.cloud_company')::jsonb ->> 'profile_id') || '/' || repeat('d', 64),
			'{"size":2}'
		);
	exception when check_violation then
		v_blocked := true;
	end;
	if not v_blocked then raise exception 'storage quota accepted an over-limit object'; end if;
	select file.* into v_file
	from public.qorpera_company_files as file
	where file.environment_id = (current_setting('qorpera_test.cloud_company')::jsonb ->> 'environment_id')::uuid;
	if v_file.storage_used_bytes <> 260 then
		raise exception 'storage usage counter is %, expected 260', v_file.storage_used_bytes;
	end if;
end
$$;

-- Usage distinguishes the live logical file, retained replayable storage, and
-- physical uploaded storage. An abandoned object becomes reclaimable only
-- after the grace period and under a service-role deletion lease.
do $$
declare
	v_file jsonb;
begin
	v_file := public.qorpera_company_file_json((
		select file from public.qorpera_company_files as file
		where file.environment_id = (current_setting('qorpera_test.cloud_company')::jsonb ->> 'environment_id')::uuid
	));
	if (v_file ->> 'logical_bytes')::bigint <> 4
		or (v_file ->> 'retained_storage_bytes')::bigint <> 256
		or (v_file ->> 'storage_used_bytes')::bigint <> 260 then
		raise exception 'Company File usage layers are inaccurate: %', v_file;
	end if;
end
$$;

update public.qorpera_profile_objects
set created_at = statement_timestamp() - interval '25 hours'
where profile_id = (current_setting('qorpera_test.cloud_company')::jsonb ->> 'profile_id')::uuid
	and sha256 = repeat('c', 64);

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}', false);
set role service_role;

do $$
declare
	v_claim jsonb;
	v_profile_id uuid := (current_setting('qorpera_test.cloud_company')::jsonb ->> 'profile_id')::uuid;
	v_lease_id uuid := '14000000-0000-4000-8000-000000000080';
	v_deleted integer;
begin
	v_claim := public.qorpera_claim_company_object_gc(10, v_lease_id);
	if v_claim ->> 'profile_id' is distinct from v_profile_id::text
		or jsonb_array_length(v_claim -> 'objects') <> 1
		or v_claim -> 'objects' -> 0 ->> 'sha256' is distinct from repeat('c', 64) then
		raise exception 'company object GC did not isolate the abandoned object: %', v_claim;
	end if;
	perform public.qorpera_renew_company_object_gc(v_profile_id, v_lease_id, array[repeat('c', 64)]);
	perform set_config('storage.allow_delete_query', 'true', true);
	delete from storage.objects
	where bucket_id = 'qorpera-profile-objects'
		and name = v_profile_id::text || '/' || repeat('c', 64);
	perform set_config('storage.allow_delete_query', 'false', true);
	v_deleted := public.qorpera_complete_company_object_gc(v_profile_id, v_lease_id, array[repeat('c', 64)]);
	if v_deleted <> 1 then raise exception 'company object GC completion count is %', v_deleted; end if;
end
$$;

reset role;
select set_config('request.jwt.claims', '', false);

do $$
declare
	v_file public.qorpera_company_files%rowtype;
begin
	select file.* into strict v_file
	from public.qorpera_company_files as file
	where file.environment_id = (current_setting('qorpera_test.cloud_company')::jsonb ->> 'environment_id')::uuid;
	if v_file.storage_used_bytes <> 256 then
		raise exception 'company object GC left physical usage at %', v_file.storage_used_bytes;
	end if;
end
$$;

insert into auth.users (id, email, raw_user_meta_data)
values (
	'14000000-0000-4000-8000-000000000002',
	'cloud-company-member@example.test',
	'{"full_name":"Cloud Company Member"}'
) on conflict (id) do nothing;
insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role)
values (
	(current_setting('qorpera_test.cloud_company')::jsonb ->> 'profile_id')::uuid,
	'14000000-0000-4000-8000-000000000002',
	'cloud-company-member@example.test', 'Cloud Company Member', 'contributor'
) on conflict (profile_id, user_id) do nothing;

select set_config(
	'request.jwt.claims',
	'{"sub":"14000000-0000-4000-8000-000000000001","email":"cloud-company-owner@example.test","role":"authenticated","user_metadata":{"full_name":"Cloud Company Owner"}}',
	false
);
set role authenticated;
select public.qorpera_register_presence_device(
	(current_setting('qorpera_test.cloud_company')::jsonb ->> 'profile_id')::uuid,
	'14000000-0000-4000-8000-000000000090',
	repeat('A', 44)
);
reset role;

select set_config(
	'request.jwt.claims',
	'{"sub":"14000000-0000-4000-8000-000000000002","email":"cloud-company-member@example.test","role":"authenticated","user_metadata":{"full_name":"Cloud Company Member"}}',
	false
);
set role authenticated;

do $$
declare
	v_rejected boolean := false;
	v_devices jsonb;
begin
	begin
		perform public.qorpera_register_presence_device(
			(current_setting('qorpera_test.cloud_company')::jsonb ->> 'profile_id')::uuid,
			'14000000-0000-4000-8000-000000000090',
			repeat('B', 44)
		);
	exception when unique_violation then v_rejected := true;
	end;
	if not v_rejected then raise exception 'active presence device identity was reassigned'; end if;
	v_devices := public.qorpera_list_presence_devices(
		(current_setting('qorpera_test.cloud_company')::jsonb ->> 'profile_id')::uuid,
		array['14000000-0000-4000-8000-000000000090'::uuid]
	);
	if v_devices -> 0 ->> 'user_id' is distinct from '14000000-0000-4000-8000-000000000001'
		or v_devices -> 0 ->> 'name' is distinct from 'Cloud Company Owner'
		or v_devices -> 0 ->> 'public_key' is distinct from repeat('A', 44) then
		raise exception 'presence identity was not resolved from membership: %', v_devices;
	end if;
end
$$;

reset role;
select set_config('request.jwt.claims', '', false);
