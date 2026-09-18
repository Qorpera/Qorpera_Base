-- Runtime reconciliation is independent of member clients. An expired viewer
-- loses authority but does not prove that input/processes physically stopped.
create function public.qorpera_runtime_office_supervisor_status(p_scope jsonb,p_computer_generation bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_viewer public.qorpera_runtime_office_viewers%rowtype;
	v_drains jsonb;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Office supervisor required' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid for update;
	if not found or p_scope is distinct from public.qorpera_runtime_office_scope(v_office)
		or v_office.generation is distinct from p_computer_generation then
		raise exception 'Office supervisor binding differs' using errcode='42501'; end if;
	-- Bounded under the same office lock used by viewer admission. Draining
	-- controls are already fenced and remain until an exact physical ack.
	for v_viewer in select * from public.qorpera_runtime_office_viewers where office_id=v_office.id
		and state in ('issued','active') and (expires_at<=clock_timestamp() or absolute_deadline<=clock_timestamp())
		order by (mode='control') desc,issued_at,id limit 64 loop
		perform public.qorpera_release_runtime_office_viewer(public.qorpera_runtime_office_viewer_grant(v_viewer));
	end loop;
	select * into strict v_office from public.qorpera_runtime_offices where id=v_office.id;
	select coalesce(jsonb_agg(jsonb_build_object('state','draining','drainId',s.drain_id,'epoch',s.epoch,
		'binding',p_scope||jsonb_build_object('computerGeneration',v_office.generation,'screenId',s.id,
			'screenOrdinal',s.ordinal,'screenGeneration',s.generation,'staffAgentId',s.staff_agent_id)) order by s.ordinal),'[]'::jsonb)
	into v_drains from public.qorpera_runtime_office_screens s where s.office_id=v_office.id and s.drain_pending;
	return jsonb_build_object('scope',p_scope,'computerGeneration',v_office.generation,'revision',v_office.revision,'state',v_office.state,
		'privacyState',v_office.privacy_state,'privacyVersion',v_office.privacy_version,'privacyChallenge',v_office.privacy_challenge,'drains',v_drains);
end
$$;
revoke all on function public.qorpera_runtime_office_supervisor_status(jsonb,bigint) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_runtime_office_supervisor_status(jsonb,bigint) to service_role;
