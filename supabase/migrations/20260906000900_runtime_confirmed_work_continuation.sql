-- Continue confirmed work across a sponsor change, retaining original
-- receipts and attempt provenance. Uncertain effects still require recovery.
create or replace function public.qorpera_company_path_plan_digest(p_actor jsonb,p_plan jsonb)
returns text language sql immutable set search_path = '' as $$
 select encode(extensions.digest(convert_to(jsonb_build_object('schema','qorpera.company-path-operation/v2',
  'actor',p_actor - array['assignmentId','sponsorVersion'],'plan',p_plan)::text,'utf8'),'sha256'),'hex')
$$;

create function public.qorpera_run_continuation(p_run public.qorpera_execution_runs)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_handoff public.qorpera_execution_sponsor_handoffs%rowtype; v_receipts jsonb; v_sends jsonb;
begin
 select * into v_handoff from public.qorpera_execution_sponsor_handoffs
 where run_id = p_run.id and to_version = p_run.sponsor_version;
 if not found then return null; end if;
 select coalesce(jsonb_agg(jsonb_build_object('receiptId',id,'logicalOperationKey',logical_operation_key,
  'assignmentId',assignment_id,'inputSha256',input_sha256,'completedAt',completed_at,
  'result',result,'outputSnapshotId',output_snapshot_id,'proposalId',proposal_id,
  'companyPathProposalId',company_path_proposal_id) order by completed_at,id),'[]') into v_receipts
 from public.qorpera_run_operation_receipts where run_id = p_run.id and status = 'completed'
  and completed_at <= v_handoff.created_at;
 select coalesce(jsonb_agg(jsonb_build_object('eventId',event.event_id,'sequence',event.sequence,
  'body',event.body) order by event.sequence),'[]') into v_sends
 from public.qorpera_agent_sends send join public.qorpera_session_events event on event.event_id = send.event_id
 where send.run_id = p_run.id and send.session_id = p_run.session_id and send.created_at <= v_handoff.created_at;
 return jsonb_build_object('schema','qorpera.run-continuation/v1','runId',p_run.id,
  'handoffId',v_handoff.id,'reason',v_handoff.reason,'receipts',v_receipts,'priorSends',v_sends);
end
$$;
revoke all on function public.qorpera_run_continuation(public.qorpera_execution_runs)
 from public,anon,authenticated,service_role,qorpera_secret_broker;

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_handoff_run_sponsor(uuid,text)'::regprocedure); v_old text; v_new text;
begin
 v_old := $old$	-- Continuation must not duplicate an effect: no governed operation, artifact or output exists for this run.
	if exists (select 1 from public.qorpera_run_operation_receipts where run_id = v_run.id)$old$;
 v_new := $new$	-- Only completed, canonical receipts may cross an attempt boundary.
	-- The old assignment remains on every receipt; no effect is reset.
	if exists (select 1 from public.qorpera_run_operation_receipts receipt where run_id = v_run.id
		and (status <> 'completed' or completed_at is null or jsonb_typeof(result) is distinct from 'object'
			or octet_length(result::text) > 65536
			or (requires_company_revision and output_snapshot_id is null
				and proposal_id is null and company_path_proposal_id is null)))
		or exists (select 1 from public.qorpera_agent_sends where run_id = v_run.id and phase = 'final')$new$;
 if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 then
  raise exception 'Continuation upgrade source differs: qorpera_handoff_run_sponsor(uuid,text)'; end if;
 v_definition := replace(v_definition,v_old,v_new);
 v_old := $old$(v_run.source_kind in ('session_turn','room_delivery') or version.allow_autonomous)$old$;
 v_new := $new$(v_run.source_kind in ('session_turn','room_delivery') or (version.allow_autonomous and public.qorpera_provider_autonomous_authority(connection.id,version.version)))$new$;
 if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 then
  raise exception 'Continuation upgrade source differs: qorpera_handoff_run_sponsor(uuid,text)'; end if;
 v_definition := replace(v_definition,v_old,v_new);
 execute v_definition;
end
$$;

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_company_context_source(public.qorpera_execution_runs,text,uuid)'::regprocedure); v_old text; v_new text;
begin
 v_old := $old$	elsif p_kind = 'job_spec' and p_id = p_run.staff_agent_id then$old$;
 v_new := $new$	elsif p_kind = 'continuation' and p_id = p_run.id then
		v_text := public.qorpera_run_continuation(p_run)::text;
		if v_text is null then raise exception 'Run has no continuation' using errcode = '42501'; end if;
		v_kind := 'completed_work'; v_actor_kind := 'control_plane';
	elsif p_kind = 'job_spec' and p_id = p_run.staff_agent_id then$new$;
 if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 then
  raise exception 'Continuation upgrade source differs: qorpera_company_context_source(public.qorpera_execution_runs,text,uuid)'; end if;
 v_definition := replace(v_definition,v_old,v_new);
 execute v_definition;
end
$$;

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_describe_company_run_context(jsonb)'::regprocedure); v_old text; v_new text;
begin
 v_old := $old$v_coworker_count bigint; v_result jsonb;$old$;
 v_new := $new$v_coworker_count bigint; v_result jsonb; v_continuation jsonb;$new$;
 if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 then
  raise exception 'Continuation upgrade source differs: qorpera_describe_company_run_context(jsonb)'; end if;
 v_definition := replace(v_definition,v_old,v_new);
 v_old := $old$	v_authority := public.qorpera_describe_native_tool_authority(p_binding);$old$;
 v_new := $new$	perform public.qorpera_company_path_assert_context(v_actor);
	v_authority := public.qorpera_describe_native_tool_authority(p_binding);$new$;
 if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 then
  raise exception 'Continuation upgrade source differs: qorpera_describe_company_run_context(jsonb)'; end if;
 v_definition := replace(v_definition,v_old,v_new);
 v_old := $old$	v_result := jsonb_build_object('schema','qorpera.native-company-context/v1'$old$;
 v_new := $new$	if public.qorpera_run_continuation(v_run) is not null then
		v_source := public.qorpera_company_context_source(v_run,'continuation',v_run.id);
		v_continuation := (v_source-'text') || jsonb_build_object('content',
			public.qorpera_company_context_excerpt(v_source ->> 'text',0,4096));
	end if;
	v_result := jsonb_build_object('schema','qorpera.native-company-context/v1'$new$;
 if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 then
  raise exception 'Continuation upgrade source differs: qorpera_describe_company_run_context(jsonb)'; end if;
 v_definition := replace(v_definition,v_old,v_new);
 v_old := $old$'job',v_job,'jobSpecification',v_spec)$old$;
 v_new := $new$'job',v_job,'jobSpecification',v_spec,'continuation',v_continuation)$new$;
 if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 then
  raise exception 'Continuation upgrade source differs: qorpera_describe_company_run_context(jsonb)'; end if;
 v_definition := replace(v_definition,v_old,v_new);
 execute v_definition;
end
$$;

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_read_company_run_context(jsonb,text,uuid,text,integer,integer)'::regprocedure); v_old text; v_new text;
begin
 v_old := $old$	perform public.qorpera_company_path_actor(v_run.environment_id,p_binding);$old$;
 v_new := $new$	perform public.qorpera_company_path_assert_context(public.qorpera_company_path_actor(v_run.environment_id,p_binding));$new$;
 if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 then
  raise exception 'Continuation upgrade source differs: qorpera_read_company_run_context(jsonb,text,uuid,text,integer,integer)'; end if;
 v_definition := replace(v_definition,v_old,v_new);
 execute v_definition;
end
$$;

do $$ declare v_owner name; begin
 for v_owner in select distinct pg_get_userbyid(proowner) from pg_proc where oid = any(array[
  'public.qorpera_handoff_run_sponsor(uuid,text)'::regprocedure,
  'public.qorpera_company_context_source(public.qorpera_execution_runs,text,uuid)'::regprocedure,
  'public.qorpera_describe_company_run_context(jsonb)'::regprocedure
 ]) loop
  if v_owner in ('anon','authenticated','service_role','qorpera_secret_broker') then
   raise exception 'Continuation authority is owned by an API role'; end if;
  execute format('grant execute on function public.qorpera_provider_autonomous_authority(uuid,bigint),public.qorpera_run_continuation(public.qorpera_execution_runs) to %I',v_owner);
 end loop;
end $$;
