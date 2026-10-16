-- 20260930400000: the legacy sweep, step E1 (the artifact lane and the live-company object GC). The snapshot-v1
-- artifact records go (folder-v2 only, the founder's decision of 3 October): a folder-v2 company keeps its bytes in its
-- company folder, and 20260930041000 made the artifact functions refuse it. HP-D took the runtime's callers and D5
-- (20260930334000) the runner broker's registration; nothing else calls them. Three functions keep their other path;
-- each is patched in place from its live text, so its header, its grants and the other migrations' changes to it stay;
-- each anchor must occur exactly once.
-- 1. The service deletion authorization keeps only its deleted-company source (the folder-v2 erasure's, tests 190, 200
--    and 922). The artifact GC plan and live-company GC sources go, and with them the GC fence it took only for those.
-- 2. The cleanup check behind the root and graph completion guards keeps the outstanding authorizations, and the
--    substrate version guard keeps the artifacts a cleanup finished (its fence stays).
-- 3. Dropped: the member's artifact registration, index, retention hold and GC plan functions with their JSON helpers,
--    audit and candidate lists; the worker's plan claim, lease, object, completion and failure functions; the
--    live-company object GC (snapshot-v1 only: C1a, 20260928120000, makes its claim skip folder-v2); the gateway's
--    retired post-delete confirmation; the coverage checks only the plans read; and the GC guards on the index
--    entries and retention holds with their triggers. Then the tables qorpera_artifact_gc_plans, _plan_entries and
--    _audit_receipts and qorpera_company_object_gc_leases and _entries, which must be empty, with the authorization
--    table's foreign key to the company leases.
-- Kept: qorpera_artifacts, its indexes, index entries and retention holds, the reachability graphs and restore proofs
-- (later E slices); the deleted-company GC, the finalize and the authorization list; and the authorization table's
-- source kinds, columns and checks (step G).
-- Every patched body names this migration (20260930400000), and every earlier marker in it stays.
set local lock_timeout = '3s';

create function pg_temp.e1_patch(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Legacy sweep E1 anchor found % time(s) in %, expected 1: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The deletion authorization keeps only a deleted company's GC lease. ---------------------------------------------

select pg_temp.e1_patch('public.qorpera_authorize_profile_object_deletion(uuid,text,bigint,text,uuid)'::regprocedure,
$old$	select plan.id, 'artifact_gc' into v_source_id, v_source_kind
	from public.qorpera_artifact_gc_plans as plan
	join public.qorpera_artifact_gc_plan_entries as entry on entry.plan_id = plan.id
	where plan.profile_id = p_profile_id
		and plan.status = 'deleting'
		and plan.lease_id = p_lease_id
		and plan.lease_expires_at > statement_timestamp()
		and entry.object_sha256 = p_sha256
		and entry.bytes = p_bytes
		and entry.status = 'pending'
	for update of plan;
	if not found then
		select lease.profile_id, 'company_gc' into v_source_id, v_source_kind
		from public.qorpera_company_object_gc_leases as lease
		join public.qorpera_company_object_gc_entries as entry
			on entry.profile_id = lease.profile_id and entry.lease_id = lease.lease_id
		where lease.profile_id = p_profile_id
			and lease.lease_id = p_lease_id
			and lease.lease_expires_at > statement_timestamp()
			and entry.object_sha256 = p_sha256
			and entry.bytes = p_bytes
		for update of lease;
	end if;
	if v_source_kind is null then
		select lease.profile_id, 'deleted_profile_gc' into v_source_id, v_source_kind
		from public.qorpera_deleted_profile_object_gc_leases as lease
		join public.qorpera_deleted_profile_object_gc_entries as entry
			on entry.profile_id = lease.profile_id and entry.lease_id = lease.lease_id
		where lease.profile_id = p_profile_id
			and lease.lease_id = p_lease_id
			and lease.lease_expires_at > statement_timestamp()
			and entry.object_sha256 = p_sha256
			and entry.bytes = p_bytes
			and entry.backend = p_backend
		for update of lease;
	end if;
$old$,
$new$	-- 20260930400000 (legacy sweep E1): only a deleted company's GC lease authorizes a deletion; the artifact GC
	-- plans and the live-company object GC are gone.
	select lease.profile_id, 'deleted_profile_gc' into v_source_id, v_source_kind
	from public.qorpera_deleted_profile_object_gc_leases as lease
	join public.qorpera_deleted_profile_object_gc_entries as entry
		on entry.profile_id = lease.profile_id and entry.lease_id = lease.lease_id
	where lease.profile_id = p_profile_id
		and lease.lease_id = p_lease_id
		and lease.lease_expires_at > statement_timestamp()
		and entry.object_sha256 = p_sha256
		and entry.bytes = p_bytes
		and entry.backend = p_backend
	for update of lease;
$new$);

-- The GC fence was taken only for the two sources that go; a deleted company's lease never took it.
select pg_temp.e1_patch('public.qorpera_authorize_profile_object_deletion(uuid,text,bigint,text,uuid)'::regprocedure,
$old$	if v_source_kind <> 'deleted_profile_gc' then
		perform public.qorpera_lock_profile_gc_fence(p_profile_id);
	end if;
$old$,
$new$$new$);

select pg_temp.e1_patch('public.qorpera_authorize_profile_object_deletion(uuid,text,bigint,text,uuid)'::regprocedure,
$old$		case when v_source_kind = 'company_gc' then p_profile_id else null end,
		case when v_source_kind = 'company_gc' then p_lease_id else null end,
		case when v_source_kind = 'deleted_profile_gc' then p_profile_id else null end,
		case when v_source_kind = 'deleted_profile_gc' then p_lease_id else null end
$old$,
$new$		null, null, p_profile_id, p_lease_id
$new$);

-- 2. The cleanup check and the substrate version guard. ---------------------------------------------------------------

select pg_temp.e1_patch('public.qorpera_profile_gc_deletion_active(uuid)'::regprocedure,
$old$	select exists (
		select 1 from public.qorpera_artifact_gc_plans as plan
		where plan.profile_id = p_profile_id and plan.status = 'deleting'
	) or exists (
		select 1 from public.qorpera_company_object_gc_leases as lease
		where lease.profile_id = p_profile_id and lease.lease_expires_at > statement_timestamp()
	) or exists (
$old$,
$new$	-- 20260930400000 (legacy sweep E1): an outstanding deletion authorization is the cleanup left; the artifact GC
	-- plans and the live-company object GC are gone.
	select exists (
$new$);

select pg_temp.e1_patch('public.qorpera_reject_gc_substrate_version()'::regprocedure,
$old$		join public.qorpera_artifacts as artifact on artifact.id = index_entry.artifact_id
		left join public.qorpera_artifact_gc_plans as plan
			on plan.artifact_id = artifact.id
			and plan.status in ('waiting', 'deleting', 'retrying', 'failed')
		where index_entry.index_id = new.artifact_index_id
			and (artifact.gc_completed_at is not null or plan.id is not null)
$old$,
$new$		join public.qorpera_artifacts as artifact on artifact.id = index_entry.artifact_id
		where index_entry.index_id = new.artifact_index_id
			-- 20260930400000 (legacy sweep E1): the artifact GC plans are gone; an artifact a cleanup finished still counts.
			and artifact.gc_completed_at is not null
$new$);

-- 3. The artifact lane and the live-company object GC go. ------------------------------------------------------------

-- The two guards refused an index entry or a retention hold while a GC plan or company GC lease held the profile.
drop trigger qorpera_artifact_index_entries_gc_guard on public.qorpera_artifact_index_entries;
drop trigger qorpera_artifact_retention_holds_gc_guard on public.qorpera_artifact_retention_holds;
drop function public.qorpera_reject_gc_artifact_index_entry();
drop function public.qorpera_reject_gc_artifact_retention_hold();

-- The member's artifact functions.
drop function public.qorpera_register_artifact(uuid,uuid,uuid,text,text,text,text,bigint,text);
drop function public.qorpera_register_artifact_v2(uuid,uuid,uuid,text,text,text,text,text,bigint,text);
drop function public.qorpera_create_artifact_index(uuid,uuid,uuid[]);
drop function public.qorpera_get_artifact_index(uuid);
drop function public.qorpera_list_artifact_index_entries(uuid,integer,integer);
drop function public.qorpera_create_artifact_retention_hold(uuid,uuid,text,timestamp with time zone);
drop function public.qorpera_release_artifact_retention_hold(uuid);
drop function public.qorpera_artifact_retention_hold_json(public.qorpera_artifact_retention_holds);

-- The artifact GC plans: the member's and the worker's functions.
drop function public.qorpera_list_artifact_gc_candidates(uuid,integer);
drop function public.qorpera_list_artifact_gc_candidates_without_worker(uuid,integer);
drop function public.qorpera_create_artifact_gc_plan(uuid,uuid);
drop function public.qorpera_list_artifact_gc_plans(uuid,integer);
drop function public.qorpera_list_artifact_gc_audit(uuid,bigint,integer);
drop function public.qorpera_cancel_artifact_gc_plan(uuid);
drop function public.qorpera_cancel_artifact_gc_plan_v2(uuid);
drop function public.qorpera_retry_artifact_gc_plan(uuid);
drop function public.qorpera_claim_artifact_gc_plans(integer,uuid);
drop function public.qorpera_renew_artifact_gc_lease(uuid,uuid,text[]);
drop function public.qorpera_claim_artifact_gc_objects(uuid,uuid,integer);
drop function public.qorpera_complete_artifact_gc_objects(uuid,uuid,text[]);
drop function public.qorpera_complete_artifact_gc_plan(uuid,uuid);
drop function public.qorpera_fail_artifact_gc_plan(uuid,uuid,text);
drop function public.qorpera_fail_artifact_gc_plan_v2(uuid,uuid,text);
drop function public.qorpera_confirm_profile_object_deletion(uuid,text,bigint,text,uuid);
drop function public.qorpera_artifact_gc_initial_guard_ready(uuid);
drop function public.qorpera_profile_reachability_coverage_ready(uuid);
drop function public.qorpera_append_artifact_gc_audit(public.qorpera_artifact_gc_plans,text,jsonb,uuid);
drop function public.qorpera_artifact_gc_plan_json(public.qorpera_artifact_gc_plans);

-- The live-company object GC.
drop function public.qorpera_claim_company_object_gc(integer,uuid);
drop function public.qorpera_renew_company_object_gc(uuid,uuid,text[]);
drop function public.qorpera_complete_company_object_gc(uuid,uuid,text[]);
drop function public.qorpera_release_company_object_gc(uuid,uuid);
drop function public.qorpera_release_company_object_gc_v2(uuid,uuid);

-- Last, as 20260930330000 does it: the tables go only while empty, and no authorization may still name a plan or a
-- company lease. The lock keeps a row from arriving between the check and the drop; all in one statement, since a
-- bare LOCK TABLE fails where each statement commits. The authorization table keeps its company lease columns and
-- source kinds for step G; only its foreign key to the company leases goes with them.
do $$
declare v_constraint name;
begin
	lock table public.qorpera_profile_object_deletion_authorizations, public.qorpera_artifact_gc_plans,
		public.qorpera_artifact_gc_plan_entries, public.qorpera_artifact_gc_audit_receipts,
		public.qorpera_company_object_gc_leases, public.qorpera_company_object_gc_entries in access exclusive mode;
	if exists (select 1 from public.qorpera_artifact_gc_plans)
		or exists (select 1 from public.qorpera_artifact_gc_plan_entries)
		or exists (select 1 from public.qorpera_artifact_gc_audit_receipts)
		or exists (select 1 from public.qorpera_company_object_gc_leases)
		or exists (select 1 from public.qorpera_company_object_gc_entries)
		or exists (select 1 from public.qorpera_profile_object_deletion_authorizations
			where source_kind <> 'deleted_profile_gc') then
		raise exception 'Legacy sweep E1 drops the artifact GC plans and the company object GC only while there are none'
			using errcode = '55000'; end if;
	for v_constraint in select constraint_row.conname from pg_constraint as constraint_row
		where constraint_row.conrelid = 'public.qorpera_profile_object_deletion_authorizations'::regclass
			and constraint_row.confrelid = 'public.qorpera_company_object_gc_leases'::regclass
	loop
		execute format('alter table public.qorpera_profile_object_deletion_authorizations drop constraint %I', v_constraint);
	end loop;
	drop table public.qorpera_artifact_gc_audit_receipts;
	drop table public.qorpera_artifact_gc_plan_entries;
	drop table public.qorpera_artifact_gc_plans;
	drop table public.qorpera_company_object_gc_entries;
	drop table public.qorpera_company_object_gc_leases;
end $$;

-- Nothing that runs may still name what went.
do $$
declare v_name text;
begin
	for v_name in select procedure.oid::regprocedure::text from pg_proc procedure
		where procedure.pronamespace = 'public'::regnamespace
			and procedure.prosrc ~ ('qorpera_artifact_gc_(plans|plan_entries|audit_receipts)\M'
				|| '|qorpera_company_object_gc_(leases|entries)\M|qorpera_(claim|renew|complete)_company_object_gc\M'
				|| '|qorpera_release_company_object_gc(_v2)?\M|qorpera_register_artifact(_v2)?\M'
				|| '|qorpera_(create|get)_artifact_index\M|qorpera_list_artifact_index_entries\M'
				|| '|qorpera_(create|release)_artifact_retention_hold\M|qorpera_artifact_retention_hold_json\M'
				|| '|qorpera_list_artifact_gc_(candidates|candidates_without_worker|plans|audit)\M'
				|| '|qorpera_(create|retry|complete)_artifact_gc_plan\M|qorpera_(cancel|fail)_artifact_gc_plan(_v2)?\M'
				|| '|qorpera_claim_artifact_gc_(plans|objects)\M|qorpera_complete_artifact_gc_objects\M'
				|| '|qorpera_renew_artifact_gc_lease\M|qorpera_append_artifact_gc_audit\M|qorpera_artifact_gc_plan_json\M'
				|| '|qorpera_artifact_gc_initial_guard_ready\M|qorpera_profile_reachability_coverage_ready\M'
				|| '|qorpera_confirm_profile_object_deletion\M|qorpera_reject_gc_artifact_(index_entry|retention_hold)\M')
	loop
		raise exception 'Function % still names the artifact GC or the company object GC', v_name;
	end loop;
end $$;
