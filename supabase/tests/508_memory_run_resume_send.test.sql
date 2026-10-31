-- @fixture 466_memory_run_resume_receipts.test.sql until "-- 3. Today's path"
-- F9 (20260930545000): a resumed attempt that has not recorded its resume makes no new send, card or rule. Test 466's
-- run in Agent notebooks mode keeps no log; its first attempt has acknowledged ('rr-ack'), completed two steps and
-- begun a third. Here the first attempt also raises a card and adds an "Ask first" rule. Then the run is cut off, and
-- its next attempt starts but records nothing, as v190's runtime does. Its new sends, card and rule are refused as its
-- steps are (55000 'Run resume is not recorded') and leave every table as it was. A card it raises before its final is
-- refused itself, so no card stays without its final. What it repeats answers as before; here no table changes.
-- Authority, the wake's work gate and the run's read recheck are checked as before, ahead of the fence. A run that does
-- not resume from its receipts (one with a log, one in Agent tree mode) works as before. A newer attempt makes the older
-- one stale (42501), and is fenced the same way until it records; then it works. Each case reports 'ok' (with the rule's
-- 'added') or its SQLSTATE and message, then the tables whose row counts changed, then the tables whose content changed
-- with the same count. Every case is noted; the test fails at its end with each case that did not match, or if a case
-- did not run.
--
-- The expected messages, from the function source (file:line):
-- - 55000 'Run resume is not recorded': the receipt fence, 20260930539000:165 (20260930545000 raises the same).
-- - 55000 'Run resume is unavailable': qorpera_memory_run_resume_of, 20260928559130:47.
-- - 55000 'Wake public output is already final': qorpera_assert_wake_work_allowed, 20260828023000:307.
-- - 42501 'Run is unavailable': the run check's lease (job, runner, assignment), qorpera_folder_run_resolve,
--   20260928249000:824.
-- - 42501 'native agent send authority is required': the send, 20260928279560:140.
-- - 42501 'native interaction authority is required': the card, 20260928279560:209.
-- - 42501 'native tool host authority is required': the rule's run check, qorpera_folder_native_actor,
--   20260928279470:172 (through qorpera_folder_tool_run, 20260928279470:237).
-- - 42501 'A read is no longer readable': the run's read recheck, qorpera_folder_run_reads_current, in P24b's text,
--   20260928469330:126. A path under secrets/ has no resource, so nobody may read it (20260928469330:61).
-- - 23505 'agent send key is bound to different content': the send's replay, 20260928279560:155.
-- - 23505 'runner event id is already bound to different content': the card's append, 20260928279560:70.
-- - 23505 'This operation key already added another rule': the rule's replay, 20260928279560:362.
-- The answers with no write: the send's replay, 20260928279560:152-159; the card's, 20260928279560:66-77; the rule's
-- 'added' false, 20260928279560:359-368 and :382.
-- The writes: a send adds its send row (20260928279560:190), its event (:117), the event's company operation
-- (20260816015000:356) and its speaker (20260920030600:19-23); a card adds its event and the operation; a rule adds its
-- rule row (20260928279560:370), and nothing else.

-- Every public table's row count and content (an md5 over its rows' md5s), by name.
create function pg_temp.f9_rows() returns jsonb language plpgsql as $$
declare v jsonb := '{}'; v_table record; v_count bigint; v_md5 text;
begin
	for v_table in select c.oid::regclass as id, c.relname::text as name from pg_class c
		join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') loop
		execute format('select count(*), coalesce(md5(string_agg(md5(f9_row::text), '''' order by md5(f9_row::text))), '''') from %s as f9_row',
			v_table.id) into v_count, v_md5;
		v := v || jsonb_build_object(v_table.name, jsonb_build_array(v_count, v_md5));
	end loop;
	return v;
end $$;
-- Since p_before: the tables whose row counts changed, each with its change, or 'none'; then '|' and the tables whose
-- content changed with the same count, or 'none'.
create function pg_temp.f9_changed(p_before jsonb) returns text language sql as $$
	select coalesce(string_agg(case when (now_.value ->> 0)::bigint <> (then_.value ->> 0)::bigint then now_.key
		|| case when (now_.value ->> 0)::bigint > (then_.value ->> 0)::bigint then '+' else '' end
		|| ((now_.value ->> 0)::bigint - (then_.value ->> 0)::bigint) end, ',' order by now_.key collate "C"), 'none')
		|| '|' || coalesce(string_agg(case when now_.value ->> 0 = then_.value ->> 0 then now_.key end, ',' order by now_.key collate "C"), 'none')
	from jsonb_each(pg_temp.f9_rows()) as now_ join jsonb_each(p_before) as then_ on then_.key = now_.key
	where now_.value <> then_.value
$$;
-- One call, as the service role (or as the owner, a member): 'ok' (':' and its answer, if any) or its SQLSTATE and
-- message, then what it changed. Unless kept, a call that goes through is undone, so each case starts from the same
-- rows on every head.
create function pg_temp.f9_try(p_sql text, p_keep boolean default false, p_member boolean default false) returns text
language plpgsql as $$
declare v_before jsonb := pg_temp.f9_rows(); v_answer text; v_outcome text;
begin
	begin
		if p_member then perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
		else perform pg_temp.base_claims('service_role'); end if;
		execute p_sql into v_answer;
		v_outcome := 'ok' || coalesce(':' || v_answer, '') || '|' || pg_temp.f9_changed(v_before);
		if not p_keep then raise exception using errcode = 'F9000', message = v_outcome; end if;
	exception when sqlstate 'F9000' then v_outcome := sqlerrm;
		when others then v_outcome := sqlstate || ' ' || sqlerrm || '|' || pg_temp.f9_changed(v_before);
	end;
	perform pg_temp.base_claims('service_role');
	return v_outcome;
end $$;
-- A card's event id, by its suffix.
create function pg_temp.f9_event(p_suffix text) returns uuid language sql immutable as $$
	select ('50800000-0000-4000-8000-0000000000' || p_suffix)::uuid
$$;
-- The card ask_member raises (as 652's).
create function pg_temp.f9_append_card(p_binding jsonb, p_event uuid) returns jsonb language sql as $$
	select public.qorpera_append_native_interaction_request((p_binding ->> 'leaseId')::uuid, (p_binding ->> 'runId')::uuid,
		(p_binding ->> 'jobId')::uuid, (p_binding ->> 'runnerId')::uuid, (p_binding ->> 'assignmentId')::uuid,
		(p_binding ->> 'credentialCapsuleId')::uuid, (p_binding ->> 'computeIdentityId')::uuid, 'openai', 'codex-cli', p_event,
		'{"schema":"qorpera.interaction/v1","surface":"question","title":"Which channel?","payload":{"options":[{"label":"#general","value":"general"},{"label":"#finance","value":"finance"}]}}')
$$;
create function pg_temp.f9_send(p_binding jsonb, p_phase text, p_key text, p_keep boolean default false,
	p_member boolean default false) returns text language sql as $$
	select pg_temp.f9_try(format('select null::text from pg_temp.base_public_send(%L::jsonb, %L, %L)', p_binding, p_phase, p_key),
		p_keep, p_member)
$$;
create function pg_temp.f9_card(p_binding jsonb, p_suffix text, p_keep boolean default false, p_member boolean default false)
returns text language sql as $$
	select pg_temp.f9_try(format('select null::text from pg_temp.f9_append_card(%L::jsonb, %L::uuid)', p_binding,
		pg_temp.f9_event(p_suffix)), p_keep, p_member)
$$;
create function pg_temp.f9_rule(p_binding jsonb, p_key text, p_when text, p_keep boolean default false,
	p_member boolean default false) returns text language sql as $$
	select pg_temp.f9_try(format('select public.qorpera_add_agent_review_rule(%L::jsonb, %L::jsonb) ->> ''added''', p_binding,
		jsonb_build_object('operationKey', p_key, 'when', p_when)), p_keep, p_member)
$$;
-- What a call that goes through writes. A send's or a card's in-place changes (the run's budget, the operation clock,
-- the session's time, which moves once per statement) are not compared ('*'); a rule changes nothing in place.
create function pg_temp.f9_sent() returns text language sql as $$
	select 'ok|qorpera_agent_sends+1,qorpera_company_operations+1,qorpera_session_event_speakers+1,qorpera_session_events+1|*'
$$;
create function pg_temp.f9_carded() returns text language sql as $$
	select 'ok|qorpera_company_operations+1,qorpera_session_events+1|*'
$$;
create function pg_temp.f9_ruled() returns text language sql as $$ select 'ok:true|qorpera_review_rules+1|none' $$;
create function pg_temp.f9_refused() returns text language sql as $$ select '55000 Run resume is not recorded|none|none' $$;
-- A case: noted as run, and noted as failed when it does not match.
create function pg_temp.f9_case(p_case text, p_got text, p_want text) returns void language plpgsql as $$
declare v_got text[] := string_to_array(p_got, '|'); v_want text[] := string_to_array(p_want, '|');
begin
	perform set_config('qorpera_test.f9_cases', current_setting('qorpera_test.f9_cases') || E'\n' || p_case, true);
	if p_got is null or (case when v_want[3] = '*' then cardinality(v_got) <> 3 or v_got[1] is distinct from v_want[1]
		or v_got[2] is distinct from v_want[2] else p_got is distinct from p_want end) then
		perform set_config('qorpera_test.f9_failed', current_setting('qorpera_test.f9_failed')
			|| format(E'\n%s: expected %s, got %s', p_case, p_want, coalesce(p_got, 'nothing')), true);
	end if;
end $$;
-- Cases as (name, got, expected) triples, noted after any undo (an undone block would undo its notes).
create function pg_temp.f9_cases(p_cases text[]) returns void language plpgsql as $$
begin
	if coalesce(cardinality(p_cases), 0) % 3 <> 0 then raise exception 'F9 cases come in triples: %', p_cases; end if;
	for i in 1 .. coalesce(cardinality(p_cases), 0) / 3 loop
		perform pg_temp.f9_case(p_cases[3 * i - 2], p_cases[3 * i - 1], p_cases[3 * i]);
	end loop;
end $$;
create function pg_temp.f9_binding(p_name text) returns jsonb language sql as $$
	select current_setting('qorpera_test.' || p_name)::jsonb
$$;
create function pg_temp.f9_sends() returns bigint language sql as $$
	select count(*) from public.qorpera_agent_sends where run_id = pg_temp.rr_run()
$$;
select set_config('qorpera_test.f9_failed', '', true) \g /dev/null
select set_config('qorpera_test.f9_cases', '', true) \g /dev/null

-- 1. The first attempt is no resume: its new send, card and rule go through, and their replays write nothing; then its
--    final. All undone. Then it keeps card A and rule A, for the next attempt to repeat.
do $$
declare v_binding jsonb := pg_temp.f9_binding('base_binding'); v text[] := '{}';
begin
	begin
		v := v || array['01 the first attempt''s new progress send', pg_temp.f9_send(v_binding, 'progress', 'f9-first-ack', true),
			pg_temp.f9_sent()];
		v := v || array['02 the first attempt''s new card', pg_temp.f9_card(v_binding, '01', true), pg_temp.f9_carded()];
		v := v || array['03 its card''s replay', pg_temp.f9_card(v_binding, '01', true), 'ok|none|none'];
		v := v || array['04 the first attempt''s new rule', pg_temp.f9_rule(v_binding, 'f9-first-rule', 'Paying a first invoice', true),
			pg_temp.f9_ruled()];
		v := v || array['05 its rule''s replay', pg_temp.f9_rule(v_binding, 'f9-first-rule', 'Paying a first invoice', true),
			'ok:false|none|none'];
		v := v || array['06 the first attempt''s final send', pg_temp.f9_send(v_binding, 'final', 'f9-first-final', true),
			pg_temp.f9_sent()];
		raise exception using errcode = 'F9001';
	exception when sqlstate 'F9001' then null;
	end;
	perform pg_temp.f9_cases(v);
end
$$;
do $$
declare v_binding jsonb := pg_temp.f9_binding('base_binding');
begin
	perform pg_temp.f9_cases(array['07 the first attempt keeps card A', pg_temp.f9_card(v_binding, '0a', true), pg_temp.f9_carded(),
		'08 the first attempt keeps rule A', pg_temp.f9_rule(v_binding, 'f9-rule-a', 'Paying an invoice', true), pg_temp.f9_ruled()]);
end
$$;

-- 2. The cut-off (as 466 §4), then the next attempt, on the same run and job, starts and records nothing.
do $$
begin
	perform pg_temp.rr_expire((pg_temp.f9_binding('base_binding') ->> 'jobId')::uuid);
	perform pg_temp.base_assert(pg_temp.rr_events(pg_temp.rr_run(), 'run_cut_off') = 1, 'the run is cut off');
end
$$;
do $$
declare v_next jsonb := pg_temp.base_start(pg_temp.rr_run());
begin
	perform pg_temp.base_assert(pg_temp.rr_begin(v_next) ->> 'leaseId' = v_next ->> 'leaseId', 'the next attempt starts');
	perform pg_temp.base_assert(public.qorpera_memory_run_resume(v_next) ->> 'why' = 'restart'
		and not exists (select 1 from public.qorpera_memory_run_resumes where run_id = pg_temp.rr_run()),
		'the next attempt is a resume it has not recorded');
	perform set_config('qorpera_test.f9_next', v_next::text, true);
end
$$;

-- 3. Before it records, the next attempt makes nothing new. It raises a card, then sends its final (as ask_member
--    does): the card itself is refused, then the final; afterwards there is no such event and no table changed. Each
--    new send and rule is refused too. What it repeats answers as before, with no write: card A's id with its own
--    assignment (other content, 23505), rule A (added false; other text under its key, 23505; its text under a new key,
--    the same rule, added false), the first attempt's send (the stored message; other content, 23505).
do $$
declare v_next jsonb := pg_temp.f9_binding('f9_next'); v_before jsonb; v text[] := '{}';
begin
	begin
		v_before := pg_temp.f9_rows();
		v := v || array['09 the unrecorded next attempt''s new card, before its final', pg_temp.f9_card(v_next, '02', true),
			pg_temp.f9_refused()];
		v := v || array['10 then its final', pg_temp.f9_send(v_next, 'final', 'f9-next-final', true), pg_temp.f9_refused()];
		v := v || array['11 after both: the card''s event, then every table', (select count(*) from public.qorpera_session_events
			where event_id = pg_temp.f9_event('02'))::text || '|' || pg_temp.f9_changed(v_before), '0|none|none'];
		raise exception using errcode = 'F9001';
	exception when sqlstate 'F9001' then null;
	end;
	perform pg_temp.f9_cases(v);
end
$$;
do $$
declare v_next jsonb := pg_temp.f9_binding('f9_next');
begin
	perform pg_temp.f9_cases(array[
		'12 the unrecorded next attempt''s new progress send', pg_temp.f9_send(v_next, 'progress', 'f9-next-ack'), pg_temp.f9_refused(),
		'13 the unrecorded next attempt''s new final send', pg_temp.f9_send(v_next, 'final', 'f9-next-final'), pg_temp.f9_refused(),
		'14 the unrecorded next attempt''s new rule', pg_temp.f9_rule(v_next, 'f9-next-rule', 'Booking travel'), pg_temp.f9_refused(),
		'15 its card under card A''s id', pg_temp.f9_card(v_next, '0a'),
			'23505 runner event id is already bound to different content|none|none',
		'16 its rule A, again', pg_temp.f9_rule(v_next, 'f9-rule-a', 'Paying an invoice'), 'ok:false|none|none',
		'17 other text under rule A''s key', pg_temp.f9_rule(v_next, 'f9-rule-a', 'Booking travel'),
			'23505 This operation key already added another rule|none|none',
		'18 rule A''s text under a new key', pg_temp.f9_rule(v_next, 'f9-next-dedupe', 'PAYING AN INVOICE'), 'ok:false|none|none',
		'19 its replay of the first attempt''s send', pg_temp.f9_send(v_next, 'progress', 'rr-ack', true), 'ok|none|none',
		'20 the replay answers the stored message', pg_temp.f9_try(format('select (reply ->> ''messageId'' = (select event_id::text '
			|| 'from public.qorpera_agent_sends where run_id = pg_temp.rr_run() and idempotency_key = ''rr-ack'') '
			|| 'and pg_temp.f9_sends() = 1)::text from pg_temp.base_public_send(%L::jsonb, ''progress'', ''rr-ack'') as reply', v_next)),
			'ok:true|none|none',
		'21 other content under that key', pg_temp.f9_send(v_next, 'final', 'rr-ack'),
			'23505 agent send key is bound to different content|none|none']);
end
$$;

-- 4. Authority is checked as before: the cut-off attempt is refused by the run check, before the fence, and only the
--    service role sends, raises a card or adds a rule. The wake's work gate too: after the next attempt's final (sent
--    in Agent tree mode, where nothing fences it), its rule in notebooks mode is refused as before, ahead of the fence.
do $$
declare v_old jsonb := pg_temp.f9_binding('base_binding'); v_next jsonb := pg_temp.f9_binding('f9_next');
begin
	perform pg_temp.f9_cases(array[
		'22 the cut-off attempt''s send', pg_temp.f9_send(v_old, 'progress', 'f9-old-ack'), '42501 Run is unavailable|none|none',
		'23 the cut-off attempt''s card', pg_temp.f9_card(v_old, '03'), '42501 Run is unavailable|none|none',
		'24 the cut-off attempt''s rule', pg_temp.f9_rule(v_old, 'f9-old-rule', 'Paying rent'), '42501 Run is unavailable|none|none',
		'25 a member''s send', pg_temp.f9_send(v_next, 'progress', 'f9-member-ack', false, true),
			'42501 native agent send authority is required|none|none',
		'26 a member''s card', pg_temp.f9_card(v_next, '04', false, true), '42501 native interaction authority is required|none|none',
		'27 a member''s rule', pg_temp.f9_rule(v_next, 'f9-member-rule', 'Paying rent', false, true),
			'42501 native tool host authority is required|none|none']);
end
$$;
do $$
declare v_next jsonb := pg_temp.f9_binding('f9_next'); v text[] := '{}';
	v_mode public.qorpera_execution_runs.memory_mode%type;
begin
	begin
		select memory_mode into strict v_mode from public.qorpera_execution_runs where id = pg_temp.rr_run();
		perform set_config('session_replication_role', 'replica', true);
		update public.qorpera_execution_runs set memory_mode = 'tree' where id = pg_temp.rr_run();
		perform set_config('session_replication_role', 'origin', true);
		v := v || array['28 in tree mode, the next attempt''s final', pg_temp.f9_send(v_next, 'final', 'f9-wake-final', true),
			pg_temp.f9_sent()];
		perform set_config('session_replication_role', 'replica', true);
		update public.qorpera_execution_runs set memory_mode = v_mode where id = pg_temp.rr_run();
		perform set_config('session_replication_role', 'origin', true);
		perform pg_temp.base_assert(public.qorpera_run_resumes_from_receipts(pg_temp.rr_run())
			and not exists (select 1 from public.qorpera_memory_run_resumes where run_id = pg_temp.rr_run()),
			'back in notebooks mode, unrecorded');
		v := v || array['29 then its rule, in notebooks mode', pg_temp.f9_rule(v_next, 'f9-wake-rule', 'Signing a lease'),
			'55000 Wake public output is already final|none|none'];
		raise exception using errcode = 'F9001';
	exception when sqlstate 'F9001' then null;
	end;
	perform pg_temp.f9_cases(v);
end
$$;

-- 5. A run that does not resume from its receipts works as before, unrecorded: one that keeps a log, and one in Agent
--    tree mode. The fence never asks for its resume: here the cut-off's event is one the resume read refuses, and the
--    send, the card and the rule still go through. All undone.
do $$
declare v_next jsonb := pg_temp.f9_binding('f9_next'); v_run public.qorpera_execution_runs; v text[] := '{}';
begin
	begin
		perform set_config('session_replication_role', 'replica', true);
		update public.qorpera_execution_run_events set payload = payload - 'schema'
		where run_id = pg_temp.rr_run() and event_type = 'run_cut_off';
		perform set_config('session_replication_role', 'origin', true);
		v := v || array['30 the resume read refuses this cut-off', pg_temp.f9_try(format(
			'select public.qorpera_memory_run_resume_of(%L::uuid, %L::uuid, %L::uuid)::text', pg_temp.rr_run(),
			v_next ->> 'assignmentId', v_next ->> 'leaseId')), '55000 Run resume is unavailable|none|none'];
		begin
			select * into strict v_run from public.qorpera_execution_runs where id = pg_temp.rr_run();
			insert into public.qorpera_memory_run_logs(environment_id, run_id, session_id, run_path, run_key, toml_path_version, commit_id)
			values (v_run.environment_id, v_run.id, extensions.gen_random_uuid(), 'QorperaOS/agents/alice/runs/' || v_run.id,
				'qorperaos/agents/alice/runs/' || v_run.id, extensions.gen_random_uuid(), extensions.gen_random_uuid());
			perform pg_temp.base_assert(public.qorpera_run_resumes_from_receipts(v_run.id) is false,
				'a run with a log does not resume from receipts');
			v := v || array['31 a run with a log: the unrecorded attempt''s send', pg_temp.f9_send(v_next, 'progress', 'f9-log-ack'),
				pg_temp.f9_sent()];
			v := v || array['32 a run with a log: its card', pg_temp.f9_card(v_next, '05'), pg_temp.f9_carded()];
			v := v || array['33 a run with a log: its rule', pg_temp.f9_rule(v_next, 'f9-log-rule', 'Hiring a contractor'),
				pg_temp.f9_ruled()];
			raise exception using errcode = 'F9001';
		exception when sqlstate 'F9001' then null;
		end;
		perform set_config('session_replication_role', 'replica', true);
		update public.qorpera_execution_runs set memory_mode = 'tree' where id = pg_temp.rr_run();
		perform set_config('session_replication_role', 'origin', true);
		perform pg_temp.base_assert(public.qorpera_run_resumes_from_receipts(pg_temp.rr_run()) is false,
			'a tree run does not resume from receipts');
		v := v || array['34 a run in Agent tree mode: the unrecorded attempt''s send', pg_temp.f9_send(v_next, 'progress', 'f9-tree-ack'),
			pg_temp.f9_sent()];
		v := v || array['35 a run in Agent tree mode: its card', pg_temp.f9_card(v_next, '06'), pg_temp.f9_carded()];
		v := v || array['36 a run in Agent tree mode: its rule', pg_temp.f9_rule(v_next, 'f9-tree-rule', 'Renewing a domain'),
			pg_temp.f9_ruled()];
		raise exception using errcode = 'F9001';
	exception when sqlstate 'F9001' then null;
	end;
	perform pg_temp.f9_cases(v);
end
$$;

-- 5b. Added after the red, as the placement control (as before on master and with the fix): each fence comes after the
--     run's read recheck. With a read the run released no longer readable (its resource is gone, and its path is under
--     secrets/), the unrecorded next attempt's new send, card and rule are refused by the recheck (42501), as before,
--     not by the fence. All undone.
do $$
declare v_next jsonb := pg_temp.f9_binding('f9_next'); v_run public.qorpera_execution_runs;
	v_resource uuid := extensions.gen_random_uuid(); v text[] := '{}';
begin
	begin
		select * into strict v_run from public.qorpera_execution_runs where id = pg_temp.rr_run();
		insert into public.qorpera_folder_run_reads(run_id, environment_id, resource_id, resource_revision)
		values (v_run.id, v_run.environment_id, v_resource, 1);
		insert into public.qorpera_folder_run_read_records(run_id, release_id, environment_id, resource_id, reads, output_sha256)
		values (v_run.id, extensions.gen_random_uuid(), v_run.environment_id, v_resource,
			jsonb_build_array(jsonb_build_object('path', 'secrets/f9.txt')), repeat('0', 64));
		v := v || array['52 a read no longer readable: the unrecorded next attempt''s new send',
			pg_temp.f9_send(v_next, 'progress', 'f9-read-ack'), '42501 A read is no longer readable|none|none'];
		v := v || array['53 a read no longer readable: its new card', pg_temp.f9_card(v_next, '09'),
			'42501 A read is no longer readable|none|none'];
		v := v || array['54 a read no longer readable: its new rule', pg_temp.f9_rule(v_next, 'f9-read-rule', 'Selling equipment'),
			'42501 A read is no longer readable|none|none'];
		raise exception using errcode = 'F9001';
	exception when sqlstate 'F9001' then null;
	end;
	perform pg_temp.f9_cases(v);
end
$$;

-- 6. A newer attempt: the next attempt is cut off before it records, and a third starts. The next attempt is stale and
--    refused by the run check; the third is fenced the same way until it records.
do $$
begin
	perform pg_temp.rr_expire((pg_temp.f9_binding('f9_next') ->> 'jobId')::uuid);
	perform pg_temp.base_assert((select status = 'queued' and attempt_count = 2 from public.qorpera_runner_jobs
		where id = (pg_temp.f9_binding('f9_next') ->> 'jobId')::uuid) and pg_temp.rr_events(pg_temp.rr_run(), 'run_cut_off') = 2,
		'a second cut-off resumes');
end
$$;
do $$
declare v_third jsonb := pg_temp.base_start(pg_temp.rr_run());
begin
	perform pg_temp.base_assert(pg_temp.rr_begin(v_third) ->> 'leaseId' = v_third ->> 'leaseId', 'the third attempt starts');
	perform set_config('qorpera_test.f9_third', v_third::text, true);
end
$$;
do $$
declare v_stale jsonb := pg_temp.f9_binding('f9_next'); v_third jsonb := pg_temp.f9_binding('f9_third');
begin
	perform pg_temp.f9_cases(array[
		'37 the stale attempt''s send', pg_temp.f9_send(v_stale, 'progress', 'f9-stale-ack'), '42501 Run is unavailable|none|none',
		'38 the stale attempt''s card', pg_temp.f9_card(v_stale, '07'), '42501 Run is unavailable|none|none',
		'39 the stale attempt''s rule', pg_temp.f9_rule(v_stale, 'f9-stale-rule', 'Buying a laptop'), '42501 Run is unavailable|none|none',
		'40 the unrecorded third attempt''s new progress send', pg_temp.f9_send(v_third, 'progress', 'f9-third-ack'), pg_temp.f9_refused(),
		'41 the unrecorded third attempt''s new final send', pg_temp.f9_send(v_third, 'final', 'f9-third-final'), pg_temp.f9_refused(),
		'42 the unrecorded third attempt''s new card', pg_temp.f9_card(v_third, '08'), pg_temp.f9_refused(),
		'43 the unrecorded third attempt''s new rule', pg_temp.f9_rule(v_third, 'f9-third-rule', 'Ordering office supplies'),
			pg_temp.f9_refused()]);
end
$$;

-- 7. Once it records what it was told (the unknown step, no steps read, as 466 §8), the third attempt works: its card,
--    its rule and its progress send, each of whose replay writes nothing, then its final.
do $$
declare v_third jsonb := pg_temp.f9_binding('f9_third'); v text[] := '{}';
begin
	perform pg_temp.base_claims('service_role');
	perform pg_temp.rr_record(v_third, jsonb_build_object('stepsRead', 0, 'unknownCalls', jsonb_build_array(
		jsonb_build_object('call', null, 'step', null, 'receiptId', current_setting('qorpera_test.rr_b')))));
	v := v || array['44 the recorded attempt''s new card', pg_temp.f9_card(v_third, '08', true), pg_temp.f9_carded()];
	v := v || array['45 its card''s replay', pg_temp.f9_card(v_third, '08', true), 'ok|none|none'];
	v := v || array['46 the recorded attempt''s new rule', pg_temp.f9_rule(v_third, 'f9-third-rule', 'Ordering office supplies', true),
		pg_temp.f9_ruled()];
	v := v || array['47 its rule''s replay', pg_temp.f9_rule(v_third, 'f9-third-rule', 'Ordering office supplies', true),
		'ok:false|none|none'];
	v := v || array['48 the recorded attempt''s new progress send', pg_temp.f9_send(v_third, 'progress', 'f9-third-ack', true),
		pg_temp.f9_sent()];
	v := v || array['49 its send''s replay', pg_temp.f9_send(v_third, 'progress', 'f9-third-ack', true), 'ok|none|none'];
	v := v || array['50 the recorded attempt''s final send', pg_temp.f9_send(v_third, 'final', 'f9-third-final', true),
		pg_temp.f9_sent()];
	v := v || array['51 the run''s sends: the first attempt''s and the third''s', (select string_agg(idempotency_key || ':'
		|| (assignment_id::text = v_third ->> 'assignmentId'), ',' order by idempotency_key collate "C")
		from public.qorpera_agent_sends where run_id = pg_temp.rr_run()), 'f9-third-ack:true,f9-third-final:true,rr-ack:false'];
	perform pg_temp.f9_cases(v);
end
$$;

-- Every case, at once: each one ran, once, and matched.
do $$
declare v_cases text[] := array_remove(string_to_array(current_setting('qorpera_test.f9_cases'), E'\n'), '');
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.f9_failed') = '' and cardinality(v_cases) = 54
		and (select count(distinct c) from unnest(v_cases) c) = 54,
		format('%s cases ran (%s distinct) of 54; failed:%s', cardinality(v_cases),
			(select count(distinct c) from unnest(v_cases) c), current_setting('qorpera_test.f9_failed')));
end
$$;

set constraints all immediate;
rollback;
