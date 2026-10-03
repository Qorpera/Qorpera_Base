-- Members read mail (I5a), a follow-up for the Interfaces Mailbox: a waiting send the member may answer names the
-- conversation its review card was raised in (`sessionId`, qorpera_action_reviews.card_session_id), the one
-- qorpera_answer_action_review answers it from. It is given only when that call's own checks of the member pass: the
-- card waits for this member (approver scope 'member') or for owners and admins and the member is one, and the member
-- can write the card's conversation (qorpera_can_write_session: no viewer role, and another member's private
-- conversation never). A card without a conversation, or one the member may not answer, has no `sessionId`. The
-- answer can still be refused (a closed conversation, a paused company, a folder-v2 card outside an agent thread). Both lists, the thread's `waiting` (qorpera_member_mail_thread) and the `waiting`
-- source's mail rows (qorpera_member_mail_waiting), read it by the card's id. Exact-text patches; each inserted text
-- names this migration (20260930000400), for deploy guards.

create function pg_temp.mail_waiting_session_patch(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Mail waiting session patch anchor not found once in %', p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;

do $$
begin
	perform pg_temp.mail_waiting_session_patch('public.qorpera_member_mail_thread(uuid,text)',
		E'\t\t\t''reviewId'', open_send.review_id,\n\t\t\t''staffAgent''',
		E'\t\t\t''reviewId'', open_send.review_id,\n'
		|| E'\t\t\t-- 20260930000400: the card''s conversation, where it is answered, for a member who may answer it.\n'
		|| E'\t\t\t''sessionId'', (select review.card_session_id from public.qorpera_action_reviews as review\n'
		|| E'\t\t\t\twhere review.id = open_send.review_id\n'
		|| E'\t\t\t\t\tand ((review.approver_scope = ''member'' and review.approver_user_id = auth.uid())\n'
		|| E'\t\t\t\t\t\tor (review.approver_scope = ''owners_admins'' and public.qorpera_can_authorize_profile(review.profile_id)))\n'
		|| E'\t\t\t\t\tand public.qorpera_can_write_session(review.card_session_id)),\n'
		|| E'\t\t\t''staffAgent''');
	perform pg_temp.mail_waiting_session_patch('public.qorpera_member_mail_waiting(uuid)',
		E'\t\t\t''reviewId'', open_send.review_id, ''thread'', open_send.thread,\n',
		E'\t\t\t''reviewId'', open_send.review_id, ''thread'', open_send.thread,\n'
		|| E'\t\t\t-- 20260930000400: the card''s conversation, where it is answered, for a member who may answer it.\n'
		|| E'\t\t\t''sessionId'', (select review.card_session_id from public.qorpera_action_reviews as review\n'
		|| E'\t\t\t\twhere review.id = open_send.review_id\n'
		|| E'\t\t\t\t\tand ((review.approver_scope = ''member'' and review.approver_user_id = auth.uid())\n'
		|| E'\t\t\t\t\t\tor (review.approver_scope = ''owners_admins'' and public.qorpera_can_authorize_profile(review.profile_id)))\n'
		|| E'\t\t\t\t\tand public.qorpera_can_write_session(review.card_session_id)),\n');
end $$;
