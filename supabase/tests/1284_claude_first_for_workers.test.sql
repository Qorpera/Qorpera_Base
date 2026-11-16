-- @fixture 1268_claude_code_worker_dispatch.test.sql until "-- The checks start here"
select pg_temp.base_claims('service_role');

insert into public.qorpera_claude_sign_in_members(user_id) values (pg_temp.c4_owner_id());
select pg_temp.c4_login('12840000-0000-4000-8000-0000000000c1', pg_temp.c4_owner_id(), 'canary-claude-first') \g /dev/null

create function pg_temp.cf_read_brief(p_id uuid, p_harness text) returns jsonb language sql as $$
	select pg_temp.c4_brief(p_id, p_harness, 'Read the notes') || jsonb_build_object('access', 'read')
		|| public.qorpera_company_state_worker_standing('in-house', 'read', 'each')
$$;
create function pg_temp.cf_saved(p_result jsonb, p_what text) returns void language plpgsql as $$
begin
	perform pg_temp.base_assert(p_result -> 'units' -> 0 ->> 'outcome' = 'saved', p_what || ': ' || p_result::text);
end $$;
create function pg_temp.cf_binding(p_name text) returns jsonb language sql as $$
	select current_setting('qorpera_test.cf_' || p_name)::jsonb
$$;
create function pg_temp.cf_fall_back(p_binding jsonb, p_reason text, p_changed jsonb default '[]') returns text
language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_claude_worker_fall_back(p_binding, p_reason, p_changed) ->> 'state';
end $$;
create function pg_temp.cf_start_next() returns jsonb language plpgsql as $$
declare v_binding jsonb;
begin
	perform pg_temp.base_materialize();
	v_binding := pg_temp.base_start(null);
	perform pg_temp.base_assert(v_binding ->> 'runId' is not null, 'a run starts');
	return v_binding;
end $$;
create function pg_temp.cf_wake(p_worker uuid) returns public.qorpera_wake_occurrences language sql as $$
	select wake.* from public.qorpera_wake_occurrences wake where wake.id = (pg_temp.c4_worker(p_worker)).occurrence_id
$$;

do $$
declare v_alice jsonb := pg_temp.c4_alice(); w public.qorpera_runtime_workers%rowtype; v_folder text;
begin
	begin
		v_folder := 'QorperaOS/agents/alice/todos/onboarding/';
		perform pg_temp.cf_saved(pg_temp.c4_dispatch(v_alice, 'claude-first-default', v_folder || 'pdf',
			pg_temp.c4_brief('12840000-0000-4000-8000-0000000000d1', null)), '1: the default dispatch');
		w := pg_temp.c4_worker('12840000-0000-4000-8000-0000000000d1');
		perform pg_temp.base_assert(w.harness = 'claude-code' and w.harness_default
			and w.claude_login_id = '12840000-0000-4000-8000-0000000000c1' and w.claude_fallback_sequence is null
			and w.requested_by_user_id = pg_temp.c4_owner_id(),
			'1: a write worker whose brief names no harness goes to Claude Code while its member can use it: ' || to_jsonb(w)::text);
		perform pg_temp.base_assert(not ((select v.structured -> 'parse' from public.qorpera_folder_path_versions v
			where v.version = w.folder_brief_version) ? 'harness'), '1: its brief still names none');
		perform pg_temp.cf_saved(pg_temp.c4_dispatch(v_alice, 'claude-first-read', v_folder || 'read',
			pg_temp.cf_read_brief('12840000-0000-4000-8000-0000000000d2', null)), '1: the read dispatch');
		w := pg_temp.c4_worker('12840000-0000-4000-8000-0000000000d2');
		perform pg_temp.base_assert(w.harness is null and w.harness_default and w.claude_login_id is null,
			'1: a read worker stays on Codex: ' || to_jsonb(w)::text);
		perform pg_temp.cf_saved(pg_temp.c4_dispatch(v_alice, 'claude-first-codex', v_folder || 'codex',
			pg_temp.c4_brief('12840000-0000-4000-8000-0000000000d3', 'codex')), '1: the codex dispatch');
		w := pg_temp.c4_worker('12840000-0000-4000-8000-0000000000d3');
		perform pg_temp.base_assert(w.harness is null and not w.harness_default and w.claude_login_id is null
			and (select v.structured -> 'parse' ->> 'harness' from public.qorpera_folder_path_versions v
				where v.version = w.folder_brief_version) = 'codex',
			'1: a member''s ask for Codex wins and its brief says so: ' || to_jsonb(w)::text);
		perform pg_temp.cf_saved(pg_temp.c4_dispatch(v_alice, 'claude-first-claude', v_folder || 'claude',
			pg_temp.c4_brief('12840000-0000-4000-8000-0000000000d4')), '1: the claude-code dispatch');
		w := pg_temp.c4_worker('12840000-0000-4000-8000-0000000000d4');
		perform pg_temp.base_assert(w.harness = 'claude-code' and not w.harness_default,
			'1: a member''s ask for Claude Code is no default: ' || to_jsonb(w)::text);
		begin
			update public.qorpera_claude_logins set status = 'revoked', revoked_at = statement_timestamp(), key_id = null,
				encrypted_envelope = null, envelope_sha256 = null where id = '12840000-0000-4000-8000-0000000000c1';
			perform pg_temp.cf_saved(pg_temp.c4_dispatch(v_alice, 'claude-first-signed-out', v_folder || 'signed-out',
				pg_temp.c4_brief('12840000-0000-4000-8000-0000000000d5', null)), '1: signed out, the dispatch still saves');
			w := pg_temp.c4_worker('12840000-0000-4000-8000-0000000000d5');
			perform pg_temp.base_assert(w.harness is null and w.harness_default and w.claude_login_id is null,
				'1: signed out: Codex: ' || to_jsonb(w)::text);
			perform pg_temp.cf_saved(pg_temp.c4_dispatch(v_alice, 'claude-first-signed-out-codex', v_folder || 'signed-out-codex',
				pg_temp.c4_brief('12840000-0000-4000-8000-0000000000d8', 'codex')), '1: signed out, an ask for Codex saves');
			perform pg_temp.base_assert((pg_temp.c4_worker('12840000-0000-4000-8000-0000000000d8')).harness is null,
				'1: and it is Codex''s');
			raise exception 'claude-first-undo';
		exception when raise_exception then if sqlerrm <> 'claude-first-undo' then raise; end if;
		end;
		begin
			perform pg_temp.h1_switch(true, false);
			perform pg_temp.cf_saved(pg_temp.c4_dispatch(v_alice, 'claude-first-no-home', v_folder || 'no-home',
				pg_temp.c4_brief('12840000-0000-4000-8000-0000000000d6', null)), '1: no machine, the dispatch still saves');
			w := pg_temp.c4_worker('12840000-0000-4000-8000-0000000000d6');
			perform pg_temp.base_assert(w.harness is null and w.harness_default,
				'1: no machine for the member''s work: Codex: ' || to_jsonb(w)::text);
			raise exception 'claude-first-undo';
		exception when raise_exception then if sqlerrm <> 'claude-first-undo' then raise; end if;
		end;
		begin
			delete from public.qorpera_claude_sign_in_members where user_id = pg_temp.c4_owner_id();
			perform pg_temp.cf_saved(pg_temp.c4_dispatch(v_alice, 'claude-first-not-listed', v_folder || 'not-listed',
				pg_temp.c4_brief('12840000-0000-4000-8000-0000000000d7', null)), '1: not on the list, the dispatch still saves');
			w := pg_temp.c4_worker('12840000-0000-4000-8000-0000000000d7');
			perform pg_temp.base_assert(w.harness is null and w.harness_default,
				'1: Claude Code not open for the member: Codex: ' || to_jsonb(w)::text);
			raise exception 'claude-first-undo';
		exception when raise_exception then if sqlerrm <> 'claude-first-undo' then raise; end if;
		end;
		perform pg_temp.base_error(format('update public.qorpera_runtime_workers set claude_fallback_sequence = 1 where id = %L',
			'12840000-0000-4000-8000-0000000000d4'), '23514');
		raise exception 'claude-first-undo';
	exception when raise_exception then if sqlerrm <> 'claude-first-undo' then raise; end if;
	end;
end $$;

do $$
declare v_alice jsonb := pg_temp.c4_alice(); v_binding jsonb; w public.qorpera_runtime_workers%rowtype;
begin
	perform pg_temp.cf_saved(pg_temp.c4_dispatch(v_alice, 'claude-first-asked', 'QorperaOS/agents/alice/todos/onboarding/asked',
		pg_temp.c4_brief('12840000-0000-4000-8000-0000000000e1', p_title => 'Make the asked PDF')), '2: the asked dispatch');
	perform pg_temp.cf_saved(pg_temp.c4_dispatch(v_alice, 'claude-first-made', 'QorperaOS/agents/alice/todos/onboarding/made',
		pg_temp.c4_brief('12840000-0000-4000-8000-0000000000e2', null, 'Make the deck')), '2: the default dispatch');
	perform pg_temp.c4_drain();
	perform pg_temp.base_assert((pg_temp.c4_worker('12840000-0000-4000-8000-0000000000e1')).occurrence_id is not null
		and (pg_temp.c4_worker('12840000-0000-4000-8000-0000000000e2')).occurrence_id is null
		and not public.qorpera_folder_worker_due(pg_temp.c4_worker('12840000-0000-4000-8000-0000000000e2')),
		'2: the default waits for the member''s lease like any Claude Code worker');
	v_binding := pg_temp.cf_start_next();
	perform pg_temp.base_assert((pg_temp.cf_wake('12840000-0000-4000-8000-0000000000e1')).run_id = (v_binding ->> 'runId')::uuid,
		'2: the asked worker''s run started');
	perform pg_temp.base_assert(pg_temp.cf_fall_back(v_binding, 'limit') = 'kept', '2: an asked worker is kept');
	w := pg_temp.c4_worker('12840000-0000-4000-8000-0000000000e1');
	perform pg_temp.base_assert(w.harness = 'claude-code' and w.occurrence_id is not null and w.claude_fallback_sequence is null
		and not exists (select 1 from public.qorpera_runtime_worker_events where worker_id = w.id and kind = 'fell_back'),
		'2: and nothing of it changed: ' || to_jsonb(w)::text);
	perform pg_temp.base_assert(pg_temp.cf_fall_back(v_alice, 'limit') = 'kept', '2: the agent''s own run is no worker''s');
	perform pg_temp.c4_end_job((v_binding ->> 'runId')::uuid, 'completed');
	perform pg_temp.c4_drain();
	perform pg_temp.base_assert((pg_temp.c4_worker('12840000-0000-4000-8000-0000000000e2')).occurrence_id is not null
		and (pg_temp.c4_lease()).worker_id = '12840000-0000-4000-8000-0000000000e2', '2: then the default starts with the lease');
	v_binding := pg_temp.cf_start_next();
	perform pg_temp.base_assert((pg_temp.cf_wake('12840000-0000-4000-8000-0000000000e2')).run_id = (v_binding ->> 'runId')::uuid
		and (pg_temp.cf_wake('12840000-0000-4000-8000-0000000000e2')).payload ->> 'harness' = 'claude-code',
		'2: the default''s Claude Code run started');
	perform set_config('qorpera_test.cf_claude', v_binding::text, false);
end $$;

do $$
declare v_claude jsonb := pg_temp.cf_binding('claude'); w public.qorpera_runtime_workers%rowtype;
	v_wake public.qorpera_wake_occurrences%rowtype; v_lease public.qorpera_claude_worker_leases%rowtype; v_codex jsonb;
	v_event public.qorpera_runtime_worker_events%rowtype;
begin
	v_lease := pg_temp.c4_lease();
	perform pg_temp.base_assert(pg_temp.cf_fall_back(v_claude, 'limit', '["product/deck.md","product/deck-notes.md"]')
		= 'fell_back', '3: the default''s run hands it back');
	w := pg_temp.c4_worker('12840000-0000-4000-8000-0000000000e2');
	perform pg_temp.base_assert(w.state = 'active' and w.harness is null and w.claude_login_id is null and w.claude_model is null
		and w.occurrence_id is null and w.claude_fallback_sequence = 1 and w.sequence = 1 and w.harness_default,
		'3: the worker is Codex''s now, waiting to start: ' || to_jsonb(w)::text);
	perform pg_temp.base_assert(w.dispatch ->> 'context' = format('Claude Code started this work and stopped before it '
		|| 'finished (%s''s Claude plan reached its limit). It changed: product/deck.md, product/deck-notes.md. Read those '
		|| 'files first and carry on from where it stopped.', pg_temp.c4_name()), '3: Codex is told what Claude Code changed: '
		|| (w.dispatch ->> 'context'));
	select * into strict v_event from public.qorpera_runtime_worker_events where worker_id = w.id and kind = 'fell_back';
	perform pg_temp.base_assert(v_event.run_id = (v_claude ->> 'runId')::uuid and v_event.sequence = 1
		and v_event.body ->> 'reason' = 'limit', '3: the record: ' || to_jsonb(v_event)::text);
	perform pg_temp.base_assert(pg_temp.cf_fall_back(v_claude, 'limit', '["product/deck.md","product/deck-notes.md"]')
		= 'fell_back', '3: a repeat answers the same');
	perform pg_temp.c4_drain();
	w := pg_temp.c4_worker(w.id);
	v_wake := pg_temp.cf_wake(w.id);
	perform pg_temp.base_assert(v_wake.status = 'queued'
		and v_wake.occurrence_key = 'worker-dispatch:' || w.id::text || ':1:codex'
		and not (v_wake.payload ? 'harness') and not (v_wake.payload ? 'claude')
		and v_wake.payload -> 'dispatch' ->> 'context' = w.dispatch ->> 'context',
		'3: the drain starts it on Codex under a key of its own: ' || to_jsonb(v_wake)::text);
	perform pg_temp.base_assert((pg_temp.c4_lease()).wake_id = v_lease.wake_id, '3: the Codex run takes no Claude lease');
	perform pg_temp.base_assert(pg_temp.cf_fall_back(v_claude, 'signed_out') = 'fell_back'
		and (select count(*) from public.qorpera_runtime_worker_events where worker_id = w.id and kind = 'fell_back') = 1,
		'3: the Claude run asking again after the drain changes nothing');
	v_codex := pg_temp.cf_start_next();
	perform pg_temp.base_assert(v_wake.id = (select wake.id from public.qorpera_wake_occurrences wake
		where wake.run_id = (v_codex ->> 'runId')::uuid), '3: the Codex run started');
	perform pg_temp.base_assert(pg_temp.cf_fall_back(v_codex, 'could_not_start') = 'kept', '3: a Codex run is never handed back');
	perform pg_temp.cf_saved(pg_temp.c4_results(v_codex, 'claude-first-codex-report', w.folder_path), '3: the Codex run reports');
	perform pg_temp.base_assert((pg_temp.c4_worker(w.id)).state = 'succeeded', '3: the worker is done');
	perform pg_temp.c4_end_job((v_claude ->> 'runId')::uuid, 'completed');
	perform pg_temp.c4_end_job((v_codex ->> 'runId')::uuid, 'completed');
end $$;

do $$
declare v_alice jsonb := pg_temp.c4_alice(); w public.qorpera_runtime_workers%rowtype; v_wake public.qorpera_wake_occurrences%rowtype;
	v_binding jsonb; v_folder text := 'QorperaOS/agents/alice/todos/onboarding/made';
begin
	perform pg_temp.cf_saved(pg_temp.c4_followup(v_alice, 'claude-first-followup-1', v_folder, 'Add the prices.'), '4: the follow-up');
	w := pg_temp.c4_worker('12840000-0000-4000-8000-0000000000e2');
	perform pg_temp.base_assert(w.sequence = 2 and w.harness = 'claude-code' and w.harness_default
		and w.claude_login_id = '12840000-0000-4000-8000-0000000000c1' and w.claude_fallback_sequence = 1,
		'4: ready again, the follow-up goes to Claude Code: ' || to_jsonb(w)::text);
	perform pg_temp.c4_drain();
	v_wake := pg_temp.cf_wake(w.id);
	perform pg_temp.base_assert(v_wake.occurrence_key = 'worker-dispatch:' || w.id::text || ':2'
		and v_wake.payload ->> 'harness' = 'claude-code' and (pg_temp.c4_lease()).wake_id = v_wake.id,
		'4: under the plain key, with the lease: ' || to_jsonb(v_wake)::text);
	v_binding := pg_temp.cf_start_next();
	perform pg_temp.cf_saved(pg_temp.c4_results(v_binding, 'claude-first-claude-report', v_folder), '4: Claude Code reports');
	perform pg_temp.c4_end_job((v_binding ->> 'runId')::uuid, 'completed');
	begin
		update public.qorpera_runtime_workers set requested_by_user_id = (select m.user_id from public.qorpera_profile_members m
			where m.profile_id = '92400000-0000-4000-8000-000000000010' and m.user_id <> pg_temp.c4_owner_id()
			order by m.user_id limit 1)
		where id = w.id;
		perform pg_temp.base_assert((pg_temp.c4_worker(w.id)).harness = 'claude-code', '4: on Claude Code before another''s word');
		perform pg_temp.cf_saved(pg_temp.c4_followup(v_alice, 'claude-first-followup-other', v_folder, 'Add the logo.'),
			'4: another member''s follow-up of a default is not refused');
		w := pg_temp.c4_worker(w.id);
		perform pg_temp.base_assert(w.harness is null and w.claude_login_id is null and w.claude_model is null,
			'4: it never runs on the asker''s Claude plan: ' || to_jsonb(w)::text);
		perform pg_temp.c4_drain();
		perform pg_temp.base_assert(not ((pg_temp.cf_wake(w.id)).payload ? 'harness'), '4: and starts on Codex');
		raise exception 'claude-first-undo';
	exception when raise_exception then if sqlerrm <> 'claude-first-undo' then raise; end if;
	end;
	w := pg_temp.c4_worker(w.id);
	update public.qorpera_claude_logins set status = 'revoked', revoked_at = statement_timestamp(), key_id = null,
		encrypted_envelope = null, envelope_sha256 = null where id = '12840000-0000-4000-8000-0000000000c1';
	perform pg_temp.cf_saved(pg_temp.c4_followup(v_alice, 'claude-first-followup-2', v_folder, 'Add the dates.'),
		'4: signed out, the follow-up of a default is not refused');
	w := pg_temp.c4_worker(w.id);
	perform pg_temp.base_assert(w.sequence = 3 and w.harness is null and w.claude_login_id is null and w.claude_model is null
		and w.harness_default, '4: it goes to Codex: ' || to_jsonb(w)::text);
	perform pg_temp.c4_drain();
	v_wake := pg_temp.cf_wake(w.id);
	perform pg_temp.base_assert(v_wake.occurrence_key = 'worker-dispatch:' || w.id::text || ':3' and not (v_wake.payload ? 'harness'),
		'4: a plain Codex start: ' || to_jsonb(v_wake)::text);
end $$;

do $$
declare v_claude jsonb := pg_temp.cf_binding('claude'); v_role text; v_function text;
begin
	perform pg_temp.base_error(format('select public.qorpera_claude_worker_fall_back(%L, %L, %L)', v_claude, 'tired', '[]'), '22023');
	perform pg_temp.base_error(format('select public.qorpera_claude_worker_fall_back(%L, null, %L)', v_claude, '[]'), '22023');
	perform pg_temp.base_error(format('select public.qorpera_claude_worker_fall_back(%L, %L, %L)', v_claude, 'limit', '{}'), '22023');
	perform pg_temp.base_error(format('select public.qorpera_claude_worker_fall_back(%L, %L, %L)', v_claude, 'limit',
		'["a","b","c","d","e","f","g","h","i"]'), '22023');
	perform pg_temp.base_error(format('select public.qorpera_claude_worker_fall_back(%L, %L, %L)', v_claude, 'limit',
		jsonb_build_array(E'a\nb')), '22023');
	perform pg_temp.base_error(format('select public.qorpera_claude_worker_fall_back(%L, %L, %L)', v_claude, 'limit',
		jsonb_build_array(repeat('a', 257))), '22023');
	perform pg_temp.base_claims('authenticated', pg_temp.c4_owner_id());
	perform pg_temp.base_error(format('select public.qorpera_claude_worker_fall_back(%L, %L, %L)', v_claude, 'limit', '[]'), '42501');
	perform pg_temp.base_claims('service_role');
	foreach v_role in array array['anon', 'authenticated', 'qorpera_secret_broker'] loop
		if has_function_privilege(v_role, 'public.qorpera_claude_worker_fall_back(jsonb,text,jsonb)', 'execute') then
			raise exception '5: % may call the fallback', v_role; end if;
	end loop;
	if not has_function_privilege('service_role', 'public.qorpera_claude_worker_fall_back(jsonb,text,jsonb)', 'execute') then
		raise exception '5: the runtime may not call the fallback'; end if;
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		foreach v_function in array array['public.qorpera_claude_worker_default_login(uuid,uuid,uuid,uuid)',
			'public.qorpera_claude_worker_resolve(uuid,uuid,uuid)'] loop
			if has_function_privilege(v_role, v_function, 'execute') then raise exception '5: % may call %', v_role, v_function; end if;
		end loop;
	end loop;
	perform pg_temp.base_assert((select scope from public.qorpera_native_host_calls where name = 'qorpera_claude_worker_fall_back')
		= 'binding', '5: the run''s host reaches it with the run''s binding');
end $$;
