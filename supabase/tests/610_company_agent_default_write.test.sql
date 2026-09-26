-- @fixture 290_company_file_path_gateway.test.sql until "-- Shared reads have an explicit"
-- No manual grant: exercise the real admitted run against its creation default.
select pg_temp.path_claims('service_role');
set local role service_role;
do $$
declare b jsonb := current_setting('qorpera_test.path_binding')::jsonb;
	v_result jsonb; v_plan jsonb; v_read jsonb;
begin
	perform public.qorpera_send_native_agent_message((b ->> 'leaseId')::uuid,(b ->> 'runId')::uuid,
		(b ->> 'jobId')::uuid,(b ->> 'runnerId')::uuid,(b ->> 'assignmentId')::uuid,
		(b ->> 'credentialCapsuleId')::uuid,(b ->> 'computeIdentityId')::uuid,
		'openai','codex-cli','default-write-ack','I am saving the research brief.','progress');
	v_result := pg_temp.path_commit(pg_temp.path_plan('default-mkdir','work','{"path":"work","kind":"directory"}'));
	if v_result ->> 'state' is distinct from 'applied' then raise exception 'Default cannot create work directory'; end if;
	v_plan := pg_temp.path_plan('default-report','work/qorpera-cloud-business-research.md',
		pg_temp.path_stage_file('work/qorpera-cloud-business-research.md','Research brief saved to the Company File.'));
	v_result := pg_temp.path_commit(v_plan);
	if v_result ->> 'state' is distinct from 'applied' then raise exception 'Default cannot save report'; end if;
	v_read := public.qorpera_read_company_path('29000000-0000-4000-8000-000000000020',
		'work/qorpera-cloud-business-research.md',b);
	if v_read #> '{entry,file}' is distinct from v_plan #> '{entry,file}'
		or v_read ->> 'version' is distinct from v_result ->> 'version' then
		raise exception 'Saved report cannot be read back at its confirmed version'; end if;
	if pg_temp.path_commit(v_plan) is distinct from v_result then raise exception 'Retry duplicated the write'; end if;
	v_result := pg_temp.path_commit(pg_temp.path_plan('default-delete','work/qorpera-cloud-business-research.md',
		null,(v_read ->> 'version')::uuid));
	if v_result ->> 'state' is distinct from 'proposed' then raise exception 'Default bypassed deletion approval'; end if;
	v_result := pg_temp.path_commit(pg_temp.path_plan('default-policy','authority.toml',
		pg_temp.path_stage_file('authority.toml','policy proposal')));
	if v_result ->> 'state' is distinct from 'proposed' then raise exception 'Default bypassed policy approval'; end if;
end $$;
reset role;

-- The migration uses this helper for existing agents. Only live defaults
-- upgrade; revoked, expired and explicit grants retain their restrictions.
do $$
declare v_profile uuid := '29000000-0000-4000-8000-000000000010';
	v_staff uuid := '29000000-0000-4000-8000-000000000030';
	v_resource public.qorpera_company_path_resources; v_grant uuid; v_probe text; v_count bigint;
begin
	select * into v_resource from public.qorpera_company_path_resources
	where environment_id = '29000000-0000-4000-8000-000000000020' and path = '';
	select id into strict v_grant from public.qorpera_company_path_grants
	where resource_id = v_resource.id and principal_id = v_staff and origin = 'default_agent_read';
	foreach v_probe in array array['live','revoked','expired','explicit','inactive'] loop
		begin
			update public.qorpera_company_path_grants set permissions = array['read'],
				created_at = clock_timestamp() - interval '1 minute',
				revoked_at = case when v_probe = 'revoked' then clock_timestamp() else null end,
				expires_at = case when v_probe = 'expired' then clock_timestamp() - interval '1 second' else null end,
				origin = case when v_probe = 'explicit' then 'explicit' else 'default_agent_read' end
			where id = v_grant;
			if v_probe = 'inactive' then
				update public.qorpera_profile_staff set employment_status = 'archived'
				where profile_id = v_profile and staff_agent_id = v_staff;
			end if;
			if v_probe = 'live' then
				begin
					perform public.qorpera_check_company_path_mutation('29000000-0000-4000-8000-000000000020',
						current_setting('qorpera_test.path_binding')::jsonb,
						pg_temp.path_plan('legacy-default','legacy-report','{"path":"legacy-report","kind":"directory"}'));
					raise exception 'Old read-only default unexpectedly allowed a write';
				exception when insufficient_privilege then null; end;
			end if;
			select count(*) into v_count from public.qorpera_company_path_grants where resource_id = v_resource.id;
			perform public.qorpera_ensure_default_agent_read_grants(v_profile,null);
			perform public.qorpera_ensure_default_agent_read_grants(v_profile,v_staff);
			if (select count(*) from public.qorpera_company_path_grants where resource_id = v_resource.id) <> v_count then
				raise exception 'Backfill duplicated or recreated % grant',v_probe; end if;
			if public.qorpera_company_path_principal_allowed(v_profile,v_resource,'staff_agent',v_staff,'write')
				is distinct from (v_probe = 'live') then raise exception 'Wrong upgrade access for %',v_probe; end if;
			if v_probe = 'live' and public.qorpera_check_company_path_mutation('29000000-0000-4000-8000-000000000020',
				current_setting('qorpera_test.path_binding')::jsonb,
				pg_temp.path_plan('legacy-default','legacy-report','{"path":"legacy-report","kind":"directory"}')) ->> 'state'
				is distinct from 'ready' then raise exception 'Upgraded default still denies ordinary writes'; end if;
			if v_probe <> 'explicit' then
				update public.qorpera_company_path_resources set version = extensions.gen_random_uuid() where id = v_resource.id;
				perform public.qorpera_ensure_default_agent_read_grants(v_profile,v_staff);
				if (select count(*) from public.qorpera_company_path_grants g
					join public.qorpera_company_path_resources r on r.id = g.resource_id and r.version = g.resource_version
					where r.id = v_resource.id and g.principal_id = v_staff) <> 1 then
					raise exception 'Root version did not carry exactly one % grant',v_probe; end if;
				if exists (select 1 from public.qorpera_company_path_grants g
					join public.qorpera_company_path_resources r on r.id = g.resource_id and r.version = g.resource_version
					where r.id = v_resource.id and g.principal_id = v_staff
						and (g.permissions is distinct from (select permissions from public.qorpera_company_path_grants where id = v_grant)
							or g.revoked_at is distinct from (select revoked_at from public.qorpera_company_path_grants where id = v_grant)
							or g.expires_at is distinct from (select expires_at from public.qorpera_company_path_grants where id = v_grant))) then
					raise exception 'Root version changed % grant restrictions',v_probe; end if;
				if v_probe in ('revoked','expired') then
					update public.qorpera_profile_staff set employment_status = 'archived'
					where profile_id = v_profile and staff_agent_id = v_staff;
					update public.qorpera_profile_staff set employment_status = 'active'
					where profile_id = v_profile and staff_agent_id = v_staff;
				end if;
				if (select public.qorpera_company_path_principal_allowed(v_profile,r,'staff_agent',v_staff,'write')
					from public.qorpera_company_path_resources r where r.id = v_resource.id)
					is distinct from (v_probe = 'live') then raise exception 'Version/rehire restored % access',v_probe; end if;
			end if;
			raise exception using errcode = 'QTC01';
		exception when sqlstate 'QTC01' then null; end;
	end loop;
end $$;

-- The old rollover trigger omitted inactive staff. Rehire recovers valid
-- platform defaults without losing expiry or overriding any access decision.
do $$
declare v_profile uuid := '29000000-0000-4000-8000-000000000010';
	v_staff uuid := '29000000-0000-4000-8000-000000000030';
	v_resource public.qorpera_company_path_resources; v_history public.qorpera_company_path_grants;
	v_probe text; v_allowed boolean; v_expiry timestamptz; v_count bigint;
begin
	select * into v_resource from public.qorpera_company_path_resources
	where environment_id = '29000000-0000-4000-8000-000000000020' and path = '';
	foreach v_probe in array array['read','read-write','finite','mixed-finite','mixed-unlimited','revoked','expired',
		'mixed-revoked','mixed-expired','mixed-explicit','current-revoked','current-explicit'] loop
		begin
			v_allowed := v_probe in ('read','read-write','finite','mixed-finite','mixed-unlimited');
			v_expiry := case when v_probe in ('finite','mixed-finite','mixed-unlimited') then clock_timestamp() + interval '1 hour' else null end;
			update public.qorpera_profile_staff set employment_status = 'archived'
			where profile_id = v_profile and staff_agent_id = v_staff;
			-- Model the database left by a pre-upgrade rollover: the archived
			-- agent's default remains at an older version, with no current row.
			update public.qorpera_company_path_grants set resource_version = extensions.gen_random_uuid(),
				permissions = case when v_probe = 'read-write' then array['read','write'] else array['read'] end,
				created_at = clock_timestamp() - interval '1 minute',
				revoked_at = case when v_probe = 'revoked' then clock_timestamp() else null end,
				expires_at = case when v_probe = 'expired' then clock_timestamp() - interval '1 second' else v_expiry end
			where resource_id = v_resource.id and principal_id = v_staff and origin = 'default_agent_read'
			returning * into strict v_history;
			if v_probe like 'mixed-%' or v_probe like 'current-%' then
				insert into public.qorpera_company_path_grants(resource_id,resource_version,principal_kind,principal_id,
					permissions,expires_at,revoked_at,created_at,created_by_user_id,origin)
				values (v_resource.id,case when v_probe like 'current-%' then v_resource.version else extensions.gen_random_uuid() end,
					'staff_agent',v_staff,array['read'],
					case when v_probe = 'mixed-expired' then clock_timestamp() - interval '1 second'
						when v_probe = 'mixed-finite' then clock_timestamp() + interval '2 hours' else null end,
					case when v_probe in ('mixed-revoked','current-revoked') then clock_timestamp() else null end,
					clock_timestamp() - interval '1 minute',v_history.created_by_user_id,
					case when v_probe in ('mixed-explicit','current-explicit') then 'explicit' else 'default_agent_read' end);
			end if;
			select count(*) into v_count from public.qorpera_company_path_grants where resource_id = v_resource.id;
			perform public.qorpera_ensure_default_agent_read_grants(v_profile,null);
			if (select count(*) from public.qorpera_company_path_grants where resource_id = v_resource.id) <> v_count then
				raise exception 'Backfill restored inactive % grant',v_probe; end if;
			update public.qorpera_profile_staff set employment_status = 'active'
			where profile_id = v_profile and staff_agent_id = v_staff;
			perform public.qorpera_ensure_default_agent_read_grants(v_profile,null);
			perform public.qorpera_ensure_default_agent_read_grants(v_profile,v_staff);
			if (select count(*) from public.qorpera_company_path_grants where resource_id = v_resource.id)
				<> v_count + v_allowed::integer then raise exception 'Wrong recovery count for %',v_probe; end if;
			if public.qorpera_company_path_principal_allowed(v_profile,v_resource,'staff_agent',v_staff,'write')
				is distinct from v_allowed then raise exception 'Wrong recovered write access for %',v_probe; end if;
			if public.qorpera_company_path_principal_allowed(v_profile,v_resource,'staff_agent',v_staff,'read')
				is distinct from (v_allowed or v_probe = 'current-explicit') then
				raise exception 'Wrong recovered read access for %',v_probe; end if;
			if v_allowed then
				if not exists (select 1 from public.qorpera_company_path_grants where resource_id = v_resource.id
					and resource_version = v_resource.version and principal_id = v_staff
					and expires_at is not distinct from v_expiry and created_at = v_history.created_at
					and created_by_user_id = v_history.created_by_user_id and origin = 'default_agent_read') then
					raise exception 'Recovery lost expiry or attribution for %',v_probe; end if;
				-- Confirm expiry continues to deny access after the restored grant lapses.
				if v_expiry is not null then
					update public.qorpera_company_path_grants set expires_at = clock_timestamp() - interval '1 second'
					where resource_id = v_resource.id and resource_version = v_resource.version and principal_id = v_staff;
					perform public.qorpera_ensure_default_agent_read_grants(v_profile,v_staff);
					if public.qorpera_company_path_principal_allowed(v_profile,v_resource,'staff_agent',v_staff,'read') then
						raise exception 'Recovery extended expired access for %',v_probe; end if;
				end if;
			end if;
			raise exception using errcode = 'QTC01';
		exception when sqlstate 'QTC01' then null; end;
	end loop;
end $$;

-- Before platform defaults existed, explicit root grants suppressed their
-- creation. A later expiry/revocation is not permission to add a fresh default.
do $$
declare v_profile uuid := '29000000-0000-4000-8000-000000000010';
	v_staff uuid := '29000000-0000-4000-8000-000000000030';
	v_resource public.qorpera_company_path_resources; v_probe text; v_historical boolean;
begin
	select * into v_resource from public.qorpera_company_path_resources
	where environment_id = '29000000-0000-4000-8000-000000000020' and path = '';
	foreach v_probe in array array['revoked','expired'] loop
		foreach v_historical in array array[false,true] loop
			begin
				update public.qorpera_company_path_grants set origin = 'explicit', permissions = array['read'],
					resource_version = case when v_historical then extensions.gen_random_uuid() else v_resource.version end,
					created_at = clock_timestamp() - interval '1 minute',
					revoked_at = case when v_probe = 'revoked' then clock_timestamp() else null end,
					expires_at = case when v_probe = 'expired' then clock_timestamp() - interval '1 second' else null end
				where resource_id = v_resource.id and principal_id = v_staff;
				perform public.qorpera_ensure_default_agent_read_grants(v_profile,null);
				update public.qorpera_profile_staff set employment_status = 'archived'
				where profile_id = v_profile and staff_agent_id = v_staff;
				update public.qorpera_profile_staff set employment_status = 'active'
				where profile_id = v_profile and staff_agent_id = v_staff;
				if exists (select 1 from public.qorpera_company_path_grants where resource_id = v_resource.id
					and principal_id = v_staff and origin = 'default_agent_read') then
					raise exception 'Explicit % grant was replaced by a default (historical=%)',v_probe,v_historical; end if;
				if public.qorpera_company_path_principal_allowed(v_profile,v_resource,'staff_agent',v_staff,'read') then
					raise exception 'Explicit % grant regained access (historical=%)',v_probe,v_historical; end if;
				raise exception using errcode = 'QTC01';
			exception when sqlstate 'QTC01' then null; end;
		end loop;
	end loop;
end $$;

-- A more-specific private resource still overrides the usable shared root.
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_set_company_path_resource('29000000-0000-4000-8000-000000000020',
	'private-report.md','exact','member_private','normal');
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
do $$
begin
	begin
		perform pg_temp.path_commit(pg_temp.path_plan('private-denied','private-report.md',
			pg_temp.path_stage_file('private-report.md','Must not be written')));
		raise exception 'Shared default crossed a private resource boundary';
	exception when insufficient_privilege then null; end;
end $$;
reset role;

set constraints all immediate;
rollback;
