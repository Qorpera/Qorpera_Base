-- The member who started the work pays (28 Sep 2026, "Whose Login Pays").
--
-- A member's own model login pays only for work that member started: their messages and
-- everything that follows from them (coworker messages, background workers, reviews of a
-- change, a computer that finished starting, coding sessions, routines an agent sets up for
-- them). Work whose starter has no usable login is paid by a company account, or does not
-- start. No run is ever paid by another member's login (contract 11.5, 17).
--
-- Before this migration an agent's follow-up work was paid by its standing authority
-- (qorpera_staff_execution_authorities), which 20260923030000 filled with the newest
-- autonomous native sponsor of ANY member and never replaced; coding sessions took the paying
-- member from the model's tool argument; an agent routine preferred the run's binding whoever
-- owned it; room posts and a few answers checked who created a binding, not who owns its login;
-- and a member could ask another member to pay for a turn.
--
-- The starter is already carried: every agent wake copies its parent run's
-- requested_by_user_id, a routine wake takes the member who saved the routine, a room wake the
-- poster, and a run's requested_by_user_id defaults to its created_by_user_id. So this
-- migration changes which login is picked and adds one check where runs are created:
--
-- * qorpera_sponsor_serves_requester: a member_connection sponsor serves only the member who
--   owns its connection; a company sponsor (company-owned connection) serves any member.
-- * qorpera_starter_sponsor: the payer for work a member started: that member's own usable
--   login (the parent run's binding first), else the company account, else their used-up
--   login (the usage-limit handoff then applies, as before).
-- * A BEFORE INSERT/UPDATE trigger on qorpera_execution_runs refuses a sponsor that does not
--   serve the run's requester; every run creator checks first, so no queue scan is poisoned.
-- * Standing authorities keep only company accounts; rows on member logins are removed.
-- * Coding sessions run for the member who asked; "sponsorship requests" are refused.
--
-- No new table, no new lock: the resolver reads, and the checks run inside locks the callers
-- already hold. The company API account (policy, entry, handoff fallback) is a later change;
-- until it exists the company step finds nothing.

-- A member's login serves only that member; a company account serves any member of the company.
create function public.qorpera_sponsor_serves_requester(p_profile_id uuid, p_binding_id uuid,
	p_version bigint, p_requester uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select coalesce((
		select case when sponsor.sponsor_kind = 'member_connection'
				then connection.owner_user_id is not null and connection.owner_user_id = p_requester
			else connection.owner_user_id is null end
		from public.qorpera_execution_sponsor_bindings as binding
		join public.qorpera_execution_sponsor_versions as sponsor
			on sponsor.binding_id = binding.id and sponsor.version = p_version
		join public.qorpera_provider_connections as connection
			on connection.id = sponsor.provider_connection_id and connection.profile_id = binding.profile_id
		where binding.id = p_binding_id and binding.profile_id = p_profile_id), false)
$$;
revoke all on function public.qorpera_sponsor_serves_requester(uuid, uuid, bigint, uuid) from public, anon, authenticated;
grant execute on function public.qorpera_sponsor_serves_requester(uuid, uuid, bigint, uuid) to service_role;

-- The company account for an agent's work: the one an owner or admin configured for this agent,
-- else the company's newest. Company-owned connection, autonomous consent, provider enabled, never a
-- Claude login (coding only, 2026-09-24).
create function public.qorpera_company_account_sponsor(p_profile_id uuid, p_staff_agent_id uuid)
returns table (binding_id uuid, version bigint)
language sql
stable
security definer
set search_path = ''
as $$
	select binding.id, sponsor.version
	from public.qorpera_execution_sponsor_bindings as binding
	join public.qorpera_execution_sponsor_versions as sponsor on sponsor.binding_id = binding.id
		and sponsor.version = (select max(latest.version) from public.qorpera_execution_sponsor_versions as latest
			where latest.binding_id = binding.id)
	join public.qorpera_provider_connections as connection on connection.id = sponsor.provider_connection_id
	join public.qorpera_provider_connection_versions as version on version.connection_id = connection.id
		and version.version = sponsor.provider_connection_version
	join public.qorpera_profile_staff as staff on staff.profile_id = p_profile_id
		and staff.staff_agent_id = p_staff_agent_id and staff.employment_status = 'active'
	left join public.qorpera_staff_execution_authorities as authority on authority.profile_id = p_profile_id
		and authority.staff_agent_id = p_staff_agent_id and authority.sponsor_binding_id = binding.id
	where binding.profile_id = p_profile_id and binding.status = 'active'
		and sponsor.sponsor_kind <> 'member_connection' and sponsor.allow_autonomous
		and connection.profile_id = p_profile_id and connection.owner_user_id is null and connection.status = 'active'
		and connection.provider = coalesce(staff.model_provider, 'openai')
		and version.authorization_state = 'active' and version.allow_autonomous
		and version.native_harness <> 'claude-code'
		and not exists (select 1 from public.qorpera_provider_connection_versions as newer
			where newer.connection_id = connection.id and newer.version > version.version)
		and public.qorpera_provider_execution_enabled(connection.provider, version.authentication_mode, version.native_harness)
	order by (authority.staff_agent_id is not null) desc, sponsor.created_at desc, binding.id
	limit 1
$$;
revoke all on function public.qorpera_company_account_sponsor(uuid, uuid) from public, anon, authenticated;

-- Who pays for an agent's work that a member started: that member's own login with room left
-- (the preferred binding, normally the parent run's, first), else the company account, else the
-- member's used-up login, whose run then meets the usage-limit handoff as before. Never another
-- member's login. Claude logins stay coding-only (2026-09-24) and never pay for agent work.
create function public.qorpera_starter_sponsor(p_profile_id uuid, p_requester uuid, p_staff_agent_id uuid,
	p_prefer_binding_id uuid)
returns table (binding_id uuid, version bigint)
language sql
stable
security definer
set search_path = ''
as $$
	with own as (
		select binding.id as binding_id, sponsor.version, binding.id = p_prefer_binding_id as preferred,
			public.qorpera_native_account_remaining(connection.id, version.version) as remaining, sponsor.created_at
		from public.qorpera_execution_sponsor_bindings as binding
		join public.qorpera_execution_sponsor_versions as sponsor on sponsor.binding_id = binding.id
			and sponsor.version = (select max(latest.version) from public.qorpera_execution_sponsor_versions as latest
				where latest.binding_id = binding.id)
		join public.qorpera_provider_connections as connection on connection.id = sponsor.provider_connection_id
		join public.qorpera_provider_connection_versions as version on version.connection_id = connection.id
			and version.version = sponsor.provider_connection_version
		join public.qorpera_profile_staff as staff on staff.profile_id = p_profile_id
			and staff.staff_agent_id = p_staff_agent_id and staff.employment_status = 'active'
		where binding.profile_id = p_profile_id and binding.status = 'active'
			and sponsor.sponsor_kind = 'member_connection' and sponsor.allow_autonomous
			and connection.profile_id = p_profile_id and connection.status = 'active'
			and connection.owner_user_id = p_requester
			and connection.provider = coalesce(staff.model_provider, 'openai')
			and version.authorization_state = 'active' and version.allow_autonomous
			and version.native_harness <> 'claude-code'
			and not exists (select 1 from public.qorpera_provider_connection_versions as newer
				where newer.connection_id = connection.id and newer.version > version.version)
			and public.qorpera_provider_execution_enabled(connection.provider, version.authentication_mode, version.native_harness)
			and exists (select 1 from public.qorpera_profile_members as member
				where member.profile_id = p_profile_id and member.user_id = p_requester)
	)
	select candidate.binding_id, candidate.version from (
		select own.binding_id, own.version, 1 as rank, own.preferred, own.remaining, own.created_at
		from own where own.remaining <> 0
		union all
		select company.binding_id, company.version, 2, false, null::numeric, null::timestamptz
		from public.qorpera_company_account_sponsor(p_profile_id, p_staff_agent_id) as company
		union all
		select own.binding_id, own.version, 3, own.preferred, own.remaining, own.created_at
		from own where own.remaining = 0
	) as candidate
	order by candidate.rank, candidate.preferred desc, candidate.remaining desc nulls last,
		candidate.created_at desc nulls last, candidate.binding_id
	limit 1
$$;
revoke all on function public.qorpera_starter_sponsor(uuid, uuid, uuid, uuid) from public, anon, authenticated;

-- The one check where runs are created (and where a handoff moves a run): the sponsor must serve
-- the member who requested the run. Every creator checks first, so this only fires on a defect.
create function public.qorpera_execution_run_payer_serves_requester()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if not public.qorpera_sponsor_serves_requester(new.profile_id, new.sponsor_binding_id, new.sponsor_version,
		coalesce(new.requested_by_user_id, new.created_by_user_id)) then
		raise exception 'A member''s model account pays only for work that member started' using errcode = '42501';
	end if;
	return new;
end
$$;
revoke all on function public.qorpera_execution_run_payer_serves_requester() from public, anon, authenticated, service_role;
create trigger qorpera_execution_run_payer_serves_requester
	before insert or update of sponsor_binding_id, sponsor_version, requested_by_user_id, created_by_user_id
	on public.qorpera_execution_runs
	for each row execute function public.qorpera_execution_run_payer_serves_requester();

-- A standing authority names a company account only. The default no longer picks a member's login.
create or replace function public.qorpera_default_staff_execution_sponsor(p_profile_id uuid, p_model_provider text)
returns table (binding_id uuid, sponsor_version bigint, created_by_user_id uuid)
language sql
security definer
set search_path = ''
stable
as $$
	select sponsor.binding_id, sponsor.version, sponsor.created_by_user_id
	from public.qorpera_execution_sponsor_bindings as binding
	join public.qorpera_execution_sponsor_versions as sponsor
		on sponsor.binding_id = binding.id
		and sponsor.version = (
			select max(latest.version) from public.qorpera_execution_sponsor_versions as latest
			where latest.binding_id = binding.id
		)
	join public.qorpera_provider_connections as connection
		on connection.id = sponsor.provider_connection_id
	join public.qorpera_provider_connection_versions as connection_version
		on connection_version.connection_id = connection.id
		and connection_version.version = sponsor.provider_connection_version
	where binding.profile_id = p_profile_id and binding.status = 'active' and sponsor.allow_autonomous
		and sponsor.sponsor_kind <> 'member_connection' and connection.owner_user_id is null
		and connection.profile_id = p_profile_id and connection.status = 'active'
		and connection_version.authorization_state = 'active'
		and public.qorpera_provider_execution_enabled(connection.provider, connection_version.authentication_mode,
			connection_version.native_harness)
		and (p_model_provider is null or connection.provider = p_model_provider)
	order by sponsor.created_at desc, sponsor.binding_id
	limit 1
$$;
revoke all on function public.qorpera_default_staff_execution_sponsor(uuid, text) from public, anon, authenticated;

-- An agent routine runs on the requester's own login or a company account, never on the run's
-- binding when someone else owns it.
create or replace function public.qorpera_agent_routine_sponsor(p_run public.qorpera_execution_runs)
returns table (binding_id uuid, version bigint, owner_user_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
	select binding.id, sponsor.version, connection.owner_user_id
	from public.qorpera_execution_sponsor_bindings binding
	join public.qorpera_execution_sponsor_versions sponsor on sponsor.binding_id = binding.id
	join public.qorpera_provider_connections connection on connection.id = sponsor.provider_connection_id
	join public.qorpera_provider_connection_versions connection_version on connection_version.connection_id = connection.id
		and connection_version.version = sponsor.provider_connection_version
	where binding.profile_id = p_run.profile_id and binding.status = 'active' and sponsor.allow_autonomous
		and connection.profile_id = p_run.profile_id and connection.status = 'active'
		and public.qorpera_provider_execution_enabled(connection.provider, connection_version.authentication_mode,
			connection_version.native_harness)
		and public.qorpera_provider_autonomous_authority(connection.id, sponsor.provider_connection_version)
		and sponsor.version = (select max(latest.version) from public.qorpera_execution_sponsor_versions latest
			where latest.binding_id = binding.id)
		and public.qorpera_sponsor_serves_requester(p_run.profile_id, binding.id, sponsor.version, p_run.requested_by_user_id)
		and not exists (select 1 from public.qorpera_provider_connection_versions harness
			where harness.connection_id = connection.id and harness.native_harness = 'claude-code')
	order by (binding.id = p_run.sponsor_binding_id) desc, sponsor.created_at desc, binding.id
	limit 1
$$;
revoke all on function public.qorpera_agent_routine_sponsor(public.qorpera_execution_runs) from public, anon, authenticated;

-- "Pay for my turn" requests end: approving one would run a member's turn on another member's login.
create or replace function public.qorpera_approve_session_turn_sponsorship(p_turn_request_id uuid,
	p_sponsor_binding_id uuid, p_sponsor_version bigint, p_compute_identity_id uuid,
	p_logical_computer_id uuid default null, p_worker_class text default 'managed_sandbox')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
	raise exception 'A member''s model account pays only for that member''s own work' using errcode = '42501';
end
$$;

-- Each patch below replaces exact text of the current definition, once, and fails loudly when
-- that text differs (a later migration changed the function first).
create function pg_temp.starter_pays_replace(p_definition text, p_old text, p_new text, p_what text)
returns text
language plpgsql
as $$
begin
	if (length(p_definition) - length(replace(p_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'starter pays: % differs', p_what; end if;
	return replace(p_definition, p_old, p_new);
end
$$;

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_pin_wake_occurrence()'::regprocedure);
begin
	v_definition := pg_temp.starter_pays_replace(v_definition, $old$		select * into strict v_authority from public.qorpera_staff_execution_authorities
		where profile_id = new.profile_id and staff_agent_id = new.staff_agent_id for share;
		new.sponsor_binding_id := v_authority.sponsor_binding_id; new.sponsor_version := v_authority.sponsor_version;
		new.logical_computer_id := v_authority.logical_computer_id;
		new.session_id := case when new.source_kind = 'worker-completion' then v_run.session_id
			when new.source_kind = 'coworker' then new.session_id end;
		if new.source_kind = 'worker-dispatch' and exists (select 1 from public.qorpera_runtime_workers w
			where w.id = new.source_id and w.species = 'coding') then
			select w.owner_sponsor_binding_id, w.owner_sponsor_version into new.sponsor_binding_id, new.sponsor_version
			from public.qorpera_runtime_workers w where w.id = new.source_id;
		end if;$old$,
$new$		-- The member who started the chain pays (20260928170000): their own login, else a company
		-- account, never the agent's standing account or another member's login.
		select payer.binding_id, payer.version into new.sponsor_binding_id, new.sponsor_version
		from public.qorpera_starter_sponsor(new.profile_id, new.requested_by_user_id, new.staff_agent_id,
			v_run.sponsor_binding_id) as payer;
		-- A standing authority lends its configured computer only to its own company account.
		select * into v_authority from public.qorpera_staff_execution_authorities
		where profile_id = new.profile_id and staff_agent_id = new.staff_agent_id;
		new.logical_computer_id := case when v_authority.sponsor_binding_id = new.sponsor_binding_id
			then v_authority.logical_computer_id end;
		new.session_id := case when new.source_kind = 'worker-completion' then v_run.session_id
			when new.source_kind = 'coworker' then new.session_id end;
		if new.source_kind = 'worker-dispatch' and exists (select 1 from public.qorpera_runtime_workers w
			where w.id = new.source_id and w.species = 'coding') then
			select w.owner_sponsor_binding_id, w.owner_sponsor_version into new.sponsor_binding_id, new.sponsor_version
			from public.qorpera_runtime_workers w where w.id = new.source_id;
			new.logical_computer_id := null;
		end if;
		if new.sponsor_binding_id is null then
			raise exception 'No model account can pay for this work' using errcode = '42501'; end if;$new$, 'agent wake sponsor');
	v_definition := pg_temp.starter_pays_replace(v_definition, $old$				where binding.id = new.sponsor_binding_id and binding.profile_id = new.profile_id and binding.status = 'active') then
			raise exception 'Room wake authority is unavailable' using errcode = '42501'; end if;$old$,
$new$				where binding.id = new.sponsor_binding_id and binding.profile_id = new.profile_id and binding.status = 'active')
			-- The poster's own login or a company account (20260928170000).
			or not public.qorpera_sponsor_serves_requester(new.profile_id, new.sponsor_binding_id, new.sponsor_version,
				new.requested_by_user_id) then
			raise exception 'Room wake authority is unavailable' using errcode = '42501'; end if;$new$, 'room wake sponsor');
	execute v_definition;
end
$$;

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure);
begin
	v_definition := pg_temp.starter_pays_replace(v_definition, $old$ if v_standing_version is null then return false; end if;$old$,
$new$ if v_standing_version is null then return false; end if;
 -- A member's login pays only for work that member started (20260928170000).
 if not public.qorpera_sponsor_serves_requester(p_wake.profile_id,p_wake.sponsor_binding_id,p_wake.sponsor_version,
  p_wake.requested_by_user_id) then return false; end if;$new$, 'wake payer');
	v_definition := pg_temp.starter_pays_replace(v_definition, $old$			and not exists(select 1 from public.qorpera_staff_execution_authorities where profile_id = p_wake.profile_id
			and staff_agent_id = p_wake.staff_agent_id and sponsor_binding_id = p_wake.sponsor_binding_id
			and sponsor_version = v_standing_version
			and logical_computer_id is not distinct from p_wake.logical_computer_id) then return false; end if;$old$,
$new$			-- Other agent wakes are paid by their starter (checked above), not a standing authority.
			and p_wake.source_kind = 'worker-dispatch' and exists (select 1 from public.qorpera_runtime_workers w
				where w.id = p_wake.source_id and w.species = 'coding') then return false; end if;$new$, 'agent wake authority');
	execute v_definition;
end
$$;

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_send_coworker_message(jsonb,uuid,text,text,boolean)'::regprocedure);
begin
	v_definition := pg_temp.starter_pays_replace(v_definition, $old$	select * into v_authority from public.qorpera_staff_execution_authorities
	where profile_id = v_run.profile_id and staff_agent_id = p_recipient_staff_id for share;
	if not found or not exists(select 1 from public.qorpera_execution_sponsor_versions s
		join public.qorpera_execution_sponsor_bindings b on b.id = s.binding_id
		where s.binding_id = v_authority.sponsor_binding_id and s.version = v_authority.sponsor_version
			and b.profile_id = v_run.profile_id and b.status = 'active' and s.allow_autonomous) then
		raise exception 'Coworker execution authority is unavailable' using errcode = '42501'; end if;$old$,
$new$	-- The member who started this chain pays for the recipient's run (20260928170000).
	select payer.binding_id, payer.version into v_authority.sponsor_binding_id, v_authority.sponsor_version
	from public.qorpera_starter_sponsor(v_run.profile_id, v_run.requested_by_user_id, p_recipient_staff_id,
		v_run.sponsor_binding_id) as payer;
	if v_priority and v_authority.sponsor_binding_id is null then
		raise exception 'Coworker execution authority is unavailable' using errcode = '42501'; end if;$new$, 'coworker payer');
	execute v_definition;
end
$$;

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_manage_agent_worker(jsonb,jsonb)'::regprocedure);
begin
	v_definition := pg_temp.starter_pays_replace(v_definition, $old$			v_owner := coalesce((p_request ->> 'owner')::uuid, v_run.requested_by_user_id);$old$,
$new$			-- The session runs for the member who asked, on their own account (20260928170000).
			v_owner := v_run.requested_by_user_id;
			if p_request ? 'owner' and (p_request ->> 'owner')::uuid is distinct from v_owner then
				raise exception 'A coding session runs for the member who asked for it' using errcode = '42501'; end if;$new$, 'coding owner');
	v_definition := pg_temp.starter_pays_replace(v_definition, $old$		if not exists (select 1 from public.qorpera_staff_execution_authorities authority
			where authority.profile_id = v_run.profile_id and authority.staff_agent_id = v_run.staff_agent_id) then
			raise exception 'No model account is set up for background work by this agent' using errcode = '55000'; end if;$old$,
$new$		-- Background work is paid by the member who started the chain (20260928170000).
		if coalesce(v_species, v_worker.species) <> 'coding' and not exists (select 1
			from public.qorpera_starter_sponsor(v_run.profile_id, v_run.requested_by_user_id, v_run.staff_agent_id,
				v_run.sponsor_binding_id)) then
			raise exception 'No model account is set up for background work by this agent' using errcode = '55000'; end if;$new$, 'background payer');
	v_definition := pg_temp.starter_pays_replace(v_definition, $old$	elsif v_action = 'followup' then
		-- One worker per coherent stream: the same worker continues with its own history.$old$,
$new$	elsif v_action = 'followup' then
		-- A coding session belongs to the member it runs for; other members' work starts its own.
		if v_worker.species = 'coding' and v_worker.owner_user_id is distinct from v_run.requested_by_user_id then
			raise exception 'This coding session runs for another member' using errcode = '42501'; end if;
		-- One worker per coherent stream: the same worker continues with its own history.$new$, 'coding follow-up owner');
	execute v_definition;
end
$$;

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_seed_company_proposal_reviews()'::regprocedure);
begin
	v_definition := pg_temp.starter_pays_replace(v_definition, $old$	select proposal.profile_id, proposal.id, new.revision, reviewer.staff_agent_id,
		authority.sponsor_binding_id, authority.sponsor_version, authority.logical_computer_id
	from public.qorpera_company_proposals as proposal
	cross join unnest(proposal.reviewer_staff_ids) as reviewer(staff_agent_id)
	join public.qorpera_staff_execution_authorities as authority
		on authority.profile_id = proposal.profile_id and authority.staff_agent_id = reviewer.staff_agent_id
	where proposal.id = new.proposal_id and proposal.execution_kind = 'run'$old$,
$new$	-- The member who started the change pays for its review (20260928170000).
	select proposal.profile_id, proposal.id, new.revision, reviewer.staff_agent_id,
		payer.binding_id, payer.version, case when authority.sponsor_binding_id = payer.binding_id
			then authority.logical_computer_id end
	from public.qorpera_company_proposals as proposal
	cross join unnest(proposal.reviewer_staff_ids) as reviewer(staff_agent_id)
	cross join lateral public.qorpera_starter_sponsor(proposal.profile_id, proposal.created_by_user_id,
		reviewer.staff_agent_id, (select origin.sponsor_binding_id from public.qorpera_execution_runs as origin
			where origin.id = proposal.execution_id)) as payer
	left join public.qorpera_staff_execution_authorities as authority
		on authority.profile_id = proposal.profile_id and authority.staff_agent_id = reviewer.staff_agent_id
	where proposal.id = new.proposal_id and proposal.execution_kind = 'run'$new$, 'review seed payer');
	execute v_definition;
end
$$;

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_retry_company_proposal_review(uuid)'::regprocedure);
begin
	v_definition := pg_temp.starter_pays_replace(v_definition, $old$	select authority.* into v_authority
	from public.qorpera_staff_execution_authorities as authority
	where authority.profile_id = v_review.profile_id
		and authority.staff_agent_id = v_review.reviewer_staff_agent_id;$old$,
$new$	-- The member who started the change pays for its review (20260928170000).
	select v_review.profile_id, v_review.reviewer_staff_agent_id, payer.binding_id, payer.version,
		(select authority.logical_computer_id from public.qorpera_staff_execution_authorities as authority
			where authority.profile_id = v_review.profile_id and authority.staff_agent_id = v_review.reviewer_staff_agent_id
				and authority.sponsor_binding_id = payer.binding_id),
		v_proposal.created_by_user_id, statement_timestamp()
	into v_authority
	from public.qorpera_starter_sponsor(v_review.profile_id, v_proposal.created_by_user_id,
		v_review.reviewer_staff_agent_id, null) as payer;$new$, 'review retry payer');
	execute v_definition;
end
$$;

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_materialize_company_proposal_review_runs(integer)'::regprocedure);
begin
	v_definition := pg_temp.starter_pays_replace(v_definition, $old$		if v_sponsor.sponsor_kind = 'member_connection' then$old$,
$new$		if not public.qorpera_sponsor_serves_requester(v_review.profile_id, v_review.reviewer_sponsor_binding_id,
			v_review.reviewer_sponsor_version, v_proposal.created_by_user_id) then
			update public.qorpera_company_proposal_review_assignments
			set status = 'failed', completed_at = statement_timestamp(),
				failure_reason = 'A member''s model account pays only for work that member started'
			where id = v_review.id and status = 'queued';
			continue;
		end if;
		if v_sponsor.sponsor_kind = 'member_connection' then$new$, 'review run payer');
	execute v_definition;
end
$$;

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_materialize_session_turn_requests(integer)'::regprocedure);
begin
	v_definition := pg_temp.starter_pays_replace(v_definition, $old$		if v_binding.id is null or v_sponsor.binding_id is null or v_connection.id is null
			or v_connection_version.connection_id is null$old$,
$new$		if v_binding.id is null or v_sponsor.binding_id is null or v_connection.id is null
			or v_connection_version.connection_id is null
			or not public.qorpera_sponsor_serves_requester(v_request.profile_id, v_request.sponsor_binding_id,
				v_request.sponsor_version, v_request.requested_by_user_id)$new$, 'turn request payer');
	execute v_definition;
end
$$;

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_materialize_session_execution_runs(integer)'::regprocedure);
begin
	v_definition := pg_temp.starter_pays_replace(v_definition, $old$		if not found then
			update public.qorpera_session_inputs
			set failed_at = statement_timestamp(), failure_reason = 'The input author no longer has session write access'
			where id = any(v_input_ids);
			continue;
		end if;$old$,
$new$		if not found then
			update public.qorpera_session_inputs
			set failed_at = statement_timestamp(), failure_reason = 'The input author no longer has session write access'
			where id = any(v_input_ids);
			continue;
		end if;
		-- A configured login pays only for its owner's own messages (20260928170000).
		if not public.qorpera_sponsor_serves_requester(v_session.profile_id, v_binding.sponsor_binding_id,
			v_binding.sponsor_version, v_requester) then
			update public.qorpera_session_inputs
			set failed_at = statement_timestamp(), failure_reason = 'A member''s model account pays only for work that member started'
			where id = any(v_input_ids);
			continue;
		end if;$new$, 'session execution payer');
	execute v_definition;
end
$$;

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_request_session_turn(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid,text,text,text,text,text,uuid[])'::regprocedure);
begin
	v_definition := pg_temp.starter_pays_replace(v_definition, $old$		or p_sponsor_mode not in ('member_connection', 'company_connection', 'sponsorship_request')$old$,
$new$		or p_sponsor_mode not in ('member_connection', 'company_connection')$new$, 'turn sponsor modes');
	execute v_definition;
end
$$;

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_create_execution_sponsor_binding(uuid,uuid,text,uuid,bigint,boolean)'::regprocedure);
begin
	v_definition := pg_temp.starter_pays_replace(v_definition, $old$	if p_sponsor_kind = 'member_connection' and v_connection.owner_user_id is null then
		raise exception 'member sponsor requires a member-owned connection' using errcode = '22023';
	end if;$old$,
$new$	if p_sponsor_kind = 'member_connection' and v_connection.owner_user_id is null then
		raise exception 'member sponsor requires a member-owned connection' using errcode = '22023';
	end if;
	-- Only the member who owns a login binds it (20260928170000).
	if p_sponsor_kind = 'member_connection' and v_connection.owner_user_id is distinct from v_user_id then
		raise exception 'member execution sponsor requires its owner' using errcode = '42501';
	end if;$new$, 'binding owner');
	execute v_definition;
end
$$;

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_configure_staff_execution_authority(uuid,uuid,uuid,bigint,uuid)'::regprocedure);
begin
	v_definition := pg_temp.starter_pays_replace(v_definition, $old$			and (
				sponsor.sponsor_kind <> 'member_connection'
				or exists (
					select 1 from public.qorpera_profile_members as member
					where member.profile_id = p_profile_id and member.user_id = connection.owner_user_id
				)
			)$old$,
$new$			-- A standing authority names a company account only (20260928170000).
			and sponsor.sponsor_kind <> 'member_connection' and connection.owner_user_id is null$new$, 'standing authority kind');
	execute v_definition;
end
$$;

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_reserve_execution_sponsor_authority(uuid)'::regprocedure);
begin
	v_definition := pg_temp.starter_pays_replace(v_definition, $old$	if v_binding.id is null or v_sponsor.binding_id is null or v_connection.id is null
		or v_connection_version.connection_id is null or v_staff.staff_agent_id is null$old$,
$new$	if v_binding.id is null or v_sponsor.binding_id is null or v_connection.id is null
		or v_connection_version.connection_id is null or v_staff.staff_agent_id is null
		or not public.qorpera_sponsor_serves_requester(v_run.profile_id, v_run.sponsor_binding_id, v_run.sponsor_version,
			v_run.requested_by_user_id)$new$, 'reservation payer');
	execute v_definition;
end
$$;

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_enqueue_execution_run(uuid,uuid,uuid,text,uuid,uuid,uuid,bigint,uuid,bigint,text,text,jsonb,text,text,uuid[],uuid)'::regprocedure);
begin
	v_definition := pg_temp.starter_pays_replace(v_definition, $old$			select 1 from public.qorpera_staff_execution_authorities as authority
			where authority.profile_id = v_environment.profile_id
				and authority.staff_agent_id = requested.staff_agent_id
		)$old$,
$new$			select 1 from public.qorpera_starter_sponsor(v_environment.profile_id, v_user_id,
				requested.staff_agent_id, p_sponsor_binding_id)
		)$new$, 'enqueue reviewer payer');
	execute v_definition;
end
$$;

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_configure_session_execution(uuid,uuid,bigint,uuid,text,text,text,text,uuid[])'::regprocedure);
begin
	v_definition := pg_temp.starter_pays_replace(v_definition, $old$				select 1 from public.qorpera_staff_execution_authorities as authority
				where authority.profile_id = v_session.profile_id
					and authority.staff_agent_id = requested.staff_agent_id
			)$old$,
$new$				select 1 from public.qorpera_starter_sponsor(v_session.profile_id, v_user_id,
					requested.staff_agent_id, p_sponsor_binding_id)
			)$new$, 'session reviewer payer');
	execute v_definition;
end
$$;

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_upsert_cloud_routine(uuid,uuid,uuid,uuid,text,text,jsonb,text,uuid,bigint,uuid,text,text,boolean,text,text,uuid[])'::regprocedure);
begin
	v_definition := pg_temp.starter_pays_replace(v_definition, $old$			select 1 from public.qorpera_staff_execution_authorities as authority
			where authority.profile_id = v_profile_id
				and authority.staff_agent_id = requested.staff_agent_id
		)$old$,
$new$			select 1 from public.qorpera_starter_sponsor(v_profile_id, v_user_id,
				requested.staff_agent_id, p_sponsor_binding_id)
		)$new$, 'routine reviewer payer');
	execute v_definition;
end
$$;

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_ensure_unattended_sponsor(public.qorpera_execution_runs)'::regprocedure);
begin
	v_definition := pg_temp.starter_pays_replace(v_definition, $old$		and connection.status = 'active'$old$,
$new$		and connection.status = 'active'
		-- Claude logins are for coding only (2026-09-24); they never pay for agent routines.
		and not exists (select 1 from public.qorpera_provider_connection_versions harness
			where harness.connection_id = connection.id and harness.native_harness = 'claude-code')$new$, 'routine login harness');
	execute v_definition;
end
$$;

-- Standing authorities on a member's login stop existing; they never pay again. Rows on a company
-- account stay. (Live on 28 Sep: 8 in company Qorpera, 4 in the test company, all member logins.)
delete from public.qorpera_staff_execution_authorities as authority
using public.qorpera_execution_sponsor_versions as sponsor
where sponsor.binding_id = authority.sponsor_binding_id and sponsor.version = authority.sponsor_version
	and sponsor.sponsor_kind = 'member_connection';
