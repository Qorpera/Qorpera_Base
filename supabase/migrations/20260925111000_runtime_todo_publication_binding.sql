-- Review 2026-09-25, finding 2: a delayed todo publication could overwrite a
-- newer todo document and still be counted as published.
--
-- A todo change is a kernel row first; the run then publishes the canonical
-- document to work/todos/<agent>/<todoKey>.json and confirms it. A publisher
-- that paused could read the file's newer version and write its older
-- document over it (ordinary compare-and-swap does not help: it asked for the
-- newest version on purpose), and the confirmation kept the newer revision
-- counted as published, so no later list repaired the file.
--
-- The revision, the exact bytes and the file state are now bound together:
--   1. A revision is always the same bytes: the document no longer carries the
--      job-lease state of a worker (queued or running change without a todo
--      revision) and writes its timestamps in UTC whatever the session.
--   2. A run writes a todo's document path only with the current revision's
--      exact bytes. The path check refuses anything else before bytes are
--      staged, and the same check runs again where the file is written, after
--      the Company File head is locked, so an older document can never replace
--      a newer one, whichever version the writer read.
--   3. Confirmation counts only the current revision, only when the file this
--      run wrote holds exactly that revision's bytes, and only while the live
--      file still holds them. Revision, version and sha256 are recorded as one.
--   4. Whatever else lands on the path afterwards (a member's edit, an approved
--      delete) clears the recorded bytes, in the same transaction and under the
--      todo's row lock, so the todo is no longer published. The next list
--      republishes open work; a finished todo is republished only when the
--      kernel changes it, so a member can still tidy away finished work.
-- Every publisher goes through the same checks: the parent's todo and worker
-- receipts, the worker's report and the list repair.

create function pg_temp.publication_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Todo publication integration differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- 1. The same revision is the same bytes.
select pg_temp.publication_patch('public.qorpera_agent_todo_document(public.qorpera_runtime_agent_todos)'::regprocedure,
	$old$jsonb_agg(public.qorpera_worker_view(worker) order by worker.created_at, worker.id)$old$,
	$new$jsonb_agg(public.qorpera_worker_view(worker) || jsonb_build_object('state', worker.state) order by worker.created_at, worker.id)$new$);
alter function public.qorpera_agent_todo_document(public.qorpera_runtime_agent_todos) set timezone to 'UTC';

-- The sha256 of the bytes the path gateway stores for the current document.
create function public.qorpera_agent_todo_document_sha256(p_todo public.qorpera_runtime_agent_todos)
returns text language sql stable security definer set search_path = '' as $$
	select encode(extensions.digest(convert_to(public.qorpera_agent_todo_document(p_todo) ->> 'text', 'utf8'), 'sha256'), 'hex')
$$;

-- The sha256 of the bytes a Company File path holds now, or null.
create function public.qorpera_company_path_live_sha256(p_environment_id uuid, p_path text)
returns text language sql stable security definer set search_path = '' as $$
	select entry.entry #>> '{file,fileSha256}' from public.qorpera_company_path_entries entry
	where entry.environment_id = p_environment_id and entry.entry ->> 'kind' = 'file'
		and entry.path_key_sha256 = extensions.digest(public.qorpera_company_path_key(p_path), 'sha256')
$$;

-- 3. What was confirmed: revision, version and bytes, one record.
alter table public.qorpera_runtime_agent_todos add column published_sha256 text
	check (published_sha256 ~ '^[0-9a-f]{64}$');
-- A todo confirmed before this migration keeps its record only where the live
-- file still holds exactly its current document. Anything else (the race's
-- trace, a worker shown as queued or running, a member's edit) counts as not
-- published, and the next list republishes it once.
update public.qorpera_runtime_agent_todos todo set published_sha256 = entry.entry #>> '{file,fileSha256}'
from public.qorpera_company_path_entries entry
where todo.published_revision = todo.revision and entry.environment_id = todo.environment_id
	and entry.path_key_sha256 = extensions.digest(public.qorpera_company_path_key(
		public.qorpera_agent_todo_path(todo.staff_agent_id, todo.todo_key)), 'sha256')
	and entry.version = todo.published_version and entry.entry ->> 'kind' = 'file'
	and entry.entry #>> '{file,fileSha256}' = public.qorpera_agent_todo_document_sha256(todo);
update public.qorpera_runtime_agent_todos set published_revision = 0
where published_revision > 0 and published_sha256 is null;

-- 4. Published: the current revision was confirmed and nothing has replaced its bytes since.
create function public.qorpera_agent_todo_published(p_todo public.qorpera_runtime_agent_todos)
returns boolean language sql immutable set search_path = '' as $$
	select p_todo.published_revision = p_todo.revision and p_todo.published_sha256 is not null
$$;

-- The todo whose document is this Company File path, or null.
create function public.qorpera_agent_todo_for_path(p_environment_id uuid, p_path text)
returns public.qorpera_runtime_agent_todos language sql stable security definer set search_path = '' as $$
	select todo from public.qorpera_company_files file
	cross join lateral regexp_match(public.qorpera_company_path_key(p_path),
		'^work/todos/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([a-z0-9][a-z0-9._-]{0,63})\.json$') todo_path
	join public.qorpera_runtime_agent_todos todo on todo.profile_id = file.profile_id
		and todo.environment_id = file.environment_id and todo.staff_agent_id = todo_path[1]::uuid and todo.todo_key = todo_path[2]
	where file.environment_id = p_environment_id
$$;

-- 2. What a run may put on a todo's document path: that todo's current document,
-- byte for byte. Removing it is not a write of older content (and from a run it
-- is only a proposal a person decides).
create function public.qorpera_agent_todo_document_entry_allowed(p_todo public.qorpera_runtime_agent_todos, p_entry jsonb)
returns boolean language sql stable security definer set search_path = '' as $$
	select p_todo.id is null or jsonb_typeof(p_entry) is distinct from 'object'
		or (p_entry ->> 'kind' = 'file'
			and p_entry #>> '{file,fileSha256}' is not distinct from public.qorpera_agent_todo_document_sha256(p_todo))
$$;

-- Refused before any bytes are staged: the agent is told plainly, and a retry of the same bytes is refused the same way.
select pg_temp.publication_patch('public.qorpera_check_company_path_mutation(uuid,jsonb,jsonb)'::regprocedure,
	$old$	perform public.qorpera_company_path_plan(v_actor,p_plan,true,false);$old$,
	$new$	perform public.qorpera_company_path_plan(v_actor,p_plan,true,false);
	-- A todo's document is written by the todo tools only, as its current revision (runtime v111).
	if not public.qorpera_agent_todo_document_entry_allowed(
		public.qorpera_agent_todo_for_path(p_environment_id, p_plan ->> 'path'), p_plan -> 'entry') then
		raise exception 'A todo document is written only as its current revision' using errcode = '42501'; end if;$new$);

-- Checked again where the file is written. Company File writes serialize on the
-- head lock taken before this insert, and the todo row is locked here until the
-- write commits: a revision change or a confirmation waits for it and then sees
-- it. Once a revision's document is written, no later write brings back an older one.
create function public.qorpera_guard_agent_todo_document()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_todo public.qorpera_runtime_agent_todos%rowtype; v_entry jsonb := new.change #> '{plan,entry}';
	v_sha256 text := case when new.change #>> '{plan,entry,kind}' = 'file' then new.change #>> '{plan,entry,file,fileSha256}' end;
begin
	v_todo := public.qorpera_agent_todo_for_path(new.environment_id, new.change #>> '{plan,path}');
	if v_todo.id is null then return new; end if;
	select * into strict v_todo from public.qorpera_runtime_agent_todos where id = v_todo.id for no key update;
	if new.run_id is not null and not public.qorpera_agent_todo_document_entry_allowed(v_todo, v_entry) then
		raise exception 'A todo document is written only as its current revision' using errcode = '42501'; end if;
	-- 4. Anything but the confirmed bytes now on the path is no longer the published document.
	if v_todo.published_sha256 is distinct from v_sha256 then
		update public.qorpera_runtime_agent_todos set published_sha256 = null where id = v_todo.id and published_sha256 is not null;
	end if;
	return new;
end
$$;
create trigger qorpera_company_path_todo_document before insert on public.qorpera_company_path_revisions
	for each row execute function public.qorpera_guard_agent_todo_document();

-- 3. Confirmation binds revision, bytes and file state.
select pg_temp.publication_patch('public.qorpera_confirm_agent_todo_publication(jsonb,jsonb)'::regprocedure,
	$old$	v_revision bigint; v_snapshot uuid; v_path text;$old$,
	$new$	v_revision bigint; v_snapshot uuid; v_path text; v_version uuid; v_sha256 text;$new$);
select pg_temp.publication_patch('public.qorpera_confirm_agent_todo_publication(jsonb,jsonb)'::regprocedure,
	$old$	if v_revision > v_todo.published_revision then
		update public.qorpera_runtime_agent_todos set published_revision = v_revision,
			published_version = (select (revision.change ->> 'version')::uuid from public.qorpera_company_path_revisions revision
				where revision.snapshot_id = v_snapshot)
		where id = v_todo.id returning * into v_todo;
	end if;$old$,
	$new$	-- Only the current revision counts, only as its exact bytes, and only while the file still holds
	-- them. An older revision, other bytes or a file changed since leave the record as it is.
	select (revision.change ->> 'version')::uuid, revision.change #>> '{plan,entry,file,fileSha256}' into v_version, v_sha256
	from public.qorpera_company_path_revisions revision where revision.snapshot_id = v_snapshot;
	if v_revision = v_todo.revision and v_sha256 = public.qorpera_agent_todo_document_sha256(v_todo)
		and public.qorpera_company_path_live_sha256(v_todo.environment_id, v_path) = v_sha256 then
		update public.qorpera_runtime_agent_todos set published_revision = v_revision, published_version = v_version,
			published_sha256 = v_sha256 where id = v_todo.id returning * into v_todo;
	end if;$new$);
select pg_temp.publication_patch('public.qorpera_confirm_agent_todo_publication(jsonb,jsonb)'::regprocedure,
	$old$'published',v_todo.published_revision = v_todo.revision);$old$,
	$new$'published',public.qorpera_agent_todo_published(v_todo));$new$);

-- 4. Everything that reports or repairs publication asks the same question.
select pg_temp.publication_patch('public.qorpera_agent_todo_view(public.qorpera_runtime_agent_todos)'::regprocedure,
	$old$'published', p_todo.published_revision = p_todo.revision,$old$,
	$new$'published', public.qorpera_agent_todo_published(p_todo),$new$);
-- A receipt carries the document on the same terms as the list repair below.
select pg_temp.publication_patch('public.qorpera_manage_agent_todo(jsonb,jsonb)'::regprocedure,
	$old$'publication',case when v_todo.published_revision < v_todo.revision then$old$,
	$new$'publication',case when v_todo.published_revision < v_todo.revision
			or (v_todo.published_sha256 is null and v_todo.state in ('open','blocked')) then$new$);
-- The list repair: open work first and newest first, so neither finished todos
-- nor an old document that cannot be written holds back current work.
select pg_temp.publication_patch('public.qorpera_manage_agent_todo(jsonb,jsonb)'::regprocedure,
	$old$			'unpublished', coalesce((select jsonb_agg(public.qorpera_agent_todo_document(todo) order by todo.updated_at, todo.id) from (
				select * from public.qorpera_runtime_agent_todos todo
				where todo.profile_id = v_run.profile_id and todo.environment_id = v_run.environment_id
					and todo.staff_agent_id = v_run.staff_agent_id and todo.published_revision < todo.revision
				order by todo.updated_at, todo.id limit 4) todo), '[]'::jsonb));$old$,
	$new$			'unpublished', coalesce((select jsonb_agg(public.qorpera_agent_todo_document(todo)
				order by todo.state in ('open','blocked') desc, todo.updated_at desc, todo.id) from (
				select * from public.qorpera_runtime_agent_todos todo
				where todo.profile_id = v_run.profile_id and todo.environment_id = v_run.environment_id
					and todo.staff_agent_id = v_run.staff_agent_id and (todo.published_revision < todo.revision
						or (todo.published_sha256 is null and todo.state in ('open','blocked')))
				order by todo.state in ('open','blocked') desc, todo.updated_at desc, todo.id limit 4) todo), '[]'::jsonb));$new$);

revoke all on function public.qorpera_agent_todo_document_sha256(public.qorpera_runtime_agent_todos),
	public.qorpera_company_path_live_sha256(uuid, text), public.qorpera_agent_todo_published(public.qorpera_runtime_agent_todos),
	public.qorpera_agent_todo_for_path(uuid, text),
	public.qorpera_agent_todo_document_entry_allowed(public.qorpera_runtime_agent_todos, jsonb),
	public.qorpera_guard_agent_todo_document()
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The patched functions keep their owners; those owners call the new helpers.
do $$ declare v_owner name; begin
	for v_owner in select distinct pg_get_userbyid(proowner) from pg_proc where oid = any(array[
		'public.qorpera_check_company_path_mutation(uuid,jsonb,jsonb)'::regprocedure,
		'public.qorpera_confirm_agent_todo_publication(jsonb,jsonb)'::regprocedure,
		'public.qorpera_agent_todo_view(public.qorpera_runtime_agent_todos)'::regprocedure,
		'public.qorpera_manage_agent_todo(jsonb,jsonb)'::regprocedure
	]) loop
		if v_owner in ('anon','authenticated','service_role','qorpera_secret_broker') then
			raise exception 'Todo publication function has an API owner'; end if;
		execute format('grant execute on function public.qorpera_agent_todo_document_sha256(public.qorpera_runtime_agent_todos),
			public.qorpera_company_path_live_sha256(uuid, text), public.qorpera_agent_todo_published(public.qorpera_runtime_agent_todos),
			public.qorpera_agent_todo_for_path(uuid, text),
			public.qorpera_agent_todo_document_entry_allowed(public.qorpera_runtime_agent_todos, jsonb) to %I', v_owner);
	end loop;
end $$;
