set local lock_timeout = '3s';

create or replace function public.qorpera_machine_data_pass(p_environment_id uuid, p_actor jsonb, p_database text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_auth jsonb; v_view public.qorpera_folder_views%rowtype; v_entries jsonb; v_pass text; v_expires timestamptz;
begin
	-- WHY: markers 20260930775000 and 20260930829000, read in pg_proc.prosrc by SQL tests 1273 and 1319.
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if jsonb_typeof(p_actor) is distinct from 'object' or p_actor ->> 'kind' is distinct from 'view' then
		raise exception 'A machine''s data pass is for a view' using errcode = '22023'; end if;
	if p_database is not null and (p_database !~ '^[a-z][a-z0-9_]{0,39}$' or p_database = 'qorpera'
			or p_database ~ '^(pg_|qorpera_)') then
		raise exception 'Database name is invalid' using errcode = '22023'; end if;
	v_auth := public.qorpera_folder_read_actor(p_environment_id, p_actor);
	if coalesce(v_auth #>> '{view,kind}', '') not in ('test_machine', 'coding_session')
			or v_auth ->> 'kind' is distinct from 'staff_agent' then
		raise exception 'A machine''s data pass is for a company machine''s view' using errcode = '22023'; end if;
	select view.* into strict v_view from public.qorpera_folder_views as view where view.id = (v_auth #>> '{view,id}')::uuid;
	if v_view.state <> 'open' or v_view.machine_id is null then
		raise exception 'Folder view has ended' using errcode = '42501'; end if;
	if v_view.kind = 'coding_session' and not exists (
			select 1 from public.qorpera_coding_sessions as cs
			join public.qorpera_coding_machines as m on m.id = cs.attached_machine_id
			where cs.worker_id = v_view.worker_id and cs.attachment_token = v_view.attachment_token
				and cs.archived_at is null and m.id = v_view.machine_id
				and m.removing_at is null and m.removed_at is null and m.folder_restart_at is null) then
		raise exception 'Folder view has ended' using errcode = '42501'; end if;
	v_entries := public.qorpera_data_pass_listing(p_environment_id, p_actor, p_database);
	v_pass := public.qorpera_folder_view_new_pass();
	insert into public.qorpera_data_passes(pass_sha256, kind, environment_id, view_id, machine_id, staff_agent_id,
		requester_user_id, database, files, expires_at)
	values (extensions.digest(v_pass, 'sha256'), 'machine', p_environment_id, v_view.id, v_view.machine_id,
		(v_auth ->> 'staffAgentId')::uuid, (v_auth ->> 'requesterUserId')::uuid, p_database,
		public.qorpera_data_pass_files(v_entries), clock_timestamp() + interval '60 seconds')
	returning expires_at into v_expires;
	return jsonb_build_object('schema', 'qorpera.machine-data-pass/v1', 'pass', v_pass, 'expiresAt', v_expires,
		'files', jsonb_array_length(v_entries),
		'entries', coalesce((select jsonb_agg(jsonb_build_object('path', e.value ->> 'path', 'version', e.value -> 'version',
			'authority', e.value -> 'authority') order by e.ordinality)
			from jsonb_array_elements(v_entries) with ordinality as e), '[]'::jsonb));
end $$;

create or replace function public.qorpera_data_pass_redeem(p_pass text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.qorpera_data_passes%rowtype;
begin
	-- WHY: markers 20260930750000, 20260930764000, 20260930775000 and 20260930829000, read by SQL tests 1262, 1273 and 1319.
	if p_pass is null or p_pass !~ '^[A-Za-z0-9_-]{43}$' then return null; end if;
	update public.qorpera_data_passes set redeemed_at = clock_timestamp()
	where pass_sha256 = extensions.digest(p_pass, 'sha256') and redeemed_at is null and expires_at > clock_timestamp()
	returning * into v_row;
	if not found then return null; end if;
	if v_row.kind = 'machine' then
		if not exists (select 1 from public.qorpera_folder_views as view where view.id = v_row.view_id
				and view.kind in ('test_machine', 'coding_session')
				and view.state = 'open' and view.machine_id = v_row.machine_id and public.qorpera_folder_view_valid(view)
				and not public.qorpera_company_execution_paused(view.profile_id)
				and exists (select 1 from public.qorpera_profile_staff as staff where staff.profile_id = view.profile_id
					and staff.staff_agent_id = view.staff_agent_id and staff.employment_status = 'active')
				and exists (select 1 from public.qorpera_profile_members as member where member.profile_id = view.profile_id
					and member.user_id = view.member_user_id)
				and (view.kind <> 'coding_session' or exists (
					select 1 from public.qorpera_coding_sessions as cs
					join public.qorpera_coding_machines as m on m.id = cs.attached_machine_id
					where cs.worker_id = view.worker_id and cs.attachment_token = view.attachment_token
						and cs.archived_at is null and m.id = view.machine_id
						and m.removing_at is null and m.removed_at is null and m.folder_restart_at is null))) then
			return null; end if;
		return jsonb_build_object('schema', 'qorpera.data-pass-redeemed/v1', 'kind', 'machine',
			'environmentId', v_row.environment_id, 'viewId', v_row.view_id, 'machineId', v_row.machine_id,
			'staffAgentId', v_row.staff_agent_id, 'requesterUserId', v_row.requester_user_id, 'database', v_row.database,
			'files', v_row.files);
	end if;
	if not exists (select 1 from public.qorpera_runner_jobs j where j.id = v_row.job_id and j.run_id = v_row.run_id
			and j.status = 'leased' and j.lease_expires_at > clock_timestamp()) then
		return null; end if;
	return jsonb_build_object('schema', 'qorpera.data-pass-redeemed/v1', 'kind', v_row.kind,
		'environmentId', v_row.environment_id, 'runId', v_row.run_id, 'staffAgentId', v_row.staff_agent_id,
		'requesterUserId', v_row.requester_user_id, 'database', v_row.database, 'files', v_row.files)
		|| case when v_row.allow is null then '{}'::jsonb else jsonb_build_object('allow', v_row.allow) end;
end $$;

revoke all on function public.qorpera_machine_data_pass(uuid, jsonb, text) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_machine_data_pass(uuid, jsonb, text) to service_role;
revoke all on function public.qorpera_data_pass_redeem(text) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_data_pass_redeem(text) to anon;
