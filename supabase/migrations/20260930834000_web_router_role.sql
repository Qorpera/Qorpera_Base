do $$
begin
	if to_regprocedure('public.qorpera_web_edge_redeem_member_pass(text,text)') is null then
		raise exception '20260930834000 requires native web hosting wiring (20260930833000)';
	end if;
	if not exists (select 1 from pg_roles where rolname = 'qorpera_web_router') then
		create role qorpera_web_router nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
	end if;
	if exists (
		select 1 from pg_roles
		where rolname = 'qorpera_web_router'
			and (rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)
	) then
		raise exception 'qorpera_web_router role has unsafe attributes';
	end if;
end $$;

set local lock_timeout = '3s';

do $$
declare
	v_proc regprocedure;
	v_def text;
	v_next text;
begin
	foreach v_proc in array array[
		'public.qorpera_web_edge_snapshot()'::regprocedure,
		'public.qorpera_web_edge_tls_allow(text)'::regprocedure,
		'public.qorpera_web_domain_mark_checked(uuid,text,text)'::regprocedure,
		'public.qorpera_web_deployment_set_upstream(uuid,text)'::regprocedure,
		'public.qorpera_web_edge_redeem_ticket(text,text)'::regprocedure,
		'public.qorpera_web_edge_redeem_member_pass(text,text)'::regprocedure
	] loop
		v_def := pg_get_functiondef(v_proc);
		if strpos(v_def, '''qorpera_web_router''') > 0 then
			continue;
		end if;
		v_next := replace(
			v_def,
			'session_user not in (''postgres'', ''service_role'')',
			'session_user not in (''postgres'', ''service_role'', ''qorpera_web_router'')'
		);
		if v_next = v_def then
			raise exception '20260930834000: expected service_role guard missing in %', v_proc;
		end if;
		execute v_next;
	end loop;
end $$;

grant usage on schema public to qorpera_web_router;

grant execute on function
	public.qorpera_web_edge_snapshot(),
	public.qorpera_web_edge_tls_allow(text),
	public.qorpera_web_domain_mark_checked(uuid, text, text),
	public.qorpera_web_deployment_set_upstream(uuid, text),
	public.qorpera_web_edge_redeem_ticket(text, text),
	public.qorpera_web_edge_redeem_member_pass(text, text)
	to qorpera_web_router;
