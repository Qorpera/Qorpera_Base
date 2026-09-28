-- Deleting a company that has used its agents (bug found 28 Sep 2026). qorpera_delete_hosted_profile
-- deleted the company row and relied on cascades. But most runtime rows hang off runs, jobs, runners,
-- assignments, snapshots and logins with ON DELETE RESTRICT and have no link to the company, and some
-- RESTRICT links run between two tables the cascade reaches in an order it does not control. So any
-- company with a run, a published Company File or a signed-in account failed with 23503.
--
-- The rules:
-- * Everything that depends on the company row through a foreign key goes, the company's history
--   included (runs, events, receipts, read observations, context views, launches, coding turns).
--   qorpera_purge_company finds those rows from the company row outward and deletes them in one
--   statement, so every RESTRICT check runs once no dependent row is left.
-- * Usage records outlive the company, like computer hours (contract 19 item 9, RUNNER-USAGE.md): the
--   two runner usage ledgers lose their links to the company's rows and keep the ids as plain values.
-- * Machines stay the node's business. While the company has a machine on a node, or an account
--   identity a node may still hold, deletion is refused. Deleting those rows would leave the VM or the
--   identity volume behind with nothing to remove it, and the node inventory would then mark the whole
--   node unavailable (UNREGISTERED_INSTANCE, or an identity device it no longer accepts). Released run,
--   office and coding machines are only records by then, and go with the company.
-- * Stored bytes: unchanged. qorpera_profile_objects has no link to the company; its rows stay behind as
--   the deleted-company cleanup queue (ARTIFACT-GC.md).
-- * Lock order: the company row, then its wake admission fence (qorpera_lock_profile_gc_fence), then
--   every dependent row FOR UPDATE, level by level outward from the company.

-- Dropping a foreign key locks both tables; never queue the company table behind this migration.
set local lock_timeout = '3s';

-- Usage records keep their ids after the company, its jobs, runners and model requests are gone.
alter table public.qorpera_runner_usage_observations
	drop constraint qorpera_runner_usage_observations_profile_id_fkey,
	drop constraint qorpera_runner_usage_observations_environment_id_fkey,
	drop constraint qorpera_runner_usage_observations_job_id_fkey,
	drop constraint qorpera_runner_usage_observations_runner_id_fkey;
alter table public.qorpera_runner_model_usage_observations
	drop constraint qorpera_runner_model_usage_observations_profile_id_fkey,
	drop constraint qorpera_runner_model_usage_observations_environment_id_fkey,
	drop constraint qorpera_runner_model_usage_observations_job_id_fkey,
	drop constraint qorpera_runner_model_usage_observations_request_id_fkey,
	drop constraint qorpera_runner_model_usage_observations_runner_id_fkey;

-- The purge registers its transaction here, so immutable history lets its deletes through and nothing
-- else's. The row never outlives the purge's own transaction.
create table public.qorpera_company_purges (
	xact_id xid8 primary key,
	profile_id uuid not null
);
alter table public.qorpera_company_purges enable row level security;
revoke all on public.qorpera_company_purges from public, anon, authenticated, service_role;

create function public.qorpera_company_purge_active()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select exists (select 1 from public.qorpera_company_purges
		where xact_id = pg_current_xact_id_if_assigned())
$$;
revoke all on function public.qorpera_company_purge_active() from public, anon, authenticated, service_role;

do $guard$
declare
	v_expected constant jsonb := jsonb_build_object(
		'public.qorpera_reject_runtime_bundle_mutation()', '335f1baab8b81102b277adef5b8e4b4f7c2bfadabf50ece72182ec1c68f10129',
		'public.qorpera_guard_native_launch_replacement()', '8c636fea37e49bc3c192901a97727c93099b1d363d09f2e28d692c8b74a6b6be',
		'public.qorpera_coding_session_turn_guard()', '9fa085cd459c2008f917ba1ae9b9284ab78db03e9e2636afbd52301437072d0b',
		'public.qorpera_guard_legacy_company_computer_teardown()', 'c7f27a7ca680fe40973565fad6f7bdc6ebd89e0518eebe5babdb76b0b5539eb2',
		'public.qorpera_guard_torn_down_legacy_company_computer()', '43621bb0bf149350fe3009aa691b1a0b7b84eba9491f6edeee2d84febe1b1eb3',
		'public.qorpera_guard_office_delete_disposition()', '0a61d673ac8754b4fd8580f0da615e5d3cd86324d40f5542078e3523fededdb3',
		'public.qorpera_delete_hosted_profile(uuid)', 'b670bd9e7067e1496b617fc2e5b6bdd56607a944018e3e6bd3af3eddcdd1bfb1');
	v_function text;
begin
	for v_function in select jsonb_object_keys(v_expected) loop
		if encode(extensions.digest(pg_get_functiondef(v_function::regprocedure), 'sha256'), 'hex')
			<> v_expected ->> v_function then
			raise exception 'Reviewed function definition changed: %', v_function;
		end if;
	end loop;
end
$guard$;

-- Each immutable history guard lets the purge's deletes through, first thing, and is otherwise
-- unchanged. qorpera_reject_runtime_bundle_mutation also guards the runtime bundles, which no company
-- row reaches, so the purge never deletes one.
create or replace function public.qorpera_reject_runtime_bundle_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if tg_op = 'DELETE' and public.qorpera_company_purge_active() then return old; end if;
	raise exception 'Runtime bundles are immutable' using errcode = '42501';
end
$$;

create or replace function public.qorpera_coding_session_turn_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
	if tg_op = 'DELETE' and public.qorpera_company_purge_active() then return old; end if;
	if tg_op = 'DELETE' then raise exception 'A coding turn is history and cannot be removed' using errcode = '55000'; end if;
	if (new.worker_id, new.sequence, new.input_from, new.input_text, new.input_user_id, new.input_run_id, new.created_at)
			is distinct from (old.worker_id, old.sequence, old.input_from, old.input_text, old.input_user_id, old.input_run_id, old.created_at)
		or (old.submission is not null and (new.submission, new.submission_receipt_id, new.submitted_at)
			is distinct from (old.submission, old.submission_receipt_id, old.submitted_at))
		or (old.outcome is not null and ((new.outcome, new.settled_at) is distinct from (old.outcome, old.settled_at)
			or new.submission is distinct from old.submission)) then
		raise exception 'A coding turn is recorded once' using errcode = '55000'; end if;
	return new;
end
$$;

create or replace function public.qorpera_guard_legacy_company_computer_teardown()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if tg_op = 'DELETE' and public.qorpera_company_purge_active() then return old; end if;
	raise exception 'Legacy company computer teardown evidence is immutable'
		using errcode = '42501';
end
$$;

create or replace function public.qorpera_guard_torn_down_legacy_company_computer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if tg_op = 'DELETE' and public.qorpera_company_purge_active() then return old; end if;
	if exists (
		select 1 from public.qorpera_legacy_company_computer_teardowns as teardown
		where teardown.logical_computer_id = old.id
	) then
		raise exception 'Torn-down legacy company computer history is immutable'
			using errcode = '42501';
	end if;
	return case when tg_op = 'DELETE' then old else new end;
end
$$;

create or replace function public.qorpera_guard_office_delete_disposition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
	if tg_op = 'DELETE' and public.qorpera_company_purge_active() then return old; end if;
	raise exception 'Office delete disposition is immutable' using errcode = '42501';
end
$$;

do $$
declare
	v_definition text := pg_get_functiondef('public.qorpera_guard_native_launch_replacement()'::regprocedure);
	v_old text := E'begin\n\tif tg_op <> ''UPDATE'' or auth.role() is distinct from ''service_role'' then';
begin
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Native launch guard differs';
	end if;
	execute replace(v_definition, v_old,
		E'begin\n\tif tg_op = ''DELETE'' and public.qorpera_company_purge_active() then return old; end if;\n'
		|| substr(v_old, length(E'begin\n') + 1));
end
$$;

-- What a company still has on the nodes: a machine that is not released, or an account identity a
-- node's execution host may hold (any sign-in or account-refresh machine, released or not).
create function public.qorpera_company_node_holdings(p_profile_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'machines', count(*) filter (where allocation.released_at is null),
		'identities', count(distinct allocation.login_compute_identity_id))
	from public.qorpera_runtime_machine_allocations as allocation
	where allocation.profile_id = p_profile_id
$$;
revoke all on function public.qorpera_company_node_holdings(uuid) from public, anon, authenticated, service_role;

-- Deletes the company and every row that depends on it. Callers check who may do this (the product
-- delete below; the folder core's C5 reset is meant to reuse it). Returns the deleted rows per table.
create function public.qorpera_purge_company(p_profile_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_holdings jsonb;
	v_level integer := 0;
	v_edge record;
	v_join text;
	v_deletes text[] := '{}';
	v_table oid;
	v_counts jsonb;
begin
	if p_profile_id is null then
		raise exception 'company id is required' using errcode = '22023';
	end if;
	perform public.qorpera_lock_profile_gc_fence(p_profile_id);
	-- The company row is locked: no new machine can be reserved for it until this transaction ends.
	v_holdings := public.qorpera_company_node_holdings(p_profile_id);
	if (v_holdings ->> 'machines')::bigint > 0 or (v_holdings ->> 'identities')::bigint > 0 then
		raise exception 'This company still has machines on our servers, so it cannot be deleted yet'
			using errcode = '55000', detail = v_holdings::text;
	end if;
	insert into public.qorpera_company_purges (xact_id, profile_id) values (pg_current_xact_id(), p_profile_id);

	create temp table if not exists qorpera_purge_rows (
		table_id oid not null,
		row_id tid not null,
		level integer not null,
		primary key (table_id, row_id)
	) on commit drop;
	truncate pg_temp.qorpera_purge_rows;
	insert into pg_temp.qorpera_purge_rows (table_id, row_id, level)
	select 'public.qorpera_profiles'::regclass, profile.ctid, 0
	from public.qorpera_profiles as profile where profile.id = p_profile_id;

	-- Every row that references a row found so far and would block or follow its delete. Rows that
	-- only lose a reference (ON DELETE SET NULL or SET DEFAULT) stay. Locking each found row makes a
	-- concurrent insert that references it wait, then fail once the row is gone.
	loop
		for v_edge in
			select constraint_row.oid, constraint_row.conrelid, constraint_row.confrelid,
				constraint_row.conkey, constraint_row.confkey, child_table.relkind, child_table.relnamespace
			from pg_catalog.pg_constraint as constraint_row
			join pg_catalog.pg_class as child_table on child_table.oid = constraint_row.conrelid
			where constraint_row.contype = 'f'
				and constraint_row.confdeltype in ('c', 'r', 'a')
				and constraint_row.confrelid in (
					select found.table_id from pg_temp.qorpera_purge_rows as found where found.level = v_level)
			order by constraint_row.oid
		loop
			if v_edge.relkind <> 'r' or v_edge.relnamespace <> 'public'::regnamespace then
				raise exception 'Company rows are referenced from %', v_edge.conrelid::regclass;
			end if;
			select string_agg(format('child.%I = parent.%I', child_column.attname, parent_column.attname), ' and '
				order by key_position)
			into v_join
			from generate_subscripts(v_edge.conkey, 1) as key_position
			join pg_catalog.pg_attribute as child_column
				on child_column.attrelid = v_edge.conrelid and child_column.attnum = v_edge.conkey[key_position]
			join pg_catalog.pg_attribute as parent_column
				on parent_column.attrelid = v_edge.confrelid and parent_column.attnum = v_edge.confkey[key_position];
			execute format(
				'insert into pg_temp.qorpera_purge_rows (table_id, row_id, level)
				select %1$s, locked.ctid, %2$s
				from (
					select child.ctid from %3$s as child join %4$s as parent on %5$s
					where parent.ctid in (
						select found.row_id from pg_temp.qorpera_purge_rows as found
						where found.table_id = %6$s and found.level = %7$s)
					for update of child
				) as locked
				on conflict do nothing',
				v_edge.conrelid::oid, v_level + 1, v_edge.conrelid::regclass, v_edge.confrelid::regclass, v_join,
				v_edge.confrelid::oid, v_level);
		end loop;
		exit when not exists (select 1 from pg_temp.qorpera_purge_rows as found where found.level = v_level + 1);
		v_level := v_level + 1;
	end loop;

	select jsonb_object_agg(counted.table_id::regclass::text, counted.row_count order by counted.table_id::regclass::text)
	into v_counts
	from (
		select found.table_id, count(*) as row_count from pg_temp.qorpera_purge_rows as found group by found.table_id
	) as counted;

	-- One statement: no RESTRICT check runs before every found row is gone, whatever the links between
	-- them. The company row and its members go last, by the cascade, so the member triggers see a
	-- company that is being deleted.
	for v_table in
		select distinct found.table_id from pg_temp.qorpera_purge_rows as found
		where found.table_id not in ('public.qorpera_profiles'::regclass, 'public.qorpera_profile_members'::regclass)
		order by found.table_id
	loop
		v_deletes := v_deletes || format(
			'd%1$s as (delete from %2$s where ctid in (
				select found.row_id from pg_temp.qorpera_purge_rows as found where found.table_id = %1$s))',
			v_table, v_table::regclass);
	end loop;
	if cardinality(v_deletes) > 0 then
		execute 'with ' || array_to_string(v_deletes, ', ') || ' select 1';
	end if;
	delete from public.qorpera_profiles where id = p_profile_id;

	delete from public.qorpera_company_purges where xact_id = pg_current_xact_id();
	truncate pg_temp.qorpera_purge_rows;
	return coalesce(v_counts, '{}'::jsonb);
end
$$;
revoke all on function public.qorpera_purge_company(uuid) from public, anon, authenticated, service_role;

-- Only the last member deletes the company; nobody deletes it while others remain.
create or replace function public.qorpera_delete_hosted_profile(p_profile_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor_id uuid := auth.uid();
begin
	if v_actor_id is null or public.qorpera_member_role(p_profile_id) is null then
		raise exception 'deleting a company requires membership' using errcode = '42501';
	end if;
	perform 1 from public.qorpera_profiles where id = p_profile_id for update;
	perform 1 from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = v_actor_id;
	if not found then
		raise exception 'deleting a company requires membership' using errcode = '42501';
	end if;
	if exists (select 1 from public.qorpera_profile_members as other
		where other.profile_id = p_profile_id and other.user_id <> v_actor_id) then
		raise exception 'Only the last member can delete the company; everyone else leaves' using errcode = '42501';
	end if;
	-- Every row that depends on the company goes (qorpera_purge_company). Usage and computer-hour
	-- records stay for bookkeeping. Stored objects are content-addressed under the company prefix and
	-- are not reachable from SQL; their catalog rows stay as the deleted-company cleanup queue, exactly
	-- as the artifact GC treats them.
	perform public.qorpera_purge_company(p_profile_id);
	return 'true'::jsonb;
end
$$;
