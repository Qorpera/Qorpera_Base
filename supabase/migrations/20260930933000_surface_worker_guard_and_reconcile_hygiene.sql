set local lock_timeout = '3s';

do $$ begin
	if exists (
		select 1
		from information_schema.columns
		where table_schema = 'public'
			and table_name = 'qorpera_surface_changes'
			and column_name = 'supersede_key'
	) then
		raise exception '20260930933000_surface_worker_guard_and_reconcile_hygiene is already applied';
	end if;
	if to_regprocedure('public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)') is null
		or to_regprocedure('public.qorpera_authorize_coding_turn(jsonb)') is null
		or to_regprocedure('public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)') is null
		or to_regprocedure('public.qorpera_surface_expire_coding_sessions(timestamptz,integer)') is null
		or to_regprocedure('public.qorpera_surface_complete_session_turn(uuid,text,text,jsonb,text[],text,uuid)') is null
		or to_regprocedure('public.qorpera_surface_fail_reconciliation(uuid,text,uuid)') is null
		or to_regprocedure('public.qorpera_surface_complete_preview(uuid,text,text,uuid,jsonb,text,uuid)') is null
		or to_regprocedure('public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)') is null
		or to_regprocedure('public.qorpera_surface_enqueue_silent_reconciliation(uuid,uuid[],text[],uuid,boolean,boolean)') is null
		or to_regprocedure('public.qorpera_surface_sync_coding_completion(public.qorpera_coding_sessions,public.qorpera_runtime_workers,text,text,text,jsonb,jsonb,text[])') is null
		or to_regprocedure('public.qorpera_surface_session_json(public.qorpera_surface_sessions)') is null
		or to_regprocedure('public.qorpera_start_surface_session(uuid,text,text,text,text,jsonb,integer,text,text[])') is null
		or to_regprocedure('public.qorpera_service_start_surface_session(uuid,uuid,text,text,text,text,integer,text,text[])') is null
		or to_regprocedure('public.qorpera_native_surface_start_session(uuid,uuid,text,text,text,text,integer,text,text[])') is null
		or to_regprocedure('public.qorpera_record_surface_change(uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean,text,text,uuid)') is null
		or to_regprocedure('public.qorpera_native_surface_record_change(uuid,uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean,uuid,text,text,uuid)') is null then
		raise exception '20260930933000 requires earlier surface and coding migrations first';
	end if;
end $$;

alter table public.qorpera_surface_sessions
	add column supersede_key text
	check (supersede_key is null or supersede_key ~ '^[a-z0-9][a-z0-9._:-]{0,79}$');

alter table public.qorpera_surface_changes
	add column supersede_key text
	check (supersede_key is null or supersede_key ~ '^[a-z0-9][a-z0-9._:-]{0,79}$');

create index qorpera_surface_changes_surface_supersede_open_idx
	on public.qorpera_surface_changes (surface_id, supersede_key)
	where supersede_key is not null and status in ('staged', 'conflicted');

create temp table swgrh_before as
select oid, to_jsonb(p) - 'prosrc' as fields
from pg_proc p
where p.pronamespace = 'public'::regnamespace
	and p.oid = any(array[
		'public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
		'public.qorpera_authorize_coding_turn(jsonb)'::regprocedure,
		'public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)'::regprocedure,
		'public.qorpera_surface_expire_coding_sessions(timestamptz,integer)'::regprocedure,
		'public.qorpera_surface_complete_session_turn(uuid,text,text,jsonb,text[],text,uuid)'::regprocedure,
		'public.qorpera_surface_fail_reconciliation(uuid,text,uuid)'::regprocedure,
		'public.qorpera_surface_complete_preview(uuid,text,text,uuid,jsonb,text,uuid)'::regprocedure,
		'public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)'::regprocedure,
		'public.qorpera_surface_enqueue_silent_reconciliation(uuid,uuid[],text[],uuid,boolean,boolean)'::regprocedure,
		'public.qorpera_surface_sync_coding_completion(public.qorpera_coding_sessions,public.qorpera_runtime_workers,text,text,text,jsonb,jsonb,text[])'::regprocedure,
		'public.qorpera_surface_session_json(public.qorpera_surface_sessions)'::regprocedure
	]);

create function pg_temp.swgrh_apply(p_def text, p_label text, p_pairs text[])
returns text language plpgsql as $$
declare
	v_def text := p_def;
	v_found integer;
begin
	for i in 1..cardinality(p_pairs) / 2 loop
		v_found := (length(v_def) - length(replace(v_def, p_pairs[2 * i - 1], ''))) / length(p_pairs[2 * i - 1]);
		if v_found <> 1 then
			raise exception '20260930933000 anchor found % time(s) in %, expected 1: %',
				v_found, p_label, left(p_pairs[2 * i - 1], 120);
		end if;
		v_def := replace(v_def, p_pairs[2 * i - 1], p_pairs[2 * i]);
	end loop;
	return v_def;
end $$;

create function pg_temp.swgrh_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
begin
	execute pg_temp.swgrh_apply(pg_get_functiondef(p_target), p_target::text, p_pairs);
end $$;

select pg_temp.swgrh_patch(
	'public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
	array[
$old$			-- The session runs for the member who asked, on their own account (20260928230000).
			elsif v_species = 'coding' and v_request ? 'owner'
				and (v_request ->> 'owner')::uuid is distinct from (p_actor ->> 'requesterUserId')::uuid then
				v_problem := 'A coding session runs for the member who asked for it';$old$,
$new$			-- The session runs for the member who asked, on their own account (20260928230000).
			elsif v_species = 'coding' and v_request ? 'owner'
				and (v_request ->> 'owner')::uuid is distinct from (p_actor ->> 'requesterUserId')::uuid then
				v_problem := 'A coding session runs for the member who asked for it';
			elsif v_species = 'coding' and v_request -> 'repository' ->> 'host' = 'qorpera'
				and (
					lower(coalesce(v_request -> 'repository' ->> 'owner', '')) = 'surfaces'
					or exists (
						select 1 from public.qorpera_surfaces surf
						where surf.profile_id = p_profile_id
							and surf.source_kind = 'code_repo'
							and surf.status <> 'archived'
							and lower(coalesce(nullif(btrim(surf.repository_key), ''), 'surfaces/' || surf.slug))
								= lower(coalesce(v_request -> 'repository' ->> 'owner', '')) || '/' || lower(coalesce(v_request -> 'repository' ->> 'name', ''))
					)
				) then
				v_problem := 'This repository belongs to a company Interface and must be changed through start_surface_session or steer_surface_session, not manage_worker';$new$
	]
);

select pg_temp.swgrh_patch(
	'public.qorpera_authorize_coding_turn(jsonb)'::regprocedure,
	array[
$old$	select * into v_session from public.qorpera_coding_sessions where worker_id = v_worker.id;$old$,
$new$	select * into v_session from public.qorpera_coding_sessions where worker_id = v_worker.id;
	if v_session.surface_session_id is not null and not exists (
		select 1 from public.qorpera_surface_sessions ss
		where ss.id = v_session.surface_session_id
			and ss.state in ('running', 'reconciling_running')
	) then
		raise exception 'Coding turn surface session is no longer active' using errcode = '42501';
	end if;$new$
	]
);

select pg_temp.swgrh_patch(
	'public.qorpera_surface_expire_coding_sessions(timestamptz,integer)'::regprocedure,
	array[
$old$	v_profile_id uuid;
	v_worker_ids uuid[];$old$,
$new$	v_profile_id uuid;
	v_worker_ids uuid[];
	v_dead_profile_id uuid;
	v_dead_worker_ids uuid[];$new$,
$old$begin
	-- WHY: Sweep at most one company per call so folder-v2 fence locks never span two companies in one transaction.$old$,
$new$begin
	select s.profile_id into v_dead_profile_id
	from public.qorpera_surface_sessions s
	join public.qorpera_runtime_workers rw on rw.id = s.worker_id
		and rw.surface_backed and rw.species = 'coding' and rw.state = 'active'
	where s.state in ('discarded', 'completed', 'failed')
	order by s.updated_at asc
	limit 1;

	if v_dead_profile_id is not null then
		select coalesce(array_agg(cand.worker_id order by cand.worker_id), '{}'::uuid[]) into v_dead_worker_ids
		from (
			select s.worker_id
			from public.qorpera_surface_sessions s
			join public.qorpera_runtime_workers rw on rw.id = s.worker_id
				and rw.surface_backed and rw.species = 'coding' and rw.state = 'active'
			where s.profile_id = v_dead_profile_id
				and s.state in ('discarded', 'completed', 'failed')
			order by s.updated_at asc
			limit greatest(1, coalesce(p_cap, 1))
		) cand;

		if coalesce(cardinality(v_dead_worker_ids), 0) > 0 then
			begin
				perform public.qorpera_lock_coding_workers(v_dead_worker_ids);
				for v_worker in
					select w.*
					from public.qorpera_runtime_workers w
					where w.id = any(v_dead_worker_ids)
						and w.surface_backed
						and w.species = 'coding'
						and w.state = 'active'
					order by w.id
				loop
					perform 1
					from public.qorpera_coding_sessions cs
					where cs.worker_id = v_worker.id
					for update;
					select * into v_ss
					from public.qorpera_surface_sessions s
					where s.id = v_worker.surface_session_id
					for update;
					if v_ss.id is not null and v_ss.state in ('discarded', 'completed', 'failed') then
						perform public.qorpera_cancel_worker(v_worker, null, 'surface_discarded');
					end if;
				end loop;
			exception when lock_not_available then
				null;
			end;
		end if;
		return;
	end if;

	-- WHY: Sweep at most one company per call so folder-v2 fence locks never span two companies in one transaction.$new$,
$old$				insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, body)
				values (
					v_ss.profile_id,
					v_ss.id,
					'system',
					'Session timed out after worker retry. Reply to retry.'
				);
			end if;$old$,
$new$				insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, body)
				values (
					v_ss.profile_id,
					v_ss.id,
					'system',
					'Session timed out after worker retry. Reply to retry.'
				);
				if v_ss.is_internal and v_ss.origin_ref ? 'reconciliationId' then
					perform public.qorpera_surface_fail_reconciliation(
						(v_ss.origin_ref ->> 'reconciliationId')::uuid,
						'Reconciliation session timed out after worker retry',
						v_ss.id
					);
				end if;
			end if;$new$
	]
);

select pg_temp.swgrh_patch(
	'public.qorpera_surface_complete_session_turn(uuid,text,text,jsonb,text[],text,uuid)'::regprocedure,
	array[
$old$			exists (
				select 1 from public.qorpera_surface_reconciliations r
				where r.id = v_rec_id and r.session_id = p_session_id
			)$old$,
$new$			exists (
				select 1 from public.qorpera_surface_reconciliations r
				where r.id = v_rec_id
					and r.session_id = p_session_id
					and r.status in ('queued', 'running')
					and r.expires_at > clock_timestamp()
			)$new$,
$old$		else
			v_next_state := 'failed';
			perform public.qorpera_surface_fail_reconciliation(v_rec_id, p_reply_text, p_session_id);
		end if;$old$,
$new$		else
			v_next_state := 'failed';
			perform public.qorpera_surface_fail_reconciliation(
				v_rec_id,
				case
					when p_state = 'ready' then
						'Reconciliation turn completed without staging a valid resolution'
						|| case when nullif(btrim(coalesce(p_reply_text, '')), '') is not null
							then ': ' || left(btrim(p_reply_text), 800)
							else '' end
					else
						coalesce(nullif(btrim(coalesce(p_reply_text, '')), ''), 'Reconciliation turn failed without error detail')
				end,
				p_session_id
			);
		end if;$new$
	]
);

select pg_temp.swgrh_patch(
	'public.qorpera_surface_fail_reconciliation(uuid,text,uuid)'::regprocedure,
	array[
$old$	v_detail text := left(coalesce(nullif(btrim(coalesce(p_error_detail, '')), ''), 'Couldn''t update preview'), 1000);$old$,
$new$	v_detail text := left(coalesce(nullif(btrim(coalesce(p_error_detail, '')), ''), 'Reconciliation failed without error detail'), 1000);$new$
	]
);

select pg_temp.swgrh_patch(
	'public.qorpera_surface_complete_preview(uuid,text,text,uuid,jsonb,text,uuid)'::regprocedure,
	array[
$old$			else
				v_next_status := 'failed';
				v_next_conflict := null;
				v_next_error := coalesce(v_rec.error_detail, 'Couldn''t update preview');
			end if;
		exception when others then
			v_next_status := 'failed';
			v_next_conflict := null;
			v_next_error := 'Couldn''t update preview';
		end;$old$,
$new$			else
				v_next_status := 'failed';
				v_next_conflict := null;
				v_next_error := coalesce(nullif(btrim(coalesce(v_rec.error_detail, '')), ''), 'Reconciliation failed without error detail');
			end if;
		exception when others then
			v_next_status := 'failed';
			v_next_conflict := null;
			v_next_error := left('Preview reconciliation failed: ' || coalesce(nullif(btrim(sqlerrm), ''), 'unknown error'), 1000);
		end;$new$
	]
);

select pg_temp.swgrh_patch(
	'public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)'::regprocedure,
	array[
$old$				if v_expired_session.is_internal and v_expired_session.origin_ref ? 'reconciliationId' then
					perform public.qorpera_surface_fail_reconciliation(
						(v_expired_session.origin_ref ->> 'reconciliationId')::uuid,
						'Couldn''t update preview',
						v_expired_session.id
					);
				end if;$old$,
$new$				if v_expired_session.is_internal and v_expired_session.origin_ref ? 'reconciliationId' then
					perform public.qorpera_surface_fail_reconciliation(
						(v_expired_session.origin_ref ->> 'reconciliationId')::uuid,
						'Reconciliation session timed out after worker retry',
						v_expired_session.id
					);
				end if;$new$
	]
);

select pg_temp.swgrh_patch(
	'public.qorpera_surface_enqueue_silent_reconciliation(uuid,uuid[],text[],uuid,boolean,boolean)'::regprocedure,
	array[
$old$	v_now timestamptz := clock_timestamp();$old$,
$new$	v_auto_approve boolean := coalesce(p_auto_approve_after, false);
	v_now timestamptz := clock_timestamp();$new$,
$old$	-- WHY: Supersede unstarted member-initiated preview reconciliations in session-then-reconciliation lock order so rapid toggles never fan out concurrent runs or strand reconciling previews.
	if v_explicit_member and not coalesce(p_auto_approve_after, false) then
		for v_sup in
			select r.id as rec_id, r.session_id, r.selected_change_ids
			from public.qorpera_surface_reconciliations r
			join public.qorpera_surface_sessions s on s.id = r.session_id
			where r.surface_id = p_surface_id
				and r.composition_key <> v_comp_key
				and r.status = 'queued'
				and r.auto_approve_after = false
				and r.created_by_user_id = v_requester
				and s.origin_kind = 'member'
				and s.state = 'reconciling'
				and s.lease_token is null
				and s.wake_id is null
				and s.worker_id is null
			order by r.created_at asc, r.id asc
		loop
			update public.qorpera_surface_sessions s
			set state = 'discarded', closed_at = v_now, updated_at = v_now
			where s.id = v_sup.session_id
				and s.origin_kind = 'member'
				and s.state = 'reconciling'
				and s.lease_token is null
				and s.wake_id is null
				and s.worker_id is null;
			if not found then
				continue;
			end if;

			delete from public.qorpera_surface_reconciliations r
			where r.id = v_sup.rec_id
				and r.session_id = v_sup.session_id
				and r.status = 'queued'
				and r.auto_approve_after = false;
			if not found then
				continue;
			end if;

			update public.qorpera_surface_previews p
			set
				status = 'failed',
				conflict_report = null,
				error_detail = 'Couldn''t update preview',
				lease_expires_at = null,
				lease_token = null,
				updated_at = v_now
			where p.surface_id = p_surface_id
				and p.status = 'reconciling'
				and (
					select array_agg(x order by x) from unnest(p.selected_change_ids) as x
				) = (
					select array_agg(y order by y) from unnest(v_sup.selected_change_ids) as y
				);
		end loop;
	end if;$old$,
$new$	-- WHY: Supersede stale same-selection and prior member preview reconciliations in session-then-reconciliation lock order; discarding the internal session stops active workers via claim/auth/expiry sweeps without lock inversion.
	for v_sup in
		select r.id as rec_id, r.session_id, r.status as rec_status, r.auto_approve_after as rec_auto_approve
		from public.qorpera_surface_reconciliations r
		where r.surface_id = p_surface_id
			and r.composition_key <> v_comp_key
			and r.status in ('queued', 'running')
			and (
				select array_agg(x order by x) from unnest(r.selected_change_ids) as x
			) = (
				select array_agg(y order by y) from unnest(v_ordered_ids) as y
			)
		order by r.created_at asc, r.id asc
	loop
		v_auto_approve := v_auto_approve or coalesce(v_sup.rec_auto_approve, false);
		if v_sup.session_id is not null then
			update public.qorpera_surface_sessions s
			set
				state = 'discarded',
				lease_token = null,
				lease_expires_at = null,
				wake_id = null,
				closed_at = v_now,
				updated_at = v_now
			where s.id = v_sup.session_id
				and s.is_internal
				and s.state in ('reconciling', 'reconciling_running', 'queued', 'running');
		end if;

		if v_sup.rec_status = 'queued' then
			delete from public.qorpera_surface_reconciliations r
			where r.id = v_sup.rec_id and r.status = 'queued';
		else
			update public.qorpera_surface_reconciliations r
			set
				status = 'failed',
				expires_at = v_now,
				error_detail = 'Superseded by updated change revision',
				auto_approve_after = false,
				updated_at = v_now
			where r.id = v_sup.rec_id and r.status in ('queued', 'running');
		end if;
	end loop;

	if v_explicit_member and not v_auto_approve then
		for v_sup in
			select r.id as rec_id, r.session_id, r.selected_change_ids
			from public.qorpera_surface_reconciliations r
			join public.qorpera_surface_sessions s on s.id = r.session_id
			where r.surface_id = p_surface_id
				and r.composition_key <> v_comp_key
				and r.status in ('queued', 'running')
				and r.auto_approve_after = false
				and r.created_by_user_id = v_requester
				and s.is_internal
				and s.origin_kind = 'member'
				and s.state in ('reconciling', 'reconciling_running')
			order by r.created_at asc, r.id asc
		loop
			update public.qorpera_surface_sessions s
			set
				state = 'discarded',
				lease_token = null,
				lease_expires_at = null,
				wake_id = null,
				closed_at = v_now,
				updated_at = v_now
			where s.id = v_sup.session_id
				and s.is_internal
				and s.origin_kind = 'member'
				and s.state in ('reconciling', 'reconciling_running');
			if not found then
				continue;
			end if;

			delete from public.qorpera_surface_reconciliations r
			where r.id = v_sup.rec_id
				and r.session_id = v_sup.session_id
				and r.status in ('queued', 'running')
				and r.auto_approve_after = false;
			if not found then
				continue;
			end if;

			if (
				select array_agg(x order by x) from unnest(v_sup.selected_change_ids) as x
			) is distinct from (
				select array_agg(y order by y) from unnest(v_ordered_ids) as y
			) then
				update public.qorpera_surface_previews p
				set
					status = 'failed',
					conflict_report = null,
					error_detail = 'Superseded by newer preview selection',
					lease_expires_at = null,
					lease_token = null,
					updated_at = v_now
				where p.surface_id = p_surface_id
					and p.status = 'reconciling'
					and (
						select array_agg(x order by x) from unnest(p.selected_change_ids) as x
					) = (
						select array_agg(y order by y) from unnest(v_sup.selected_change_ids) as y
					);
			end if;
		end loop;
	end if;$new$,
$old$			auto_approve_after = coalesce(p_auto_approve_after, false),$old$,
$new$			auto_approve_after = v_auto_approve,$new$,
$old$			v_ordered_ids, 'queued', v_paths, coalesce(p_auto_approve_after, false),$old$,
$new$			v_ordered_ids, 'queued', v_paths, v_auto_approve,$new$
	]
);

select pg_temp.swgrh_patch(
	'public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)'::regprocedure,
	array[
$old$			or case when v_session.surface_session_id is not null then
				(p_artifacts -> 0) - array['kind','branch','baseSha','headSha'] <> '{}'::jsonb
				or p_artifacts -> 0 ->> 'kind' is distinct from 'staged'
				or p_artifacts -> 0 ->> 'branch' is distinct from v_session.branch
				or coalesce(p_artifacts -> 0 ->> 'baseSha', '') !~ '^[0-9a-f]{40}$'
				or coalesce(p_artifacts -> 0 ->> 'headSha', '') !~ '^[0-9a-f]{40}$'$old$,
$new$			or case when v_session.surface_session_id is not null then
				(p_artifacts -> 0) - array['kind','branch','baseSha','headSha','affectedPaths','diffStats'] <> '{}'::jsonb
				or p_artifacts -> 0 ->> 'kind' is distinct from 'staged'
				or p_artifacts -> 0 ->> 'branch' is distinct from v_session.branch
				or coalesce(p_artifacts -> 0 ->> 'baseSha', '') !~ '^[0-9a-f]{40}$'
				or coalesce(p_artifacts -> 0 ->> 'headSha', '') !~ '^[0-9a-f]{40}$'
				or (p_artifacts -> 0 ? 'affectedPaths' and (
					jsonb_typeof(p_artifacts -> 0 -> 'affectedPaths') <> 'array'
					or jsonb_array_length(p_artifacts -> 0 -> 'affectedPaths') > 500
					or exists (
						select 1
						from jsonb_array_elements(p_artifacts -> 0 -> 'affectedPaths') ap
						where jsonb_typeof(ap) <> 'string'
							or char_length(ap #>> '{}') not between 1 and 512
					)
				))
				or (p_artifacts -> 0 ? 'diffStats' and p_artifacts -> 0 -> 'diffStats' <> 'null'::jsonb and (
					jsonb_typeof(p_artifacts -> 0 -> 'diffStats') <> 'object'
					or (p_artifacts -> 0 -> 'diffStats') - array['filesChanged','additions','deletions'] <> '{}'::jsonb
					or not ((p_artifacts -> 0 -> 'diffStats') ?& array['filesChanged','additions','deletions'])
					or jsonb_typeof(p_artifacts -> 0 -> 'diffStats' -> 'filesChanged') is distinct from 'number'
					or jsonb_typeof(p_artifacts -> 0 -> 'diffStats' -> 'additions') is distinct from 'number'
					or jsonb_typeof(p_artifacts -> 0 -> 'diffStats' -> 'deletions') is distinct from 'number'
					or coalesce((p_artifacts -> 0 -> 'diffStats' ->> 'filesChanged') !~ '^[0-9]{1,6}$', true)
					or coalesce((p_artifacts -> 0 -> 'diffStats' ->> 'additions') !~ '^[0-9]{1,8}$', true)
					or coalesce((p_artifacts -> 0 -> 'diffStats' ->> 'deletions') !~ '^[0-9]{1,8}$', true)
				))$new$
	]
);

select pg_temp.swgrh_patch(
	'public.qorpera_surface_session_json(public.qorpera_surface_sessions)'::regprocedure,
	array[
$old$		'explorationVariantLabel', p_session.exploration_variant_label,$old$,
$new$		'explorationVariantLabel', p_session.exploration_variant_label,
		'supersedeKey', p_session.supersede_key,$new$,
$old$					'optionGroupTitle', ch.option_group_title,$old$,
$new$					'optionGroupTitle', ch.option_group_title,
					'supersedeKey', ch.supersede_key,$new$
	]
);

do $$
declare
	v_def text;
begin
	v_def := pg_get_functiondef('public.qorpera_start_surface_session(uuid,text,text,text,text,jsonb,integer,text,text[])'::regprocedure);
	v_def := pg_temp.swgrh_apply(v_def, 'qorpera_start_surface_session', array[
		'p_variant_labels text[] DEFAULT NULL::text[])',
		'p_variant_labels text[] DEFAULT NULL::text[], p_supersede_key text DEFAULT NULL::text)',
$old$	v_origin_ref jsonb := p_origin_ref;
	v_preview_base_ids uuid[] := '{}'::uuid[];
begin$old$,
$new$	v_origin_ref jsonb := p_origin_ref;
	v_preview_base_ids uuid[] := '{}'::uuid[];
	v_supersede_key text := nullif(lower(btrim(coalesce(p_supersede_key, ''))), '');
begin
	if v_supersede_key is not null and v_supersede_key !~ '^[a-z0-9][a-z0-9._:-]{0,79}$' then
		raise exception 'supersedeKey must be 1..80 lower-case letters, digits, dots, colons, underscores, or hyphens' using errcode = '22023';
	end if;$new$,
$old$			insert into public.qorpera_surface_sessions(
				profile_id, surface_id, machine_id, exploration_id, exploration_variant_label,
				title, prompt, origin_kind, origin_label, origin_ref, preview_base_change_ids,
				created_by_user_id, state, base_sha
			)
			values (
				v_surface.profile_id, p_surface_id, v_machine_id, v_exploration_id,
				left(v_variant_label, 80),
				left(v_variant_label, 160),
				v_prompt, v_origin_kind, coalesce(v_owner_label, 'Member'), v_origin_ref, v_preview_base_ids,
				v_user_id, 'queued', v_surface.live_head_sha
			)$old$,
$new$			insert into public.qorpera_surface_sessions(
				profile_id, surface_id, machine_id, exploration_id, exploration_variant_label,
				title, prompt, origin_kind, origin_label, origin_ref, preview_base_change_ids,
				created_by_user_id, state, base_sha, supersede_key
			)
			values (
				v_surface.profile_id, p_surface_id, v_machine_id, v_exploration_id,
				left(v_variant_label, 80),
				left(v_variant_label, 160),
				v_prompt, v_origin_kind, coalesce(v_owner_label, 'Member'), v_origin_ref, v_preview_base_ids,
				v_user_id, 'queued', v_surface.live_head_sha, v_supersede_key
			)$new$,
$old$		insert into public.qorpera_surface_sessions(
			profile_id, surface_id, machine_id, title, prompt,
			origin_kind, origin_label, origin_ref, preview_base_change_ids, created_by_user_id, state, base_sha
		)
		values (
			v_surface.profile_id, p_surface_id, v_machine_id, v_title, v_prompt,
			v_origin_kind, v_owner_label, v_origin_ref, v_preview_base_ids, v_user_id, 'queued', v_surface.live_head_sha
		)$old$,
$new$		insert into public.qorpera_surface_sessions(
			profile_id, surface_id, machine_id, title, prompt,
			origin_kind, origin_label, origin_ref, preview_base_change_ids, created_by_user_id, state, base_sha, supersede_key
		)
		values (
			v_surface.profile_id, p_surface_id, v_machine_id, v_title, v_prompt,
			v_origin_kind, v_owner_label, v_origin_ref, v_preview_base_ids, v_user_id, 'queued', v_surface.live_head_sha, v_supersede_key
		)$new$
	]);
	drop function public.qorpera_start_surface_session(uuid, text, text, text, text, jsonb, integer, text, text[]);
	execute v_def;

	v_def := pg_get_functiondef('public.qorpera_service_start_surface_session(uuid,uuid,text,text,text,text,integer,text,text[])'::regprocedure);
	v_def := pg_temp.swgrh_apply(v_def, 'qorpera_service_start_surface_session', array[
		'p_variant_labels text[] DEFAULT NULL::text[])',
		'p_variant_labels text[] DEFAULT NULL::text[], p_supersede_key text DEFAULT NULL::text)',
$old$	v_owner_label text := coalesce(nullif(btrim(coalesce(p_origin_label, '')), ''), 'Co-Founder');
begin$old$,
$new$	v_owner_label text := coalesce(nullif(btrim(coalesce(p_origin_label, '')), ''), 'Co-Founder');
	v_supersede_key text := nullif(lower(btrim(coalesce(p_supersede_key, ''))), '');
begin
	if v_supersede_key is not null and v_supersede_key !~ '^[a-z0-9][a-z0-9._:-]{0,79}$' then
		raise exception 'supersedeKey must be 1..80 lower-case letters, digits, dots, colons, underscores, or hyphens' using errcode = '22023';
	end if;$new$,
$old$			insert into public.qorpera_surface_sessions(
				profile_id, surface_id, machine_id, exploration_id, exploration_variant_label,
				title, prompt, origin_kind, origin_label, state, base_sha
			)
			values (
				p_company_id, p_surface_id, v_machine_id, v_exploration_id,
				left(v_variant_label, 80),
				left(v_variant_label, 160),
				v_prompt, coalesce(p_origin_kind, 'cofounder'), v_owner_label, 'queued', v_surface.live_head_sha
			)$old$,
$new$			insert into public.qorpera_surface_sessions(
				profile_id, surface_id, machine_id, exploration_id, exploration_variant_label,
				title, prompt, origin_kind, origin_label, state, base_sha, supersede_key
			)
			values (
				p_company_id, p_surface_id, v_machine_id, v_exploration_id,
				left(v_variant_label, 80),
				left(v_variant_label, 160),
				v_prompt, coalesce(p_origin_kind, 'cofounder'), v_owner_label, 'queued', v_surface.live_head_sha, v_supersede_key
			)$new$,
$old$		insert into public.qorpera_surface_sessions(
			profile_id, surface_id, machine_id, title, prompt,
			origin_kind, origin_label, state, base_sha
		)
		values (
			p_company_id, p_surface_id, v_machine_id, v_title, v_prompt,
			coalesce(p_origin_kind, 'cofounder'), v_owner_label, 'queued', v_surface.live_head_sha
		)$old$,
$new$		insert into public.qorpera_surface_sessions(
			profile_id, surface_id, machine_id, title, prompt,
			origin_kind, origin_label, state, base_sha, supersede_key
		)
		values (
			p_company_id, p_surface_id, v_machine_id, v_title, v_prompt,
			coalesce(p_origin_kind, 'cofounder'), v_owner_label, 'queued', v_surface.live_head_sha, v_supersede_key
		)$new$
	]);
	drop function public.qorpera_service_start_surface_session(uuid, uuid, text, text, text, text, integer, text, text[]);
	execute v_def;

	v_def := pg_get_functiondef('public.qorpera_native_surface_start_session(uuid,uuid,text,text,text,text,integer,text,text[])'::regprocedure);
	v_def := pg_temp.swgrh_apply(v_def, 'qorpera_native_surface_start_session', array[
		'p_variant_labels text[] DEFAULT NULL::text[])',
		'p_variant_labels text[] DEFAULT NULL::text[], p_supersede_key text DEFAULT NULL::text)',
$old$	return public.qorpera_service_start_surface_session(
		p_profile_id, p_surface_id, p_prompt, p_title, v_origin_kind, p_origin_label,
		p_exploration_count, p_exploration_title, p_variant_labels
	);$old$,
$new$	return public.qorpera_service_start_surface_session(
		p_profile_id, p_surface_id, p_prompt, p_title, v_origin_kind, p_origin_label,
		p_exploration_count, p_exploration_title, p_variant_labels, p_supersede_key
	);$new$
	]);
	drop function public.qorpera_native_surface_start_session(uuid, uuid, text, text, text, text, integer, text, text[]);
	execute v_def;

	v_def := pg_get_functiondef('public.qorpera_record_surface_change(uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean,text,text,uuid)'::regprocedure);
	v_def := pg_temp.swgrh_apply(v_def, 'qorpera_record_surface_change', array[
		'p_option_group_key text DEFAULT NULL::text, p_option_group_title text DEFAULT NULL::text, p_change_id uuid DEFAULT NULL::uuid)',
		'p_option_group_key text DEFAULT NULL::text, p_option_group_title text DEFAULT NULL::text, p_change_id uuid DEFAULT NULL::uuid, p_supersede_key text DEFAULT NULL::text)',
$old$	v_conflicted_downstream_ids uuid[];
	v_now timestamptz := clock_timestamp();$old$,
$new$	v_conflicted_downstream_ids uuid[];
	v_supersede_key text := nullif(lower(btrim(coalesce(p_supersede_key, ''))), '');
	v_locked_idle_session_ids uuid[] := '{}'::uuid[];
	v_locked_rec_session_ids uuid[] := '{}'::uuid[];
	v_superseded_rec_session_ids uuid[];
	v_superseded_change_ids uuid[];
	v_superseded_session_ids uuid[];
	v_superseded_sid uuid;
	v_now timestamptz := clock_timestamp();$new$,
$old$		update public.qorpera_surface_reconciliations
		set
			expires_at = v_now,
			status = case when status in ('queued', 'running') then 'failed' else status end,
			error_detail = case when status in ('queued', 'running') then 'Change updated' else error_detail end,
			auto_approve_after = false,
			updated_at = v_now
		where surface_id = v_session.surface_id
			and selected_change_ids && v_affected_change_ids
			and (expires_at > v_now or status in ('queued', 'running'));$old$,
$new$		select coalesce(array_agg(s.id order by s.id), '{}'::uuid[])
		into v_locked_rec_session_ids
		from (
			select rs.id
			from public.qorpera_surface_sessions rs
			where rs.id in (
				select r.session_id
				from public.qorpera_surface_reconciliations r
				where r.surface_id = v_session.surface_id
					and r.selected_change_ids && v_affected_change_ids
					and (r.expires_at > v_now or r.status in ('queued', 'running'))
					and r.session_id is not null
			)
				and rs.is_internal
				and rs.state in ('queued', 'running', 'reconciling', 'reconciling_running')
			order by rs.id asc
			for update of rs skip locked
		) s;

		with invalidated as (
			update public.qorpera_surface_reconciliations
			set
				expires_at = v_now,
				status = case when status in ('queued', 'running') then 'failed' else status end,
				error_detail = case when status in ('queued', 'running') then 'Change updated' else error_detail end,
				auto_approve_after = false,
				updated_at = v_now
			where surface_id = v_session.surface_id
				and selected_change_ids && v_affected_change_ids
				and (expires_at > v_now or status in ('queued', 'running'))
			returning session_id
		)
		select coalesce(array_agg(distinct session_id), '{}'::uuid[])
		into v_superseded_rec_session_ids
		from invalidated
		where session_id is not null;

		if coalesce(cardinality(v_superseded_rec_session_ids), 0) > 0
			and coalesce(cardinality(v_locked_rec_session_ids), 0) > 0 then
			update public.qorpera_surface_sessions
			set
				state = 'discarded',
				lease_token = null,
				lease_expires_at = null,
				wake_id = null,
				closed_at = v_now,
				updated_at = v_now
			where id = any(v_superseded_rec_session_ids)
				and id = any(v_locked_rec_session_ids)
				and is_internal
				and state in ('queued', 'running', 'reconciling', 'reconciling_running');
		end if;$new$,
$old$	insert into public.qorpera_surface_changes(
		profile_id, surface_id, session_id, seq, title, summary, kind,
		parent_sha, head_sha, depends_on_change_ids, preview_base_change_ids,
		affected_paths, diff_stats, patch_manifest, base_files, status,
		option_group_key, option_group_title
	)
	values (
		v_session.profile_id, v_session.surface_id, p_session_id, v_next_seq,
		btrim(p_title), coalesce(p_summary, ''), coalesce(p_kind, 'git_range'),
		p_parent_sha, p_head_sha, coalesce(p_depends_on_change_ids, '{}'::uuid[]),
		coalesce(v_preview_base_ids, '{}'::uuid[]),
		coalesce(p_affected_paths, '{}'::text[]), p_diff_stats, v_patch_manifest, v_base_files, 'staged',
		v_group_key, v_group_title
	)
	returning * into v_change;$old$,
$new$	v_supersede_key := coalesce(v_supersede_key, v_session.supersede_key);
	if v_supersede_key is not null and v_supersede_key !~ '^[a-z0-9][a-z0-9._:-]{0,79}$' then
		raise exception 'supersedeKey must be 1..80 lower-case letters, digits, dots, colons, underscores, or hyphens' using errcode = '22023';
	end if;

	if v_supersede_key is not null and not coalesce(v_session.is_internal, false) then
		perform pg_catalog.pg_advisory_xact_lock(
			pg_catalog.hashtextextended('qorpera.surface-supersede:' || v_session.surface_id::text || ':' || v_supersede_key, 0)
		);
		select
			coalesce(array_agg(s.id order by s.id) filter (where not s.is_internal), '{}'::uuid[]),
			coalesce(array_agg(s.id order by s.id) filter (where s.is_internal), '{}'::uuid[])
		into v_locked_idle_session_ids, v_locked_rec_session_ids
		from (
			select ps.id, coalesce(ps.is_internal, false) as is_internal
			from public.qorpera_surface_sessions ps
			where (
				ps.id in (
					select distinct ch.session_id
					from public.qorpera_surface_changes ch
					where ch.surface_id = v_session.surface_id
						and ch.profile_id = v_session.profile_id
						and ch.supersede_key = v_supersede_key
						and ch.status in ('staged', 'conflicted')
						and ch.session_id <> p_session_id
				)
				and ps.state not in ('queued', 'running', 'reconciling', 'reconciling_running')
			) or (
				ps.is_internal
				and ps.state in ('queued', 'running', 'reconciling', 'reconciling_running')
				and ps.id in (
					select r.session_id
					from public.qorpera_surface_reconciliations r
					where r.surface_id = v_session.surface_id
						and r.session_id is not null
						and (r.expires_at > v_now or r.status in ('queued', 'running'))
						and r.selected_change_ids && coalesce(
							(
								select array_agg(ch.id)
								from public.qorpera_surface_changes ch
								where ch.surface_id = v_session.surface_id
									and ch.profile_id = v_session.profile_id
									and ch.supersede_key = v_supersede_key
									and ch.status in ('staged', 'conflicted')
									and ch.session_id <> p_session_id
							),
							'{}'::uuid[]
						)
				)
			)
			order by ps.id asc
			for update of ps skip locked
		) s;
	end if;

	insert into public.qorpera_surface_changes(
		profile_id, surface_id, session_id, seq, title, summary, kind,
		parent_sha, head_sha, depends_on_change_ids, preview_base_change_ids,
		affected_paths, diff_stats, patch_manifest, base_files, status,
		option_group_key, option_group_title, supersede_key
	)
	values (
		v_session.profile_id, v_session.surface_id, p_session_id, v_next_seq,
		btrim(p_title), coalesce(p_summary, ''), coalesce(p_kind, 'git_range'),
		p_parent_sha, p_head_sha, coalesce(p_depends_on_change_ids, '{}'::uuid[]),
		coalesce(v_preview_base_ids, '{}'::uuid[]),
		coalesce(p_affected_paths, '{}'::text[]), p_diff_stats, v_patch_manifest, v_base_files, 'staged',
		v_group_key, v_group_title, v_supersede_key
	)
	returning * into v_change;

	if v_supersede_key is not null and not coalesce(v_session.is_internal, false) then
		with locked_old as (
			select ch.id, ch.session_id
			from public.qorpera_surface_changes ch
			where ch.surface_id = v_session.surface_id
				and ch.profile_id = v_session.profile_id
				and ch.supersede_key = v_supersede_key
				and ch.status in ('staged', 'conflicted')
				and ch.session_id <> p_session_id
				and ch.id <> v_change.id
			order by ch.id asc
			for update
		),
		superseded as (
			update public.qorpera_surface_changes ch
			set status = 'discarded', resolved_at = v_now
			from locked_old lo
			where ch.id = lo.id
			returning ch.id, ch.session_id
		),
		notices as (
			insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, body, change_id)
			select
				v_session.profile_id,
				sup.session_id,
				'system',
				'Superseded by newer update: ' || v_change.title,
				sup.id
			from superseded sup
		)
		select
			coalesce(array_agg(sup.id order by sup.id), '{}'::uuid[]),
			coalesce(array_agg(distinct sup.session_id order by sup.session_id) filter (where sup.session_id <> p_session_id), '{}'::uuid[])
		into v_superseded_change_ids, v_superseded_session_ids
		from superseded sup;

		if coalesce(cardinality(v_superseded_change_ids), 0) > 0 then
			update public.qorpera_member_surface_state
			set toggled_change_ids = coalesce(
				(
					select array_agg(dedup.cid order by dedup.first_ord)
					from (
						select
							case when t.cid = any(v_superseded_change_ids) then v_change.id else t.cid end as cid,
							min(t.ord) as first_ord
						from unnest(toggled_change_ids) with ordinality as t(cid, ord)
						group by 1
					) dedup
				),
				'{}'::uuid[]
			)
			where surface_id = v_session.surface_id
				and toggled_change_ids && v_superseded_change_ids;

			with invalidated as (
				update public.qorpera_surface_reconciliations
				set
					expires_at = v_now,
					status = case when status in ('queued', 'running') then 'failed' else status end,
					error_detail = case when status in ('queued', 'running') then 'Change superseded' else error_detail end,
					auto_approve_after = false,
					updated_at = v_now
				where surface_id = v_session.surface_id
					and selected_change_ids && v_superseded_change_ids
					and (expires_at > v_now or status in ('queued', 'running'))
				returning session_id
			)
			select coalesce(array_agg(distinct session_id), '{}'::uuid[])
			into v_superseded_rec_session_ids
			from invalidated
			where session_id is not null;

			if coalesce(cardinality(v_superseded_rec_session_ids), 0) > 0
				and coalesce(cardinality(v_locked_rec_session_ids), 0) > 0 then
				update public.qorpera_surface_sessions
				set
					state = 'discarded',
					lease_token = null,
					lease_expires_at = null,
					wake_id = null,
					closed_at = v_now,
					updated_at = v_now
				where id = any(v_superseded_rec_session_ids)
					and id = any(v_locked_rec_session_ids)
					and is_internal
					and state in ('queued', 'running', 'reconciling', 'reconciling_running');
			end if;

			update public.qorpera_surface_previews
			set expires_at = v_now, updated_at = v_now
			where surface_id = v_session.surface_id
				and selected_change_ids && v_superseded_change_ids
				and status in ('composing', 'reconciling')
				and expires_at > v_now;

			perform public.qorpera_surface_enqueue_standalone_dependents(v_session.surface_id, v_superseded_change_ids);

			foreach v_superseded_sid in array v_superseded_session_ids loop
				if v_superseded_sid = any(v_locked_idle_session_ids) then
					perform public.qorpera_evaluate_surface_session_lifecycle(v_superseded_sid);
				end if;
			end loop;
		end if;
	end if;$new$
	]);
	drop function public.qorpera_record_surface_change(uuid, text, text, text, text, text, uuid[], text[], jsonb, jsonb, boolean, text, text, uuid);
	execute v_def;

	v_def := pg_get_functiondef('public.qorpera_native_surface_record_change(uuid,uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean,uuid,text,text,uuid)'::regprocedure);
	v_def := pg_temp.swgrh_apply(v_def, 'qorpera_native_surface_record_change', array[
		'p_option_group_key text DEFAULT NULL::text, p_option_group_title text DEFAULT NULL::text, p_change_id uuid DEFAULT NULL::uuid)',
		'p_option_group_key text DEFAULT NULL::text, p_option_group_title text DEFAULT NULL::text, p_change_id uuid DEFAULT NULL::uuid, p_supersede_key text DEFAULT NULL::text)',
$old$	v_result := public.qorpera_record_surface_change(
		p_session_id, p_title, p_summary, p_kind, v_parent_sha, v_head_sha,
		p_depends_on_change_ids, p_affected_paths, p_diff_stats, p_patch_manifest, p_finish_session,
		p_option_group_key, p_option_group_title, p_change_id
	);$old$,
$new$	v_result := public.qorpera_record_surface_change(
		p_session_id, p_title, p_summary, p_kind, v_parent_sha, v_head_sha,
		p_depends_on_change_ids, p_affected_paths, p_diff_stats, p_patch_manifest, p_finish_session,
		p_option_group_key, p_option_group_title, p_change_id, p_supersede_key
	);$new$
	]);
	drop function public.qorpera_native_surface_record_change(uuid, uuid, text, text, text, text, text, uuid[], text[], jsonb, jsonb, boolean, uuid, text, text, uuid);
	execute v_def;
end $$;

select pg_temp.swgrh_patch(
	'public.qorpera_surface_sync_coding_completion(public.qorpera_coding_sessions,public.qorpera_runtime_workers,text,text,text,jsonb,jsonb,text[])'::regprocedure,
	array[
$old$	v_open_git_count integer := 0;
	v_reply_change_id uuid;$old$,
$new$	v_open_git_count integer := 0;
	v_reply_change_id uuid;
	v_artifact_paths text[] := '{}'::text[];
	v_artifact_diff_stats jsonb := null;$new$,
$old$		if p_artifacts is not null and jsonb_typeof(p_artifacts) = 'array' and jsonb_array_length(p_artifacts) >= 1 then
			v_head_sha := nullif(btrim(coalesce(p_artifacts -> 0 ->> 'headSha', '')), '');
			v_base_sha := nullif(btrim(coalesce(p_artifacts -> 0 ->> 'baseSha', '')), '');
		end if;$old$,
$new$		if p_artifacts is not null and jsonb_typeof(p_artifacts) = 'array' and jsonb_array_length(p_artifacts) >= 1 then
			v_head_sha := nullif(btrim(coalesce(p_artifacts -> 0 ->> 'headSha', '')), '');
			v_base_sha := nullif(btrim(coalesce(p_artifacts -> 0 ->> 'baseSha', '')), '');
			if jsonb_typeof(p_artifacts -> 0 -> 'affectedPaths') = 'array' then
				select coalesce(array_agg(left(ap, 512) order by ord), '{}'::text[])
				into v_artifact_paths
				from jsonb_array_elements_text(p_artifacts -> 0 -> 'affectedPaths') with ordinality as u(ap, ord)
				where ord <= 500 and nullif(btrim(ap), '') is not null;
			end if;
			if jsonb_typeof(p_artifacts -> 0 -> 'diffStats') = 'object' then
				v_artifact_diff_stats := p_artifacts -> 0 -> 'diffStats';
			end if;
		end if;$new$,
$old$					perform public.qorpera_record_surface_change(
						v_surf_session.id,
						v_tip_change.title,
						coalesce(nullif(left(btrim(coalesce(p_summary, '')), 400), ''), v_tip_change.summary),
						'git_range',
						coalesce(nullif(btrim(v_tip_change.parent_sha), ''), v_base_sha),
						v_head_sha,
						v_tip_change.depends_on_change_ids,
						v_tip_change.affected_paths,
						null,
						null,
						false,
						null,
						null,
						v_tip_change.id
					);
				else
					v_title := left(coalesce(nullif(btrim(v_surf_session.title), ''), 'Staged update'), 160);
					perform public.qorpera_record_surface_change(
						v_surf_session.id,
						v_title,
						left(btrim(coalesce(p_summary, '')), 400),
						'git_range',
						v_prev_sha,
						v_head_sha,
						'{}'::uuid[],
						'{}'::text[],
						null,
						null,
						false
					);$old$,
$new$					perform public.qorpera_record_surface_change(
						v_surf_session.id,
						v_tip_change.title,
						coalesce(nullif(left(btrim(coalesce(p_summary, '')), 400), ''), v_tip_change.summary),
						'git_range',
						coalesce(nullif(btrim(v_tip_change.parent_sha), ''), v_base_sha),
						v_head_sha,
						v_tip_change.depends_on_change_ids,
						case when coalesce(cardinality(v_artifact_paths), 0) > 0 then v_artifact_paths else v_tip_change.affected_paths end,
						v_artifact_diff_stats,
						null,
						false,
						null,
						null,
						v_tip_change.id
					);
				else
					v_title := left(coalesce(nullif(btrim(v_surf_session.title), ''), 'Staged update'), 160);
					perform public.qorpera_record_surface_change(
						v_surf_session.id,
						v_title,
						left(btrim(coalesce(p_summary, '')), 400),
						'git_range',
						v_prev_sha,
						v_head_sha,
						'{}'::uuid[],
						v_artifact_paths,
						v_artifact_diff_stats,
						null,
						false
					);$new$
	]
);

revoke all on function
	public.qorpera_start_surface_session(uuid, text, text, text, text, jsonb, integer, text, text[], text)
	from public, anon, qorpera_secret_broker;
grant execute on function
	public.qorpera_start_surface_session(uuid, text, text, text, text, jsonb, integer, text, text[], text)
	to authenticated;

revoke all on function
	public.qorpera_service_start_surface_session(uuid, uuid, text, text, text, text, integer, text, text[], text),
	public.qorpera_native_surface_start_session(uuid, uuid, text, text, text, text, integer, text, text[], text),
	public.qorpera_record_surface_change(uuid, text, text, text, text, text, uuid[], text[], jsonb, jsonb, boolean, text, text, uuid, text),
	public.qorpera_native_surface_record_change(uuid, uuid, text, text, text, text, text, uuid[], text[], jsonb, jsonb, boolean, uuid, text, text, uuid, text)
	from public, anon, authenticated, qorpera_secret_broker;
grant execute on function
	public.qorpera_service_start_surface_session(uuid, uuid, text, text, text, text, integer, text, text[], text),
	public.qorpera_native_surface_start_session(uuid, uuid, text, text, text, text, integer, text, text[], text),
	public.qorpera_record_surface_change(uuid, text, text, text, text, text, uuid[], text[], jsonb, jsonb, boolean, text, text, uuid, text),
	public.qorpera_native_surface_record_change(uuid, uuid, text, text, text, text, text, uuid[], text[], jsonb, jsonb, boolean, uuid, text, text, uuid, text)
	to service_role;

do $$
declare
	v_owner name;
	v_bad text;
begin
	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = 'public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception '20260930933000 function has an API owner: %', v_owner;
		end if;
		execute format('grant select on public.qorpera_surfaces to %I', v_owner);
	end loop;

	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = 'public.qorpera_authorize_coding_turn(jsonb)'::regprocedure
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception '20260930933000 function has an API owner: %', v_owner;
		end if;
		execute format('grant select on public.qorpera_surface_sessions to %I', v_owner);
	end loop;

	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = 'public.qorpera_surface_expire_coding_sessions(timestamptz,integer)'::regprocedure
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception '20260930933000 function has an API owner: %', v_owner;
		end if;
		execute format('grant execute on function public.qorpera_surface_fail_reconciliation(uuid, text, uuid) to %I', v_owner);
	end loop;

	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = any(array[
			'public.qorpera_start_surface_session_with_images(uuid,text,text,text,text,jsonb,integer,text,text[],uuid,jsonb)'::regprocedure,
			'public.qorpera_native_surface_start_session(uuid,uuid,text,text,text,text,integer,text,text[],text)'::regprocedure,
			'public.qorpera_surface_trigger_automation(uuid)'::regprocedure,
			'public.qorpera_native_surface_record_change(uuid,uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean,uuid,text,text,uuid,text)'::regprocedure,
			'public.qorpera_surface_sync_coding_completion(public.qorpera_coding_sessions,public.qorpera_runtime_workers,text,text,text,jsonb,jsonb,text[])'::regprocedure
		])
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception '20260930933000 function has an API owner: %', v_owner;
		end if;
		execute format(
			'grant execute on function public.qorpera_start_surface_session(uuid, text, text, text, text, jsonb, integer, text, text[], text), '
			|| 'public.qorpera_service_start_surface_session(uuid, uuid, text, text, text, text, integer, text, text[], text), '
			|| 'public.qorpera_record_surface_change(uuid, text, text, text, text, text, uuid[], text[], jsonb, jsonb, boolean, text, text, uuid, text) to %I',
			v_owner
		);
	end loop;

	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = 'public.qorpera_record_surface_change(uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean,text,text,uuid,text)'::regprocedure
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception '20260930933000 function has an API owner: %', v_owner;
		end if;
		execute format(
			'grant select, update on public.qorpera_member_surface_state, public.qorpera_surface_reconciliations, public.qorpera_surface_previews, public.qorpera_surface_sessions to %I',
			v_owner
		);
		execute format(
			'grant execute on function public.qorpera_surface_enqueue_standalone_dependents(uuid, uuid[]), public.qorpera_evaluate_surface_session_lifecycle(uuid) to %I',
			v_owner
		);
	end loop;

	select string_agg(p.oid::regprocedure::text, ', ')
	into v_bad
	from pg_proc as p
	join swgrh_before as b on b.oid = p.oid
	where p.pronamespace = 'public'::regnamespace
		and b.fields is distinct from (to_jsonb(p) - 'prosrc');
	if v_bad is not null then
		raise exception '20260930933000 changed function metadata on: %', v_bad;
	end if;
end $$;

drop function pg_temp.swgrh_patch(regprocedure, text[]);
drop function pg_temp.swgrh_apply(text, text, text[]);
drop table swgrh_before;
