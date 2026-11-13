-- 20260930741000: the import's follow-ups (own code storage, step 6; 13 Nov 2026; STEP6-FOLLOW-UPS-PLAN.md as
-- STEP6-BUILD.md "The import's follow-ups: the lead's calls" corrects it).
--
-- What the first import showed: the code came in, but nothing said what it brought besides its main version, no agent
-- learned that it was there, and an agent that made a bundle for a file import could not tell whether the file was
-- still that bundle.
--
-- 1. Work outside the main version (item 1). The code host's look measures the other lines of work it keeps (the heads
--    under refs/qorpera/imported/heads/): a new optional key of qorpera.code-import-look/v1,
--    lines: {count, changes, shown: [{name, ahead, behind, lastAt, fits}]}, which qorpera_code_import_look_valid now
--    takes (qorpera_code_import_lines_valid). An import's record keeps it in imported_from when count is at least 1,
--    with entries of shown dropped from the end while the column would be over its 2,048 bytes (count and changes
--    always stay). qorpera_list_code_repositories answers otherWork ({lines, changes} or null) beside earlierChanges,
--    and the record files' list (qorpera_code_change_files) answers imported: {at, lines} for 30 days after it came in.
--    A look without the key (every executor before this release) is taken and kept as before.
-- 3. Every agent learns of code brought in (item 3). qorpera_code_import_tellings keeps which agent was told of which
--    import, and in which run; qorpera_take_agent_code_imports takes, for a run's agent, the imports of its company
--    that ended brought in in the last 7 days, that it did not ask for and that no other run of it was told of (oldest
--    first, at most 8). qorpera_describe_agent_open_work answers them as codeBroughtIn, a key that is absent when there
--    is none. No wake: an agent learns at its next run.
-- 8. The bundle a file import read (item 8). qorpera_folder_code_import answers a twelfth key, file: null, or, for an
--    import from a file that ended brought in, {path, version}, version the folder entry's (the token company_read
--    reports and company_delete takes as expectedVersion) while the file there is still the bytes the import read,
--    else null. The agent may then delete its own bundle on that version; the platform never does.
-- Every changed body carries the marker 20260930741000.
--
-- Order: after the runtime bundle that reads codeBroughtIn and the read's twelfth key (an older runtime would refuse the
-- read and mark tellings it never shows), before the coding executors that write lines (today's SQL refuses a look with
-- the key). With today's executors (no look carries lines) every executor call answers as before, otherWork is null,
-- the record files' list has no imported, and codeBroughtIn and file say what they say of any import.
-- Who may call: nothing new for an API role. qorpera_take_agent_code_imports and the two helpers are no role's (the
-- open-work answer, a definer, calls the one; the others are called inside definers); the table is closed to every
-- API role.
-- Locks: a new table whose foreign key takes qorpera_code_requests in SHARE ROW EXCLUSIVE, and a partial index on it
-- that takes it in SHARE, both to the end of this migration (writes to code requests wait for it; reads do not); the
-- functions are replaced in place.

set local lock_timeout = '3s';

-- 1. Tables ------------------------------------------------------------------------------------------------------------

-- Which agent was told of which import, in which run (qorpera_take_agent_code_imports). A row goes with its import.
create table public.qorpera_code_import_tellings (
	request_id uuid not null references public.qorpera_code_requests(id) on delete cascade,
	staff_agent_id uuid not null,
	told_run_id uuid not null,
	told_at timestamptz not null default clock_timestamp(),
	primary key (request_id, staff_agent_id)
);
create index qorpera_code_import_tellings_run on public.qorpera_code_import_tellings(told_run_id);
alter table public.qorpera_code_import_tellings enable row level security;
revoke all on public.qorpera_code_import_tellings from public, anon, authenticated, service_role, qorpera_secret_broker;
comment on table public.qorpera_code_import_tellings is
	'20260930741000: the agents told of code a member or another agent brought in (openWork.codeBroughtIn), each once, '
	'and the run that was told.';
-- A company's imports that came in, by when: every open-work answer reads its last 7 days.
create index qorpera_code_requests_imported on public.qorpera_code_requests(environment_id, finished_at)
	where kind = 'import' and state = 'done';

-- 2. What the calls share ----------------------------------------------------------------------------------------------

-- Whether p_lines is what the code host's look measured of the other lines of work it keeps (as the executor's
-- codeImportLook writes lines), given the look's branches.kept: exactly {count, changes, shown}. count the kept lines
-- that hold changes main lacks (at most p_kept), changes the distinct such changes (at least 1 exactly when count is),
-- shown at most min(10, count) of them, most ahead first, each exactly {name, ahead, behind, lastAt, fits}: name a
-- string of 1 to 200 bytes or null (never cut), ahead 1 to changes, behind a count, lastAt a time as the look's or
-- null, fits a boolean or null (not measured).
create function public.qorpera_code_import_lines_valid(p_lines jsonb, p_kept jsonb)
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(jsonb_typeof(p_lines) = 'object'
		and p_lines - array['count','changes','shown'] = '{}'::jsonb
		and public.qorpera_code_json_count(p_lines -> 'count') and public.qorpera_code_json_count(p_lines -> 'changes')
		and public.qorpera_code_json_count(p_kept) and p_lines -> 'count' <= p_kept
		and (p_lines -> 'count' >= '1'::jsonb) = (p_lines -> 'changes' >= '1'::jsonb)
		and jsonb_typeof(p_lines -> 'shown') = 'array' and jsonb_array_length(p_lines -> 'shown') <= 10
		and to_jsonb(jsonb_array_length(p_lines -> 'shown')) <= p_lines -> 'count'
		and not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p_lines -> 'shown') = 'array'
				then p_lines -> 'shown' else '[]'::jsonb end) with ordinality as line(value, n)
			where not coalesce(jsonb_typeof(line.value) = 'object'
				and line.value - array['name','ahead','behind','lastAt','fits'] = '{}'::jsonb
				and public.qorpera_code_import_path_valid(line.value -> 'name')
				and public.qorpera_code_json_count(line.value -> 'ahead') and line.value -> 'ahead' >= '1'::jsonb
				and line.value -> 'ahead' <= p_lines -> 'changes'
				and public.qorpera_code_json_count(line.value -> 'behind')
				and public.qorpera_code_care_text_valid(line.value -> 'lastAt',
					'^\d{4}-\d{2}-\d{2}T[0-9:.]{8,15}(Z|[+-]\d{2}:?\d{2})$')
				and jsonb_typeof(line.value -> 'fits') in ('boolean','null')
				and (line.n = 1 or line.value -> 'ahead' <= p_lines -> 'shown' -> (line.n::integer - 2) -> 'ahead'),
				false)), false)
$$;

-- What a member and an agent read of the other lines of work that came with code brought in: {lines, changes}, from
-- what it was brought in from, or null when none came (or it came before 20260930741000).
create function public.qorpera_code_import_other_work(p_imported_from jsonb)
returns jsonb language sql immutable set search_path = '' as $$
	select case when jsonb_typeof(p_imported_from -> 'lines' -> 'count') = 'number'
			and p_imported_from -> 'lines' -> 'count' >= '1'::jsonb
		then jsonb_build_object('lines', p_imported_from -> 'lines' -> 'count',
			'changes', p_imported_from -> 'lines' -> 'changes') end
$$;

-- 3. Agents told once ---------------------------------------------------------------------------------------------------

-- The code a member or another agent brought into the run's company, for the run's agent, each once: the imports that
-- ended brought in (done, imported) in the last 7 days, whose repository is there, that this agent did not ask for and
-- that no other run of this agent was told of; oldest first, at most 8 a run. A row belongs to the first run that took
-- it: a run that takes it at the same time waits for that run's end and takes it only if that run did not commit; the
-- same run (a restart after a usage limit) takes what it took again. Each item: {owner, name, from (as a member reads
-- it), by ("member" or "agent"), at (when it was in), earlierChanges, otherWork ({lines, changes} or null)}. Null when
-- there is none.
create function public.qorpera_take_agent_code_imports(p_run public.qorpera_execution_runs)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz := clock_timestamp(); v_room integer; v_taken jsonb;
begin
	if p_run.id is null or p_run.staff_agent_id is null then return null; end if;
	v_room := 8 - (select count(*) from public.qorpera_code_import_tellings told where told.told_run_id = p_run.id);
	if v_room > 0 then
		insert into public.qorpera_code_import_tellings(request_id, staff_agent_id, told_run_id, told_at)
		select request.id, p_run.staff_agent_id, p_run.id, v_now
		from public.qorpera_code_requests request
		where request.environment_id = p_run.environment_id and request.kind = 'import' and request.state = 'done'
			and request.finished_at > v_now - interval '7 days' and request.outcome ->> 'result' = 'imported'
			and request.by_agent_id is distinct from p_run.staff_agent_id
			and exists (select 1 from public.qorpera_code_repositories repository
				where repository.environment_id = request.environment_id and repository.owner = request.owner
					and repository.name = request.name and repository.imported_from is not null)
			and not exists (select 1 from public.qorpera_code_import_tellings told
				where told.request_id = request.id and told.staff_agent_id = p_run.staff_agent_id)
		order by request.finished_at, request.id
		limit v_room
		on conflict do nothing;
	end if;
	select jsonb_agg(jsonb_build_object('owner', request.owner, 'name', request.name,
			'from', public.qorpera_code_import_member_source(request.input -> 'from'), 'by', request.by_kind,
			'at', request.finished_at, 'earlierChanges', repository.imported_from -> 'commits',
			'otherWork', public.qorpera_code_import_other_work(repository.imported_from))
		order by request.finished_at, request.id) into v_taken
	from public.qorpera_code_import_tellings told
	join public.qorpera_code_requests request on request.id = told.request_id
	left join public.qorpera_code_repositories repository on repository.environment_id = request.environment_id
		and repository.owner = request.owner and repository.name = request.name
	where told.told_run_id = p_run.id;
	return v_taken;
end $$;

-- 4. Existing functions -------------------------------------------------------------------------------------------------

-- Applies each (old, new) pair in turn, each old text exactly once, then runs the result.
create or replace function pg_temp.code_import_follow_ups_patch(p_target regprocedure, p_edits text[]) returns void
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_found integer;
begin
	if position('20260930741000' in v_definition) > 0 then
		raise exception '20260930741000 is already in %', p_target; end if;
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception '20260930741000 anchor found % time(s) in %, expected 1: %', v_found, p_target, left(p_edits[2 * i - 1], 80);
		end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

-- The look may carry lines.
select pg_temp.code_import_follow_ups_patch('public.qorpera_code_import_look_valid(jsonb)'::regprocedure, array[
	$old$		and p_look - array['schema','bytes','defaultBranch','mainSha','commits','firstAt','lastAt','authors30d','tags',$old$,
	$new$		-- 20260930741000: and lines, which a look from before it does not carry.
		and (p_look - 'lines') - array['schema','bytes','defaultBranch','mainSha','commits','firstAt','lastAt','authors30d','tags',$new$,
	$old$			or public.qorpera_code_json_text(p_look -> 'why', '^(IMPORT|CODE_HOST)_[A-Z0-9_]{1,100}$')), false)$old$,
	$new$			or public.qorpera_code_json_text(p_look -> 'why', '^(IMPORT|CODE_HOST)_[A-Z0-9_]{1,100}$'))
		and (not p_look ? 'lines' or public.qorpera_code_import_lines_valid(p_look -> 'lines', p_look -> 'branches' -> 'kept')),
		false)$new$]);

-- The record keeps the other lines of work, within the column's 2,048 bytes.
select pg_temp.code_import_follow_ups_patch(
	'public.qorpera_code_import_record(text,text,uuid,uuid,jsonb)'::regprocedure, array[
	$old$		|| jsonb_build_object('branch', v_request.look -> 'defaultBranch', 'commit', p_imported ->> 'mainSha',
			'commits', v_request.look -> 'commits');$old$,
	$new$		|| jsonb_build_object('branch', v_request.look -> 'defaultBranch', 'commit', p_imported ->> 'mainSha',
			'commits', v_request.look -> 'commits');
	-- 20260930741000: and the other lines of work that came with it, when any did: entries of shown go from the end while
	-- it would be over the column's 2,048 bytes; count and changes always stay.
	if (v_request.look -> 'lines' ->> 'count')::numeric >= 1 then
		v_from := v_from || jsonb_build_object('lines', v_request.look -> 'lines');
		while pg_column_size(v_from) > 2048 and jsonb_array_length(v_from -> 'lines' -> 'shown') > 0 loop
			v_from := jsonb_set(v_from, '{lines,shown}', (v_from -> 'lines' -> 'shown') - (-1));
		end loop;
	end if;$new$]);

-- The agent's read says which file a file import read, and whether it is still that file.
select pg_temp.code_import_follow_ups_patch('public.qorpera_folder_code_import(jsonb,uuid)'::regprocedure, array[
	$old$		'change', v_request.outcome -> 'change', 'code', v_request.outcome -> 'code');$old$,
	$new$		'change', v_request.outcome -> 'change', 'code', v_request.outcome -> 'code',
		-- 20260930741000: the bundle a file import read, once it is in: its path, and the folder entry's version while the
		-- file there is still the bytes it read (null when it changed or is gone). Null for GitHub and before the end.
		'file', case when v_request.input -> 'from' ? 'file' and v_request.outcome ->> 'result' = 'imported'
			then jsonb_build_object('path', v_request.input -> 'from' -> 'file', 'version', (select to_jsonb(entry.version)
				from public.qorpera_folder_entries entry
				where entry.environment_id = v_request.environment_id
					and entry.key_sha256 = extensions.digest(public.qorpera_folder_key(v_request.input -> 'from' ->> 'file'), 'sha256')
					and entry.file_sha256 = v_request.input ->> 'fileSha256')) end);$new$]);

-- The repositories' list says what other work came with code brought in.
select pg_temp.code_import_follow_ups_patch('public.qorpera_list_code_repositories(uuid)'::regprocedure, array[
	$old$				'earlierChanges', repository.imported_from -> 'commits',$old$,
	$new$				'earlierChanges', repository.imported_from -> 'commits',
				-- 20260930741000: and the other lines of work that came with it ({lines, changes}, or null).
				'otherWork', public.qorpera_code_import_other_work(repository.imported_from),$new$]);

-- The record files' list says, for 30 days, what came with code brought in.
select pg_temp.code_import_follow_ups_patch('public.qorpera_code_change_files(text,text,uuid,text,text,integer)'::regprocedure, array[
	$old$				|| public.qorpera_code_release_index(v_repository) into v_index$old$,
	$new$				|| public.qorpera_code_release_index(v_repository)
				-- 20260930741000: for 30 days after code came in with other lines of work, when and what (changes/1.md
				-- names them).
				|| case when v_repository.imported_at > clock_timestamp() - interval '30 days'
						and public.qorpera_code_import_other_work(v_repository.imported_from) is not null
					then jsonb_build_object('imported', jsonb_build_object('at', v_repository.imported_at,
						'lines', v_repository.imported_from -> 'lines'))
					else '{}'::jsonb end into v_index$new$]);

-- The open work: code brought in, told once to every agent but the one that asked.
select pg_temp.code_import_follow_ups_patch('public.qorpera_describe_agent_open_work(jsonb)'::regprocedure, array[
	$old$from (select public.qorpera_take_agent_machine_stopped(v_run) as list) taken where taken.list is not null),'{}'::jsonb);$old$,
	$new$from (select public.qorpera_take_agent_machine_stopped(v_run) as list) taken where taken.list is not null),'{}'::jsonb)
		-- Code a member or another agent brought in, told once to each agent (20260930741000).
		|| coalesce((select jsonb_build_object('codeBroughtIn',taken.list)
			from (select public.qorpera_take_agent_code_imports(v_run) as list) taken where taken.list is not null),'{}'::jsonb);$new$]);

-- 5. Grants, and the deploy guard ---------------------------------------------------------------------------------------

revoke all on function public.qorpera_code_import_lines_valid(jsonb, jsonb),
	public.qorpera_code_import_other_work(jsonb),
	public.qorpera_take_agent_code_imports(public.qorpera_execution_runs)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
comment on function public.qorpera_take_agent_code_imports(public.qorpera_execution_runs) is
	'The code a member or another agent brought into the run''s company in the last 7 days, for the run''s agent, each '
	'once (openWork.codeBroughtIn; 20260930741000).';

-- The functions above may have a private owner in production: it reaches what their new text uses.
do $$ declare v_owner name; begin
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_code_import_look_valid(jsonb)'::regprocedure,
		'public.qorpera_code_import_record(text,text,uuid,uuid,jsonb)'::regprocedure,
		'public.qorpera_folder_code_import(jsonb,uuid)'::regprocedure,
		'public.qorpera_list_code_repositories(uuid)'::regprocedure,
		'public.qorpera_code_change_files(text,text,uuid,text,text,integer)'::regprocedure,
		'public.qorpera_describe_agent_open_work(jsonb)'::regprocedure)) loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception '20260930741000: a code import function has an API owner'; end if;
		if v_owner is distinct from current_user then
			execute format('grant select, insert on public.qorpera_code_import_tellings to %I', v_owner);
			execute format('grant execute on function public.qorpera_code_import_lines_valid(jsonb, jsonb), '
				'public.qorpera_code_import_other_work(jsonb), '
				'public.qorpera_take_agent_code_imports(public.qorpera_execution_runs) to %I', v_owner);
		end if;
	end loop;
end $$;

-- Every changed body carries the marker.
do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_code_import_look_valid(jsonb)',
		'public.qorpera_code_import_record(text,text,uuid,uuid,jsonb)',
		'public.qorpera_folder_code_import(jsonb,uuid)',
		'public.qorpera_list_code_repositories(uuid)',
		'public.qorpera_code_change_files(text,text,uuid,text,text,integer)',
		'public.qorpera_describe_agent_open_work(jsonb)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930741000') = 0 then
			raise exception '20260930741000 is missing from %', v_function; end if;
	end loop;
end $guard$;
