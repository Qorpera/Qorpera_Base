-- Company folder core, C1c-2b part 1: a folder-v2 run's operation receipts and the commits that satisfy them
-- (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §5.6, §5.7).
--
-- Changes only folder-v2 behaviour; no real folder-v2 run exists yet (C1C §7).
-- * A folder-v2 tool call's receipt begins and completes on the folder fence: the run check (C1c-2a's run mutex, the
--   job and fence KEY SHARE, the ranks, the plain lease checks), then the receipt row. No broker job FOR UPDATE, no gc
--   fence. qorpera_begin_native_tool_operation and _complete_native_tool_operation dispatch to the folder bodies in
--   place of C1c-2a's interim refusal; the runner broker's direct receipt calls keep refusing (C1C §5.4).
-- * A receipt that "requires a company revision" is satisfied by a folder commit that carries it. The commit takes an
--   optional receipt id (part of its request digest), locks the receipt FOR NO KEY UPDATE as a run-owned row, checks
--   it is the run's own, executing and requiring a revision, and records it. One commit per receipt, whatever its
--   units' outcomes: a receipt another commit satisfied refuses with 22023, so a writer's conflict redo takes a new
--   receipt (decided on #548). Completion names the commit.
-- * The commit accepts session targets from the structured-file hook (rank 11: sessions FOR UPDATE, in id order,
--   after rank 10's recheck and before any session write), so F2's triggers that write an agent's thread, its pair
--   sessions or a group chat's session find those sessions already held (C1C §5.6 "Sessions and the operation clock").

-- 1. Schema --------------------------------------------------------------------------------------------------------

-- The commit's receipt column exists since C1a, unused. One commit per receipt; completion records the commit.
alter table public.qorpera_folder_commits
	add constraint qorpera_folder_commits_receipt_id_fkey foreign key (receipt_id)
		references public.qorpera_run_operation_receipts(id) on delete set null;
create unique index qorpera_folder_commits_one_per_receipt on public.qorpera_folder_commits(receipt_id)
	where receipt_id is not null;
-- The receipts table is busy: the new column is added without a default (no rewrite), and its constraints NOT VALID,
-- since every existing row holds null there (they still hold for every new or changed row).
alter table public.qorpera_run_operation_receipts add column folder_commit_id uuid;
alter table public.qorpera_run_operation_receipts
	add constraint qorpera_run_operation_receipts_folder_commit_id_fkey foreign key (folder_commit_id)
		references public.qorpera_folder_commits(id) on delete set null not valid,
	add constraint qorpera_run_operation_receipts_folder_commit check (folder_commit_id is null
		or (output_snapshot_id is null and proposal_id is null and company_path_proposal_id is null)) not valid;

-- 2. Patch helpers (names unique to this migration: pg_temp lives for the whole session) ------------------------

create function pg_temp.c1c2b_replace(p_target regprocedure, p_old text, p_new text, p_count integer) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'C1c-2b patch anchor not found % time(s) in %', p_count, p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 3. Sessions a commit writes (rank 11) ----------------------------------------------------------------------------

-- The sessions a change set's hook names, FOR UPDATE in id order. They come after rank 10's recheck and before the
-- commit's first session write (the triggers of its apply step), and so before the operation clock: after its first
-- session write a transaction locks no further session (C1C §5.6). A required session that is gone refuses.
create function public.qorpera_folder_lock_sessions(p_environment_id uuid, p_targets jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[]; v_required uuid[]; v_locked uuid[];
begin
	select coalesce(array_agg(distinct (t ->> 'key')::uuid), '{}'),
		coalesce(array_agg(distinct (t ->> 'key')::uuid) filter (where coalesce((t ->> 'required')::boolean, false)), '{}')
	into v_ids, v_required
	from jsonb_array_elements(coalesce(p_targets, '[]'::jsonb)) t where t ->> 'rank' = '11';
	if cardinality(v_ids) = 0 then return; end if;
	if exists (select 1 from public.qorpera_shared_sessions where id = any (v_ids) and environment_id <> p_environment_id) then
		raise exception 'A session target belongs to another company' using errcode = 'XX000'; end if;
	select coalesce(array_agg(id), '{}') into v_locked from (select s.id from public.qorpera_shared_sessions s
		where s.id = any (v_ids) and s.environment_id = p_environment_id order by s.id for update) locked;
	if exists (select 1 from unnest(v_required) r(id) where not (r.id = any (v_locked))) then
		raise exception 'A session this change set relies on is unavailable' using errcode = '42501'; end if;
end $$;

-- 4. The commit takes a receipt and session targets ----------------------------------------------------------------

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid)'::regprocedure);
	v_pair text;
begin
	-- Replaces exact text exactly once.
	for v_pair in select unnest(array[
		-- The receipt parameter: the five-argument function is replaced, never overloaded (PostgREST would find both).
		'p_review_id uuid DEFAULT NULL::uuid)' || chr(1) || 'p_review_id uuid DEFAULT NULL::uuid, p_receipt_id uuid DEFAULT NULL::uuid)',
		E'v_request_sha text; v_commit_id uuid := extensions.gen_random_uuid(); v_existing record;' || chr(1)
			|| E'v_request_sha text; v_commit_id uuid := extensions.gen_random_uuid(); v_existing record;\n\tv_receipt public.qorpera_run_operation_receipts%rowtype;',
		-- Only a run's tool call has a receipt.
		E'\tif p_operation_key is null or p_operation_key !~ ''^[A-Za-z0-9._:-]{8,200}$'' then' || chr(1)
			|| E'\tif p_receipt_id is not null and v_actor_kind <> ''run'' then\n'
			|| E'\t\traise exception ''Only a run carries a receipt'' using errcode = ''22023''; end if;\n'
			|| E'\tif p_operation_key is null or p_operation_key !~ ''^[A-Za-z0-9._:-]{8,200}$'' then',
		-- The receipt is part of the request digest; a request without one keeps today's digest.
		E'\t-- review id is part of it: a retry with another review is another change set.\n' || chr(1)
			|| E'\t-- review id is part of it: a retry with another review is another change set. So is a receipt id (C1C §5.6).\n',
		E'\tv_request_sha := encode(extensions.digest(convert_to((case when p_review_id is null then jsonb_build_array(v_digest_actor, p_units)\n'
			|| E'\t\telse jsonb_build_array(v_digest_actor, p_units, p_review_id) end)::text, ''utf8''), ''sha256''), ''hex'');' || chr(1)
			|| E'\tv_request_sha := encode(extensions.digest(convert_to((case when p_review_id is null and p_receipt_id is null\n'
			|| E'\t\t\tthen jsonb_build_array(v_digest_actor, p_units)\n'
			|| E'\t\twhen p_receipt_id is null then jsonb_build_array(v_digest_actor, p_units, p_review_id)\n'
			|| E'\t\telse jsonb_build_array(v_digest_actor, p_units, p_review_id, p_receipt_id) end)::text, ''utf8''), ''sha256''), ''hex'');',
		-- Session targets: rank 11, sessions only, FOR UPDATE.
		E'\t-- Every target names a rank 0-9, a table, a key and a known mode; anything else is a defect, never a silent skip.' || chr(1)
			|| E'\t-- Every target names a rank 0-9 (or 11: a session the apply step writes, FOR UPDATE only), a table, a key and a\n'
			|| E'\t-- known mode; anything else is a defect, never a silent skip.',
		E'\t\twhere jsonb_typeof(t) <> ''object'' or coalesce(t ->> ''rank'', '''') !~ ''^[0-9]$'' or t ->> ''tbl'' is null or t ->> ''key'' is null' || chr(1)
			|| E'\t\twhere jsonb_typeof(t) <> ''object'' or coalesce(t ->> ''rank'', '''') !~ ''^([0-9]|11)$'' or t ->> ''tbl'' is null or t ->> ''key'' is null\n'
			|| E'\t\t\tor (t ->> ''rank'' = ''11'') <> (t ->> ''tbl'' = ''qorpera_shared_sessions'')\n'
			|| E'\t\t\tor (t ->> ''rank'' = ''11'' and (t ->> ''mode'' <> ''update''\n'
			|| E'\t\t\t\tor coalesce(t ->> ''key'', '''') !~ ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''))',
		-- A session the apply step writes inserts company operations (a foreign key on this company's row): with rank 11
		-- targets, this company's row comes first, at rank 0, whatever the hook named (legacy posting takes the company row
		-- FOR UPDATE, then the session).
		E'\tperform public.qorpera_folder_structured_lock(p_environment_id, v_targets, 0::smallint, 0::smallint);' || chr(1)
			|| E'\tif exists (select 1 from jsonb_array_elements(v_targets) t where t ->> ''rank'' = ''11'') then\n'
			|| E'\t\tv_targets := v_targets || jsonb_build_array(jsonb_build_object(''rank'', 0, ''tbl'', ''qorpera_profiles'',\n'
			|| E'\t\t\t''key'', v_file.profile_id::text, ''mode'', ''keyshare'', ''required'', true));\n'
			|| E'\tend if;\n'
			|| E'\tperform public.qorpera_folder_structured_lock(p_environment_id, v_targets, 0::smallint, 0::smallint);',
		-- The receipt, a run-owned row, after ranks 8 and 9 and before rank 10 (C1C §5.7).
		E'\t-- Rank 10: a run''s released reads still hold (C1B-2 §3).' || chr(1)
			|| E'\t-- Run-owned rows (C1C §5.7): the tool call''s receipt, FOR NO KEY UPDATE. It must be this run''s own, executing and\n'
			|| E'\t-- requiring a revision. One commit per receipt, whatever its outcomes: a receipt another commit satisfied refuses\n'
			|| E'\t-- (a writer''s redo takes a new receipt); a replay of this commit was answered at step 0.\n'
			|| E'\tif p_receipt_id is not null then\n'
			|| E'\t\tselect * into v_receipt from public.qorpera_run_operation_receipts where id = p_receipt_id for no key update;\n'
			|| E'\t\tif not found or v_receipt.run_id is distinct from (p_actor ->> ''runId'')::uuid then\n'
			|| E'\t\t\traise exception ''Run receipt is unavailable'' using errcode = ''42501''; end if;\n'
			|| E'\t\t-- Before its status: a receipt completed with its commit is still "satisfied" (a redo reusing it is a defect).\n'
			|| E'\t\tif exists (select 1 from public.qorpera_folder_commits where receipt_id = p_receipt_id) then\n'
			|| E'\t\t\traise exception ''Run receipt is already satisfied by another commit'' using errcode = ''22023''; end if;\n'
			|| E'\t\tif v_receipt.status <> ''executing'' or not v_receipt.requires_company_revision then\n'
			|| E'\t\t\traise exception ''Run receipt is unavailable'' using errcode = ''42501''; end if;\n'
			|| E'\tend if;\n\n'
			|| E'\t-- Rank 10: a run''s released reads still hold (C1B-2 §3).',
		-- The sessions, after rank 10 and before the paths and the apply step's session writes.
		E'\t-- Step 5. Paths, in one increasing key order.' || chr(1)
			|| E'\t-- Rank 11: the sessions the apply step writes (the hook''s), FOR UPDATE in id order (C1C §5.6).\n'
			|| E'\tperform public.qorpera_folder_lock_sessions(p_environment_id, v_targets);\n\n'
			|| E'\t-- Step 5. Paths, in one increasing key order.',
		-- The commit records its receipt.
		E'\t\tprovider_connection_id, runtime_bundle_id, units, as_of_seq, view_id, view_kind, turn_run_id)' || chr(1)
			|| E'\t\tprovider_connection_id, runtime_bundle_id, units, as_of_seq, view_id, view_kind, turn_run_id, receipt_id)',
		E'\t\tv_view.id, v_view.kind, v_turn_run);' || chr(1) || E'\t\tv_view.id, v_view.kind, v_turn_run, p_receipt_id);'
	]) loop
		if (length(v_definition) - length(replace(v_definition, split_part(v_pair, chr(1), 1), '')))
				/ length(split_part(v_pair, chr(1), 1)) <> 1 then
			raise exception 'C1c-2b commit anchor not found once: %', left(split_part(v_pair, chr(1), 1), 80); end if;
		v_definition := replace(v_definition, split_part(v_pair, chr(1), 1), split_part(v_pair, chr(1), 2));
	end loop;
	drop function public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid);
	execute v_definition;
end $$;
-- The same grants as the function it replaces: the runtime (service role) only.
revoke all on function public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid) from public, anon, authenticated;
grant execute on function public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid) to service_role;

-- 5. Folder receipts -----------------------------------------------------------------------------------------------

-- Begins a folder-v2 tool call's operation receipt: the run check, the wake's work gate, then the receipt, under the run
-- mutex, which orders "one unresolved operation per run" and the budget count. A replay of the same logical operation
-- returns its receipt; the same key for other work refuses (23505), as the legacy receipt does.
create function public.qorpera_folder_begin_run_receipt(p_binding jsonb, p_receipt_id uuid, p_logical_operation_key text,
	p_input_sha256 text, p_downstream_idempotency_sha256 text, p_requires_company_revision boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_receipt public.qorpera_run_operation_receipts%rowtype;
begin
	v_run := jsonb_populate_record(null::public.qorpera_execution_runs, public.qorpera_folder_tool_run(p_binding, '[]'::jsonb) -> 'run');
	-- No governed effect before a required acknowledgement or after the final report (contract 7.1).
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	-- The legacy codes: a missing argument is invalid (22023); a malformed one refuses the operation (42501).
	if p_input_sha256 is null or p_downstream_idempotency_sha256 is null or p_requires_company_revision is null then
		raise exception 'native tool operation is invalid' using errcode = '22023'; end if;
	if p_receipt_id is null or char_length(btrim(coalesce(p_logical_operation_key, ''))) not between 1 and 256
		or p_input_sha256 !~ '^[0-9a-f]{64}$' or p_downstream_idempotency_sha256 !~ '^[0-9a-f]{64}$' then
		raise exception 'run operation authority is invalid' using errcode = '42501'; end if;
	select * into v_receipt from public.qorpera_run_operation_receipts
	where run_id = v_run.id and logical_operation_key = btrim(p_logical_operation_key) for update;
	if found then
		if v_receipt.operation_kind <> 'cloud_tool' or v_receipt.input_sha256 <> p_input_sha256
			or v_receipt.downstream_idempotency_sha256 <> p_downstream_idempotency_sha256
			or v_receipt.requires_company_revision <> p_requires_company_revision then
			raise exception 'logical operation key is already bound to other work' using errcode = '23505'; end if;
		return jsonb_build_object('state', v_receipt.status, 'receipt_id', v_receipt.id, 'result', v_receipt.result,
			'output_snapshot_id', v_receipt.output_snapshot_id, 'proposal_id', v_receipt.proposal_id,
			'folder_commit_id', v_receipt.folder_commit_id, 'run_id', v_run.id);
	end if;
	if exists (select 1 from public.qorpera_run_operation_receipts
		where run_id = v_run.id and status in ('executing', 'ambiguous')) then
		raise exception 'run has an unresolved operation' using errcode = '55000'; end if;
	-- The budget row is the run mutex, already held.
	update public.qorpera_execution_run_budgets set operation_count = operation_count + 1 where run_id = v_run.id;
	if not found then raise exception 'run operation budget is exhausted' using errcode = '55000'; end if;
	insert into public.qorpera_run_operation_receipts(id, run_id, job_id, assignment_id, logical_operation_key, operation_kind,
		input_sha256, downstream_idempotency_sha256, requires_company_revision)
	values (p_receipt_id, v_run.id, v_run.job_id, (p_binding ->> 'assignmentId')::uuid, btrim(p_logical_operation_key), 'cloud_tool',
		p_input_sha256, p_downstream_idempotency_sha256, p_requires_company_revision)
	returning * into v_receipt;
	return jsonb_build_object('state', 'executing', 'receipt_id', v_receipt.id, 'run_id', v_run.id);
end $$;

-- Completes a folder-v2 tool call's receipt. A receipt that requires a company revision names the folder commit that
-- carried it: the commit exists, is this run's, and carries this receipt. Whatever the commit's unit outcomes, it
-- satisfies the receipt; the run's disposition comes from the outcomes (C1c-2c). A replay with the same result and
-- commit returns the receipt; a different one refuses (23505).
create function public.qorpera_folder_complete_run_receipt(p_binding jsonb, p_receipt_id uuid, p_input_sha256 text,
	p_result jsonb, p_folder_commit_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_receipt public.qorpera_run_operation_receipts%rowtype;
begin
	v_run := jsonb_populate_record(null::public.qorpera_execution_runs, public.qorpera_folder_tool_run(p_binding, '[]'::jsonb) -> 'run');
	if p_input_sha256 is null or jsonb_typeof(p_result) is distinct from 'object' or pg_column_size(p_result) > 65536 then
		raise exception 'native tool completion is invalid' using errcode = '22023'; end if;
	select * into v_receipt from public.qorpera_run_operation_receipts where id = p_receipt_id and run_id = v_run.id for update;
	if not found or v_receipt.job_id <> v_run.job_id or v_receipt.assignment_id <> (p_binding ->> 'assignmentId')::uuid
		or v_receipt.input_sha256 <> p_input_sha256 then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'run operation receipt is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	if v_receipt.status = 'completed' then
		if v_receipt.result <> p_result or v_receipt.folder_commit_id is distinct from p_folder_commit_id then
			raise exception 'run operation completion replay differs' using errcode = '23505'; end if;
		return jsonb_build_object('state', 'completed', 'receipt_id', v_receipt.id, 'result', v_receipt.result,
			'folder_commit_id', v_receipt.folder_commit_id, 'run_id', v_run.id);
	end if;
	if v_receipt.status <> 'executing' then
		raise exception 'run operation requires recovery review' using errcode = '55000'; end if;
	if v_receipt.requires_company_revision and p_folder_commit_id is null then
		raise exception 'Company folder operation has no commit' using errcode = '55000'; end if;
	if p_folder_commit_id is not null and not exists (select 1 from public.qorpera_folder_commits
		where id = p_folder_commit_id and run_id = v_run.id and receipt_id = v_receipt.id) then
		raise exception 'Company folder commit does not carry this receipt' using errcode = '55000'; end if;
	update public.qorpera_run_operation_receipts
	set status = 'completed', result = p_result, folder_commit_id = p_folder_commit_id, completed_at = statement_timestamp()
	where id = v_receipt.id returning * into v_receipt;
	return jsonb_build_object('state', 'completed', 'receipt_id', v_receipt.id, 'result', v_receipt.result,
		'folder_commit_id', v_receipt.folder_commit_id, 'run_id', v_run.id);
end $$;

revoke all on function public.qorpera_folder_lock_sessions(uuid,jsonb),
	public.qorpera_folder_begin_run_receipt(jsonb,uuid,text,text,text,boolean),
	public.qorpera_folder_complete_run_receipt(jsonb,uuid,text,jsonb,uuid)
	from public, anon, authenticated, service_role;
-- The runtime completes a folder writer's receipt with its commit directly; the legacy completion has no commit id.
grant execute on function public.qorpera_folder_complete_run_receipt(jsonb,uuid,text,jsonb,uuid) to service_role;

-- 6. Dispatch in place of C1c-2a's interim refusals ----------------------------------------------------------------

do $$
declare c_refused constant text := 'if public.qorpera_binding_is_folder_v2(p_binding) then raise exception ''This Company File path does not serve folder-v2 companies'' using errcode = ''0A000''; end if;';
begin
	perform pg_temp.c1c2b_replace('public.qorpera_begin_native_tool_operation(jsonb,uuid,text,text,text,boolean)', c_refused,
		'if public.qorpera_binding_is_folder_v2(p_binding) then return public.qorpera_folder_begin_run_receipt(p_binding, p_receipt_id, '
		|| 'p_logical_operation_key, p_input_sha256, p_downstream_idempotency_sha256, p_requires_company_revision); end if;', 1);
	-- The legacy completion names a snapshot or a proposal, never a folder commit: folder-v2 takes none, and a writer
	-- whose receipt requires a revision completes it through qorpera_folder_complete_run_receipt with its commit.
	perform pg_temp.c1c2b_replace('public.qorpera_complete_native_tool_operation(jsonb,uuid,text,jsonb,uuid,uuid)', c_refused,
		'if public.qorpera_binding_is_folder_v2(p_binding) then if p_output_snapshot_id is not null or p_proposal_id is not null then '
		|| 'raise exception ''A folder-v2 operation completes with its folder commit'' using errcode = ''22023''; end if; '
		|| 'return public.qorpera_folder_complete_run_receipt(p_binding, p_receipt_id, p_input_sha256, p_result, null); end if;', 1);
end $$;
