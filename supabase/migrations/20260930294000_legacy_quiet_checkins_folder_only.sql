-- 20260930294000: the legacy sweep, step F3a (the quiet check-ins' legacy ask and the plan's routine resume). Two
-- snapshot-v1 paths that folder-v2 never takes go (folder-v2 only, the founder's decision of 3 October):
-- 1. The executor's quiet-session archive (qorpera_archive_quiet_coding_sessions) no longer runs the legacy quiet
--    check-ins when it entered no company, and qorpera_ask_quiet_coding_sessions, a wake inserter with no fence that
--    skipped folder-v2 sessions since C1c-3i (20260930026000), is dropped. The folder drain coding_checkins asks every
--    quiet session per company (20260928519100), with 349850's qorpera_coding_quiet_mark, which stays.
-- 2. Turning a ChatGPT plan on (qorpera_set_chatgpt_plan_work_while_away) no longer resumes the snapshot-v1 routines
--    that wait for it (20260928369985; on folder-v2 the agents write routine files, and the call resumed none). The
--    call is the consent call under the member's choice mark, and its answer is the consent's plus resumed_routines,
--    always [] as on folder-v2 before; the 2 s lock wait and the busy answer (55P03) stay. qorpera_routine_waits_for_
--    member_plan, read only by that resume, is dropped.
-- The archive is patched in place from its live text (its anchor must occur exactly once); the plan call is its live
-- text without the resume, and create or replace keeps its grants. Both bodies name this migration (20260930294000),
-- and the archive's earlier marker stays.
set local lock_timeout = '3s';

create function pg_temp.f3a_patch(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Legacy sweep F3a anchor found % time(s) in %, expected 1: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The quiet-session archive runs no legacy ask. ---------------------------------------------------------------------

select pg_temp.f3a_patch('public.qorpera_archive_quiet_coding_sessions(text)'::regprocedure,
$old$		end loop;
	else
		-- The legacy quiet check-ins only when no company was entered: they lock other companies' coding rows (NOWAIT).
		-- C1c-3i part b asks folder-v2 sessions per company. An unexpected failure is reported and tried at the next scan.
		begin
			perform public.qorpera_ask_quiet_coding_sessions(p_owner);
		exception when others then
			raise warning 'Coding quiet check-ins failed: % (%)', sqlerrm, sqlstate;
		end;
	end if;
$old$,
$new$		end loop;
	end if;
	-- The quiet check-ins are the folder drain coding_checkins' (20260928519100); the legacy ask that ran here when no
	-- company was entered went in the legacy sweep's F3a (20260930294000).
$new$);

drop function public.qorpera_ask_quiet_coding_sessions(text);

-- 2. Turning a plan on resumes no routine. -----------------------------------------------------------------------------

create or replace function public.qorpera_set_chatgpt_plan_work_while_away(p_profile_id uuid, p_connection_id uuid, p_on boolean)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $function$
declare
	v_user uuid := auth.uid(); v_result jsonb;
	v_state text; v_message text; v_detail text;
begin
	-- A wait for any one lock ends after 2 s (the function's lock_timeout, below), and a deadlock PostgreSQL breaks on
	-- this side ends the call too; both answer a plain "busy" the web shows (55P03, a retry code PostgREST does not
	-- replay). This block's rollback undoes all the call did, the member's choice mark included. Only these two are
	-- caught; every other error is raised as it was.
	begin
		if v_user is null or p_on is null or p_connection_id is null or p_profile_id is null
			or not exists (select 1 from public.qorpera_provider_connections as connection
				where connection.id = p_connection_id and connection.profile_id = p_profile_id
					and connection.owner_user_id = v_user and connection.status = 'active')
			or not public.qorpera_connection_is_chatgpt_plan(p_connection_id) then
			raise exception 'ChatGPT plan login is unavailable' using errcode = '42501'; end if;
		perform set_config('qorpera.chatgpt_plan_member_choice', p_connection_id::text, true);
		v_result := public.qorpera_consent_provider_connection_autonomous(p_profile_id, p_connection_id, p_on);
		perform set_config('qorpera.chatgpt_plan_member_choice', '', true);
		-- 20260930294000 (legacy sweep F3a): no routine waits here for the plan (snapshot-v1's resume, 20260928369985,
		-- went; on folder-v2 the agents write routine files), so resumed_routines is always empty.
		return v_result || jsonb_build_object('resumed_routines', '[]'::jsonb);
	exception when lock_not_available or deadlock_detected then
		-- The member sees busy; the database log keeps which it was (a lock wait or a broken deadlock, and with whom).
		get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail;
		raise log 'qorpera_set_chatgpt_plan_work_while_away busy: % %: %', v_state, v_message, coalesce(v_detail, '');
		raise exception 'Busy right now. Try again in a moment.' using errcode = '55P03';
	end;
end
$function$;

drop function public.qorpera_routine_waits_for_member_plan(uuid, uuid, uuid);
