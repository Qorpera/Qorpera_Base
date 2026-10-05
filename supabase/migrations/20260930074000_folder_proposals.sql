-- Company folder core, slice P40a: C2-R2, change sets no tool call carried, parked as proposals and reviewed in a run
-- (deploy/first-node/RUNTIME-COMPANY-FOLDER-C2.md §8, the coordinator's shape B of 4 October 2026).
-- * A view's unit that needs review (a deletion or a delegation unit of an in-house agent's view) and carries no review
--   is parked: its outcome is waiting_for_review (reason parked), and the commit makes one proposal of all such units,
--   the whole units as sent, with a row per path they name. Runs and members are unchanged: a run's unit without a
--   review stays review_required (R1 covers tool calls), and members are never reviewed.
-- * An open proposal roots the bytes its units name (core §8). Proposals never expire.
-- * The agent's next run for the same member lists its open proposals (qorpera_folder_agent_proposals) and reviews each
--   as one call, apply_proposal with arguments {"proposalId":…}, through the usual gate: R1's recorder accepts that call
--   for the proposal it names (the approved call's digest covers the id) and records the review of the proposal's own
--   units, and qorpera_folder_apply_proposal commits them as the run with that review. The commit applies them as any
--   reviewed unit (a moved base is a conflict, kept as a copy by P17) and closes the proposal: applied when a unit
--   saved, not_applied otherwise. A deny closes it as declined; the agent's run, the asked member and owners or admins
--   may discard it.
-- * A hire through a view by an agent that cannot delegate the new agent's default access asks the owners and admins,
--   as hire_agent does (contract 14.1).
-- * Erasing a path erases the open proposals that name a path under it before the root's cutoff, as P18d erases
--   conflict copies.
-- Lock order: a proposal row is rank 7c, after the folder review (7b) and before ranks 8 and 9. The applying commit
-- takes it FOR NO KEY UPDATE after the review; a close, a member's discard and the recorder (FOR SHARE) take it after
-- their ranks 0 to 7; the erasure takes it FOR UPDATE after its rank 7 and before its rank 8. The parking commit only
-- inserts. Every patched body carries the marker 20260930074000 for the deploy guard.

set local lock_timeout = '3s';

create function pg_temp.p40_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'P40 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The tables ------------------------------------------------------------------------------------------------------

-- One row per parking commit that parked units. Open, it holds those units as the view sent them (with their structured
-- parses), their numbers in the parking commit, their change-set digest and its effect (destructive when a unit
-- deletes or moves). Once decided its units are emptied and its path rows go: the decision's own commit (or the
-- answer) is the record.
create table public.qorpera_folder_proposals (
	id uuid primary key,
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	profile_id uuid not null,
	commit_id uuid not null references public.qorpera_folder_commits(id),
	staff_agent_id uuid not null,
	member_user_id uuid not null,
	view_id uuid not null,
	view_kind text not null,
	units jsonb not null check (jsonb_typeof(units) = 'array' and jsonb_array_length(units) <= 1000),
	commit_units integer[] not null check (cardinality(commit_units) between 1 and 1000),
	change_set_sha256 text not null check (change_set_sha256 ~ '^[0-9a-f]{64}$'),
	effect text not null check (effect in ('delegation','destructive')),
	status text not null default 'open' check (status in ('open','applied','not_applied','declined','discarded')),
	created_at timestamptz not null default clock_timestamp(),
	decided_at timestamptz,
	decided_by text check (decided_by in ('review','staff_agent','member')),
	decided_by_user_id uuid,
	review_id uuid,
	action_review_id uuid,
	apply_commit_id uuid references public.qorpera_folder_commits(id),
	check ((status = 'open') = (decided_at is null) and (status = 'open') = (decided_by is null)),
	check ((status = 'open') = (jsonb_array_length(units) > 0)),
	check ((status in ('applied','not_applied')) = (apply_commit_id is not null)),
	check (status <> 'discarded' or decided_by in ('staff_agent','member')),
	check (status not in ('applied','not_applied','declined') or decided_by = 'review')
);
create index qorpera_folder_proposals_open on public.qorpera_folder_proposals(environment_id, staff_agent_id, member_user_id,
	created_at, id) where status = 'open';
alter table public.qorpera_folder_proposals enable row level security;
revoke all on public.qorpera_folder_proposals from public, anon, authenticated, service_role;

-- One row per path an open proposal's units name: item 0 is a unit's own path (a move's or copy's source), item 1 a
-- move's or copy's target, items 1 and up a new folder's contents in their order; a file's row names its manifest. The
-- manifest index serves the root check, the key index erasure's cover test. Rows go when the proposal is decided.
create table public.qorpera_folder_proposal_paths (
	proposal_id uuid not null references public.qorpera_folder_proposals(id) on delete cascade,
	environment_id uuid not null,
	unit_no integer not null check (unit_no >= 1),
	item_no integer not null check (item_no >= 0),
	path text collate "C" not null check (public.qorpera_company_path_valid(path)),
	key_text text collate "C" generated always as (public.qorpera_folder_key(path)) stored,
	manifest_sha256 text check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
	primary key (proposal_id, unit_no, item_no)
);
create index qorpera_folder_proposal_paths_key_text on public.qorpera_folder_proposal_paths(environment_id, key_text);
create index qorpera_folder_proposal_paths_manifest on public.qorpera_folder_proposal_paths(environment_id, manifest_sha256)
	where manifest_sha256 is not null;
alter table public.qorpera_folder_proposal_paths enable row level security;
revoke all on public.qorpera_folder_proposal_paths from public, anon, authenticated, service_role;

-- The folder review an apply records names its proposal.
alter table public.qorpera_folder_reviews add column proposal_id uuid;

-- 2. Helpers ---------------------------------------------------------------------------------------------------------

-- The digest of the call that applies a proposal, as the runtime's tool boundary takes it: the SHA-256 of the JSON
-- array [namespace, tool, arguments text], the arguments being exactly {"proposalId":"<id>"}.
create function public.qorpera_folder_proposal_call_sha256(p_proposal_id uuid)
returns text language sql stable set search_path = '' as $$
	select encode(extensions.digest(convert_to('["qorpera","apply_proposal",'
		|| to_json('{"proposalId":"' || p_proposal_id::text || '"}')::text || ']', 'utf8'), 'sha256'), 'hex')
$$;
revoke all on function public.qorpera_folder_proposal_call_sha256(uuid) from public, anon, authenticated, service_role;

-- The proposal an apply_proposal call names, when its arguments are exactly {"proposalId":"<id>"} and its digest is
-- that call's; otherwise null.
create function public.qorpera_folder_proposal_of_call(p_argument_sha256 text, p_arguments text)
returns uuid language plpgsql stable set search_path = '' as $$
declare v_id uuid;
begin
	if coalesce(p_arguments, '') !~ '^\{"proposalId":"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"\}$' then
		return null; end if;
	v_id := substr(p_arguments, 16, 36)::uuid;
	if public.qorpera_folder_proposal_call_sha256(v_id) is distinct from p_argument_sha256 then return null; end if;
	return v_id;
end $$;
revoke all on function public.qorpera_folder_proposal_of_call(text, text) from public, anon, authenticated, service_role;

-- Whether units make an agent: an agent.md, written alone or inside a new folder, where no live file is.
create function public.qorpera_folder_units_create_agent(p_environment_id uuid, p_units jsonb)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p_units) = 'array' then p_units else '[]'::jsonb end) u
		cross join lateral public.qorpera_company_state_unit_files(u.value, u.value ->> 'path') f
		where public.qorpera_structured_path_kind(f.key) = 'agent'
			and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
				and e.key_sha256 = extensions.digest(f.key, 'sha256') and e.kind = 'file'))
$$;
revoke all on function public.qorpera_folder_units_create_agent(uuid, jsonb) from public, anon, authenticated, service_role;

-- Whether an action review record applies an open proposal of this environment that makes an agent (the layering's
-- restricted hire; the recorder checks again under the proposal's lock).
create function public.qorpera_folder_proposal_hires(p_environment_id uuid, p_review jsonb)
returns boolean language sql stable security definer set search_path = '' as $$
	select p_review ->> 'tool' = 'apply_proposal' and coalesce((select public.qorpera_folder_units_create_agent(p_environment_id, q.units)
		from public.qorpera_folder_proposals q
		where q.id = public.qorpera_folder_proposal_of_call(p_review ->> 'argumentSha256', p_review -> 'action' ->> 'arguments')
			and q.environment_id = p_environment_id and q.status = 'open'), false)
$$;
revoke all on function public.qorpera_folder_proposal_hires(uuid, jsonb) from public, anon, authenticated, service_role;

-- 3. The commit: parking, and applying ------------------------------------------------------------------------------

select pg_temp.p40_replace('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$	v_kept integer := 0; -- 20260930042000 (P17)
$old$,
	$new$	v_kept integer := 0; -- 20260930042000 (P17)
	-- 20260930074000 (P40): the units this commit parks and the proposal they make; a proposal this commit applies, or
	-- refuses to; and the actor the byte checks take (the platform for an applied proposal's own files).
	v_parked jsonb := '[]'::jsonb; v_proposal_id uuid := extensions.gen_random_uuid();
	v_proposal public.qorpera_folder_proposals%rowtype; v_proposal_refused boolean := false; v_bytes_actor jsonb := p_actor;
$new$);

select pg_temp.p40_replace('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$	v_change_set_sha := public.qorpera_folder_change_set_sha256(p_units);
$old$,
	$new$	v_change_set_sha := public.qorpera_folder_change_set_sha256(p_units);
	-- 20260930074000 (P40), rank 7c: the proposal the review applies, FOR NO KEY UPDATE, which a second apply, a close, a
	-- member's discard and an erasure take as well. It must still be open, of this run's agent for this run's requester,
	-- and these units; otherwise the review stands for none of them. Its files passed the possession check when the view
	-- parked them, so the byte checks take them as the platform's: the proof, the catalog and step 6's lock still hold.
	if v_review.proposal_id is not null then
		select * into v_proposal from public.qorpera_folder_proposals where id = v_review.proposal_id for no key update;
		if not found or v_proposal.status <> 'open' or v_proposal.environment_id <> p_environment_id or v_actor_kind <> 'run'
			or v_proposal.staff_agent_id is distinct from v_actor_id
			or v_proposal.member_user_id is distinct from (v_resolved ->> 'requesterUserId')::uuid
			or v_proposal.change_set_sha256 is distinct from v_change_set_sha then
			v_proposal := null; v_proposal_refused := true;
		else
			v_bytes_actor := jsonb_build_object('kind', 'platform');
		end if;
	end if;
$new$);

select pg_temp.p40_replace('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$		provider_connection_id, runtime_bundle_id, units, as_of_seq, view_id, view_kind, turn_run_id, receipt_id)$old$,
	$new$		provider_connection_id, runtime_bundle_id, units, as_of_seq, view_id, view_kind, turn_run_id, receipt_id, proposal_id)$new$);
select pg_temp.p40_replace('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$		v_view.id, v_view.kind, v_turn_run, p_receipt_id);$old$,
	$new$		v_view.id, v_view.kind, v_turn_run, p_receipt_id, v_proposal.id);$new$);

select pg_temp.p40_replace('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$			elsif public.qorpera_folder_contents_bytes_problem(p_environment_id, v_file.profile_id, p_actor, v_auth_actor,$old$,
	$new$			elsif public.qorpera_folder_contents_bytes_problem(p_environment_id, v_file.profile_id, v_bytes_actor, v_auth_actor,$new$);
select pg_temp.p40_replace('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$			elsif public.qorpera_folder_file_bytes_problem(p_environment_id, v_file.profile_id, p_actor, v_auth_actor,$old$,
	$new$			elsif public.qorpera_folder_file_bytes_problem(p_environment_id, v_file.profile_id, v_bytes_actor, v_auth_actor,$new$);
select pg_temp.p40_replace('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$			v_kept := v_kept + public.qorpera_folder_keep_conflict_copies(p_environment_id, v_file.profile_id, p_actor,$old$,
	$new$			v_kept := v_kept + public.qorpera_folder_keep_conflict_copies(p_environment_id, v_file.profile_id, v_bytes_actor,$new$);

select pg_temp.p40_replace('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$		-- Names the folder never holds, on every path the unit produces.
$old$,
	$new$		-- 20260930074000 (P40): a review naming a proposal this commit may not apply stands for none of its units: each is
		-- refused before anything else is decided (and keeps no conflict copy).
		if v_ok and v_proposal_refused then v_ok := false; v_reason := 'review_required'; end if;

		-- Names the folder never holds, on every path the unit produces.
$new$);
select pg_temp.p40_replace('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$			if v_class is distinct from 'plain' then
				if v_review.id is null or v_review.run_id is distinct from (v_auth_actor ->> 'runId')::uuid$old$,
	$new$			if v_class is distinct from 'plain' then
				-- 20260930074000 (P40): a view's unit that carries no review is parked, whole, for the agent's next run
				-- with this member (C2 §8); its spelling is kept for the proposal's path rows.
				if v_actor_kind = 'view' and p_review_id is null then
					v_ok := false; v_reason := 'parked';
					v_parked := v_parked || jsonb_build_array(jsonb_build_object('no', v_no, 'unit', v_unit, 'path', v_eff_path,
						'to', v_eff_to));
				elsif v_review.id is null or v_review.run_id is distinct from (v_auth_actor ->> 'runId')::uuid$new$);
select pg_temp.p40_replace('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$				when v_reason = 'waiting_for_review' then 'waiting_for_review'$old$,
	$new$				when v_reason in ('waiting_for_review','parked') then 'waiting_for_review'$new$);

select pg_temp.p40_replace('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$	-- Claims that did not become live never outlive the transaction.
$old$,
	$new$	-- 20260930074000 (P40): the parked units become one proposal, with a row per path they name: item 0 the unit's own
	-- path (a write's names its manifest), item 1 a move's or copy's target, items 1 and up a new folder's contents.
	if jsonb_array_length(v_parked) > 0 then
		insert into public.qorpera_folder_proposals(id, environment_id, profile_id, commit_id, staff_agent_id, member_user_id,
			view_id, view_kind, units, commit_units, change_set_sha256, effect)
		select v_proposal_id, p_environment_id, v_file.profile_id, v_commit_id, v_actor_id, (v_resolved ->> 'requesterUserId')::uuid,
			v_view.id, v_view.kind, u.units, u.nos, public.qorpera_folder_change_set_sha256(u.units), u.effect
		from (select jsonb_agg(x.p -> 'unit' order by x.o) as units, array_agg((x.p ->> 'no')::integer order by x.o) as nos,
				case when bool_or(x.p -> 'unit' ->> 'op' in ('delete','move')) then 'destructive' else 'delegation' end as effect
			from jsonb_array_elements(v_parked) with ordinality x(p, o)) u;
		insert into public.qorpera_folder_proposal_paths(proposal_id, environment_id, unit_no, item_no, path, manifest_sha256)
		select v_proposal_id, p_environment_id, x.o::integer, i.item_no, i.path, i.manifest
		from jsonb_array_elements(v_parked) with ordinality x(p, o)
		cross join lateral (
			select 0 as item_no, x.p ->> 'path' as path,
				case when x.p -> 'unit' ->> 'op' = 'write' then x.p -> 'unit' -> 'file' ->> 'manifestSha256' end as manifest
			union all
			select 1, x.p ->> 'to', null where x.p ->> 'to' is not null
			union all
			select s.ord::integer, s.path, case when s.kind = 'file' then s.file ->> 'manifestSha256' end
			from public.qorpera_folder_spelled_contents(x.p ->> 'path', case when x.p -> 'unit' ->> 'op' = 'new_folder'
				then x.p -> 'unit' -> 'contents' else '[]'::jsonb end) s) i;
	end if;
	-- The proposal this commit applied is decided: applied when a unit saved, not applied otherwise. Its units are in this
	-- commit now; its own copy and its roots go.
	if v_proposal.id is not null then
		update public.qorpera_folder_proposals set status = case when v_saved > 0 then 'applied' else 'not_applied' end,
			units = '[]'::jsonb, decided_at = clock_timestamp(), decided_by = 'review', decided_by_user_id = v_review.answered_by_user_id,
			review_id = v_review.id, apply_commit_id = v_commit_id
		where id = v_proposal.id;
		delete from public.qorpera_folder_proposal_paths where proposal_id = v_proposal.id;
	end if;

	-- Claims that did not become live never outlive the transaction.
$new$);

select pg_temp.p40_replace('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$	if v_saved = 0 and v_kept = 0 then -- 20260930042000 (P17): kept copies go on to the checks below$old$,
	$new$	-- 20260930042000 (P17), 20260930074000 (P40): kept copies and parked units go on to the checks below.
	if v_saved = 0 and v_kept = 0 and jsonb_array_length(v_parked) = 0 then$new$);

-- 4. The root ------------------------------------------------------------------------------------------------------

select pg_temp.p40_replace('public.qorpera_folder_object_rooted(uuid,text,uuid)'::regprocedure,
	$old$				or exists (select 1 from public.qorpera_folder_conflict_copies k
					where k.environment_id = f.environment_id and k.manifest_sha256 = m.manifest))
$old$,
	$new$				or exists (select 1 from public.qorpera_folder_conflict_copies k
					where k.environment_id = f.environment_id and k.manifest_sha256 = m.manifest)
				-- 20260930074000 (P40): a file of an open proposal (its path rows go when it is decided).
				or exists (select 1 from public.qorpera_folder_proposal_paths q
					where q.environment_id = f.environment_id and q.manifest_sha256 = m.manifest))
$new$);

-- 5. The recorder: an apply_proposal approval stands for the proposal its call names ------------------------------------

select pg_temp.p40_replace('public.qorpera_folder_record_review(jsonb,jsonb)'::regprocedure,
	$old$	v_keys constant text[] := array['actionReviewId','tool','argumentSha256','units'];
$old$,
	$new$	-- 20260930074000 (P40): applying a proposal names it; its units are the proposal's own.
	v_keys constant text[] := case when p_request ->> 'tool' = 'apply_proposal'
		then array['actionReviewId','tool','argumentSha256','proposalId'] else array['actionReviewId','tool','argumentSha256','units'] end;
	v_proposal public.qorpera_folder_proposals%rowtype;
$new$);
select pg_temp.p40_replace('public.qorpera_folder_record_review(jsonb,jsonb)'::regprocedure,
	$old$		or jsonb_typeof(p_request -> 'units') is distinct from 'array'
		or jsonb_array_length(p_request -> 'units') not between 1 and 1000 then$old$,
	$new$		or (p_request ->> 'tool' is distinct from 'apply_proposal' and (jsonb_typeof(p_request -> 'units') is distinct from 'array'
			or jsonb_array_length(p_request -> 'units') not between 1 and 1000))
		or (p_request ->> 'tool' = 'apply_proposal' and (jsonb_typeof(p_request -> 'proposalId') is distinct from 'string'
			or p_request ->> 'proposalId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) then$new$);
select pg_temp.p40_replace('public.qorpera_folder_record_review(jsonb,jsonb)'::regprocedure,
	$old$			'manage_worker' /* 20260930003000 (F2-5b) */)
$old$,
	$new$			'manage_worker' /* 20260930003000 (F2-5b) */)
			-- 20260930074000 (P40): a proposal the run applies, named by the approved call's arguments, which its digest covers.
			or (v_action.tool_name = 'apply_proposal'
				and v_action.argument_sha256 = public.qorpera_folder_proposal_call_sha256((p_request ->> 'proposalId')::uuid))
$new$);
select pg_temp.p40_replace('public.qorpera_folder_record_review(jsonb,jsonb)'::regprocedure,
	$old$	-- A hire by an agent that cannot delegate the new agent's default access stands only on an owner's or admin's
$old$,
	$new$	-- 20260930074000 (P40), rank 7c: the proposal, FOR SHARE, which an apply's FOR NO KEY UPDATE waits for. It is open, of
	-- this run's agent for this run's requester, and the review is of its own units.
	if v_action.tool_name = 'apply_proposal' then
		select * into v_proposal from public.qorpera_folder_proposals where id = (p_request ->> 'proposalId')::uuid for share;
		if not found or v_proposal.status <> 'open' or v_proposal.environment_id <> v_run.environment_id
			or v_proposal.staff_agent_id <> v_run.staff_agent_id or v_proposal.member_user_id is distinct from v_run.requested_by_user_id then
			raise exception 'This proposal is not open for this run' using errcode = '42501'; end if;
		v_units := v_proposal.units;
	end if;
	-- A hire by an agent that cannot delegate the new agent's default access stands only on an owner's or admin's
$new$);
select pg_temp.p40_replace('public.qorpera_folder_record_review(jsonb,jsonb)'::regprocedure,
	$old$	if v_action.tool_name = 'hire_agent'
$old$,
	$new$	if (v_action.tool_name = 'hire_agent'
		-- 20260930074000 (P40): and a proposal that makes an agent.
		or (v_action.tool_name = 'apply_proposal' and public.qorpera_folder_units_create_agent(v_run.environment_id, v_units)))
$new$);
select pg_temp.p40_replace('public.qorpera_folder_record_review(jsonb,jsonb)'::regprocedure,
	$old$		if v_review.change_set_sha256 <> v_sha or v_review.run_id <> v_run.id then$old$,
	$new$		if v_review.change_set_sha256 <> v_sha or v_review.run_id <> v_run.id or v_review.proposal_id is distinct from v_proposal.id then$new$);
select pg_temp.p40_replace('public.qorpera_folder_record_review(jsonb,jsonb)'::regprocedure,
	$old$			answered_by_user_id, answered_at)
$old$,
	$new$			answered_by_user_id, answered_at, proposal_id)
$new$);
select pg_temp.p40_replace('public.qorpera_folder_record_review(jsonb,jsonb)'::regprocedure,
	$old$			case when v_card then v_action.answered_by_user_id end, case when v_card then v_action.answered_at end)
$old$,
	$new$			case when v_card then v_action.answered_by_user_id end, case when v_card then v_action.answered_at end, v_proposal.id)
$new$);

-- 6. The layering: the call's binding, and the restricted hire ------------------------------------------------------------

select pg_temp.p40_replace('public.qorpera_record_action_review(jsonb,jsonb)'::regprocedure,
	$old$	v_decision := p_review ->> 'decision';
$old$,
	$new$	v_decision := p_review ->> 'decision';
	-- 20260930074000 (P40): applying a proposal is a delegation or a deletion whose arguments name the proposal, which the
	-- digest covers.
	if p_review ->> 'tool' = 'apply_proposal' and (p_review ->> 'effect' not in ('delegation','destructive')
		or public.qorpera_folder_proposal_of_call(p_review ->> 'argumentSha256', p_review -> 'action' ->> 'arguments') is null) then
		raise exception 'Action review record is invalid' using errcode = '22023'; end if;
$new$);
select pg_temp.p40_replace('public.qorpera_record_action_review(jsonb,jsonb)'::regprocedure,
	$old$	if p_review ->> 'tool' = 'hire_agent' and v_decision <> 'deny'
$old$,
	$new$	-- 20260930074000 (P40): so does a proposal that makes an agent.
	if (p_review ->> 'tool' = 'hire_agent' or public.qorpera_folder_proposal_hires(v_run.environment_id, p_review))
		and v_decision <> 'deny'
$new$);

-- 7. Erasure: the open proposals that name a path under a root before its cutoff --------------------------------------

select pg_temp.p40_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$	v_targets jsonb; v_changes jsonb; v_erased jsonb; v_env uuid; v_journal jsonb := '{}'::jsonb; v_pairs uuid[]; v_workers uuid[];
$old$,
	$new$	v_targets jsonb; v_changes jsonb; v_erased jsonb; v_env uuid; v_journal jsonb := '{}'::jsonb; v_pairs uuid[]; v_workers uuid[];
	v_proposals uuid[]; -- 20260930074000 (P40)
$new$);
select pg_temp.p40_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$	-- 2. Rank 0: the company row KEY SHARE; a company being deleted is purged whole.
$old$,
	$new$	-- 20260930074000 (P40): the open proposals naming a path under a root, for rank 7c (a plain read; read again after the
	-- paths).
	select coalesce(array_agg(distinct q.proposal_id order by q.proposal_id), '{}') into v_proposals
	from unnest(v_keys) k join public.qorpera_folder_proposal_paths q on q.environment_id = p_environment_id
		and q.key_text >= k collate "C" and q.key_text < (k || '0') collate "C" and public.qorpera_folder_erasure_covers(k, q.key_text);

	-- 2. Rank 0: the company row KEY SHARE; a company being deleted is purged whole.
$new$);
select pg_temp.p40_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$	perform 1 from public.qorpera_cloud_secret_operation_grants g where g.profile_id = v_profile and g.staff_agent_id = any(v_staff_ids)
$old$,
	$new$	-- 20260930074000 (P40), rank 7c: those proposals FOR UPDATE in id order, after rank 7 and before rank 8, where an apply,
	-- a close and a member's discard take one.
	perform 1 from public.qorpera_folder_proposals where id = any(v_proposals) order by id for update;
	perform 1 from public.qorpera_cloud_secret_operation_grants g where g.profile_id = v_profile and g.staff_agent_id = any(v_staff_ids)
$new$);
select pg_temp.p40_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$			where w.folder_retired_at is not null and w.profile_id = v_profile and not w.id = any(v_workers)) then
$old$,
	$new$			where w.folder_retired_at is not null and w.profile_id = v_profile and not w.id = any(v_workers))
		-- 20260930074000 (P40): a proposal parked under a root since the plain read.
		or exists (select 1 from unnest(v_keys) k join public.qorpera_folder_proposal_paths q on q.environment_id = p_environment_id
			and q.key_text >= k collate "C" and q.key_text < (k || '0') collate "C" and public.qorpera_folder_erasure_covers(k, q.key_text)
			where not q.proposal_id = any(v_proposals)) then
$new$);
select pg_temp.p40_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$		'rules', cardinality(v_rules), 'tables', cardinality(v_tables)); -- 20260930028000 (P18c)
$old$,
	$new$		'rules', cardinality(v_rules), 'tables', cardinality(v_tables), -- 20260930028000 (P18c)
		'proposals', cardinality(v_proposals)); -- 20260930074000 (P40)
$new$);
select pg_temp.p40_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$	v_erased := jsonb_build_object('agents', cardinality(v_staff_ids), 'groupChats', cardinality(v_rooms),
$old$,
	$new$	-- 20260930074000 (P40): of the proposals locked at rank 7c, those still open that name a path under a root before its
	-- cutoff, placed as a conflict copy is (qorpera_folder_erasure_copy_before): by the parking commit's seq and the
	-- unit's number there when that commit saved something, else by its time.
	v_proposals := array(select distinct q.proposal_id from jsonb_array_elements(v_roots) r
		join public.qorpera_folder_proposal_paths q on q.environment_id = p_environment_id and q.proposal_id = any(v_proposals)
			and q.key_text >= (r ->> 'key') collate "C" and q.key_text < ((r ->> 'key') || '0') collate "C"
			and public.qorpera_folder_erasure_covers(r ->> 'key', q.key_text)
		join public.qorpera_folder_proposals p on p.id = q.proposal_id and p.status = 'open'
		join public.qorpera_folder_commits c on c.id = p.commit_id
		where public.qorpera_folder_erasure_copy_before(r, c.seq, c.created_at, p.commit_units[q.unit_no]));
	v_erased := jsonb_build_object('agents', cardinality(v_staff_ids), 'groupChats', cardinality(v_rooms),
$new$);
select pg_temp.p40_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$	delete from public.qorpera_folder_human_task_index i using jsonb_array_elements(v_roots) r
$old$,
	$new$	-- 20260930074000 (P40): the erased proposals go: their files' hashes to phase 5 (which collects what nothing else
	-- roots) and their parking commits' runs to phase 4, as conflict copies' do (20260930045000); the roots' spellings are
	-- the needles above.
	insert into public.qorpera_folder_erasure_hashes(erasure_id, sha256)
	select distinct v_id, x.h from (
		select q.manifest_sha256 as h from public.qorpera_folder_proposal_paths q
		where q.proposal_id = any(v_proposals) and q.manifest_sha256 is not null
		union
		select ch.chunk_sha256 from public.qorpera_folder_proposal_paths q
		join public.qorpera_folder_file_chunks ch on ch.profile_id = v_profile and ch.manifest_sha256 = q.manifest_sha256
		where q.proposal_id = any(v_proposals)) x
	on conflict do nothing;
	insert into public.qorpera_folder_erasure_runs(erasure_id, run_id)
	select distinct v_id, c.run_id from public.qorpera_folder_proposals p join public.qorpera_folder_commits c on c.id = p.commit_id
	where p.id = any(v_proposals) and c.run_id is not null
	on conflict do nothing;
	delete from public.qorpera_folder_proposals where id = any(v_proposals);
	delete from public.qorpera_folder_human_task_index i using jsonb_array_elements(v_roots) r
$new$);

-- 8. A run's list, apply and close; a member's discard ------------------------------------------------------------------

-- The open proposals of a run's agent for the run's requester, oldest first, at most 4 per page after `cursor` (a
-- proposal the last page ended on), each with its first 50 units: op, path, target, a new folder's item count and its
-- structured files' parses. Only a run that can raise a card lists them: an in-house agent's run with a session, no
-- worker, not in another agent's room (a group chat), as qorpera_record_action_review raises one.
create function public.qorpera_folder_agent_proposals(p_environment_id uuid, p_actor jsonb, p_request jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_auth jsonb; v_run public.qorpera_execution_runs%rowtype; v_after public.qorpera_folder_proposals%rowtype;
	v_rows public.qorpera_folder_proposals[]; v_more bigint;
	c_page constant integer := 4; c_units constant integer := 50;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_actor ->> 'kind' is distinct from 'run' then
		raise exception 'Proposal authority is unavailable' using errcode = '42501'; end if;
	v_auth := public.qorpera_folder_read_actor(p_environment_id, p_actor);
	select * into v_run from public.qorpera_execution_runs where id = (p_actor ->> 'runId')::uuid;
	if v_auth ->> 'kind' is distinct from 'staff_agent' or v_auth ->> 'sessionKind' is distinct from 'in_house'
		or v_run.session_id is null or (public.qorpera_run_worker(v_run.id)).id is not null
		or exists (select 1 from public.qorpera_company_rooms room
			where room.session_id = v_run.session_id and room.bound_staff_agent_id is distinct from v_run.staff_agent_id) then
		raise exception 'Proposal authority is unavailable' using errcode = '42501'; end if;
	if jsonb_typeof(p_request) is distinct from 'object'
		or exists (select 1 from jsonb_object_keys(p_request) k where k <> 'cursor')
		or (p_request ? 'cursor' and coalesce(p_request ->> 'cursor', '')
			!~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
		raise exception 'Proposal request is invalid' using errcode = '22023'; end if;
	if p_request ? 'cursor' then
		select * into v_after from public.qorpera_folder_proposals q where q.id = (p_request ->> 'cursor')::uuid
			and q.environment_id = p_environment_id and q.staff_agent_id = v_run.staff_agent_id
			and q.member_user_id = v_run.requested_by_user_id;
		if v_after.id is null then
			raise exception 'Proposal cursor is unavailable; list again without it' using errcode = 'P0002'; end if;
	end if;
	v_rows := array(select q from public.qorpera_folder_proposals q
		where q.environment_id = p_environment_id and q.staff_agent_id = v_run.staff_agent_id
			and q.member_user_id = v_run.requested_by_user_id and q.status = 'open'
			and (v_after.id is null or (q.created_at, q.id) > (v_after.created_at, v_after.id))
		order by q.created_at, q.id limit c_page + 1);
	v_more := greatest(cardinality(v_rows) - c_page, 0);
	if v_more > 0 then
		select count(*) into v_more from public.qorpera_folder_proposals q
		where q.environment_id = p_environment_id and q.staff_agent_id = v_run.staff_agent_id
			and q.member_user_id = v_run.requested_by_user_id and q.status = 'open'
			and (q.created_at, q.id) > ((v_rows[c_page]).created_at, (v_rows[c_page]).id);
	end if;
	return jsonb_build_object('schema', 'qorpera.folder-agent-proposals/v1',
		'proposals', coalesce((select jsonb_agg(jsonb_build_object('proposalId', (v_rows[i]).id, 'createdAt', (v_rows[i]).created_at,
				'viewKind', (v_rows[i]).view_kind, 'effect', (v_rows[i]).effect,
				'createsAgent', public.qorpera_folder_units_create_agent(p_environment_id, (v_rows[i]).units),
				'unitCount', jsonb_array_length((v_rows[i]).units),
				'units', (select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('unit', u.o, 'op', u.v ->> 'op',
						'path', coalesce(u.v ->> 'from', u.v ->> 'path'), 'to', u.v ->> 'to',
						'items', case when u.v ->> 'op' = 'new_folder' then jsonb_array_length(u.v -> 'contents') end,
						'structured', (select jsonb_agg(jsonb_build_object('path', s.value ->> 'path', 'kind', s.value ->> 'kind',
								'parse', s.value -> 'parse') order by s.ord)
							from jsonb_array_elements(case when jsonb_typeof(u.v -> 'structured') = 'array' then u.v -> 'structured'
								else '[]'::jsonb end) with ordinality s(value, ord)
							where jsonb_typeof(s.value -> 'parse') = 'object'))) order by u.o)
					from jsonb_array_elements((v_rows[i]).units) with ordinality u(v, o) where u.o <= c_units),
				'moreUnits', greatest(jsonb_array_length((v_rows[i]).units) - c_units, 0)) order by i)
			from generate_series(1, least(cardinality(v_rows), c_page)) i), '[]'::jsonb),
		'moreProposals', v_more,
		'nextCursor', case when v_more > 0 then to_jsonb((v_rows[c_page]).id) else 'null'::jsonb end);
end $$;
revoke all on function public.qorpera_folder_agent_proposals(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.qorpera_folder_agent_proposals(uuid, jsonb, jsonb) to service_role;

-- Commits an open proposal's units as the run, with the review R1's recorder made of them (its proposal_id names this
-- proposal). A retry with the same operation key after the apply decided it answers as the commit's replay.
create function public.qorpera_folder_apply_proposal(p_environment_id uuid, p_actor jsonb, p_operation_key text,
	p_proposal_id uuid, p_review_id uuid, p_receipt_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_proposal public.qorpera_folder_proposals%rowtype; v_commit public.qorpera_folder_commits%rowtype;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_actor ->> 'kind' is distinct from 'run'
		or coalesce(p_actor ->> 'runId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		or p_proposal_id is null or p_review_id is null then
		raise exception 'Proposal apply is invalid' using errcode = '22023'; end if;
	select * into v_proposal from public.qorpera_folder_proposals where id = p_proposal_id and environment_id = p_environment_id;
	if not found then raise exception 'Proposal is unavailable' using errcode = 'P0002'; end if;
	if v_proposal.status <> 'open' then
		select c.* into v_commit from public.qorpera_folder_operation_keys k
		join public.qorpera_folder_commits c on c.id = k.commit_id
		where k.environment_id = p_environment_id and k.scope_id = (p_actor ->> 'runId')::uuid
			and k.operation_key = p_operation_key and c.id = v_proposal.apply_commit_id;
		if found then
			return jsonb_build_object('schema','qorpera.folder-commit/v1','commitId',v_commit.id,'seq',v_commit.seq,'replay',true,
				'units',v_commit.units);
		end if;
		raise exception 'Proposal is no longer open' using errcode = 'P0002';
	end if;
	if not exists (select 1 from public.qorpera_folder_reviews r where r.id = p_review_id and r.proposal_id = p_proposal_id) then
		raise exception 'This review is not of this proposal' using errcode = '22023'; end if;
	return public.qorpera_folder_commit(p_environment_id, p_actor, p_operation_key, v_proposal.units, p_review_id, p_receipt_id);
end $$;
revoke all on function public.qorpera_folder_apply_proposal(uuid, jsonb, text, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.qorpera_folder_apply_proposal(uuid, jsonb, text, uuid, uuid, uuid) to service_role;

-- A run of the proposal's agent for its member closes it: declined when `actionReviewId` names a denial of this
-- proposal's apply_proposal call (the reviewer's deny, or a member's on its card), otherwise discarded by the agent. A
-- decided proposal answers as it stands.
create function public.qorpera_folder_close_proposal(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_tool jsonb; v_run public.qorpera_execution_runs%rowtype; v_proposal public.qorpera_folder_proposals%rowtype;
	v_action public.qorpera_action_reviews%rowtype;
begin
	if jsonb_typeof(p_request) is distinct from 'object'
		or exists (select 1 from jsonb_object_keys(p_request) k where k not in ('proposalId','actionReviewId'))
		or jsonb_typeof(p_request -> 'proposalId') is distinct from 'string'
		or p_request ->> 'proposalId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		or (p_request ? 'actionReviewId' and (jsonb_typeof(p_request -> 'actionReviewId') is distinct from 'string'
			or p_request ->> 'actionReviewId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) then
		raise exception 'Proposal request is invalid' using errcode = '22023'; end if;
	-- Ranks 0 to 7 through the run's entry, then the proposal at rank 7c.
	v_tool := public.qorpera_folder_tool_run(p_binding, '[]'::jsonb);
	v_run := jsonb_populate_record(null::public.qorpera_execution_runs, v_tool -> 'run');
	select * into v_proposal from public.qorpera_folder_proposals where id = (p_request ->> 'proposalId')::uuid for no key update;
	if not found or v_proposal.environment_id <> v_run.environment_id or v_proposal.staff_agent_id <> v_run.staff_agent_id
		or v_proposal.member_user_id is distinct from v_run.requested_by_user_id then
		raise exception 'Proposal is unavailable' using errcode = 'P0002'; end if;
	if v_proposal.status = 'open' then
		if p_request ? 'actionReviewId' then
			select * into v_action from public.qorpera_action_reviews a where a.id = (p_request ->> 'actionReviewId')::uuid
				and a.profile_id = v_run.profile_id and a.staff_agent_id = v_run.staff_agent_id and a.tool_name = 'apply_proposal'
				and a.argument_sha256 = public.qorpera_folder_proposal_call_sha256(v_proposal.id)
				and (a.decision = 'deny' or a.answer = 'deny');
			if not found then raise exception 'This proposal has no denial' using errcode = '42501'; end if;
			update public.qorpera_folder_proposals set status = 'declined', units = '[]'::jsonb, decided_at = clock_timestamp(),
				decided_by = 'review', decided_by_user_id = v_action.answered_by_user_id, action_review_id = v_action.id
			where id = v_proposal.id returning * into v_proposal;
		else
			update public.qorpera_folder_proposals set status = 'discarded', units = '[]'::jsonb, decided_at = clock_timestamp(),
				decided_by = 'staff_agent'
			where id = v_proposal.id returning * into v_proposal;
		end if;
		delete from public.qorpera_folder_proposal_paths where proposal_id = v_proposal.id;
	end if;
	return jsonb_build_object('schema', 'qorpera.folder-proposal/v1', 'proposalId', v_proposal.id, 'status', v_proposal.status);
end $$;
revoke all on function public.qorpera_folder_close_proposal(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.qorpera_folder_close_proposal(jsonb, jsonb) to service_role;

-- A member discards an open proposal: the member it waits for, or an owner or admin. Rank 0 and the member's row at rank
-- 1 (KEY SHARE, qorpera_folder_mutator_role), then the proposal at rank 7c. A decided proposal answers as it stands.
create function public.qorpera_folder_member_discard_proposal(p_environment_id uuid, p_actor jsonb, p_proposal_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_profile uuid; v_role public.qorpera_profile_role; v_proposal public.qorpera_folder_proposals%rowtype;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_actor ->> 'kind' is distinct from 'member' or p_proposal_id is null then
		raise exception 'Proposal request is invalid' using errcode = '22023'; end if;
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id and core = 'folder-v2';
	if v_profile is null then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	perform 1 from public.qorpera_profiles where id = v_profile for key share;
	v_role := public.qorpera_folder_mutator_role(v_profile, p_actor);
	select * into v_proposal from public.qorpera_folder_proposals where id = p_proposal_id for no key update;
	if not found or v_proposal.environment_id <> p_environment_id then
		raise exception 'Proposal is unavailable' using errcode = 'P0002'; end if;
	if v_role not in ('owner','admin') and v_proposal.member_user_id <> (p_actor ->> 'userId')::uuid then
		raise exception 'Only the member it waits for, owners and admins discard a proposal' using errcode = '42501'; end if;
	if v_proposal.status = 'open' then
		update public.qorpera_folder_proposals set status = 'discarded', units = '[]'::jsonb, decided_at = clock_timestamp(),
			decided_by = 'member', decided_by_user_id = (p_actor ->> 'userId')::uuid
		where id = v_proposal.id returning * into v_proposal;
		delete from public.qorpera_folder_proposal_paths where proposal_id = v_proposal.id;
	end if;
	return jsonb_build_object('schema', 'qorpera.folder-proposal/v1', 'proposalId', v_proposal.id, 'status', v_proposal.status);
end $$;
revoke all on function public.qorpera_folder_member_discard_proposal(uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.qorpera_folder_member_discard_proposal(uuid, jsonb, uuid) to service_role;

-- 9. The deploy guard: every patched body carries the marker ----------------------------------------------------------

do $guard$
declare v_fn regprocedure;
begin
	foreach v_fn in array array['public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)',
			'public.qorpera_folder_object_rooted(uuid,text,uuid)', 'public.qorpera_folder_record_review(jsonb,jsonb)',
			'public.qorpera_record_action_review(jsonb,jsonb)', 'public.qorpera_folder_erase(uuid,jsonb,jsonb,text)']::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_fn), '20260930074000') = 0 then
			raise exception 'P40 did not reach %', v_fn; end if;
	end loop;
end $guard$;
