-- @fixture 764_chatgpt_plan_login.test.sql until "-- A plan login is never listed for the account record the node switch-off reads; the Codex login is."
-- Sign in with ChatGPT, slice 1c (20260929916000): deleting a company ends its members' ChatGPT plan logins
-- at OpenAI before the purge. Test 764's fixture leaves the company with a member's plan login and a
-- Codex vault login, and the company's broker. (Test 773 races the revocation against a run's lease check.)
reset role;
select set_config('request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',false);
do $$
declare v_plan uuid; v_codex uuid;
begin
	select version.connection_id into strict v_plan from public.qorpera_provider_connection_versions as version
	join public.qorpera_model_logins as login on login.credential_capsule_id = version.credential_capsule_id
	where login.id = '76400000-0000-4000-8000-000000000150' and version.version = 1;
	select version.connection_id into strict v_codex from public.qorpera_provider_connection_versions as version
	join public.qorpera_model_logins as login on login.credential_capsule_id = version.credential_capsule_id
	where login.id = '76400000-0000-4000-8000-000000000250' and version.version = 1;
	perform set_config('qorpera_test.r771', jsonb_build_object('plan', v_plan, 'codex', v_codex)::text, false);
	-- Nobody but the kernel calls the new functions.
	if exists (select 1 from unnest(array['anon','authenticated','service_role']) as role(name)
		cross join unnest(array['public.qorpera_revoke_company_chatgpt_plan_logins(uuid)',
			'public.qorpera_company_chatgpt_plan_logins_open(uuid)',
			'public.qorpera_abandon_company_chatgpt_plan_logins(uuid)']) as fn(signature)
		where has_function_privilege(role.name, fn.signature, 'execute')) then
		raise exception 'a plan deletion helper is callable from the API'; end if;
end $$;

-- The company is being deleted.
-- Another company's plan login stays as it is: the same member's plan login, copied (its own rows only, so
-- nothing of this company is left depending on it) onto the fixture's other company.
set local session_replication_role = replica;
insert into public.qorpera_provider_connections
select (jsonb_populate_record(connection, jsonb_build_object('id', '77100000-0000-4000-8000-000000000001',
	'profile_id', '76400000-0000-4000-8000-000000000010', 'client_connection_id', '77100000-0000-4000-8000-000000000002'))).*
from public.qorpera_provider_connections as connection
where connection.id = (current_setting('qorpera_test.r771')::jsonb ->> 'plan')::uuid;
insert into public.qorpera_provider_connection_versions
select (jsonb_populate_record(source, jsonb_build_object('connection_id', '77100000-0000-4000-8000-000000000001',
	'credential_capsule_id', '77100000-0000-4000-8000-000000000003'))).*
from public.qorpera_provider_connection_versions as source
where source.connection_id = (current_setting('qorpera_test.r771')::jsonb ->> 'plan')::uuid and source.version = 1;
insert into public.qorpera_model_logins
select (jsonb_populate_record(login, jsonb_build_object('id', '77100000-0000-4000-8000-000000000004',
	'profile_id', '76400000-0000-4000-8000-000000000010', 'credential_capsule_id', '77100000-0000-4000-8000-000000000003',
	'sign_in_session_id', '77100000-0000-4000-8000-000000000005', 'compute_identity_id', '77100000-0000-4000-8000-000000000006',
	'broker_authority_id', '77100000-0000-4000-8000-000000000007'))).*
from public.qorpera_model_logins as login where login.id = '76400000-0000-4000-8000-000000000150';
-- A run the plan pays for is still leased (what slice 4 enables): the fixture's leased job.
update public.qorpera_execution_sponsor_versions as sponsor
set provider_connection_id = (current_setting('qorpera_test.r771')::jsonb ->> 'plan')::uuid, provider_connection_version = 1
from public.qorpera_execution_runs as run join public.qorpera_runner_jobs as job on job.id = run.job_id
where sponsor.binding_id = run.sponsor_binding_id and sponsor.version = run.sponsor_version and job.status = 'leased'
	and run.profile_id = '16000000-0000-4000-8000-000000000010';
set local session_replication_role = origin;
-- Both companies are being deleted; each pass counts its own company's logins only.
insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
values ('16000000-0000-4000-8000-000000000010', '16000000-0000-4000-8000-000000000001'),
	('76400000-0000-4000-8000-000000000010', '16000000-0000-4000-8000-000000000001');
do $$
begin
	if not exists (select 1 from public.qorpera_runner_jobs as job
		join public.qorpera_execution_runs as run on run.job_id = job.id
		join public.qorpera_execution_sponsor_versions as sponsor
			on sponsor.binding_id = run.sponsor_binding_id and sponsor.version = run.sponsor_version
		where job.status = 'leased' and sponsor.provider_connection_id = (current_setting('qorpera_test.r771')::jsonb ->> 'plan')::uuid) then
		raise exception 'the fixture has no leased job on the plan'; end if;
	-- The revocation leaves a connection alone while a job it pays is queued or leased: the stop left that job
	-- because a runtime call holds it, and the connection's trigger would wait for the job under the fence.
	perform public.qorpera_revoke_company_chatgpt_plan_logins('16000000-0000-4000-8000-000000000010');
	if (select status from public.qorpera_provider_connections
		where id = (current_setting('qorpera_test.r771')::jsonb ->> 'plan')::uuid) <> 'active' then
		raise exception 'the plan connection was revoked while it paid a leased job'; end if;
end $$;
-- The same for a queued job (the job is queued again for this check alone).
create function pg_temp.r771_job_status(p_status text) returns void language plpgsql as $$
begin
	update public.qorpera_runner_jobs as job set status = p_status,
		lease_token_sha256 = case when p_status = 'leased' then repeat('d', 64) end,
		lease_expires_at = case when p_status = 'leased' then clock_timestamp() + interval '5 minutes' end
	from public.qorpera_execution_runs as run
	join public.qorpera_execution_sponsor_versions as sponsor
		on sponsor.binding_id = run.sponsor_binding_id and sponsor.version = run.sponsor_version
	where run.job_id = job.id and sponsor.provider_connection_id = (current_setting('qorpera_test.r771')::jsonb ->> 'plan')::uuid
		and job.status in ('queued', 'leased');
end $$;
set local session_replication_role = replica;
select pg_temp.r771_job_status('queued');
set local session_replication_role = origin;
do $$
begin
	perform public.qorpera_revoke_company_chatgpt_plan_logins('16000000-0000-4000-8000-000000000010');
	if (select status from public.qorpera_provider_connections
		where id = (current_setting('qorpera_test.r771')::jsonb ->> 'plan')::uuid) <> 'active' then
		raise exception 'the plan connection was revoked while it paid a queued job'; end if;
end $$;
set local session_replication_role = replica;
select pg_temp.r771_job_status('leased');
set local session_replication_role = origin;

-- A pass of the finisher: its stop ends the job (nothing holds it here), then it revokes the plan login's
-- connection (the Codex login's stays, for the purge, and so does the other company's plan login), and waits
-- for the vault to end the login.
do $$
declare v_result jsonb := public.qorpera_finish_company_deletion('16000000-0000-4000-8000-000000000010');
begin
	if v_result ->> 'state' <> 'waiting' or v_result #>> '{holdings,chatgpt_plan_logins}' <> '1' then
		raise exception 'the finisher does not wait for the plan login: %', v_result; end if;
	if (select status from public.qorpera_provider_connections
		where id = (current_setting('qorpera_test.r771')::jsonb ->> 'plan')::uuid) <> 'revoked' then
		raise exception 'the plan login''s connection was not revoked'; end if;
	if (select status from public.qorpera_provider_connections
		where id = (current_setting('qorpera_test.r771')::jsonb ->> 'codex')::uuid) <> 'active' then
		raise exception 'the Codex login''s connection changed'; end if;
	if (select status from public.qorpera_provider_connections where id = '77100000-0000-4000-8000-000000000001') <> 'active' then
		raise exception 'another company''s plan login was revoked'; end if;
end $$;

-- The finisher waits also for a login that needs a new sign-in (the vault ends that too), and for 6 hours
-- at most after the deletion was requested.
create function pg_temp.r771_open(p_requested_ago interval) returns bigint language plpgsql as $$
begin
	update public.qorpera_company_deletions set requested_at = clock_timestamp() - p_requested_ago
	where profile_id = '16000000-0000-4000-8000-000000000010';
	return public.qorpera_company_chatgpt_plan_logins_open('16000000-0000-4000-8000-000000000010');
end $$;
update public.qorpera_model_logins set status = 'needs_sign_in' where id = '76400000-0000-4000-8000-000000000150';
do $$
begin
	if pg_temp.r771_open(interval '1 minute') <> 1 then
		raise exception 'the finisher does not wait for a plan login that needs a new sign-in'; end if;
end $$;
update public.qorpera_model_logins set status = 'active' where id = '76400000-0000-4000-8000-000000000150';
do $$
begin
	if pg_temp.r771_open(interval '5 hours 59 minutes') <> 1 then
		raise exception 'the finisher stops waiting for a plan login before 6 hours'; end if;
	if pg_temp.r771_open(interval '6 hours 1 minute') <> 0 then
		raise exception 'the finisher waits for a plan login past 6 hours'; end if;
end $$;
-- Past 6 hours the login is counted in the log (it lapses at OpenAI) and deleted with the company.
savepoint r771_cap;
do $$
declare v_result jsonb;
begin
	if public.qorpera_abandon_company_chatgpt_plan_logins('16000000-0000-4000-8000-000000000010') <> 1 then
		raise exception 'the plan login left open is not counted'; end if;
	v_result := public.qorpera_finish_company_deletion('16000000-0000-4000-8000-000000000010');
	if v_result ->> 'state' <> 'purged'
		or exists (select 1 from public.qorpera_model_logins where id = '76400000-0000-4000-8000-000000000150') then
		raise exception 'the plan login past 6 hours was not deleted with the company: %', v_result; end if;
end $$;
rollback to savepoint r771_cap;
select pg_temp.r771_open(interval '1 minute');

-- The vault's upkeep takes the login (its connection is revoked) and ends it at OpenAI.
set local session authorization qorpera_secret_broker;
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_take_chatgpt_plan_revocation(%L,%L)::text',
	'76400000-0000-4000-8000-000000000040', repeat('c',64))), 'ok', 'the vault takes the plan login');
reset session authorization;
do $$
begin
	if current_setting('qorpera_test.plan764_last')::jsonb ->> 'loginId' <> '76400000-0000-4000-8000-000000000150' then
		raise exception 'the vault did not take the deleting company''s plan login: %', current_setting('qorpera_test.plan764_last'); end if;
end $$;
set local session authorization qorpera_secret_broker;
select pg_temp.plan764_expect(pg_temp.plan764_try(format('select public.qorpera_finish_chatgpt_plan_revocation(%L,%L,%L,%L,%s)::text',
	'76400000-0000-4000-8000-000000000040', repeat('c',64), '76400000-0000-4000-8000-000000000150',
	current_setting('qorpera_test.plan764_last')::jsonb #>> '{revocation,token}',
	current_setting('qorpera_test.plan764_last')::jsonb #>> '{revocation,baseVersion}')), 'ok', 'the vault ends it');
reset session authorization;
-- Checked before the next pass, which purges the company with its rows.
do $$
declare v_result jsonb;
begin
	if (select status from public.qorpera_model_logins where id = '76400000-0000-4000-8000-000000000150') <> 'revoked' then
		raise exception 'the plan login was not marked revoked'; end if;
	if public.qorpera_company_chatgpt_plan_logins_open('16000000-0000-4000-8000-000000000010') <> 0 then
		raise exception 'the finisher still waits for an ended plan login'; end if;
	if public.qorpera_abandon_company_chatgpt_plan_logins('16000000-0000-4000-8000-000000000010') <> 0 then
		raise exception 'an ended plan login is counted as left open'; end if;
	v_result := public.qorpera_finish_company_deletion('16000000-0000-4000-8000-000000000010');
	if v_result ->> 'state' <> 'purged' then
		raise exception 'the finisher did not purge once the plan login ended: %', v_result; end if;
end $$;

rollback;
