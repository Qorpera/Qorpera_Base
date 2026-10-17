begin;
-- F3 step 5e D3 (20260930398000): a deleted company's code hosts go with it. Each node's coding executor asks
-- qorpera_code_hosts_deleting, under its custody check, which of the companies with a code host project on the node
-- have a deletion request (purged or not), at most 500 a call. The answer tells nothing else; the function is
-- read-only and the service role's only.
create function pg_temp.claims(p_role text) returns void language sql as $$
	select set_config('request.jwt.claims',jsonb_build_object('role',p_role)::text,true)::text::void $$;
create function pg_temp.ok(p_value boolean,p_message text) returns void language plpgsql as $$
begin if p_value is distinct from true then raise exception '%',p_message; end if; end $$;
create function pg_temp.fails(p_statement text,p_message text) returns void language plpgsql as $$
declare v_message text;
begin
	begin execute p_statement; exception when others then get stacked diagnostics v_message = message_text;
		if v_message not like p_message then raise exception 'Expected "%", got "%" for %',p_message,v_message,p_statement; end if;
		return; end;
	raise exception 'Accepted: %',p_statement;
end $$;
create function pg_temp.company(p_n int) returns uuid language sql as $$
	select format('49400000-0000-4000-8000-%s',lpad(p_n::text,12,'0'))::uuid $$;
create function pg_temp.ask(p_ids uuid[],p_owner text default 'node-a',p_hash text default repeat('4',64)) returns uuid[]
language sql as $$ select public.qorpera_code_hosts_deleting(p_owner,p_hash,p_ids) $$;

-- The service role's only, read-only, as definer with an empty search path.
select pg_temp.ok(not has_function_privilege('public','public.qorpera_code_hosts_deleting(text,text,uuid[])','execute')
	and not has_function_privilege('anon','public.qorpera_code_hosts_deleting(text,text,uuid[])','execute')
	and not has_function_privilege('authenticated','public.qorpera_code_hosts_deleting(text,text,uuid[])','execute')
	and has_function_privilege('service_role','public.qorpera_code_hosts_deleting(text,text,uuid[])','execute'),
	'Only the service role may ask');
select pg_temp.ok((select provolatile = 's' and prosecdef and proconfig = array['search_path=""'] from pg_proc
	where oid = 'public.qorpera_code_hosts_deleting(text,text,uuid[])'::regprocedure),'Stable definer with an empty search path');

-- Company 1's deletion is open, company 2's is purged; company 3 is not being deleted.
insert into public.qorpera_company_deletions(profile_id,requested_by_user_id) values (pg_temp.company(1),null);
insert into public.qorpera_company_deletions(profile_id,requested_by_user_id,checked_at,purged_at)
	values (pg_temp.company(2),null,clock_timestamp(),clock_timestamp());

-- Only the coding executor's custody asks.
select pg_temp.claims('authenticated');
select pg_temp.fails($q$select pg_temp.ask(array[pg_temp.company(1)])$q$,'Coding machine custody required');
select pg_temp.claims('anon');
select pg_temp.fails($q$select pg_temp.ask(array[pg_temp.company(1)])$q$,'Coding machine custody required');
select pg_temp.claims('service_role');
set local role service_role;
select pg_temp.fails($q$select pg_temp.ask(array[pg_temp.company(1)],null)$q$,'Coding machine custody required');
select pg_temp.fails($q$select pg_temp.ask(array[pg_temp.company(1)],'node a')$q$,'Coding machine custody required');
select pg_temp.fails($q$select pg_temp.ask(array[pg_temp.company(1)],repeat('n',121))$q$,'Coding machine custody required');
select pg_temp.fails($q$select pg_temp.ask(array[pg_temp.company(1)],'node-a',null)$q$,'Coding machine custody required');
select pg_temp.fails($q$select pg_temp.ask(array[pg_temp.company(1)],'node-a',repeat('A',64))$q$,'Coding machine custody required');
select pg_temp.fails($q$select pg_temp.ask(array[pg_temp.company(1)],'node-a',repeat('4',63))$q$,'Coding machine custody required');

-- One list of at most 500 companies, none of them null.
select pg_temp.fails($q$select pg_temp.ask(null)$q$,'Code host companies invalid');
select pg_temp.fails($q$select pg_temp.ask(array(select pg_temp.company(n) from generate_series(1,501) n))$q$,
	'Code host companies invalid');
select pg_temp.fails($q$select pg_temp.ask(array[pg_temp.company(1),null])$q$,'Code host companies invalid');
select pg_temp.fails($q$select pg_temp.ask(array[[pg_temp.company(1)],[pg_temp.company(3)]])$q$,'Code host companies invalid');
select pg_temp.fails($q$select pg_temp.ask(array[[pg_temp.company(1),null]])$q$,'Code host companies invalid');

-- The answer names just the asked companies with a deletion request, open or purged, each once.
select pg_temp.ok(pg_temp.ask(array[pg_temp.company(3),pg_temp.company(2),pg_temp.company(1)])
	= array[pg_temp.company(1),pg_temp.company(2)],'Both deletions, open and purged');
select pg_temp.ok(pg_temp.ask(array[pg_temp.company(2),pg_temp.company(2),pg_temp.company(3)]) = array[pg_temp.company(2)],
	'A company asked twice is named once');
select pg_temp.ok(pg_temp.ask(array[pg_temp.company(3)]) = '{}'::uuid[],'A company not being deleted is not named');
select pg_temp.ok(pg_temp.ask('{}'::uuid[]) = '{}'::uuid[],'Nothing asked, nothing named');
select pg_temp.ok(pg_temp.ask(array(select pg_temp.company(n) from generate_series(1,500) n))
	= array[pg_temp.company(1),pg_temp.company(2)],'500 companies at once');
reset role;

-- It changes nothing.
select pg_temp.ok((select count(*) = 2 and count(purged_at) = 1 from public.qorpera_company_deletions
	where profile_id in (pg_temp.company(1),pg_temp.company(2),pg_temp.company(3))),'The deletions are as they were');
rollback;
