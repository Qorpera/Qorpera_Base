-- Sign in with ChatGPT, slice 1c (founder decisions 2026-10-01; built switched off with the login kind,
-- 20260928329830): deleting a company ends its members' ChatGPT plan logins at OpenAI before the purge.
--
-- Until now the purge deleted plan logins with the company, so their refresh tokens stayed live at OpenAI
-- for up to 30 days, and the vault's revocation pass never saw them (it takes a plan login only once its
-- capsule, versions or connection are revoked). Now the deletion finisher revokes the company's plan-login
-- connections, as for a member who left the company; the vault's upkeep then ends each login at OpenAI
-- and marks it revoked (qorpera_take_chatgpt_plan_revocation and qorpera_finish_chatgpt_plan_revocation,
-- which ignore the plan switches by design; the company's broker authority stays active until the purge).
-- The finisher waits while plan logins are open, at most 6 hours after the deletion was requested, like
-- connector tokens (20260928269500); a login still open then is deleted with the company and lapses at
-- OpenAI within 30 days, and the purging pass writes a server log line that counts it (raise log, as the
-- connector tokens keep abandoned receipts). Codex logins are unchanged.
--
-- Locks: none added. The revocation updates only the company's plan-login connections, in the finisher's
-- existing transaction after its fence and stop. It skips a connection while a job it pays is still queued
-- or leased: the stop left that job because a runtime call holds it (job before fence), and the connection's
-- status trigger would wait for that job under the fence, a deadlock with the run's lease check. The stop
-- ends the job on a later pass, and the revocation follows; meanwhile the count keeps the finisher waiting.
-- The count reads the company's logins by profile.

set local lock_timeout = '3s';

-- Revokes the connections of a company's ChatGPT plan logins (each login's capsule names its connection),
-- except one still paying a queued or leased job (the jobs its status trigger would end).
create or replace function public.qorpera_revoke_company_chatgpt_plan_logins(p_profile_id uuid)
returns void language sql security definer set search_path = '' as $$
	update public.qorpera_provider_connections as connection set status = 'revoked'
	where connection.profile_id = p_profile_id and connection.status <> 'revoked'
		and exists (select 1 from public.qorpera_provider_connection_versions as version
			join public.qorpera_model_logins as login on login.credential_capsule_id = version.credential_capsule_id
			where version.connection_id = connection.id and login.login_kind = 'chatgpt_plan')
		and not exists (select 1 from public.qorpera_runner_jobs as job
			join public.qorpera_execution_runs as run on job.id = run.job_id
			join public.qorpera_execution_sponsor_versions as sponsor
				on sponsor.binding_id = run.sponsor_binding_id and sponsor.version = run.sponsor_version
			where job.status in ('queued', 'leased') and sponsor.provider_connection_id = connection.id)
$$;

-- How many of a deleting company's ChatGPT plan logins the vault has still to end, within 6 hours of the
-- deletion request.
create or replace function public.qorpera_company_chatgpt_plan_logins_open(p_profile_id uuid)
returns bigint language sql security definer set search_path = '' as $$
	select count(*)
	from public.qorpera_model_logins as login
	join public.qorpera_company_deletions as deletion on deletion.profile_id = login.profile_id
	where login.profile_id = p_profile_id and login.login_kind = 'chatgpt_plan'
		and login.status in ('active', 'needs_sign_in')
		and deletion.requested_at > clock_timestamp() - interval '6 hours'
$$;

-- Before the purge: the company's plan logins the vault did not end (the 6 hours ran out), counted in the
-- server log. Their rows go with the company; each refresh token lapses at OpenAI.
create or replace function public.qorpera_abandon_company_chatgpt_plan_logins(p_profile_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
	select count(*) into v_count from public.qorpera_model_logins as login
	where login.profile_id = p_profile_id and login.login_kind = 'chatgpt_plan'
		and login.status in ('active', 'needs_sign_in');
	if v_count > 0 then
		raise log 'qorpera company deletion %: % ChatGPT plan login(s) not ended at OpenAI before the purge',
			p_profile_id, v_count;
	end if;
	return v_count;
end
$$;

revoke all on function public.qorpera_revoke_company_chatgpt_plan_logins(uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_company_chatgpt_plan_logins_open(uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_abandon_company_chatgpt_plan_logins(uuid) from public, anon, authenticated, service_role;

do $patch$
declare
	v_definition text := pg_get_functiondef('public.qorpera_finish_company_deletion(uuid)'::regprocedure);
	v_pairs text[] := array[
		$a0$			perform public.qorpera_revoke_company_connector_secrets(p_profile_id);
			v_holdings := v_holdings || jsonb_build_object('connector_tokens',
				public.qorpera_company_token_revocations_open(p_profile_id));
$a0$,
		$r0$			perform public.qorpera_revoke_company_connector_secrets(p_profile_id);
			v_holdings := v_holdings || jsonb_build_object('connector_tokens',
				public.qorpera_company_token_revocations_open(p_profile_id));
			-- Members' ChatGPT plan logins end at OpenAI before the purge (Sign in with ChatGPT, 20260929960000): their
			-- connections are revoked, and the vault's upkeep ends each login, as for a member who left.
			perform public.qorpera_revoke_company_chatgpt_plan_logins(p_profile_id);
			v_holdings := v_holdings || jsonb_build_object('chatgpt_plan_logins',
				public.qorpera_company_chatgpt_plan_logins_open(p_profile_id));
$r0$,
		$a1$			or (v_holdings ->> 'connector_tokens')::bigint > 0) then
$a1$,
		$r1$			or (v_holdings ->> 'connector_tokens')::bigint > 0
			or (v_holdings ->> 'chatgpt_plan_logins')::bigint > 0) then
$r1$,
		$a2$				perform public.qorpera_abandon_company_token_revocations(p_profile_id);
$a2$,
		$r2$				perform public.qorpera_abandon_company_token_revocations(p_profile_id);
				perform public.qorpera_abandon_company_chatgpt_plan_logins(p_profile_id);
$r2$];
	v_count integer;
begin
	if position('20260929960000' in v_definition) > 0 then return; end if;
	for v_index in 1 .. array_length(v_pairs, 1) / 2 loop
		v_count := (length(v_definition) - length(replace(v_definition, v_pairs[2 * v_index - 1], '')))
			/ length(v_pairs[2 * v_index - 1]);
		if v_count <> 1 then
			raise exception 'The deletion finisher''s source differs (anchor % matches % times)', v_index, v_count; end if;
		v_definition := replace(v_definition, v_pairs[2 * v_index - 1], v_pairs[2 * v_index]);
	end loop;
	execute v_definition;
end
$patch$;
