-- @fixture 596_runtime_agent_thread_cards.test.sql until "-- A group chat carries no card"
-- 20260930525000 (QORPERA-RUNTIME-CONTRACT.md, the 2026-10-21 amendment, item 3): a run woken by a member's answer to a
-- card shows the card beside the answer, and qorpera_read_company_run_card reads a card its history no longer holds.
-- On 596's thread cards: Bob raises a card, the owner answers it, and the answer's run reads the card by its id, as its
-- context shows a history entry (the whole text's hash, its first 16 KiB). A post or an answer is no card, an unknown id
-- is none, and a card raised after the run's transcript start is not the run's to read. The native host may call it
-- with the run's binding.

do $$
declare v_binding jsonb; v_answer jsonb; v_run uuid; v_card jsonb; v_listed jsonb;
	c_card constant uuid := '54800000-0000-4000-8000-0000000009a1';
begin
	v_binding := pg_temp.cd_post(current_setting('qorpera_test.card_room')::uuid, 'Bob, set up the Slack digest.');
	perform pg_temp.cd_card(v_binding, c_card);
	perform pg_temp.base_public_send(v_binding, 'final', 'card-final');
	perform public.qorpera_fail_runner_job((v_binding ->> 'runnerId')::uuid, repeat('2', 64), (v_binding ->> 'jobId')::uuid,
		repeat('3', 64), 'card fixture run ended', false);
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	v_answer := pg_temp.cd_answer(extensions.gen_random_uuid(), c_card, 'answered', '{"values":["finance"]}');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(pg_temp.base_materialize() ->> 'state' = 'done', 'The next pass runs');
	select run_id into strict v_run from public.qorpera_wake_occurrences
	where source_kind = 'room' and source_id = (v_answer ->> 'input_id')::uuid;
	v_binding := pg_temp.base_start(v_run);

	-- The card, as the run's history shows it: the same entry, the whole text's hash, all of a small card's text.
	v_card := public.qorpera_read_company_run_card(v_binding, c_card);
	select entry into v_listed from jsonb_array_elements(public.qorpera_describe_company_run_context(v_binding) -> 'history') entry
	where entry ->> 'id' = c_card::text;
	perform pg_temp.base_assert(v_card ->> 'id' = c_card::text and v_card ->> 'sourceKind' = 'history'
		and v_card ->> 'kind' = 'historical_data' and v_card -> 'images' = '[]'::jsonb
		and v_card #>> '{content,offset}' = '0' and v_card #> '{content,nextOffset}' = 'null'::jsonb
		and v_card #>> '{content,truncated}' = 'false'
		and v_card #>> '{content,text}' like '%Which channel should the digest go to?%'
		and v_card #>> '{content,sha256}' = encode(extensions.digest(convert_to(v_card #>> '{content,text}', 'utf8'), 'sha256'), 'hex'),
		'The card is read whole as a history entry: ' || v_card::text);
	perform pg_temp.base_assert(v_listed is not null and (v_listed - 'content') = (v_card - 'content')
		and v_listed #>> '{content,sha256}' = v_card #>> '{content,sha256}',
		'The card is the entry the run''s history shows: ' || coalesce(v_listed::text, 'missing'));

	-- The answer is no card, an unknown id is none, and a card the run raises after its start is not its to read.
	perform pg_temp.base_error(format('select public.qorpera_read_company_run_card(%L, %L)', v_binding, v_answer ->> 'input_id'),
		'42501', 'Cloud context history is unavailable');
	perform pg_temp.base_error(format('select public.qorpera_read_company_run_card(%L, %L)', v_binding,
		extensions.gen_random_uuid()), '42501', 'Cloud context history is unavailable');
	perform pg_temp.cd_card(v_binding, '54800000-0000-4000-8000-0000000009a2');
	perform pg_temp.base_error(format('select public.qorpera_read_company_run_card(%L, %L)', v_binding,
		'54800000-0000-4000-8000-0000000009a2'), '42501', 'Cloud context history is unavailable');
end
$$;

-- The native host calls it with the run's binding, and no API role may.
do $$
begin
	perform pg_temp.base_assert((select scope = 'binding' and budget = 'standard' from public.qorpera_native_host_calls
		where name = 'qorpera_read_company_run_card'), 'The native host may call it with the run''s binding');
	perform pg_temp.base_assert(not has_function_privilege('anon', 'public.qorpera_read_company_run_card(jsonb,uuid)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_read_company_run_card(jsonb,uuid)', 'execute')
		and has_function_privilege('service_role', 'public.qorpera_read_company_run_card(jsonb,uuid)', 'execute'),
		'Only the platform calls it');
end
$$;

rollback;
