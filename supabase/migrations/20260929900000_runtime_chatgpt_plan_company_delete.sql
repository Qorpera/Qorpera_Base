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
-- OpenAI. Codex logins are unchanged.
--
-- Locks: none added. The revocation updates only the company's plan-login connections, in the finisher's
-- existing transaction after its fence and stop; the count reads the company's logins by profile.

set local lock_timeout = '3s';

-- Revokes the connections of a company's ChatGPT plan logins (each login's capsule names its connection).
create or replace function public.qorpera_revoke_company_chatgpt_plan_logins(p_profile_id uuid)
returns void language sql security definer set search_path = '' as $$
	update public.qorpera_provider_connections as connection set status = 'revoked'
	where connection.profile_id = p_profile_id and connection.status <> 'revoked'
		and exists (select 1 from public.qorpera_provider_connection_versions as version
			join public.qorpera_model_logins as login on login.credential_capsule_id = version.credential_capsule_id
			where version.connection_id = connection.id and login.login_kind = 'chatgpt_plan')
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

revoke all on function public.qorpera_revoke_company_chatgpt_plan_logins(uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_company_chatgpt_plan_logins_open(uuid) from public, anon, authenticated, service_role;

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
			-- Members' ChatGPT plan logins end at OpenAI before the purge (Sign in with ChatGPT, 20260929900000): their
			-- connections are revoked, and the vault's upkeep ends each login, as for a member who left.
			perform public.qorpera_revoke_company_chatgpt_plan_logins(p_profile_id);
			v_holdings := v_holdings || jsonb_build_object('chatgpt_plan_logins',
				public.qorpera_company_chatgpt_plan_logins_open(p_profile_id));
$r0$,
		$a1$			or (v_holdings ->> 'connector_tokens')::bigint > 0) then
$a1$,
		$r1$			or (v_holdings ->> 'connector_tokens')::bigint > 0
			or (v_holdings ->> 'chatgpt_plan_logins')::bigint > 0) then
$r1$];
	v_count integer;
begin
	if position('20260929900000' in v_definition) > 0 then return; end if;
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
