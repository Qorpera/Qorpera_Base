set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_surface_finalize_publish(public.qorpera_surface_jobs,text,timestamp with time zone)') is not null then
		raise exception 'Surface publish/merge serialization (20260930932000) is already applied';
	end if;
	if to_regprocedure('public.qorpera_publish_surface(uuid)') is null
		or to_regprocedure('public.qorpera_surface_complete_merge(uuid,text,text,text,uuid,text[],text,jsonb,uuid)') is null
		or to_regprocedure('public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)') is null
		or to_regprocedure('public.qorpera_surface_complete_publish(uuid,text,text,text,uuid)') is null
		or to_regprocedure('public.qorpera_surface_preview_build_settle(uuid)') is null then
		raise exception 'Surface publish/merge serialization (20260930932000) requires prior surface publish, merge, claim, and preview build migrations';
	end if;
end $$;

create temporary table spms_before as
select p.oid, to_jsonb(p) - 'prosrc' as fields
from pg_proc as p
where p.pronamespace = 'public'::regnamespace
	and p.oid in (
		'public.qorpera_publish_surface(uuid)'::regprocedure,
		'public.qorpera_surface_complete_merge(uuid,text,text,text,uuid,text[],text,jsonb,uuid)'::regprocedure,
		'public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)'::regprocedure,
		'public.qorpera_surface_complete_publish(uuid,text,text,text,uuid)'::regprocedure,
		'public.qorpera_surface_preview_build_settle(uuid)'::regprocedure
	);

create function pg_temp.spms_patch(p_target regprocedure, p_edits text[])
returns void language plpgsql as $$
declare
	v_definition text := pg_get_functiondef(p_target);
	v_found integer;
begin
	if coalesce(cardinality(p_edits), 0) = 0 or cardinality(p_edits) % 2 <> 0 then
		raise exception '20260930932000 invalid edits for %', p_target;
	end if;
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception '20260930932000 anchor found % time(s) in %, expected 1: %', v_found, p_target, left(p_edits[2 * i - 1], 120);
		end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

create function public.qorpera_surface_finalize_publish(
	p_job public.qorpera_surface_jobs,
	p_published_head_sha text,
	p_now timestamptz default clock_timestamp()
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_surface public.qorpera_surfaces%rowtype;
	v_effective_sha text;
	v_head_matches boolean;
	v_included_ids uuid[];
	v_remaining integer := 0;
	v_has_queued_publish boolean := false;
begin
	select * into v_surface from public.qorpera_surfaces where id = p_job.surface_id for update;
	if v_surface.id is null then
		return;
	end if;

	v_effective_sha := coalesce(nullif(btrim(coalesce(p_published_head_sha, '')), ''), v_surface.live_head_sha);
	v_head_matches := v_surface.live_head_sha is null or v_effective_sha is not distinct from v_surface.live_head_sha;

	if v_head_matches then
		update public.qorpera_surface_changes
		set
			published_at = p_now,
			published_by_user_id = p_job.requested_by_user_id
		where surface_id = p_job.surface_id
			and status = 'merged'
			and published_at is null;
		v_remaining := 0;
	else
		if jsonb_typeof(coalesce(p_job.payload -> 'includedChangeIds', 'null'::jsonb)) = 'array' then
			select coalesce(array_agg(x::uuid), '{}'::uuid[])
			into v_included_ids
			from jsonb_array_elements_text(p_job.payload -> 'includedChangeIds') as x
			where x ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

			if cardinality(v_included_ids) > 0 then
				update public.qorpera_surface_changes
				set
					published_at = p_now,
					published_by_user_id = p_job.requested_by_user_id
				where surface_id = p_job.surface_id
					and status = 'merged'
					and published_at is null
					and id = any(v_included_ids);
			end if;
		else
			update public.qorpera_surface_changes
			set
				published_at = p_now,
				published_by_user_id = p_job.requested_by_user_id
			where surface_id = p_job.surface_id
				and status = 'merged'
				and published_at is null
				and (
					(v_effective_sha is not null and landed_main_after = v_effective_sha)
					or (resolved_at <= p_job.created_at and landed_main_after is distinct from v_surface.live_head_sha)
				);
		end if;

		select count(*)::integer
		into v_remaining
		from public.qorpera_surface_changes
		where surface_id = p_job.surface_id
			and status = 'merged'
			and published_at is null;
		v_remaining := greatest(v_remaining, 1);
	end if;

	select exists (
		select 1
		from public.qorpera_surface_jobs q
		where q.surface_id = p_job.surface_id
			and q.kind = 'publish_surface'
			and q.status = 'queued'
			and q.id <> p_job.id
	) into v_has_queued_publish;

	update public.qorpera_surfaces
	set
		published_head_sha = v_effective_sha,
		unpublished_change_count = v_remaining,
		publish_status = case when v_has_queued_publish then 'publishing' else 'idle' end,
		last_publish_error = null,
		updated_at = p_now
	where id = p_job.surface_id;
end $$;

revoke all on function public.qorpera_surface_finalize_publish(public.qorpera_surface_jobs, text, timestamptz)
	from public, anon, authenticated, service_role;

select pg_temp.spms_patch(
	'public.qorpera_publish_surface(uuid)'::regprocedure,
	array[
$old$	v_user_id uuid;
begin$old$,
$new$	v_user_id uuid;
	v_queued_job_id uuid;
begin$new$,
$old$		insert into public.qorpera_surface_jobs(
			profile_id, surface_id, kind, payload, requested_by_user_id
		)
		values (
			v_surface.profile_id, p_surface_id, 'publish_surface',
			jsonb_build_object('liveHeadSha', v_surface.live_head_sha, 'repositoryKey', v_surface.repository_key),
			v_user_id
		);$old$,
$new$		select j.id into v_queued_job_id
		from public.qorpera_surface_jobs j
		where j.surface_id = p_surface_id
			and j.kind = 'publish_surface'
			and j.status = 'queued'
		order by j.created_at asc, j.id asc
		limit 1
		for update skip locked;

		if v_queued_job_id is not null then
			update public.qorpera_surface_jobs
			set
				payload = jsonb_build_object('repositoryKey', v_surface.repository_key),
				requested_by_user_id = v_user_id,
				updated_at = clock_timestamp()
			where id = v_queued_job_id;
		else
			insert into public.qorpera_surface_jobs(
				profile_id, surface_id, kind, payload, requested_by_user_id
			)
			values (
				v_surface.profile_id, p_surface_id, 'publish_surface',
				jsonb_build_object('repositoryKey', v_surface.repository_key),
				v_user_id
			);
		end if;$new$
	]
);

select pg_temp.spms_patch(
	'public.qorpera_surface_complete_merge(uuid,text,text,text,uuid,text[],text,jsonb,uuid)'::regprocedure,
	array[
$old$	v_repo public.qorpera_code_repositories%rowtype;
begin$old$,
$new$	v_repo public.qorpera_code_repositories%rowtype;
	v_queued_publish_id uuid;
begin$new$,
$old$			if coalesce((v_job.payload ->> 'autoPublish')::boolean, false) then
				insert into public.qorpera_surface_jobs(
					profile_id, surface_id, kind, payload, requested_by_user_id
				)
				values (
					v_job.profile_id, v_job.surface_id, 'publish_surface',
					jsonb_build_object('liveHeadSha', coalesce(p_main_after, v_surface.live_head_sha), 'repositoryKey', v_surface.repository_key),
					v_job.requested_by_user_id
				);
			end if;$old$,
$new$			if coalesce((v_job.payload ->> 'autoPublish')::boolean, false) then
				if v_surface.source_kind = 'code_repo' and v_surface.repository_key is not null then
					update public.qorpera_surfaces
					set
						publish_status = 'publishing',
						last_publish_error = null,
						updated_at = clock_timestamp()
					where id = v_job.surface_id;
				end if;

				select q.id into v_queued_publish_id
				from public.qorpera_surface_jobs q
				where q.surface_id = v_job.surface_id
					and q.kind = 'publish_surface'
					and q.status = 'queued'
				order by q.created_at asc, q.id asc
				limit 1
				for update skip locked;

				if v_queued_publish_id is not null then
					update public.qorpera_surface_jobs
					set
						payload = jsonb_build_object('repositoryKey', v_surface.repository_key),
						requested_by_user_id = v_job.requested_by_user_id,
						updated_at = clock_timestamp()
					where id = v_queued_publish_id;
				else
					insert into public.qorpera_surface_jobs(
						profile_id, surface_id, kind, payload, requested_by_user_id
					)
					values (
						v_job.profile_id, v_job.surface_id, 'publish_surface',
						jsonb_build_object('repositoryKey', v_surface.repository_key),
						v_job.requested_by_user_id
					);
				end if;
			end if;$new$
	]
);

select pg_temp.spms_patch(
	'public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)'::regprocedure,
	array[
$old$			elsif v_expired_job.kind = 'publish_surface' then
				update public.qorpera_surfaces
				set
					publish_status = 'failed',
					last_publish_error = 'Publish worker lease expired',
					updated_at = v_now
				where id = v_expired_job.surface_id;$old$,
$new$			elsif v_expired_job.kind = 'publish_surface' then
				update public.qorpera_surfaces
				set
					publish_status = case
						when exists (
							select 1 from public.qorpera_surface_jobs q
							where q.surface_id = v_expired_job.surface_id
								and q.kind = 'publish_surface'
								and q.status = 'queued'
								and q.id <> v_expired_job.id
						) then 'publishing'
						else 'failed'
					end,
					last_publish_error = 'Publish worker lease expired',
					updated_at = v_now
				where id = v_expired_job.surface_id;$new$,
$old$	with picked as (
		select j.id
		from public.qorpera_surface_jobs j
		join public.qorpera_surfaces surf on surf.id = j.surface_id
		where j.kind = 'publish_surface'
			and j.status = 'queued'
			and not public.qorpera_surface_company_paused(j.profile_id)
			and (
				v_lane = 'all'
				or (v_lane = 'sessions' and surf.source_kind = 'native_ops')
				or (v_lane = 'folder' and surf.source_kind = 'folder')
				or (v_lane = 'code_repo' and surf.source_kind = 'code_repo')
			)
		order by j.created_at asc
		limit v_cap
		for update of j skip locked
	),
	claimed as (
		update public.qorpera_surface_jobs j
		set
			status = 'running',
			attempts = j.attempts + 1,
			lease_expires_at = v_lease,
			lease_token = extensions.gen_random_uuid(),
			updated_at = v_now
		from picked
		where j.id = picked.id
		returning j.*
	)$old$,
$new$	with candidate_publishes as materialized (
		select distinct on (j.surface_id) j.id, j.surface_id, j.created_at
		from public.qorpera_surface_jobs j
		join public.qorpera_surfaces surf on surf.id = j.surface_id
		where j.kind = 'publish_surface'
			and j.status = 'queued'
			and not public.qorpera_surface_company_paused(j.profile_id)
			and (
				v_lane = 'all'
				or (v_lane = 'sessions' and surf.source_kind = 'native_ops')
				or (v_lane = 'folder' and surf.source_kind = 'folder')
				or (v_lane = 'code_repo' and surf.source_kind = 'code_repo')
			)
			and not exists (
				select 1 from public.qorpera_surface_jobs active_j
				where active_j.surface_id = j.surface_id
					and (
						(active_j.kind in ('land_change', 'undo_change') and active_j.status in ('queued', 'running'))
						or (active_j.kind = 'publish_surface' and active_j.status = 'running')
					)
			)
		order by j.surface_id, j.created_at asc, j.id asc
	),
	picked as (
		select j.id, surf.live_head_sha
		from candidate_publishes cp
		join public.qorpera_surface_jobs j on j.id = cp.id
		join public.qorpera_surfaces surf on surf.id = j.surface_id
		where j.status = 'queued'
			and not exists (
				select 1 from public.qorpera_surface_jobs active_j
				where active_j.surface_id = j.surface_id
					and (
						(active_j.kind in ('land_change', 'undo_change') and active_j.status in ('queued', 'running'))
						or (active_j.kind = 'publish_surface' and active_j.status = 'running')
					)
			)
		order by cp.created_at asc, j.id asc
		limit v_cap
		for update of j, surf skip locked
	),
	claimed as (
		update public.qorpera_surface_jobs j
		set
			status = 'running',
			attempts = j.attempts + 1,
			lease_expires_at = v_lease,
			lease_token = extensions.gen_random_uuid(),
			payload = (coalesce(j.payload, '{}'::jsonb) - 'liveHeadSha' - 'requestedHeadSha')
				|| jsonb_strip_nulls(jsonb_build_object(
					'liveHeadSha', coalesce(picked.live_head_sha, nullif(j.payload ->> 'liveHeadSha', ''))
				))
				|| jsonb_build_object(
					'includedChangeIds', coalesce(
						(
							select jsonb_agg(ch.id order by ch.resolved_at asc nulls last, ch.id asc)
							from public.qorpera_surface_changes ch
							where ch.surface_id = j.surface_id
								and ch.status = 'merged'
								and ch.published_at is null
						),
						'[]'::jsonb
					),
					'claimedAt', v_now
				),
			updated_at = v_now
		from picked
		where j.id = picked.id
		returning j.*
	)$new$
	]
);

select pg_temp.spms_patch(
	'public.qorpera_surface_complete_publish(uuid,text,text,text,uuid)'::regprocedure,
	array[
$old$	if p_status = 'published' then
		update public.qorpera_surfaces
		set
			published_head_sha = coalesce(p_published_head_sha, live_head_sha),
			unpublished_change_count = 0,
			publish_status = 'idle',
			last_publish_error = null,
			updated_at = clock_timestamp()
		where id = v_job.surface_id;

		update public.qorpera_surface_changes
		set
			published_at = clock_timestamp(),
			published_by_user_id = v_job.requested_by_user_id
		where surface_id = v_job.surface_id and status = 'merged' and published_at is null;
	else
		update public.qorpera_surfaces
		set
			publish_status = 'failed',
			last_publish_error = p_error_detail,
			updated_at = clock_timestamp()
		where id = v_job.surface_id;
	end if;$old$,
$new$	if p_status = 'published' then
		perform public.qorpera_surface_finalize_publish(v_job, p_published_head_sha, clock_timestamp());
	else
		update public.qorpera_surfaces
		set
			publish_status = case
				when exists (
					select 1 from public.qorpera_surface_jobs q
					where q.surface_id = v_job.surface_id
						and q.kind = 'publish_surface'
						and q.status = 'queued'
						and q.id <> v_job.id
				) then 'publishing'
				else 'failed'
			end,
			last_publish_error = p_error_detail,
			updated_at = clock_timestamp()
		where id = v_job.surface_id;
	end if;$new$
	]
);

select pg_temp.spms_patch(
	'public.qorpera_surface_preview_build_settle(uuid)'::regprocedure,
	array[
$old$				update public.qorpera_surfaces
				set
					published_head_sha = coalesce(v_publish_head_sha, live_head_sha),
					unpublished_change_count = 0,
					publish_status = 'idle',
					last_publish_error = null,
					updated_at = v_now
				where id = v_job.surface_id;
				update public.qorpera_surface_changes
				set
					published_at = v_now,
					published_by_user_id = v_job.requested_by_user_id
				where surface_id = v_job.surface_id and status = 'merged' and published_at is null;$old$,
$new$				perform public.qorpera_surface_finalize_publish(v_job, v_publish_head_sha, v_now);$new$,
$old$					update public.qorpera_surfaces
					set publish_status = 'failed', last_publish_error = v_err, updated_at = v_now
					where id = v_job.surface_id;$old$,
$new$					update public.qorpera_surfaces
					set
						publish_status = case
							when exists (
								select 1 from public.qorpera_surface_jobs q
								where q.surface_id = v_job.surface_id
									and q.kind = 'publish_surface'
									and q.status = 'queued'
									and q.id <> v_job.id
							) then 'publishing'
							else 'failed'
						end,
						last_publish_error = v_err,
						updated_at = v_now
					where id = v_job.surface_id;$new$,
$old$			update public.qorpera_surfaces
			set
				publish_status = 'failed',
				last_publish_error = coalesce(v_build.error_detail,
					public.qorpera_surface_preview_build_detail('PREVIEW_BUILD_FAILED', 'The build was dropped.')),
				updated_at = v_now
			where id = v_job.surface_id;$old$,
$new$			update public.qorpera_surfaces
			set
				publish_status = case
					when exists (
						select 1 from public.qorpera_surface_jobs q
						where q.surface_id = v_job.surface_id
							and q.kind = 'publish_surface'
							and q.status = 'queued'
							and q.id <> v_job.id
					) then 'publishing'
					else 'failed'
				end,
				last_publish_error = coalesce(v_build.error_detail,
					public.qorpera_surface_preview_build_detail('PREVIEW_BUILD_FAILED', 'The build was dropped.')),
				updated_at = v_now
			where id = v_job.surface_id;$new$
	]
);

do $$ begin
	if exists (
		select 1
		from spms_before b
		join pg_proc p on p.oid = b.oid
		where (to_jsonb(p) - 'prosrc') is distinct from b.fields
	) then
		raise exception '20260930932000 changed pg_proc metadata unexpectedly';
	end if;
end $$;
