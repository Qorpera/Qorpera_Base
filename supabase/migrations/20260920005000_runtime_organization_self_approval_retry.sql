-- Review follow-up to 20260920001000. Approval by policy is followed at once by
-- the apply, but the apply can fail after the approval was recorded (a head
-- conflict that outlasts its retries, a lost connection). The same run retrying
-- the same operation must then be able to finish the job: a policy approval
-- this run made is renewed when it has expired, instead of being refused as
-- expired by the approval lane. Nothing else changes: only a NEW agent or room
-- this run proposed, the same approver rule and the same per-run limits.
create or replace function public.qorpera_self_approve_organization_proposal(p_binding jsonb, p_proposal_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype; v_proposal public.qorpera_company_path_proposals%rowtype;
	v_kind text; v_approver uuid; v_role public.qorpera_profile_role; v_limit integer;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	select * into v_proposal from public.qorpera_company_path_proposals where id = p_proposal_id for update;
	v_kind := public.qorpera_agent_creatable_path_kind(v_proposal.plan ->> 'path');
	if not found or v_proposal.run_id is distinct from v_run.id or v_run.audience_kind <> 'company'
		or v_kind is null or v_kind = 'directory' or v_proposal.plan -> 'expectedVersion' <> 'null'::jsonb
		or v_proposal.plan -> 'entry' = 'null'::jsonb
		or (v_proposal.status <> 'applied' and exists (select 1 from public.qorpera_company_path_entries entry
			where entry.environment_id = v_proposal.environment_id
				and entry.path_key_sha256 = extensions.digest(public.qorpera_company_path_key(v_proposal.plan ->> 'path'),'sha256'))) then
		raise exception 'Only a new agent or room proposed by this run is approved by policy' using errcode = '42501'; end if;
	if v_proposal.status = 'applied' then
		return jsonb_build_object('proposalId', v_proposal.id, 'planSha256', v_proposal.plan_sha256, 'state', 'applied'); end if;
	select member.role into v_role from public.qorpera_profile_members member
	where member.profile_id = v_run.profile_id and member.user_id = v_run.requested_by_user_id;
	v_approver := case when v_role in ('owner','admin') then v_run.requested_by_user_id
		else public.qorpera_company_owner_user_id(v_run.profile_id) end;
	if v_approver is null then
		raise exception 'Organization approval authority is unavailable' using errcode = '42501'; end if;
	if v_proposal.status = 'approved' then
		-- Only an approval this policy made is renewed; a member's own approval is theirs.
		if v_proposal.approved_by_user_id is distinct from v_approver then
			raise exception 'Organization proposal is under member review' using errcode = '55000'; end if;
		update public.qorpera_company_path_proposals set approval_expires_at = clock_timestamp() + interval '10 minutes'
		where id = v_proposal.id and approval_expires_at <= clock_timestamp() + interval '1 minute';
		return jsonb_build_object('proposalId', v_proposal.id, 'planSha256', v_proposal.plan_sha256, 'state', 'approved');
	end if;
	if v_proposal.status <> 'open' then
		raise exception 'Organization proposal is closed' using errcode = '55000'; end if;
	v_limit := case v_kind when 'agent' then 3 else 5 end;
	if (select count(*) from public.qorpera_company_path_proposals other
		where other.run_id = v_run.id and other.id <> v_proposal.id and other.status in ('approved','applied')
			and public.qorpera_agent_creatable_path_kind(other.plan ->> 'path') = v_kind) >= v_limit then
		raise exception 'This run reached its limit for new %s', v_kind || 's' using errcode = '54000'; end if;
	update public.qorpera_company_path_proposals set status = 'approved', approved_by_user_id = v_approver,
		approval_expires_at = clock_timestamp() + interval '10 minutes' where id = v_proposal.id;
	return jsonb_build_object('proposalId', v_proposal.id, 'planSha256', v_proposal.plan_sha256, 'state', 'approved');
end
$$;
revoke all on function public.qorpera_self_approve_organization_proposal(jsonb, uuid) from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_self_approve_organization_proposal(jsonb, uuid) to service_role;
