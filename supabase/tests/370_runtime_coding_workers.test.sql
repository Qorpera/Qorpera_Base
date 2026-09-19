-- Run only against the disposable database after migrations. No deployment URL.
begin;
do $$
declare r text; t text; n text; v_bad jsonb; v_repo jsonb := '{"host":"github.com","owner":"Qorpera","name":"platform","baseBranch":"feature/runtime.v2"}';
begin
	if not public.qorpera_coding_repository_valid(v_repo) then raise exception 'Valid coding repository rejected'; end if;
	for v_bad in select value from jsonb_array_elements('[null,{},[],{"host":"git.example","owner":"Qorpera","name":"platform","baseBranch":"main"}]') loop
		if public.qorpera_coding_repository_valid(v_bad) then raise exception 'Invalid coding repository accepted: %',v_bad; end if;
	end loop;
	foreach n in array array['-option','main..other','refs//main','refs/.hidden','refs/topic.lock','refs/topic.','main/','main:other','HEAD~1','main@{1}'] loop
		if public.qorpera_coding_repository_valid(jsonb_set(v_repo,'{baseBranch}',to_jsonb(n))) then
			raise exception 'Unsafe Git ref accepted: %',n; end if;
	end loop;
	if public.qorpera_coding_repository_valid(v_repo||'{"url":"https://evil.example/repo"}')
		or public.qorpera_coding_repository_valid(v_repo||'{"owner":"owner-"}')
		or not public.qorpera_coding_repository_valid(v_repo||'{"name":"_repo"}') then
		raise exception 'Coding repository parser differs from the closed wire contract'; end if;
	foreach r in array array['anon','authenticated','service_role'] loop
		foreach t in array array['qorpera_coding_workers','qorpera_coding_requests','qorpera_coding_repository_grants','qorpera_coding_executors','qorpera_coding_completions'] loop
			if has_table_privilege(r,'public.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') then
				raise exception 'Coding ledger table exposed to %: %',r,t; end if;
		end loop;
		if has_function_privilege(r,'public.qorpera_coding_assert_delegation(public.qorpera_coding_workers,uuid)','EXECUTE')
			or has_function_privilege(r,'public.qorpera_coding_locked_request(uuid,uuid)','EXECUTE') then
			raise exception 'Coding internal authority helper exposed to %',r; end if;
		if r<>'service_role' and (has_function_privilege(r,'public.qorpera_dispatch_coding_worker(jsonb,jsonb)','EXECUTE')
			or has_function_privilege(r,'public.qorpera_claim_coding_request(text,integer)','EXECUTE')
			or has_function_privilege(r,'public.qorpera_configure_coding_executor(uuid,text,boolean)','EXECUTE')) then
			raise exception 'Coding service-only RPC exposed to %',r; end if;
	end loop;
end $$;

-- Exercise the real identity trigger against an isolated table, without
-- manufacturing a live parent lease or replacing authority functions.
create temporary table coding_identity_fixture (like public.qorpera_coding_workers including defaults) on commit drop;
create trigger coding_identity_guard before update on coding_identity_fixture
	for each row execute function public.qorpera_coding_worker_identity_guard();
insert into coding_identity_fixture(id,company_id,environment_id,parent_agent_id,parent_run_id,repository,branch,dispatch)
values('37000000-0000-4000-8000-000000000001','37000000-0000-4000-8000-000000000002',
	'37000000-0000-4000-8000-000000000003','37000000-0000-4000-8000-000000000004','37000000-0000-4000-8000-000000000005',
	'{"host":"github.com","owner":"Qorpera","name":"platform","baseBranch":"main"}',
	'qorpera/coding/37000000-0000-4000-8000-000000000001','{}');
do $$
declare v_column text; v_value text;
begin
	foreach v_column in array array['id','company_id','environment_id','parent_agent_id','parent_run_id'] loop
		begin
			execute format('update coding_identity_fixture set %I = %L, version=version+1',v_column,'37000000-0000-4000-8000-000000000099');
			raise exception 'Coding identity changed: %',v_column;
		exception when insufficient_privilege then null; end;
	end loop;
	begin update coding_identity_fixture set branch='main',version=version+1;
		raise exception 'Coding branch changed'; exception when insufficient_privilege then null; end;
	begin update coding_identity_fixture set repository=repository||'{"name":"another"}',version=version+1;
		raise exception 'Coding repository changed'; exception when insufficient_privilege then null; end;
	begin update coding_identity_fixture set dispatch='{"goal":"spoofed"}',version=version+1;
		raise exception 'Coding dispatch changed'; exception when insufficient_privilege then null; end;
	begin update coding_identity_fixture set version=version+2;
		raise exception 'Coding version skipped'; exception when insufficient_privilege then null; end;
	begin update coding_identity_fixture set turn=turn+2,version=version+1;
		raise exception 'Coding turn skipped'; exception when insufficient_privilege then null; end;
	update coding_identity_fixture set vm_id='37000000-0000-4000-8000-000000000006',version=version+1;
	begin update coding_identity_fixture set vm_id='37000000-0000-4000-8000-000000000007',version=version+1;
		raise exception 'Coding VM replaced'; exception when insufficient_privilege then null; end;
	begin update coding_identity_fixture set vm_id=null,version=version+1;
		raise exception 'Coding VM erased'; exception when insufficient_privilege then null; end;
	update coding_identity_fixture set turn=turn+1,version=version+1;
	if (select (version,turn,vm_id) is distinct from (3::bigint,2,'37000000-0000-4000-8000-000000000006'::uuid) from coding_identity_fixture) then
		raise exception 'Followup did not retain coding identity'; end if;
end $$;
set local "request.jwt.claims"='{"role":"service_role"}';
set local role service_role;
do $$
begin
	if public.qorpera_claim_coding_request('unprovisioned-test-executor',60) is not null then
		raise exception 'Unprovisioned executor claimed work'; end if;
	begin perform public.qorpera_heartbeat_coding_request('37000000-0000-4000-8000-000000000001','37000000-0000-4000-8000-000000000002');
		raise exception 'Unknown coding lease renewed'; exception when insufficient_privilege then null; end;
	begin perform public.qorpera_complete_coding_request('37000000-0000-4000-8000-000000000001','37000000-0000-4000-8000-000000000002',1,'completed','{"summary":"fake","noChange":true}');
		raise exception 'Unknown coding request completed'; exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
