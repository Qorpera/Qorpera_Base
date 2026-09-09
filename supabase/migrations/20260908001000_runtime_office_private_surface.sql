-- Recovery metadata is not authority to run an idle sign-in browser. This
-- broker-only check covers preparation and continued private-surface lifetime.
-- It never grants member input, native browser consent, or acknowledges drains.
create function public.qorpera_check_runtime_office_private_surface(p_challenge jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype;
	v_profile public.qorpera_runtime_browser_profiles%rowtype;
	v_screen public.qorpera_runtime_office_screens%rowtype; v_drain jsonb;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Privacy supervisor required' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where id=(p_challenge#>>'{scope,companyComputerId}')::uuid for share;
	if not found or v_office.state<>'active' or v_office.privacy_state not in ('entering','private')
		or p_challenge is distinct from v_office.privacy_challenge or p_challenge->>'state' is distinct from 'entering'
		or p_challenge->'scope' is distinct from public.qorpera_runtime_office_scope(v_office)
		or (p_challenge->>'computerGeneration')::bigint is distinct from v_office.generation
		or (p_challenge->>'version')::bigint is distinct from v_office.privacy_version
		or not exists(select 1 from public.qorpera_logical_computers c where c.id=v_office.logical_computer_id
			and c.status='active' and public.qorpera_runtime_office_matches(c)) then
		raise exception 'Private surface unavailable' using errcode='42501'; end if;
	perform 1 from public.qorpera_profile_members where profile_id=v_office.profile_id
		and user_id=(p_challenge->>'memberId')::uuid for share;
	if not found or v_office.privacy_owner_membership_version is distinct from coalesce((select version
		from public.qorpera_runtime_browser_membership_revocations where profile_id=v_office.profile_id
		and user_id=(p_challenge->>'memberId')::uuid),0) then
		raise exception 'Private surface owner changed' using errcode='42501'; end if;
	select * into v_profile from public.qorpera_runtime_browser_profiles where id=(p_challenge->>'profileId')::uuid for share;
	if not found or v_profile.office_id is distinct from v_office.id
		or v_profile.owner_user_id::text is distinct from p_challenge->>'memberId'
		or v_profile.version is distinct from (p_challenge->>'profileVersion')::bigint then
		raise exception 'Private surface profile changed' using errcode='42501'; end if;
	if (select count(*) from public.qorpera_runtime_office_screens where office_id=v_office.id)<>jsonb_array_length(p_challenge->'drains')
		or exists(select 1 from public.qorpera_runtime_office_resources where office_id=v_office.id and state<>'drained') then
		raise exception 'Private surface inventory undrained' using errcode='42501'; end if;
	for v_drain in select value from jsonb_array_elements(p_challenge->'drains') loop
		select * into v_screen from public.qorpera_runtime_office_screens where office_id=v_office.id
			and id=(v_drain#>>'{binding,screenId}')::uuid for share;
		if not found or v_screen.drain_pending or v_screen.drain_acknowledged_at is null
			or v_screen.lease_id is not null or v_screen.native_binding is not null
			or v_drain->'binding' is distinct from public.qorpera_runtime_office_scope(v_office)||jsonb_build_object(
				'computerGeneration',v_office.generation,'screenId',v_screen.id,'screenOrdinal',v_screen.ordinal,
				'screenGeneration',v_screen.generation,'staffAgentId',v_screen.staff_agent_id)
			or v_screen.epoch<(v_drain->>'epoch')::bigint
			or (v_screen.id::text=p_challenge->>'screenId' and v_screen.power<>'open')
			or (v_office.privacy_state='entering' and (v_screen.drain_id::text is distinct from v_drain->>'drainId'
				or v_screen.epoch is distinct from (v_drain->>'epoch')::bigint)) then
			raise exception 'Private surface drain unconfirmed' using errcode='42501'; end if;
	end loop;
	-- Once private, a disconnected viewer may require a newer drain on the same
	-- screen generation. It must finish before this browser may reopen.
	return jsonb_build_object('state','authorized','privacyState',v_office.privacy_state,'version',v_office.privacy_version,'validForMs',5000);
end
$$;
revoke all on function public.qorpera_check_runtime_office_private_surface(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_check_runtime_office_private_surface(jsonb) to service_role;

-- Recheck entry at acknowledgement too: membership removal between physical
-- preparation and SQL acknowledgement must not verify the profile. Exit still
-- works after revocation so the owner can clear secret-bearing resources.
alter function public.qorpera_ack_runtime_office_privacy(jsonb) rename to qorpera_ack_runtime_office_privacy_v1;
revoke all on function public.qorpera_ack_runtime_office_privacy_v1(jsonb) from public,anon,authenticated,service_role;
create function public.qorpera_ack_runtime_office_privacy(p_challenge jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Privacy supervisor required' using errcode='42501'; end if;
	-- Acquire UPDATE first; concurrent entry acknowledgements cannot deadlock
	-- while upgrading the SHARE lock taken by the surface check.
	perform 1 from public.qorpera_runtime_offices where id=(p_challenge#>>'{scope,companyComputerId}')::uuid for update;
	if p_challenge->>'state'='entering' then perform public.qorpera_check_runtime_office_private_surface(p_challenge); end if;
	return public.qorpera_ack_runtime_office_privacy_v1(p_challenge);
end
$$;
revoke all on function public.qorpera_ack_runtime_office_privacy(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_ack_runtime_office_privacy(jsonb) to service_role;
