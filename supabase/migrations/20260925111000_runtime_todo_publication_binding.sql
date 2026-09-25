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
--      exact bytes. The check runs where the file is written, after the
--      Company File head is locked, so an older document can never replace a
--      newer one, whichever version the writer read.
--   3. Confirmation counts only the current revision, only when the file this
--      run wrote holds exactly that revision's bytes, and only while the live
--      file still holds them. Revision, version and sha256 are recorded as one.
--   4. Published means the live file still holds the confirmed bytes. Anything
--      that changes the file afterwards (a member, an old runner, a delete)
--      makes the todo unpublished again, and the next list republishes it.
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

-- What was confirmed: revision, version and bytes, one triple.
alter table public.qorpera_runtime_agent_todos add column published_sha256 text
	check (published_sha256 ~ '^[0-9a-f]{64}$');
-- A todo confirmed before this migration keeps the bytes its file holds at the
-- confirmed version. Where the file has moved on since (which is how the race
-- left its trace), the sha256 stays unknown, the todo is unpublished, and the
-- next list republishes it.
update public.qorpera_runtime_agent_todos todo set published_sha256 = entry.entry #>> '{file,fileSha256}'
from public.qorpera_company_path_entries entry
where todo.published_version is not null and entry.environment_id = todo.environment_id
	and entry.path_key_sha256 = extensions.digest(public.qorpera_company_path_key(
		public.qorpera_agent_todo_path(todo.staff_agent_id, todo.todo_key)), 'sha256')
	and entry.version = todo.published_version and entry.entry ->> 'kind' = 'file';

-- The sha256 of the bytes a Company File path holds now, or null.
create function public.qorpera_company_path_live_sha256(p_environment_id uuid, p_path text)
returns text language sql stable security definer set search_path = '' as $$
	select entry.entry #>> '{file,fileSha256}' from public.qorpera_company_path_entries entry
	where entry.environment_id = p_environment_id and entry.entry ->> 'kind' = 'file'
		and entry.path_key_sha256 = extensions.digest(public.qorpera_company_path_key(p_path), 'sha256')
$$;

-- 4. Published: the current revision was confirmed and the file still holds exactly the confirmed bytes.
create function public.qorpera_agent_todo_published(p_todo public.qorpera_runtime_agent_todos)
returns boolean language sql stable security definer set search_path = '' as $$
	select p_todo.published_revision = p_todo.revision and p_todo.published_sha256 is not null
		and public.qorpera_company_path_live_sha256(p_todo.environment_id,
			public.qorpera_agent_todo_path(p_todo.staff_agent_id, p_todo.todo_key)) is not distinct from p_todo.published_sha256
$$;

-- 2. A run writes a todo's document only as the current revision's exact bytes.
-- Company File writes serialize on the head lock taken before this insert, and
-- this check reads the todo after it: once a revision's document is written,
-- no later write can bring back an older one. A delete brings back nothing
-- (and from a run it is a proposal a person approves). A member is not a run.
-- Either way the published check sees the change and the next list republishes.
create function public.qorpera_guard_agent_todo_document()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_key text[]; v_todo public.qorpera_runtime_agent_todos%rowtype;
begin
	if new.run_id is null then return new; end if;
	v_key := regexp_match(public.qorpera_company_path_key(new.change #>> '{plan,path}'),
		'^work/todos/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([a-z0-9][a-z0-9._-]{0,63})\.json$');
	if v_key is null then return new; end if;
	select todo.* into v_todo from public.qorpera_company_files file
	join public.qorpera_runtime_agent_todos todo on todo.profile_id = file.profile_id and todo.environment_id = file.environment_id
	where file.environment_id = new.environment_id and todo.staff_agent_id = v_key[1]::uuid and todo.todo_key = v_key[2];
	if v_todo.id is not null and jsonb_typeof(new.change #> '{plan,entry}') = 'object'
		and (new.change #>> '{plan,entry,kind}' is distinct from 'file'
			or new.change #>> '{plan,entry,file,fileSha256}' is distinct from public.qorpera_agent_todo_document_sha256(v_todo)) then
		raise exception 'Todo document is not the current revision' using errcode = 'PT412'; end if;
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
select pg_temp.publication_patch('public.qorpera_manage_agent_todo(jsonb,jsonb)'::regprocedure,
	$old$and todo.staff_agent_id = v_run.staff_agent_id and todo.published_revision < todo.revision$old$,
	$new$and todo.staff_agent_id = v_run.staff_agent_id and not public.qorpera_agent_todo_published(todo)$new$);
select pg_temp.publication_patch('public.qorpera_manage_agent_todo(jsonb,jsonb)'::regprocedure,
	$old$'publication',case when v_todo.published_revision < v_todo.revision then$old$,
	$new$'publication',case when not public.qorpera_agent_todo_published(v_todo) then$new$);

revoke all on function public.qorpera_agent_todo_document_sha256(public.qorpera_runtime_agent_todos),
	public.qorpera_company_path_live_sha256(uuid, text), public.qorpera_agent_todo_published(public.qorpera_runtime_agent_todos),
	public.qorpera_guard_agent_todo_document()
	from public, anon, authenticated, service_role, qorpera_secret_broker;
