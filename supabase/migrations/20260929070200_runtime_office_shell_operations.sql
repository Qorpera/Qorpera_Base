-- 20260929070200: the office accepts the long-running shell's actions
-- (2026-09-28 amendment "compute for agents", item 2). The computer_shell tool
-- now sends start, read, write, stop and list; the operation check still took
-- only the 15-second form, which runtime bundles before this keep sending.
-- Exactly the shapes the tool's parser produces: each action's own keys, a
-- command or input of at most 16 KiB, a wait of at most 15 seconds, and a
-- command id the office issued. Patched in place, so other patches commute.

create function public.qorpera_valid_office_shell_action(p_args jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
	v_keys text[];
	v_wait jsonb:=p_args->'waitMs';
	v_session text:=p_args->>'sessionId';
begin
	if jsonb_typeof(p_args) is distinct from 'object' or p_args->>'kind' is distinct from 'shell' then return false; end if;
	-- The 15-second form of older runtime bundles.
	if not p_args ? 'action' then
		return p_args-'kind'-'command'-'timeoutMs'='{}'::jsonb
			and jsonb_typeof(p_args->'command')='string'
			and length(btrim(p_args->>'command'))>0 and octet_length(p_args->>'command')<=16384
			and case when coalesce(p_args->>'timeoutMs','') ~ '^[0-9]{1,5}$'
				then (p_args->>'timeoutMs')::integer between 1 and 15000 else false end;
	end if;
	select array_agg(key order by key collate "C") into v_keys from jsonb_object_keys(p_args) as key;
	if p_args ? 'waitMs' and not (case when jsonb_typeof(v_wait)='number' and v_wait::text ~ '^[0-9]{1,5}$'
		then v_wait::text::integer<=15000 else false end) then return false; end if;
	if p_args ? 'sessionId' and (jsonb_typeof(p_args->'sessionId') is distinct from 'string'
		or v_session !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') then return false; end if;
	return case p_args->>'action'
		when 'start' then v_keys=array['action','command','kind','waitMs']
			and jsonb_typeof(p_args->'command')='string'
			and length(btrim(p_args->>'command'))>0 and octet_length(p_args->>'command')<=16384
		when 'read' then v_keys=array['action','kind','sessionId','waitMs']
		when 'write' then v_keys=array['action','endInput','kind','sessionId','text','waitMs']
			and jsonb_typeof(p_args->'text')='string' and octet_length(p_args->>'text')<=16384
			and jsonb_typeof(p_args->'endInput')='boolean'
			and (p_args->>'text'<>'' or p_args->'endInput'='true'::jsonb)
		when 'stop' then v_keys=array['action','kind'] or v_keys=array['action','kind','sessionId']
		when 'list' then v_keys=array['action','kind']
		else false
	end;
end $$;
revoke all on function public.qorpera_valid_office_shell_action(jsonb) from public,anon,authenticated,service_role;

create function pg_temp.office_shell_operations_patch(p_target regprocedure,p_old text,p_new text)
returns void language plpgsql as $$
declare v_definition text:=pg_get_functiondef(p_target);
begin
	if (length(v_definition)-length(replace(v_definition,p_old,'')))/length(p_old)<>1 then
		raise exception 'Office shell operation integration differs: %',p_target; end if;
	execute replace(v_definition,p_old,p_new);
end $$;
select pg_temp.office_shell_operations_patch(
	'public.qorpera_native_office_operation(jsonb,jsonb,jsonb,text,text,uuid,text)'::regprocedure,
	$old$		if (v_operation->'arguments')-'kind'-'command'-'timeoutMs'<>'{}'::jsonb
			or jsonb_typeof(v_operation#>'{arguments,command}') is distinct from 'string'
			or length(btrim(v_operation#>>'{arguments,command}'))=0 or octet_length(v_operation#>>'{arguments,command}')>16384
			or coalesce(v_operation#>>'{arguments,timeoutMs}','') !~ '^[0-9]{1,5}$'
			or (v_operation#>>'{arguments,timeoutMs}')::integer not between 1 and 15000 then$old$,
	$new$		-- Every computer_shell action and the older 15-second form (20260929070200).
		if not public.qorpera_valid_office_shell_action(v_operation->'arguments') then$new$);

-- The operation function may have a private owner in production.
do $$ declare v_owner name; begin
	select pg_get_userbyid(proowner) into v_owner from pg_proc
		where oid='public.qorpera_native_office_operation(jsonb,jsonb,jsonb,text,text,uuid,text)'::regprocedure;
	if v_owner in ('anon','authenticated','service_role','qorpera_secret_broker') then
		raise exception 'Office operation function has an API owner'; end if;
	if v_owner is distinct from current_user then
		execute format('grant execute on function public.qorpera_valid_office_shell_action(jsonb) to %I',v_owner); end if;
end $$;
