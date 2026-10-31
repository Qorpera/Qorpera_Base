-- 20260930545000 (F9): a resumed attempt that has not recorded its resume makes no new send, card or rule
-- (WB-001 G1 b's follow-up; RC_A_RESUME_SEND_FENCE, RC_A_RESUME_CARD_FENCE, RC_A_RESUME_RULE_FENCE).
--
-- G1 b (20260930539000) lets a run in Agent notebooks with no log resume from its receipts, and refuses its resumed
-- attempt's first receipt until the attempt has recorded its resume (55000 'Run resume is not recorded'). Its header
-- says that meanwhile a resumed run on an older runtime "is refused at its first receipt and never repeats an effect".
-- That held only for effects that take a receipt. Three take none, so such an attempt still made them new, also after
-- its steps were refused:
-- - the agent send (qorpera_folder_send_agent_message, which every progress and final send reaches through
--   qorpera_send_native_agent_message): its send row, its session event, the event's company operation and its speaker;
-- - the interaction card (qorpera_folder_append_interaction_request, ask_member's card): its session event and the
--   event's company operation. A card raised before a refused final stayed;
-- - the "Ask first" rule (qorpera_folder_add_agent_review_rule): its rule row.
-- Now each refuses such an attempt with G1 b's 55000 before that effect. The check is G1 b's, read one step at a time:
-- the run resumes from its receipts, then this assignment has recorded no resume, then the run has a resume to record
-- (qorpera_memory_run_resume_of, which may also refuse, 55000 'Run resume is unavailable', as on the receipt path).
-- G1 b joins the first two in one condition (20260930539000:161); here they are nested, so the resume row is read only
-- for a run that resumes from its receipts, and the resume only when there is no row.
-- Where each check sits, by the line before it and the line after it (20260928279560's lines):
-- - the send: after the read recheck, `perform public.qorpera_folder_run_reads_current(...)` (:172); before
--   "-- The run's session, FOR UPDATE, before the first session write (C1C §5.6)." (:173) and the session lock (:174).
--   So after the run check, the plain checks, the same-key replay, 'already final', the wake policy (its phases,
--   budget and acknowledgement) and the recheck; before the session lock and the send row.
-- - the card: after the read recheck, the same line (:220); before the session lock,
--   `perform 1 from public.qorpera_shared_sessions where id = v_run.session_id for update;` (:221). So after the run
--   check, the request checks and the group-chat check; before the session lock and the transcript append. It is
--   skipped when an event with the card's id already exists: the append then returns that event, or refuses other
--   content (23505), as before.
-- - the rule: after `if not found then` (:368); before `begin` (:369) and its insert (:370). So after the run check
--   (with the member lock), the recheck, the wake's work gate, the company-agent check, the request check, the same-key
--   replay (added false), other text under the key (23505) and the same rule's text (added false); before the insert.
-- Unchanged: who may call (the service role, through the run's live lease and binding: an attempt a newer one replaced
-- is refused 42501 before these checks); every earlier check, its order and its error; the replays; the run locks and
-- their order; an original attempt, a recorded resume, a run that keeps a log, a run in Agent tree mode and a coding
-- session's turn; the tables, the grants and the data. G1 b's file stays as written.
-- Limits:
-- - The read recheck (qorpera_folder_run_reads_current) runs before each check, and when a read changed it rewrites the
--   run's read set (its own bookkeeping). A refused call rolls that back with the call; a call that goes through, a
--   replay among them, keeps it, as today. This migration does not fence it.
-- - Only these three effects are fenced; this migration claims nothing about any other effect.
-- - The three paths are traced from the source and shown on synthetic fixtures (SQL test 508); nothing was seen live.
--   What the runtime does after a refused final is not settled here.
-- The pre-check refuses unless each of the three bodies is exactly 20260928279560's (the send's and the card's with
-- 20260928549450's changes), and each anchor must occur once. The catalog check refuses unless exactly these three
-- public functions changed, only in their bodies, each by its one replacement, and no public function came or went.
-- Deploy order: either. It reads only what G1 b added.
-- Every inserted text names this migration (20260930545000), for the deploy guard.

do $$
declare v record;
begin
	if exists (select 1 from pg_proc where oid in (
			to_regprocedure('public.qorpera_folder_send_agent_message(jsonb,text,text,text)'),
			to_regprocedure('public.qorpera_folder_append_interaction_request(jsonb,uuid,jsonb)'),
			to_regprocedure('public.qorpera_folder_add_agent_review_rule(jsonb,jsonb)'))
		and strpos(prosrc, '20260930545000') > 0) then
		raise exception '20260930545000 (F9) is already applied'; end if;
	if to_regprocedure('public.qorpera_memory_run_resume_receipts(jsonb)') is null
		or to_regprocedure('public.qorpera_run_resumes_from_receipts(uuid)') is null
		or to_regprocedure('public.qorpera_memory_run_resume_of(uuid,uuid,uuid)') is null then
		raise exception '20260930545000 (F9) needs G1 b (20260930539000)'; end if;
	-- The bodies it replaces, by their md5: anything else refuses this migration.
	for v in select * from (values
		('public.qorpera_folder_send_agent_message(jsonb,text,text,text)', '63eeda567e04644291b6e501a646c88a'),
		('public.qorpera_folder_append_interaction_request(jsonb,uuid,jsonb)', 'd5bd6332d5d02874fe9014cd6c7752e5'),
		('public.qorpera_folder_add_agent_review_rule(jsonb,jsonb)', '4d78bd88041a9b9bd88d48abbfd3e37a')) as pinned(signature, source)
	loop
		if md5(coalesce((select prosrc from pg_proc where oid = to_regprocedure(v.signature)), '')) <> v.source then
			raise exception '20260930545000 (F9): % differs from 20260928279560 (with 20260928549450)', v.signature; end if;
	end loop;
end $$;

set local lock_timeout = '3s';

-- The catalog check's baseline: every public function's catalog row apart from its body, and its body's md5.
create temporary table f9_before as
select p.oid, to_jsonb(p) - 'prosrc' as fields, md5(p.prosrc) as source, null::text as expected
from pg_proc as p where p.pronamespace = 'public'::regnamespace;

create function pg_temp.f9_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930545000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	-- What the catalog check expects: the body with exactly this one replacement.
	update pg_temp.f9_before as prior set expected = md5(replace(
		(select p.prosrc from pg_proc as p where p.oid = p_function), p_old, p_new)) where prior.oid = p_function;
	execute replace(v_definition, p_old, p_new);
end $$;

-- No new send before the record ---------------------------------------------------------------------------------------

select pg_temp.f9_replace('public.qorpera_folder_send_agent_message(jsonb,text,text,text)'::regprocedure,
	$old$	perform public.qorpera_folder_run_reads_current(v_run.environment_id, v_run.profile_id, v_tool -> 'resolved');
	-- The run's session, FOR UPDATE, before the first session write (C1C §5.6).
$old$,
	$new$	perform public.qorpera_folder_run_reads_current(v_run.environment_id, v_run.profile_id, v_tool -> 'resolved');
	-- 20260930545000 (F9): a resumed attempt of a run with no log sends nothing new before it records its resume.
	if public.qorpera_run_resumes_from_receipts(v_run.id) then
		if not exists (select 1 from public.qorpera_memory_run_resumes as resume
			where resume.run_id = v_run.id and resume.assignment_id = (p_binding ->> 'assignmentId')::uuid) then
			if public.qorpera_memory_run_resume_of(v_run.id, (p_binding ->> 'assignmentId')::uuid,
				(p_binding ->> 'leaseId')::uuid) is not null then
				raise exception 'Run resume is not recorded' using errcode = '55000'; end if;
		end if;
	end if;
	-- The run's session, FOR UPDATE, before the first session write (C1C §5.6).
$new$);

-- No new card before the record ---------------------------------------------------------------------------------------

select pg_temp.f9_replace('public.qorpera_folder_append_interaction_request(jsonb,uuid,jsonb)'::regprocedure,
	$old$	perform public.qorpera_folder_run_reads_current(v_run.environment_id, v_run.profile_id, v_tool -> 'resolved');
	perform 1 from public.qorpera_shared_sessions where id = v_run.session_id for update;
$old$,
	$new$	perform public.qorpera_folder_run_reads_current(v_run.environment_id, v_run.profile_id, v_tool -> 'resolved');
	-- 20260930545000 (F9): a resumed attempt of a run with no log raises no new card before it records its resume. An
	-- event id already in use goes on to the append as before: it returns that event, or refuses other content (23505).
	if not exists (select 1 from public.qorpera_session_events as event where event.event_id = p_event_id) then
		if public.qorpera_run_resumes_from_receipts(v_run.id) then
			if not exists (select 1 from public.qorpera_memory_run_resumes as resume
				where resume.run_id = v_run.id and resume.assignment_id = (p_binding ->> 'assignmentId')::uuid) then
				if public.qorpera_memory_run_resume_of(v_run.id, (p_binding ->> 'assignmentId')::uuid,
					(p_binding ->> 'leaseId')::uuid) is not null then
					raise exception 'Run resume is not recorded' using errcode = '55000'; end if;
			end if;
		end if;
	end if;
	perform 1 from public.qorpera_shared_sessions where id = v_run.session_id for update;
$new$);

-- No new rule before the record ---------------------------------------------------------------------------------------

select pg_temp.f9_replace('public.qorpera_folder_add_agent_review_rule(jsonb,jsonb)'::regprocedure,
	$old$		if not found then
			begin
$old$,
	$new$		if not found then
			-- 20260930545000 (F9): a resumed attempt of a run with no log adds no new rule before it records its resume.
			if public.qorpera_run_resumes_from_receipts(v_run.id) then
				if not exists (select 1 from public.qorpera_memory_run_resumes as resume
					where resume.run_id = v_run.id and resume.assignment_id = (p_binding ->> 'assignmentId')::uuid) then
					if public.qorpera_memory_run_resume_of(v_run.id, (p_binding ->> 'assignmentId')::uuid,
						(p_binding ->> 'leaseId')::uuid) is not null then
						raise exception 'Run resume is not recorded' using errcode = '55000'; end if;
				end if;
			end if;
			begin
$new$);

-- The deploy guard ----------------------------------------------------------------------------------------------------

-- In each function the marker occurs once, and these texts' first occurrences come in this order.
do $guard$
declare v record; v_source text; v_at integer; v_next integer;
begin
	for v in select * from (values
		('public.qorpera_folder_send_agent_message(jsonb,text,text,text)', array['agent send key is bound to different content',
			'agent public output is already final', 'wake requires an acknowledgement', 'qorpera_folder_run_reads_current',
			'20260930545000', 'for update', 'insert into public.qorpera_agent_sends']),
		('public.qorpera_folder_append_interaction_request(jsonb,uuid,jsonb)', array['cards are not raised in a group chat',
			'qorpera_folder_run_reads_current', '20260930545000', 'for update', 'qorpera_folder_append_transcript_event']),
		('public.qorpera_folder_add_agent_review_rule(jsonb,jsonb)', array['qorpera_folder_run_reads_current',
			'qorpera_assert_wake_work_allowed', 'This operation key already added another rule',
			'lower(rule.when_text) = lower(v_text)', '20260930545000', 'insert into public.qorpera_review_rules'])) as guard(signature, texts)
	loop
		v_source := (select prosrc from pg_proc where oid = v.signature::regprocedure);
		if (length(v_source) - length(replace(v_source, '20260930545000', ''))) / length('20260930545000') <> 1 then
			raise exception '20260930545000 marker is not once in %', v.signature; end if;
		v_at := 0;
		for i in 1 .. cardinality(v.texts) loop
			v_next := strpos(v_source, v.texts[i]);
			if v_next <= v_at then
				raise exception '20260930545000 check is out of place in %: %', v.signature, v.texts[i]; end if;
			v_at := v_next;
		end loop;
	end loop;
end $guard$;

-- The catalog check ---------------------------------------------------------------------------------------------------

-- Exactly the three functions changed, each only in its body and by its one replacement; every other public function
-- is as it was, and none came or went.
do $$ begin
	if (select count(*) from pg_temp.f9_before where expected is not null) <> 3
		or exists (select 1 from pg_temp.f9_before as prior where prior.expected is not null and prior.oid not in (
			'public.qorpera_folder_send_agent_message(jsonb,text,text,text)'::regprocedure,
			'public.qorpera_folder_append_interaction_request(jsonb,uuid,jsonb)'::regprocedure,
			'public.qorpera_folder_add_agent_review_rule(jsonb,jsonb)'::regprocedure))
		or exists (select 1 from pg_temp.f9_before as prior left join pg_proc as patched on patched.oid = prior.oid
			where patched.oid is null or to_jsonb(patched) - 'prosrc' is distinct from prior.fields
				or md5(patched.prosrc) is distinct from coalesce(prior.expected, prior.source)
				or prior.expected = prior.source)
		or exists (select 1 from pg_proc as p where p.pronamespace = 'public'::regnamespace
			and p.oid not in (select prior.oid from pg_temp.f9_before as prior)) then
		raise exception '20260930545000: the catalog did not change as expected'; end if;
end $$;

drop function pg_temp.f9_replace(regprocedure, text, text);
drop table pg_temp.f9_before;
