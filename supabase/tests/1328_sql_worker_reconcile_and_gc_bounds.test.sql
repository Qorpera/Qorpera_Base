begin;

create function pg_temp.assert_1328(p_ok boolean, p_message text) returns void language plpgsql as $$
begin
	if p_ok is distinct from true then
		raise exception '1328 assertion failed: %', p_message;
	end if;
end
$$;

do $$
declare
	v_def text;
begin
	perform pg_temp.assert_1328(
		(select relrowsecurity from pg_class where oid = 'public.qorpera_deleted_profile_object_gc_queue'::regclass),
		'qorpera_deleted_profile_object_gc_queue must enable RLS'
	);
	perform pg_temp.assert_1328(
		not has_table_privilege('anon', 'public.qorpera_deleted_profile_object_gc_queue', 'SELECT')
			and not has_table_privilege('authenticated', 'public.qorpera_deleted_profile_object_gc_queue', 'SELECT')
			and not has_table_privilege('service_role', 'public.qorpera_deleted_profile_object_gc_queue', 'SELECT')
			and not has_table_privilege('service_role', 'public.qorpera_deleted_profile_object_gc_queue', 'INSERT'),
		'qorpera_deleted_profile_object_gc_queue must revoke API role privileges'
	);

	perform pg_temp.assert_1328(
		not has_function_privilege('anon', 'public.qorpera_enqueue_deleted_profile_object_gc_on_profile_delete()', 'EXECUTE')
			and not has_function_privilege('authenticated', 'public.qorpera_enqueue_deleted_profile_object_gc_on_profile_delete()', 'EXECUTE')
			and not has_function_privilege('service_role', 'public.qorpera_enqueue_deleted_profile_object_gc_on_profile_delete()', 'EXECUTE')
			and not has_function_privilege('anon', 'public.qorpera_enqueue_deleted_profile_object_gc_on_object_insert()', 'EXECUTE')
			and not has_function_privilege('authenticated', 'public.qorpera_enqueue_deleted_profile_object_gc_on_object_insert()', 'EXECUTE')
			and not has_function_privilege('service_role', 'public.qorpera_enqueue_deleted_profile_object_gc_on_object_insert()', 'EXECUTE'),
		'new GC queue trigger functions must revoke EXECUTE from all API roles'
	);

	perform pg_temp.assert_1328(
		to_regclass('public.qorpera_deleted_profile_object_gc_queue_order') is not null
			and to_regclass('public.qorpera_folder_object_gc_due_order') is not null,
		'new queue and folder GC indexes must exist'
	);

	perform pg_temp.assert_1328(
		(select proconfig @> array['search_path=""', 'lock_timeout=2s']
			from pg_proc where oid = 'public.qorpera_folder_claim_object_gc(integer,uuid)'::regprocedure)
			and (select proconfig @> array['search_path=""', 'lock_timeout=2s']
				from pg_proc where oid = 'public.qorpera_claim_company_mail(integer,uuid)'::regprocedure)
			and (select proconfig @> array['search_path=""', 'lock_timeout=1s']
				from pg_proc where oid = 'public.qorpera_site_count_upkeep(timestamptz)'::regprocedure)
			and (select proconfig @> array['search_path=""', 'lock_timeout=1s']
				from pg_proc where oid = 'public.qorpera_order_upkeep(timestamptz)'::regprocedure),
		'patched RPC proconfig search_path and lock_timeout settings must be preserved'
	);

	v_def := pg_get_functiondef('public.qorpera_reconcile_runner_orchestrator_without_sponsored_turns(uuid)'::regprocedure);
	perform pg_temp.assert_1328(
		position('qorpera_runner_model_requests_reserved_expiry' in v_def) > 0
			and position('join public.qorpera_runner_jobs as req_job on req_job.id = request.job_id' in v_def) > 0
			and position('qorpera_computer_hour_finish_window_over' in v_def) > 0
			and position('with doomed as materialized' in v_def) > 0
			and position('limit 100' in v_def) > 0
			and position('for update of candidate skip locked' in v_def) > 0
			and position('for update of job skip locked' in v_def) > 0
			and position('limit 200' in v_def) > 0,
		'reconcile_runner_orchestrator must preserve prior patches and bound all sweeps'
	);

	v_def := pg_get_functiondef('public.qorpera_claim_company_mail(integer,uuid)'::regprocedure);
	perform pg_temp.assert_1328(
		position('qorpera_mail_threads' in v_def) > 0
			and position('with doomed as materialized' in v_def) > 0
			and position('limit 500' in v_def) > 0
			and position('for update of candidate skip locked' in v_def) > 0
			and position('for update of mail skip locked' in v_def) > 0,
		'qorpera_claim_company_mail must preserve thread cleanup, bound sweeps, and guard candidates'
	);

	v_def := pg_get_functiondef('public.qorpera_claim_computer_hour_notices(integer,uuid)'::regprocedure);
	perform pg_temp.assert_1328(
		position('qorpera_computer_hour_zero_occasion' in v_def) > 0
			and position('for update of open_notice skip locked' in v_def) > 0
			and position('for update of candidate skip locked' in v_def) > 0
			and position('for update of notice skip locked' in v_def) > 0,
		'qorpera_claim_computer_hour_notices must preserve zero-state patches, bound sweeps, and guard candidates'
	);

	v_def := pg_get_functiondef('public.qorpera_complete_deleted_profile_object_gc(uuid,uuid,text[])'::regprocedure);
	perform pg_temp.assert_1328(
		position('from public.qorpera_deleted_profile_object_gc_queue' in v_def) > 0
			and position('for update;' in v_def) > 0,
		'qorpera_complete_deleted_profile_object_gc must lock queue row before deleting'
	);
end
$$;

do $$
declare
	v_user uuid := '13280000-0000-4000-8000-000000000001';
	v_empty_profile uuid := '13280000-0000-4000-8000-000000000010';
	v_obj_profile uuid := '13280000-0000-4000-8000-000000000011';
	v_late_profile uuid := '13280000-0000-4000-8000-000000000012';
	v_lease uuid := '13280000-0000-4000-8000-000000000020';
	v_sha_a text := repeat('a', 64);
	v_sha_b text := repeat('b', 64);
	v_sha_c text := repeat('c', 64);
	v_claim jsonb;
	v_plan text := '';
	v_line text;
	v_remaining_leases integer;
	v_older_queued timestamptz;
begin
	insert into auth.users (id, email) values (v_user, 'u1328@example.test');
	insert into public.qorpera_profiles (id, name, created_by_user_id) values
		(v_empty_profile, 'Empty 1328', v_user),
		(v_obj_profile, 'Objects 1328', v_user);

	insert into public.qorpera_profile_objects (profile_id, sha256, bytes, backend)
	values (v_obj_profile, v_sha_a, 128, 'nas-object-gateway');

	delete from public.qorpera_deleted_profile_object_gc_queue;
	delete from public.qorpera_deleted_profile_object_gc_leases;

	delete from public.qorpera_profiles where id = v_empty_profile;
	perform pg_temp.assert_1328(
		exists (select 1 from public.qorpera_deleted_profile_object_gc_queue where profile_id = v_empty_profile),
		'deleting a profile must enqueue it in qorpera_deleted_profile_object_gc_queue'
	);

	update public.qorpera_deleted_profile_object_gc_queue
	set queued_at = statement_timestamp() - interval '2 minutes'
	where profile_id = v_empty_profile;

	delete from public.qorpera_profiles where id = v_obj_profile;
	perform pg_temp.assert_1328(
		exists (select 1 from public.qorpera_deleted_profile_object_gc_queue where profile_id = v_obj_profile),
		'deleting a profile with objects must enqueue it'
	);

	insert into public.qorpera_profile_objects (profile_id, sha256, bytes, backend)
	values (v_late_profile, v_sha_b, 64, 'nas-object-gateway');
	perform pg_temp.assert_1328(
		exists (select 1 from public.qorpera_deleted_profile_object_gc_queue where profile_id = v_late_profile),
		'inserting an orphaned profile_object must enqueue its profile_id'
	);

	insert into public.qorpera_profile_objects (profile_id, sha256, bytes, backend, created_at)
	values (v_late_profile, v_sha_c, 64, 'nas-object-gateway', statement_timestamp() - interval '10 minutes');
	select queued_at into v_older_queued from public.qorpera_deleted_profile_object_gc_queue where profile_id = v_late_profile;
	perform pg_temp.assert_1328(
		v_older_queued <= statement_timestamp() - interval '9 minutes',
		'trigger ON CONFLICT DO UPDATE must touch existing queue row and preserve oldest queued_at'
	);

	insert into public.qorpera_deleted_profile_object_gc_leases (profile_id, lease_id, lease_expires_at)
	select extensions.gen_random_uuid(), extensions.gen_random_uuid(), statement_timestamp() - interval '1 hour'
	from generate_series(1, 105);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	v_claim := public.qorpera_claim_deleted_profile_object_gc(10, v_lease);
	perform pg_temp.assert_1328(
		v_claim ->> 'profile_id' = v_late_profile::text
			and jsonb_array_length(v_claim -> 'objects') = 2,
		'claim must order by oldest queued_at first: ' || coalesce(v_claim::text, 'null')
	);
	delete from public.qorpera_profile_objects where profile_id = v_late_profile;
	perform public.qorpera_complete_deleted_profile_object_gc(v_late_profile, v_lease, array[v_sha_b, v_sha_c]);
	perform pg_temp.assert_1328(
		not exists (select 1 from public.qorpera_deleted_profile_object_gc_queue where profile_id = v_late_profile),
		'completing the final batch must dequeue the deleted profile'
	);

	v_claim := public.qorpera_claim_deleted_profile_object_gc(10, '13280000-0000-4000-8000-000000000021');
	perform pg_temp.assert_1328(
		v_claim ->> 'profile_id' = v_obj_profile::text
			and jsonb_array_length(v_claim -> 'objects') = 1,
		'claim must drain empty queue row first and claim next orphaned profile: ' || coalesce(v_claim::text, 'null')
	);
	perform pg_temp.assert_1328(
		not exists (select 1 from public.qorpera_deleted_profile_object_gc_queue where profile_id = v_empty_profile),
		'claiming past an empty deleted profile must remove its queue row'
	);
	select count(*) into v_remaining_leases
	from public.qorpera_deleted_profile_object_gc_leases
	where lease_expires_at <= statement_timestamp();
	perform pg_temp.assert_1328(
		v_remaining_leases = 0,
		'second claim call must drain remaining 5 expired leases, remaining=' || v_remaining_leases
	);

	insert into public.qorpera_deleted_profile_object_gc_leases (profile_id, lease_id, lease_expires_at)
	select extensions.gen_random_uuid(), extensions.gen_random_uuid(), statement_timestamp() - interval '1 hour'
	from generate_series(1, 105);
	perform public.qorpera_claim_deleted_profile_object_gc(10, '13280000-0000-4000-8000-000000000022');
	select count(*) into v_remaining_leases
	from public.qorpera_deleted_profile_object_gc_leases
	where lease_expires_at <= statement_timestamp();
	perform pg_temp.assert_1328(
		v_remaining_leases = 5,
		'expired deleted-profile GC lease cleanup must cap at 100 per call, remaining=' || v_remaining_leases
	);

	perform set_config('enable_seqscan', 'off', true);
	for v_line in execute $q$
		explain select queue.profile_id
		from public.qorpera_deleted_profile_object_gc_queue as queue
		where not exists (select 1 from public.qorpera_profiles as profile where profile.id = queue.profile_id)
			and not exists (select 1 from public.qorpera_deleted_profile_object_gc_leases as lease where lease.profile_id = queue.profile_id)
		order by queue.queued_at, queue.profile_id
		limit 100
	$q$ loop
		v_plan := v_plan || E'\n' || v_line;
	end loop;
	perform pg_temp.assert_1328(
		position('qorpera_deleted_profile_object_gc_queue_order' in v_plan) > 0,
		'deleted-profile GC queue scan should use qorpera_deleted_profile_object_gc_queue_order: ' || v_plan
	);
end
$$;

do $$
declare
	v_plan text := '';
	v_line text;
	v_cutoff timestamptz := clock_timestamp() - interval '24 hours';
	v_empty jsonb;
begin
	perform set_config('enable_seqscan', 'off', true);
	for v_line in execute format($q$
		explain select g.profile_id, g.sha256
		from public.qorpera_folder_object_gc g
		where g.unreferenced_since <= %L::timestamptz
		order by g.unreferenced_since, g.profile_id, g.sha256 collate "C"
		limit 40
	$q$, v_cutoff) loop
		v_plan := v_plan || E'\n' || v_line;
	end loop;
	perform pg_temp.assert_1328(
		position('qorpera_folder_object_gc_due_order' in v_plan) > 0,
		'folder GC due candidate query should use qorpera_folder_object_gc_due_order: ' || v_plan
	);
	perform set_config('enable_seqscan', 'on', true);

	delete from public.qorpera_folder_object_gc;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	v_empty := public.qorpera_folder_claim_object_gc(10, '13280000-0000-4000-8000-000000000030');
	perform pg_temp.assert_1328(
		v_empty ->> 'schema' = 'qorpera.folder-object-gc-claim/v1'
			and v_empty -> 'objects' = '[]'::jsonb,
		'empty folder GC claim must return empty jsonb array: ' || coalesce(v_empty::text, 'null')
	);
end
$$;

do $$
declare
	v_user uuid := '13280000-0000-4000-8000-000000000040';
	v_profile uuid := '13280000-0000-4000-8000-000000000041';
	v_remaining integer;
begin
	insert into auth.users (id, email) values (v_user, 'inv1328@example.test');
	insert into public.qorpera_profiles (id, name, created_by_user_id) values (v_profile, 'Inv 1328', v_user);
	insert into public.qorpera_profile_invitations (profile_id, email, role, invited_by_user_id, expires_at)
	select v_profile, 'exp-' || i || '@example.test', 'contributor', v_user, statement_timestamp() - interval '1 hour'
	from generate_series(1, 205) as i;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	perform public.qorpera_claim_profile_invitation_deliveries(10, '13280000-0000-4000-8000-000000000042');

	select count(*) into v_remaining
	from public.qorpera_profile_invitations
	where profile_id = v_profile;
	perform pg_temp.assert_1328(
		v_remaining = 5,
		'expired invitation cleanup must cap at 200 per claim call, remaining=' || v_remaining
	);
end
$$;

do $$
declare
	v_user uuid := '13280000-0000-4000-8000-000000000080';
	v_profile uuid := '13280000-0000-4000-8000-000000000081';
	v_env uuid := '13280000-0000-4000-8000-000000000082';
	v_hook_active uuid := '13280000-0000-4000-8000-000000000083';
	v_hook_paused uuid := '13280000-0000-4000-8000-000000000084';
	v_box_active uuid := '13280000-0000-4000-8000-000000000085';
	v_box_paused uuid := '13280000-0000-4000-8000-000000000086';
	v_fresh_mail uuid := '13280000-0000-4000-8000-000000000087';
	v_agent uuid := '13280000-0000-4000-8000-000000000088';
	v_claimed jsonb;
	v_failed integer;
	v_stale_left integer;
	v_cancelled integer;
	v_paused_left integer;
begin
	insert into auth.users (id, email) values (v_user, 'mail1328@example.test');
	insert into public.qorpera_profiles (id, name, created_by_user_id) values (v_profile, 'Mail 1328', v_user);
	insert into public.qorpera_company_environments (id, profile_id, name, contract_version, created_by_user_id)
	values (v_env, v_profile, 'production', 1, v_user);

	update public.qorpera_mail_settings set enabled = true, sending = true, domain = 'inbox1328.example.test';
	delete from public.qorpera_company_mail_outbox where status in ('pending', 'retrying', 'delivering');

	insert into public.qorpera_event_hooks (id, profile_id, environment_id, name, purpose, proof, address, status, created_by_user_id) values
		(v_hook_active, v_profile, v_env, 'mail-a', 'active mailbox', 'mail', repeat('a', 43), 'active', v_user),
		(v_hook_paused, v_profile, v_env, 'mail-p', 'paused mailbox', 'mail', repeat('b', 43), 'paused', v_user);
	insert into public.qorpera_company_mailboxes (id, hook_id, profile_id, environment_id, local_part, created_by_user_id) values
		(v_box_active, v_hook_active, v_profile, v_env, 'active1328', v_user),
		(v_box_paused, v_hook_paused, v_profile, v_env, 'paused1328', v_user);

	insert into public.qorpera_company_mail_outbox (
		thread, profile_id, environment_id, mailbox_id, run_id, call_id, staff_agent_id,
		from_name, recipients_to, subject, body, status, next_attempt_at, created_at
	)
	select public.qorpera_mail_thread_id(v_box_active, 'stale:' || i),
		v_profile, v_env, v_box_active, extensions.gen_random_uuid(), 'stale-' || i, v_agent,
		'Agent at Mail 1328', array['dest@example.test'], 'Stale ' || i, 'Body', 'pending',
		clock_timestamp() - interval '2 days', clock_timestamp() - interval '2 days'
	from generate_series(1, 205) as i;

	insert into public.qorpera_company_mail_outbox (
		id, thread, profile_id, environment_id, mailbox_id, run_id, call_id, staff_agent_id,
		from_name, recipients_to, subject, body, status, next_attempt_at, created_at
	) values (
		v_fresh_mail, public.qorpera_mail_thread_id(v_box_active, 'fresh:1'),
		v_profile, v_env, v_box_active, extensions.gen_random_uuid(), 'fresh-1', v_agent,
		'Agent at Mail 1328', array['dest@example.test'], 'Fresh', 'Body', 'pending',
		clock_timestamp() - interval '1 minute', clock_timestamp()
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	v_claimed := public.qorpera_claim_company_mail(50, '13280000-0000-4000-8000-000000000089');
	select count(*) filter (where status = 'failed'), count(*) filter (where status = 'pending')
	into v_failed, v_stale_left
	from public.qorpera_company_mail_outbox
	where mailbox_id = v_box_active and id <> v_fresh_mail;
	perform pg_temp.assert_1328(
		jsonb_array_length(v_claimed) = 1
			and v_claimed #>> '{0,mailId}' = v_fresh_mail::text
			and v_failed = 200
			and v_stale_left = 5,
		'mail claim must cap fail sweep at 200 and never claim excess stale rows: claimed=' || v_claimed::text
			|| ' failed=' || v_failed || ' left=' || v_stale_left
	);

	insert into public.qorpera_company_mail_outbox (
		thread, profile_id, environment_id, mailbox_id, run_id, call_id, staff_agent_id,
		from_name, recipients_to, subject, body, status, next_attempt_at, created_at
	)
	select public.qorpera_mail_thread_id(v_box_paused, 'paused:' || i),
		v_profile, v_env, v_box_paused, extensions.gen_random_uuid(), 'paused-' || i, v_agent,
		'Agent at Mail 1328', array['dest@example.test'], 'Paused ' || i, 'Body', 'pending',
		clock_timestamp() - interval '1 minute', clock_timestamp()
	from generate_series(1, 205) as i;

	v_claimed := public.qorpera_claim_company_mail(50, '13280000-0000-4000-8000-00000000008a');
	select count(*) filter (where status = 'cancelled'), count(*) filter (where status = 'pending')
	into v_cancelled, v_paused_left
	from public.qorpera_company_mail_outbox
	where mailbox_id = v_box_paused;
	perform pg_temp.assert_1328(
		jsonb_array_length(v_claimed) = 0
			and v_cancelled = 200
			and v_paused_left = 5,
		'mail claim must cap cancel sweep at 200 and never claim excess paused-mailbox rows: claimed=' || v_claimed::text
			|| ' cancelled=' || v_cancelled || ' left=' || v_paused_left
	);
end
$$;

do $$
declare
	v_user_no_email uuid := '13280000-0000-4000-8000-000000000090';
	v_user_ok uuid := '13280000-0000-4000-8000-000000000091';
	v_claimed jsonb;
	v_failed integer;
	v_left integer;
begin
	insert into auth.users (id, email) values
		(v_user_no_email, ''),
		(v_user_ok, 'notice-ok-1328@example.test');
	delete from public.qorpera_computer_hour_notices where status in ('pending', 'retrying', 'delivering');

	insert into public.qorpera_computer_hour_notices (kind, profile_id, user_id, occasion, details, status, next_attempt_at)
	select 'monthly_summary', null, v_user_no_email, 'summary-1328-' || i, '{}'::jsonb, 'pending',
		clock_timestamp() - interval '5 minutes'
	from generate_series(1, 205) as i;

	insert into public.qorpera_computer_hour_notices (kind, profile_id, user_id, occasion, details, status, next_attempt_at)
	values ('monthly_summary', null, v_user_ok, 'summary-1328-ok', '{}'::jsonb, 'pending', clock_timestamp() - interval '1 minute');

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	v_claimed := public.qorpera_claim_computer_hour_notices(50, '13280000-0000-4000-8000-000000000092');
	select count(*) filter (where status = 'failed'), count(*) filter (where status = 'pending')
	into v_failed, v_left
	from public.qorpera_computer_hour_notices
	where user_id = v_user_no_email;
	perform pg_temp.assert_1328(
		jsonb_array_length(v_claimed) = 1
			and v_claimed #>> '{0,recipientEmail}' = 'notice-ok-1328@example.test'
			and v_failed = 200
			and v_left = 5,
		'notice claim must cap ineligible sweep at 200 and never claim excess ineligible notices: claimed=' || v_claimed::text
			|| ' failed=' || v_failed || ' left=' || v_left
	);
end
$$;

do $$
declare
	v_user_a uuid := '13280000-0000-4000-8000-000000000050';
	v_user_b uuid := '13280000-0000-4000-8000-000000000051';
	v_profile uuid := '13280000-0000-4000-8000-000000000052';
	v_env uuid := '13280000-0000-4000-8000-000000000053';
	v_agent uuid := '13280000-0000-4000-8000-000000000054';
	v_node_id uuid := '13280000-0000-4000-8000-000000000055';
	v_node_sha text := repeat('5', 64);
	v_setup text := repeat('e', 64);
	v_policy jsonb := jsonb_build_object('providerPolicySha256', repeat('d', 64));
	v_m_live uuid := '13280000-0000-4000-8000-000000000056';
	v_m_keep uuid := '13280000-0000-4000-8000-000000000057';
	v_m_other uuid := '13280000-0000-4000-8000-000000000058';
	v_w_live uuid := '13280000-0000-4000-8000-000000000059';
	v_w_keep uuid := '13280000-0000-4000-8000-00000000005a';
	v_w_arch uuid := '13280000-0000-4000-8000-00000000005b';
	v_tok uuid := '13280000-0000-4000-8000-00000000005c';
	v_list jsonb;
	v_e_live jsonb;
	v_e_keep jsonb;
	v_e_other jsonb;
begin
	insert into auth.users (id, email) values
		(v_user_a, 'code-a-1328@example.test'),
		(v_user_b, 'code-b-1328@example.test');
	insert into public.qorpera_profiles (id, name, created_by_user_id) values (v_profile, 'Code 1328', v_user_a);
	insert into public.qorpera_company_environments (id, profile_id, name, contract_version, created_by_user_id)
	values (v_env, v_profile, 'production', 1, v_user_a);
	insert into public.qorpera_coding_executors (
		environment_id, owner, enabled, vm_policy, nas_machine_id_sha256,
		machine_sleep_after_seconds, machine_remove_after_seconds
	) values (v_env, 'exec-1328', true, v_policy, v_node_sha, 600, 600);

	set local session_replication_role = replica;
	insert into public.qorpera_coding_machines (
		id, kind, profile_id, environment_id, member_user_id, staff_agent_id, repository, setup_digest,
		owner, machine_id_sha256, binding, last_used_at, created_at
	) values
		(v_m_live, 'member', v_profile, v_env, v_user_a, v_agent, 'acme/live', v_setup,
			'exec-1328', v_node_sha, v_policy, clock_timestamp() - interval '2 hours', clock_timestamp() - interval '3 hours'),
		(v_m_keep, 'member', v_profile, v_env, v_user_b, v_agent, 'acme/keep', v_setup,
			'exec-1328', v_node_sha, v_policy, clock_timestamp() - interval '2 hours', clock_timestamp() - interval '2 hours'),
		(v_m_other, 'member', v_profile, v_env, v_user_b, v_agent, 'acme/other', v_setup,
			'exec-1328', v_node_sha, v_policy, clock_timestamp() - interval '2 hours', clock_timestamp() - interval '1 hour');

	insert into public.qorpera_runtime_node_demands (
		allocation_id, node_id, provider_kind, provider_id, policy_sha256, cpu_millis, memory_bytes, reserved_at, suspended_at
	) values
		(v_m_live, v_node_id, 'coding', 'lxd', repeat('d', 64), 2000, 4294967296, clock_timestamp() - interval '2 hours', null),
		(v_m_keep, v_node_id, 'coding', 'lxd', repeat('d', 64), 2000, 4294967296, clock_timestamp() - interval '2 hours', clock_timestamp() - interval '2 hours'),
		(v_m_other, v_node_id, 'coding', 'lxd', repeat('d', 64), 2000, 4294967296, clock_timestamp() - interval '2 hours', clock_timestamp() - interval '2 hours');

	insert into public.qorpera_coding_sessions (
		worker_id, profile_id, environment_id, harness, repository, branch, phase,
		lease_owner, lease_token, lease_until, vm_allocation_id, attached_machine_id, attachment_token, attachment_until, attachment_turn, attached_at, archived_at, archived_by
	) values
		(v_w_live, v_profile, v_env, 'codex', '{"host":"github.com","owner":"acme","name":"live","baseBranch":"main"}'::jsonb,
			'b-live-1328', 'running', 'exec-1328', extensions.gen_random_uuid(), clock_timestamp() + interval '5 minutes',
			v_m_live, v_m_live, v_tok, clock_timestamp() + interval '5 minutes', 1, clock_timestamp(), null, null),
		(v_w_keep, v_profile, v_env, 'codex', '{"host":"github.com","owner":"acme","name":"keep","baseBranch":"main"}'::jsonb,
			'b-keep-1328', 'awaiting_input', null, null, null,
			v_m_keep, null, null, null, null, null, null, null),
		(v_w_arch, v_profile, v_env, 'codex', '{"host":"github.com","owner":"acme","name":"other","baseBranch":"main"}'::jsonb,
			'b-other-1328', 'completed', null, null, null,
			v_m_other, null, null, null, null, null, clock_timestamp() - interval '3 hours', 'kernel');
	set local session_replication_role = origin;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	v_list := public.qorpera_list_coding_machines('exec-1328', v_node_sha);
	perform pg_temp.assert_1328(jsonb_array_length(v_list) = 3, 'expected 3 coding machines: ' || v_list::text);

	select e into v_e_live from jsonb_array_elements(v_list) e where e ->> 'machineId' = v_m_live::text;
	select e into v_e_keep from jsonb_array_elements(v_list) e where e ->> 'machineId' = v_m_keep::text;
	select e into v_e_other from jsonb_array_elements(v_list) e where e ->> 'machineId' = v_m_other::text;

	perform pg_temp.assert_1328(
		(v_e_live ->> 'live')::boolean = true
			and (v_e_live ->> 'sleepDue')::boolean = false
			and jsonb_array_length(v_e_live -> 'attached') = 1
			and v_e_live #>> '{attached,0,workerId}' = v_w_live::text
			and v_e_live #>> '{attached,0,attachmentToken}' = v_tok::text,
		'live/attached machine state mismatch: ' || coalesce(v_e_live::text, 'null')
	);
	perform pg_temp.assert_1328(
		(v_e_keep ->> 'live')::boolean = false
			and (v_e_keep ->> 'removeDue')::boolean = false,
		'sleeping machine with its own open session must not be removeDue: ' || coalesce(v_e_keep::text, 'null')
	);
	perform pg_temp.assert_1328(
		(v_e_other ->> 'live')::boolean = false
			and (v_e_other ->> 'removeDue')::boolean = true,
		'sleeping machine with no open session of its own must be removeDue even when same member has another open machine: '
			|| coalesce(v_e_other::text, 'null')
	);
end
$$;

do $$
declare
	v_user uuid := '13280000-0000-4000-8000-000000000060';
	v_profile uuid := '13280000-0000-4000-8000-000000000061';
	v_env uuid := '13280000-0000-4000-8000-000000000062';
	v_site uuid := '13280000-0000-4000-8000-000000000063';
	v_agent uuid := '13280000-0000-4000-8000-000000000064';
	v_old_hour timestamptz := date_trunc('hour', clock_timestamp() - interval '60 days', 'UTC');
	v_site_res jsonb;
	v_order_res jsonb;
	v_rem_hours integer;
	v_rem_orders integer;
begin
	insert into auth.users (id, email) values (v_user, 'upkeep1328@example.test');
	insert into public.qorpera_profiles (id, name, created_by_user_id) values (v_profile, 'Upkeep 1328', v_user);
	insert into public.qorpera_company_environments (id, profile_id, name, contract_version, created_by_user_id)
	values (v_env, v_profile, 'production', 1, v_user);
	insert into public.qorpera_company_sites (id, profile_id, environment_id, slug, source_path, created_by_staff_agent_id)
	values (v_site, v_profile, v_env, 'site-upkeep-1328', '/site', v_agent);

	update public.qorpera_site_count_upkeep set rolled_until = date_trunc('hour', clock_timestamp() - interval '1 hour', 'UTC');
	delete from public.qorpera_site_counts where hour < clock_timestamp() - interval '35 days';
	insert into public.qorpera_site_counts (site_id, hour, path, views, visits)
	select v_site, v_old_hour, 'p/' || i || '.html', 1, 1
	from generate_series(1, 5005) as i;

	v_site_res := public.qorpera_site_count_upkeep();
	select count(*) into v_rem_hours from public.qorpera_site_counts where site_id = v_site;
	perform pg_temp.assert_1328(
		(v_site_res ->> 'hoursDeleted')::integer = 5000 and v_rem_hours = 5,
		'qorpera_site_count_upkeep must cap hour deletion at 5000 per run: res=' || v_site_res::text || ' rem=' || v_rem_hours
	);

	delete from public.qorpera_orders where rolled and coalesce(ordered_at, made_at) < clock_timestamp() - interval '400 days';
	insert into public.qorpera_orders (
		profile_id, environment_id, source, live, ref_sha256, ordered_at, currency, amount_minor,
		state, state_at, state_by, made_at, changed_at, rolled, rolled_day, rolled_currency, rolled_orders, rolled_sales_minor
	)
	select v_profile, v_env, 'added', true, lpad(to_hex(i), 64, '0'),
		clock_timestamp() - interval '450 days', 'usd', 100,
		'paid', clock_timestamp() - interval '450 days', 'member',
		clock_timestamp() - interval '450 days', clock_timestamp() - interval '450 days',
		true, (clock_timestamp() - interval '450 days')::date, 'usd', 1, 100
	from generate_series(1, 5005) as i;

	v_order_res := public.qorpera_order_upkeep();
	select count(*) into v_rem_orders from public.qorpera_orders where profile_id = v_profile;
	perform pg_temp.assert_1328(
		(v_order_res ->> 'deleted')::integer = 5000 and v_rem_orders = 5,
		'qorpera_order_upkeep must cap retention deletion at 5000 per run: res=' || v_order_res::text || ' rem=' || v_rem_orders
	);
end
$$;

rollback;

do $$
declare
	v_user uuid := '13280000-0000-4000-8000-000000000070';
	v_company jsonb;
	v_profile uuid;
	v_env uuid;
	v_inv_locked uuid := '13280000-0000-4000-8000-000000000072';
	v_inv_free uuid := '13280000-0000-4000-8000-000000000073';
	v_sha_leased text := repeat('0', 64);
	v_sha_rooted text := '05' || repeat('5', 62);
	v_sha_locked text := '09' || repeat('9', 62);
	v_sha_a text := '11' || repeat('1', 62);
	v_sha_b text := '22' || repeat('2', 62);
begin
	insert into auth.users (id, email) values (v_user, 'dblink1328@example.test');
	v_company := public.qorpera_folder_company_open(v_user, '13280000-0000-4000-8000-000000000071', 'Dblink 1328');
	v_profile := (v_company ->> 'profile_id')::uuid;
	v_env := (v_company ->> 'environment_id')::uuid;
	perform set_config('qorpera_test.p1328_profile', v_profile::text, false);
	perform set_config('qorpera_test.p1328_env', v_env::text, false);

	insert into public.qorpera_profile_invitations (id, profile_id, email, role, invited_by_user_id, expires_at) values
		(v_inv_locked, v_profile, 'locked-1328@example.test', 'contributor', v_user, statement_timestamp() - interval '2 hours'),
		(v_inv_free, v_profile, 'free-1328@example.test', 'contributor', v_user, statement_timestamp() - interval '1 hour');

	insert into public.qorpera_profile_objects (profile_id, sha256, bytes, backend) values
		(v_profile, v_sha_leased, 10, 'nas-object-gateway'),
		(v_profile, v_sha_rooted, 10, 'nas-object-gateway'),
		(v_profile, v_sha_locked, 10, 'nas-object-gateway'),
		(v_profile, v_sha_a, 10, 'nas-object-gateway'),
		(v_profile, v_sha_b, 10, 'nas-object-gateway');

	set local session_replication_role = replica;
	insert into public.qorpera_folder_entries (
		environment_id, path, kind, version, commit_id, manifest_sha256, file_sha256, bytes, media_type, executable
	) values (
		v_env, 'rooted-1328.txt', 'file', extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		v_sha_rooted, v_sha_rooted, 10, 'text/plain', false
	);
	set local session_replication_role = origin;

	insert into public.qorpera_folder_object_gc (profile_id, sha256, unreferenced_since, lease_id, lease_expires_at) values
		(v_profile, v_sha_leased, clock_timestamp() - interval '48 hours', '13280000-0000-4000-8000-000000000075', clock_timestamp() + interval '5 minutes'),
		(v_profile, v_sha_rooted, clock_timestamp() - interval '48 hours', null, null),
		(v_profile, v_sha_locked, clock_timestamp() - interval '48 hours', null, null),
		(v_profile, v_sha_a, clock_timestamp() - interval '47 hours', null, null),
		(v_profile, v_sha_b, clock_timestamp() - interval '48 hours', null, null);
end
$$;

select dblink_connect('r1328_hold', 'dbname=' || current_database());
select dblink_exec('r1328_hold', 'begin');
select * from dblink('r1328_hold',
	$$select id from public.qorpera_profile_invitations where id = '13280000-0000-4000-8000-000000000072' for update$$
) as t(id uuid);
select * from dblink('r1328_hold',
	format(
		$$select sha256 from public.qorpera_folder_object_gc where profile_id = %L and sha256 = %L for update$$,
		current_setting('qorpera_test.p1328_profile'),
		'09' || repeat('9', 62)
	)
) as t(sha256 text);

do $$
declare
	v_profile uuid := current_setting('qorpera_test.p1328_profile')::uuid;
	v_claim jsonb;
	v_sha_leased text := repeat('0', 64);
	v_sha_rooted text := '05' || repeat('5', 62);
	v_sha_locked text := '09' || repeat('9', 62);
	v_sha_a text := '11' || repeat('1', 62);
	v_sha_b text := '22' || repeat('2', 62);
begin
	perform set_config('lock_timeout', '500ms', true);
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

	perform public.qorpera_claim_profile_invitation_deliveries(10, '13280000-0000-4000-8000-000000000074');
	if not exists (select 1 from public.qorpera_profile_invitations where id = '13280000-0000-4000-8000-000000000072') then
		raise exception '1328: locked expired invitation should have been skipped';
	end if;
	if exists (select 1 from public.qorpera_profile_invitations where id = '13280000-0000-4000-8000-000000000073') then
		raise exception '1328: unlocked expired invitation should have been deleted';
	end if;

	v_claim := public.qorpera_folder_claim_object_gc(10, '13280000-0000-4000-8000-000000000076');
	if exists (select 1 from public.qorpera_folder_object_gc where profile_id = v_profile and sha256 = v_sha_rooted) then
		raise exception '1328: rooted folder GC row should have been deleted';
	end if;
	if not exists (
		select 1 from public.qorpera_folder_object_gc
		where profile_id = v_profile and sha256 = v_sha_leased and lease_id = '13280000-0000-4000-8000-000000000075'
	) then
		raise exception '1328: already-leased folder GC row should have kept its prior lease';
	end if;
	if exists (
		select 1 from jsonb_array_elements(v_claim -> 'objects') o where o ->> 'sha256' = v_sha_locked
	) then
		raise exception '1328: locked folder GC row should have been skipped';
	end if;
	if jsonb_array_length(v_claim -> 'objects') <> 2
		or v_claim #>> '{objects,0,sha256}' <> v_sha_a
		or v_claim #>> '{objects,1,sha256}' <> v_sha_b then
		raise exception '1328: folder GC claim must return eligible due rows in canonical sha256 C order: %', v_claim;
	end if;
end
$$;

select dblink_exec('r1328_hold', 'rollback');
select dblink_disconnect('r1328_hold');

do $$
declare
	v_profile uuid := current_setting('qorpera_test.p1328_profile')::uuid;
	v_env uuid := current_setting('qorpera_test.p1328_env')::uuid;
begin
	delete from public.qorpera_folder_object_gc where profile_id = v_profile;
	delete from public.qorpera_folder_entries where environment_id = v_env;
	delete from public.qorpera_profile_invitations where profile_id = v_profile;
	delete from public.qorpera_profile_objects where profile_id = v_profile;
	delete from public.qorpera_profiles where id = v_profile;
	delete from public.qorpera_deleted_profile_object_gc_queue where profile_id = v_profile;
	delete from auth.users where id = '13280000-0000-4000-8000-000000000070';
end
$$;
