set local lock_timeout = '3s';

do $$ begin
	if strpos(
		coalesce(pg_get_functiondef('public.qorpera_folder_view_renew(uuid,text,timestamptz,uuid)'::regprocedure), ''),
		'20260930917000'
	) > 0 then
		raise exception '20260930917000_coding_cleanup_and_surface_metadata is already applied';
	end if;
	if to_regprocedure('public.qorpera_folder_view_renew(uuid,text,timestamptz,uuid)') is null
		or to_regprocedure('public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)') is null
		or to_regprocedure('public.qorpera_code_request_step(text,text,uuid,uuid,jsonb)') is null
		or to_regprocedure('public.qorpera_surface_site_version_finish(uuid,boolean)') is null
		or to_regprocedure('public.qorpera_surface_complete_merge(uuid,text,text,text,uuid,text[],text,jsonb,uuid)') is null then
		raise exception '20260930917000 requires earlier folder, code-ops, and surface migrations first';
	end if;
end $$;

create temp table ccsm_before as
select oid, to_jsonb(p) - 'prosrc' as fields
from pg_proc p
where p.pronamespace = 'public'::regnamespace
	and p.oid = any(array[
		'public.qorpera_folder_view_renew(uuid,text,timestamptz,uuid)'::regprocedure,
		'public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)'::regprocedure,
		'public.qorpera_code_request_step(text,text,uuid,uuid,jsonb)'::regprocedure,
		'public.qorpera_surface_site_version_finish(uuid,boolean)'::regprocedure,
		'public.qorpera_surface_complete_merge(uuid,text,text,text,uuid,text[],text,jsonb,uuid)'::regprocedure
	]);

create function pg_temp.ccsm_patch(p_target regprocedure, p_edits text[])
returns void language plpgsql as $$
declare
	v_definition text := pg_get_functiondef(p_target);
	v_found integer;
begin
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception '20260930917000 anchor found % time(s) in %, expected 1: %',
				v_found, p_target, left(p_edits[2 * i - 1], 100);
		end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

select pg_temp.ccsm_patch(
	'public.qorpera_folder_view_renew(uuid,text,timestamptz,uuid)'::regprocedure,
	array[
$old$	return jsonb_build_object('schema','qorpera.folder-view-renew/v1','state','open','leaseUntil',v_view.lease_until,
		'kind',v_view.kind,'machineId',v_view.machine_id,'companyId',v_view.profile_id,
		'codingMachineId',case when v_view.kind = 'coding_session' then v_view.machine_id end);$old$,
$new$	-- WHY: 20260930917000 returns workerId on coding_session renewals so folder-service keeps non-owned worktree index refreshes view-local.
	return jsonb_build_object('schema','qorpera.folder-view-renew/v1','state','open','leaseUntil',v_view.lease_until,
		'kind',v_view.kind,'machineId',v_view.machine_id,'companyId',v_view.profile_id,
		'codingMachineId',case when v_view.kind = 'coding_session' then v_view.machine_id end)
		|| case when v_view.kind = 'coding_session' and v_view.worker_id is not null
			then jsonb_build_object('workerId',v_view.worker_id) else '{}'::jsonb end;$new$
	]
);

select pg_temp.ccsm_patch(
	'public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)'::regprocedure,
	array[
$old$						and (
							rw.state = 'active'
							or cs.attached_machine_id is not null
							or cs.vm_allocation_id is not null
							or cs.phase in ('queued', 'preparing', 'running', 'publishing', 'input_ready')$old$,
$new$						and (
							rw.state = 'active'
							or cs.attached_machine_id is not null
							or (cs.lease_token is not null and cs.lease_until > v_now)
							or cs.phase in ('queued', 'preparing', 'running', 'publishing', 'input_ready')$new$
	]
);

select pg_temp.ccsm_patch(
	'public.qorpera_code_request_step(text,text,uuid,uuid,jsonb)'::regprocedure,
	array[
$old$				and session.archived_at is not null
				and session.attached_machine_id is null
				and session.vm_allocation_id is null
				and worker.state <> 'active'$old$,
$new$				and session.archived_at is not null
				and session.attached_machine_id is null
				and (session.lease_token is null or session.lease_until <= clock_timestamp())
				and worker.state <> 'active'$new$
	]
);

select pg_temp.ccsm_patch(
	'public.qorpera_surface_site_version_finish(uuid,boolean)'::regprocedure,
	array[
$old$	v_version public.qorpera_company_site_versions%rowtype;
	v_site public.qorpera_company_sites%rowtype;
	v_now timestamptz := clock_timestamp();$old$,
$new$	v_version public.qorpera_company_site_versions%rowtype;
	v_site public.qorpera_company_sites%rowtype;
	v_surface public.qorpera_surfaces%rowtype;
	v_live_title text;
	v_now timestamptz := clock_timestamp();$new$,
$old$	if coalesce(p_promote_live, false) and v_version.state <> 'live' then
		update public.qorpera_company_site_versions
		set state = 'kept'
		where site_id = v_site.id and state = 'live' and id <> v_version.id;

		update public.qorpera_company_site_versions
		set state = 'live', published_at = coalesce(published_at, v_now)
		where id = v_version.id;
		v_version.state := 'live';

		update public.qorpera_company_sites
		set
			current_version_id = v_version.id,
			title = v_version.title,
			published_at = v_now,
			published_by_user_id = null,
			published_by_staff_agent_id = v_site.created_by_staff_agent_id,
			updated_at = v_now
		where id = v_site.id;
	end if;$old$,
$new$	if coalesce(p_promote_live, false) and v_version.state <> 'live' then
		select * into v_surface
		from public.qorpera_surfaces
		where site_id = v_site.id
		order by created_at asc
		limit 1;

		-- WHY: Preview site versions are uploaded with temporary 'Preview <shortHostId>' titles and must not overwrite the live site title on promotion.
		v_live_title := case
			when coalesce(v_version.title, '') ~ '^Preview [0-9a-f]{8}$' then
				coalesce(
					nullif(btrim(coalesce(v_surface.title, '')), ''),
					case when coalesce(v_site.title, '') !~ '^Preview [0-9a-f]{8}$' then nullif(btrim(v_site.title), '') end,
					v_version.title
				)
			else v_version.title
		end;

		update public.qorpera_company_site_versions
		set state = 'kept'
		where site_id = v_site.id and state = 'live' and id <> v_version.id;

		update public.qorpera_company_site_versions
		set state = 'live', title = v_live_title, published_at = coalesce(published_at, v_now)
		where id = v_version.id;
		v_version.state := 'live';
		v_version.title := v_live_title;

		update public.qorpera_company_sites
		set
			current_version_id = v_version.id,
			title = v_live_title,
			published_at = v_now,
			published_by_user_id = null,
			published_by_staff_agent_id = v_site.created_by_staff_agent_id,
			updated_at = v_now
		where id = v_site.id;
	end if;$new$
	]
);

select pg_temp.ccsm_patch(
	'public.qorpera_surface_complete_merge(uuid,text,text,text,uuid,text[],text,jsonb,uuid)'::regprocedure,
	array[
$old$			update public.qorpera_surfaces
			set
				live_head_sha = coalesce(p_main_after, live_head_sha),
				folder_revision = case when source_kind = 'folder' then folder_revision + 1 else folder_revision end,
				unpublished_change_count = unpublished_change_count + greatest(v_merged_count, 0),
				updated_at = clock_timestamp()
			where id = v_job.surface_id;$old$,
$new$			update public.qorpera_surfaces
			set
				live_head_sha = coalesce(p_main_after, live_head_sha),
				folder_revision = case when source_kind = 'folder' then folder_revision + 1 else folder_revision end,
				unpublished_change_count = unpublished_change_count + greatest(v_merged_count, 0),
				updated_at = clock_timestamp()
			where id = v_job.surface_id;

			if coalesce(p_main_after, '') ~ '^[0-9a-f]{40}$'
				and v_surface.source_kind = 'code_repo'
				and v_surface.repository_key is not null
				and strpos(v_surface.repository_key, '/') > 1 then
				update public.qorpera_code_repositories r
				set
					last_main = p_main_after,
					main_sha = p_main_after
				from public.qorpera_company_cofounders cof
				where cof.profile_id = v_job.profile_id
					and r.environment_id = cof.environment_id
					and r.owner = split_part(v_surface.repository_key, '/', 1)
					and r.name = split_part(v_surface.repository_key, '/', 2);
			end if;$new$,
$old$		if p_status = 'landed' then
			if p_main_after is not null or v_surface.source_kind = 'folder' then
				update public.qorpera_surfaces
				set
					live_head_sha = coalesce(p_main_after, live_head_sha),
					folder_revision = case when source_kind = 'folder' then folder_revision + 1 else folder_revision end,
					updated_at = clock_timestamp()
				where id = v_job.surface_id;
			end if;$old$,
$new$		if p_status = 'landed' then
			if p_main_after is not null or v_surface.source_kind = 'folder' then
				update public.qorpera_surfaces
				set
					live_head_sha = coalesce(p_main_after, live_head_sha),
					folder_revision = case when source_kind = 'folder' then folder_revision + 1 else folder_revision end,
					updated_at = clock_timestamp()
				where id = v_job.surface_id;

				if coalesce(p_main_after, '') ~ '^[0-9a-f]{40}$'
					and v_surface.source_kind = 'code_repo'
					and v_surface.repository_key is not null
					and strpos(v_surface.repository_key, '/') > 1 then
					update public.qorpera_code_repositories r
					set
						last_main = p_main_after,
						main_sha = p_main_after
					from public.qorpera_company_cofounders cof
					where cof.profile_id = v_job.profile_id
						and r.environment_id = cof.environment_id
						and r.owner = split_part(v_surface.repository_key, '/', 1)
						and r.name = split_part(v_surface.repository_key, '/', 2);
				end if;
			end if;$new$
	]
);

update public.qorpera_company_sites site
set
	title = surf.title,
	updated_at = clock_timestamp()
from public.qorpera_surfaces surf
where surf.site_id = site.id
	and nullif(btrim(coalesce(surf.title, '')), '') is not null
	and site.title ~ '^Preview [0-9a-f]{8}$';

update public.qorpera_company_site_versions ver
set title = site.title
from public.qorpera_company_sites site
where site.current_version_id = ver.id
	and ver.title ~ '^Preview [0-9a-f]{8}$'
	and site.title !~ '^Preview [0-9a-f]{8}$';

update public.qorpera_code_repositories r
set
	last_main = surf.live_head_sha,
	main_sha = surf.live_head_sha
from public.qorpera_surfaces surf
join public.qorpera_company_cofounders cof on cof.profile_id = surf.profile_id
where surf.source_kind = 'code_repo'
	and surf.repository_key is not null
	and strpos(surf.repository_key, '/') > 1
	and coalesce(surf.live_head_sha, '') ~ '^[0-9a-f]{40}$'
	and r.environment_id = cof.environment_id
	and r.owner = split_part(surf.repository_key, '/', 1)
	and r.name = split_part(surf.repository_key, '/', 2)
	and (r.last_main is distinct from surf.live_head_sha or r.main_sha is distinct from surf.live_head_sha);

do $$
declare
	v_owner name;
	v_bad text;
begin
	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = 'public.qorpera_surface_site_version_finish(uuid,boolean)'::regprocedure
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception '20260930917000 function has an API owner: %', v_owner;
		end if;
		execute format('grant select on public.qorpera_surfaces to %I', v_owner);
	end loop;

	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = 'public.qorpera_surface_complete_merge(uuid,text,text,text,uuid,text[],text,jsonb,uuid)'::regprocedure
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception '20260930917000 function has an API owner: %', v_owner;
		end if;
		execute format('grant select on public.qorpera_company_cofounders to %I', v_owner);
		execute format('grant select, update on public.qorpera_code_repositories to %I', v_owner);
	end loop;

	select string_agg(p.oid::regprocedure::text, ', ')
	into v_bad
	from pg_proc p
	join ccsm_before b on b.oid = p.oid
	where p.pronamespace = 'public'::regnamespace
		and b.fields is distinct from (to_jsonb(p) - 'prosrc');
	if v_bad is not null then
		raise exception '20260930917000 changed function metadata on: %', v_bad;
	end if;
end $$;

drop function pg_temp.ccsm_patch(regprocedure, text[]);
drop table ccsm_before;
