-- F3, the server-side folder search (20260929999975): observations name `company_search`, next to the mail tools, and
-- the list around it is unchanged (test 320 records an observation of every name).
do $$
declare v_body text := pg_get_functiondef('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure);
begin
	if position('''list_hooks'',''read_event'',''send_mail'',''find_mail'',''company_search'',' in v_body) = 0 then
		raise exception 'The observation vocabulary names company_search after find_mail'; end if;
	if (length(v_body) - length(replace(v_body, '''company_search''', ''))) / length('''company_search''') <> 1 then
		raise exception 'company_search is named once'; end if;
end $$;

rollback;
