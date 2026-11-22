set local lock_timeout = '3s';

create function pg_temp.rpc_patch(p_target regprocedure, p_old text, p_new text, p_label text)
returns void language plpgsql as $$
declare
	v_definition text := pg_get_functiondef(p_target);
	v_count integer;
begin
	v_count := (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old);
	if v_count <> 1 then
		raise exception '20260930846000 patch % matched % times in %', p_label, v_count, p_target;
	end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

create table public.qorpera_deleted_profile_object_gc_queue (
	profile_id uuid primary key,
	queued_at timestamptz not null default statement_timestamp()
);

create index qorpera_deleted_profile_object_gc_queue_order
	on public.qorpera_deleted_profile_object_gc_queue (queued_at, profile_id);

alter table public.qorpera_deleted_profile_object_gc_queue enable row level security;
revoke all on public.qorpera_deleted_profile_object_gc_queue from public, anon, authenticated, service_role;

create function public.qorpera_enqueue_deleted_profile_object_gc_on_profile_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	insert into public.qorpera_deleted_profile_object_gc_queue (profile_id, queued_at)
	select deleted.id, statement_timestamp()
	from deleted
	on conflict (profile_id) do update
	set queued_at = least(public.qorpera_deleted_profile_object_gc_queue.queued_at, excluded.queued_at);
	return null;
end
$$;

create function public.qorpera_enqueue_deleted_profile_object_gc_on_object_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	insert into public.qorpera_deleted_profile_object_gc_queue (profile_id, queued_at)
	select inserted.profile_id, least(min(inserted.created_at), statement_timestamp())
	from inserted
	where not exists (
		select 1 from public.qorpera_profiles as profile where profile.id = inserted.profile_id
	)
	group by inserted.profile_id
	on conflict (profile_id) do update
	set queued_at = least(public.qorpera_deleted_profile_object_gc_queue.queued_at, excluded.queued_at);
	return null;
end
$$;

revoke all on function public.qorpera_enqueue_deleted_profile_object_gc_on_profile_delete()
	from public, anon, authenticated, service_role;
revoke all on function public.qorpera_enqueue_deleted_profile_object_gc_on_object_insert()
	from public, anon, authenticated, service_role;

create trigger qorpera_deleted_profile_object_gc_enqueue_profile_delete
	after delete on public.qorpera_profiles
	referencing old table as deleted
	for each statement
	execute function public.qorpera_enqueue_deleted_profile_object_gc_on_profile_delete();

create trigger qorpera_deleted_profile_object_gc_enqueue_object_insert
	after insert on public.qorpera_profile_objects
	referencing new table as inserted
	for each statement
	execute function public.qorpera_enqueue_deleted_profile_object_gc_on_object_insert();

insert into public.qorpera_deleted_profile_object_gc_queue (profile_id, queued_at)
select object.profile_id, min(object.created_at)
from public.qorpera_profile_objects as object
where not exists (
	select 1 from public.qorpera_profiles as profile where profile.id = object.profile_id
)
group by object.profile_id
on conflict (profile_id) do update
set queued_at = least(public.qorpera_deleted_profile_object_gc_queue.queued_at, excluded.queued_at);

create or replace function public.qorpera_claim_deleted_profile_object_gc(p_limit integer, p_lease_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid;
	v_objects jsonb;
begin
	if auth.role() <> 'service_role' or p_lease_id is null or p_limit not between 1 and 100 then
		raise exception 'deleted profile object cleanup authorization is invalid' using errcode = '42501';
	end if;
	with doomed as materialized (
		select lease.profile_id
		from public.qorpera_deleted_profile_object_gc_leases as lease
		where lease.lease_expires_at <= statement_timestamp()
		order by lease.lease_expires_at, lease.profile_id
		limit 100
		for update skip locked
	)
	delete from public.qorpera_deleted_profile_object_gc_leases as lease
	using doomed
	where lease.profile_id = doomed.profile_id;

	for v_profile_id in
		select queue.profile_id
		from public.qorpera_deleted_profile_object_gc_queue as queue
		where not exists (
			select 1 from public.qorpera_profiles as profile where profile.id = queue.profile_id
		)
			and not exists (
				select 1 from public.qorpera_deleted_profile_object_gc_leases as lease
				where lease.profile_id = queue.profile_id
			)
		order by queue.queued_at, queue.profile_id
		limit 100
	loop
		insert into public.qorpera_deleted_profile_object_gc_leases (profile_id, lease_id, lease_expires_at)
		values (v_profile_id, p_lease_id, statement_timestamp() + interval '10 minutes')
		on conflict (profile_id) do nothing;
		if not found then
			continue;
		end if;
		insert into public.qorpera_deleted_profile_object_gc_entries (
			profile_id,
			lease_id,
			object_sha256,
			bytes,
			backend
		)
		select object.profile_id, p_lease_id, object.sha256, object.bytes, object.backend
		from public.qorpera_profile_objects as object
		where object.profile_id = v_profile_id
		order by object.created_at, object.sha256
		limit p_limit;
		select jsonb_agg(jsonb_build_object(
			'sha256', entry.object_sha256,
			'bytes', entry.bytes,
			'path', entry.profile_id::text || '/' || entry.object_sha256,
			'backend', entry.backend
		) order by entry.object_sha256) into v_objects
		from public.qorpera_deleted_profile_object_gc_entries as entry
		where entry.profile_id = v_profile_id and entry.lease_id = p_lease_id;
		if v_objects is null then
			delete from public.qorpera_deleted_profile_object_gc_leases
			where profile_id = v_profile_id and lease_id = p_lease_id;
			perform 1 from public.qorpera_deleted_profile_object_gc_queue
			where profile_id = v_profile_id
			for update;
			delete from public.qorpera_deleted_profile_object_gc_queue
			where profile_id = v_profile_id
				and not exists (
					select 1 from public.qorpera_profile_objects as object
					where object.profile_id = v_profile_id
				);
			continue;
		end if;
		return jsonb_build_object(
			'profile_id', v_profile_id,
			'lease_id', p_lease_id,
			'objects', v_objects
		);
	end loop;
	return null;
end
$$;

select pg_temp.rpc_patch(
	'public.qorpera_complete_deleted_profile_object_gc(uuid,uuid,text[])'::regprocedure,
	$old$	if not found then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'deleted profile object cleanup lease is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	return v_expected;$old$,
	$new$	if not found then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'deleted profile object cleanup lease is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	perform 1 from public.qorpera_deleted_profile_object_gc_queue
	where profile_id = p_profile_id
	for update;
	delete from public.qorpera_deleted_profile_object_gc_queue
	where profile_id = p_profile_id
		and not exists (
			select 1 from public.qorpera_profile_objects as object
			where object.profile_id = p_profile_id
		);
	return v_expected;$new$,
	'complete_deleted_profile_object_gc_dequeue'
);

create index if not exists qorpera_folder_object_gc_due_order
	on public.qorpera_folder_object_gc (unreferenced_since, profile_id, sha256 collate "C");

create or replace function public.qorpera_folder_claim_object_gc(p_limit integer, p_lease uuid)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	v_row record;
	v_marked jsonb[] := '{}'::jsonb[];
	v_expires timestamptz;
	v_now timestamptz := clock_timestamp();
	v_cutoff timestamptz := v_now - interval '24 hours';
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_limit is null or p_limit not between 1 and 100 or p_lease is null then
		raise exception 'GC claim is invalid' using errcode = '22023'; end if;
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'Folder GC needs read committed isolation' using errcode = '25000'; end if;
	for v_row in
		with candidates as materialized (
			select g.profile_id, g.sha256
			from public.qorpera_folder_object_gc g
			join public.qorpera_profile_objects o on o.profile_id = g.profile_id and o.sha256 = g.sha256
			where g.unreferenced_since <= v_cutoff
				and (g.lease_id is null or g.lease_expires_at <= v_now)
				and o.backend = 'nas-object-gateway'
				and public.qorpera_folder_gc_company(g.profile_id)
			order by g.unreferenced_since, g.profile_id, g.sha256 collate "C"
			limit p_limit * 4
		)
		select o.profile_id, o.sha256, o.bytes, o.backend
		from candidates c
		join public.qorpera_folder_object_gc g on g.profile_id = c.profile_id and g.sha256 = c.sha256
		join public.qorpera_profile_objects o on o.profile_id = g.profile_id and o.sha256 = g.sha256
		where g.unreferenced_since <= v_cutoff
			and (g.lease_id is null or g.lease_expires_at <= v_now)
			and o.backend = 'nas-object-gateway'
			and public.qorpera_folder_gc_company(g.profile_id)
		order by g.profile_id, g.sha256 collate "C"
		limit p_limit
		for update of o, g skip locked
	loop
		if public.qorpera_folder_object_rooted(v_row.profile_id, v_row.sha256) then
			delete from public.qorpera_folder_object_gc where profile_id = v_row.profile_id and sha256 = v_row.sha256;
			continue;
		end if;
		update public.qorpera_folder_object_gc set lease_id = p_lease, lease_expires_at = clock_timestamp() + interval '10 minutes'
		where profile_id = v_row.profile_id and sha256 = v_row.sha256
			and unreferenced_since <= clock_timestamp() - interval '24 hours'
			and (lease_id is null or lease_expires_at <= clock_timestamp())
		returning lease_expires_at into v_expires;
		if found then
			v_marked := array_append(v_marked, jsonb_build_object('profileId', v_row.profile_id, 'sha256', v_row.sha256,
				'bytes', v_row.bytes, 'backend', v_row.backend, 'leaseId', p_lease, 'leaseExpiresAt', v_expires));
		end if;
	end loop;
	return jsonb_build_object('schema', 'qorpera.folder-object-gc-claim/v1', 'objects', to_jsonb(v_marked));
end
$$;

select pg_temp.rpc_patch(
	'public.qorpera_reconcile_runner_orchestrator_without_sponsored_turns(uuid)'::regprocedure,
	$old$	from (
		select distinct request.job_id from public.qorpera_runner_model_requests as request
		where request.status = 'reserved' and request.reservation_expires_at <= statement_timestamp()
	) as expired$old$,
	$new$	from (
		select distinct expired_req.job_id from (
			select request.job_id from public.qorpera_runner_model_requests as request
			join public.qorpera_runner_jobs as req_job on req_job.id = request.job_id
			where request.status = 'reserved'
				and request.reservation_expires_at <= statement_timestamp()
				and req_job.status in ('completed', 'failed', 'cancelled')
			order by request.reservation_expires_at, request.job_id
			limit 200
		) as expired_req
		order by expired_req.job_id
		limit 100
	) as expired$new$,
	'reconcile_expired_model_requests_limit'
);

select pg_temp.rpc_patch(
	'public.qorpera_reconcile_runner_orchestrator_without_sponsored_turns(uuid)'::regprocedure,
	$old$	update public.qorpera_runner_jobs as job
	set status = 'failed', finished_at = statement_timestamp(),
		last_error = 'Execution sponsor, model policy, or quota reservation is unavailable'
	from public.qorpera_execution_runs as run
	where job.id = run.job_id and job.status = 'queued'
		and not public.qorpera_execution_sponsor_available(run)
		and job.id in (select candidate.id from public.qorpera_runner_jobs as candidate
			join public.qorpera_execution_runs as candidate_run on candidate_run.job_id = candidate.id
			where candidate.status = 'queued' and not public.qorpera_execution_sponsor_available(candidate_run)
			order by candidate.id for update of candidate skip locked);$old$,
	$new$	with doomed as materialized (
		select candidate.id
		from public.qorpera_runner_jobs as candidate
		join public.qorpera_execution_runs as candidate_run on candidate_run.job_id = candidate.id
		where candidate.status = 'queued' and not public.qorpera_execution_sponsor_available(candidate_run)
		order by candidate.id
		limit 100
		for update of candidate skip locked
	)
	update public.qorpera_runner_jobs as job
	set status = 'failed', finished_at = statement_timestamp(),
		last_error = 'Execution sponsor, model policy, or quota reservation is unavailable'
	from doomed
	where job.id = doomed.id and job.status = 'queued';$new$,
	'reconcile_queued_sponsor_limit'
);

select pg_temp.rpc_patch(
	'public.qorpera_reconcile_runner_orchestrator_without_sponsored_turns(uuid)'::regprocedure,
	$old$	update public.qorpera_runner_jobs as job
	set status = 'failed', finished_at = statement_timestamp(),
		last_error = 'Pinned logical computer is unavailable or incompatible'
	from public.qorpera_execution_runs as run
	where job.id = run.job_id and job.status = 'queued'
		and not public.qorpera_execution_compute_available(run)
		and job.id in (select candidate.id from public.qorpera_runner_jobs as candidate
			join public.qorpera_execution_runs as candidate_run on candidate_run.job_id = candidate.id
			where candidate.status = 'queued' and not public.qorpera_execution_compute_available(candidate_run)
			order by candidate.id for update of candidate skip locked);$old$,
	$new$	with doomed as materialized (
		select candidate.id
		from public.qorpera_runner_jobs as candidate
		join public.qorpera_execution_runs as candidate_run on candidate_run.job_id = candidate.id
		where candidate.status = 'queued' and not public.qorpera_execution_compute_available(candidate_run)
		order by candidate.id
		limit 100
		for update of candidate skip locked
	)
	update public.qorpera_runner_jobs as job
	set status = 'failed', finished_at = statement_timestamp(),
		last_error = 'Pinned logical computer is unavailable or incompatible'
	from doomed
	where job.id = doomed.id and job.status = 'queued';$new$,
	'reconcile_queued_compute_limit'
);

select pg_temp.rpc_patch(
	'public.qorpera_reconcile_runner_orchestrator_without_sponsored_turns(uuid)'::regprocedure,
	$old$	update public.qorpera_runner_jobs as job
	set status = 'failed', finished_at = statement_timestamp(),
		last_error = 'Out of computer hours [code=COMPUTER_HOURS_EXHAUSTED]'
	from public.qorpera_execution_runs as run
	where job.id = run.job_id and job.status = 'queued'
		and job.id in (select candidate.id from public.qorpera_runner_jobs as candidate
			join public.qorpera_execution_runs as candidate_run on candidate_run.job_id = candidate.id
			where candidate.status = 'queued'
				and public.qorpera_computer_hour_finish_window_over(candidate_run.profile_id, statement_timestamp())
			order by candidate.id for update of candidate skip locked);$old$,
	$new$	with doomed as materialized (
		select candidate.id
		from public.qorpera_runner_jobs as candidate
		join public.qorpera_execution_runs as candidate_run on candidate_run.job_id = candidate.id
		where candidate.status = 'queued'
			and public.qorpera_computer_hour_finish_window_over(candidate_run.profile_id, statement_timestamp())
		order by candidate.id
		limit 100
		for update of candidate skip locked
	)
	update public.qorpera_runner_jobs as job
	set status = 'failed', finished_at = statement_timestamp(),
		last_error = 'Out of computer hours [code=COMPUTER_HOURS_EXHAUSTED]'
	from doomed
	where job.id = doomed.id and job.status = 'queued';$new$,
	'reconcile_queued_hours_limit'
);

select pg_temp.rpc_patch(
	'public.qorpera_reconcile_runner_orchestrator_without_sponsored_turns(uuid)'::regprocedure,
	$old$	update public.qorpera_runner_jobs as job
	set status = 'failed', finished_at = statement_timestamp(),
		last_error = 'No computer could start the run within a day'
	from public.qorpera_execution_runs as run
	where job.id = run.job_id and job.status = 'queued'
		and (run.deadline_at <= statement_timestamp() or job.queued_at <= statement_timestamp() - interval '24 hours')
		and job.id in (select candidate.id from public.qorpera_runner_jobs as candidate
			join public.qorpera_execution_runs as candidate_run on candidate_run.job_id = candidate.id
			where candidate.status = 'queued' and (candidate_run.deadline_at <= statement_timestamp()
				or candidate.queued_at <= statement_timestamp() - interval '24 hours')
			order by candidate.id for update of candidate skip locked);$old$,
	$new$	with doomed as materialized (
		select candidate.id
		from public.qorpera_runner_jobs as candidate
		join public.qorpera_execution_runs as candidate_run on candidate_run.job_id = candidate.id
		where candidate.status = 'queued' and (candidate_run.deadline_at <= statement_timestamp()
			or candidate.queued_at <= statement_timestamp() - interval '24 hours')
		order by candidate.id
		limit 100
		for update of candidate skip locked
	)
	update public.qorpera_runner_jobs as job
	set status = 'failed', finished_at = statement_timestamp(),
		last_error = 'No computer could start the run within a day'
	from doomed
	where job.id = doomed.id and job.status = 'queued';$new$,
	'reconcile_queued_deadline_limit'
);

select pg_temp.rpc_patch(
	'public.qorpera_reconcile_runner_orchestrator_without_sponsored_turns(uuid)'::regprocedure,
	$old$			or public.qorpera_computer_hour_finish_window_over(run.profile_id, statement_timestamp())
		)
		for update skip locked$old$,
	$new$			or public.qorpera_computer_hour_finish_window_over(run.profile_id, statement_timestamp())
		)
		order by job.id
		limit 100
		for update of job skip locked$new$,
	'reconcile_leased_jobs_limit'
);

select pg_temp.rpc_patch(
	'public.qorpera_reconcile_runner_orchestrator_without_sponsored_turns(uuid)'::regprocedure,
	$old$	update public.qorpera_runner_assignments as assignment
	set status = 'expired', last_error = 'Assignment was not accepted before expiry'
	where assignment.status = 'offered' and assignment.expires_at <= statement_timestamp()
		and assignment.id in (select candidate.id from public.qorpera_runner_assignments as candidate
			where candidate.status = 'offered' and candidate.expires_at <= statement_timestamp()
			order by candidate.id for update skip locked);$old$,
	$new$	with doomed as materialized (
		select candidate.id
		from public.qorpera_runner_assignments as candidate
		where candidate.status = 'offered' and candidate.expires_at <= statement_timestamp()
		order by candidate.expires_at, candidate.id
		limit 200
		for update skip locked
	)
	update public.qorpera_runner_assignments as assignment
	set status = 'expired', last_error = 'Assignment was not accepted before expiry'
	from doomed
	where assignment.id = doomed.id and assignment.status = 'offered';$new$,
	'reconcile_assignments_limit'
);

select pg_temp.rpc_patch(
	'public.qorpera_reconcile_runner_orchestrator_without_sponsored_turns(uuid)'::regprocedure,
	$old$	update public.qorpera_runner_job_claims as claim
	set status = 'released', released_at = statement_timestamp(),
		release_reason = 'Orchestrator claim expired before runner acceptance'
	where claim.status in ('claimed', 'assigned') and claim.lease_expires_at <= statement_timestamp()
		and claim.id in (select candidate.id from public.qorpera_runner_job_claims as candidate
			where candidate.status in ('claimed', 'assigned') and candidate.lease_expires_at <= statement_timestamp()
			order by candidate.id for update skip locked);$old$,
	$new$	with doomed as materialized (
		select candidate.id
		from public.qorpera_runner_job_claims as candidate
		where candidate.status in ('claimed', 'assigned') and candidate.lease_expires_at <= statement_timestamp()
		order by candidate.lease_expires_at, candidate.id
		limit 200
		for update skip locked
	)
	update public.qorpera_runner_job_claims as claim
	set status = 'released', released_at = statement_timestamp(),
		release_reason = 'Orchestrator claim expired before runner acceptance'
	from doomed
	where claim.id = doomed.id and claim.status in ('claimed', 'assigned');$new$,
	'reconcile_claims_limit'
);

select pg_temp.rpc_patch(
	'public.qorpera_claim_company_mail(integer,uuid)'::regprocedure,
	$old$	update public.qorpera_company_mail_outbox set body = null
	where id in (select id from public.qorpera_company_mail_outbox
		where body is not null and status in ('sent', 'failed', 'cancelled') and settled_at < v_now - interval '7 days'
		order by settled_at limit 500);$old$,
	$new$	with doomed as materialized (
		select id from public.qorpera_company_mail_outbox
		where body is not null and status in ('sent', 'failed', 'cancelled') and settled_at < v_now - interval '7 days'
		order by settled_at, id
		limit 500
		for update skip locked
	)
	update public.qorpera_company_mail_outbox as mail
	set body = null
	from doomed
	where mail.id = doomed.id;$new$,
	'claim_company_mail_body_cleanup_skip_locked'
);

select pg_temp.rpc_patch(
	'public.qorpera_claim_company_mail(integer,uuid)'::regprocedure,
	$old$	delete from public.qorpera_mail_threads where id in (select id from public.qorpera_mail_threads
		where last_at < v_now - interval '30 days' order by last_at limit 500);$old$,
	$new$	with doomed as materialized (
		select id from public.qorpera_mail_threads
		where last_at < v_now - interval '30 days'
		order by last_at, id
		limit 500
		for update skip locked
	)
	delete from public.qorpera_mail_threads as thread
	using doomed
	where thread.id = doomed.id;$new$,
	'claim_company_mail_thread_cleanup_skip_locked'
);

select pg_temp.rpc_patch(
	'public.qorpera_claim_company_mail(integer,uuid)'::regprocedure,
	$old$	update public.qorpera_company_mail_outbox as mail
	set status = 'cancelled', settled_at = v_now, lease_id = null, lease_expires_at = null,
		last_error = case when public.qorpera_company_deleting(mail.profile_id) then 'The company is being deleted'
			when mailbox.removed_at is not null then 'The mailbox was removed'
			else 'The mailbox was paused' end
			|| case when mail.attempt_count > 0 then '; an earlier attempt may have gone out' else '' end
	from public.qorpera_company_mailboxes as mailbox, public.qorpera_event_hooks as hook
	where mailbox.id = mail.mailbox_id and hook.id = mailbox.hook_id
		and (mail.status in ('pending', 'retrying') or (mail.status = 'delivering' and mail.lease_expires_at <= v_now))
		and (mailbox.removed_at is not null or hook.status <> 'active' or public.qorpera_company_deleting(mail.profile_id));$old$,
	$new$	with doomed as materialized (
		select candidate.id, candidate_mailbox.removed_at, public.qorpera_company_deleting(candidate.profile_id) as deleting
		from public.qorpera_company_mail_outbox as candidate
		join public.qorpera_company_mailboxes as candidate_mailbox on candidate_mailbox.id = candidate.mailbox_id
		join public.qorpera_event_hooks as candidate_hook on candidate_hook.id = candidate_mailbox.hook_id
		where (candidate.status in ('pending', 'retrying')
				or (candidate.status = 'delivering' and candidate.lease_expires_at <= v_now))
			and (candidate_mailbox.removed_at is not null or candidate_hook.status <> 'active'
				or public.qorpera_company_deleting(candidate.profile_id))
		order by candidate.id
		limit 200
		for update of candidate skip locked
	)
	update public.qorpera_company_mail_outbox as mail
	set status = 'cancelled', settled_at = v_now, lease_id = null, lease_expires_at = null,
		last_error = case when doomed.deleting then 'The company is being deleted'
			when doomed.removed_at is not null then 'The mailbox was removed'
			else 'The mailbox was paused' end
			|| case when mail.attempt_count > 0 then '; an earlier attempt may have gone out' else '' end
	from doomed
	where mail.id = doomed.id
		and (mail.status in ('pending', 'retrying') or (mail.status = 'delivering' and mail.lease_expires_at <= v_now));$new$,
	'claim_company_mail_cancel_limit'
);

select pg_temp.rpc_patch(
	'public.qorpera_claim_company_mail(integer,uuid)'::regprocedure,
	$old$	update public.qorpera_company_mail_outbox as mail
	set status = 'failed', settled_at = v_now, lease_id = null, lease_expires_at = null,
		last_error = left(case when mail.attempt_count >= 8 then coalesce(mail.last_error, 'Gave up after eight attempts')
			else 'Not sent within a day' end
			|| case when mail.attempt_count > 0 then '; an earlier attempt may have gone out' else '' end, 1000)
	where (mail.status in ('pending', 'retrying') or (mail.status = 'delivering' and mail.lease_expires_at <= v_now))
		and (mail.created_at <= v_now - interval '1 day'
			or (mail.status = 'delivering' and mail.attempt_count >= 8));$old$,
	$new$	with doomed as materialized (
		select candidate.id
		from public.qorpera_company_mail_outbox as candidate
		where (candidate.status in ('pending', 'retrying')
				or (candidate.status = 'delivering' and candidate.lease_expires_at <= v_now))
			and (candidate.created_at <= v_now - interval '1 day'
				or (candidate.status = 'delivering' and candidate.attempt_count >= 8))
		order by candidate.id
		limit 200
		for update of candidate skip locked
	)
	update public.qorpera_company_mail_outbox as mail
	set status = 'failed', settled_at = v_now, lease_id = null, lease_expires_at = null,
		last_error = left(case when mail.attempt_count >= 8 then coalesce(mail.last_error, 'Gave up after eight attempts')
			else 'Not sent within a day' end
			|| case when mail.attempt_count > 0 then '; an earlier attempt may have gone out' else '' end, 1000)
	from doomed
	where mail.id = doomed.id
		and (mail.status in ('pending', 'retrying') or (mail.status = 'delivering' and mail.lease_expires_at <= v_now));$new$,
	'claim_company_mail_fail_limit'
);

select pg_temp.rpc_patch(
	'public.qorpera_claim_company_mail(integer,uuid)'::regprocedure,
	$old$	with candidates as (
		select mail.id, mail.next_attempt_at, mail.created_at, mail.attachment_bytes
		from public.qorpera_company_mail_outbox as mail
		where mail.status in ('pending', 'retrying', 'delivering')
			and mail.next_attempt_at <= v_now
			and (mail.lease_expires_at is null or mail.lease_expires_at <= v_now)
		order by mail.next_attempt_at, mail.created_at
		for update skip locked
		limit p_limit
	), budgeted as ($old$,
	$new$	with candidates as (
		select mail.id, mail.next_attempt_at, mail.created_at, mail.attachment_bytes
		from public.qorpera_company_mail_outbox as mail
		join public.qorpera_company_mailboxes as mailbox on mailbox.id = mail.mailbox_id
		join public.qorpera_event_hooks as hook on hook.id = mailbox.hook_id
		where mail.status in ('pending', 'retrying', 'delivering')
			and mail.next_attempt_at <= v_now
			and (mail.lease_expires_at is null or mail.lease_expires_at <= v_now)
			and mailbox.removed_at is null
			and hook.status = 'active'
			and not public.qorpera_company_deleting(mail.profile_id)
			and mail.created_at > v_now - interval '1 day'
			and not (mail.status = 'delivering' and mail.attempt_count >= 8)
		order by mail.next_attempt_at, mail.created_at
		for update of mail skip locked
		limit p_limit
	), budgeted as ($new$,
	'claim_company_mail_candidates_exclusions'
);

select pg_temp.rpc_patch(
	'public.qorpera_claim_computer_hour_notices(integer,uuid)'::regprocedure,
	$old$	update public.qorpera_computer_hour_notices notice
	set status = 'cancelled',
		last_error = case when notice.occasion like '%:zero:%' then 'The company was no longer out of hours when it was due'
			else 'Hours arrived before it was sent' end,
		lease_id = null, lease_expires_at = null
	where (notice.status in ('pending', 'retrying') or (notice.status = 'delivering' and notice.lease_expires_at <= v_now))
		and notice.kind = 'out_of_hours'
		-- Still the same time of owing: hours arriving (even some) name a new one, which has its own notice.
		and not exists (
			select 1 from public.qorpera_computer_hour_sources owed
			where owed.kind = 'owed' and owed.profile_id = notice.profile_id and not owed.dry_run
				and owed.drawn_seconds > owed.repaid_seconds
				and notice.occasion = notice.profile_id::text || ':' || owed.repaid_seconds::text
		)
		-- Still the same time at zero: leaving zero ends it, and running out again is a new one.
		and not exists (
			select 1 from public.qorpera_computer_hour_zero_state zero
			where zero.profile_id = notice.profile_id
				and notice.occasion = public.qorpera_computer_hour_zero_occasion(zero.profile_id, zero.ran_out_at)
				and public.qorpera_company_at_zero(zero.profile_id, v_now)
		);$old$,
	$new$	with doomed as materialized (
		select candidate.id
		from public.qorpera_computer_hour_notices as candidate
		where (candidate.status in ('pending', 'retrying')
				or (candidate.status = 'delivering' and candidate.lease_expires_at <= v_now))
			and candidate.kind = 'out_of_hours'
			and not exists (
				select 1 from public.qorpera_computer_hour_sources owed
				where owed.kind = 'owed' and owed.profile_id = candidate.profile_id and not owed.dry_run
					and owed.drawn_seconds > owed.repaid_seconds
					and candidate.occasion = candidate.profile_id::text || ':' || owed.repaid_seconds::text
			)
			and not exists (
				select 1 from public.qorpera_computer_hour_zero_state zero
				where zero.profile_id = candidate.profile_id
					and candidate.occasion = public.qorpera_computer_hour_zero_occasion(zero.profile_id, zero.ran_out_at)
					and public.qorpera_company_at_zero(zero.profile_id, v_now)
			)
		order by candidate.id
		limit 200
		for update of candidate skip locked
	)
	update public.qorpera_computer_hour_notices notice
	set status = 'cancelled',
		last_error = case when notice.occasion like '%:zero:%' then 'The company was no longer out of hours when it was due'
			else 'Hours arrived before it was sent' end,
		lease_id = null, lease_expires_at = null
	from doomed
	where notice.id = doomed.id
		and (notice.status in ('pending', 'retrying') or (notice.status = 'delivering' and notice.lease_expires_at <= v_now))
		and notice.kind = 'out_of_hours';$new$,
	'claim_computer_hour_notices_out_of_hours_limit'
);

select pg_temp.rpc_patch(
	'public.qorpera_claim_computer_hour_notices(integer,uuid)'::regprocedure,
	$old$	update public.qorpera_computer_hour_notices notice
	set status = 'cancelled', occasion = notice.occasion || ':dropped:' || notice.id::text,
		last_error = case
			when hours.left_seconds is null then 'The company no longer pays for its hours'
			when owing.id is not null or zero.profile_id is not null then 'The company ran out before it was sent'
			else 'Hours arrived before it was sent' end,
		lease_id = null, lease_expires_at = null
	from public.qorpera_computer_hour_notices open_notice
	cross join lateral public.qorpera_computer_hour_notice_hours(open_notice.profile_id, v_now) hours
	left join public.qorpera_computer_hour_sources owing
		on owing.kind = 'owed' and owing.profile_id = open_notice.profile_id and not owing.dry_run
			and owing.drawn_seconds > owing.repaid_seconds
	left join public.qorpera_computer_hour_zero_state zero on zero.profile_id = open_notice.profile_id
	where notice.id = open_notice.id
		and (open_notice.status in ('pending', 'retrying')
			or (open_notice.status = 'delivering' and open_notice.lease_expires_at <= v_now))
		and open_notice.kind = 'running_low'
		-- Again on the row being updated, so a notice another claim just leased is left alone.
		and (notice.status in ('pending', 'retrying') or (notice.status = 'delivering' and notice.lease_expires_at <= v_now))
		and notice.kind = 'running_low'
		and (hours.left_seconds is null or owing.id is not null or zero.profile_id is not null
			or (hours.left_seconds >= 3600 and hours.left_seconds * 5 > hours.hours_seconds));$old$,
	$new$	with doomed as materialized (
		select open_notice.id, hours.left_seconds,
			exists (
				select 1 from public.qorpera_computer_hour_sources owing
				where owing.kind = 'owed' and owing.profile_id = open_notice.profile_id and not owing.dry_run
					and owing.drawn_seconds > owing.repaid_seconds
			) as has_owing,
			(zero.profile_id is not null) as at_zero
		from public.qorpera_computer_hour_notices open_notice
		cross join lateral public.qorpera_computer_hour_notice_hours(open_notice.profile_id, v_now) hours
		left join public.qorpera_computer_hour_zero_state zero on zero.profile_id = open_notice.profile_id
		where (open_notice.status in ('pending', 'retrying')
				or (open_notice.status = 'delivering' and open_notice.lease_expires_at <= v_now))
			and open_notice.kind = 'running_low'
			and (hours.left_seconds is null
				or exists (
					select 1 from public.qorpera_computer_hour_sources owing
					where owing.kind = 'owed' and owing.profile_id = open_notice.profile_id and not owing.dry_run
						and owing.drawn_seconds > owing.repaid_seconds
				)
				or zero.profile_id is not null
				or (hours.left_seconds >= 3600 and hours.left_seconds * 5 > hours.hours_seconds))
		order by open_notice.id
		limit 200
		for update of open_notice skip locked
	)
	update public.qorpera_computer_hour_notices notice
	set status = 'cancelled', occasion = notice.occasion || ':dropped:' || notice.id::text,
		last_error = case
			when doomed.left_seconds is null then 'The company no longer pays for its hours'
			when doomed.has_owing or doomed.at_zero then 'The company ran out before it was sent'
			else 'Hours arrived before it was sent' end,
		lease_id = null, lease_expires_at = null
	from doomed
	where notice.id = doomed.id
		and (notice.status in ('pending', 'retrying') or (notice.status = 'delivering' and notice.lease_expires_at <= v_now))
		and notice.kind = 'running_low';$new$,
	'claim_computer_hour_notices_running_low_limit'
);

select pg_temp.rpc_patch(
	'public.qorpera_claim_computer_hour_notices(integer,uuid)'::regprocedure,
	$old$	update public.qorpera_computer_hour_notices notice
	set status = 'failed', last_error = 'The recipient is no longer a founder of the company', lease_id = null,
		lease_expires_at = null
	where (notice.status in ('pending', 'retrying') or (notice.status = 'delivering' and notice.lease_expires_at <= v_now))
		and notice.profile_id is not null
		and not exists (
			select 1 from public.qorpera_company_founders(notice.profile_id) founder where founder.user_id = notice.user_id
		);$old$,
	$new$	with doomed as materialized (
		select candidate.id
		from public.qorpera_computer_hour_notices as candidate
		where (candidate.status in ('pending', 'retrying')
				or (candidate.status = 'delivering' and candidate.lease_expires_at <= v_now))
			and candidate.profile_id is not null
			and not exists (
				select 1 from public.qorpera_company_founders(candidate.profile_id) founder
				where founder.user_id = candidate.user_id
			)
		order by candidate.id
		limit 200
		for update of candidate skip locked
	)
	update public.qorpera_computer_hour_notices notice
	set status = 'failed', last_error = 'The recipient is no longer a founder of the company', lease_id = null,
		lease_expires_at = null
	from doomed
	where notice.id = doomed.id
		and (notice.status in ('pending', 'retrying') or (notice.status = 'delivering' and notice.lease_expires_at <= v_now));$new$,
	'claim_computer_hour_notices_founder_limit'
);

select pg_temp.rpc_patch(
	'public.qorpera_claim_computer_hour_notices(integer,uuid)'::regprocedure,
	$old$	update public.qorpera_computer_hour_notices notice
	set status = 'failed', last_error = 'The recipient has no email address', lease_id = null, lease_expires_at = null
	where (notice.status in ('pending', 'retrying') or (notice.status = 'delivering' and notice.lease_expires_at <= v_now))
		and not exists (
			select 1 from auth.users recipient
			where recipient.id = notice.user_id and nullif(btrim(recipient.email), '') is not null
		);$old$,
	$new$	with doomed as materialized (
		select candidate.id
		from public.qorpera_computer_hour_notices as candidate
		where (candidate.status in ('pending', 'retrying')
				or (candidate.status = 'delivering' and candidate.lease_expires_at <= v_now))
			and not exists (
				select 1 from auth.users recipient
				where recipient.id = candidate.user_id and nullif(btrim(recipient.email), '') is not null
			)
		order by candidate.id
		limit 200
		for update of candidate skip locked
	)
	update public.qorpera_computer_hour_notices notice
	set status = 'failed', last_error = 'The recipient has no email address', lease_id = null, lease_expires_at = null
	from doomed
	where notice.id = doomed.id
		and (notice.status in ('pending', 'retrying') or (notice.status = 'delivering' and notice.lease_expires_at <= v_now));$new$,
	'claim_computer_hour_notices_email_limit'
);

select pg_temp.rpc_patch(
	'public.qorpera_claim_computer_hour_notices(integer,uuid)'::regprocedure,
	$old$	update public.qorpera_computer_hour_notices notice
	set status = 'failed', last_error = coalesce(notice.last_error, 'Gave up after eight attempts'), lease_id = null,
		lease_expires_at = null
	where notice.status = 'delivering' and notice.lease_expires_at <= v_now and notice.attempt_count >= 8;$old$,
	$new$	with doomed as materialized (
		select candidate.id
		from public.qorpera_computer_hour_notices as candidate
		where candidate.status = 'delivering' and candidate.lease_expires_at <= v_now and candidate.attempt_count >= 8
		order by candidate.id
		limit 200
		for update of candidate skip locked
	)
	update public.qorpera_computer_hour_notices notice
	set status = 'failed', last_error = coalesce(notice.last_error, 'Gave up after eight attempts'), lease_id = null,
		lease_expires_at = null
	from doomed
	where notice.id = doomed.id
		and notice.status = 'delivering' and notice.lease_expires_at <= v_now and notice.attempt_count >= 8;$new$,
	'claim_computer_hour_notices_attempts_limit'
);

select pg_temp.rpc_patch(
	'public.qorpera_claim_computer_hour_notices(integer,uuid)'::regprocedure,
	$old$	with candidates as (
		select notice.id
		from public.qorpera_computer_hour_notices notice
		where notice.status in ('pending', 'retrying', 'delivering')
			and notice.next_attempt_at <= v_now
			and (notice.lease_expires_at is null or notice.lease_expires_at <= v_now)
		order by notice.next_attempt_at, notice.created_at
		for update skip locked
		limit p_limit
	), claimed as ($old$,
	$new$	with candidates as (
		select notice.id
		from public.qorpera_computer_hour_notices notice
		where notice.status in ('pending', 'retrying', 'delivering')
			and notice.next_attempt_at <= v_now
			and (notice.lease_expires_at is null or notice.lease_expires_at <= v_now)
			and not (notice.status = 'delivering' and notice.attempt_count >= 8)
			and exists (
				select 1 from auth.users recipient
				where recipient.id = notice.user_id and nullif(btrim(recipient.email), '') is not null
			)
			and (notice.profile_id is null or exists (
				select 1 from public.qorpera_company_founders(notice.profile_id) founder
				where founder.user_id = notice.user_id
			))
			and (notice.kind <> 'out_of_hours'
				or exists (
					select 1 from public.qorpera_computer_hour_sources owed
					where owed.kind = 'owed' and owed.profile_id = notice.profile_id and not owed.dry_run
						and owed.drawn_seconds > owed.repaid_seconds
						and notice.occasion = notice.profile_id::text || ':' || owed.repaid_seconds::text
				)
				or exists (
					select 1 from public.qorpera_computer_hour_zero_state zero
					where zero.profile_id = notice.profile_id
						and notice.occasion = public.qorpera_computer_hour_zero_occasion(zero.profile_id, zero.ran_out_at)
						and public.qorpera_company_at_zero(zero.profile_id, v_now)
				))
			and (notice.kind <> 'running_low' or (
				not exists (
					select 1 from public.qorpera_computer_hour_sources owing
					where owing.kind = 'owed' and owing.profile_id = notice.profile_id and not owing.dry_run
						and owing.drawn_seconds > owing.repaid_seconds
				)
				and not exists (
					select 1 from public.qorpera_computer_hour_zero_state zero
					where zero.profile_id = notice.profile_id
				)
				and exists (
					select 1 from public.qorpera_computer_hour_notice_hours(notice.profile_id, v_now) hours
					where hours.left_seconds is not null
						and not coalesce(hours.left_seconds >= 3600 and hours.left_seconds * 5 > hours.hours_seconds, false)
				)
			))
		order by notice.next_attempt_at, notice.created_at
		for update of notice skip locked
		limit p_limit
	), claimed as ($new$,
	'claim_computer_hour_notices_candidates_exclusions'
);

select pg_temp.rpc_patch(
	'public.qorpera_claim_profile_invitation_deliveries(integer,uuid)'::regprocedure,
	$old$	delete from public.qorpera_profile_invitations
	where expires_at <= statement_timestamp();$old$,
	$new$	with doomed as materialized (
		select invitation.id
		from public.qorpera_profile_invitations as invitation
		where invitation.expires_at <= statement_timestamp()
		order by invitation.expires_at, invitation.id
		limit 200
		for update skip locked
	)
	delete from public.qorpera_profile_invitations as invitation
	using doomed
	where invitation.id = doomed.id;$new$,
	'claim_profile_invitation_deliveries_expire_limit'
);

create or replace function public.qorpera_list_coding_machines(p_owner text, p_machine_id_sha256 text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_now timestamptz := clock_timestamp();
begin
	if auth.role() is distinct from 'service_role' or coalesce(p_owner,'') !~ '^[A-Za-z0-9_.:-]{1,120}$'
		or coalesce(p_machine_id_sha256,'') !~ '^[0-9a-f]{64}$' then
		raise exception 'Coding machine custody required' using errcode = '42501'; end if;
	return coalesce((
		with machines as materialized (
			select machine.id, machine.profile_id, machine.environment_id, machine.member_user_id,
				machine.kind, machine.worker_id, machine.binding, machine.instance_sha256,
				machine.removing_at, machine.retire_requested_at, machine.last_used_at,
				machine.busy_at, machine.created_at, machine.last_error, machine.last_error_at,
				executor.vm_policy, executor.machine_sleep_after_seconds, executor.machine_remove_after_seconds,
				demand.reserved_at, demand.suspended_at,
				allocation.released_at
			from public.qorpera_coding_machines machine
			left join public.qorpera_coding_executors executor
				on executor.environment_id = machine.environment_id and executor.owner = machine.owner
			left join public.qorpera_runtime_node_demands demand
				on demand.allocation_id = machine.id and demand.released_at is null
			left join public.qorpera_runtime_machine_allocations allocation
				on allocation.id = machine.id
			where machine.owner = p_owner
				and machine.machine_id_sha256 = p_machine_id_sha256
				and machine.removed_at is null
		),
		live_machines as (
			select distinct session.vm_allocation_id as machine_id
			from public.qorpera_coding_sessions session
			where session.vm_allocation_id in (select id from machines)
				and session.phase in ('preparing', 'running', 'publishing')
				and session.lease_until > v_now
		),
		attached_sessions as (
			select session.attached_machine_id as machine_id,
				jsonb_agg(
					jsonb_build_object('workerId', session.worker_id, 'attachmentToken', session.attachment_token)
					order by session.worker_id
				) as attached
			from public.qorpera_coding_sessions session
			where session.attached_machine_id in (select id from machines)
			group by session.attached_machine_id
		),
		open_machine_sessions as (
			select distinct session.vm_allocation_id as machine_id
			from public.qorpera_coding_sessions session
			where session.vm_allocation_id in (select id from machines where kind <> 'session')
				and session.archived_at is null
		),
		profile_finish_window as (
			select profiles.profile_id,
				public.qorpera_computer_hour_coding_finish_window_over(profiles.profile_id, v_now) as finish_over
			from (select distinct profile_id from machines where kind = 'member') profiles
		)
		select jsonb_agg(entry order by entry ->> 'createdAt', entry ->> 'machineId')
		from (
			select jsonb_build_object(
				'schema', 'qorpera.coding-machine-state/v1',
				'machineId', machine.id,
				'kind', machine.kind,
				'workerId', machine.worker_id,
				'binding', machine.binding,
				'instanceSha256', machine.instance_sha256,
				'live', state.live,
				'reserved', state.reserved,
				'asleepSince', machine.suspended_at,
				'removing', machine.removing_at is not null,
				'superseded', state.superseded,
				'released', state.released,
				'lastUsedAt', machine.last_used_at,
				'createdAt', machine.created_at,
				'lastError', machine.last_error,
				'lastErrorAt', machine.last_error_at,
				'sleepDue', machine.kind = 'member' and not state.live and state.reserved and not state.superseded
					and (greatest(machine.last_used_at, coalesce(machine.busy_at, machine.last_used_at))
							<= v_now - make_interval(secs => machine.machine_sleep_after_seconds)
						or coalesce(finish.finish_over, false)),
				'attached', coalesce(attached.attached, '[]'::jsonb),
				'removeDue', not state.live and (
					machine.removing_at is not null
					or state.superseded
					or state.released
					or (machine.suspended_at is not null
						and machine.suspended_at <= v_now - make_interval(secs => machine.machine_remove_after_seconds)
						and (machine.kind = 'session' or open_session.machine_id is null))
					or (not state.reserved and machine.suspended_at is null
						and machine.last_used_at <= v_now - make_interval(secs => machine.machine_remove_after_seconds))
				)
			) as entry
			from machines machine
			left join live_machines live on live.machine_id = machine.id
			left join attached_sessions attached on attached.machine_id = machine.id
			left join open_machine_sessions open_session on open_session.machine_id = machine.id
			left join profile_finish_window finish on finish.profile_id = machine.profile_id
			cross join lateral (
				select (live.machine_id is not null) as live,
					(machine.released_at is not null) as released,
					(machine.reserved_at is not null and machine.suspended_at is null) as reserved,
					(machine.kind = 'session'
						or machine.retire_requested_at is not null
						or machine.vm_policy is null
						or machine.binding - array['schema','machineId','companyId','environmentId','memberUserId'] <> machine.vm_policy) as superseded
			) state
		) listed
	), '[]'::jsonb);
end
$$;

select pg_temp.rpc_patch(
	'public.qorpera_site_count_upkeep(timestamptz)'::regprocedure,
	$old$		delete from public.qorpera_site_counts as hour
		where hour.hour < least(v_until, v_now - interval '35 days');
		get diagnostics v_hours = row_count;
		delete from public.qorpera_site_session_seen as seen where seen.last_view_at < v_now - interval '1 hour';$old$,
	$new$		with doomed as materialized (
			select doomed.ctid from public.qorpera_site_counts as doomed
			where doomed.hour < least(v_until, v_now - interval '35 days')
			order by doomed.hour
			limit 5000
			for update skip locked
		)
		delete from public.qorpera_site_counts as hour
		using doomed
		where hour.ctid = doomed.ctid;
		get diagnostics v_hours = row_count;
		with doomed as materialized (
			select doomed.ctid from public.qorpera_site_session_seen as doomed
			where doomed.last_view_at < v_now - interval '1 hour'
			order by doomed.last_view_at
			limit 5000
			for update skip locked
		)
		delete from public.qorpera_site_session_seen as seen
		using doomed
		where seen.ctid = doomed.ctid;$new$,
	'site_count_upkeep_batch_deletes'
);

select pg_temp.rpc_patch(
	'public.qorpera_order_upkeep(timestamptz)'::regprocedure,
	$old$		delete from public.qorpera_orders as o
		where o.rolled and coalesce(o.ordered_at, o.made_at) < v_now - interval '400 days';$old$,
	$new$		with doomed as materialized (
			select doomed.id from public.qorpera_orders as doomed
			where doomed.rolled and coalesce(doomed.ordered_at, doomed.made_at) < v_now - interval '400 days'
			order by coalesce(doomed.ordered_at, doomed.made_at), doomed.id
			limit 5000
			for update skip locked
		)
		delete from public.qorpera_orders as o
		using doomed
		where o.id = doomed.id;$new$,
	'order_upkeep_batch_deletes'
);
