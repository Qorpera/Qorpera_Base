-- Order 3: addressed responsibility signals use the existing agent wake and
-- operation ledger. These are routing records; the responsibility definition
-- and its authority remain in the versioned Company File projection.
-- Responsibility/project scopes use the same current principal checks as
-- ordinary path tools. The earlier wake helper only admitted company_shared.
create or replace function public.qorpera_wake_path_authorized(
	p_environment uuid,p_requester uuid,p_staff uuid,p_path text)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_file public.qorpera_company_files%rowtype; v_resource public.qorpera_company_path_resources%rowtype;
begin
	select * into v_file from public.qorpera_company_files where environment_id=p_environment;
	if not found then return false; end if;
	perform public.qorpera_lock_profile_gc_fence(v_file.profile_id);
	select * into v_file from public.qorpera_company_files where environment_id=p_environment for update;
	if v_file.path_gateway_version is distinct from 1 or v_file.path_index_snapshot_id is distinct from v_file.head_snapshot_id then return false; end if;
	perform 1 from public.qorpera_profile_members where profile_id=v_file.profile_id and user_id=p_requester for share;
	perform 1 from public.qorpera_profile_staff where profile_id=v_file.profile_id and staff_agent_id=p_staff for share;
	v_resource:=public.qorpera_company_path_resource(p_environment,p_path);
	return v_resource.scope <> 'member_private'
		and public.qorpera_company_path_principal_allowed(v_file.profile_id,v_resource,'member',p_requester,'read')
		and public.qorpera_company_path_principal_allowed(v_file.profile_id,v_resource,'staff_agent',p_staff,'read');
end $$;

create table public.qorpera_responsibility_escalations (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete restrict,
	environment_id uuid not null references public.qorpera_company_files(environment_id) on delete restrict,
	responsibility_id uuid not null references public.qorpera_company_responsibilities(id) on delete restrict,
	responsibility_version bigint not null check (responsibility_version > 0),
	source_path text not null,
	source_path_version uuid not null,
	source_file_sha256 text not null check (source_file_sha256 ~ '^[a-f0-9]{64}$'),
	source_snapshot_id uuid not null references public.qorpera_company_snapshots(id) on delete restrict,
	source_manifest_sha256 text not null check (source_manifest_sha256 ~ '^[a-f0-9]{64}$'),
	target_staff_id uuid,
	target_user_id uuid references auth.users(id) on delete restrict,
	signal_kind text not null check (signal_kind in ('decision','blocker','risk','exception','outcome','resource_proposal')),
	status text not null check (status in ('open','resolved','causal_fence')),
	occurrence_id uuid references public.qorpera_wake_occurrences(id) on delete restrict,
	created_at timestamptz not null default clock_timestamp(),
	resolved_at timestamptz,
	resolved_by_user_id uuid references auth.users(id) on delete restrict,
	resolved_by_staff_id uuid,
	resolution text check (octet_length(resolution) between 1 and 2048),
	check ((target_staff_id is null) <> (target_user_id is null)),
	foreign key (profile_id,target_staff_id) references public.qorpera_profile_staff(profile_id,staff_agent_id) on delete restrict
);
-- One open signal lane per definition version and category. Updates to the
-- definition do not silently retarget old decisions or revive old authority.
create unique index qorpera_responsibility_escalations_open
	on public.qorpera_responsibility_escalations(responsibility_id,responsibility_version,signal_kind) where status='open';
create table public.qorpera_responsibility_escalation_signals (
	id uuid primary key default extensions.gen_random_uuid(),
	escalation_id uuid not null references public.qorpera_responsibility_escalations(id) on delete restrict,
	run_id uuid not null references public.qorpera_execution_runs(id) on delete restrict,
	receipt_id uuid not null unique references public.qorpera_run_operation_receipts(id) on delete restrict,
	summary text not null check (summary ~ '[^[:space:]]' and octet_length(summary) <= 2048),
	recommendation text not null check (recommendation ~ '[^[:space:]]' and octet_length(recommendation) <= 2048),
	evidence_read_ids uuid[] not null check (cardinality(evidence_read_ids) between 1 and 16),
	-- Retain the complete data-flow set of each contributing run, including
	-- inherited coworker context, so later reads cannot bypass a revocation.
	read_paths text[] not null check (cardinality(read_paths) between 1 and 129),
	created_at timestamptz not null default clock_timestamp()
);
create index qorpera_responsibility_escalation_signals_queue on public.qorpera_responsibility_escalation_signals(escalation_id,id);
alter table public.qorpera_responsibility_escalations enable row level security;
alter table public.qorpera_responsibility_escalation_signals enable row level security;
revoke all on public.qorpera_responsibility_escalations,public.qorpera_responsibility_escalation_signals
	from public,anon,authenticated,service_role,qorpera_secret_broker;
create trigger qorpera_responsibility_escalation_signals_immutable
	before update or delete on public.qorpera_responsibility_escalation_signals
	for each row execute function public.qorpera_reject_runtime_bundle_mutation();

create function public.qorpera_current_escalation_responsibility(p_actor jsonb,p_id uuid,p_version bigint)
returns public.qorpera_company_responsibilities language plpgsql security definer set search_path='' as $$
declare v_responsibility public.qorpera_company_responsibilities%rowtype;
begin
	select * into v_responsibility from public.qorpera_company_responsibilities
	where id=p_id and profile_id=(p_actor->>'companyId')::uuid
		and environment_id=(p_actor->>'environmentId')::uuid for share;
	if not found or v_responsibility.version is distinct from p_version
		or v_responsibility.status not in ('active','degraded')
		or v_responsibility.source_path_version is null or v_responsibility.source_file_sha256 is null
		or not exists(select 1 from public.qorpera_company_path_entries e
			where e.environment_id=v_responsibility.environment_id and e.path=v_responsibility.source_path
				and e.version=v_responsibility.source_path_version and e.entry->>'kind'='file'
				and e.entry#>>'{file,fileSha256}'=v_responsibility.source_file_sha256) then
		raise exception 'Responsibility version is unavailable' using errcode='42501'; end if;
	perform public.qorpera_company_path_require(p_actor,v_responsibility.source_path,'read');
	return v_responsibility;
end $$;

create function public.qorpera_escalate_responsibility(p_binding jsonb,p_signal jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_actor jsonb; v_recipient jsonb;
	v_r public.qorpera_company_responsibilities%rowtype; v_queue public.qorpera_responsibility_escalations%rowtype;
	v_authority public.qorpera_staff_execution_authorities%rowtype; v_ancestry jsonb; v_occurrence uuid;
	v_staff uuid; v_user uuid; v_path text; v_evidence uuid[]; v_paths text[]; v_digest text;
	v_receipt uuid:=extensions.gen_random_uuid(); v_begun jsonb; v_result jsonb;
	v_new boolean:=false; v_signal_id uuid;
begin
	v_run:=public.qorpera_native_tool_locked_run(p_binding);
	v_actor:=public.qorpera_company_path_actor(v_run.environment_id,p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	if v_run.audience_kind <> 'company' then
		raise exception 'Private context requires its publication authority' using errcode='42501'; end if;
	if jsonb_typeof(p_signal) is distinct from 'object'
		or not (p_signal ?& array['operationKey','responsibilityId','responsibilityVersion','kind','summary','recommendation','evidenceReadIds'])
		or p_signal-array['operationKey','responsibilityId','responsibilityVersion','kind','summary','recommendation','evidenceReadIds'] <> '{}'::jsonb
		or coalesce(p_signal->>'operationKey','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$'
		or jsonb_typeof(p_signal->'responsibilityVersion') is distinct from 'number'
		or coalesce(p_signal->>'responsibilityVersion','') !~ '^[1-9][0-9]{0,14}$'
		or coalesce(p_signal->>'kind','') not in ('decision','blocker','risk','exception','outcome','resource_proposal')
		or jsonb_typeof(p_signal->'summary') is distinct from 'string'
		or coalesce(p_signal->>'summary','') !~ '[^[:space:]]' or octet_length(p_signal->>'summary') > 2048
		or jsonb_typeof(p_signal->'recommendation') is distinct from 'string'
		or coalesce(p_signal->>'recommendation','') !~ '[^[:space:]]' or octet_length(p_signal->>'recommendation') > 2048
		or jsonb_typeof(p_signal->'evidenceReadIds') is distinct from 'array' then
		raise exception 'Responsibility signal is invalid' using errcode='22023'; end if;
	if jsonb_array_length(p_signal->'evidenceReadIds') not between 1 and 16
		or exists(select 1 from jsonb_array_elements(p_signal->'evidenceReadIds') id where jsonb_typeof(id) <> 'string') then
		raise exception 'Responsibility evidence is invalid' using errcode='22023'; end if;
	select array_agg(id::uuid order by id::uuid) into v_evidence from jsonb_array_elements_text(p_signal->'evidenceReadIds') id;
	if cardinality(v_evidence) <> (select count(distinct id) from unnest(v_evidence) id) then
		raise exception 'Responsibility evidence repeats' using errcode='22023'; end if;
	v_r:=public.qorpera_current_escalation_responsibility(v_actor,(p_signal->>'responsibilityId')::uuid,(p_signal->>'responsibilityVersion')::bigint);
	if v_r.accountable_staff_agent_id <> v_run.staff_agent_id then
		raise exception 'Only the accountable agent may escalate this responsibility' using errcode='42501'; end if;
	-- Evidence is a confirmed read of this run, with the exact version still
	-- current. A UUID, path, model assertion or another run's receipt is no grant.
	if exists(select 1 from unnest(v_evidence) wanted(id)
		left join public.qorpera_company_read_observations o on o.id=wanted.id and o.run_id=v_run.id and o.kind='file'
		left join public.qorpera_company_read_confirmations c on c.read_id=o.id
		left join public.qorpera_company_path_entries e on e.environment_id=o.environment_id and e.path=o.path
		where o.id is null or c.read_id is null or c.included_bytes=0 or e.version is distinct from o.version
			or e.entry is distinct from o.source->'entry') then
		raise exception 'Responsibility evidence is unavailable' using errcode='42501'; end if;
	case v_r.escalation_target->>'kind'
		when 'cofounder' then select staff_agent_id into v_staff from public.qorpera_company_cofounders where profile_id=v_run.profile_id for share;
		when 'staff_agent' then v_staff:=(v_r.escalation_target->>'id')::uuid;
		when 'member' then v_user:=(v_r.escalation_target->>'id')::uuid;
		when 'accountable_member' then v_user:=v_r.accountable_user_id;
		else raise exception 'Responsibility target is unavailable' using errcode='42501';
	end case;
	if (v_staff is null) = (v_user is null) then
		raise exception 'Responsibility target is unavailable' using errcode='42501'; end if;
	if v_staff is not null then
		perform 1 from public.qorpera_profile_staff where profile_id=v_run.profile_id and staff_agent_id=v_staff
			and employment_status='active' and deleted_at is null for share;
		if not found then raise exception 'Responsibility staff target is unavailable' using errcode='42501'; end if;
		select * into v_authority from public.qorpera_staff_execution_authorities
		where profile_id=v_run.profile_id and staff_agent_id=v_staff for share;
		if not found or not exists(select 1 from public.qorpera_execution_sponsor_versions s
			join public.qorpera_execution_sponsor_bindings b on b.id=s.binding_id
			where s.binding_id=v_authority.sponsor_binding_id and s.version=v_authority.sponsor_version
				and b.profile_id=v_run.profile_id and b.status='active' and s.allow_autonomous) then
			raise exception 'Responsibility execution authority is unavailable' using errcode='42501'; end if;
	end if;
	if v_user is not null then
		perform 1 from public.qorpera_profile_members where profile_id=v_run.profile_id and user_id=v_user
			and role in ('owner','admin','contributor') for share;
		if not found then raise exception 'Responsibility member is unavailable' using errcode='42501'; end if;
		v_recipient:=v_actor || jsonb_build_object('audience','human','userId',v_user,'audienceUserId',v_user,'staffAgentId',null);
	end if;
	select array_agg(path order by path collate "C") into v_paths from (
		select path from public.qorpera_company_run_read_paths where run_id=v_run.id union select v_r.source_path) paths;
	foreach v_path in array v_paths loop
		if (v_staff is not null and not coalesce(public.qorpera_wake_path_authorized(v_run.environment_id,v_run.requested_by_user_id,v_staff,v_path),false))
			or (v_user is not null and not public.qorpera_company_path_allowed(v_recipient,v_path,'read')) then
			raise exception 'Responsibility target cannot receive this context' using errcode='42501'; end if;
	end loop;
	v_digest:=encode(extensions.digest(convert_to(p_signal::text,'utf8'),'sha256'),'hex');
	v_begun:=public.qorpera_begin_native_tool_operation(p_binding,v_receipt,'responsibility:'||(p_signal->>'operationKey'),
		v_digest,encode(extensions.digest(convert_to(v_run.id::text||':responsibility:'||(p_signal->>'operationKey'),'utf8'),'sha256'),'hex'),false);
	if v_begun->>'state'='completed' then return v_begun->'result'; end if;
	if v_begun->>'state' is distinct from 'executing' or v_begun->>'receipt_id' is distinct from v_receipt::text then
		raise exception 'Responsibility signal requires reconciliation' using errcode='55000'; end if;
	if (select count(*) from public.qorpera_responsibility_escalation_signals where run_id=v_run.id) >= 32 then
		raise exception 'Responsibility signal budget exceeded' using errcode='54000'; end if;
	-- The company-file actor holds the environment lock. The unique index is
	-- also a final concurrent-delivery fence; one lane can cause only one wake.
	select * into v_queue from public.qorpera_responsibility_escalations
	where responsibility_id=v_r.id and responsibility_version=v_r.version and signal_kind=p_signal->>'kind' and status='open' for update;
	if not found then
		v_new:=true;
		insert into public.qorpera_responsibility_escalations(profile_id,environment_id,responsibility_id,responsibility_version,
			source_path,source_path_version,source_file_sha256,source_snapshot_id,source_manifest_sha256,target_staff_id,target_user_id,signal_kind,status)
		values(v_run.profile_id,v_run.environment_id,v_r.id,v_r.version,v_r.source_path,v_r.source_path_version,v_r.source_file_sha256,
			v_r.source_snapshot_id,(select entry#>>'{file,manifestSha256}' from public.qorpera_company_path_entries
				where environment_id=v_r.environment_id and path=v_r.source_path),
			v_staff,v_user,p_signal->>'kind','open') returning * into v_queue;
		if v_staff is not null then
			v_occurrence:=extensions.gen_random_uuid();
			v_ancestry:=public.qorpera_wake_ancestry(v_run.id,v_run.staff_agent_id,v_staff,v_occurrence);
			if v_ancestry is not null then
				-- The signal owns the one operation receipt. Enqueue the normal
				-- coworker occurrence atomically, without nesting a second effect.
				insert into public.qorpera_wake_occurrences(id,profile_id,environment_id,wake_kind,source_kind,staff_agent_id,
					parent_run_id,sponsor_binding_id,sponsor_version,trigger_id,occurrence_key,scheduled_for,not_before,payload)
				values(v_occurrence,v_run.profile_id,v_run.environment_id,'agent','coworker',v_staff,v_run.id,
					v_authority.sponsor_binding_id,v_authority.sponsor_version,'coworker','escalation:'||v_queue.id::text,
					clock_timestamp(),clock_timestamp(),jsonb_build_object('senderStaffId',v_run.staff_agent_id,'receiptId',v_receipt,
						'text',jsonb_build_object('schema','qorpera.responsibility-escalation-wake/v1','escalationId',v_queue.id,
							'responsibilityId',v_r.id,'responsibilityVersion',v_r.version,'kind',v_queue.signal_kind)::text));
			else v_occurrence:=null; end if;
			update public.qorpera_responsibility_escalations set occurrence_id=v_occurrence,
				status=case when v_occurrence is null then 'causal_fence' else 'open' end
			where id=v_queue.id returning * into v_queue;
		end if;
	elsif (v_queue.target_staff_id,v_queue.target_user_id,v_queue.source_path_version,v_queue.source_file_sha256)
		is distinct from (v_staff,v_user,v_r.source_path_version,v_r.source_file_sha256) then
		raise exception 'Responsibility route changed without a new version' using errcode='40001';
	end if;
	insert into public.qorpera_responsibility_escalation_signals(escalation_id,run_id,receipt_id,summary,recommendation,evidence_read_ids,read_paths)
	values(v_queue.id,v_run.id,v_receipt,p_signal->>'summary',p_signal->>'recommendation',v_evidence,v_paths) returning id into v_signal_id;
	v_result:=jsonb_build_object('schema','qorpera.responsibility-escalation-receipt/v1','runId',v_run.id,'receiptId',v_receipt,
		'escalationId',v_queue.id,'signalId',v_signal_id,'status',case when v_queue.status='causal_fence' then 'causal-fence'
			when not v_new then 'coalesced' when v_staff is null then 'member-queued' else 'agent-queued' end);
	perform public.qorpera_complete_native_tool_operation(p_binding,v_receipt,v_digest,v_result);
	return v_result;
end $$;

-- A recipient reads only its addressed lanes, under current Company File
-- authority over every contributing context path. Member routing is an
-- addressed decision queue, not an automatically sent public message.
create function public.qorpera_escalation_recipient_allowed(p_actor jsonb,p_queue public.qorpera_responsibility_escalations)
returns boolean language plpgsql security definer set search_path='' as $$
begin
	if p_queue.profile_id is distinct from (p_actor->>'companyId')::uuid
		or p_queue.environment_id is distinct from (p_actor->>'environmentId')::uuid
		or not coalesce((p_actor->>'audience'='human' and p_queue.target_user_id=(p_actor->>'userId')::uuid)
			or (p_actor->>'audience'='company' and p_queue.target_staff_id=(p_actor->>'staffAgentId')::uuid),false) then return false; end if;
	if not public.qorpera_company_path_allowed(p_actor,p_queue.source_path,'read') then return false; end if;
	return not exists(select 1 from public.qorpera_responsibility_escalation_signals s,
		unnest(s.read_paths) path where s.escalation_id=p_queue.id and not public.qorpera_company_path_allowed(p_actor,path,'read'));
end $$;

create function public.qorpera_list_responsibility_escalations(
	p_environment_id uuid,p_binding jsonb default null,p_escalation_id uuid default null,p_after uuid default null,p_limit integer default 20,
	p_expected_signal_count bigint default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor jsonb; v_items jsonb; v_queue public.qorpera_responsibility_escalations%rowtype; v_path text; v_signal_count bigint;
begin
	v_actor:=public.qorpera_company_path_actor(p_environment_id,p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	if p_limit is null or p_limit not between 1 and 20 then raise exception 'Escalation page is invalid' using errcode='22023'; end if;
	if p_escalation_id is null then
		if p_expected_signal_count is not null then raise exception 'Queue listing has no contribution version' using errcode='22023'; end if;
		select coalesce(jsonb_agg(item order by id),'[]'::jsonb) into v_items from (
			select q.id,jsonb_build_object('id',q.id,'responsibilityId',q.responsibility_id,'responsibilityVersion',q.responsibility_version,
				'kind',q.signal_kind,'createdAt',q.created_at,'signalCount',(select count(*) from public.qorpera_responsibility_escalation_signals s where s.escalation_id=q.id)) item
			from public.qorpera_responsibility_escalations q where q.environment_id=p_environment_id and q.status='open'
				and (p_after is null or q.id>p_after) and public.qorpera_escalation_recipient_allowed(v_actor,q) order by q.id limit p_limit) page;
		if p_binding is not null then
			for v_path in select distinct path from public.qorpera_responsibility_escalation_signals s,unnest(s.read_paths) path
				where s.escalation_id in (select (item->>'id')::uuid from jsonb_array_elements(v_items) item) loop
				perform public.qorpera_assert_company_path_reads(p_environment_id,p_binding,array[v_path]);
			end loop;
		end if;
	else
		select * into v_queue from public.qorpera_responsibility_escalations where id=p_escalation_id for share;
		if not found or not public.qorpera_escalation_recipient_allowed(v_actor,v_queue) then
			raise exception 'Responsibility escalation is unavailable' using errcode='42501'; end if;
		select count(*) into v_signal_count from public.qorpera_responsibility_escalation_signals where escalation_id=p_escalation_id;
		if (p_after is not null and p_expected_signal_count is null)
			or (p_expected_signal_count is not null and p_expected_signal_count is distinct from v_signal_count) then
			raise exception 'Escalation contributions changed; reread from the beginning' using errcode='40001'; end if;
		select coalesce(jsonb_agg(item order by id),'[]'::jsonb) into v_items from (
			select s.id,jsonb_build_object('id',s.id,'escalationId',s.escalation_id,'sourceRunId',s.run_id,'receiptId',s.receipt_id,
				'summary',s.summary,'recommendation',s.recommendation,'evidenceReadIds',to_jsonb(s.evidence_read_ids),'createdAt',s.created_at) item
			from public.qorpera_responsibility_escalation_signals s where s.escalation_id=p_escalation_id
				and (p_after is null or s.id>p_after) order by s.id limit p_limit) page;
		-- Reads join the current run's durable data-flow guard before releasing
		-- text. A later tool/model turn cannot forget an inherited revocation.
		if p_binding is not null then
			for v_path in select distinct path from public.qorpera_responsibility_escalation_signals s,unnest(s.read_paths) path
				where s.escalation_id=p_escalation_id loop
				perform public.qorpera_assert_company_path_reads(p_environment_id,p_binding,array[v_path]);
			end loop;
		end if;
	end if;
	return jsonb_build_object('schema','qorpera.responsibility-escalation-page/v1','items',v_items,'signalCount',v_signal_count,
		'nextAfter',case when jsonb_array_length(v_items)=p_limit then v_items->-1->>'id' else null end);
end $$;

create function public.qorpera_resolve_responsibility_escalation(
	p_environment_id uuid,p_binding jsonb,p_escalation_id uuid,p_resolution text,p_expected_signal_count bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor jsonb; v_queue public.qorpera_responsibility_escalations%rowtype; v_digest text;
	v_receipt uuid; v_begun jsonb; v_result jsonb;
begin
	v_actor:=public.qorpera_company_path_actor(p_environment_id,p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	if p_binding is not null then perform public.qorpera_assert_wake_work_allowed((v_actor->>'runId')::uuid); end if;
	if p_binding is null and not public.qorpera_can_write_profile((v_actor->>'companyId')::uuid) then
		raise exception 'Escalation resolution requires current member write authority' using errcode='42501'; end if;
	if p_resolution is null or p_resolution !~ '[^[:space:]]' or octet_length(p_resolution)>2048 then
		raise exception 'Escalation resolution is invalid' using errcode='22023'; end if;
	select * into v_queue from public.qorpera_responsibility_escalations where id=p_escalation_id for update;
	if not found or not public.qorpera_escalation_recipient_allowed(v_actor,v_queue) then
		raise exception 'Responsibility escalation is unavailable' using errcode='42501'; end if;
	if p_expected_signal_count is null or p_expected_signal_count < 1
		or p_expected_signal_count is distinct from (select count(*) from public.qorpera_responsibility_escalation_signals where escalation_id=v_queue.id) then
		raise exception 'Escalation contributions changed before resolution' using errcode='40001'; end if;
	if p_binding is not null then
		v_receipt:=extensions.gen_random_uuid();
		v_digest:=encode(extensions.digest(convert_to(jsonb_build_object('escalationId',p_escalation_id,
			'expectedSignalCount',p_expected_signal_count,'resolution',p_resolution)::text,'utf8'),'sha256'),'hex');
		v_begun:=public.qorpera_begin_native_tool_operation(p_binding,v_receipt,'responsibility-resolution:'||p_escalation_id::text,v_digest,
			encode(extensions.digest(convert_to((v_actor->>'runId')||':responsibility-resolution:'||p_escalation_id::text,'utf8'),'sha256'),'hex'),false);
		if v_begun->>'state'='completed' then return v_begun->'result'; end if;
		if v_begun->>'state' is distinct from 'executing' or v_begun->>'receipt_id' is distinct from v_receipt::text then
			raise exception 'Escalation resolution requires reconciliation' using errcode='55000'; end if;
	end if;
	if v_queue.status='resolved' then
		if v_queue.resolution is distinct from p_resolution then raise exception 'Escalation resolution differs' using errcode='23505'; end if;
	elsif v_queue.status='open' then
		update public.qorpera_responsibility_escalations set status='resolved',resolved_at=clock_timestamp(),resolution=p_resolution,
			resolved_by_user_id=(v_actor->>'userId')::uuid,resolved_by_staff_id=(v_actor->>'staffAgentId')::uuid where id=v_queue.id;
	else raise exception 'Causal-fenced escalation cannot be resolved as delivered' using errcode='55000'; end if;
	v_result:=jsonb_build_object('schema','qorpera.responsibility-escalation-resolution/v1','escalationId',v_queue.id,
		'runId',v_actor->>'runId','receiptId',v_receipt,'status','resolved');
	if p_binding is not null then perform public.qorpera_complete_native_tool_operation(p_binding,v_receipt,v_digest,v_result); end if;
	return v_result;
end $$;

revoke all on function public.qorpera_current_escalation_responsibility(jsonb,uuid,bigint),
	public.qorpera_escalation_recipient_allowed(jsonb,public.qorpera_responsibility_escalations),
	public.qorpera_escalate_responsibility(jsonb,jsonb),
	public.qorpera_list_responsibility_escalations(uuid,jsonb,uuid,uuid,integer,bigint),
	public.qorpera_resolve_responsibility_escalation(uuid,jsonb,uuid,text,bigint)
	from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function public.qorpera_escalate_responsibility(jsonb,jsonb) to service_role;
grant execute on function public.qorpera_list_responsibility_escalations(uuid,jsonb,uuid,uuid,integer,bigint),
	public.qorpera_resolve_responsibility_escalation(uuid,jsonb,uuid,text,bigint) to authenticated,service_role;

-- Open decisions retain their exact definition and evidence even when the
-- source run is old and newer Company File heads no longer reference them.
alter function public.qorpera_company_additional_retained_object_hashes(uuid)
	rename to qorpera_company_pre_escalation_retained_object_hashes;
create function public.qorpera_company_additional_retained_object_hashes(p_profile_id uuid)
returns table(object_sha256 text) language sql stable security definer set search_path='' as $$
	with open_queues as (
		select * from public.qorpera_responsibility_escalations where profile_id=p_profile_id and status='open'
	), retained as (
		select source_snapshot_id snapshot_id,source_manifest_sha256 manifest_sha256 from open_queues
		union select o.snapshot_id,o.source#>>'{entry,file,manifestSha256}' from open_queues q
		join public.qorpera_responsibility_escalation_signals s on s.escalation_id=q.id
		cross join lateral unnest(s.evidence_read_ids) evidence(id)
		join public.qorpera_company_read_observations o on o.id=evidence.id and o.run_id=s.run_id
	)
	select object_sha256 from public.qorpera_company_pre_escalation_retained_object_hashes(p_profile_id)
	union select snapshot.tree_manifest_sha256 from retained
	join public.qorpera_company_snapshots snapshot on snapshot.id=retained.snapshot_id
	union select object->>'sha256' from retained
	join public.qorpera_verified_company_file_objects proof on proof.profile_id=p_profile_id and proof.manifest_sha256=retained.manifest_sha256
	cross join lateral jsonb_array_elements(proof.objects) object
$$;
revoke all on function public.qorpera_company_pre_escalation_retained_object_hashes(uuid),
	public.qorpera_company_additional_retained_object_hashes(uuid) from public,anon,authenticated,service_role,qorpera_secret_broker;
do $$ declare v_owner name; begin
	select pg_get_userbyid(proowner) into strict v_owner from pg_proc
	where oid='public.qorpera_company_retained_object_hashes(uuid)'::regprocedure;
	execute format('grant execute on function public.qorpera_company_additional_retained_object_hashes(uuid) to %I',v_owner);
end $$;
