-- 20260930396000: step 5a, the folder service that serves a view, and the code host's view
-- (deploy/first-node/RUNTIME-FOLDER-CODING-MACHINES.md, "The folder service"; 5c builds the service against it).
-- 1. qorpera_folder_views.served_by names the folder service that serves a coding or code host view. The service sends its
--    id, new at each start, with every renewal (qorpera_folder_view_renew's p_service; the three-argument form is
--    dropped). The first renewal sets it. A renewal from another service while it is set closes the view as
--    'service_crashed': the old service may have served reads it never released. qorpera_folder_service_stopped (a clean
--    stop, after the service released and published everything) clears it, and the views stay open.
-- 2. The renewal's answer names the company and, for a coding session, its coding machine.
-- 3. The code host's view (kind 'code_host'): the platform opens it with an empty anchor, for the service that hosts the
--    company's repositories. It has no agent or member and acts as the platform, on code/ only: the fence is in
--    qorpera_folder_actor_allowed, qorpera_folder_actor_keys_allowed and qorpera_folder_paths_authority. Its commits
--    record the platform and the view; its releases record nothing, since the platform reads under no grant.
-- Every patched body names this migration (20260930396000), and every earlier marker in it stays.

set local lock_timeout = '3s';

-- Applies each (old, new) pair in turn, each old text exactly once, then runs the result.
create or replace function pg_temp.s5a_patch(p_target regprocedure, p_edits text[]) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_found integer;
begin
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception 'Step 5a anchor found % time(s) in %, expected 1: %', v_found, p_target, left(p_edits[2 * i - 1], 80); end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

-- 1. Views: the service that serves them. --------------------------------------------------------------------------

alter table public.qorpera_folder_views add column served_by uuid;
create index qorpera_folder_views_served_by on public.qorpera_folder_views(served_by) where served_by is not null;

-- 2. Renewal names the service. ----------------------------------------------------------------------------------

drop function public.qorpera_folder_view_renew(uuid, text, timestamptz);
create function public.qorpera_folder_view_renew(p_view_id uuid, p_pass text, p_unsaved_since timestamptz default null,
	p_service uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_view public.qorpera_folder_views%rowtype; v_ok boolean;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	select * into v_view from public.qorpera_folder_views where id = p_view_id for no key update;
	if not found or v_view.pass_sha256 <> extensions.digest(coalesce(p_pass, ''), 'sha256') then
		raise exception 'Folder view is unavailable' using errcode = '42501'; end if;
	-- 20260930396000 (step 5a): a coding or code host view is renewed by the folder service that serves it, named by
	-- its id (new at each start).
	if v_view.kind in ('coding_session','code_host') and p_service is null then
		raise exception 'Folder service is required' using errcode = '22023'; end if;
	if v_view.state = 'closed' then
		return jsonb_build_object('schema','qorpera.folder-view-renew/v1','state','closed','reason',v_view.close_reason); end if;
	-- A view another service served and never let go of (qorpera_folder_service_stopped) may have served reads that
	-- were never released: it is refused, and the session opens a new view.
	if v_view.kind in ('coding_session','code_host') and v_view.served_by <> p_service then
		update public.qorpera_folder_views set state = 'closed', closed_at = clock_timestamp(), close_reason = 'service_crashed'
		where id = v_view.id returning * into v_view;
		return jsonb_build_object('schema','qorpera.folder-view-renew/v1','state','closed','reason',v_view.close_reason);
	end if;
	v_ok := public.qorpera_folder_view_valid(v_view)
		-- A code host's view (20260930396000) has no agent or member: it acts as the platform.
		and (v_view.kind = 'code_host' or (exists (select 1 from public.qorpera_profile_staff where profile_id = v_view.profile_id
				and staff_agent_id = v_view.staff_agent_id and employment_status = 'active')
			and exists (select 1 from public.qorpera_profile_members where profile_id = v_view.profile_id
				and user_id = v_view.member_user_id)));
	if not v_ok then
		update public.qorpera_folder_views set state = 'closed', closed_at = clock_timestamp(),
			close_reason = case when v_view.lease_until <= clock_timestamp() then 'expired' else 'ended' end
		where id = v_view.id returning * into v_view;
		return jsonb_build_object('schema','qorpera.folder-view-renew/v1','state','closed','reason',v_view.close_reason);
	end if;
	update public.qorpera_folder_views set lease_until = clock_timestamp() + interval '120 seconds', renewed_at = clock_timestamp(),
		unsaved_since = p_unsaved_since,
		served_by = case when v_view.kind in ('coding_session','code_host') then p_service end
	where id = v_view.id returning * into v_view;
	-- 20260930104000: the open answer says what the view is and which machine it belongs to; 20260930396000: and whose
	-- it is, the company and, for a coding session, its coding machine (the same id as its machine).
	return jsonb_build_object('schema','qorpera.folder-view-renew/v1','state','open','leaseUntil',v_view.lease_until,
		'kind',v_view.kind,'machineId',v_view.machine_id,'companyId',v_view.profile_id,
		'codingMachineId',case when v_view.kind = 'coding_session' then v_view.machine_id end);
end $$;

-- A clean stop: the service has released every read it recorded and published everything, so its views may be served
-- by the next service. They stay open.
create function public.qorpera_folder_service_stopped(p_service uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_service is null then raise exception 'Folder service is required' using errcode = '22023'; end if;
	perform 1 from public.qorpera_folder_views where served_by = p_service order by id for no key update;
	update public.qorpera_folder_views set served_by = null where served_by = p_service;
	get diagnostics v_count = row_count;
	return v_count;
end $$;

-- 3. The code host's view. --------------------------------------------------------------------------------------------

-- The platform opens it for the folder service that hosts the company's repositories. It has no agent or member: it acts
-- as the platform, on code/ only, and is anchored to nothing.
alter table public.qorpera_folder_views
	alter column staff_agent_id drop not null,
	alter column member_user_id drop not null,
	add constraint qorpera_folder_views_code_host_principals
		check ((kind = 'code_host') = (staff_agent_id is null) and (kind = 'code_host') = (member_user_id is null)),
	add constraint qorpera_folder_views_code_host check (kind <> 'code_host' or (worker_id is null and machine_id is null
		and screen_id is null and run_id is null and shell_command_id is null and holder_run_id is null and holder_user_id is null)),
	drop constraint qorpera_folder_views_kind_check,
	add constraint qorpera_folder_views_kind_check
		check (kind in ('run_box','computer_desktop','computer_shell_command','coding_session','test_machine','code_host')),
	drop constraint qorpera_folder_views_built_kind,
	add constraint qorpera_folder_views_built_kind
		check (kind in ('run_box','computer_desktop','computer_shell_command','coding_session','code_host')),
	drop constraint qorpera_folder_views_close_reason_check,
	add constraint qorpera_folder_views_close_reason_check
		check (close_reason in ('closed','superseded','ended','expired','service_crashed'));
alter table public.qorpera_folder_commits
	drop constraint qorpera_folder_commits_view_kind_check,
	add constraint qorpera_folder_commits_view_kind_check
		check (view_kind in ('run_box','computer_desktop','computer_shell_command','coding_session','test_machine','code_host'));

select pg_temp.s5a_patch('public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)', array[
	$old$	if p_kind not in ('run_box','computer_desktop','computer_shell_command','coding_session') -- 20260930183000$old$,
	$new$	if p_kind not in ('run_box','computer_desktop','computer_shell_command','coding_session','code_host') -- 20260930183000, 20260930396000$new$,
	$old$		raise exception 'Folder view opener is invalid' using errcode = '22023'; end if;

$old$,
	$new$		raise exception 'Folder view opener is invalid' using errcode = '22023'; end if;

	-- 20260930396000 (step 5a): the code host's view, for the folder service that hosts the company's repositories.
	if p_kind = 'code_host' then
		if p_anchor <> '{}'::jsonb then raise exception 'Folder view anchor is invalid' using errcode = '22023'; end if;
		insert into public.qorpera_folder_views(environment_id, profile_id, kind, pass_sha256, lease_until)
		values (p_environment_id, v_file.profile_id, 'code_host', extensions.digest(v_pass, 'sha256'),
			clock_timestamp() + interval '120 seconds')
		returning * into v_view;
		return jsonb_build_object('schema','qorpera.folder-view/v1','viewId',v_view.id,'pass',v_pass,'leaseUntil',v_view.lease_until);
	end if;

$new$
]);

select pg_temp.s5a_patch('public.qorpera_folder_view_valid(public.qorpera_folder_views)', array[
	$old$		else false end$old$,
	$new$		when 'code_host' then true -- 20260930396000: its lease alone
		else false end$new$
]);

select pg_temp.s5a_patch('public.qorpera_folder_view_resolve(uuid,uuid,jsonb)', array[
	$old$		'companyWide', v_view.kind in ('computer_desktop','computer_shell_command'));
$old$,
	$new$		'companyWide', v_view.kind in ('computer_desktop','computer_shell_command'));
	-- 20260930396000 (step 5a): a code host's view acts as the platform. The pause does not stop it; a deletion does,
	-- as qorpera_folder_read_actor stops the platform.
	if v_view.kind = 'code_host' then
		if exists (select 1 from public.qorpera_company_deletions where profile_id = p_profile_id) then
			raise exception 'Company is being deleted' using errcode = '55000'; end if;
		return jsonb_build_object('kind','platform','view',v_view_json);
	end if;
$new$
]);

-- 4. The code/ fence. -------------------------------------------------------------------------------------------------

-- True when a code host's view names a path outside code/. Keys are case-folded and paths never hold '%'.
create function public.qorpera_folder_code_host_outside(p_actor jsonb, p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
	select coalesce(p_actor -> 'view' ->> 'kind' = 'code_host', false)
		and not coalesce(public.qorpera_folder_key(p_path) = 'code' or public.qorpera_folder_key(p_path) like 'code/%', false)
$$;

select pg_temp.s5a_patch('public.qorpera_folder_actor_allowed(uuid,uuid,jsonb,text,text)', array[
	$old$	return public.qorpera_folder_actor_resource_allowed(p_profile_id, p_actor,$old$,
	$new$	-- 20260930396000 (step 5a): a code host's view acts as the platform, on code/ only.
	if public.qorpera_folder_code_host_outside(p_actor, p_path) then return false; end if;
	return public.qorpera_folder_actor_resource_allowed(p_profile_id, p_actor,$new$
]);

select pg_temp.s5a_patch('public.qorpera_folder_actor_keys_allowed(uuid,uuid,jsonb,text,text[],text)', array[
	$old$	return not exists (
		with res as materialized ($old$,
	$new$	-- 20260930396000 (step 5a): a code host's view, as the platform, needs no resource's grant; the boundaries above
	-- code/ would refuse it. Only the fence applies.
	if p_actor -> 'view' ->> 'kind' = 'code_host' then
		return not exists (select 1 from unnest(p_keys) k(key) where public.qorpera_folder_code_host_outside(p_actor, k.key));
	end if;
	return not exists (
		with res as materialized ($new$
]);

-- Reads decided per resource (downloads, releases, byte possession) apply the fence per path.
select pg_temp.s5a_patch('public.qorpera_folder_paths_authority(uuid,uuid,jsonb,text[])', array[
	$old$	select covered.path, (covered.resource).id, coalesce(decided.ok, false),$old$,
	$new$	-- 20260930396000 (step 5a): a code host's view reads code/ only.
	select covered.path, (covered.resource).id,
		coalesce(decided.ok, false) and not public.qorpera_folder_code_host_outside(p_actor, covered.path),$new$
]);

-- 5. Commits and releases through it. --------------------------------------------------------------------------------

select pg_temp.s5a_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)', array[
	$old$			v_hook_actor := jsonb_build_object('kind','member','userId',v_resolved ->> 'userId');
		else
$old$,
	$new$			v_hook_actor := jsonb_build_object('kind','member','userId',v_resolved ->> 'userId');
		elsif v_resolved ->> 'kind' = 'platform' then
			-- 20260930396000 (step 5a): a code host's view acts as the platform, on code/ only
			-- (qorpera_folder_actor_allowed). It has no agent or member to lock.
			v_auth_actor := v_resolved;
			v_hook_actor := jsonb_build_object('kind','platform');
		else
$new$,
	$old$	elsif v_actor_kind = 'view' then
		v_targets := v_targets || jsonb_build_array(jsonb_build_object('rank', 1,$old$,
	$new$	elsif v_actor_kind = 'view' and v_resolved ->> 'kind' = 'member' then -- 20260930396000
		v_targets := v_targets || jsonb_build_array(jsonb_build_object('rank', 1,$new$,
	$old$		case when v_actor_kind in ('run','view') then 'member' else v_actor_kind end,$old$,
	$new$		case when v_actor_kind = 'view' and v_resolved ->> 'kind' = 'platform' then 'platform' -- 20260930396000
			when v_actor_kind in ('run','view') then 'member' else v_actor_kind end,$new$,
	$old$	if v_actor_kind <> 'platform' and exists (select 1 from public.qorpera_folder_journal j$old$,
	$new$	if v_actor_kind <> 'platform' and v_resolved ->> 'kind' is distinct from 'platform' -- 20260930396000
		and exists (select 1 from public.qorpera_folder_journal j$new$
]);

select pg_temp.s5a_patch('public.qorpera_folder_record_view_release(uuid,uuid,jsonb,uuid,jsonb,text,text)', array[
	$old$		v_early := public.qorpera_folder_view_resolve(p_environment_id, p_profile_id, p_actor);
		if v_early ->> 'kind' = 'member' then
			raise exception 'A member-held view records no reads' using errcode = '22023'; end if;
$old$,
	$new$		v_early := public.qorpera_folder_view_resolve(p_environment_id, p_profile_id, p_actor);
		if v_early ->> 'kind' = 'member' then
			raise exception 'A member-held view records no reads' using errcode = '22023'; end if;
		-- 20260930396000 (step 5a): a code host's view acts as the platform, under no grant: nothing to record.
		if v_early ->> 'kind' = 'platform' then
			return jsonb_build_object('schema','qorpera.folder-release/v1','releaseId',p_release_id,
				'reads',jsonb_array_length(p_reads),'replay',false,'runId',null);
		end if;
$new$
]);

select pg_temp.s5a_patch('public.qorpera_folder_run_inherit_view_reads(uuid,jsonb,uuid,uuid)', array[
	$old$	select * into v_view from public.qorpera_folder_views where id = p_view_id;
$old$,
	$new$	select * into v_view from public.qorpera_folder_views where id = p_view_id;
	-- 20260930396000 (step 5a): a code host's view has no agent or member, so no run's matches it.
$new$,
	$old$v_view.staff_agent_id <> (v_resolved ->> 'staffAgentId')::uuid$old$,
	$new$v_view.staff_agent_id is distinct from (v_resolved ->> 'staffAgentId')::uuid$new$,
	$old$v_view.member_user_id <> (v_resolved ->> 'requesterUserId')::uuid$old$,
	$new$v_view.member_user_id is distinct from (v_resolved ->> 'requesterUserId')::uuid$new$
]);

-- 6. Grants -----------------------------------------------------------------------------------------------------------

revoke all on function public.qorpera_folder_code_host_outside(jsonb, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_folder_view_renew(uuid, text, timestamptz, uuid),
	public.qorpera_folder_service_stopped(uuid)
	from public, anon, authenticated;
grant execute on function public.qorpera_folder_view_renew(uuid, text, timestamptz, uuid),
	public.qorpera_folder_service_stopped(uuid)
	to service_role;
