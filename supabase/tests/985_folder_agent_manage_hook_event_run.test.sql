-- @fixture 913_folder_core_event_wakes.test.sql until "-- 5. Retries, a paused company, a removed hook"
-- Company folder core C4, E3a (migration 20260930106000; deploy/first-node/RUNTIME-COMPANY-FOLDER-EVENTS.md §5.2): a run
-- that a hook's event woke, its manage_hook on that hook. E2a's gate refuses the run once its wake's hook is removed, and
-- the receipt's completion checks the run again, so the run may pause and resume that hook but never remove it: the
-- removal is refused with a plain reason before anything changes, and the run lives on. It may remove another hook.
-- On 913's company (Nora, an owner, requests the Payments routine's wakes on the hook `stripe`); rolled back at the end.

create function pg_temp.e985_raises(p_sql text, p_state text, p_message text) returns void language plpgsql as $$
begin
	execute p_sql;
	raise exception 'Expected SQLSTATE % from %', p_state, p_sql using errcode = 'QTF02';
exception when others then
	if sqlstate = 'QTF02' then raise; end if;
	if sqlstate <> p_state or sqlerrm <> p_message then
		raise exception 'Expected % "%" from %, got % "%"', p_state, p_message, p_sql, sqlstate, sqlerrm using errcode = 'QTF03'; end if;
end $$;
create function pg_temp.e985_request(p_key text, p_action text, p_hook text) returns jsonb language sql as $$
	select jsonb_build_object('action', p_action, 'operationKey', p_key, 'hook', p_hook)
$$;
create function pg_temp.e985_status(p_hook uuid) returns text language sql as $$
	select status from public.qorpera_event_hooks where id = p_hook
$$;
create function pg_temp.e985_receipts(p_binding jsonb) returns bigint language sql as $$
	select count(*) from public.qorpera_run_operation_receipts where run_id = (p_binding ->> 'runId')::uuid
		and logical_operation_key like 'hook:%'
$$;

-- 1. The Payments routine's next wake (the late payment's, queued in 913's section 4) becomes a run, woken by `stripe`.
do $$
declare w public.qorpera_wake_occurrences; a jsonb; r jsonb;
begin
	select * into strict w from pg_temp.ew('91300000-0000-4000-8000-0000000000e1') where status = 'queued';
	perform pg_temp.is(w.source_id::text, '91300000-0000-4000-8000-0000000000b1', 'the wake''s hook is stripe');
	a := pg_temp.native(pg_temp.event_run(w.id));
	perform set_config('qorpera_test.e985_run', a::text, false);

	-- 2. Removing the hook that woke it: refused, nothing changed, no receipt. Paused, it is still refused.
	perform pg_temp.e985_raises(format('select public.qorpera_folder_manage_hook(%L::jsonb, %L::jsonb)', a,
		pg_temp.e985_request('e985-remove-own', 'remove', 'stripe')), '55000', 'A run this hook woke cannot remove it; pause it instead');
	perform pg_temp.is(pg_temp.e985_status('91300000-0000-4000-8000-0000000000b1'), 'active', 'stripe after the refusal');
	perform pg_temp.is(pg_temp.e985_receipts(a)::text, '0', 'no receipt for a refused removal');

	-- 3. Pausing and resuming it: the run may.
	r := public.qorpera_folder_manage_hook(a, pg_temp.e985_request('e985-pause-own', 'pause', 'stripe'));
	perform pg_temp.is(r -> 'hook' ->> 'status', 'paused', 'the pause''s answer');
	perform pg_temp.is(pg_temp.e985_status('91300000-0000-4000-8000-0000000000b1'), 'paused', 'stripe paused');
	perform pg_temp.e985_raises(format('select public.qorpera_folder_manage_hook(%L::jsonb, %L::jsonb)', a,
		pg_temp.e985_request('e985-remove-paused', 'remove', 'stripe')), '55000', 'A run this hook woke cannot remove it; pause it instead');
	r := public.qorpera_folder_manage_hook(a, pg_temp.e985_request('e985-resume-own', 'resume', 'stripe'));
	perform pg_temp.is(r -> 'hook' ->> 'status', 'active', 'the resume''s answer');
	perform pg_temp.is(pg_temp.e985_status('91300000-0000-4000-8000-0000000000b1'), 'active', 'stripe resumed');

	-- 4. Another hook (`forms`, which woke nothing): the run removes it, and still acts after.
	r := public.qorpera_folder_manage_hook(a, pg_temp.e985_request('e985-remove-forms', 'remove', 'forms'));
	perform pg_temp.is(r -> 'hook' ->> 'status', 'removed', 'the removal''s answer');
	perform pg_temp.is(pg_temp.e985_status('91300000-0000-4000-8000-0000000000b3'), 'removed', 'forms removed');
	r := public.qorpera_folder_manage_hook(a, pg_temp.e985_request('e985-pause-again', 'pause', 'stripe'));
	perform pg_temp.is(r -> 'hook' ->> 'status', 'paused', 'a pause after the removal');
	perform pg_temp.is(pg_temp.e985_receipts(a)::text, '4', 'one receipt per change');
	-- A replay of the removal answers from its receipt.
	r := public.qorpera_folder_manage_hook(a, pg_temp.e985_request('e985-remove-forms', 'remove', 'forms'));
	perform pg_temp.is(r -> 'hook' ->> 'status', 'removed', 'the removal''s replay');
	perform pg_temp.is(pg_temp.e985_receipts(a)::text, '4', 'a replay adds no receipt');
end $$;
