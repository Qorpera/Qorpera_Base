-- Company folder core, C1c-3b: a member's answers on the folder fence
-- (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6.3; inventory scratchpad reports/C1c3-inventory.md §5, §8).
--
-- Changes only folder-v2 behaviour; snapshot-v1 keeps every path. On folder-v2 none of these takes the company row FOR
-- UPDATE (the gc fence) any more:
-- * qorpera_folder_enter_agent_thread: the prelude of a member's answer in an agent's thread: the thread room read
--   without a lock, then the enter helper with the member (rank 1), the agent (rank 2), the room FOR SHARE (as a post
--   takes it) and both memberships (rank 4). It reads no pause: each caller reads it under the fence where it does
--   today, so a replayed answer still returns its receipt while the company is paused.
-- * An answer to an agent's card (qorpera_answer_interaction) in its thread: the prelude in place of the gc fence; the
--   conversation FOR UPDATE; the input; the transcript events (the operation clock), then admission, then the wake.
--   Plain conversations refuse (0A000) until C3/C4 give them folder-v2 runs, as their inputs do since C1c-3a.
-- * An email draft's completion (qorpera_finish_email_draft_action) takes that prelude before its own conversation
--   lock, when the draft sits in an agent's thread. The answer it then gives takes the same rows again in the same
--   modes, which never waits. So the answer to a sent email reaches the agent on folder-v2. The broker's claim
--   (qorpera_claim_email_draft_action) takes it before its conversation lock too: a claim of an action already
--   completed replays the completion under that lock.
-- * An answer to an action-review card (qorpera_answer_action_review) in an agent's thread: the prelude, the
--   conversation, then the review (C1C §5.7's card exception), "Always allow"'s company rule, the input, the events,
--   admission, then the wake. A card still held by a call adds the input and the events only. Plain conversations
--   refuse (0A000).

-- 1. Patch helper (a name unique to this migration: pg_temp lives for the whole session) ---------------------------

create function pg_temp.c1c3b_replace(p_target regprocedure, p_old text, p_new text, p_count integer) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'C1c-3b patch anchor not found % time(s) in %', p_count, p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 2. The prelude of an answer in an agent's thread --------------------------------------------------------------------

-- On a folder-v2 company, for a member answering in an agent's thread: the thread room read without a lock, then the
-- enter helper with the member, the agent, the room FOR SHARE and both memberships. No target is required: each
-- caller's own checks after it refuse a missing member, agent or room as they do today, and the wake's pin trigger
-- checks both memberships again. Returns false, locking nothing, when the conversation is not an agent's thread.
create function public.qorpera_folder_enter_agent_thread(p_session_id uuid, p_user_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_room public.qorpera_company_rooms%rowtype;
begin
	select * into v_room from public.qorpera_company_rooms where session_id = p_session_id and bound_staff_agent_id is not null;
	if not found then return false; end if;
	perform public.qorpera_folder_company_enter(v_room.environment_id, v_room.profile_id, jsonb_build_array(
		jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members', 'key', v_room.profile_id::text || ':' || p_user_id::text,
			'mode', 'keyshare', 'required', false),
		jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff', 'key', v_room.profile_id::text || ':' || v_room.bound_staff_agent_id::text,
			'mode', 'keyshare', 'required', false),
		jsonb_build_object('rank', 4, 'tbl', 'qorpera_company_rooms', 'key', v_room.id::text, 'mode', 'share', 'required', false),
		jsonb_build_object('rank', 4, 'tbl', 'qorpera_company_room_members', 'key', v_room.id::text || ':member:' || p_user_id::text,
			'mode', 'keyshare', 'required', false),
		jsonb_build_object('rank', 4, 'tbl', 'qorpera_company_room_members',
			'key', v_room.id::text || ':staff_agent:' || v_room.bound_staff_agent_id::text, 'mode', 'keyshare', 'required', false)), false);
	return true;
end $$;

-- 3. Patches ------------------------------------------------------------------------------------------------------------

do $$
declare c_plain constant text := 'This conversation does not serve folder-v2 companies yet';
begin
	-- An answer to an agent's card. On folder-v2 only an agent's thread delivers it: the prelude in place of the gc
	-- fence (a group chat keeps its own refusal); then, in the thread branch, the events and admission before the wake.
	perform pg_temp.c1c3b_replace('public.qorpera_answer_interaction(uuid,uuid,uuid,text,jsonb,uuid,bigint)',
		E'\tperform public.qorpera_lock_profile_gc_fence(v_profile_id);\n',
		E'\tif public.qorpera_company_is_folder_v2(v_profile_id) then\n'
		|| E'\t\tif not public.qorpera_folder_enter_agent_thread(p_session_id, v_user_id) then\n'
		|| E'\t\t\tif exists (select 1 from public.qorpera_company_rooms as room where room.session_id = p_session_id) then\n'
		|| E'\t\t\t\traise exception ''cards are not answered in a group chat'' using errcode = ''22023''; end if;\n'
		|| E'\t\t\traise exception ''' || c_plain || E''' using errcode = ''0A000''; end if;\n'
		|| E'\telse\n'
		|| E'\tperform public.qorpera_lock_profile_gc_fence(v_profile_id);\n'
		|| E'\tend if;\n', 1);
	perform pg_temp.c1c3b_replace('public.qorpera_answer_interaction(uuid,uuid,uuid,text,jsonb,uuid,bigint)',
		E'\t\t\t\t''recipientStaffId'', v_room.bound_staff_agent_id));\n'
		|| E'\t\tperform public.qorpera_append_admitted_input_events(p_session_id, array[v_input.id]);\n',
		E'\t\t\t\t''recipientStaffId'', v_room.bound_staff_agent_id));\n'
		|| E'\t\tif not public.qorpera_company_is_folder_v2(v_room.profile_id) then\n'
		|| E'\t\tperform public.qorpera_append_admitted_input_events(p_session_id, array[v_input.id]);\n'
		|| E'\t\tend if;\n', 1);
	perform pg_temp.c1c3b_replace('public.qorpera_answer_interaction(uuid,uuid,uuid,text,jsonb,uuid,bigint)',
		E'\t\tvalues (p_session_id, p_client_input_id, ''user_message'', v_user_id, v_body, clock_timestamp())\n'
		|| E'\t\treturning * into v_input;\n'
		|| E'\t\tinsert into public.qorpera_wake_occurrences',
		E'\t\tvalues (p_session_id, p_client_input_id, ''user_message'', v_user_id, v_body, clock_timestamp())\n'
		|| E'\t\treturning * into v_input;\n'
		|| E'\t\tif public.qorpera_company_is_folder_v2(v_room.profile_id) then\n'
		|| E'\t\t\t-- The transcript events (the operation clock), then admission, the last lock before the folder clock.\n'
		|| E'\t\t\tperform public.qorpera_append_admitted_input_events(p_session_id, array[v_input.id]);\n'
		|| E'\t\t\tperform public.qorpera_folder_admit_wakes(v_room.profile_id);\n'
		|| E'\t\tend if;\n'
		|| E'\t\tinsert into public.qorpera_wake_occurrences', 1);

	-- An email draft's completion: the answer's thread prelude before this conversation's lock (the answer below would
	-- otherwise take the fence and rank 0 after it). The answer's own prelude then takes the same rows in the same modes.
	perform pg_temp.c1c3b_replace('public.qorpera_finish_email_draft_action(uuid,text,uuid,text,jsonb)',
		E' perform 1 from public.qorpera_shared_sessions s join public.qorpera_member_email_drafts d on d.session_id=s.id',
		E' if public.qorpera_company_is_folder_v2(v_profile) then\n'
		|| E'  perform public.qorpera_folder_enter_agent_thread(d.session_id, d.user_id) from public.qorpera_member_email_drafts d\n'
		|| E'  join public.qorpera_member_email_actions a on a.interaction_id=d.interaction_id\n'
		|| E'  join public.qorpera_shared_sessions s on s.id=d.session_id where a.id=p_action_id and s.profile_id=v_profile;\n'
		|| E' end if;\n'
		|| E' perform 1 from public.qorpera_shared_sessions s join public.qorpera_member_email_drafts d on d.session_id=s.id', 1);

	-- The broker's claim of an email action: the same prelude before its conversation lock. A claim of an action already
	-- completed replays the completion (finish, then the answer) under that lock, so the prelude must come first here too.
	perform pg_temp.c1c3b_replace('public.qorpera_claim_email_draft_action(uuid,text,uuid,text)',
		E' -- Same lock order as member preparation: session, draft, action.\n',
		E' if public.qorpera_company_is_folder_v2(v_broker.profile_id) then\n'
		|| E'  perform public.qorpera_folder_enter_agent_thread(d.session_id, d.user_id) from public.qorpera_member_email_drafts d\n'
		|| E'  join public.qorpera_member_email_actions a on a.interaction_id=d.interaction_id\n'
		|| E'  join public.qorpera_shared_sessions s on s.id=d.session_id where a.id=p_action_id and s.profile_id=v_broker.profile_id;\n'
		|| E' end if;\n'
		|| E' -- Same lock order as member preparation: session, draft, action.\n', 1);

	-- An answer to an action-review card: the prelude in place of the gc fence (a card outside an agent's thread
	-- refuses on folder-v2); then, when the answer wakes the agent, the events and admission before the wake.
	perform pg_temp.c1c3b_replace('public.qorpera_answer_action_review(uuid,uuid,text,text,uuid,bigint)',
		E'\tperform public.qorpera_lock_profile_gc_fence(v_review.profile_id);\n',
		E'\tif public.qorpera_company_is_folder_v2(v_review.profile_id) then\n'
		|| E'\t\tif not public.qorpera_folder_enter_agent_thread(v_review.card_session_id, v_user) then\n'
		|| E'\t\t\traise exception ''' || c_plain || E''' using errcode = ''0A000''; end if;\n'
		|| E'\telse\n'
		|| E'\tperform public.qorpera_lock_profile_gc_fence(v_review.profile_id);\n'
		|| E'\tend if;\n', 1);
	perform pg_temp.c1c3b_replace('public.qorpera_answer_action_review(uuid,uuid,text,text,uuid,bigint)',
		E'\t\t\t\t\t''recipientStaffId'', v_room.bound_staff_agent_id));\n'
		|| E'\t\t\tperform public.qorpera_append_admitted_input_events(v_session.id, array[v_input.id]);\n',
		E'\t\t\t\t\t''recipientStaffId'', v_room.bound_staff_agent_id));\n'
		|| E'\t\t\tif not public.qorpera_company_is_folder_v2(v_room.profile_id) then\n'
		|| E'\t\t\tperform public.qorpera_append_admitted_input_events(v_session.id, array[v_input.id]);\n'
		|| E'\t\t\tend if;\n', 1);
	perform pg_temp.c1c3b_replace('public.qorpera_answer_action_review(uuid,uuid,text,text,uuid,bigint)',
		E'\t\t\tvalues (v_session.id, p_client_input_id, ''user_message'', v_user, v_body, clock_timestamp())\n'
		|| E'\t\t\treturning * into v_input;\n'
		|| E'\t\t\tinsert into public.qorpera_wake_occurrences',
		E'\t\t\tvalues (v_session.id, p_client_input_id, ''user_message'', v_user, v_body, clock_timestamp())\n'
		|| E'\t\t\treturning * into v_input;\n'
		|| E'\t\t\tif public.qorpera_company_is_folder_v2(v_room.profile_id) then\n'
		|| E'\t\t\t\t-- The transcript events (the operation clock), then admission, the last lock before the folder clock.\n'
		|| E'\t\t\t\tperform public.qorpera_append_admitted_input_events(v_session.id, array[v_input.id]);\n'
		|| E'\t\t\t\tperform public.qorpera_folder_admit_wakes(v_room.profile_id);\n'
		|| E'\t\t\tend if;\n'
		|| E'\t\t\tinsert into public.qorpera_wake_occurrences', 1);
end $$;

-- 4. Privileges ------------------------------------------------------------------------------------------------------

-- Internal: reached only through the answers.
revoke all on function public.qorpera_folder_enter_agent_thread(uuid, uuid) from public, anon, authenticated, service_role;
