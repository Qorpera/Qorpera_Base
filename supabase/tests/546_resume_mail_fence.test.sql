-- @fixture 466_memory_run_resume_receipts.test.sql until "-- 3. Today's path"
-- A3 (20260930546000): a resumed attempt that has not recorded its resume queues no new email. Test 466's run in Agent
-- notebooks mode keeps no log; its first attempt has acknowledged ('rr-ack'), completed two steps and begun a third.
-- Here the company's mail is on (as 542's), and the first attempt queues an email. Then the run is cut off, and its next
-- attempt starts but records nothing, as v190's runtime does. Its new email is refused (55000 'Run resume is not
-- recorded') after every check of the request and the mailbox, and after the folder-v2 attachment refusal; before the
-- rest of the attachments, the limits and the outbox. The refusal leaves every table as it was. The replay of the first
-- attempt's email answers the stored email, as before, with no write. Authority, the request, the mailbox and the
-- folder-v2 attachment refusal are checked as before, ahead of the fence. A run that does not resume from its
-- receipts (one with a log, one in Agent tree mode) works as before. Once the attempt records its resume it mails
-- again. Each case reports 'ok' (with the receipt's status) or its SQLSTATE and message, then the tables whose row
-- counts changed, then the tables whose content changed with the same count. Every case is noted; the test fails at its
-- end with each case that did not match, or if a case did not run. Nothing is sent: the outbox's sender is not run.
--
-- The expected messages, from the function source (file:line):
-- - 55000 'Run resume is not recorded': the fence, 20260930546000 (as 20260930539000:165 and 20260930545000 raise).
-- - 55000 'Run resume is unavailable': qorpera_memory_run_resume_of, 20260928559130:47.
-- - 42501 'Run is unavailable': the run check's lease (job, runner, assignment), qorpera_folder_run_resolve,
--   20260928249000:824.
-- - 42501 'native tool host authority is required': the run check, qorpera_folder_native_actor, 20260928279470:172.
-- - 22023 'Mail request is invalid', 0A000 'Sending company mail is switched off', 42501 'No mailbox of this company
--   has that address; list_hooks shows them', 0A000 'The mailbox is paused; a member resumes it', 42501 'Email to your
--   own company''s mailboxes is refused; reach coworkers with send_coworker_message' and 42501 'The email this answers
--   is not one the company received': qorpera_send_agent_mail, 20260928309740:184-224.
-- - 0A000 'Attaching files from this company''s folder is not built yet': 20260928429984:368.
-- The replay with no write: 20260928309740:168-171. The writes: the outbox row (20260928309740:315, as
-- 20260928439980:437 patches it) and its thread (qorpera_mail_thread_note, 20260928439980:217).

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
-- An email from the support mailbox to a customer, with the fields given replacing or adding to it (a null drops one).
create function pg_temp.a3_mail_request(p_change jsonb default '{}') returns jsonb language sql as $$
	select jsonb_strip_nulls(jsonb_build_object('from', 'support@mail.example.test', 'to', jsonb_build_array('customer@example.org'),
		'subject', 'Your order', 'text', 'Thanks for writing.') || p_change)
$$;
-- One email by its call id: the receipt's status.
create function pg_temp.a3_mail(p_binding jsonb, p_call text, p_change jsonb default '{}', p_keep boolean default false,
	p_member boolean default false) returns text language sql as $$
	select pg_temp.a3_try(format('select public.qorpera_send_agent_mail(%L::jsonb, %L, %L::jsonb) ->> ''status''', p_binding,
		p_call, pg_temp.a3_mail_request(p_change)), p_keep, p_member)
$$;
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
-- What an email that goes through writes: its outbox row and its thread.
create function pg_temp.a3_mailed() returns text language sql as $$
	select 'ok:queued|qorpera_company_mail_outbox+1,qorpera_mail_threads+1|none'
$$;
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

-- The company's mail is on, with a support mailbox (as 542's).
update public.qorpera_mail_settings set domain = 'mail.example.test', enabled = true, sending = true;
update public.qorpera_event_intake_settings set enabled = true, public_url = 'https://intake.example.test';
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select public.qorpera_create_company_mailbox('92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020', 'support', 'Customer support') \g /dev/null
select pg_temp.base_claims('service_role');

-- 1. The first attempt is no resume: its email is queued, and its replay writes nothing. Kept, for the next attempt to
--    repeat.
do $$
declare v_binding jsonb := pg_temp.a3_binding('base_binding');
begin
	perform pg_temp.a3_cases(array[
		'01 the first attempt''s email', pg_temp.a3_mail(v_binding, 'a3-m1', '{}', true), pg_temp.a3_mailed(),
		'02 its replay', pg_temp.a3_mail(v_binding, 'a3-m1', '{}', true), 'ok:queued|none|none']);
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

-- 3. Before it records, the next attempt queues no new email. An attachment is refused first, as before (0A000: this
--    company is on folder-v2). Its replay of the first attempt's email answers the stored email, with no write. A
--    request, a mailbox or a reply the checks refuse is refused as before.
do $$
declare v_next jsonb := pg_temp.a3_binding('a3_next'); v text[] := '{}';
begin
	v := v || array['03 the unrecorded next attempt''s new email', pg_temp.a3_mail(v_next, 'a3-m2'), pg_temp.a3_refused()];
	v := v || array['04 its new email with an attachment', pg_temp.a3_mail(v_next, 'a3-m2',
		'{"attachments":["notes/a.txt"]}'), '0A000 Attaching files from this company''s folder is not built yet|none|none'];
	v := v || array['05 its replay of the first attempt''s email', pg_temp.a3_mail(v_next, 'a3-m1'), 'ok:queued|none|none'];
	v := v || array['06 the replay answers the stored email', pg_temp.a3_try(format('select (reply ->> ''mailId'' = (select '
		|| 'id::text from public.qorpera_company_mail_outbox where run_id = %L::uuid and call_id = ''a3-m1'') and (select '
		|| 'count(*) from public.qorpera_company_mail_outbox where run_id = %L::uuid) = 1)::text '
		|| 'from public.qorpera_send_agent_mail(%L::jsonb, ''a3-m1'', %L::jsonb) as reply', pg_temp.rr_run(), pg_temp.rr_run(),
		v_next, pg_temp.a3_mail_request())), 'ok:true|none|none'];
	v := v || array['07 an email with no subject', pg_temp.a3_mail(v_next, 'a3-m2', '{"subject":null}'),
		'22023 Mail request is invalid|none|none'];
	v := v || array['08 an email from no mailbox', pg_temp.a3_mail(v_next, 'a3-m2', '{"from":"nobody@mail.example.test"}'),
		'42501 No mailbox of this company has that address; list_hooks shows them|none|none'];
	v := v || array['09 an email to the company''s own mailbox', pg_temp.a3_mail(v_next, 'a3-m2',
		'{"to":["support@mail.example.test"]}'),
		'42501 Email to your own company''s mailboxes is refused; reach coworkers with send_coworker_message|none|none'];
	v := v || array['10 a reply to no received email', pg_temp.a3_mail(v_next, 'a3-m2',
		jsonb_build_object('inReplyTo', extensions.gen_random_uuid())), '42501 The email this answers is not one the company received|none|none'];
	begin
		perform set_config('session_replication_role', 'replica', true);
		update public.qorpera_mail_settings set sending = false;
		perform set_config('session_replication_role', 'origin', true);
		v := v || array['11 sending switched off', pg_temp.a3_mail(v_next, 'a3-m2'), '0A000 Sending company mail is switched off|none|none'];
		raise exception using errcode = 'A3001';
	exception when sqlstate 'A3001' then null;
	end;
	begin
		perform set_config('session_replication_role', 'replica', true);
		update public.qorpera_event_hooks set status = 'paused'
		where id = (select hook_id from public.qorpera_company_mailboxes where local_part = 'support' and removed_at is null);
		perform set_config('session_replication_role', 'origin', true);
		v := v || array['12 the mailbox paused', pg_temp.a3_mail(v_next, 'a3-m2'), '0A000 The mailbox is paused; a member resumes it|none|none'];
		raise exception using errcode = 'A3001';
	exception when sqlstate 'A3001' then null;
	end;
	perform pg_temp.a3_cases(v);
end
$$;

-- 4. Authority is checked as before, ahead of the fence: the cut-off attempt is refused by the run check, and only the
--    service role mails. The function keeps its settings and grants.
do $$
declare v_old jsonb := pg_temp.a3_binding('base_binding'); v_next jsonb := pg_temp.a3_binding('a3_next');
begin
	perform pg_temp.a3_cases(array[
		'13 the cut-off attempt''s email', pg_temp.a3_mail(v_old, 'a3-old'), '42501 Run is unavailable|none|none',
		'14 a member''s email', pg_temp.a3_mail(v_next, 'a3-member', '{}', false, true),
			'42501 native tool host authority is required|none|none',
		'15 its settings and grants', pg_temp.a3_grants('public.qorpera_send_agent_mail(jsonb,text,jsonb)'),
			'secdef=t;config={"search_path=\"\""};owner=postgres;anon=f;authenticated=f;public=f;service_role=t']);
end
$$;

-- 5. The fence asks for the resume only where it is about to write: with the cut-off's event one the resume read
--    refuses, the new email is refused with the read, while the replay answers as before. A run that does not resume
--    from its receipts mails as before, unrecorded: one that keeps a log, and one in Agent tree mode. Undone.
do $$
declare v_next jsonb := pg_temp.a3_binding('a3_next'); v_run public.qorpera_execution_runs; v text[] := '{}';
begin
	begin
		perform set_config('session_replication_role', 'replica', true);
		update public.qorpera_execution_run_events set payload = payload - 'schema'
		where run_id = pg_temp.rr_run() and event_type = 'run_cut_off';
		perform set_config('session_replication_role', 'origin', true);
		v := v || array['16 the resume read refuses this cut-off', pg_temp.a3_try(format(
			'select public.qorpera_memory_run_resume_of(%L::uuid, %L::uuid, %L::uuid)::text', pg_temp.rr_run(),
			v_next ->> 'assignmentId', v_next ->> 'leaseId')), '55000 Run resume is unavailable|none|none'];
		v := v || array['17 unreadable resume: the new email', pg_temp.a3_mail(v_next, 'a3-m2'),
			'55000 Run resume is unavailable|none|none'];
		v := v || array['18 unreadable resume: the replay', pg_temp.a3_mail(v_next, 'a3-m1'), 'ok:queued|none|none'];
		begin
			select * into strict v_run from public.qorpera_execution_runs where id = pg_temp.rr_run();
			insert into public.qorpera_memory_run_logs(environment_id, run_id, session_id, run_path, run_key, toml_path_version, commit_id)
			values (v_run.environment_id, v_run.id, extensions.gen_random_uuid(), 'QorperaOS/agents/alice/runs/' || v_run.id,
				'qorperaos/agents/alice/runs/' || v_run.id, extensions.gen_random_uuid(), extensions.gen_random_uuid());
			perform pg_temp.base_assert(public.qorpera_run_resumes_from_receipts(v_run.id) is false,
				'a run with a log does not resume from receipts');
			v := v || array['19 a run with a log: the new email', pg_temp.a3_mail(v_next, 'a3-m2'), pg_temp.a3_mailed()];
			raise exception using errcode = 'A3001';
		exception when sqlstate 'A3001' then null;
		end;
		perform set_config('session_replication_role', 'replica', true);
		update public.qorpera_execution_runs set memory_mode = 'tree' where id = pg_temp.rr_run();
		perform set_config('session_replication_role', 'origin', true);
		perform pg_temp.base_assert(public.qorpera_run_resumes_from_receipts(pg_temp.rr_run()) is false,
			'a tree run does not resume from receipts');
		v := v || array['20 a tree run: the new email', pg_temp.a3_mail(v_next, 'a3-m2'), pg_temp.a3_mailed()];
		raise exception using errcode = 'A3001';
	exception when sqlstate 'A3001' then null;
	end;
	perform pg_temp.a3_cases(v);
end
$$;

-- 6. Once it records what it was told (the unknown step, no steps read, as 466 §8), the attempt mails again; its
--    replay writes nothing.
do $$
declare v_next jsonb := pg_temp.a3_binding('a3_next'); v text[] := '{}';
begin
	perform pg_temp.base_claims('service_role');
	perform pg_temp.rr_record(v_next, jsonb_build_object('stepsRead', 0, 'unknownCalls', jsonb_build_array(
		jsonb_build_object('call', null, 'step', null, 'receiptId', current_setting('qorpera_test.rr_b')))));
	v := v || array['21 the recorded attempt''s new email', pg_temp.a3_mail(v_next, 'a3-m3', '{}', true), pg_temp.a3_mailed()];
	v := v || array['22 its replay', pg_temp.a3_mail(v_next, 'a3-m3', '{}', true), 'ok:queued|none|none'];
	v := v || array['23 the run''s emails: the first attempt''s and the recorded one''s', (select string_agg(call_id, ','
		order by call_id collate "C") from public.qorpera_company_mail_outbox where run_id = pg_temp.rr_run()), 'a3-m1,a3-m3'];
	perform pg_temp.a3_cases(v);
end
$$;

-- Every case, at once: each one ran, once, and matched.
do $$
declare v_cases text[] := array_remove(string_to_array(current_setting('qorpera_test.a3_cases'), E'\n'), '');
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.a3_failed') = '' and cardinality(v_cases) = 23
		and (select count(distinct c) from unnest(v_cases) c) = 23,
		format('%s cases ran (%s distinct) of 23; failed:%s', cardinality(v_cases),
			(select count(distinct c) from unnest(v_cases) c), current_setting('qorpera_test.a3_failed')));
end
$$;

set constraints all immediate;
rollback;
