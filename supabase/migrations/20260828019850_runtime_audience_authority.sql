-- Forward-only integration correction for the Step 0/2 authority boundary.
-- Keep historical audience identities while revoking live membership. Private
-- conversations may consume authorized shared state; publishing their output
-- to shared state requires an exact, audience-owner-approved proposal.

-- Rename-and-recreate wrappers inherited PUBLIC's default EXECUTE, not their
-- predecessor's closed ACL. Revoke on the actual new OIDs before granting the
-- authenticated member surface. In particular the secret broker is not a user.
revoke all on function public.qorpera_read_session_events(uuid,bigint,integer),
	public.qorpera_list_session_inputs(uuid,bigint,integer),
	public.qorpera_append_account_event(uuid,uuid,text,jsonb,bigint,text,uuid,uuid),
	public.qorpera_create_shared_session(uuid,text,text,uuid),
	public.qorpera_create_shared_session_v2(uuid,uuid,text,text,uuid),
	public.qorpera_create_shared_session_v3(uuid,uuid,text,text,uuid,jsonb),
	public.qorpera_cancel_runner_job(uuid),public.qorpera_cancel_session_run(uuid,uuid)
	from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function public.qorpera_read_session_events(uuid,bigint,integer),
	public.qorpera_list_session_inputs(uuid,bigint,integer),
	public.qorpera_append_account_event(uuid,uuid,text,jsonb,bigint,text,uuid,uuid),
	public.qorpera_create_shared_session(uuid,text,text,uuid),
	public.qorpera_create_shared_session_v2(uuid,uuid,text,text,uuid),
	public.qorpera_create_shared_session_v3(uuid,uuid,text,text,uuid,jsonb),
	public.qorpera_cancel_runner_job(uuid),public.qorpera_cancel_session_run(uuid,uuid) to authenticated;

-- Neither a retained run nor its conversation is a live membership grant.
-- Cascading the conversation would also destroy inputs or hit immutable-run
-- and first-run references, so preserve both historical identities.
alter table public.qorpera_execution_runs
	drop constraint qorpera_execution_runs_profile_id_audience_user_id_fkey,
	add constraint qorpera_execution_runs_audience_identity
		foreign key (audience_user_id) references auth.users(id) on delete restrict;
alter table public.qorpera_shared_sessions
	drop constraint qorpera_shared_sessions_audience_member,
	add constraint qorpera_shared_sessions_audience_identity
		foreign key (audience_user_id) references auth.users(id) on delete restrict;

create function public.qorpera_require_current_private_audience()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if tg_op = 'UPDATE' and (new.profile_id,new.audience_kind,new.audience_user_id)
		is not distinct from (old.profile_id,old.audience_kind,old.audience_user_id) then return new; end if;
	if new.audience_kind = 'member_private' then
		perform 1 from public.qorpera_profile_members member
		where member.profile_id = new.profile_id and member.user_id = new.audience_user_id
			and member.role in ('owner','admin','contributor') for share;
		if not found then raise exception 'private audience membership is unavailable' using errcode = '42501'; end if;
	end if;
	return new;
end
$$;
create trigger qorpera_shared_session_current_private_member
before insert or update of profile_id,audience_kind,audience_user_id on public.qorpera_shared_sessions
for each row execute function public.qorpera_require_current_private_audience();
-- Alphabetical trigger order: the existing *_audience trigger first resolves
-- the closed audience from the canonical session, then this guard validates it.
create trigger qorpera_execution_run_current_private_member
before insert or update of profile_id,audience_kind,audience_user_id on public.qorpera_execution_runs
for each row execute function public.qorpera_require_current_private_audience();

create function public.qorpera_close_removed_member_private_sessions()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	delete from public.qorpera_session_execution_bindings binding
	using public.qorpera_shared_sessions session
	where binding.session_id = session.id and session.profile_id = old.profile_id
		and session.audience_kind = 'member_private' and session.audience_user_id = old.user_id;
	update public.qorpera_shared_sessions set status = 'closed',updated_at = statement_timestamp()
	where profile_id = old.profile_id and audience_kind = 'member_private'
		and audience_user_id = old.user_id and status = 'open';
	return old;
end
$$;
create trigger qorpera_removed_member_private_sessions
after delete on public.qorpera_profile_members
for each row execute function public.qorpera_close_removed_member_private_sessions();

create or replace function public.qorpera_company_path_allowed(p_actor jsonb,p_path text,p_permission text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare v_resource public.qorpera_company_path_resources%rowtype; v_profile uuid := (p_actor ->> 'companyId')::uuid;
begin
	v_resource := public.qorpera_company_path_resource((p_actor ->> 'environmentId')::uuid,p_path);
	if p_permission is null or p_permission not in ('read','write')
		or not public.qorpera_company_path_principal_allowed(v_profile,v_resource,'member',
			(p_actor ->> 'userId')::uuid,p_permission) then return false; end if;
	if p_actor ->> 'audience' = 'company' then
		return v_resource.scope <> 'member_private' and public.qorpera_company_path_principal_allowed(
			v_profile,v_resource,'staff_agent',(p_actor ->> 'staffAgentId')::uuid,p_permission);
	end if;
	if p_actor ->> 'audience' = 'member_private' then
		return coalesce((p_actor ->> 'audienceUserId')::uuid = (p_actor ->> 'userId')::uuid
			and (v_resource.scope <> 'member_private' or v_resource.owner_user_id = (p_actor ->> 'userId')::uuid)
			and public.qorpera_company_path_principal_allowed(v_profile,v_resource,'staff_agent',
				(p_actor ->> 'staffAgentId')::uuid,p_permission),false);
	end if;
	return coalesce(p_actor ->> 'audience' = 'human',false);
end
$$;

create function public.qorpera_company_path_needs_approval(
	p_actor jsonb,p_resource public.qorpera_company_path_resources,p_plan jsonb
)
returns boolean language sql immutable set search_path = '' as $$
	select public.qorpera_company_path_protected(p_resource,p_plan)
		or (p_actor ->> 'audience' = 'member_private' and p_resource.scope <> 'member_private')
$$;

-- A private conversation itself is private context, even when no private file
-- was read. Its draft, metadata and staged bytes are not visible to another
-- founder merely because the proposed destination is company-shared.
create function public.qorpera_company_proposal_audience_allowed(p_run_id uuid,p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_execution_runs run where run.id = p_run_id
		and (run.audience_kind = 'company' or (run.audience_kind = 'member_private'
			and run.audience_user_id = p_user_id and run.requested_by_user_id = p_user_id)))
$$;

create or replace function public.qorpera_check_company_path_mutation(p_environment_id uuid,p_binding jsonb,p_plan jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_resource public.qorpera_company_path_resources%rowtype;
	v_receipt public.qorpera_run_operation_receipts%rowtype;
begin
	if p_binding is null then raise exception 'Native Company File binding is required' using errcode = '42501'; end if;
	v_actor := public.qorpera_company_path_actor(p_environment_id,p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	v_resource := public.qorpera_company_path_plan(v_actor,p_plan,false,false);
	select * into v_receipt from public.qorpera_run_operation_receipts where run_id = (v_actor ->> 'runId')::uuid
		and logical_operation_key = 'company_path:' || (p_plan ->> 'operationKey');
	if found then
		if v_receipt.input_sha256 <> public.qorpera_company_path_plan_digest(v_actor,p_plan) then
			raise exception 'Company File operation key is bound to different work' using errcode = '23505'; end if;
		if v_receipt.status <> 'completed' then
			raise exception 'Company File operation requires recovery' using errcode = '55000'; end if;
		return jsonb_build_object('state','completed','result',v_receipt.result);
	end if;
	perform public.qorpera_company_path_plan(v_actor,p_plan,true,false);
	return jsonb_build_object('state',case when public.qorpera_company_path_needs_approval(v_actor,v_resource,p_plan)
		then 'protected' else 'ready' end);
end
$$;

create or replace function public.qorpera_commit_company_path_mutation(
	p_environment_id uuid,p_binding jsonb,p_plan jsonb,p_expected_head uuid default null,p_tree_sha256 text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_resource public.qorpera_company_path_resources%rowtype; v_prepared jsonb;
	v_receipt_id uuid := extensions.gen_random_uuid(); v_proposal_id uuid; v_digest text; v_begun jsonb; v_result jsonb;
begin
	v_prepared := public.qorpera_prepare_company_path_mutation(p_environment_id,p_binding,p_plan);
	if v_prepared ->> 'state' = 'completed' then return v_prepared -> 'result'; end if;
	v_actor := public.qorpera_company_path_actor(p_environment_id,p_binding);
	v_resource := public.qorpera_company_path_plan(v_actor,p_plan,true);
	v_digest := public.qorpera_company_path_plan_digest(v_actor,p_plan);
	v_begun := public.qorpera_begin_native_tool_operation(p_binding,v_receipt_id,'company_path:' || (p_plan ->> 'operationKey'),
		v_digest,encode(extensions.digest(convert_to((v_actor ->> 'runId') || ':' || (p_plan ->> 'operationKey'),'utf8'),'sha256'),'hex'),true);
	if v_begun ->> 'receipt_id' <> v_receipt_id::text or v_begun ->> 'state' <> 'executing' then
		raise exception 'Company File operation requires recovery' using errcode = '55000'; end if;
	if public.qorpera_company_path_needs_approval(v_actor,v_resource,p_plan) then
		if p_expected_head is not null or p_tree_sha256 is not null then
			raise exception 'Protected Company File mutation requires a proposal' using errcode = '42501'; end if;
		perform public.qorpera_company_path_assert_context(v_actor);
		insert into public.qorpera_company_path_proposals(environment_id,run_id,receipt_id,plan,plan_sha256,resource_id,resource_version)
		values (p_environment_id,(v_actor ->> 'runId')::uuid,v_receipt_id,p_plan,v_digest,v_resource.id,v_resource.version)
		returning id into v_proposal_id;
		v_result := jsonb_build_object('schema','qorpera.company-path-result/v1','state','proposed','receiptId',v_receipt_id,
			'operationKey',p_plan ->> 'operationKey','path',p_plan ->> 'path','version',p_plan -> 'expectedVersion',
			'snapshotId',null,'proposalId',v_proposal_id);
	else
		v_result := public.qorpera_publish_company_path(v_actor,p_binding,p_plan,p_expected_head,p_tree_sha256,v_receipt_id,null);
	end if;
	update public.qorpera_run_operation_receipts set status = 'completed',result = v_result,completed_at = clock_timestamp(),
		output_snapshot_id = (v_result ->> 'snapshotId')::uuid,company_path_proposal_id = v_proposal_id where id = v_receipt_id;
	return v_result;
end
$$;

create or replace function public.qorpera_get_company_path_proposal(p_proposal_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_proposal public.qorpera_company_path_proposals%rowtype;
begin
	select * into v_proposal from public.qorpera_company_path_proposals where id = p_proposal_id;
	if not found or not public.qorpera_company_proposal_audience_allowed(v_proposal.run_id,auth.uid()) then
		raise exception 'Company File proposal is unavailable' using errcode = '42501'; end if;
	v_actor := public.qorpera_company_path_actor(v_proposal.environment_id,null);
	select * into strict v_proposal from public.qorpera_company_path_proposals where id = p_proposal_id;
	perform public.qorpera_company_path_require(v_actor,v_proposal.plan ->> 'path','read');
	perform public.qorpera_company_path_assert_context(v_actor || jsonb_build_object('runId',v_proposal.run_id));
	return jsonb_build_object('proposalId',v_proposal.id,'plan',v_proposal.plan,'planSha256',v_proposal.plan_sha256,
		'state',v_proposal.status,'snapshotId',v_proposal.output_snapshot_id);
end
$$;

create or replace function public.qorpera_list_company_path_proposals(
	p_environment_id uuid,p_after uuid default null,p_limit integer default 50
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_items jsonb;
begin
	v_actor := public.qorpera_company_path_actor(p_environment_id,null);
	if p_limit is null or p_limit not between 1 and 50 then raise exception 'Invalid Company File page' using errcode = '22023'; end if;
	select coalesce(jsonb_agg(item order by id),'[]') into v_items from (
		select p.id,public.qorpera_get_company_path_proposal(p.id) as item from public.qorpera_company_path_proposals p
		where p.environment_id = p_environment_id and p.status in ('open','approved') and (p_after is null or p.id > p_after)
			and public.qorpera_company_proposal_audience_allowed(p.run_id,auth.uid())
			and public.qorpera_company_path_allowed(v_actor,p.plan ->> 'path','read')
			and not exists (select 1 from public.qorpera_company_run_read_paths r where r.run_id = p.run_id
				and not public.qorpera_company_path_allowed(v_actor,r.path,'read'))
		order by p.id limit p_limit
	) page;
	return jsonb_build_object('items',v_items,'nextAfter',case when jsonb_array_length(v_items) = p_limit
		then v_items -> -1 ->> 'proposalId' else null end);
end
$$;

create or replace function public.qorpera_review_company_path_proposal(
	p_proposal_id uuid,p_plan_sha256 text,p_decision text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_proposal public.qorpera_company_path_proposals%rowtype; v_actor jsonb;
	v_resource public.qorpera_company_path_resources%rowtype;
begin
	select * into v_proposal from public.qorpera_company_path_proposals where id = p_proposal_id;
	if not found or not public.qorpera_company_proposal_audience_allowed(v_proposal.run_id,auth.uid()) then
		raise exception 'Company File proposal is unavailable' using errcode = '42501'; end if;
	v_actor := public.qorpera_company_path_actor(v_proposal.environment_id,null);
	select * into strict v_proposal from public.qorpera_company_path_proposals where id = p_proposal_id for update;
	v_resource := public.qorpera_company_path_require(v_actor,v_proposal.plan ->> 'path','read');
	perform public.qorpera_company_path_require(v_actor,v_proposal.plan ->> 'path','write');
	perform public.qorpera_company_path_assert_context(v_actor || jsonb_build_object('runId',v_proposal.run_id));
	if p_decision is null or p_decision not in ('approve','reject','skip')
		or p_plan_sha256 is distinct from v_proposal.plan_sha256 then
		raise exception 'Company File review differs from its proposal' using errcode = '22023'; end if;
	if (v_resource.scope <> 'member_private' and public.qorpera_company_path_protected(v_resource,v_proposal.plan)
		and not public.qorpera_can_authorize_profile((v_actor ->> 'companyId')::uuid))
		or (v_resource.scope = 'member_private' and v_resource.owner_user_id <> auth.uid()) then
		raise exception 'Company File review authority is required' using errcode = '42501'; end if;
	if v_proposal.status in ('applied','rejected') then return jsonb_build_object('state',v_proposal.status); end if;
	if v_resource.id <> v_proposal.resource_id or v_resource.version <> v_proposal.resource_version then
		raise exception 'Company File proposal policy changed' using errcode = '40001'; end if;
	if p_decision = 'approve' then
		perform public.qorpera_company_path_plan(v_actor,v_proposal.plan,true);
		if v_proposal.status = 'approved' then
			if v_proposal.approved_by_user_id <> auth.uid() or v_proposal.approval_expires_at <= clock_timestamp() then
				raise exception 'Company File approval is unavailable' using errcode = '42501'; end if;
		else
			update public.qorpera_company_path_proposals set status = 'approved',approved_by_user_id = auth.uid(),
				approval_expires_at = clock_timestamp() + interval '10 minutes' where id = p_proposal_id;
		end if;
	elsif p_decision = 'reject' then
		update public.qorpera_company_path_proposals set status = 'rejected',resolved_by_user_id = auth.uid(),
			resolved_at = clock_timestamp() where id = p_proposal_id;
	else
		update public.qorpera_company_path_proposals set status = 'open',approved_by_user_id = null,
			approval_expires_at = null where id = p_proposal_id;
	end if;
	return jsonb_build_object('state',case p_decision when 'approve' then 'approved' when 'reject' then 'rejected' else 'skipped' end);
end
$$;

create or replace function public.qorpera_company_path_approved_actor(p_proposal_id uuid,p_plan_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_proposal public.qorpera_company_path_proposals%rowtype; v_file public.qorpera_company_files%rowtype;
	v_resource public.qorpera_company_path_resources%rowtype; v_run public.qorpera_execution_runs%rowtype;
	v_actor jsonb; v_source_actor jsonb; v_role public.qorpera_profile_role; v_bundle public.qorpera_active_runtime_bundle%rowtype;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Company File publisher authority is required' using errcode = '42501'; end if;
	select * into v_proposal from public.qorpera_company_path_proposals where id = p_proposal_id;
	select * into v_file from public.qorpera_company_files where environment_id = v_proposal.environment_id;
	perform public.qorpera_lock_profile_gc_fence(v_file.profile_id);
	select * into strict v_file from public.qorpera_company_files where environment_id = v_proposal.environment_id for update;
	select * into strict v_proposal from public.qorpera_company_path_proposals where id = p_proposal_id for update;
	select role into v_role from public.qorpera_profile_members where profile_id = v_file.profile_id
		and user_id = v_proposal.approved_by_user_id for share;
	if not found or v_proposal.plan_sha256 is distinct from p_plan_sha256
		or v_proposal.status not in ('approved','applied') or v_file.path_gateway_version is distinct from 1
		or v_file.path_index_snapshot_id is distinct from v_file.head_snapshot_id
		or public.qorpera_profile_gc_deletion_active(v_file.profile_id)
		or not public.qorpera_company_proposal_audience_allowed(v_proposal.run_id,v_proposal.approved_by_user_id) then
		raise exception 'Company File approval authority is unavailable' using errcode = '42501'; end if;
	select * into strict v_bundle from public.qorpera_active_runtime_bundle where singleton;
	v_actor := jsonb_build_object('companyId',v_file.profile_id,'environmentId',v_file.environment_id,
		'userId',v_proposal.approved_by_user_id,'staffAgentId',null,'runId',v_proposal.run_id,'audience','human',
		'audienceUserId',v_proposal.approved_by_user_id,'runtimeBundleId',v_bundle.runtime_bundle_id,
		'runtimeBundleSha256',v_bundle.runtime_bundle_sha256);
	v_resource := public.qorpera_company_path_require(v_actor,v_proposal.plan ->> 'path','read');
	perform public.qorpera_company_path_require(v_actor,v_proposal.plan ->> 'path','write');
	if (v_resource.scope <> 'member_private' and public.qorpera_company_path_protected(v_resource,v_proposal.plan)
		and v_role not in ('owner','admin'))
		or (v_resource.scope = 'member_private' and v_resource.owner_user_id <> v_proposal.approved_by_user_id)
		or v_resource.id <> v_proposal.resource_id or v_resource.version <> v_proposal.resource_version then
		raise exception 'Company File approval policy changed' using errcode = '42501'; end if;
	if v_proposal.status = 'applied' then return v_actor; end if;
	if v_proposal.approval_expires_at <= clock_timestamp() then
		raise exception 'Company File approval expired' using errcode = '42501'; end if;
	select * into strict v_run from public.qorpera_execution_runs where id = v_proposal.run_id;
	perform 1 from public.qorpera_profile_members where profile_id = v_file.profile_id
		and user_id = v_run.requested_by_user_id for share;
	perform 1 from public.qorpera_profile_staff where profile_id = v_file.profile_id
		and staff_agent_id = v_run.staff_agent_id for share;
	if not public.qorpera_company_path_principal_allowed(v_file.profile_id,v_resource,'member',v_run.requested_by_user_id,'write')
		or not public.qorpera_company_path_principal_allowed(v_file.profile_id,v_resource,'staff_agent',v_run.staff_agent_id,'write') then
		raise exception 'Company File proposal source authority was revoked' using errcode = '42501'; end if;
	v_source_actor := jsonb_build_object('companyId',v_file.profile_id,'environmentId',v_file.environment_id,
		'runId',v_run.id,'userId',v_run.requested_by_user_id,'staffAgentId',v_run.staff_agent_id,
		'audience',v_run.audience_kind,'audienceUserId',v_run.audience_user_id,
		'runtimeBundleId',v_run.runtime_bundle_id,'runtimeBundleSha256',v_run.runtime_bundle_sha256);
	perform public.qorpera_company_path_assert_context(v_source_actor);
	perform public.qorpera_company_path_assert_context(v_actor);
	perform public.qorpera_company_path_plan(v_actor,v_proposal.plan,true);
	return v_actor;
end
$$;

-- Last SQL publication boundary, independent of the caller's preflight. Run
-- after provenance pinning and label the *published effect* with its target
-- audience; source-private provenance remains attached through run_id.
create function public.qorpera_enforce_private_company_publication()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_proposal public.qorpera_company_path_proposals%rowtype;
	v_resource public.qorpera_company_path_resources%rowtype;
begin
	if new.run_id is null then return new; end if;
	select * into strict v_run from public.qorpera_execution_runs where id = new.run_id;
	if v_run.audience_kind <> 'member_private' then return new; end if;
	v_resource := public.qorpera_company_path_resource(new.environment_id,new.change #>> '{plan,path}');
	if v_resource.id is null then raise exception 'Private publication target is unavailable' using errcode = '42501'; end if;
	if v_resource.scope = 'member_private' then return new; end if;
	select * into v_proposal from public.qorpera_company_path_proposals where id = new.proposal_id;
	if not found or new.actor_staff_id is not null or new.actor_user_id is distinct from v_run.audience_user_id
		or v_proposal.approved_by_user_id is distinct from v_run.audience_user_id
		or v_proposal.status <> 'approved' or v_proposal.approval_expires_at <= clock_timestamp()
		or v_proposal.run_id <> new.run_id or v_proposal.environment_id <> new.environment_id
		or v_proposal.receipt_id is distinct from new.receipt_id or v_proposal.plan is distinct from new.change -> 'plan'
		or v_proposal.resource_id <> v_resource.id or v_proposal.resource_version <> v_resource.version then
		raise exception 'Private-to-shared publication requires its audience owner approval' using errcode = '42501'; end if;
	new.audience_kind := 'company'; new.audience_user_id := null;
	return new;
end
$$;
create trigger qorpera_company_path_z_private_publication
before insert on public.qorpera_company_path_revisions
for each row execute function public.qorpera_enforce_private_company_publication();

revoke all on function public.qorpera_require_current_private_audience(),
	public.qorpera_close_removed_member_private_sessions(),
	public.qorpera_company_path_needs_approval(jsonb,public.qorpera_company_path_resources,jsonb),
	public.qorpera_company_proposal_audience_allowed(uuid,uuid),public.qorpera_enforce_private_company_publication()
	from public,anon,authenticated,service_role,qorpera_secret_broker;

-- CREATE OR REPLACE preserves a deployed SECURITY DEFINER owner's identity.
-- Only those exact trusted callers may execute the new private helpers.
do $$ declare v_owner name; begin
	for v_owner in select distinct pg_get_userbyid(proowner) from pg_proc where oid = any(array[
		'public.qorpera_check_company_path_mutation(uuid,jsonb,jsonb)'::regprocedure,
		'public.qorpera_commit_company_path_mutation(uuid,jsonb,jsonb,uuid,text)'::regprocedure,
		'public.qorpera_get_company_path_proposal(uuid)'::regprocedure,
		'public.qorpera_list_company_path_proposals(uuid,uuid,integer)'::regprocedure,
		'public.qorpera_review_company_path_proposal(uuid,text,text)'::regprocedure,
		'public.qorpera_company_path_approved_actor(uuid,text)'::regprocedure
	]) loop
		if v_owner in ('anon','authenticated','service_role','qorpera_secret_broker') then
			raise exception 'Company File authority is owned by an API role'; end if;
		execute format('grant execute on function public.qorpera_company_path_needs_approval(jsonb,public.qorpera_company_path_resources,jsonb),public.qorpera_company_proposal_audience_allowed(uuid,uuid) to %I',v_owner);
	end loop;
end $$;
