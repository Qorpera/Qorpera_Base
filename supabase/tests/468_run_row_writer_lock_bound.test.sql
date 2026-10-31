-- @fixture 467_run_row_read_lock_bound.test.sql until "-- 2. statement_timeout set inside a function"
-- 20260930541000 (item 7) on 467's committed fixture: 924's real native run of Alice's, its native start recorded and its
-- wake acknowledged, the holder and caller connections and 467's helpers. A tool call's receipt begin and finish
-- (qorpera_folder_begin_run_receipt and qorpera_folder_complete_run_receipt, which the legacy native begin and finish
-- hand every call to) wait at most 3 s for the run's budget row (the run mutex). The holder makes the context read
-- through the native host and sleeps holding the row; the caller begins or finishes a receipt through the same entry
-- point (8 s statement budget, 8 s lock_timeout) and gives up with 55P03 after about 3 s while the holder still holds the
-- row. Its transaction has ended by the answer, and the receipt is as it was. With the row free the same calls answer,
-- and a repeat of each answers the same receipt again, as the runtime asks them again (cloud-native-tool-operations.ts).
-- The timings are printed too.

-- 1. The begin and the finish carry lock_timeout 3s beside their search_path; the legacy native begin and finish that
--    hand calls to them keep theirs (467 checks the run check and the entry points). Their grants are as before: the
--    begin is the owner's only, the finish the platform service caller's.
do $$
declare v_config text[]; v_expected text[]; v_fn regprocedure; v_wrong text[] := '{}';
begin
	for v_fn, v_expected in select * from (values
		('public.qorpera_folder_begin_run_receipt(jsonb,uuid,text,text,text,boolean)'::regprocedure,
			array['search_path=""', 'lock_timeout=3s']),
		('public.qorpera_folder_complete_run_receipt(jsonb,uuid,text,jsonb,uuid)'::regprocedure,
			array['search_path=""', 'lock_timeout=3s']),
		('public.qorpera_begin_native_tool_operation(jsonb,uuid,text,text,text,boolean)'::regprocedure, array['search_path=""']),
		('public.qorpera_complete_native_tool_operation(jsonb,uuid,text,jsonb,uuid,uuid)'::regprocedure,
			array['search_path=""'])) as setting(fn, expected) loop
		select p.proconfig into v_config from pg_catalog.pg_proc as p where p.oid = v_fn;
		if not (coalesce(v_config, '{}') @> v_expected and coalesce(v_config, '{}') <@ v_expected) then
			v_wrong := v_wrong || format('%s sets %s', v_fn, v_config); end if;
	end loop;
	if exists (select 1 from unnest(array['public', 'anon', 'authenticated', 'service_role']) as r(name)
			where has_function_privilege(r.name, 'public.qorpera_folder_begin_run_receipt(jsonb,uuid,text,text,text,boolean)', 'execute'))
		or exists (select 1 from unnest(array['public', 'anon', 'authenticated']) as r(name)
			where has_function_privilege(r.name, 'public.qorpera_folder_complete_run_receipt(jsonb,uuid,text,jsonb,uuid)', 'execute'))
		or not has_function_privilege('service_role', 'public.qorpera_folder_complete_run_receipt(jsonb,uuid,text,jsonb,uuid)', 'execute') then
		v_wrong := v_wrong || 'the grants changed'::text; end if;
	if cardinality(v_wrong) > 0 then raise exception 'The run-row writers are not as expected: %', v_wrong; end if;
end $$;

-- The receipt the caller begins and finishes, as the runtime sends them: the begin's six arguments, the finish's four
-- (no folder commit, so both finishes take it).
create function pg_temp.rw_receipt() returns uuid language sql as $$ select '46800000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.rw_begin_args() returns jsonb language sql as $$
	select jsonb_build_object('p_binding', current_setting('qorpera_test.base_binding')::jsonb, 'p_receipt_id', pg_temp.rw_receipt(),
		'p_logical_operation_key', 'rw468-operation', 'p_input_sha256', repeat('a', 64),
		'p_downstream_idempotency_sha256', repeat('b', 64), 'p_requires_company_revision', false)
$$;
create function pg_temp.rw_finish_args() returns jsonb language sql as $$
	select jsonb_build_object('p_binding', current_setting('qorpera_test.base_binding')::jsonb, 'p_receipt_id', pg_temp.rw_receipt(),
		'p_input_sha256', repeat('a', 64), 'p_result', '{"rw468": "done"}'::jsonb)
$$;
-- The receipt's status as other connections see it, or null when there is none.
create function pg_temp.rw_status() returns text language sql as $$
	select receipt.status from public.qorpera_run_operation_receipts as receipt where receipt.id = pg_temp.rw_receipt()
$$;
-- p_name through the native host's standard entry point while the holder holds the run's row (its context read, then a
-- 6 s sleep): the caller's outcome, and whether the holder still held the row at the answer.
create function pg_temp.rw_held(p_name text, p_args jsonb) returns jsonb language plpgsql as $$
declare v_held jsonb; v_outcome jsonb;
begin
	v_held := pg_temp.rr_hold('qorpera_native_host_call', 'qorpera_assert_company_path_reads', pg_temp.rr_context_args(), 6);
	v_outcome := pg_temp.rr_host('qorpera_native_host_call', p_name, p_args);
	return v_outcome || jsonb_build_object('held', v_held, 'holding', pg_temp.rr_release());
end $$;
-- Whether a held call gave up on the row within its bound: 55P03 after about 3 s, having waited for the holder, which
-- still held the row; by the answer the caller is idle, holds and waits for no lock, and no one blocks it.
create function pg_temp.rw_gave_up(p_outcome jsonb) returns boolean language sql as $$
	select p_outcome -> 'held' = '{"answer": null}'::jsonb and p_outcome ->> 'state' = '55P03'
		and (p_outcome ->> 'waited')::boolean and (p_outcome ->> 'ms')::numeric between 2950 and 4500
		and (p_outcome ->> 'holding')::boolean
		and p_outcome -> 'after' = '{"state": "idle", "transaction": false, "locks": 0, "blockers": 0}'::jsonb
$$;

-- 2. The begin, while the row is held: the caller gives up after about 3 s (the begin's own lock_timeout) and begins
--    no receipt.
do $$
declare v_outcome jsonb := pg_temp.rw_held('qorpera_begin_native_tool_operation', pg_temp.rw_begin_args());
begin
	perform set_config('qorpera_test.rw_begin', format('%s after %s ms', v_outcome ->> 'state', v_outcome ->> 'ms'), false);
	if not coalesce(pg_temp.rw_gave_up(v_outcome), false) or pg_temp.rw_status() is not null then
		raise exception 'The begin did not give up on the held row within its bound: %, receipt %', v_outcome, pg_temp.rw_status(); end if;
end $$;

-- 3. With the row free, the same begin answers without waiting, and so does a repeat: a copy that did begin answers by
--    its key with the same receipt, still executing.
do $$
declare v_run text := current_setting('qorpera_test.base_binding')::jsonb ->> 'runId'; v_begun jsonb; v_again jsonb;
begin
	v_begun := pg_temp.rr_host('qorpera_native_host_call', 'qorpera_begin_native_tool_operation', pg_temp.rw_begin_args());
	v_again := pg_temp.rr_host('qorpera_native_host_call', 'qorpera_begin_native_tool_operation', pg_temp.rw_begin_args());
	if v_begun -> 'result' is distinct from jsonb_build_object('state', 'executing', 'receipt_id', pg_temp.rw_receipt(), 'run_id', v_run)
		or (v_begun ->> 'waited')::boolean
		or v_again -> 'result' is distinct from jsonb_build_object('state', 'executing', 'receipt_id', pg_temp.rw_receipt(),
			'result', null, 'output_snapshot_id', null, 'proposal_id', null, 'folder_commit_id', null, 'run_id', v_run)
		or (v_again ->> 'waited')::boolean or pg_temp.rw_status() is distinct from 'executing' then
		raise exception 'The begin did not answer with the row free: %, again %', v_begun, v_again; end if;
end $$;

-- 4. The finish, while the row is held, both ways the runtime sends it: the legacy native finish, and the folder core's
--    by name (which a finish with a folder commit takes). Each gives up after about 3 s (the finish's own lock_timeout),
--    and the receipt is still executing.
do $$
declare v_name text; v_outcome jsonb; v_seen text[] := '{}';
begin
	foreach v_name in array array['qorpera_complete_native_tool_operation', 'qorpera_folder_complete_run_receipt'] loop
		v_outcome := pg_temp.rw_held(v_name, pg_temp.rw_finish_args());
		v_seen := v_seen || format('%s: %s after %s ms', v_name, v_outcome ->> 'state', v_outcome ->> 'ms');
		if not coalesce(pg_temp.rw_gave_up(v_outcome), false) or pg_temp.rw_status() is distinct from 'executing' then
			raise exception 'The finish (%) did not give up on the held row within its bound: %, receipt %',
				v_name, v_outcome, pg_temp.rw_status(); end if;
	end loop;
	perform set_config('qorpera_test.rw_finish', array_to_string(v_seen, '; '), false);
end $$;

-- 5. With the row free, the finish answers without waiting, and so does a repeat of each call: the finish both ways with
--    the same result answers it again, and the begin by its key answers the finished receipt.
do $$
declare v_run text := current_setting('qorpera_test.base_binding')::jsonb ->> 'runId'; v_finished jsonb; v_name text;
	v_outcome jsonb; v_wrong text[] := '{}';
begin
	v_finished := jsonb_build_object('state', 'completed', 'receipt_id', pg_temp.rw_receipt(), 'result', '{"rw468": "done"}'::jsonb,
		'folder_commit_id', null, 'run_id', v_run);
	foreach v_name in array array['qorpera_complete_native_tool_operation', 'qorpera_complete_native_tool_operation',
		'qorpera_folder_complete_run_receipt'] loop
		v_outcome := pg_temp.rr_host('qorpera_native_host_call', v_name, pg_temp.rw_finish_args());
		if v_outcome -> 'result' is distinct from v_finished or (v_outcome ->> 'waited')::boolean then
			v_wrong := v_wrong || format('%s answered %s', v_name, v_outcome); end if;
	end loop;
	v_outcome := pg_temp.rr_host('qorpera_native_host_call', 'qorpera_begin_native_tool_operation', pg_temp.rw_begin_args());
	if v_outcome -> 'result' is distinct from v_finished || jsonb_build_object('output_snapshot_id', null, 'proposal_id', null)
		or (v_outcome ->> 'waited')::boolean then
		v_wrong := v_wrong || format('the begin answered %s', v_outcome); end if;
	if pg_temp.rw_status() is distinct from 'completed' then v_wrong := v_wrong || format('the receipt is %s', pg_temp.rw_status()); end if;
	if cardinality(v_wrong) > 0 then raise exception 'The receipt did not answer with the row free: %', v_wrong; end if;
end $$;
select current_setting('qorpera_test.rw_begin') as rw_begin, current_setting('qorpera_test.rw_finish') as rw_finish \gset
\echo 468 while the row is held: the begin gave :rw_begin; :rw_finish

select pg_temp.rr_cleanup();
