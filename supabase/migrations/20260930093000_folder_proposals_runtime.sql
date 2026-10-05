-- Folder core P40b: the runtime side of C2-R2 (deploy/first-node/RUNTIME-COMPANY-FOLDER-C2.md §8; P40a is migration
-- 20260930074000). A folder-v2 run that can raise a card lists its agent's open proposals for its member at the start of
-- the turn, and offers two tools: apply_proposal (reviewed through the gate, recorded by R1's recorder, then applied)
-- and discard_proposal. A denial of the apply closes the proposal as declined.
-- * The native host (G2) may call the run's three calls: qorpera_folder_agent_proposals and
--   qorpera_folder_apply_proposal with the folder scope (this run's environment and its run actor), and
--   qorpera_folder_close_proposal with the binding's.
-- * Observations name the two tools.
-- * The listing gives each proposal's reads, the paths it names with their authority, which the run releases with the
--   context that shows them: a revocation after the listing fences the run. It names what a new folder contains, each
--   item by path and kind, for the review to read.
-- * An apply that finds its proposal decided or erased (a member's discard after the run recorded its review) cancels
--   the call's own receipt, still executing with no commit, and answers so: the run is not fenced by it. One the discard
--   reached while it waited for the proposal committed nothing under that receipt; a retry replays that commit.
-- No table, no lock. Inert until a view saves (F3 steps 3 and 4).

set local lock_timeout = '3s';

do $$ begin if to_regprocedure('public.qorpera_folder_apply_proposal(uuid,jsonb,text,uuid,uuid,uuid)') is null then
	raise exception 'P40b requires migration 20260930074000_folder_proposals'; end if; end $$;

create function pg_temp.p40b_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'P40b anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- The native host may call the three for its job's run (G2-1's scopes).
insert into public.qorpera_native_host_calls(name, scope) values
	('qorpera_folder_agent_proposals', 'folder'),
	('qorpera_folder_apply_proposal', 'folder'),
	('qorpera_folder_close_proposal', 'binding');

-- Observations name the two tools, after the company's accounts.
select pg_temp.p40b_replace('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$'company_search','company_account',$old$,
	$new$'company_search','company_account','apply_proposal','discard_proposal',$new$);

-- A listed proposal's reads: each path it names (qorpera_folder_proposal_paths) with the authority its listing was decided
-- on, as qorpera_folder_record_release takes them. The run releases them with the context that shows them, so a grant
-- revoked after the listing fences the run as for a file it read. Decided in the listing's snapshot.
create function public.qorpera_folder_proposal_reads(p_environment_id uuid, p_profile_id uuid, p_auth jsonb,
	p_proposal_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
	select coalesce(jsonb_agg(jsonb_build_object('path', d.path, 'authority', d.receipt) order by d.path), '[]'::jsonb)
	from public.qorpera_folder_paths_authority(p_environment_id, p_profile_id, p_auth,
		array(select distinct q.path from public.qorpera_folder_proposal_paths q where q.proposal_id = p_proposal_id)) d
$$;
revoke all on function public.qorpera_folder_proposal_reads(uuid, uuid, jsonb, uuid)
	from public, anon, authenticated, service_role;

select pg_temp.p40b_replace('public.qorpera_folder_agent_proposals(uuid,jsonb,jsonb)'::regprocedure,
	$old$'moreUnits', greatest(jsonb_array_length((v_rows[i]).units) - c_units, 0)) order by i)$old$,
	$new$'moreUnits', greatest(jsonb_array_length((v_rows[i]).units) - c_units, 0),
				-- 20260930093000 (P40b): what the run releases with the context that shows it.
				'reads', public.qorpera_folder_proposal_reads(p_environment_id, v_run.profile_id, v_auth, (v_rows[i]).id))
				order by i)$new$);
-- What a new folder contains, each item by its path row (items 1 and up) and kind (a file has a manifest): the review
-- reads every path an apply would make, where the structured files alone come with their parses.
select pg_temp.p40b_replace('public.qorpera_folder_agent_proposals(uuid,jsonb,jsonb)'::regprocedure,
	$old$'items', case when u.v ->> 'op' = 'new_folder' then jsonb_array_length(u.v -> 'contents') end,$old$,
	$new$'items', case when u.v ->> 'op' = 'new_folder' then jsonb_array_length(u.v -> 'contents') end,
						-- 20260930093000 (P40b)
						'contains', case when u.v ->> 'op' = 'new_folder' then (select jsonb_agg(jsonb_build_object('path', q.path,
								'kind', case when q.manifest_sha256 is null then 'folder' else 'file' end) order by q.item_no)
							from public.qorpera_folder_proposal_paths q
							where q.proposal_id = (v_rows[i]).id and q.unit_no = u.o and q.item_no >= 1) end,$new$);

drop function pg_temp.p40b_replace(regprocedure, text, text);

-- P40a's apply, and its answer when the proposal is no longer open and no commit of this key applied it: the runtime
-- recorded the review before the call's receipt, so a member's discard (or an erasure) can land between the two. The
-- receipt, the run's own for this proposal's apply, is then still executing with no commit, and nothing will apply under
-- it: it is cancelled here under its lock (the commit's, FOR NO KEY UPDATE, rank C1C §5.7, taken alone), and the
-- answer says what the proposal is. A retry with the same receipt answers the same. A discard that lands while the apply
-- waits for the proposal leaves a commit of this key that applied nothing and carries the receipt: a retry replays it.
create or replace function public.qorpera_folder_apply_proposal(p_environment_id uuid, p_actor jsonb, p_operation_key text,
	p_proposal_id uuid, p_review_id uuid, p_receipt_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_proposal public.qorpera_folder_proposals%rowtype; v_commit public.qorpera_folder_commits%rowtype;
	v_receipt public.qorpera_run_operation_receipts%rowtype;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_actor ->> 'kind' is distinct from 'run'
		or coalesce(p_actor ->> 'runId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		or p_proposal_id is null or p_review_id is null then
		raise exception 'Proposal apply is invalid' using errcode = '22023'; end if;
	select * into v_proposal from public.qorpera_folder_proposals where id = p_proposal_id and environment_id = p_environment_id;
	if found and v_proposal.status = 'open' then
		if not exists (select 1 from public.qorpera_folder_reviews r where r.id = p_review_id and r.proposal_id = p_proposal_id) then
			raise exception 'This review is not of this proposal' using errcode = '22023'; end if;
		return public.qorpera_folder_commit(p_environment_id, p_actor, p_operation_key, v_proposal.units, p_review_id,
			p_receipt_id);
	end if;
	-- The commit of this key that applied the proposal, or (20260930093000, P40b) the one that carries this call's receipt
	-- and applied nothing: a discard or an erasure reached the proposal while the apply waited for it.
	select c.* into v_commit from public.qorpera_folder_operation_keys k
	join public.qorpera_folder_commits c on c.id = k.commit_id
	where k.environment_id = p_environment_id and k.scope_id = (p_actor ->> 'runId')::uuid
		and k.operation_key = p_operation_key
		and (c.id = v_proposal.apply_commit_id or (c.proposal_id is null and c.receipt_id = p_receipt_id));
	if found then
		-- The same request only: the review and the receipt the apply was made with (the commit's own digest covered its
		-- units, which the decided proposal no longer keeps). A commit that applied nothing names no review: the receipt,
		-- this run's for this proposal's apply, stands for the request.
		if v_commit.receipt_id is distinct from p_receipt_id
			or (v_commit.proposal_id is not null and v_proposal.review_id is distinct from p_review_id)
			or (v_commit.proposal_id is null and not exists (select 1 from public.qorpera_run_operation_receipts r
				where r.id = p_receipt_id and r.run_id = (p_actor ->> 'runId')::uuid
					and r.logical_operation_key = 'apply_proposal:apply:' || p_proposal_id::text)) then
			raise exception 'Operation key was used for a different change set' using errcode = '22023'; end if;
		return jsonb_build_object('schema','qorpera.folder-commit/v1','commitId',v_commit.id,'seq',v_commit.seq,'replay',true,
			'units',v_commit.units);
	end if;
	-- 20260930093000 (P40b): decided or erased before this apply reached it. A decided proposal never opens again, so the
	-- status read without a lock stands.
	if p_receipt_id is not null then
		select * into v_receipt from public.qorpera_run_operation_receipts where id = p_receipt_id for no key update;
		if found and v_receipt.run_id = (p_actor ->> 'runId')::uuid
			and v_receipt.logical_operation_key = 'apply_proposal:apply:' || p_proposal_id::text
			and v_receipt.requires_company_revision and v_receipt.status in ('executing', 'cancelled')
			and not exists (select 1 from public.qorpera_folder_commits c where c.receipt_id = p_receipt_id) then
			if v_receipt.status = 'executing' then
				update public.qorpera_run_operation_receipts set status = 'cancelled', completed_at = clock_timestamp()
				where id = p_receipt_id;
			end if;
			return jsonb_build_object('schema', 'qorpera.folder-proposal-unapplied/v1', 'proposalId', p_proposal_id,
				'status', coalesce(v_proposal.status, 'erased'), 'receiptId', p_receipt_id);
		end if;
	end if;
	if v_proposal.id is null then raise exception 'Proposal is unavailable' using errcode = 'P0002'; end if;
	raise exception 'Proposal is no longer open' using errcode = 'P0002';
end $$;
revoke all on function public.qorpera_folder_apply_proposal(uuid, jsonb, text, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.qorpera_folder_apply_proposal(uuid, jsonb, text, uuid, uuid, uuid) to service_role;

do $guard$
begin
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure),
		'''discard_proposal''') = 0 then
		raise exception 'P40b did not reach the observation vocabulary'; end if;
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_folder_agent_proposals(uuid,jsonb,jsonb)'::regprocedure),
		'qorpera_folder_proposal_reads') = 0
		or strpos((select prosrc from pg_proc where oid = 'public.qorpera_folder_agent_proposals(uuid,jsonb,jsonb)'::regprocedure),
			'''contains''') = 0 then
		raise exception 'P40b did not reach the proposal listing'; end if;
end $guard$;
