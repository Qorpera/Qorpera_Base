-- 20260930546000 (A3): a resumed attempt that has not recorded its resume uses no approval and gets no new review,
-- card or email (RC_A_RESUME_REVIEW_CARD_FENCE, A2-1; RC_A_RESUME_MAIL_FENCE, 4a-1).
--
-- G1 b (20260930539000) refuses a resumed attempt's first receipt until the attempt has recorded its resume (55000
-- 'Run resume is not recorded'). Its header (:27-28) says that meanwhile a resumed run on an older runtime "is refused
-- at its first receipt and never repeats an effect". F9 (20260930545000) fenced three effects that take no receipt,
-- and its header (:7) says "Three take none". Both say too much: G1 b's claim held only for effects that take a
-- receipt, and more than those three take none. Before its first receipt, such an attempt still:
-- - used an approval: qorpera_begin_action_review answered 'approved' and marked the approval used (consumed_at and
--   consumed_run_id), for the woken run's own card (20260930489000) or for the latest answered review of the action;
-- - was held on a waiting card: begin answered 'pending', and the runtime holds the call there and awaits the answer;
-- - got a new review: begin answered 'review', and qorpera_record_action_review wrote a new review row and, for an ask
--   with a card, the card (its transcript entry: a session event and the event's company operation). The replay of an
--   ask with a card answered with that card, and the runtime holds on it;
-- - queued a new email: qorpera_send_agent_mail wrote an outbox row and its mail thread.
-- Now each refuses such an attempt with G1 b's 55000 at the points below, before its first new write and before an
-- approval is used. The check is F9's, nested the same way: the run resumes from its receipts, then this assignment
-- has recorded no resume, then the run has a resume to record (qorpera_memory_run_resume_of, which may also refuse,
-- 55000 'Run resume is unavailable').
-- Where each check sits (20260926130000's lines unless named):
-- - begin, four points: inside the woken run's own card with its approval unused (20260930489000's
--   `if found and v_review.consumed_at is null then`), before its update; inside the latest answered, unused review
--   (:303), before its update (:304); inside the waiting card (:308), before 'pending' (:309); and after the last
--   `end if;` (:319), before the agent is read (:320) and 'review' (:322). So after the run check, the request check
--   and the review reads (a row lock they take is released with the refusal). A denial ('declined') and an approval
--   another call used ('used') answer as before.
-- - record, two points: in the replay of the same call (:372-375), after the other-content check (23505), only for an
--   ask with a card (every other replay answers as before); and before 20260928279560's
--   `if v_card and public.qorpera_environment_is_folder_v2(...)` (its :431), so before a card's read recheck and
--   conversation lock, the review insert (:447) and the card. Every check of the record's shape and values comes first,
--   with its error as before (:353-369, :383-386 and P40's apply_proposal check, 20260928489240:351-353): only reads
--   lie between them and this point.
-- - mail, one point: after the folder-v2 attachment refusal (0A000, 20260928429984:367-368), before the rest of the
--   attachments (its :369-388). So after the run check, the request checks, the same call's replay and the mailbox
--   checks. The rest of the attachments, the recipient limits (54000) and the check that nothing goes out as if from
--   Qorpera (42501) stay after it: for a company outside folder-v2 the attachment loop records the run's reads first
--   (qorpera_company_path_remember_read, 20260928429984:371), a write.
-- Unchanged: who may call (the service role, through the run's live lease and binding: an attempt a newer one replaced
-- is refused 42501 before these checks); every earlier check, its order and its error; the replays not named above,
-- read-only as before; the run and row locks and their order; an original attempt, a recorded resume, a run that keeps
-- a log and a run in Agent tree mode; the tables, the grants, the settings and the data. G1 b's and F9's files stay
-- as written.
-- Limits:
-- - Only these effects are fenced; this migration claims nothing about any other effect. After a denial ('declined',
--   or the replay of a deny record) the runtime may close the proposal an apply_proposal call names
--   (qorpera_folder_close_proposal, 20260928489240:576-591). That close is not fenced here.
-- - A recorded resume goes on as before. The fences hold an attempt only until it records its resume; they do not make
--   a resumed run's effects exactly-once.
-- - The paths are traced from the source and shown on synthetic fixtures (SQL tests 509 and 546); nothing was seen
--   live, and no email was sent.
-- The pre-check refuses unless each of the three bodies is exactly the one it replaces, by md5 (begin: 20260926130000's
-- with 20260930489000's changes; record: 20260926130000's with those of 20260926210000, 20260928279560,
-- 20260928399940, 20260928489240 and 20260928549450; mail: 20260928309740's with those of 20260928319810,
-- 20260928429982, 20260928429984, 20260928439980 and 20260930521000), and each anchor must occur once. The catalog
-- check refuses unless exactly these three public functions changed, only in their bodies, each by its replacements,
-- and no public function came or went.
-- Deploy order: either. The checks' only new reads are qorpera_run_resumes_from_receipts, which G1 b (20260930539000)
-- added, and qorpera_memory_run_resumes and qorpera_memory_run_resume_of, which W5b-2 (20260928559130) added. Both
-- are earlier migrations.
-- Every inserted text names this migration (20260930546000), for the deploy guard.

do $$
declare v record;
begin
	if exists (select 1 from pg_proc where oid in (
			to_regprocedure('public.qorpera_begin_action_review(jsonb,jsonb)'),
			to_regprocedure('public.qorpera_record_action_review(jsonb,jsonb)'),
			to_regprocedure('public.qorpera_send_agent_mail(jsonb,text,jsonb)'))
		and strpos(prosrc, '20260930546000') > 0) then
		raise exception '20260930546000 (A3) is already applied'; end if;
	if to_regprocedure('public.qorpera_memory_run_resume_receipts(jsonb)') is null
		or to_regprocedure('public.qorpera_run_resumes_from_receipts(uuid)') is null
		or to_regprocedure('public.qorpera_memory_run_resume_of(uuid,uuid,uuid)') is null then
		raise exception '20260930546000 (A3) needs G1 b (20260930539000)'; end if;
	-- The bodies it replaces, by their md5: anything else refuses this migration.
	for v in select * from (values
		('public.qorpera_begin_action_review(jsonb,jsonb)', 'd3fbb150f53d390ea8787b42120b9ca3'),
		('public.qorpera_record_action_review(jsonb,jsonb)', '29a80d707aa3bddd1b7a7c7df8701353'),
		('public.qorpera_send_agent_mail(jsonb,text,jsonb)', 'b412e6dcccfe8890c8244620a073d5cd')) as pinned(signature, source)
	loop
		if md5(coalesce((select prosrc from pg_proc where oid = to_regprocedure(v.signature)), '')) <> v.source then
			raise exception '20260930546000 (A3): % differs from its pinned body', v.signature; end if;
	end loop;
end $$;

set local lock_timeout = '3s';

-- The catalog check's baseline: every public function's catalog row apart from its body, and its body's md5.
create temporary table a3_before as
select p.oid, to_jsonb(p) - 'prosrc' as fields, md5(p.prosrc) as source, null::text as expected
from pg_proc as p where p.pronamespace = 'public'::regnamespace;

create function pg_temp.a3_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930546000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	-- What the catalog check expects: the body with this replacement and the ones before it.
	update pg_temp.a3_before as prior set expected = md5(replace(
		(select p.prosrc from pg_proc as p where p.oid = p_function), p_old, p_new)) where prior.oid = p_function;
	execute replace(v_definition, p_old, p_new);
end $$;

-- Begin: no approval used, no hold and no new review before the record ------------------------------------------------

select pg_temp.a3_replace('public.qorpera_begin_action_review(jsonb,jsonb)'::regprocedure,
	$old$	if found and v_review.consumed_at is null then
$old$,
	$new$	if found and v_review.consumed_at is null then
		-- 20260930546000 (A3): a resumed attempt of a run with no log uses no approval before it records its resume.
		if public.qorpera_run_resumes_from_receipts(v_run.id) then
			if not exists (select 1 from public.qorpera_memory_run_resumes as resume
				where resume.run_id = v_run.id and resume.assignment_id = (p_binding ->> 'assignmentId')::uuid) then
				if public.qorpera_memory_run_resume_of(v_run.id, (p_binding ->> 'assignmentId')::uuid,
					(p_binding ->> 'leaseId')::uuid) is not null then
					raise exception 'Run resume is not recorded' using errcode = '55000'; end if;
			end if;
		end if;
$new$);

select pg_temp.a3_replace('public.qorpera_begin_action_review(jsonb,jsonb)'::regprocedure,
	$old$	elsif found and v_review.answer is not null and v_review.consumed_at is null then
$old$,
	$new$	elsif found and v_review.answer is not null and v_review.consumed_at is null then
		-- 20260930546000 (A3): a resumed attempt of a run with no log uses no approval before it records its resume.
		if public.qorpera_run_resumes_from_receipts(v_run.id) then
			if not exists (select 1 from public.qorpera_memory_run_resumes as resume
				where resume.run_id = v_run.id and resume.assignment_id = (p_binding ->> 'assignmentId')::uuid) then
				if public.qorpera_memory_run_resume_of(v_run.id, (p_binding ->> 'assignmentId')::uuid,
					(p_binding ->> 'leaseId')::uuid) is not null then
					raise exception 'Run resume is not recorded' using errcode = '55000'; end if;
			end if;
		end if;
$new$);

select pg_temp.a3_replace('public.qorpera_begin_action_review(jsonb,jsonb)'::regprocedure,
	$old$	elsif found and v_review.answer is null then
$old$,
	$new$	elsif found and v_review.answer is null then
		-- 20260930546000 (A3): a resumed attempt of a run with no log is not held on a waiting card before it records its
		-- resume (the runtime would hold the call there and use the answer).
		if public.qorpera_run_resumes_from_receipts(v_run.id) then
			if not exists (select 1 from public.qorpera_memory_run_resumes as resume
				where resume.run_id = v_run.id and resume.assignment_id = (p_binding ->> 'assignmentId')::uuid) then
				if public.qorpera_memory_run_resume_of(v_run.id, (p_binding ->> 'assignmentId')::uuid,
					(p_binding ->> 'leaseId')::uuid) is not null then
					raise exception 'Run resume is not recorded' using errcode = '55000'; end if;
			end if;
		end if;
$new$);

select pg_temp.a3_replace('public.qorpera_begin_action_review(jsonb,jsonb)'::regprocedure,
	$old$	select staff.* into v_agent from public.qorpera_profile_staff as staff
$old$,
	$new$	-- 20260930546000 (A3): a resumed attempt of a run with no log gets no new review before it records its resume. A
	-- denial and an approval another call used answer as before.
	if public.qorpera_run_resumes_from_receipts(v_run.id) then
		if not exists (select 1 from public.qorpera_memory_run_resumes as resume
			where resume.run_id = v_run.id and resume.assignment_id = (p_binding ->> 'assignmentId')::uuid) then
			if public.qorpera_memory_run_resume_of(v_run.id, (p_binding ->> 'assignmentId')::uuid,
				(p_binding ->> 'leaseId')::uuid) is not null then
				raise exception 'Run resume is not recorded' using errcode = '55000'; end if;
		end if;
	end if;
	select staff.* into v_agent from public.qorpera_profile_staff as staff
$new$);

-- Record: no hold on a card and no new review, card or transcript entry before the record -----------------------------

select pg_temp.a3_replace('public.qorpera_record_action_review(jsonb,jsonb)'::regprocedure,
	$old$		return public.qorpera_action_review_receipt(v_existing);
$old$,
	$new$		-- 20260930546000 (A3): the replay of an ask with a card holds the call on that card, so a resumed attempt
		-- of a run with no log is refused it before it records its resume. Every other replay answers as before.
		if v_existing.decision = 'ask' and v_existing.card_session_id is not null then
			if public.qorpera_run_resumes_from_receipts(v_run.id) then
				if not exists (select 1 from public.qorpera_memory_run_resumes as resume
					where resume.run_id = v_run.id and resume.assignment_id = (p_binding ->> 'assignmentId')::uuid) then
					if public.qorpera_memory_run_resume_of(v_run.id, (p_binding ->> 'assignmentId')::uuid,
						(p_binding ->> 'leaseId')::uuid) is not null then
						raise exception 'Run resume is not recorded' using errcode = '55000'; end if;
				end if;
			end if;
		end if;
		return public.qorpera_action_review_receipt(v_existing);
$new$);

select pg_temp.a3_replace('public.qorpera_record_action_review(jsonb,jsonb)'::regprocedure,
	$old$	if v_card and public.qorpera_environment_is_folder_v2(v_run.environment_id) then
$old$,
	$new$	-- 20260930546000 (A3): a resumed attempt of a run with no log records no new review, card or transcript entry
	-- before it records its resume. The record's checks come first; only reads lie between them and here.
	if public.qorpera_run_resumes_from_receipts(v_run.id) then
		if not exists (select 1 from public.qorpera_memory_run_resumes as resume
			where resume.run_id = v_run.id and resume.assignment_id = (p_binding ->> 'assignmentId')::uuid) then
			if public.qorpera_memory_run_resume_of(v_run.id, (p_binding ->> 'assignmentId')::uuid,
				(p_binding ->> 'leaseId')::uuid) is not null then
				raise exception 'Run resume is not recorded' using errcode = '55000'; end if;
		end if;
	end if;
	if v_card and public.qorpera_environment_is_folder_v2(v_run.environment_id) then
$new$);

-- Mail: no new email before the record --------------------------------------------------------------------------------

select pg_temp.a3_replace('public.qorpera_send_agent_mail(jsonb,text,jsonb)'::regprocedure,
	$old$			raise exception 'Attaching files from this company''s folder is not built yet' using errcode = '0A000'; end if;
		v_actor := public.qorpera_company_path_actor(v_run.environment_id, p_binding);
$old$,
	$new$			raise exception 'Attaching files from this company''s folder is not built yet' using errcode = '0A000'; end if;
	end if;
	-- 20260930546000 (A3): a resumed attempt of a run with no log queues no new email before it records its resume. It
	-- comes before the rest of the attachments: for a company outside folder-v2 they record the run's reads first.
	if public.qorpera_run_resumes_from_receipts(v_run.id) then
		if not exists (select 1 from public.qorpera_memory_run_resumes as resume
			where resume.run_id = v_run.id and resume.assignment_id = (p_binding ->> 'assignmentId')::uuid) then
			if public.qorpera_memory_run_resume_of(v_run.id, (p_binding ->> 'assignmentId')::uuid,
				(p_binding ->> 'leaseId')::uuid) is not null then
				raise exception 'Run resume is not recorded' using errcode = '55000'; end if;
		end if;
	end if;
	if jsonb_array_length(coalesce(p_request -> 'attachments', '[]')) > 0 then
		v_actor := public.qorpera_company_path_actor(v_run.environment_id, p_binding);
$new$);

-- The deploy guard ----------------------------------------------------------------------------------------------------

-- In each function the marker occurs as often as it was inserted, and these texts come in this order, each found
-- after the one before it.
do $guard$
declare v record; v_source text; v_at integer; v_next integer;
begin
	for v in select * from (values
		('public.qorpera_begin_action_review(jsonb,jsonb)', 4, array['Action review request is invalid',
			'20260930489000', 'if found and v_review.consumed_at is null then', '20260930546000', 'set consumed_at',
			'''state'', ''used''', 'The latest review of exactly this action', '''state'', ''declined''',
			'v_review.answer is not null and v_review.consumed_at is null then', '20260930546000', 'set consumed_at',
			'v_review.answer is null then', '20260930546000', '''state'', ''pending''', '20260930546000',
			'select staff.* into v_agent', '''state'', ''review''']),
		('public.qorpera_record_action_review(jsonb,jsonb)', 2, array['This call was already reviewed with other content',
			'20260930546000', 'return public.qorpera_action_review_receipt(v_existing)', 'qorpera_folder_proposal_of_call',
			'20260930546000', 'qorpera_folder_run_reads_current', 'insert into public.qorpera_action_reviews']),
		('public.qorpera_send_agent_mail(jsonb,text,jsonb)', 1, array['The same call again',
			'return public.qorpera_agent_mail_receipt(v_existing', 'The mailbox is paused', 'folder is not built yet',
			'20260930546000', 'qorpera_company_path_remember_read', 'pg_advisory_xact_lock',
			'insert into public.qorpera_company_mail_outbox'])) as guard(signature, markers, texts)
	loop
		v_source := (select prosrc from pg_proc where oid = v.signature::regprocedure);
		if (length(v_source) - length(replace(v_source, '20260930546000', ''))) / length('20260930546000') <> v.markers then
			raise exception '20260930546000 marker is not % times in %', v.markers, v.signature; end if;
		v_at := 0;
		for i in 1 .. cardinality(v.texts) loop
			v_next := strpos(substr(v_source, v_at + 1), v.texts[i]);
			if v_next = 0 then
				raise exception '20260930546000 check is out of place in %: %', v.signature, v.texts[i]; end if;
			v_at := v_at + v_next;
		end loop;
	end loop;
end $guard$;

-- The catalog check ---------------------------------------------------------------------------------------------------

-- Exactly the three functions changed, each only in its body and by its replacements; every other public function is
-- as it was, and none came or went.
do $$ begin
	if (select count(*) from pg_temp.a3_before where expected is not null) <> 3
		or exists (select 1 from pg_temp.a3_before as prior where prior.expected is not null and prior.oid not in (
			'public.qorpera_begin_action_review(jsonb,jsonb)'::regprocedure,
			'public.qorpera_record_action_review(jsonb,jsonb)'::regprocedure,
			'public.qorpera_send_agent_mail(jsonb,text,jsonb)'::regprocedure))
		or exists (select 1 from pg_temp.a3_before as prior left join pg_proc as patched on patched.oid = prior.oid
			where patched.oid is null or to_jsonb(patched) - 'prosrc' is distinct from prior.fields
				or md5(patched.prosrc) is distinct from coalesce(prior.expected, prior.source)
				or prior.expected = prior.source)
		or exists (select 1 from pg_proc as p where p.pronamespace = 'public'::regnamespace
			and p.oid not in (select prior.oid from pg_temp.a3_before as prior)) then
		raise exception '20260930546000: the catalog did not change as expected'; end if;
end $$;

drop function pg_temp.a3_replace(regprocedure, text, text);
drop table pg_temp.a3_before;
