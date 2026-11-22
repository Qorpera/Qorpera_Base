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
			and position('qorpera_computer_hour_finish_window_over' in v_def) > 0
			and position('order by candidate.id limit 100 for update of candidate skip locked' in v_def) > 0
			and position('for update of job skip locked' in v_def) > 0
			and position('limit 200 for update skip locked' in v_def) > 0,
		'reconcile_runner_orchestrator must preserve prior patches and bound all sweeps'
	);

	v_def := pg_get_functiondef('public.qorpera_claim_company_mail(integer,uuid)'::regprocedure);
	perform pg_temp.assert_1328(
		position('qorpera_mail_threads' in v_def) > 0
			and position('limit 500 for update skip locked' in v_def) > 0
			and position('limit 200' in v_def) > 0
			and position('for update of candidate skip locked' in v_def) > 0,
		'qorpera_claim_company_mail must preserve thread cleanup and bound housekeeping updates'
	);

	v_def := pg_get_functiondef('public.qorpera_claim_computer_hour_notices(integer,uuid)'::regprocedure);
	perform pg_temp.assert_1328(
		position('qorpera_computer_hour_zero_occasion' in v_def) > 0
			and position('for update of open_notice skip locked' in v_def) > 0
			and position('for update of candidate skip locked' in v_def) > 0
			and position('limit 200' in v_def) > 0,
		'qorpera_claim_computer_hour_notices must preserve zero-state patches and bound housekeeping updates'
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
	v_claim jsonb;
	v_plan text := '';
	v_line text;
	v_remaining_leases integer;
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

	insert into public.qorpera_deleted_profile_object_gc_leases (profile_id, lease_id, lease_expires_at)
	select extensions.gen_random_uuid(), extensions.gen_random_uuid(), statement_timestamp() - interval '1 hour'
	from generate_series(1, 105);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	v_claim := public.qorpera_claim_deleted_profile_object_gc(10, v_lease);
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
		v_remaining_leases = 5,
		'expired deleted-profile GC lease cleanup must cap at 100 per call, remaining=' || v_remaining_leases
	);

	delete from public.qorpera_profile_objects where profile_id = v_obj_profile and sha256 = v_sha_a;
	perform public.qorpera_complete_deleted_profile_object_gc(v_obj_profile, v_lease, array[v_sha_a]);
	perform pg_temp.assert_1328(
		not exists (select 1 from public.qorpera_deleted_profile_object_gc_queue where profile_id = v_obj_profile),
		'completing the final batch must dequeue the deleted profile'
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
	v_user_fresh uuid := '13280000-0000-4000-8000-000000000050';
	v_user_stale uuid := '13280000-0000-4000-8000-000000000051';
	v_profile uuid := '13280000-0000-4000-8000-000000000052';
	v_env uuid := '13280000-0000-4000-8000-000000000053';
	v_node_sha text := repeat('5', 64);
	v_policy jsonb := jsonb_build_object('providerPolicySha256', repeat('d', 64));
	v_m_fresh uuid := '13280000-0000-4000-8000-000000000054';
	v_m_stale uuid := '13280000-0000-4000-8000-000000000055';
	v_list jsonb;
	v_e_fresh jsonb;
	v_e_stale jsonb;
begin
	insert into auth.users (id, email) values
		(v_user_fresh, 'code-fresh-1328@example.test'),
		(v_user_stale, 'code-stale-1328@example.test');
	insert into public.qorpera_profiles (id, name, created_by_user_id) values (v_profile, 'Code 1328', v_user_fresh);
	insert into public.qorpera_company_environments (id, profile_id, name, contract_version, created_by_user_id)
	values (v_env, v_profile, 'production', 1, v_user_fresh);
	insert into public.qorpera_coding_executors (
		environment_id, owner, enabled, vm_policy, nas_machine_id_sha256,
		machine_sleep_after_seconds, machine_remove_after_seconds
	) values (v_env, 'exec-1328', true, v_policy, v_node_sha, 600, 600);

	insert into public.qorpera_coding_machines (
		id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding, last_used_at, created_at
	) values
		(v_m_fresh, 'member', v_profile, v_env, v_user_fresh, 'exec-1328', v_node_sha, v_policy,
			clock_timestamp(), clock_timestamp() - interval '2 minutes'),
		(v_m_stale, 'member', v_profile, v_env, v_user_stale, 'exec-1328', v_node_sha, v_policy,
			clock_timestamp() - interval '2 hours', clock_timestamp() - interval '1 minute');

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	v_list := public.qorpera_list_coding_machines('exec-1328', v_node_sha);
	perform pg_temp.assert_1328(jsonb_array_length(v_list) = 2, 'expected 2 coding machines: ' || v_list::text);

	select e into v_e_fresh from jsonb_array_elements(v_list) e where e ->> 'machineId' = v_m_fresh::text;
	select e into v_e_stale from jsonb_array_elements(v_list) e where e ->> 'machineId' = v_m_stale::text;

	perform pg_temp.assert_1328(
		(v_e_fresh ->> 'live')::boolean = false
			and (v_e_fresh ->> 'reserved')::boolean = false
			and (v_e_fresh ->> 'superseded')::boolean = false
			and (v_e_fresh ->> 'removeDue')::boolean = false
			and v_e_fresh -> 'attached' = '[]'::jsonb,
		'fresh unreserved machine state mismatch: ' || coalesce(v_e_fresh::text, 'null')
	);
	perform pg_temp.assert_1328(
		(v_e_stale ->> 'live')::boolean = false
			and (v_e_stale ->> 'reserved')::boolean = false
			and (v_e_stale ->> 'superseded')::boolean = false
			and (v_e_stale ->> 'removeDue')::boolean = true
			and v_e_stale -> 'attached' = '[]'::jsonb,
		'stale unreserved machine must be removeDue: ' || coalesce(v_e_stale::text, 'null')
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
	v_profile uuid := '13280000-0000-4000-8000-000000000071';
	v_inv_locked uuid := '13280000-0000-4000-8000-000000000072';
	v_inv_free uuid := '13280000-0000-4000-8000-000000000073';
begin
	insert into auth.users (id, email) values (v_user, 'dblink1328@example.test');
	insert into public.qorpera_profiles (id, name, created_by_user_id) values (v_profile, 'Dblink 1328', v_user);
	insert into public.qorpera_profile_invitations (id, profile_id, email, role, invited_by_user_id, expires_at) values
		(v_inv_locked, v_profile, 'locked-1328@example.test', 'contributor', v_user, statement_timestamp() - interval '2 hours'),
		(v_inv_free, v_profile, 'free-1328@example.test', 'contributor', v_user, statement_timestamp() - interval '1 hour');
end
$$;

select dblink_connect('r1328_hold', 'dbname=' || current_database());
select dblink_exec('r1328_hold', 'begin');
select * from dblink('r1328_hold',
	$$select id from public.qorpera_profile_invitations where id = '13280000-0000-4000-8000-000000000072' for update$$
) as t(id uuid);

do $$
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
end
$$;

select dblink_exec('r1328_hold', 'rollback');
select dblink_disconnect('r1328_hold');

do $$
begin
	delete from public.qorpera_profile_invitations where profile_id = '13280000-0000-4000-8000-000000000071';
	delete from public.qorpera_profiles where id = '13280000-0000-4000-8000-000000000071';
	delete from public.qorpera_deleted_profile_object_gc_queue where profile_id = '13280000-0000-4000-8000-000000000071';
	delete from auth.users where id = '13280000-0000-4000-8000-000000000070';
end
$$;
