-- @fixture 466_memory_run_resume_receipts.test.sql until "-- 3. Today's path"
-- A3 (20260930546000): a resumed attempt that has not recorded its resume uses no approval and raises no new review or
-- card. Test 466's run in Agent notebooks mode keeps no log; its first attempt has acknowledged ('rr-ack'), completed
-- two steps and begun a third. Here the first attempt also raises approval cards for the owner (the member the run
-- works for), who approves some of them while the call still holds; it uses one approval, records an allow, a deny and
-- a dynamic routine's ask (which raises no card). Then the run is cut off, and its next attempt starts but records
-- nothing, as v190's runtime does. Its begin is refused (55000 'Run resume is not recorded') where it would use an
-- approval (the one the answer that woke the run gave, or the latest), hold on a waiting card, or ask for a new review;
-- its record is refused where it would add a review (with or without a card) and where it would replay a review that
-- has a card (the runtime would hold on it). Each refusal leaves every table as it was. A denial still answers
-- 'declined', an approval another call used still answers 'used', and the replay of an allow, a deny or an ask with no
-- card answers as before, with no write. Authority, the request's shape and its values (P40's apply_proposal check
-- among them) are checked as before, ahead of the fence.
-- A run that does not resume from its receipts (one with a log, one in Agent tree mode) works as before. Once the
-- attempt records its resume it works again; an approval the first attempt used is then reviewed afresh (the fence
-- bounds the unrecorded attempt only; it does not make an approval exactly-once across attempts). Each case reports
-- 'ok' (with begin's state, or record's decision and card) or its SQLSTATE and message, then the tables whose row
-- counts changed, then the tables whose content changed with the same count. Every case is noted; the test fails at
-- its end with each case that did not match, or if a case did not run.
--
-- The expected messages, from the function source (file:line):
-- - 55000 'Run resume is not recorded': the fence, 20260930546000 (as 20260930539000:165 and 20260930545000 raise).
-- - 55000 'Run resume is unavailable': qorpera_memory_run_resume_of, 20260928559130:47.
-- - 42501 'Run is unavailable': the run check's lease (job, runner, assignment), qorpera_folder_run_resolve,
--   20260928249000:824.
-- - 42501 'native tool host authority is required': the run check, qorpera_folder_native_actor, 20260928279470:172.
-- - 22023 'Action review request is invalid': begin's request, 20260926130000:270.
-- - 22023 'Action review record is invalid': record's request, 20260926130000:369 (its shape) and :386 (its values),
--   and P40's apply_proposal check, 20260928489240:351-353 (a call that names no proposal).
-- - 23505 'This call was already reviewed with other content': record's replay, 20260926130000:374.
-- The answers with no write: begin's 'declined' (20260926130000:301), 'pending' (:309) and 'review' (:322), and 'used'
-- (20260930489000's check of the card that woke the run); record's replay (20260926130000:375).
-- The writes: begin's 'approved' marks the approval used (20260930489000's check of the card that woke the run, and
-- 20260926130000:304); record adds its review (20260926130000:447) and, for a card, the run budget's transcript
-- counters, the card's event and the session's time (this run is folder-v2: qorpera_folder_append_transcript_event,
-- 20260928279560:446, adds to the counters at 20260928279560:103-106, inserts the event at :117 and sets the time at
-- :121) and the event's company operation (the after-insert trigger on qorpera_session_events, 20260816015000:356, and
-- its function at :205).

-- Every public table's row count and content (an md5 over its rows' md5s), by name.
create function pg_temp.a3_rows() returns jsonb language plpgsql as $$
declare v jsonb := '{}'; v_table record; v_count bigint; v_md5 text;
begin
	for v_table in select c.oid::regclass as id, c.relname::text as name from pg_class c
		join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') loop
		execute format('select count(*), coalesce(md5(string_agg(md5(a3_row::text), '''' order by md5(a3_row::text))), '''') from %s as a3_row',
			v_table.id) into v_count, v_md5;
		v := v || jsonb_build_object(v_table.name, jsonb_build_array(v_count, v_md5));
	end loop;
	return v;
end $$;
-- Since p_before: the tables whose row counts changed, each with its change, or 'none'; then '|' and the tables whose
-- content changed with the same count, or 'none'.
create function pg_temp.a3_changed(p_before jsonb) returns text language sql as $$
	select coalesce(string_agg(case when (now_.value ->> 0)::bigint <> (then_.value ->> 0)::bigint then now_.key
		|| case when (now_.value ->> 0)::bigint > (then_.value ->> 0)::bigint then '+' else '' end
		|| ((now_.value ->> 0)::bigint - (then_.value ->> 0)::bigint) end, ',' order by now_.key collate "C"), 'none')
		|| '|' || coalesce(string_agg(case when now_.value ->> 0 = then_.value ->> 0 then now_.key end, ',' order by now_.key collate "C"), 'none')
	from jsonb_each(pg_temp.a3_rows()) as now_ join jsonb_each(p_before) as then_ on then_.key = now_.key
	where now_.value <> then_.value
$$;
-- One call, as the service role (or as the owner, a member): 'ok' (':' and its answer, if any) or its SQLSTATE and
-- message, then what it changed. Unless kept, a call that goes through is undone, so each case starts from the same
-- rows on every head.
create function pg_temp.a3_try(p_sql text, p_keep boolean default false, p_member boolean default false) returns text
language plpgsql as $$
declare v_before jsonb := pg_temp.a3_rows(); v_answer text; v_outcome text;
begin
	begin
		if p_member then perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
		else perform pg_temp.base_claims('service_role'); end if;
		execute p_sql into v_answer;
		v_outcome := 'ok' || coalesce(':' || v_answer, '') || '|' || pg_temp.a3_changed(v_before);
		if not p_keep then raise exception using errcode = 'A3000', message = v_outcome; end if;
	exception when sqlstate 'A3000' then v_outcome := sqlerrm;
		when others then v_outcome := sqlstate || ' ' || sqlerrm || '|' || pg_temp.a3_changed(v_before);
	end;
	perform pg_temp.base_claims('service_role');
	return v_outcome;
end $$;
-- An action's argument digest, by one hex digit.
create function pg_temp.a3_digest(p_digit text) returns text language sql immutable as $$ select repeat(p_digit, 64) $$;
-- The reviewer's verdict on one call (as 605's): the reviewer's own doubt (no rule, no built-in check), so an ask is
-- the member's the run works for (the owner), and raises a card in the run's thread unless it is decide_routine's.
create function pg_temp.a3_request(p_call text, p_digit text, p_decision text, p_tool text default 'send_email')
returns jsonb language sql as $$
	select jsonb_build_object('callId', p_call, 'tool', p_tool, 'effect', 'external', 'argumentSha256', pg_temp.a3_digest(p_digit),
		'action', jsonb_build_object('title', 'Send an email', 'target', 'customer@example.org',
			'details', jsonb_build_object('subject', 'Your order')),
		'decision', p_decision, 'ruleIds', '[]'::jsonb, 'builtIn', 'none',
		'reason', 'The member may not want this sent yet.', 'proposedRule', null, 'reviewerModel', 'gpt-6-luna')
$$;
create function pg_temp.a3_record_request(p_binding jsonb, p_request jsonb, p_keep boolean default false,
	p_member boolean default false) returns text language sql as $$
	select pg_temp.a3_try(format('select (review ->> ''decision'') || '':'' || (review ->> ''card'') '
		|| 'from public.qorpera_record_action_review(%L::jsonb, %L::jsonb) as review', p_binding, p_request), p_keep, p_member)
$$;
create function pg_temp.a3_record(p_binding jsonb, p_call text, p_digit text, p_decision text, p_keep boolean default false,
	p_member boolean default false, p_tool text default 'send_email') returns text language sql as $$
	select pg_temp.a3_record_request(p_binding, pg_temp.a3_request(p_call, p_digit, p_decision, p_tool), p_keep, p_member)
$$;
-- Begin for one action: its state.
create function pg_temp.a3_begin(p_binding jsonb, p_digit text, p_keep boolean default false, p_member boolean default false,
	p_tool text default 'send_email') returns text language sql as $$
	select pg_temp.a3_try(format('select public.qorpera_begin_action_review(%L::jsonb, %L::jsonb) ->> ''state''', p_binding,
		jsonb_build_object('tool', p_tool, 'argumentSha256', pg_temp.a3_digest(p_digit))), p_keep, p_member)
$$;
create function pg_temp.a3_review(p_call text) returns uuid language sql as $$
	select id from public.qorpera_action_reviews where run_id = pg_temp.rr_run() and call_id = p_call
$$;
-- The owner's answer on a card (as 605's rv_answer), while the card's call still holds it: it wakes nobody.
create function pg_temp.a3_answer(p_call text, p_answer text default 'allow_once') returns jsonb language plpgsql as $$
declare v_run public.qorpera_execution_runs%rowtype; v_result jsonb;
begin
	select * into strict v_run from public.qorpera_execution_runs where id = pg_temp.rr_run();
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	v_result := public.qorpera_answer_action_review(pg_temp.a3_review(p_call), extensions.gen_random_uuid(), p_answer, null,
		v_run.sponsor_binding_id, v_run.sponsor_version);
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(v_result ->> 'woke' = 'false' and v_result ->> 'inputId' is not null,
		'the held call takes the answer: ' || v_result::text);
	return v_result;
end $$;
-- A function's settings and grants.
create function pg_temp.a3_grants(p_function regprocedure) returns text language sql as $$
	select format('secdef=%s;config=%s;owner=%s;anon=%s;authenticated=%s;public=%s;service_role=%s', p.prosecdef,
		p.proconfig, pg_get_userbyid(p.proowner), has_function_privilege('anon', p.oid, 'EXECUTE'),
		has_function_privilege('authenticated', p.oid, 'EXECUTE'),
		exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
			where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'),
		has_function_privilege('service_role', p.oid, 'EXECUTE'))
	from pg_proc as p where p.oid = p_function
$$;
-- What a call that goes through writes. A card's in-place changes (the run budget's transcript counters,
-- 20260928279560:103-106; the session's time; the operation clock) are not compared ('*').
create function pg_temp.a3_carded() returns text language sql as $$
	select 'ok:ask:true|qorpera_action_reviews+1,qorpera_company_operations+1,qorpera_session_events+1|*'
$$;
create function pg_temp.a3_reviewed(p_decision text) returns text language sql as $$
	select 'ok:' || p_decision || ':false|qorpera_action_reviews+1|none'
$$;
create function pg_temp.a3_consumed() returns text language sql as $$ select 'ok:approved|none|qorpera_action_reviews' $$;
create function pg_temp.a3_refused() returns text language sql as $$ select '55000 Run resume is not recorded|none|none' $$;
-- A case: noted as run, and noted as failed when it does not match.
create function pg_temp.a3_case(p_case text, p_got text, p_want text) returns void language plpgsql as $$
declare v_got text[] := string_to_array(p_got, '|'); v_want text[] := string_to_array(p_want, '|');
begin
	perform set_config('qorpera_test.a3_cases', current_setting('qorpera_test.a3_cases') || E'\n' || p_case, true);
	if p_got is null or (case when v_want[3] = '*' then cardinality(v_got) <> 3 or v_got[1] is distinct from v_want[1]
		or v_got[2] is distinct from v_want[2] else p_got is distinct from p_want end) then
		perform set_config('qorpera_test.a3_failed', current_setting('qorpera_test.a3_failed')
			|| format(E'\n%s: expected %s, got %s', split_part(p_case, ' ', 1), p_want, coalesce(p_got, 'nothing')), true);
	end if;
end $$;
-- Cases as (name, got, expected) triples, noted after any undo (an undone block would undo its notes).
create function pg_temp.a3_cases(p_cases text[]) returns void language plpgsql as $$
begin
	if coalesce(cardinality(p_cases), 0) % 3 <> 0 then raise exception 'A3 cases come in triples: %', p_cases; end if;
	for i in 1 .. coalesce(cardinality(p_cases), 0) / 3 loop
		perform pg_temp.a3_case(p_cases[3 * i - 2], p_cases[3 * i - 1], p_cases[3 * i]);
	end loop;
end $$;
create function pg_temp.a3_binding(p_name text) returns jsonb language sql as $$
	select current_setting('qorpera_test.' || p_name)::jsonb
$$;
select set_config('qorpera_test.a3_failed', '', true) \g /dev/null
select set_config('qorpera_test.a3_cases', '', true) \g /dev/null

-- 1. The first attempt is no resume. It raises cards 1 to 4 (the owner approves 1, 2 and 3 while the call holds;
--    action 2 gets a newer card, still waiting), uses approval 3, and records an allow, a deny and decide_routine's ask
--    (no card). Kept, for the next attempt to meet. A new ask and the use of approval 1 go through too, undone.
do $$
declare v_binding jsonb := pg_temp.a3_binding('base_binding'); v text[] := '{}';
begin
	v := v || array['01 first attempt: card 1', pg_temp.a3_record(v_binding, 'a3-u1', '1', 'ask', true), pg_temp.a3_carded()];
	perform pg_temp.a3_answer('a3-u1');
	v := v || array['02 first attempt: card 2', pg_temp.a3_record(v_binding, 'a3-u2', '2', 'ask', true), pg_temp.a3_carded()];
	perform set_config('qorpera_test.a3_u2_input', pg_temp.a3_answer('a3-u2') ->> 'inputId', true);
	v := v || array['03 first attempt: a newer card of action 2', pg_temp.a3_record(v_binding, 'a3-u2n', '2', 'ask', true),
		pg_temp.a3_carded()];
	v := v || array['04 first attempt: action 2 holds on its newer card', pg_temp.a3_begin(v_binding, '2'), 'ok:pending|none|none'];
	v := v || array['05 first attempt: card 3', pg_temp.a3_record(v_binding, 'a3-u3', '3', 'ask', true), pg_temp.a3_carded()];
	perform pg_temp.a3_answer('a3-u3');
	v := v || array['06 first attempt: uses approval 3', pg_temp.a3_begin(v_binding, '3', true), pg_temp.a3_consumed()];
	v := v || array['07 first attempt: card 4', pg_temp.a3_record(v_binding, 'a3-u4', '4', 'ask', true), pg_temp.a3_carded()];
	v := v || array['08 first attempt: card 4''s replay', pg_temp.a3_record(v_binding, 'a3-u4', '4', 'ask', true),
		'ok:ask:true|none|none'];
	v := v || array['09 first attempt: action 4 holds on card 4', pg_temp.a3_begin(v_binding, '4'), 'ok:pending|none|none'];
	v := v || array['10 first attempt: action 5 is reviewed', pg_temp.a3_begin(v_binding, '5'), 'ok:review|none|none'];
	v := v || array['11 first attempt: an allow', pg_temp.a3_record(v_binding, 'a3-k3', '7', 'allow', true),
		pg_temp.a3_reviewed('allow')];
	v := v || array['12 first attempt: a deny', pg_temp.a3_record(v_binding, 'a3-k1', '6', 'deny', true), pg_temp.a3_reviewed('deny')];
	v := v || array['13 first attempt: action 6 is declined', pg_temp.a3_begin(v_binding, '6'), 'ok:declined|none|none'];
	v := v || array['14 first attempt: decide_routine''s ask, no card', pg_temp.a3_record(v_binding, 'a3-k4', '8', 'ask', true,
		false, 'decide_routine'), 'ok:ask:false|qorpera_action_reviews+1|none'];
	v := v || array['15 first attempt: a new ask (undone)', pg_temp.a3_record(v_binding, 'a3-u5x', '5', 'ask'), pg_temp.a3_carded()];
	v := v || array['16 first attempt: uses approval 1 (undone)', pg_temp.a3_begin(v_binding, '1'), pg_temp.a3_consumed()];
	perform pg_temp.a3_cases(v);
end
$$;

-- 2. The cut-off (as 466 §4), then the next attempt, on the same run and job, starts and records nothing.
do $$
begin
	perform pg_temp.rr_expire((pg_temp.a3_binding('base_binding') ->> 'jobId')::uuid);
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
	perform set_config('qorpera_test.a3_next', v_next::text, true);
end
$$;

-- 3. Before it records, the next attempt uses no approval, holds on no card and asks for no new review: begin is
--    refused for approval 1 (unused), for action 3 (its approval used, so a new review) and action 5 (never reviewed),
--    and for action 4 (its card waits); record is refused for a new ask, allow, deny or decide_routine's ask, and for
--    the replay of a review with a card (cards 1 and 4). A record whose values are wrong (an unknown decision, an
--    apply_proposal call that names no proposal) is refused for them first, as before: only reads lie between those
--    checks and the fence.
do $$
declare v_next jsonb := pg_temp.a3_binding('a3_next');
begin
	perform pg_temp.a3_cases(array[
		'17 unrecorded: approval 1', pg_temp.a3_begin(v_next, '1'), pg_temp.a3_refused(),
		'18 unrecorded: card 1''s replay', pg_temp.a3_record(v_next, 'a3-u1', '1', 'ask'), pg_temp.a3_refused(),
		'19 unrecorded: action 3, its approval used', pg_temp.a3_begin(v_next, '3'), pg_temp.a3_refused(),
		'20 unrecorded: a new ask of action 3', pg_temp.a3_record(v_next, 'a3-u3b', '3', 'ask'), pg_temp.a3_refused(),
		'21 unrecorded: action 4, its card waiting', pg_temp.a3_begin(v_next, '4'), pg_temp.a3_refused(),
		'22 unrecorded: card 4''s replay', pg_temp.a3_record(v_next, 'a3-u4', '4', 'ask'), pg_temp.a3_refused(),
		'23 unrecorded: action 5, never reviewed', pg_temp.a3_begin(v_next, '5'), pg_temp.a3_refused(),
		'24 unrecorded: a new ask', pg_temp.a3_record(v_next, 'a3-u5a', '5', 'ask'), pg_temp.a3_refused(),
		'25 unrecorded: a new allow', pg_temp.a3_record(v_next, 'a3-u5b', '9', 'allow'), pg_temp.a3_refused(),
		'26 unrecorded: a new deny', pg_temp.a3_record(v_next, 'a3-u5c', 'a', 'deny'), pg_temp.a3_refused(),
		'27 unrecorded: decide_routine''s new ask', pg_temp.a3_record(v_next, 'a3-u5d', 'b', 'ask', false, false, 'decide_routine'),
			pg_temp.a3_refused(),
		'28 unrecorded: a new review with an unknown decision', pg_temp.a3_record(v_next, 'a3-u5e', 'c', 'maybe'),
			'22023 Action review record is invalid|none|none',
		'28b unrecorded: an apply_proposal call that names no proposal', pg_temp.a3_record(v_next, 'a3-u5f', 'c', 'ask',
			false, false, 'apply_proposal'), '22023 Action review record is invalid|none|none']);
end
$$;

-- 3b. The approval of the card whose answer woke the run (as 677): with the run's wake made the answer to card 2, the
--     unrecorded attempt's begin for action 2 is refused where it would use that approval (not held on the newer
--     card), and once another call has used it, it answers 'used', as before. Undone.
do $$
declare v_next jsonb := pg_temp.a3_binding('a3_next'); v text[] := '{}';
begin
	begin
		v := v || array['29w the run''s room wakes', (select count(*) from public.qorpera_wake_occurrences
			where run_id = pg_temp.rr_run() and source_kind = 'room')::text, '1'];
		perform set_config('session_replication_role', 'replica', true);
		update public.qorpera_wake_occurrences set source_id = current_setting('qorpera_test.a3_u2_input')::uuid
		where run_id = pg_temp.rr_run() and source_kind = 'room';
		perform set_config('session_replication_role', 'origin', true);
		v := v || array['29 unrecorded, woken by card 2''s answer: approval 2', pg_temp.a3_begin(v_next, '2'), pg_temp.a3_refused()];
		perform set_config('session_replication_role', 'replica', true);
		update public.qorpera_action_reviews set consumed_at = clock_timestamp(), consumed_run_id = extensions.gen_random_uuid()
		where id = pg_temp.a3_review('a3-u2');
		perform set_config('session_replication_role', 'origin', true);
		v := v || array['30 unrecorded, woken: approval 2 used by another call', pg_temp.a3_begin(v_next, '2'), 'ok:used|none|none'];
		raise exception using errcode = 'A3001';
	exception when sqlstate 'A3001' then null;
	end;
	perform pg_temp.a3_cases(v);
end
$$;

-- 3c. What the unrecorded attempt repeats or is refused for anyway answers as before, with no write: the denial, the
--     replay of the deny, the allow and decide_routine's ask (no card), other content under a call (23505), and a
--     request of the wrong shape (22023).
do $$
declare v_next jsonb := pg_temp.a3_binding('a3_next');
begin
	perform pg_temp.a3_cases(array[
		'31 unrecorded: action 6 is declined', pg_temp.a3_begin(v_next, '6'), 'ok:declined|none|none',
		'32 unrecorded: the deny''s replay', pg_temp.a3_record(v_next, 'a3-k1', '6', 'deny'), 'ok:deny:false|none|none',
		'33 unrecorded: the allow''s replay', pg_temp.a3_record(v_next, 'a3-k3', '7', 'allow'), 'ok:allow:false|none|none',
		'34 unrecorded: decide_routine''s ask replay', pg_temp.a3_record(v_next, 'a3-k4', '8', 'ask', false, false, 'decide_routine'),
			'ok:ask:false|none|none',
		'35 unrecorded: other content under a call', pg_temp.a3_record(v_next, 'a3-k3', 'd', 'allow'),
			'23505 This call was already reviewed with other content|none|none',
		'36 unrecorded: a record of the wrong shape', pg_temp.a3_record_request(v_next, '{"callId":"a3-bad"}'),
			'22023 Action review record is invalid|none|none',
		'37 unrecorded: a begin of the wrong shape', pg_temp.a3_begin(v_next, '5', false, false, 'Send-Email'),
			'22023 Action review request is invalid|none|none']);
end
$$;

-- 4. Authority is checked as before, ahead of the fence: the cut-off attempt is refused by the run check, and only the
--    service role begins or records. The functions keep their settings and grants.
do $$
declare v_old jsonb := pg_temp.a3_binding('base_binding'); v_next jsonb := pg_temp.a3_binding('a3_next');
begin
	perform pg_temp.a3_cases(array[
		'38 the cut-off attempt''s begin', pg_temp.a3_begin(v_old, '5'), '42501 Run is unavailable|none|none',
		'39 the cut-off attempt''s record', pg_temp.a3_record(v_old, 'a3-old', 'e', 'ask'), '42501 Run is unavailable|none|none',
		'40 a member''s begin', pg_temp.a3_begin(v_next, '5', false, true), '42501 native tool host authority is required|none|none',
		'41 a member''s record', pg_temp.a3_record(v_next, 'a3-member', 'e', 'ask', false, true),
			'42501 native tool host authority is required|none|none',
		'42 begin''s settings and grants', pg_temp.a3_grants('public.qorpera_begin_action_review(jsonb,jsonb)'),
			'secdef=t;config={"search_path=\"\""};owner=postgres;anon=f;authenticated=f;public=f;service_role=t',
		'43 record''s settings and grants', pg_temp.a3_grants('public.qorpera_record_action_review(jsonb,jsonb)'),
			'secdef=t;config={"search_path=\"\""};owner=postgres;anon=f;authenticated=f;public=f;service_role=t']);
end
$$;

-- 5. The fence asks for the resume only where it is about to write: with the cut-off's event one the resume read
--    refuses, begin for action 5 is refused with the read, while the denial and the replays above answer as before. A
--    run that does not resume from its receipts works as before, unrecorded: one that keeps a log, and one in Agent
--    tree mode (each uses approval 1, raises a new card, replays card 4 and holds on it, and reviews action 5). Undone.
do $$
declare v_next jsonb := pg_temp.a3_binding('a3_next'); v_run public.qorpera_execution_runs; v text[] := '{}';
begin
	begin
		perform set_config('session_replication_role', 'replica', true);
		update public.qorpera_execution_run_events set payload = payload - 'schema'
		where run_id = pg_temp.rr_run() and event_type = 'run_cut_off';
		perform set_config('session_replication_role', 'origin', true);
		v := v || array['44 the resume read refuses this cut-off', pg_temp.a3_try(format(
			'select public.qorpera_memory_run_resume_of(%L::uuid, %L::uuid, %L::uuid)::text', pg_temp.rr_run(),
			v_next ->> 'assignmentId', v_next ->> 'leaseId')), '55000 Run resume is unavailable|none|none'];
		v := v || array['45 unreadable resume: action 5', pg_temp.a3_begin(v_next, '5'), '55000 Run resume is unavailable|none|none'];
		v := v || array['46 unreadable resume: action 6 is declined', pg_temp.a3_begin(v_next, '6'), 'ok:declined|none|none'];
		v := v || array['47 unreadable resume: the deny''s replay', pg_temp.a3_record(v_next, 'a3-k1', '6', 'deny'),
			'ok:deny:false|none|none'];
		v := v || array['48 unreadable resume: the allow''s replay', pg_temp.a3_record(v_next, 'a3-k3', '7', 'allow'),
			'ok:allow:false|none|none'];
		v := v || array['49 unreadable resume: decide_routine''s ask replay', pg_temp.a3_record(v_next, 'a3-k4', '8', 'ask', false,
			false, 'decide_routine'), 'ok:ask:false|none|none'];
		begin
			select * into strict v_run from public.qorpera_execution_runs where id = pg_temp.rr_run();
			insert into public.qorpera_memory_run_logs(environment_id, run_id, session_id, run_path, run_key, toml_path_version, commit_id)
			values (v_run.environment_id, v_run.id, extensions.gen_random_uuid(), 'QorperaOS/agents/alice/runs/' || v_run.id,
				'qorperaos/agents/alice/runs/' || v_run.id, extensions.gen_random_uuid(), extensions.gen_random_uuid());
			perform pg_temp.base_assert(public.qorpera_run_resumes_from_receipts(v_run.id) is false,
				'a run with a log does not resume from receipts');
			v := v || array['50 a run with a log: approval 1', pg_temp.a3_begin(v_next, '1'), pg_temp.a3_consumed()];
			v := v || array['51 a run with a log: a new ask', pg_temp.a3_record(v_next, 'a3-l1', 'e', 'ask'), pg_temp.a3_carded()];
			v := v || array['52 a run with a log: card 4''s replay', pg_temp.a3_record(v_next, 'a3-u4', '4', 'ask'),
				'ok:ask:true|none|none'];
			v := v || array['53 a run with a log: action 4', pg_temp.a3_begin(v_next, '4'), 'ok:pending|none|none'];
			v := v || array['54 a run with a log: action 5', pg_temp.a3_begin(v_next, '5'), 'ok:review|none|none'];
			raise exception using errcode = 'A3001';
		exception when sqlstate 'A3001' then null;
		end;
		perform set_config('session_replication_role', 'replica', true);
		update public.qorpera_execution_runs set memory_mode = 'tree' where id = pg_temp.rr_run();
		perform set_config('session_replication_role', 'origin', true);
		perform pg_temp.base_assert(public.qorpera_run_resumes_from_receipts(pg_temp.rr_run()) is false,
			'a tree run does not resume from receipts');
		v := v || array['55 a tree run: approval 1', pg_temp.a3_begin(v_next, '1'), pg_temp.a3_consumed()];
		v := v || array['56 a tree run: a new ask', pg_temp.a3_record(v_next, 'a3-t1', 'e', 'ask'), pg_temp.a3_carded()];
		v := v || array['57 a tree run: card 4''s replay', pg_temp.a3_record(v_next, 'a3-u4', '4', 'ask'), 'ok:ask:true|none|none'];
		v := v || array['58 a tree run: action 4', pg_temp.a3_begin(v_next, '4'), 'ok:pending|none|none'];
		v := v || array['59 a tree run: action 5', pg_temp.a3_begin(v_next, '5'), 'ok:review|none|none'];
		raise exception using errcode = 'A3001';
	exception when sqlstate 'A3001' then null;
	end;
	perform pg_temp.a3_cases(v);
end
$$;

-- 6. Once it records what it was told (the unknown step, no steps read, as 466 §8), the attempt works as before: it
--    uses approval 1, replays card 1, holds on card 4 and raises a new card. Action 3, whose approval the first
--    attempt used, is reviewed afresh: the fence bounds the unrecorded attempt, not what a recorded one repeats.
do $$
declare v_next jsonb := pg_temp.a3_binding('a3_next'); v text[] := '{}';
begin
	perform pg_temp.base_claims('service_role');
	perform pg_temp.rr_record(v_next, jsonb_build_object('stepsRead', 0, 'unknownCalls', jsonb_build_array(
		jsonb_build_object('call', null, 'step', null, 'receiptId', current_setting('qorpera_test.rr_b')))));
	v := v || array['60 recorded: approval 1', pg_temp.a3_begin(v_next, '1'), pg_temp.a3_consumed()];
	v := v || array['61 recorded: card 1''s replay', pg_temp.a3_record(v_next, 'a3-u1', '1', 'ask'), 'ok:ask:true|none|none'];
	v := v || array['62 recorded: action 3 is reviewed afresh', pg_temp.a3_begin(v_next, '3'), 'ok:review|none|none'];
	v := v || array['63 recorded: a new ask', pg_temp.a3_record(v_next, 'a3-r1', 'f', 'ask'), pg_temp.a3_carded()];
	v := v || array['64 recorded: action 4', pg_temp.a3_begin(v_next, '4'), 'ok:pending|none|none'];
	perform pg_temp.a3_cases(v);
end
$$;

-- Every case, at once: each one ran, once, and matched.
do $$
declare v_cases text[] := array_remove(string_to_array(current_setting('qorpera_test.a3_cases'), E'\n'), '');
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.a3_failed') = '' and cardinality(v_cases) = 66
		and (select count(distinct c) from unnest(v_cases) c) = 66,
		format('%s cases ran (%s distinct) of 66; failed:%s', cardinality(v_cases),
			(select count(distinct c) from unnest(v_cases) c), current_setting('qorpera_test.a3_failed')));
end
$$;

set constraints all immediate;
rollback;
