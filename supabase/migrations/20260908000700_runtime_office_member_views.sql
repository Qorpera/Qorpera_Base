-- Shared desktop/web read and exact cancellation APIs. No endpoint, ticket,
-- input, profile, native binding or credentials are included in status.
create function public.qorpera_runtime_office_member_status(p_scope jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_screens jsonb; v_viewers jsonb;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null then
		raise exception 'Office member required' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid for share;
	if not found or p_scope is distinct from public.qorpera_runtime_office_scope(v_office)
		or not exists(select 1 from public.qorpera_profile_members where profile_id=v_office.profile_id and user_id=auth.uid()) then
		raise exception 'Office member unavailable' using errcode='42501'; end if;
	select coalesce(jsonb_agg(jsonb_build_object('binding',p_scope||jsonb_build_object('computerGeneration',v_office.generation,
		'screenId',s.id,'screenOrdinal',s.ordinal,'screenGeneration',s.generation,'staffAgentId',s.staff_agent_id),
		'epoch',s.epoch,'drainPending',s.drain_pending,'takeoverMemberId',s.takeover_user_id,
		'driver',case when s.drain_pending then 'draining' when s.takeover_user_id is not null then 'member'
			when s.lease_id is not null then 'agent' else 'idle' end) order by s.ordinal),'[]'::jsonb)
	into v_screens from public.qorpera_runtime_office_screens s where s.office_id=v_office.id;
	-- Unended controls remain discoverable after expiry or an ambiguous mint.
	-- Ordinary expired watches have no input occupancy and need no reconnect.
	select coalesce(jsonb_agg(jsonb_build_object('viewerSessionId',v.id,'screenId',v.screen_id,'mode',v.mode,'state',v.state)
		order by v.issued_at,v.id),'[]'::jsonb) into v_viewers from public.qorpera_runtime_office_viewers v
		where v.office_id=v_office.id and v.member_id=auth.uid() and v.state<>'ended'
		and (v.mode='control' or v.expires_at>clock_timestamp());
	return jsonb_build_object('scope',p_scope,'computerGeneration',v_office.generation,'state',v_office.state,
		'privacyState',v_office.privacy_state,'privacyVersion',v_office.privacy_version,'screens',v_screens,'viewers',v_viewers);
end
$$;

create function public.qorpera_cancel_runtime_office_viewer(p_scope jsonb,p_viewer_session_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_viewer public.qorpera_runtime_office_viewers%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null then
		raise exception 'Viewer owner required' using errcode='42501'; end if;
	select * into v_viewer from public.qorpera_runtime_office_viewers where id=p_viewer_session_id and member_id=auth.uid();
	if not found or p_scope is distinct from (v_viewer.binding-'computerGeneration'-'screenId'-'screenOrdinal'-'screenGeneration'-'staffAgentId') then
		raise exception 'Viewer cleanup differs' using errcode='42501'; end if;
	-- Exact cleanup survives membership revocation. The shared release function
	-- re-locks office, screen, viewer and preserves every newer drain/driver.
	return public.qorpera_release_runtime_office_viewer(public.qorpera_runtime_office_viewer_grant(v_viewer));
end
$$;
revoke all on function public.qorpera_runtime_office_member_status(jsonb),public.qorpera_cancel_runtime_office_viewer(jsonb,uuid)
	from public,anon,authenticated,service_role;
grant execute on function public.qorpera_runtime_office_member_status(jsonb),public.qorpera_cancel_runtime_office_viewer(jsonb,uuid) to authenticated;
