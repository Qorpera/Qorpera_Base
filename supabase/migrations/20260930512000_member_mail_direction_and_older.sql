-- Members read mail (I5a), for the Interfaces Mailbox (C6e, QORPERA-REBUILD-SCOPE-AMENDMENT-2026-10-17.md §4): the Sent
-- view and a thread's older messages.
-- - qorpera_member_mail_threads takes `direction` ('received' or 'sent'): only threads whose newest message went that
--   way, the `direction` each row already shows. It filters before the page is cut, so Sent pages through every sent
--   thread with `before` and `nextBefore`, not only the threads of the pages read.
-- - qorpera_member_mail_thread takes `p_before` ({at, kind, id}, the `nextBefore` a page names while `more` is true): the
--   50 messages before that one, oldest first, in the order of the newest page. Without it the answer is the newest 50,
--   as before.
-- Who may call, account mail's hidden parts, the 16,000-character texts and the waiting sends are unchanged. Quotes
-- are checked from the stored mail (qorpera_check_member_quotes), not from these answers. Exact-text patches; each
-- inserted text names this migration (20260930512000), for deploy guards.

create function pg_temp.mail_c6e_patch(p_target regprocedure, variadic p_edits text[]) returns text language plpgsql as $$
declare
	v_definition text := pg_get_functiondef(p_target);
	v_n integer;
begin
	for v_n in 1 .. array_length(p_edits, 1) by 2 loop
		if (length(v_definition) - length(replace(v_definition, p_edits[v_n], ''))) / length(p_edits[v_n]) <> 1 then
			raise exception 'Mail C6e patch anchor % not found once in %', (v_n + 1) / 2, p_target; end if;
		v_definition := replace(v_definition, p_edits[v_n], p_edits[v_n + 1]);
	end loop;
	return v_definition;
end $$;

do $$
begin
	execute pg_temp.mail_c6e_patch('public.qorpera_member_mail_threads(uuid,jsonb)',
		E'array[''address'', ''state'', ''before'', ''limit'']',
		E'array[''address'', ''state'', ''direction'', ''before'', ''limit'']',
		E'\t\tor coalesce(jsonb_typeof(p_request -> ''state''), ''string'') <> ''string''\n',
		E'\t\tor coalesce(jsonb_typeof(p_request -> ''state''), ''string'') <> ''string''\n'
		|| E'\t\t-- 20260930512000: the newest message''s direction.\n'
		|| E'\t\tor coalesce(p_request ->> ''direction'', ''sent'') not in (''received'', ''sent'')\n'
		|| E'\t\tor coalesce(jsonb_typeof(p_request -> ''direction''), ''string'') <> ''string''\n',
		E'\t\t\tand (v_box is null or mailbox.local_part = v_box)\n',
		E'\t\t\tand (v_box is null or mailbox.local_part = v_box)\n'
		|| E'\t\t\t-- 20260930512000: the direction each row shows, before the page or a state''s window is cut.\n'
		|| E'\t\t\tand (not p_request ? ''direction'' or thread.last_direction = p_request ->> ''direction'')\n');

	-- The thread read gains its third argument: the patched text makes the new function, and the old one goes.
	execute pg_temp.mail_c6e_patch('public.qorpera_member_mail_thread(uuid,text)',
		'public.qorpera_member_mail_thread(p_environment_id uuid, p_thread text)',
		'public.qorpera_member_mail_thread(p_environment_id uuid, p_thread text, p_before jsonb DEFAULT NULL::jsonb)',
		E'\tv_more boolean;\n',
		E'\tv_more boolean;\n\tv_before_at timestamptz;\n\tv_before_key text;\n\tv_next jsonb;\n',
		E'\t\traise exception ''Mail thread request is invalid'' using errcode = ''22023''; end if;\n',
		E'\t\traise exception ''Mail thread request is invalid'' using errcode = ''22023''; end if;\n'
		|| E'\t-- 20260930512000: an older page starts before {at, kind, id}, the message a page named as nextBefore.\n'
		|| E'\tif p_before is not null and (jsonb_typeof(p_before) <> ''object''\n'
		|| E'\t\tor p_before - array[''at'', ''kind'', ''id''] <> ''{}''::jsonb\n'
		|| E'\t\tor jsonb_typeof(p_before -> ''at'') is distinct from ''string''\n'
		|| E'\t\tor p_before ->> ''at''\n'
		|| E'\t\t\t!~ ''^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}:?[0-9]{2})$''\n'
		|| E'\t\tor jsonb_typeof(p_before -> ''kind'') is distinct from ''string''\n'
		|| E'\t\tor p_before ->> ''kind'' not in (''received'', ''sent'')\n'
		|| E'\t\tor jsonb_typeof(p_before -> ''id'') is distinct from ''string''\n'
		|| E'\t\tor p_before ->> ''id'' !~ ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'') then\n'
		|| E'\t\traise exception ''Mail thread request is invalid'' using errcode = ''22023''; end if;\n'
		|| E'\tbegin\n'
		|| E'\t\tv_before_at := (p_before ->> ''at'')::timestamptz;\n'
		|| E'\texception when others then\n'
		|| E'\t\traise exception ''Mail thread request is invalid'' using errcode = ''22023'';\n'
		|| E'\tend;\n'
		|| E'\tv_before_key := (p_before ->> ''kind'') || '':'' || (p_before ->> ''id'');\n',
		E'\t\t\twhere received.thread_id = p_thread and received.profile_id = v_profile_id\n',
		E'\t\t\twhere received.thread_id = p_thread and received.profile_id = v_profile_id\n'
		|| E'\t\t\t\t-- 20260930512000: on an older page, only the messages before the cursor, in the page order.\n'
		|| E'\t\t\t\tand (v_before_at is null or received.received_at <= v_before_at\n'
		|| E'\t\t\t\t\tand (received.received_at, ''received:'' || received.delivery_id) < (v_before_at, v_before_key))\n',
		E'\t\t\twhere mail.thread = p_thread and mail.profile_id = v_profile_id\n',
		E'\t\t\twhere mail.thread = p_thread and mail.profile_id = v_profile_id\n'
		|| E'\t\t\t\tand (v_before_at is null or mail.created_at <= v_before_at\n'
		|| E'\t\t\t\t\tand (mail.created_at, ''sent:'' || mail.id) < (v_before_at, v_before_key))\n',
		E'\t\t(select count(*) > 50 from chosen)\n\tinto v_messages, v_more\n',
		E'\t\t(select count(*) > 50 from chosen),\n'
		|| E'\t\t-- 20260930512000: where the next older page starts: the oldest message of this one.\n'
		|| E'\t\t(select jsonb_build_object(''at'', placed.at, ''kind'', split_part(placed.key, '':'', 1),\n'
		|| E'\t\t\t''id'', split_part(placed.key, '':'', 2)) from placed where placed.place = 50)\n'
		|| E'\tinto v_messages, v_more, v_next\n',
		E'''more'', case when v_more then true end, ''waiting'', v_waiting',
		E'''more'', case when v_more then true end,\n'
		|| E'\t\t''nextBefore'', case when v_more then v_next end, ''waiting'', v_waiting');
end $$;
drop function public.qorpera_member_mail_thread(uuid, text);
revoke all on function public.qorpera_member_mail_thread(uuid, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_member_mail_thread(uuid, text, jsonb) to authenticated;

-- The Sent and received pages read in order, as the whole list does.
create index qorpera_mail_threads_direction on public.qorpera_mail_threads (environment_id, last_direction, last_at desc, id desc);
