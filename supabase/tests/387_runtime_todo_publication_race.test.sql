-- @fixture 385_runtime_workers_todos.test.sql until "-- 4b. A worker's access is kernel authority"
-- Review 2026-09-25, finding 2: a todo document published late must never
-- replace a newer one, and must never be counted as published. Real SQL after
-- all migrations: the kernel change, the governed path write, confirmation and
-- the list repair. Where this starts, market-scan has a dispatched worker
-- "prices" running as its own run, and its revision 1 is published.

create function pg_temp.sha(p_text text) returns text language sql as $$
	select encode(extensions.digest(convert_to(p_text,'utf8'),'sha256'),'hex')
$$;
-- The live Company File entry of a path: its version and the sha256 of its bytes.
create function pg_temp.live(p_path text) returns jsonb language sql as $$
	select jsonb_build_object('version',entry.version,'sha256',entry.entry #>> '{file,fileSha256}')
	from public.qorpera_company_path_entries entry
	where entry.environment_id = '30000000-0000-4000-8000-000000000020'
		and entry.path_key_sha256 = extensions.digest(public.qorpera_company_path_key(p_path),'sha256')
$$;
-- A governed write against a given file version, as the runtime makes it right after reading that version.
create function pg_temp.write_over(p_binding jsonb,p_key text,p_path text,p_text text,p_version uuid) returns jsonb language plpgsql as $$
declare v_saved text := current_setting('qorpera_test.wake_binding'); v_result jsonb;
begin
	perform set_config('qorpera_test.wake_binding',p_binding::text,true);
	v_result := pg_temp.path_commit(pg_temp.path_plan(p_key,p_path,
		case when p_text is null then null else pg_temp.path_stage_file(p_path,p_text) end,p_version));
	perform set_config('qorpera_test.wake_binding',v_saved,true);
	return v_result;
end $$;
create function pg_temp.confirm(p_binding jsonb,p_key text,p_revision bigint,p_snapshot text) returns jsonb language sql as $$
	select public.qorpera_confirm_agent_todo_publication(p_binding,
		jsonb_build_object('todoKey',p_key,'revision',p_revision,'snapshotId',p_snapshot))
$$;
create function pg_temp.unpublished(p_key text) returns jsonb language sql as $$
	select coalesce(jsonb_agg(value),'[]') from jsonb_array_elements(pg_temp.todo('{"action":"list"}') -> 'unpublished')
	where value ->> 'path' like '%/' || p_key || '.json'
$$;

-- 1. A revision is always the same bytes: no worker lease state, no session time zone.
do $$
declare v_todo public.qorpera_runtime_agent_todos; v_document jsonb; v_utc text; v_elsewhere text;
begin
	select * into strict v_todo from public.qorpera_runtime_agent_todos where todo_key = 'market-scan';
	v_document := public.qorpera_agent_todo_document(v_todo);
	perform pg_temp.wake_assert((pg_temp.worker('{"action":"status"}') #>> '{workers,0,state}') = 'running'
		and (v_document ->> 'text')::jsonb #>> '{workers,0,state}' = 'active',
		'The document states a worker''s durable state, not its job lease');
	v_utc := public.qorpera_agent_todo_document_sha256(v_todo);
	perform set_config('timezone','America/New_York',true);
	v_elsewhere := public.qorpera_agent_todo_document_sha256(v_todo);
	perform set_config('timezone','UTC',true);
	perform pg_temp.wake_assert(v_utc = v_elsewhere and v_utc = pg_temp.sha(v_document ->> 'text'),
		'The document bytes do not depend on the session time zone');
end $$;

-- 2. Two runs publish one todo. The worker's report (revision n) pauses; the
-- parent's change (revision n+1) is published and confirmed; the worker then
-- writes its older document against the version it has just read.
do $$
declare v_parent jsonb := current_setting('qorpera_test.parent_binding')::jsonb;
	v_child jsonb := current_setting('qorpera_test.child_binding')::jsonb;
	v_path text := 'work/todos/30000000-0000-4000-8000-000000000030/market-scan.json';
	v_report jsonb; v_update jsonb; v_write jsonb; v_confirm jsonb; v_revision bigint;
begin
	v_report := public.qorpera_report_worker_result(v_child,
		'{"operationKey":"race-report","outcome":"succeeded","summary":"Alfa 49, Beta 59, Gamma 45."}');
	v_revision := (v_report #>> '{publication,revision}')::bigint;
	v_update := pg_temp.todo('{"action":"upsert","operationKey":"race-update","todoKey":"market-scan",
		"title":"Market scan for Q4","detail":"Prices are in; compare them next."}');
	perform pg_temp.wake_assert((v_update #>> '{publication,revision}')::bigint = v_revision + 1,
		'The parent''s change is the next revision');
	v_write := pg_temp.write_over(v_parent,'race-publish-parent',v_path,v_update #>> '{publication,text}',
		(pg_temp.live(v_path) ->> 'version')::uuid);
	v_confirm := pg_temp.confirm(v_parent,'market-scan',v_revision + 1,v_write ->> 'snapshotId');
	perform pg_temp.wake_assert(v_confirm ->> 'published' = 'true' and (v_confirm ->> 'publishedRevision')::bigint = v_revision + 1,
		'The newer revision is published and confirmed');
	perform pg_temp.wake_error(format($q$select pg_temp.write_over(%L::jsonb,'race-publish-worker',%L,%L,%L::uuid)$q$,
		v_child,v_path,v_report #>> '{publication,text}',pg_temp.live(v_path) ->> 'version'),
		'42501','A todo document is written only as its current revision');
	perform pg_temp.wake_assert(pg_temp.live(v_path) ->> 'version' = v_write ->> 'version'
		and pg_temp.live(v_path) ->> 'sha256' = pg_temp.sha(v_update #>> '{publication,text}'),
		'The worker''s older document never replaces the newer one');
	perform pg_temp.wake_assert(pg_temp.todo('{"action":"list"}') #>> '{todos,0,published}' = 'true'
		and pg_temp.unpublished('market-scan') = '[]','The kernel''s claim and the file agree');
end $$;

-- 3. The review's reproduction: revision 1's receipt pauses, revision 2 is
-- published and confirmed, then revision 1 is written against the current
-- version, first late and then again from its replayed receipt.
do $$
declare v_parent jsonb := current_setting('qorpera_test.parent_binding')::jsonb;
	v_old jsonb; v_new jsonb; v_write jsonb; v_confirm jsonb; v_path text;
begin
	v_old := pg_temp.todo('{"action":"upsert","operationKey":"race-a","todoKey":"race","title":"Old state"}');
	v_new := pg_temp.todo('{"action":"upsert","operationKey":"race-b","todoKey":"race","title":"New state"}');
	v_path := v_new #>> '{publication,path}';
	perform set_config('qorpera_test.race_old',v_old::text,true);
	v_write := pg_temp.write_over(v_parent,'publish-new',v_path,v_new #>> '{publication,text}',null);
	perform set_config('qorpera_test.race_write',v_write::text,true);
	v_confirm := pg_temp.confirm(v_parent,'race',2,v_write ->> 'snapshotId');
	perform pg_temp.wake_assert(v_confirm ->> 'published' = 'true','Revision 2 is published');
	perform pg_temp.wake_error(format($q$select pg_temp.write_over(%L::jsonb,'publish-old',%L,%L,%L::uuid)$q$,
		v_parent,v_path,v_old #>> '{publication,text}',pg_temp.live(v_path) ->> 'version'),
		'42501','A todo document is written only as its current revision');
	perform pg_temp.wake_assert(pg_temp.todo('{"action":"upsert","operationKey":"race-a","todoKey":"race","title":"Old state"}') = v_old,
		'Replaying the old operation returns the old receipt');
	perform pg_temp.wake_error(format($q$select pg_temp.write_over(%L::jsonb,'publish-old-replayed',%L,%L,%L::uuid)$q$,
		v_parent,v_path,v_old #>> '{publication,text}',pg_temp.live(v_path) ->> 'version'),
		'42501','A todo document is written only as its current revision');
	-- Confirming revision 1 claims nothing, whatever snapshot of this run it names.
	v_confirm := pg_temp.confirm(v_parent,'race',1,v_write ->> 'snapshotId');
	perform pg_temp.wake_assert(v_confirm ->> 'published' = 'true' and (v_confirm ->> 'publishedRevision')::int = 2
		and (select title from public.qorpera_runtime_agent_todos where todo_key = 'race') = 'New state'
		and pg_temp.live(v_path) ->> 'sha256' = pg_temp.sha(v_new #>> '{publication,text}')
		and pg_temp.unpublished('race') = '[]','The file holds New state, and the kernel says so');
end $$;

-- 4. A writer the run checks do not stop (a member, a runner from before this
-- fix; here the refusal is relaxed for one write) puts revision 1 over the
-- published revision 2.
savepoint legacy_writer;
do $$
declare v_allowed text := pg_get_functiondef('public.qorpera_agent_todo_document_entry_allowed(public.qorpera_runtime_agent_todos,jsonb)'::regprocedure);
	v_old jsonb := current_setting('qorpera_test.race_old')::jsonb;
begin
	create or replace function public.qorpera_agent_todo_document_entry_allowed(p_todo public.qorpera_runtime_agent_todos, p_entry jsonb)
	returns boolean language sql stable security definer set search_path = '' as $allowed$ select true $allowed$;
	perform set_config('qorpera_test.legacy_write',pg_temp.write_over(current_setting('qorpera_test.parent_binding')::jsonb,
		'legacy-old',v_old #>> '{publication,path}',v_old #>> '{publication,text}',
		(pg_temp.live(v_old #>> '{publication,path}') ->> 'version')::uuid)::text,true);
	execute v_allowed;
end $$;
do $$
declare v_parent jsonb := current_setting('qorpera_test.parent_binding')::jsonb;
	v_legacy jsonb := current_setting('qorpera_test.legacy_write')::jsonb; v_old jsonb := current_setting('qorpera_test.race_old')::jsonb;
	v_listed jsonb; v_write jsonb; v_confirm jsonb; v_path text := v_old #>> '{publication,path}';
begin
	perform pg_temp.wake_assert(v_legacy ->> 'state' = 'applied'
		and pg_temp.live(v_path) ->> 'sha256' = pg_temp.sha(v_old #>> '{publication,text}'),'The legacy write landed');
	-- The kernel no longer claims revision 2 is published, although its published revision is still 2:
	-- the write itself cleared the confirmed bytes.
	v_listed := pg_temp.unpublished('race');
	perform pg_temp.wake_assert((select published_revision = revision and published_sha256 is null
		from public.qorpera_runtime_agent_todos where todo_key = 'race')
		and jsonb_array_length(v_listed) = 1 and (v_listed #>> '{0,revision}')::int = 2
		and (v_listed #>> '{0,text}')::jsonb ->> 'title' = 'New state'
		and pg_temp.todo('{"action":"list"}') -> 'todos' @> '[{"todoKey":"race","published":false}]',
		'A file that no longer holds the confirmed bytes is unpublished, and the list offers revision 2 again');
	-- Confirming the stale bytes as revision 2, or as revision 1, is refused.
	perform pg_temp.wake_assert(pg_temp.confirm(v_parent,'race',2,v_legacy ->> 'snapshotId') ->> 'published' = 'false'
		and pg_temp.confirm(v_parent,'race',1,v_legacy ->> 'snapshotId') ->> 'published' = 'false'
		and (select published_version from public.qorpera_runtime_agent_todos where todo_key = 'race')::text
			= current_setting('qorpera_test.race_write')::jsonb ->> 'version',
		'Confirmation accepts only the current revision''s exact bytes');
	-- Nor when the claimed revision is current: the next change is revision 3, and the stale bytes are not its document.
	perform pg_temp.todo('{"action":"upsert","operationKey":"race-c","todoKey":"race","title":"Newest state"}');
	perform pg_temp.wake_assert(pg_temp.confirm(v_parent,'race',3,v_legacy ->> 'snapshotId') ->> 'published' = 'false'
		and (select published_revision from public.qorpera_runtime_agent_todos where todo_key = 'race') = 2,
		'Confirmation compares the bytes, not only the revision');
	-- The same run republishes what the list offers, under a new operation key, and confirms it.
	v_listed := pg_temp.unpublished('race');
	perform pg_temp.wake_assert((v_listed #>> '{0,revision}')::int = 3 and (v_listed #>> '{0,text}')::jsonb ->> 'title' = 'Newest state',
		'The list offers the current revision');
	v_write := pg_temp.write_over(v_parent,'race-republish',v_path,v_listed #>> '{0,text}',(pg_temp.live(v_path) ->> 'version')::uuid);
	v_confirm := pg_temp.confirm(v_parent,'race',3,v_write ->> 'snapshotId');
	perform pg_temp.wake_assert(v_confirm ->> 'published' = 'true' and pg_temp.unpublished('race') = '[]'
		and (select published_version::text = v_write ->> 'version' and published_sha256 = pg_temp.sha(v_listed #>> '{0,text}')
			from public.qorpera_runtime_agent_todos where todo_key = 'race'),'The repair restores New state and the record');
	-- Writing the same bytes again leaves the todo published: publication is about content.
	v_write := pg_temp.write_over(v_parent,'race-republish-again',v_path,v_listed #>> '{0,text}',(pg_temp.live(v_path) ->> 'version')::uuid);
	perform pg_temp.wake_assert(pg_temp.unpublished('race') = '[]','An identical rewrite needs no repair');
end $$;
rollback to legacy_writer;

-- 5. A run writes nothing else to a todo's document, under any spelling of its
-- path, and cannot remove it on its own. A file in the todo area that is no
-- todo's document stays an ordinary file.
do $$
declare v_parent jsonb := current_setting('qorpera_test.parent_binding')::jsonb; v_path text; v_live jsonb;
begin
	v_path := current_setting('qorpera_test.race_old')::jsonb #>> '{publication,path}';
	v_live := pg_temp.live(v_path);
	perform pg_temp.wake_error(format($q$select pg_temp.write_over(%L::jsonb,'race-scribble',%L,'{}',%L::uuid)$q$,
		v_parent,v_path,v_live ->> 'version'),'42501','A todo document is written only as its current revision');
	perform pg_temp.wake_error(format($q$select pg_temp.write_over(%L::jsonb,'race-shout',%L,'{}',%L::uuid)$q$,
		v_parent,replace(v_path,'race.json','RACE.json'),v_live ->> 'version'),'42501','Company File path is unavailable');
	perform pg_temp.wake_assert(pg_temp.write_over(v_parent,'race-delete',v_path,null,(v_live ->> 'version')::uuid) ->> 'state' = 'proposed'
		and pg_temp.live(v_path) = v_live and pg_temp.unpublished('race') = '[]','A run''s delete is only a proposal');
	perform pg_temp.wake_assert(pg_temp.write_over(v_parent,'not-a-todo','work/todos/30000000-0000-4000-8000-000000000030/notes.json','{}',null)
		->> 'state' = 'applied','Only an existing todo''s document is guarded');
end $$;

-- 6. The check where the file is written refuses on its own: here the earlier
-- path check is switched off, as if the revision moved between that check and
-- the Company File head lock.
savepoint commit_check;
do $$
declare v_check text := pg_get_functiondef('public.qorpera_check_company_path_mutation(uuid,jsonb,jsonb)'::regprocedure);
	v_old jsonb := current_setting('qorpera_test.race_old')::jsonb; v_path text;
begin
	v_path := v_old #>> '{publication,path}';
	-- The path check alone refuses the older document, before the gateway stages any bytes.
	perform pg_temp.wake_error(format($q$select public.qorpera_check_company_path_mutation('30000000-0000-4000-8000-000000000020',%L::jsonb,
		pg_temp.path_plan('race-check',%L,pg_temp.path_stage_file(%L,%L),%L::uuid))$q$,
		current_setting('qorpera_test.parent_binding'),v_path,v_path,v_old #>> '{publication,text}',pg_temp.live(v_path) ->> 'version'),
		'42501','A todo document is written only as its current revision');
	execute replace(v_check,'if not public.qorpera_agent_todo_document_entry_allowed(','if false and not public.qorpera_agent_todo_document_entry_allowed(');
	perform pg_temp.wake_error(format($q$select pg_temp.write_over(%L::jsonb,'race-late',%L,%L,%L::uuid)$q$,
		current_setting('qorpera_test.parent_binding'),v_path,v_old #>> '{publication,text}',pg_temp.live(v_path) ->> 'version'),
		'42501','A todo document is written only as its current revision');
	execute v_check;
end $$;
rollback to commit_check;

-- 7. Repair order and finished work. Open work is repaired first and newest
-- first; a finished todo is republished when the kernel changed it, not when
-- someone tidied its file away.
savepoint finished_work;
do $$
declare v_parent jsonb := current_setting('qorpera_test.parent_binding')::jsonb; v_allowed text; v_index integer;
	v_done jsonb; v_write jsonb; v_path text; v_listed jsonb;
begin
	-- A finished todo, published; then someone else replaces its file.
	perform pg_temp.todo('{"action":"upsert","operationKey":"tidy-1","todoKey":"tidy","title":"Finished work"}');
	v_done := pg_temp.todo('{"action":"done","operationKey":"tidy-2","todoKey":"tidy"}');
	v_path := v_done #>> '{publication,path}';
	v_write := pg_temp.write_over(v_parent,'tidy-publish',v_path,v_done #>> '{publication,text}',null);
	perform pg_temp.wake_assert(pg_temp.confirm(v_parent,'tidy',(v_done #>> '{publication,revision}')::bigint,v_write ->> 'snapshotId')
		->> 'published' = 'true','The finished todo is published');
	v_allowed := pg_get_functiondef('public.qorpera_agent_todo_document_entry_allowed(public.qorpera_runtime_agent_todos,jsonb)'::regprocedure);
	create or replace function public.qorpera_agent_todo_document_entry_allowed(p_todo public.qorpera_runtime_agent_todos, p_entry jsonb)
	returns boolean language sql stable security definer set search_path = '' as $allowed$ select true $allowed$;
	perform pg_temp.write_over(v_parent,'tidy-member',v_path,'{"tidied":true}',(pg_temp.live(v_path) ->> 'version')::uuid);
	execute v_allowed;
	perform pg_temp.wake_assert(pg_temp.todo('{"action":"list","includeClosed":true}') -> 'todos' @> '[{"todoKey":"tidy","published":false}]'
		and pg_temp.unpublished('tidy') = '[]','A finished todo whose file was tidied is reported as it is, and left alone');
	-- Five finished todos the kernel changed and nobody published, then one open todo nobody published.
	for v_index in 1..5 loop
		perform pg_temp.todo(jsonb_build_object('action','upsert','operationKey','old-' || v_index,'todoKey','old-' || v_index,'title','Old ' || v_index));
		perform pg_temp.todo(jsonb_build_object('action','done','operationKey','old-done-' || v_index,'todoKey','old-' || v_index));
	end loop;
	perform pg_temp.todo('{"action":"upsert","operationKey":"fresh-1","todoKey":"fresh","title":"Fresh open work"}');
	v_listed := pg_temp.todo('{"action":"list"}') -> 'unpublished';
	perform pg_temp.wake_assert(jsonb_array_length(v_listed) = 4 and v_listed #>> '{0,path}' like '%/fresh.json'
		and v_listed #>> '{1,path}' like '%/old-5.json','Open work comes first, then the newest finished work');
end $$;
rollback to finished_work;

-- 8. Where the checks sit. The run check and the tidy check run in a trigger on
-- the revision insert, which the Company File publisher makes after locking the
-- head, and the trigger holds the todo's row until the write commits.
do $$
declare v_publish text := pg_get_functiondef('public.qorpera_publish_company_path(jsonb,jsonb,jsonb,uuid,text,uuid,uuid)'::regprocedure);
	v_guard text := pg_get_functiondef('public.qorpera_guard_agent_todo_document()'::regprocedure);
begin
	perform pg_temp.wake_assert(exists (select 1 from pg_trigger where tgrelid = 'public.qorpera_company_path_revisions'::regclass
		and tgname = 'qorpera_company_path_todo_document' and tgenabled = 'O' and tgtype & 2 = 2 and tgtype & 4 = 4
		and tgfoid = 'public.qorpera_guard_agent_todo_document()'::regprocedure),'The trigger runs before every revision insert');
	perform pg_temp.wake_assert(position('from public.qorpera_company_files where environment_id' in v_publish) > 0
		and position('for update' in v_publish) > position('from public.qorpera_company_files where environment_id' in v_publish)
		and position('for update' in v_publish) < position('insert into public.qorpera_company_path_revisions' in v_publish),
		'The publisher locks the Company File head before it inserts the revision');
	perform pg_temp.wake_assert(position('for no key update' in v_guard) > 0
		and position('for no key update' in v_guard) < position('raise exception' in v_guard),
		'The trigger locks the todo before it decides');
end $$;

-- 9. The new functions are kernel-only.
do $$
declare v_role text; v_function text;
begin
	foreach v_role in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
		foreach v_function in array array['public.qorpera_agent_todo_document_sha256(public.qorpera_runtime_agent_todos)',
			'public.qorpera_agent_todo_published(public.qorpera_runtime_agent_todos)',
			'public.qorpera_company_path_live_sha256(uuid,text)','public.qorpera_agent_todo_for_path(uuid,text)',
			'public.qorpera_agent_todo_document_entry_allowed(public.qorpera_runtime_agent_todos,jsonb)',
			'public.qorpera_guard_agent_todo_document()'] loop
			perform pg_temp.wake_assert(not has_function_privilege(v_role,v_function,'execute'),v_function || ' is exposed to ' || v_role);
		end loop;
	end loop;
end $$;
rollback;
