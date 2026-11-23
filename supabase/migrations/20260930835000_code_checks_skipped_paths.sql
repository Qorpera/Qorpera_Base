set local lock_timeout = '3s';

create or replace function public.qorpera_code_checks_passed_valid(p_result jsonb, p_commit text, p_how text)
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(case when jsonb_typeof(p_result) = 'object' then pg_column_size(p_result) <= 8192
		and p_result - array['schema','commit','how','file','ms','copyMs','checks','changed','tries'] = '{}'::jsonb
		and p_result -> 'schema' = '"qorpera.code-checks/v1"'::jsonb
		and p_result ->> 'commit' = p_commit and p_result ->> 'how' = p_how
		and public.qorpera_code_json_text(p_result -> 'file', '^[0-9a-f]{40}$')
		and public.qorpera_code_json_count(p_result -> 'ms') and public.qorpera_code_json_count(p_result -> 'copyMs')
		and jsonb_typeof(p_result -> 'tries') = 'number' and p_result ->> 'tries' in ('1','2')
		and case when jsonb_typeof(p_result -> 'checks') = 'array' then jsonb_array_length(p_result -> 'checks') between 1 and 20
				and not exists (select 1 from jsonb_array_elements(p_result -> 'checks') item
					where case when jsonb_typeof(item) = 'object' then item - array['name','run','ms','skipped'] <> '{}'::jsonb
						or not public.qorpera_code_json_text(item -> 'name', '^[a-z0-9][a-z0-9._-]{0,39}$')
						or not public.qorpera_code_json_text(item -> 'run', '.') or octet_length(item ->> 'run') > 200
						or not public.qorpera_code_json_count(item -> 'ms')
						or (item ? 'skipped' and item -> 'skipped' <> '"paths_unmatched"'::jsonb)
						else true end)
				and (select count(distinct item ->> 'name') = count(*) from jsonb_array_elements(p_result -> 'checks') item)
			else false end
		and case jsonb_typeof(p_result -> 'changed') when 'null' then true
			when 'object' then (p_result -> 'changed') - array['added','removed','run'] = '{}'::jsonb
				and not exists (select 1 from unnest(array['added','removed','run']) list(key)
					where case when public.qorpera_code_json_strings(p_result -> 'changed' -> list.key, 20)
						then exists (select 1 from jsonb_array_elements_text(p_result -> 'changed' -> list.key) named(name)
							where named.name !~ '^[a-z0-9][a-z0-9._-]{0,39}$')
						else true end)
			else false end
		else false end, false)
$$;

revoke all on function public.qorpera_code_checks_passed_valid(jsonb, text, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
