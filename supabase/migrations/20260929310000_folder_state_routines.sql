-- Company state files, F2-6: routines (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §2, §4).
--
-- Inert for today's companies: everything here runs only inside the folder core's commit, which only folder-v2
-- companies reach, and only an operator makes one (qorpera_folder_enable) until the reset (core C5). The routine table
-- gains nullable folder columns, and its identity check lets a file's routine keep an owner and a key whoever made it.
--
-- agents/<handle>/routines/<name>.md is one of an agent's routines, with one trigger (pending decision 3; the answer
-- lives in the parser and qorpera_company_state_routine_trigger only). The index is today's tables, so the scheduler,
-- wake admission and the runtime read file routines unchanged: qorpera_cloud_routines (the row) and
-- qorpera_cloud_routine_versions (what a run pins).
-- * Owner: the agent whose folder holds the file (its agent.md is indexed and not retired, or the same unit writes it).
--   The key is the file name. Moving the file to another agent's routines/ hands the routine over.
-- * Versions: a new version only when what a run pins changes: the agent, title, instructions, trigger (with its reply)
--   or effort.
--   Status, ends, runs, quiet hours and the conclusion live on the row. A new version's schedule position follows the
--   2026-09-25 rules (qorpera_routine_version_schedule_position), as a member's or an agent's save does today.
-- * Who pays (S2: a member's login pays only for work that member started): the saver's own login that pays for
--   unattended work (qorpera_agent_routine_sponsor's rule, read without its lock on the login), for a new version and for
--   work a save starts or extends (a resume, a revival, more runs, a later end, a handover). A version on another login
--   moves to the saver's. A member without one cannot make those saves; a run whose requester has none pins the run's,
--   and the routine waits. Unlike an agent's save today, the commit never sets up a login for unattended work (that
--   takes the login FOR UPDATE and writes rows): the runtime's routine writer does that before its commit (F2-1b).
-- * Status: the file's status is the saver's word when the save changes it (or restores the file). Otherwise a pause,
--   expiry or suspension the platform recorded stays, until core C2's queue writes it into the file; a save still
--   revives an expired routine, and a new version with a paying login ends a wait for one.
-- * Rules (contract 16.3): file-change waits for the folder's file events (core C4) and is refused for now; only an
--   agent's run makes a routine dynamic (when: once), never one a member made; a dynamic routine's own run never
--   pauses, removes or moves it, and while it owes its decision the run's save of that file is only the decision.
-- * Review: an agent's routine change is delegation, except its dynamic routine's own run deciding a new at, effort or
--   reply, or concluding it.
-- * Index: deleting the file retires the routine (its runs and history stay) and gives its key a tombstone as a todo's
--   does; a restore brings it back. The routine row is locked at rank 5 (where a routine run's commit holds it KEY
--   SHARE), with the company row at rank 2 for the rows' foreign keys. The commit never inserts a wake: the tick starts
--   a dynamic routine's next run (qorpera_restore_dynamic_routine_runs), so no admission fence is taken after the clock.
-- * The member RPC (qorpera_upsert_cloud_routine) refuses a folder-v2 company's routines, except rows from before it
--   became folder-v2; the agent tools (qorpera_manage_agent_routine, qorpera_decide_agent_routine) refuse any on a
--   folder-v2 company, whose agents write routine files. The name index covers file routines of either origin.
-- * Known: a save that carries several routines (an agent folder's delete or move) locks them in id order, while the
--   expiry sweep updates the routines that ended in its own order; the two can deadlock (40P01, one side retries,
--   nothing is wrong).
-- * Follow-ups for C2's queue: the platform's pauses written into the files; a notification when a routine waits for
--   its requester's login.
--
-- Builds on F2-5a (20260929210000) and replaces the hook functions with the routine branches added.

-- F1's C1b-3a (20260929230000, #497) moves the company row in the hook's targets to rank 0. This migration's targets
-- (section 4) take it at rank 2, so it must not run after that change without being moved to rank 0 too: stop, before
-- anything changes, rather than undo it.
do $$
begin
	if pg_get_functiondef('public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)'::regprocedure)
		like '%rank := 0; tbl := ''qorpera_profiles''%' then
		raise exception 'F2-6 routine targets take the company row at rank 2; move them to rank 0 after 20260929230000'; end if;
end
$$;

-- 1. The routine table as the index of routine files --------------------------------------------------------------------

-- The scheduler and wake admission read these tables on every tick: never queue them behind this change.
set local lock_timeout = '3s';

alter table public.qorpera_cloud_routines
	add column folder_environment_id uuid,
	add column folder_path text collate "C",
	add column folder_path_version uuid,
	add column folder_commit_id uuid,
	add column folder_retired_at timestamptz,
	-- A member's routine row has no owner and no key; an agent's has both, and so does a file's, whoever made it.
	drop constraint qorpera_cloud_routines_agent_identity,
	add constraint qorpera_cloud_routines_agent_identity check (
		(origin = 'member' and folder_path is null and owner_staff_agent_id is null and routine_key is null)
		or ((origin <> 'member' or folder_path is not null) and owner_staff_agent_id is not null and routine_key is not null)),
	add constraint qorpera_cloud_routines_folder_complete check (
		(folder_path is null) = (folder_environment_id is null)
		and (folder_path is null) = (folder_path_version is null)
		and (folder_path is null) = (folder_commit_id is null)
		and (folder_retired_at is null or folder_path is not null));
create index qorpera_cloud_routines_folder_path on public.qorpera_cloud_routines(folder_environment_id, folder_path collate "C")
	where folder_path is not null;
-- An agent's routine names are unique, a file's too whoever made it.
drop index public.qorpera_cloud_routines_agent_key;
create unique index qorpera_cloud_routines_agent_key on public.qorpera_cloud_routines(profile_id, environment_id, owner_staff_agent_id,
	routine_key) where origin <> 'member' or folder_path is not null;

-- 2. The parse's shape, now for routines too ------------------------------------------------------------------------

-- The parser's canonical instant: seconds always, a fraction of up to six digits without trailing zeros, UTC.
create function public.qorpera_company_state_instant(p_value jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
	return jsonb_typeof(p_value) = 'string'
		and (p_value #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{0,5}[1-9])?Z$'
		and (p_value #>> '{}')::timestamptz is not null;
exception when others then return false;
end $$;

create or replace function public.qorpera_company_state_parse_problems(p_kind text, p_parse jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
	v_bad text[] := '{}'; v_named jsonb; v_when jsonb;
	c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
	c_clock constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
	c_zone constant text := '^[A-Z0-9][A-Za-z0-9_+-]*(/[A-Z0-9][A-Za-z0-9_+-]*)*$';
begin
	if jsonb_typeof(p_parse) is distinct from 'object' or p_parse ->> 'kind' is distinct from p_kind then
		return jsonb_build_array(public.qorpera_company_state_problem('value', null, null, 'the parse does not match the file''s kind'));
	end if;
	if p_kind = 'vision' then
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from array['kind','name'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if not public.qorpera_company_state_one_line(p_parse -> 'name', 1, 120) then v_bad := array_append(v_bad, 'name'); end if;
	elsif p_kind = 'agent' then
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from
			array['agentKind','colour','effort','figure','id','instructions','kind','model','name','role','status'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if coalesce(p_parse ->> 'id', '') !~ c_uuid then v_bad := array_append(v_bad, 'id'); end if;
		if not public.qorpera_company_state_one_line(p_parse -> 'name', 1, 160) then v_bad := array_append(v_bad, 'name'); end if;
		if not public.qorpera_company_state_one_line(p_parse -> 'role', 1, 320) then v_bad := array_append(v_bad, 'role'); end if;
		if coalesce(p_parse ->> 'agentKind', '') not in ('co-founder','agent') then v_bad := array_append(v_bad, 'agentKind'); end if;
		if coalesce(p_parse ->> 'status', '') not in ('active','archived') then v_bad := array_append(v_bad, 'status'); end if;
		if jsonb_typeof(p_parse -> 'colour') <> 'null' and coalesce(p_parse ->> 'colour', '') not in
			('charcoal','brown','coral','orange','gold','green','teal','blue','purple','pink','gray') then v_bad := array_append(v_bad, 'colour'); end if;
		if jsonb_typeof(p_parse -> 'figure') <> 'null' and coalesce(p_parse ->> 'figure', '') not in
			('planet','acorn','flame','rocket','crown','heart','ghost') then v_bad := array_append(v_bad, 'figure'); end if;
		if jsonb_typeof(p_parse -> 'model') <> 'null' and coalesce(p_parse ->> 'model', '') not in
			('gpt-6-astra','gpt-6-sol','gpt-6-luna') then v_bad := array_append(v_bad, 'model'); end if;
		if jsonb_typeof(p_parse -> 'effort') <> 'null' and coalesce(p_parse ->> 'effort', '') not in ('low','medium','high') then
			v_bad := array_append(v_bad, 'effort'); end if;
		if jsonb_typeof(p_parse -> 'instructions') is distinct from 'string'
			or octet_length(p_parse ->> 'instructions') not between 1 and 32768
			or (p_parse ->> 'instructions') <> btrim(p_parse ->> 'instructions', E' \t\n\r')
			or (p_parse ->> 'instructions') ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' then
			v_bad := array_append(v_bad, 'instructions'); end if;
	elsif p_kind = 'group' then
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from
			array['agents','id','kind','name','people','purpose','subtitle'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if coalesce(p_parse ->> 'id', '') !~ c_uuid then v_bad := array_append(v_bad, 'id'); end if;
		if not public.qorpera_company_state_one_line(p_parse -> 'name', 1, 256) then v_bad := array_append(v_bad, 'name'); end if;
		if jsonb_typeof(p_parse -> 'subtitle') <> 'null' and not public.qorpera_company_state_one_line(p_parse -> 'subtitle', 0, 256) then
			v_bad := array_append(v_bad, 'subtitle'); end if;
		-- At least two agents, and no id twice in a list.
		if jsonb_typeof(p_parse -> 'agents') is distinct from 'array' or jsonb_array_length(p_parse -> 'agents') < 2
			or exists (select 1 from jsonb_array_elements(p_parse -> 'agents') a where jsonb_typeof(a) <> 'string' or (a #>> '{}') !~ c_uuid)
			or (select count(distinct a #>> '{}') from jsonb_array_elements(p_parse -> 'agents') a) <> jsonb_array_length(p_parse -> 'agents') then
			v_bad := array_append(v_bad, 'agents'); end if;
		if jsonb_typeof(p_parse -> 'people') is distinct from 'array'
			or exists (select 1 from jsonb_array_elements(p_parse -> 'people') a where jsonb_typeof(a) <> 'string' or (a #>> '{}') !~ c_uuid)
			or (select count(distinct a #>> '{}') from jsonb_array_elements(p_parse -> 'people') a) <> jsonb_array_length(p_parse -> 'people') then
			v_bad := array_append(v_bad, 'people'); end if;
		if jsonb_typeof(p_parse -> 'purpose') is distinct from 'string'
			or octet_length(p_parse ->> 'purpose') not between 1 and 32768
			or (p_parse ->> 'purpose') <> btrim(p_parse ->> 'purpose', E' \t\n\r') then
			v_bad := array_append(v_bad, 'purpose'); end if;
	elsif p_kind = 'sections' then
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from array['kind','sections'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if jsonb_typeof(p_parse -> 'sections') is distinct from 'array'
			or exists (select 1 from jsonb_array_elements(p_parse -> 'sections') s
				where jsonb_typeof(s) <> 'object'
					or (select array_agg(k order by k) from jsonb_object_keys(s) k) is distinct from array['line','members','name']
					or not public.qorpera_company_state_one_line(s -> 'name', 1, 60)
					or jsonb_typeof(s -> 'line') <> 'number' or (s ->> 'line') !~ '^[1-9][0-9]{0,8}$'
					or jsonb_typeof(s -> 'members') <> 'array'
					or exists (select 1 from jsonb_array_elements(s -> 'members') m
						where jsonb_typeof(m) <> 'object'
							or (select array_agg(k order by k) from jsonb_object_keys(m) k) is distinct from array['id','line']
							or jsonb_typeof(m -> 'id') <> 'string' or (m ->> 'id') !~ c_uuid
							or jsonb_typeof(m -> 'line') <> 'number' or (m ->> 'line') !~ '^[1-9][0-9]{0,8}$')) then
			v_bad := array_append(v_bad, 'sections');
		-- Names are unique ignoring case as the database compares them (lower(), the index's unique key), which can
		-- join two names the parser keeps apart; and an id is listed once in the whole file.
		else
			if (select count(distinct lower(s ->> 'name')) from jsonb_array_elements(p_parse -> 'sections') s)
					<> jsonb_array_length(p_parse -> 'sections') then
				v_named := public.qorpera_company_state_problem('value', null, null,
					'two sections have the same name when case is ignored; rename one');
			end if;
			if (select count(*) <> count(distinct m ->> 'id') from jsonb_array_elements(p_parse -> 'sections') s,
					jsonb_array_elements(s -> 'members') m) then
				v_bad := array_append(v_bad, 'sections');
			end if;
		end if;
	elsif p_kind = 'connection' then
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from
			array['account','actions','connectedAt','connectedBy','id','kind','purpose','service','status'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if coalesce(p_parse ->> 'id', '') !~ c_uuid then v_bad := array_append(v_bad, 'id'); end if;
		if jsonb_typeof(p_parse -> 'service') is distinct from 'string' or (p_parse ->> 'service') !~ '^[a-z][a-z0-9_-]{0,63}$' then
			v_bad := array_append(v_bad, 'service'); end if;
		if not public.qorpera_company_state_one_line(p_parse -> 'account', 1, 254) then v_bad := array_append(v_bad, 'account'); end if;
		if coalesce(p_parse ->> 'status', '') not in ('connected','broken') then v_bad := array_append(v_bad, 'status'); end if;
		if jsonb_typeof(p_parse -> 'actions') is distinct from 'array'
			or exists (select 1 from jsonb_array_elements(p_parse -> 'actions') a
				where jsonb_typeof(a) <> 'string' or (a #>> '{}') !~ '^[a-z][a-z0-9_]{0,63}$')
			or (select count(distinct a #>> '{}') from jsonb_array_elements(p_parse -> 'actions') a) <> jsonb_array_length(p_parse -> 'actions') then
			v_bad := array_append(v_bad, 'actions'); end if;
		if coalesce(p_parse ->> 'connectedBy', '') !~ c_uuid then v_bad := array_append(v_bad, 'connectedBy'); end if;
		-- The parser's canonical instant: seconds always, a fraction without trailing zeros, UTC.
		if jsonb_typeof(p_parse -> 'connectedAt') is distinct from 'string'
			or (p_parse ->> 'connectedAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{0,5}[1-9])?Z$' then
			v_bad := array_append(v_bad, 'connectedAt');
		else
			begin
				perform (p_parse ->> 'connectedAt')::timestamptz;
			exception when others then v_bad := array_append(v_bad, 'connectedAt');
			end;
		end if;
		if jsonb_typeof(p_parse -> 'purpose') is distinct from 'string' or octet_length(p_parse ->> 'purpose') > 32768
			or (p_parse ->> 'purpose') <> btrim(p_parse ->> 'purpose', E' \t\n\r') then
			v_bad := array_append(v_bad, 'purpose'); end if;
	elsif p_kind = 'rule' then
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from array['id','kind','outcome','text'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if coalesce(p_parse ->> 'id', '') !~ c_uuid then v_bad := array_append(v_bad, 'id'); end if;
		if coalesce(p_parse ->> 'outcome', '') not in ('ask-first','allow') then v_bad := array_append(v_bad, 'outcome'); end if;
		-- One line of 1-280 characters, trimmed, no controls: the rule table's own check on when_text.
		if not public.qorpera_company_state_one_line(p_parse -> 'text', 1, 280) then v_bad := array_append(v_bad, 'text'); end if;
	elsif p_kind = 'todo' then
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from
			array['detail','id','kind','requestedBy','status','title'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if coalesce(p_parse ->> 'id', '') !~ c_uuid then v_bad := array_append(v_bad, 'id'); end if;
		if not public.qorpera_company_state_one_line(p_parse -> 'title', 1, 200, true) then v_bad := array_append(v_bad, 'title'); end if;
		if coalesce(p_parse ->> 'status', '') not in ('open','blocked','done','cancelled') then v_bad := array_append(v_bad, 'status'); end if;
		if jsonb_typeof(p_parse -> 'requestedBy') <> 'null' and coalesce(p_parse ->> 'requestedBy', '') !~ c_uuid then
			v_bad := array_append(v_bad, 'requestedBy'); end if;
		if jsonb_typeof(p_parse -> 'detail') is distinct from 'string' or octet_length(p_parse ->> 'detail') > 4000
			or (p_parse ->> 'detail') <> btrim(p_parse ->> 'detail', E' \t\n\r') then
			v_bad := array_append(v_bad, 'detail'); end if;
	elsif p_kind = 'routine' then
		if (select array_agg(k order by k) from jsonb_object_keys(p_parse) k) is distinct from
			array['conclusion','effort','ends','id','instructions','kind','quiet','reply','runs','status','timezone','title','trigger'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if coalesce(p_parse ->> 'id', '') !~ c_uuid then v_bad := array_append(v_bad, 'id'); end if;
		if not public.qorpera_company_state_one_line(p_parse -> 'title', 1, 160, true) then v_bad := array_append(v_bad, 'title'); end if;
		if coalesce(p_parse ->> 'status', '') not in ('active','paused','concluded') then v_bad := array_append(v_bad, 'status'); end if;
		-- One trigger, with exactly the keys of its kind.
		v_when := p_parse -> 'trigger';
		if jsonb_typeof(v_when) is distinct from 'object'
			or coalesce(v_when ->> 'when', '') not in ('every','weekly','window','once','file-change') then
			v_bad := array_append(v_bad, 'trigger');
		elsif (select array_agg(k order by k) from jsonb_object_keys(v_when) k) is distinct from (case v_when ->> 'when'
				when 'every' then array['minutes','starts','when'] when 'weekly' then array['days','starts','time','when']
				when 'window' then array['days','from','minutes','months','to','when'] when 'once' then array['at','when']
				else array['match','watch','when'] end)
			or (v_when ? 'minutes' and (jsonb_typeof(v_when -> 'minutes') <> 'number' or (v_when ->> 'minutes') !~ '^[0-9]{1,5}$'
				or (v_when ->> 'minutes')::integer not between 5 and 10080))
			or (v_when ? 'starts' and jsonb_typeof(v_when -> 'starts') <> 'null' and not public.qorpera_company_state_instant(v_when -> 'starts'))
			or (v_when ? 'at' and not public.qorpera_company_state_instant(v_when -> 'at'))
			or (v_when ? 'time' and coalesce(v_when ->> 'time', '') !~ c_clock)
			or (v_when ? 'from' and (coalesce(v_when ->> 'from', '') !~ c_clock or coalesce(v_when ->> 'to', '') !~ c_clock
				or (v_when ->> 'from') > (v_when ->> 'to')))
			or (v_when ->> 'when' = 'weekly' and jsonb_typeof(v_when -> 'days') is distinct from 'array')
			or (jsonb_typeof(v_when -> 'days') = 'array' and (jsonb_array_length(v_when -> 'days') = 0
				or exists (select 1 from jsonb_array_elements(v_when -> 'days') d
					where jsonb_typeof(d) <> 'string' or (d #>> '{}') not in ('mon','tue','wed','thu','fri','sat','sun'))
				or (select count(distinct d) from jsonb_array_elements(v_when -> 'days') d) <> jsonb_array_length(v_when -> 'days')))
			or (v_when ? 'days' and jsonb_typeof(v_when -> 'days') not in ('array','null'))
			or (jsonb_typeof(v_when -> 'months') = 'array' and (jsonb_array_length(v_when -> 'months') = 0
				or exists (select 1 from jsonb_array_elements(v_when -> 'months') m
					where jsonb_typeof(m) <> 'number' or (m #>> '{}') !~ '^([1-9]|1[0-2])$')
				or (select count(distinct m) from jsonb_array_elements(v_when -> 'months') m) <> jsonb_array_length(v_when -> 'months')))
			or (v_when ? 'months' and jsonb_typeof(v_when -> 'months') not in ('array','null'))
			-- A path inside the company, without a trailing /.
			or (v_when ? 'watch' and (not public.qorpera_company_state_one_line(v_when -> 'watch', 1, 4096)
				or (v_when ->> 'watch') like '/%'
				or exists (select 1 from unnest(string_to_array(v_when ->> 'watch', '/')) part where part in ('', '.', '..'))))
			or (v_when ? 'match' and coalesce(v_when ->> 'match', '') not in ('exact','subtree')) then
			v_bad := array_append(v_bad, 'trigger');
		end if;
		-- A time zone by its shape (the database's list decides the name); every one but every needs it.
		if (jsonb_typeof(p_parse -> 'timezone') = 'null' and v_when ->> 'when' is distinct from 'every')
			or (jsonb_typeof(p_parse -> 'timezone') <> 'null' and (jsonb_typeof(p_parse -> 'timezone') <> 'string'
				or (p_parse ->> 'timezone') !~ c_zone or char_length(p_parse ->> 'timezone') > 64)) then
			v_bad := array_append(v_bad, 'timezone'); end if;
		if jsonb_typeof(p_parse -> 'ends') <> 'null' and not public.qorpera_company_state_instant(p_parse -> 'ends') then
			v_bad := array_append(v_bad, 'ends'); end if;
		if v_when ->> 'when' = 'once' and public.qorpera_company_state_instant(v_when -> 'at')
			and public.qorpera_company_state_instant(p_parse -> 'ends')
			and (v_when ->> 'at')::timestamptz >= (p_parse ->> 'ends')::timestamptz then
			v_bad := array_append(v_bad, 'at'); end if;
		if jsonb_typeof(p_parse -> 'runs') <> 'null' and (jsonb_typeof(p_parse -> 'runs') <> 'number'
			or (p_parse ->> 'runs') !~ '^[1-9][0-9]{0,5}$' or (p_parse ->> 'runs')::integer > 100000 or v_when ->> 'when' = 'once') then
			v_bad := array_append(v_bad, 'runs'); end if;
		if jsonb_typeof(p_parse -> 'quiet') = 'object' then
			if (select array_agg(k order by k) from jsonb_object_keys(p_parse -> 'quiet') k) is distinct from array['end','start','timezone']
				or coalesce(p_parse -> 'quiet' ->> 'start', '') !~ c_clock or coalesce(p_parse -> 'quiet' ->> 'end', '') !~ c_clock
				or p_parse -> 'quiet' ->> 'start' = p_parse -> 'quiet' ->> 'end'
				or jsonb_typeof(p_parse -> 'quiet' -> 'timezone') is distinct from 'string'
				or (p_parse -> 'quiet' ->> 'timezone') !~ c_zone or char_length(p_parse -> 'quiet' ->> 'timezone') > 64 then
				v_bad := array_append(v_bad, 'quiet'); end if;
		elsif jsonb_typeof(p_parse -> 'quiet') is distinct from 'null' then
			v_bad := array_append(v_bad, 'quiet');
		end if;
		if coalesce(p_parse ->> 'effort', '') not in ('low','medium','high') then v_bad := array_append(v_bad, 'effort'); end if;
		if coalesce(p_parse ->> 'reply', '') not in ('optional','required','silent') then v_bad := array_append(v_bad, 'reply'); end if;
		-- A conclusion is one line of 1-2000 bytes, written when the routine is concluded and only then.
		if (p_parse ->> 'status' = 'concluded') is distinct from (jsonb_typeof(p_parse -> 'conclusion') = 'string')
			or (jsonb_typeof(p_parse -> 'conclusion') = 'string'
				and not public.qorpera_company_state_one_line(p_parse -> 'conclusion', 1, 2000, true)) then
			v_bad := array_append(v_bad, 'conclusion'); end if;
		if jsonb_typeof(p_parse -> 'instructions') is distinct from 'string'
			or octet_length(p_parse ->> 'instructions') not between 1 and 32768
			or (p_parse ->> 'instructions') <> btrim(p_parse ->> 'instructions', E' \t\n\r') then
			v_bad := array_append(v_bad, 'instructions'); end if;
	end if;
	if cardinality(v_bad) = 0 and v_named is null then return '[]'::jsonb; end if;
	return case when v_named is null then '[]'::jsonb else jsonb_build_array(v_named) end
		|| case when cardinality(v_bad) = 0 then '[]'::jsonb else jsonb_build_array(public.qorpera_company_state_problem('value', null, null,
			'the platform read this file differently from its rules (' || array_to_string(v_bad, ', ') || ')')) end;
end $$;

create or replace function public.qorpera_company_state_checked(p_entry jsonb, p_path text, p_key text, p_file jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_kind text := public.qorpera_structured_path_kind(p_key); v_entry jsonb := p_entry; v_problems jsonb;
begin
	v_problems := public.qorpera_company_state_path_problems(p_path, false);
	if jsonb_array_length(v_problems) > 0 then return jsonb_build_object('ok', false, 'problems', v_problems); end if;
	if v_entry is null or v_entry ->> 'kind' is distinct from v_kind then
		return jsonb_build_object('ok', false, 'problems', jsonb_build_array(public.qorpera_company_state_problem('front_matter', null, null,
			'the platform could not read this file; save it again')));
	end if;
	if jsonb_typeof(v_entry -> 'problems') = 'array' then
		return jsonb_build_object('ok', false, 'problems', (select coalesce(jsonb_agg(p.value), '[]'::jsonb)
			from (select value from jsonb_array_elements(v_entry -> 'problems') limit 51) p));
	end if;
	if jsonb_typeof(v_entry -> 'text') is distinct from 'string' or jsonb_typeof(v_entry -> 'parserVersion') is distinct from 'number'
		or encode(extensions.digest(convert_to(v_entry ->> 'text', 'utf8'), 'sha256'), 'hex') is distinct from p_file ->> 'fileSha256' then
		return jsonb_build_object('ok', false, 'problems', jsonb_build_array(public.qorpera_company_state_problem('front_matter', null, null,
			'the text read does not match the saved file; save it again')));
	end if;
	if v_kind in ('vision','agent','group','sections','connection','rule','todo','routine') then
		v_problems := public.qorpera_company_state_parse_problems(v_kind, v_entry -> 'parse');
		if jsonb_array_length(v_problems) > 0 then return jsonb_build_object('ok', false, 'problems', v_problems); end if;
	elsif jsonb_typeof(v_entry -> 'parse') is distinct from 'object' or v_entry -> 'parse' ->> 'kind' is distinct from v_kind then
		return jsonb_build_object('ok', false, 'problems', public.qorpera_company_state_parse_problems(v_kind, v_entry -> 'parse'));
	end if;
	return jsonb_build_object('ok', true, 'kind', v_kind, 'parse', v_entry -> 'parse', 'parserVersion', v_entry -> 'parserVersion');
end $$;

-- 3. The rules of a routine file ----------------------------------------------------------------------------------------

-- The agent whose folder holds a routine key (agents/<h>/routines/<name>.md): its indexed, unretired agent.md.
create function public.qorpera_company_state_routine_owner(p_environment_id uuid, p_key text)
returns uuid language sql stable set search_path = '' as $$
	select s.staff_agent_id from public.qorpera_profile_staff s
	where s.folder_environment_id = p_environment_id and s.folder_retired_at is null and s.deleted_at is null
		and public.qorpera_folder_key(s.folder_path) = regexp_replace(p_key, '/routines/[^/]+[.]md$', '/agent.md')
$$;

-- The one trigger a routine file's timing stands for, as a routine version stores it (pending decision 3: one per
-- file). Its id stays 'file', so the schedule position carries from version to version. starts becomes the millisecond
-- instant a schedule keeps (the rules refuse a finer one). Null for file-change, which is not scheduled on folder-v2
-- yet, and for a parse that is not a routine's.
create function public.qorpera_company_state_routine_trigger(p_parse jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
declare v_when jsonb := p_parse -> 'trigger'; v_days jsonb; v_trigger jsonb;
begin
	if jsonb_typeof(v_when -> 'days') = 'array' then
		select jsonb_agg(case d.value #>> '{}' when 'mon' then 'monday' when 'tue' then 'tuesday' when 'wed' then 'wednesday'
				when 'thu' then 'thursday' when 'fri' then 'friday' when 'sat' then 'saturday' when 'sun' then 'sunday' end
			order by d.ordinality)
		into v_days from jsonb_array_elements(v_when -> 'days') with ordinality d(value, ordinality);
	end if;
	v_trigger := case v_when ->> 'when'
		when 'every' then jsonb_build_object('kind', 'schedule', 'intervalMinutes', v_when -> 'minutes')
		when 'weekly' then jsonb_build_object('kind', 'schedule', 'intervalMinutes', 1440, 'weekdays', v_days,
			'localTime', v_when -> 'time', 'timeZone', p_parse -> 'timezone')
		when 'window' then jsonb_build_object('kind', 'schedule', 'intervalMinutes', v_when -> 'minutes',
				'windowStart', v_when -> 'from', 'windowEnd', v_when -> 'to', 'timeZone', p_parse -> 'timezone')
			|| case when v_days is null then '{}'::jsonb else jsonb_build_object('weekdays', v_days) end
			|| case when jsonb_typeof(v_when -> 'months') = 'array' then jsonb_build_object('months', v_when -> 'months')
				else '{}'::jsonb end
		when 'once' then jsonb_build_object('kind', 'once', 'at', v_when -> 'at', 'timeZone', p_parse -> 'timezone') end;
	if v_trigger is null then return null; end if;
	if v_when ->> 'when' in ('every','weekly') and jsonb_typeof(v_when -> 'starts') = 'string' then
		v_trigger := v_trigger || jsonb_build_object('startAt',
			to_char((v_when ->> 'starts')::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
	end if;
	return v_trigger || jsonb_build_object('id', 'file', 'replyPolicy', p_parse -> 'reply');
exception when others then return null;
end $$;

-- Whether a routine version already holds what a run pins from this file: the agent, title, instructions, trigger and
-- effort. Everything else in the file lives on the routine row.
create function public.qorpera_company_state_routine_same(p_version public.qorpera_cloud_routine_versions, p_owner uuid,
	p_parse jsonb, p_trigger jsonb)
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(p_version.staff_agent_id = p_owner and p_version.title = p_parse ->> 'title'
		and p_version.prompt = p_parse ->> 'instructions' and p_version.triggers = jsonb_build_array(p_trigger)
		and p_version.effort = p_parse ->> 'effort', false)
$$;

-- A routine version's content hash, as an agent's save computes it.
create function public.qorpera_company_state_routine_sha(p_staff_agent_id uuid, p_title text, p_prompt text, p_triggers jsonb,
	p_effort text, p_binding_id uuid, p_sponsor_version bigint)
returns text language sql immutable set search_path = '' as $$
	select encode(extensions.digest(convert_to(jsonb_build_object('staff_agent_id', p_staff_agent_id, 'title', p_title,
		'prompt', p_prompt, 'triggers', p_triggers, 'effort', p_effort, 'sponsor_binding_id', p_binding_id,
		'sponsor_version', p_sponsor_version, 'logical_computer_id', null, 'required_capability', 'agent_turn',
		'job_type', 'agent_turn', 'publication_mode', 'automatic', 'review_policy_key', null,
		'reviewer_staff_ids', '[]'::jsonb)::text, 'utf8'), 'sha256'), 'hex')
$$;

-- Who pays for a routine version a save writes: the saver's own login that pays for unattended work and serves them, the
-- rule of qorpera_agent_routine_sponsor, with the given binding first. Read without that function's lock on the login
-- (qorpera_provider_autonomous_authority takes it FOR SHARE): a commit takes no lock after its clock that a login's own
-- change could hold, and a run re-checks its login when it is admitted. No row when they have none.
create function public.qorpera_company_state_routine_payer(p_profile_id uuid, p_user_id uuid, p_prefer_binding uuid)
returns table(binding_id uuid, version bigint) language sql stable security definer set search_path = '' as $$
	select binding.id, sponsor.version
	from public.qorpera_execution_sponsor_bindings binding
	join public.qorpera_execution_sponsor_versions sponsor on sponsor.binding_id = binding.id
	join public.qorpera_provider_connections connection on connection.id = sponsor.provider_connection_id
	join public.qorpera_provider_connection_versions connection_version on connection_version.connection_id = connection.id
		and connection_version.version = sponsor.provider_connection_version
	where binding.profile_id = p_profile_id and binding.status = 'active' and sponsor.allow_autonomous
		and connection.profile_id = p_profile_id and connection.status = 'active'
		and public.qorpera_provider_execution_enabled(connection.provider, connection_version.authentication_mode,
			connection_version.native_harness)
		and connection_version.authorization_state = 'active' and connection_version.allow_autonomous
		and not exists (select 1 from public.qorpera_provider_connection_versions later
			where later.connection_id = connection.id and later.version > connection_version.version and not later.allow_autonomous)
		and sponsor.version = (select max(latest.version) from public.qorpera_execution_sponsor_versions latest
			where latest.binding_id = binding.id)
		and public.qorpera_sponsor_serves_requester(p_profile_id, binding.id, sponsor.version, p_user_id)
		-- Claude logins are for coding only; they never pay for agent routines.
		and not exists (select 1 from public.qorpera_provider_connection_versions harness
			where harness.connection_id = connection.id and harness.native_harness = 'claude-code')
	order by (binding.id = p_prefer_binding) desc, sponsor.created_at desc, binding.id
	limit 1
$$;

-- Whether a routine version's login still pays for it: its binding still serves the version's creator, at the pinned
-- version or one that follows it.
create function public.qorpera_company_state_routine_paid(p_version public.qorpera_cloud_routine_versions)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_company_state_routine_payer(p_version.profile_id, p_version.created_by_user_id,
			p_version.sponsor_binding_id) p
		where p.binding_id = p_version.sponsor_binding_id
			and public.qorpera_sponsor_version_follows(p.binding_id, p_version.sponsor_version, p.version))
$$;

-- The dynamic routine (when: once) a run was woken for, or null.
create function public.qorpera_company_state_routine_of_run(p_run_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
	select wake.routine_id from public.qorpera_wake_occurrences wake
	join public.qorpera_cloud_routine_versions version on version.routine_id = wake.routine_id and version.version = wake.routine_version
	where wake.run_id = p_run_id and wake.wake_kind = 'routine' and version.triggers -> 0 ->> 'kind' = 'once'
	limit 1
$$;

-- Whether a save starts or extends a routine's work: it makes the routine run again (a first save, a restore, a resume,
-- a reopen, or reviving an expired routine), or it allows more runs or a later end. A pause, a conclusion, fewer runs or
-- an earlier end does not, and quiet hours only delay runs.
create function public.qorpera_company_state_routine_restarts(p_row public.qorpera_cloud_routines, p_prev jsonb, p_parse jsonb)
returns boolean language sql stable set search_path = '' as $$
	select coalesce(p_parse ->> 'status' = 'active' and (p_row.id is null or p_row.status in ('expired','retired')
			or p_prev ->> 'status' is distinct from 'active'), false)
		or (p_row.max_occurrences is not null and coalesce((p_parse ->> 'runs')::integer > p_row.max_occurrences, true))
		or (p_row.expires_at is not null and coalesce((p_parse ->> 'ends')::timestamptz > p_row.expires_at, true))
$$;

-- Who pays from a save on (S2: a member's login pays only for work that member started): the saver's own login that
-- pays, the version's pinned one first. When they have none, paid is false and the routine waits for a login: a run's
-- requester pins the run's login, and a member whose login stopped paying after the save was decided their newest.
-- The platform keeps the version's.
create function public.qorpera_company_state_routine_saver_pays(p_commit public.qorpera_folder_commits, p_profile_id uuid,
	p_current public.qorpera_cloud_routine_versions, out binding_id uuid, out version bigint, out user_id uuid, out paid boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
	if p_commit.actor_kind = 'platform' then
		binding_id := p_current.sponsor_binding_id; version := p_current.sponsor_version; user_id := p_current.created_by_user_id;
		paid := public.qorpera_company_state_routine_paid(p_current);
		return;
	end if;
	user_id := p_commit.requester_id;
	select p.binding_id, p.version into binding_id, version
	from public.qorpera_company_state_routine_payer(p_profile_id, p_commit.requester_id,
		coalesce(p_current.sponsor_binding_id, p_commit.sponsor_binding_id)) p;
	paid := binding_id is not null;
	if paid then return; end if;
	if p_commit.actor_kind = 'staff_agent' then
		binding_id := p_commit.sponsor_binding_id; version := p_commit.sponsor_version;
	else
		select s.binding_id, s.version into binding_id, version
		from public.qorpera_execution_sponsor_versions s
		join public.qorpera_execution_sponsor_bindings b on b.id = s.binding_id
		join public.qorpera_provider_connections c on c.id = s.provider_connection_id
		where b.profile_id = p_profile_id and c.owner_user_id = p_commit.requester_id
		order by s.created_at desc, s.binding_id limit 1;
	end if;
end $$;

-- One routine file (§2): it lives in an agent's folder (an indexed agent, or the agent.md the same unit writes); the id
-- never changes and belongs to this file's routine only; the file name (at most 64 characters of a-z, 0-9 and hyphens,
-- which the routine key allows) is a key no other routine of the agent has; its timing is one the scheduler runs; only
-- an agent's run makes a routine dynamic, and never one a member made; a dynamic routine's own run never pauses it, and
-- while it owes its decision its save of the file is only the decision (contract 16.3); a member's save that makes a
-- new version, or starts or extends the routine's work, needs the member's own login to pay for it.
create function public.qorpera_company_state_routine_rules(p_environment_id uuid, p_profile_id uuid, p_actor jsonb, p_key text,
	p_parse jsonb, p_owner_in_unit boolean)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_base jsonb := public.qorpera_company_state_base(p_environment_id, p_key); v_row public.qorpera_cloud_routines%rowtype;
	v_version public.qorpera_cloud_routine_versions%rowtype; v_exists boolean; v_problem text; v_prev jsonb;
	v_trigger jsonb := public.qorpera_company_state_routine_trigger(p_parse); v_when text := p_parse -> 'trigger' ->> 'when';
	v_name text := public.qorpera_company_state_todo_key(p_key);
	v_owner uuid := public.qorpera_company_state_routine_owner(p_environment_id, p_key); v_zone text; v_own uuid;
	-- What a decision may change: a new at (the trigger), and with it the title, instructions, effort or reply.
	c_decision constant text[] := array['trigger','title','instructions','effort','reply'];
begin
	-- The saved version is trusted only when the index points at this path for its routine.
	if v_base is not null and (jsonb_array_length(public.qorpera_company_state_parse_problems('routine', v_base)) > 0
		or not exists (select 1 from public.qorpera_cloud_routines r
			where r.id = (v_base ->> 'id')::uuid and r.folder_environment_id = p_environment_id and r.folder_retired_at is null
				and public.qorpera_folder_key(r.folder_path) = p_key)) then
		v_base := null; end if;
	select * into v_row from public.qorpera_cloud_routines where id = (p_parse ->> 'id')::uuid;
	v_exists := found;
	-- A restore has no saved version at its path: the saved version is the routine's last file.
	v_prev := v_base;
	if v_prev is null and v_exists and v_row.profile_id = p_profile_id and v_row.folder_environment_id = p_environment_id
		and v_row.folder_retired_at is not null then
		select v.structured -> 'parse' into v_prev from public.qorpera_folder_path_versions v where v.version = v_row.folder_path_version;
		if v_prev is not null and jsonb_array_length(public.qorpera_company_state_parse_problems('routine', v_prev)) > 0 then
			v_prev := null; end if;
	end if;
	if v_exists then
		select * into v_version from public.qorpera_cloud_routine_versions where routine_id = v_row.id and version = v_row.current_version;
	end if;
	if p_actor ->> 'kind' = 'staff_agent' then
		v_own := public.qorpera_company_state_routine_of_run((p_actor ->> 'runId')::uuid); end if;
	-- A time zone the parser accepts by its shape but the database does not know.
	v_zone := coalesce(case when jsonb_typeof(p_parse -> 'timezone') = 'string'
			and not public.qorpera_runtime_time_zone_name_valid(p_parse ->> 'timezone') then p_parse ->> 'timezone' end,
		case when jsonb_typeof(p_parse -> 'quiet') = 'object'
			and not public.qorpera_runtime_time_zone_name_valid(p_parse -> 'quiet' ->> 'timezone') then p_parse -> 'quiet' ->> 'timezone' end);
	if v_owner is null and not p_owner_in_unit then
		v_problem := 'a routine lives in an agent''s folder, next to its agent.md';
	elsif v_base is not null and v_base ->> 'id' is distinct from p_parse ->> 'id' then
		v_problem := 'id never changes; it is ' || (v_base ->> 'id');
	-- A row from before the files has no folder environment (qorpera_cloud_routines_folder_complete).
	elsif (v_exists and (v_row.profile_id <> p_profile_id or v_row.folder_environment_id is distinct from p_environment_id))
		or exists (select 1 from public.qorpera_cloud_routines r
			where r.profile_id = p_profile_id and r.client_routine_id = (p_parse ->> 'id')::uuid and r.id <> (p_parse ->> 'id')::uuid) then
		v_problem := 'this id belongs to another routine; give this routine a new id';
	elsif v_exists and v_row.folder_retired_at is null and public.qorpera_folder_key(v_row.folder_path) <> p_key then
		v_problem := 'this id belongs to the routine at ' || left(v_row.folder_path, 100) || '; give this routine a new id';
	elsif v_owner is not null and exists (select 1 from public.qorpera_cloud_routines r
		where r.profile_id = p_profile_id and r.environment_id = p_environment_id and r.owner_staff_agent_id = v_owner
			and r.routine_key = v_name and r.id <> (p_parse ->> 'id')::uuid) then
		v_problem := 'this agent has another routine called ' || v_name || '; choose another name';
	elsif v_when = 'file-change' then
		v_problem := 'a file-change routine waits for the folder''s file events, which come later; use every, weekly, window or once';
	elsif v_zone is not null then
		v_problem := 'the platform does not know the time zone ' || left(v_zone, 64) || '; use a name like Europe/Copenhagen';
	elsif jsonb_typeof(p_parse -> 'trigger' -> 'starts') = 'string'
		and date_trunc('milliseconds', (p_parse -> 'trigger' ->> 'starts')::timestamptz) <> (p_parse -> 'trigger' ->> 'starts')::timestamptz then
		v_problem := 'starts is given to the millisecond at most';
	elsif v_trigger is null or not public.qorpera_cloud_routine_trigger_valid(v_trigger) then
		v_problem := 'the platform cannot schedule this timing';
	elsif v_when = 'once' and v_prev -> 'trigger' ->> 'when' is distinct from 'once' and p_actor ->> 'kind' is distinct from 'staff_agent' then
		v_problem := 'only an agent makes a routine dynamic (when: once)';
	elsif v_when = 'once' and v_exists and v_row.origin = 'member' then
		v_problem := 'a routine a member made does not become dynamic (when: once)';
	elsif v_own = (p_parse ->> 'id')::uuid and p_parse ->> 'status' = 'paused' and v_prev ->> 'status' is distinct from 'paused' then
		v_problem := 'this run cannot pause its own routine; conclude it instead';
	elsif v_own = (p_parse ->> 'id')::uuid and public.qorpera_routine_decision_pending((p_actor ->> 'runId')::uuid)
		and not coalesce((p_parse ->> 'status' = 'active' and v_when = 'once' and p_parse - c_decision = v_prev - c_decision)
			or (p_parse ->> 'status' = 'concluded'
				and p_parse - array['status','conclusion'] = v_prev - array['status','conclusion']), false) then
		v_problem := 'this run owes its routine''s decision: set a new at (and, if needed, the title, instructions, effort or '
			|| 'reply), or conclude it with a conclusion';
	elsif not (v_exists and public.qorpera_company_state_routine_same(v_version, v_owner, p_parse, v_trigger))
		or public.qorpera_company_state_routine_restarts(v_row, v_prev, p_parse) then
		if p_actor ->> 'kind' = 'member' and not exists (select 1 from public.qorpera_company_state_routine_payer(p_profile_id,
				(p_actor ->> 'userId')::uuid, v_version.sponsor_binding_id)) then
			v_problem := 'a routine runs on the AI login of the member who saves it; connect yours in Settings, then save again';
		elsif p_actor ->> 'kind' = 'platform' and v_version.routine_id is null then
			v_problem := 'the platform does not start routines';
		end if;
	end if;
	if v_problem is null then return null; end if;
	return jsonb_build_object('ok', false, 'reason', 'structured_rule',
		'problems', jsonb_build_array(public.qorpera_company_state_problem('value', null, null, v_problem)));
end $$;

-- One routine file's rows (§4). The row follows the file. A new version comes when what a run pins changes, when a
-- dynamic routine's own run decides, and when the saver's login is not the one pinned for work the save starts or
-- extends (see qorpera_company_state_routine_saver_pays). Its schedule position is inserted before the routine moves to
-- it: the move supersedes the old version's waiting runs, and one still waiting is offered again only while it is
-- visible there. Status: see the header. A second change set that wrote another file with the same new id first makes
-- this one abort (its retry is refused by decide).
create function public.qorpera_company_state_index_routine(p_environment_id uuid, p_profile_id uuid, p_commit_id uuid,
	p_path text, p_version uuid, p_parse jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
	v_commit public.qorpera_folder_commits%rowtype; v_row public.qorpera_cloud_routines%rowtype;
	v_current public.qorpera_cloud_routine_versions%rowtype; v_id uuid := (p_parse ->> 'id')::uuid;
	v_owner uuid := public.qorpera_company_state_routine_owner(p_environment_id, public.qorpera_folder_key(p_path));
	v_trigger jsonb := public.qorpera_company_state_routine_trigger(p_parse); v_status text := p_parse ->> 'status';
	v_prev jsonb; v_pay record; v_paid boolean := true; v_new boolean; v_restarts boolean; v_woken boolean; v_own boolean;
	v_set boolean; v_reason text; v_next bigint; v_created timestamptz; v_count bigint;
begin
	select * into v_commit from public.qorpera_folder_commits where id = p_commit_id;
	-- A run this routine woke (it may conclude the routine and still finish), and whether it is the routine's dynamic run.
	v_woken := v_commit.run_id is not null and v_commit.routine_id = v_id;
	v_own := v_woken and public.qorpera_company_state_routine_of_run(v_commit.run_id) = v_id;
	select * into v_row from public.qorpera_cloud_routines where id = v_id;
	if found then
		-- The file this save follows: the one the routine points at (for a restore, its last file).
		select v.structured -> 'parse' into v_prev from public.qorpera_folder_path_versions v where v.version = v_row.folder_path_version;
		if v_prev is not null and jsonb_array_length(public.qorpera_company_state_parse_problems('routine', v_prev)) > 0 then
			v_prev := null; end if;
		select * into v_current from public.qorpera_cloud_routine_versions where routine_id = v_id and version = v_row.current_version;
	end if;
	v_restarts := public.qorpera_company_state_routine_restarts(v_row, v_prev, p_parse);
	v_new := v_current.routine_id is null or (v_own and v_status = 'active')
		or not public.qorpera_company_state_routine_same(v_current, v_owner, p_parse, v_trigger);
	-- The saver pays for a new version and for work the save starts or extends; when the saver's login is not the one
	-- pinned, a version like the last pins it.
	if v_new or v_restarts then
		select * into v_pay from public.qorpera_company_state_routine_saver_pays(v_commit, p_profile_id, v_current);
		v_paid := v_pay.paid;
		if v_pay.paid and not coalesce(v_pay.binding_id = v_current.sponsor_binding_id
			and public.qorpera_sponsor_version_follows(v_current.sponsor_binding_id, v_current.sponsor_version, v_pay.version), false) then
			v_new := true; end if;
		if v_new and v_pay.binding_id is null then raise exception 'A routine version has no login to pin' using errcode = 'XX000'; end if;
	end if;
	if v_row.id is null then
		insert into public.qorpera_cloud_routines(id, profile_id, environment_id, client_routine_id, status, created_by_user_id,
			origin, owner_staff_agent_id, routine_key, folder_environment_id, folder_path, folder_path_version, folder_commit_id)
		values (v_id, p_profile_id, p_environment_id, v_id, 'paused', v_pay.user_id,
			case when v_commit.actor_kind = 'staff_agent' then 'agent' else 'member' end, v_owner,
			public.qorpera_company_state_todo_key(p_path), p_environment_id, p_path, p_version, p_commit_id)
		on conflict (id) do nothing;
		get diagnostics v_count = row_count;
		if v_count = 0 then raise exception 'A routine id was taken by another change set' using errcode = '23505'; end if;
		select * into v_row from public.qorpera_cloud_routines where id = v_id;
	end if;

	-- The saver's word on the status: a change of it, a restore or a first save. Otherwise the platform's record stays,
	-- except that a save revives an expired routine and a new version ends a wait for a login.
	v_set := v_current.routine_id is null or v_row.status = 'retired' or v_prev is null
		or v_prev ->> 'status' is distinct from v_status
		or (v_status = 'active' and (v_row.status = 'expired'
			or (v_row.status = 'paused' and v_row.pause_reason = 'needs_model_account' and v_new)))
		or (v_status = 'paused' and v_row.status = 'active')
		or (v_status = 'concluded' and v_row.status <> 'concluded');
	if not v_set then v_status := v_row.status; v_reason := v_row.pause_reason;
	elsif v_status = 'paused' then
		v_reason := case v_commit.actor_kind when 'member' then 'member' when 'staff_agent' then 'agent'
			else case when v_row.status = 'paused' then v_row.pause_reason end end;
	end if;
	-- A routine no login pays for waits for one, as an agent's save leaves it today.
	if v_status = 'active' and not v_paid then v_status := 'paused'; v_reason := 'needs_model_account'; end if;
	-- A routine whose runs are used up has ended, as the recorded occurrence at its limit leaves it.
	if v_status = 'active' and p_parse ->> 'runs' is not null
		and public.qorpera_routine_occurrence_count(v_id) >= (p_parse ->> 'runs')::integer then
		v_status := 'expired'; v_reason := null; end if;

	if v_new then
		v_next := v_row.current_version + 1;
		insert into public.qorpera_cloud_routine_versions(routine_id, version, client_version_id, profile_id, environment_id,
			staff_agent_id, title, prompt, triggers, effort, sponsor_binding_id, sponsor_version, content_sha256, created_by_user_id)
		values (v_id, v_next, extensions.gen_random_uuid(), p_profile_id, p_environment_id, v_owner, p_parse ->> 'title',
			p_parse ->> 'instructions', jsonb_build_array(v_trigger), p_parse ->> 'effort', v_pay.binding_id, v_pay.version,
			public.qorpera_company_state_routine_sha(v_owner, p_parse ->> 'title', p_parse ->> 'instructions',
				jsonb_build_array(v_trigger), p_parse ->> 'effort', v_pay.binding_id, v_pay.version), v_pay.user_id)
		returning created_at into v_created;
		if v_trigger ->> 'kind' = 'schedule' then
			insert into public.qorpera_cloud_routine_schedule_cursors(routine_id, routine_version, trigger_id, last_scheduled_for,
				next_due_at)
			select v_id, v_next, 'file', position.last_scheduled_for, position.next_due_at
			from public.qorpera_routine_version_schedule_position(v_id, v_row.current_version, v_trigger, v_created,
				v_row.status = 'active', v_status = 'active') position;
		end if;
	else v_next := v_row.current_version; end if;
	update public.qorpera_cloud_routines set current_version = v_next, status = v_status, pause_reason = v_reason,
		authorization_failures = case when v_set and v_status = 'active' then 0 else authorization_failures end,
		conclusion = case when v_status = 'concluded' then coalesce(p_parse ->> 'conclusion', conclusion) end,
		concluded_at = case when v_status = 'concluded' then coalesce(concluded_at, statement_timestamp()) end,
		concluded_by_run_id = case when v_status <> 'concluded' then null when status = 'concluded' then concluded_by_run_id
			when v_woken then v_commit.run_id end,
		expires_at = (p_parse ->> 'ends')::timestamptz, max_occurrences = (p_parse ->> 'runs')::integer,
		quiet_start = (p_parse -> 'quiet' ->> 'start')::time, quiet_end = (p_parse -> 'quiet' ->> 'end')::time,
		quiet_time_zone = p_parse -> 'quiet' ->> 'timezone', owner_staff_agent_id = v_owner,
		routine_key = public.qorpera_company_state_todo_key(p_path), folder_environment_id = p_environment_id, folder_path = p_path,
		folder_path_version = p_version, folder_commit_id = p_commit_id, folder_retired_at = null, updated_at = statement_timestamp()
	where id = v_id;
end $$;

-- 4. The hooks, with the routine branches ---------------------------------------------------------------------------

create or replace function public.qorpera_folder_structured_targets(p_environment_id uuid, p_actor jsonb, p_units jsonb)
returns table(rank smallint, tbl text, key text, mode text) language plpgsql stable set search_path = '' as $$
declare
	v_profile uuid; v_unit jsonb; v_op text; v_key text; v_entry jsonb; v_staff record; v_room uuid; v_routine uuid;
	c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id;
	if v_profile is null then return; end if;
	for v_unit in select value from jsonb_array_elements(p_units) loop
		v_op := v_unit ->> 'op';
		if v_op in ('write','new_folder') then
			for v_entry in select e.value from jsonb_array_elements(case when jsonb_typeof(v_unit -> 'structured') = 'array'
					then v_unit -> 'structured' else '[]'::jsonb end) e
				where e.value ->> 'kind' = 'agent' and coalesce(e.value -> 'parse' ->> 'id', '') ~ c_uuid
			loop
				rank := 2; tbl := 'qorpera_profile_staff'; key := v_profile::text || ':' || (v_entry -> 'parse' ->> 'id'); mode := 'nokeyupdate';
				return next;
				rank := 2; tbl := 'qorpera_profiles'; key := v_profile::text; mode := 'keyshare';
				return next;
				select s.display_name, s.employment_status, s.folder_retired_at into v_staff from public.qorpera_profile_staff s
				where s.profile_id = v_profile and s.staff_agent_id = (v_entry -> 'parse' ->> 'id')::uuid;
				if found and (v_staff.display_name is distinct from v_entry -> 'parse' ->> 'name'
					or v_staff.employment_status is distinct from v_entry -> 'parse' ->> 'status' or v_staff.folder_retired_at is not null) then
					for v_room in select r.id from public.qorpera_company_rooms r
						where r.profile_id = v_profile and r.bound_staff_agent_id = (v_entry -> 'parse' ->> 'id')::uuid loop
						rank := 4; tbl := 'qorpera_company_rooms'; key := v_room::text; mode := 'update';
						return next;
					end loop;
				end if;
			end loop;
			for v_entry in select e.value from jsonb_array_elements(case when jsonb_typeof(v_unit -> 'structured') = 'array'
					then v_unit -> 'structured' else '[]'::jsonb end) e
				where e.value ->> 'kind' in ('group','sections','rule','todo','routine')
			loop
				rank := 2; tbl := 'qorpera_profiles'; key := v_profile::text; mode := 'keyshare';
				return next;
				if v_entry ->> 'kind' = 'group' and coalesce(v_entry -> 'parse' ->> 'id', '') ~ c_uuid then
					for v_room in select r.id from public.qorpera_company_rooms r
						where r.id = (v_entry -> 'parse' ->> 'id')::uuid and r.profile_id = v_profile and r.folder_path is not null loop
						rank := 4; tbl := 'qorpera_company_rooms'; key := v_room::text; mode := 'nokeyupdate';
						return next;
					end loop;
				end if;
				-- A routine's row, at rank 5, where a run of that routine holds it FOR KEY SHARE.
				if v_entry ->> 'kind' = 'routine' and coalesce(v_entry -> 'parse' ->> 'id', '') ~ c_uuid then
					for v_routine in select r.id from public.qorpera_cloud_routines r
						where r.id = (v_entry -> 'parse' ->> 'id')::uuid and r.profile_id = v_profile loop
						rank := 5; tbl := 'qorpera_cloud_routines'; key := v_routine::text; mode := 'nokeyupdate';
						return next;
					end loop;
				end if;
			end loop;
		elsif v_op in ('delete','move') then
			v_key := public.qorpera_folder_key(case when v_op = 'move' then v_unit ->> 'from' else v_unit ->> 'path' end);
			if v_key like 'agents/%' then
				for v_staff in select s.staff_agent_id, s.employment_status from public.qorpera_profile_staff s
					where s.folder_environment_id = p_environment_id and s.folder_path is not null and s.deleted_at is null
						and (public.qorpera_folder_key(s.folder_path) = v_key
							or public.qorpera_folder_key(s.folder_path) like public.qorpera_folder_under(v_key))
				loop
					rank := 2; tbl := 'qorpera_profile_staff'; key := v_profile::text || ':' || v_staff.staff_agent_id::text; mode := 'nokeyupdate';
					return next;
					rank := 2; tbl := 'qorpera_profiles'; key := v_profile::text; mode := 'keyshare';
					return next;
					if v_op = 'delete' and v_staff.employment_status = 'active' then
						for v_room in select r.id from public.qorpera_company_rooms r
							where r.profile_id = v_profile and r.bound_staff_agent_id = v_staff.staff_agent_id loop
							rank := 4; tbl := 'qorpera_company_rooms'; key := v_room::text; mode := 'update';
							return next;
						end loop;
					end if;
				end loop;
				for v_room in select r.id from public.qorpera_company_rooms r
					where r.folder_environment_id = p_environment_id and r.folder_path is not null and r.folder_retired_at is null
						and (public.qorpera_folder_key(r.folder_path) = v_key
							or public.qorpera_folder_key(r.folder_path) like public.qorpera_folder_under(v_key))
				loop
					rank := 2; tbl := 'qorpera_profiles'; key := v_profile::text; mode := 'keyshare';
					return next;
					rank := 4; tbl := 'qorpera_company_rooms'; key := v_room::text; mode := 'nokeyupdate';
					return next;
				end loop;
				for v_routine in select r.id from public.qorpera_cloud_routines r
					where r.folder_environment_id = p_environment_id and r.folder_retired_at is null
						and (r.folder_path = v_key collate "C"
							or (r.folder_path > (v_key || '/') collate "C" and r.folder_path < (v_key || '0') collate "C"))
				loop
					rank := 2; tbl := 'qorpera_profiles'; key := v_profile::text; mode := 'keyshare';
					return next;
					rank := 5; tbl := 'qorpera_cloud_routines'; key := v_routine::text; mode := 'nokeyupdate';
					return next;
				end loop;
			end if;
		end if;
	end loop;
end $$;

create or replace function public.qorpera_folder_structured_decide(p_environment_id uuid, p_actor jsonb, p_commit_id uuid, p_unit_no integer,
	p_unit jsonb, p_eff_path text, p_eff_to text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_op text := p_unit ->> 'op'; v_profile uuid; v_key text; v_row public.qorpera_folder_entries%rowtype;
	v_file record; v_checked jsonb; v_rule jsonb; v_problems jsonb; v_cofounder_path text; v_content jsonb;
	v_entries jsonb; v_ids text[] := '{}'; v_cofounders integer := 0; v_groups text[] := '{}'; v_connections text[] := '{}';
	v_rules text[] := '{}'; v_rule_bytes bigint := 0; v_todos text[] := '{}'; v_agent_files text[]; v_routines text[] := '{}';
	v_own uuid; v_carried record; v_dest text; v_dest_owner uuid;
begin
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id;
	v_key := public.qorpera_folder_key(p_eff_path);

	if v_op in ('delete','move') then
		if public.qorpera_company_state_seeded(v_key) then return jsonb_build_object('ok', false, 'reason', 'seeded'); end if;
		select s.folder_path into v_cofounder_path from public.qorpera_company_cofounders c
			join public.qorpera_profile_staff s on s.profile_id = c.profile_id and s.staff_agent_id = c.staff_agent_id
		where c.profile_id = v_profile and s.folder_environment_id = p_environment_id;
		-- The Co-Founder's agent.md and its folder are never deleted; the folder only moves within agents/ (the
		-- kind-change rule refuses anywhere else), and the file never moves alone.
		if v_cofounder_path is not null and v_op = 'delete'
			and (public.qorpera_folder_key(v_cofounder_path) = v_key
				or public.qorpera_folder_key(v_cofounder_path) like public.qorpera_folder_under(v_key)) then
			return jsonb_build_object('ok', false, 'reason', 'cofounder'); end if;
		select * into v_row from public.qorpera_folder_entries
		where environment_id = p_environment_id and key_sha256 = extensions.digest(v_key, 'sha256') and kind <> 'claim';
		-- An agent.md or group.md never goes alone: its folder is deleted or moved instead.
		if v_row.kind = 'file' and public.qorpera_structured_path_kind(v_key) in ('agent','group') then
			return jsonb_build_object('ok', false, 'reason', 'lone_structured_file'); end if;
		-- A connection's file goes only when the platform removes it after a disconnect.
		if v_op = 'delete' and v_row.kind = 'file' and public.qorpera_structured_path_kind(v_key) = 'connection'
			and (p_actor ->> 'kind' is distinct from 'platform'
				or exists (select 1 from public.qorpera_folder_connection_index i
					join public.qorpera_cloud_secrets s on s.id = i.secret_id
					where i.environment_id = p_environment_id and i.retired_at is null
						and public.qorpera_folder_key(i.folder_path) = v_key and s.status = 'active')) then
			return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
				public.qorpera_company_state_problem('value', null, null,
					'a connection''s file goes when its account is disconnected in Settings'))); end if;
		-- A todo with a working worker stays where it is, its folder too: cancel the worker first.
		if exists (select 1 from public.qorpera_runtime_agent_todos t
			join public.qorpera_runtime_workers w on w.todo_id = t.id and w.state = 'active'
			where t.folder_environment_id = p_environment_id and t.folder_retired_at is null
				and (t.folder_path = v_key collate "C"
					or (t.folder_path > (v_key || '/') collate "C" and t.folder_path < (v_key || '0') collate "C"))) then
			return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
				public.qorpera_company_state_problem('value', null, null,
					'a todo here has a worker at work; cancel the worker first'))); end if;
		if v_op = 'move' and exists (select 1 from public.qorpera_runtime_agent_todos t
			where t.folder_environment_id = p_environment_id and t.folder_retired_at is null
				and (t.folder_path = v_key collate "C"
					or (t.folder_path > (v_key || '/') collate "C" and t.folder_path < (v_key || '0') collate "C"))
				and not exists (select 1 from public.qorpera_profile_staff s
					where s.folder_environment_id = p_environment_id and s.folder_retired_at is null and s.deleted_at is null
						and regexp_replace(public.qorpera_folder_key(p_eff_to || substr(t.folder_path, char_length(p_eff_path) + 1)),
								'/todos/[^/]+[.]md$', '/agent.md')
							= case when public.qorpera_folder_key(s.folder_path) = v_key
									or public.qorpera_folder_key(s.folder_path) like public.qorpera_folder_under(v_key)
								then public.qorpera_folder_key(p_eff_to || substr(s.folder_path, char_length(p_eff_path) + 1))
								else public.qorpera_folder_key(s.folder_path) end)) then
			return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
				public.qorpera_company_state_problem('value', null, null, 'a todo moves only into an agent''s todos folder'))); end if;
		-- A dynamic routine's own run never removes or moves it: it concludes it.
		if p_actor ->> 'kind' = 'staff_agent' then
			v_own := public.qorpera_company_state_routine_of_run((p_actor ->> 'runId')::uuid);
			if v_own is not null and exists (select 1 from public.qorpera_cloud_routines r
				where r.id = v_own and r.folder_environment_id = p_environment_id and r.folder_retired_at is null
					and (r.folder_path = v_key collate "C"
						or (r.folder_path > (v_key || '/') collate "C" and r.folder_path < (v_key || '0') collate "C"))) then
				return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', null, null,
						'this run cannot remove or move its own routine; conclude it instead'))); end if;
		end if;
		-- A routine moves only into an agent's routines folder (its folder may move along), onto a name no routine row of
		-- that agent from before the files has. Anywhere else is a kind change, which the next check refuses. A handover
		-- to another agent is a new version: a member's needs the member's own login to pay for it.
		if v_op = 'move' then
			for v_carried in select r.id, r.folder_path, r.current_version from public.qorpera_cloud_routines r
				where r.folder_environment_id = p_environment_id and r.folder_retired_at is null
					and (r.folder_path = v_key collate "C"
						or (r.folder_path > (v_key || '/') collate "C" and r.folder_path < (v_key || '0') collate "C"))
			loop
				v_dest := public.qorpera_folder_key(p_eff_to || substr(v_carried.folder_path, char_length(p_eff_path) + 1));
				if public.qorpera_structured_path_kind(v_dest) is distinct from 'routine' then continue; end if;
				v_dest_owner := null;
				select s.staff_agent_id into v_dest_owner from public.qorpera_profile_staff s
				where s.folder_environment_id = p_environment_id and s.folder_retired_at is null and s.deleted_at is null
					and regexp_replace(v_dest, '/routines/[^/]+[.]md$', '/agent.md')
						= case when public.qorpera_folder_key(s.folder_path) = v_key
								or public.qorpera_folder_key(s.folder_path) like public.qorpera_folder_under(v_key)
							then public.qorpera_folder_key(p_eff_to || substr(s.folder_path, char_length(p_eff_path) + 1))
							else public.qorpera_folder_key(s.folder_path) end;
				if v_dest_owner is null then
					return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
						public.qorpera_company_state_problem('value', null, null, 'a routine moves only into an agent''s routines folder')));
				end if;
				if exists (select 1 from public.qorpera_cloud_routines r
					where r.profile_id = v_profile and r.environment_id = p_environment_id and r.folder_path is null
						and r.owner_staff_agent_id = v_dest_owner and r.routine_key = public.qorpera_company_state_todo_key(v_dest)) then
					return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
						public.qorpera_company_state_problem('value', null, null,
							'that agent has another routine called ' || public.qorpera_company_state_todo_key(v_dest)
								|| '; choose another name'))); end if;
				if p_actor ->> 'kind' = 'member' and exists (select 1 from public.qorpera_cloud_routine_versions cv
						where cv.routine_id = v_carried.id and cv.version = v_carried.current_version and cv.staff_agent_id <> v_dest_owner)
					and not exists (select 1 from public.qorpera_company_state_routine_payer(v_profile, (p_actor ->> 'userId')::uuid, null)) then
					return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
						public.qorpera_company_state_problem('value', null, null,
							'a routine handed to another agent runs on the AI login of the member who moves it; connect yours in Settings, '
								|| 'then move it again'))); end if;
			end loop;
		end if;
		if v_op = 'move' then return public.qorpera_company_state_carried(p_environment_id, v_op, v_key, p_eff_to, v_row); end if;
		return jsonb_build_object('ok', true);
	end if;

	if v_op = 'copy' then
		select * into v_row from public.qorpera_folder_entries
		where environment_id = p_environment_id and key_sha256 = extensions.digest(v_key, 'sha256') and kind <> 'claim';
		return public.qorpera_company_state_carried(p_environment_id, v_op, v_key, p_eff_to, v_row);
	end if;

	if v_op = 'mkdir' then
		v_problems := public.qorpera_company_state_path_problems(p_eff_path, true);
		if jsonb_array_length(v_problems) > 0 then
			return jsonb_build_object('ok', false, 'reason', 'structured_invalid', 'problems', v_problems); end if;
		return jsonb_build_object('ok', true);
	end if;

	-- write or new_folder: the folders a new folder brings are checked by name; every structured file it writes
	-- is checked, then its database rules.
	if v_op = 'new_folder' then
		for v_content in select to_jsonb(c) from (select p_eff_path as path union all
			select s.path from public.qorpera_folder_spelled_contents(p_eff_path, p_unit -> 'contents') s where s.kind = 'folder') c loop
			v_problems := public.qorpera_company_state_path_problems(v_content ->> 'path', true);
			if jsonb_array_length(v_problems) > 0 then
				return jsonb_build_object('ok', false, 'reason', 'structured_invalid', 'problems', v_problems); end if;
		end loop;
	end if;
	v_entries := public.qorpera_company_state_entries(p_unit);
	for v_file in select * from public.qorpera_company_state_unit_files(p_unit, p_eff_path) loop
		if public.qorpera_structured_path_kind(v_file.key) is null then continue; end if;
		v_checked := public.qorpera_company_state_checked(v_entries -> v_file.key, v_file.path, v_file.key, v_file.file);
		if not (v_checked ->> 'ok')::boolean then
			return jsonb_build_object('ok', false, 'reason', 'structured_invalid', 'problems', v_checked -> 'problems'); end if;
		if v_checked ->> 'kind' = 'agent' then
			-- One id per agent, and one Co-Founder, within the unit too.
			if (v_checked -> 'parse' ->> 'id') = any (v_ids) or (v_checked -> 'parse' ->> 'agentKind' = 'co-founder' and v_cofounders > 0) then
				return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', null, null, 'two agent.md files in one change carry the same id or kind'))); end if;
			v_ids := array_append(v_ids, v_checked -> 'parse' ->> 'id');
			if v_checked -> 'parse' ->> 'agentKind' = 'co-founder' then v_cofounders := v_cofounders + 1; end if;
			v_rule := public.qorpera_company_state_agent_rules(p_environment_id, v_profile, p_actor, v_file.path, v_file.key,
				v_checked -> 'parse');
			if v_rule is not null then return v_rule; end if;
			-- An agent never takes a conversation's id: sections.md lists both kinds by id.
			if exists (select 1 from public.qorpera_company_rooms r where r.id = (v_checked -> 'parse' ->> 'id')::uuid) then
				return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', null, null, 'this id belongs to a conversation; give this agent a new id'))); end if;
		elsif v_checked ->> 'kind' = 'group' then
			-- One id per group chat within the unit too.
			if (v_checked -> 'parse' ->> 'id') = any (v_groups) then
				return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', null, null, 'two group.md files in one change carry the same id'))); end if;
			v_groups := array_append(v_groups, v_checked -> 'parse' ->> 'id');
			v_rule := public.qorpera_company_state_group_rules(p_environment_id, v_profile, p_actor, v_file.key, v_checked -> 'parse');
			if v_rule is not null then return v_rule; end if;
		elsif v_checked ->> 'kind' = 'sections' then
			v_rule := public.qorpera_company_state_sections_rules(p_environment_id, v_profile, v_file.key, v_checked -> 'parse');
			if v_rule is not null then return v_rule; end if;
		elsif v_checked ->> 'kind' = 'connection' then
			-- One file per connection within the unit too.
			if (v_checked -> 'parse' ->> 'id') = any (v_connections) then
				return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', null, null, 'two connection files in one change carry the same id'))); end if;
			v_connections := array_append(v_connections, v_checked -> 'parse' ->> 'id');
			v_rule := public.qorpera_company_state_connection_rules(p_environment_id, v_profile, p_actor, v_file.key, v_checked -> 'parse');
			if v_rule is not null then return v_rule; end if;
		elsif v_checked ->> 'kind' = 'rule' then
			-- One file per rule within the unit too.
			if (v_checked -> 'parse' ->> 'id') = any (v_rules) then
				return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', null, null, 'two rule files in one change carry the same id'))); end if;
			v_rule := public.qorpera_company_state_rule_rules(p_environment_id, v_profile, v_file.key, v_checked -> 'parse',
				v_rules, v_rule_bytes);
			if v_rule is not null then return v_rule; end if;
			v_rules := array_append(v_rules, v_checked -> 'parse' ->> 'id');
			v_rule_bytes := v_rule_bytes + octet_length(v_checked -> 'parse' ->> 'text');
		elsif v_checked ->> 'kind' = 'todo' then
			-- One file per todo within the unit too.
			if (v_checked -> 'parse' ->> 'id') = any (v_todos) then
				return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', null, null, 'two todo files in one change carry the same id'))); end if;
			v_todos := array_append(v_todos, v_checked -> 'parse' ->> 'id');
			-- The agent.md files this unit writes, read once for the whole unit.
			if v_agent_files is null then
				v_agent_files := array(select o.key from public.qorpera_company_state_unit_files(p_unit, p_eff_path) o
					where v_entries -> o.key ->> 'kind' is not distinct from 'agent'); end if;
			v_rule := public.qorpera_company_state_todo_rules(p_environment_id, v_profile, v_file.key, v_checked -> 'parse',
				regexp_replace(v_file.key, '/todos/[^/]+[.]md$', '/agent.md') = any (v_agent_files));
			if v_rule is not null then return v_rule; end if;
		elsif v_checked ->> 'kind' = 'routine' then
			-- One file per routine within the unit too.
			if (v_checked -> 'parse' ->> 'id') = any (v_routines) then
				return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', null, null, 'two routine files in one change carry the same id'))); end if;
			v_routines := array_append(v_routines, v_checked -> 'parse' ->> 'id');
			if v_agent_files is null then
				v_agent_files := array(select o.key from public.qorpera_company_state_unit_files(p_unit, p_eff_path) o
					where v_entries -> o.key ->> 'kind' is not distinct from 'agent'); end if;
			v_rule := public.qorpera_company_state_routine_rules(p_environment_id, v_profile, p_actor, v_file.key, v_checked -> 'parse',
				regexp_replace(v_file.key, '/routines/[^/]+[.]md$', '/agent.md') = any (v_agent_files));
			if v_rule is not null then return v_rule; end if;
		end if;
	end loop;
	return jsonb_build_object('ok', true);
end $$;

-- Called for an in-house run's units other than delete and move (the commit classes those as deletion). A new
-- agent (hire) and a change of its status are delegation (contract 5.6); so are a new group.md and any routine file
-- change, except a dynamic routine's own run deciding it: a new at, effort or reply, or its conclusion (contract
-- 16.3). Everything else is plain.
create or replace function public.qorpera_folder_structured_review_class(p_environment_id uuid, p_actor jsonb, p_unit jsonb,
	p_eff_path text, p_eff_to text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_file record; v_kind text; v_base jsonb; v_entry jsonb; v_entries jsonb := public.qorpera_company_state_entries(p_unit);
begin
	for v_file in select * from public.qorpera_company_state_unit_files(p_unit, p_eff_path) loop
		v_kind := public.qorpera_structured_path_kind(v_file.key);
		if v_kind is null then continue; end if;
		select v.structured -> 'parse' into v_base
		from public.qorpera_folder_entries e join public.qorpera_folder_path_versions v on v.version = e.version
		where e.environment_id = p_environment_id and e.key_sha256 = extensions.digest(v_file.key, 'sha256') and e.kind = 'file';
		v_entry := v_entries -> v_file.key;
		if v_kind = 'agent' and (v_base is null
			or v_base ->> 'status' is distinct from v_entry -> 'parse' ->> 'status') then return 'delegation'; end if;
		if v_kind = 'group' and v_base is null then return 'delegation'; end if;
		-- A dynamic routine's own run deciding it while the decision is owed: a new at, effort or reply, or its conclusion.
		-- A decision that also changes the title or the instructions is delegation, and so is every other routine change,
		-- including the run's changes after it decided or after another change settled the decision (contract 16.3).
		if v_kind = 'routine' and not coalesce(p_actor ->> 'wakeKind' = 'routine' and v_base ->> 'id' = p_actor ->> 'routineId'
			and v_entry -> 'parse' ->> 'id' = p_actor ->> 'routineId' and v_base -> 'trigger' ->> 'when' = 'once'
			and public.qorpera_company_state_routine_of_run((p_actor ->> 'runId')::uuid) = (p_actor ->> 'routineId')::uuid
			and public.qorpera_routine_decision_pending((p_actor ->> 'runId')::uuid)
			and ((v_entry -> 'parse' ->> 'status' = 'active' and v_entry -> 'parse' -> 'trigger' ->> 'when' = 'once'
					and (v_entry -> 'parse') - array['trigger','effort','reply'] = v_base - array['trigger','effort','reply'])
				or (v_entry -> 'parse' ->> 'status' = 'concluded'
					and (v_entry -> 'parse') - array['status','conclusion'] = v_base - array['status','conclusion'])), false) then
			return 'delegation'; end if;
	end loop;
	return 'plain';
end $$;

create or replace function public.qorpera_folder_structured_apply(p_environment_id uuid, p_commit_id uuid, p_unit_no integer,
	p_unit jsonb, p_eff_path text, p_eff_to text)
returns void language plpgsql security definer set search_path = '' as $$
declare
	v_op text := p_unit ->> 'op'; v_profile uuid; v_user uuid; v_file record; v_kind text; v_entry jsonb; v_version uuid;
	v_key text; v_staff record; v_room record; v_connection record; v_new_path text; v_actor jsonb; v_entries jsonb;
	v_routine record; v_owner uuid; v_next bigint; v_created timestamptz; v_commit public.qorpera_folder_commits%rowtype;
	v_moved public.qorpera_cloud_routine_versions%rowtype; v_pay record; v_waits boolean;
begin
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id;
	select jsonb_build_object('kind', c.actor_kind, 'requesterUserId', c.requester_id) into v_actor
	from public.qorpera_folder_commits c where c.id = p_commit_id;
	v_user := public.qorpera_company_state_actor_user(v_profile, case v_actor ->> 'kind'
		when 'member' then jsonb_build_object('kind', 'member', 'userId', v_actor ->> 'requesterUserId') else v_actor end);

	if v_op in ('write','new_folder') then
		v_entries := public.qorpera_company_state_entries(p_unit);
		-- Todos and routines last, so an agent the same unit brings is indexed before its todos and routines.
		for v_file in select f.* from public.qorpera_company_state_unit_files(p_unit, p_eff_path) f
			order by coalesce(public.qorpera_structured_path_kind(f.key) in ('todo','routine'), false) loop
			v_kind := public.qorpera_structured_path_kind(v_file.key);
			if v_kind is null then continue; end if;
			v_entry := v_entries -> v_file.key;
			update public.qorpera_folder_path_versions set structured = jsonb_build_object('kind', v_kind, 'parse', v_entry -> 'parse',
				'parserVersion', v_entry -> 'parserVersion')
			where commit_id = p_commit_id and unit_no = p_unit_no and key_sha256 = extensions.digest(v_file.key, 'sha256')
			returning version into v_version;
			if v_version is null then raise exception 'A structured file has no version in its commit' using errcode = 'XX000'; end if;
			if v_kind = 'vision' then
				insert into public.qorpera_folder_company_index(environment_id, profile_id, name, vision_path_version, vision_seeded, commit_id)
				values (p_environment_id, v_profile, v_entry -> 'parse' ->> 'name', v_version, v_actor ->> 'kind' = 'platform', p_commit_id)
				on conflict (environment_id) do update set name = excluded.name, vision_path_version = excluded.vision_path_version,
					vision_seeded = false, commit_id = excluded.commit_id, updated_at = clock_timestamp();
			elsif v_kind = 'agent' then
				perform public.qorpera_company_state_index_agent(p_environment_id, v_profile, p_commit_id, v_user, v_file.path,
					v_version, v_entry -> 'parse', v_actor);
			elsif v_kind = 'group' then
				perform public.qorpera_company_state_index_group(p_environment_id, v_profile, p_commit_id, v_user, v_file.path,
					v_version, v_entry -> 'parse');
			elsif v_kind = 'sections' then
				perform public.qorpera_company_state_index_sections(v_profile, v_user, v_entry -> 'parse');
			elsif v_kind = 'connection' then
				perform public.qorpera_company_state_index_connection(p_environment_id, v_profile, p_commit_id, v_file.path, v_version,
					v_entry -> 'parse');
			elsif v_kind = 'rule' then
				perform public.qorpera_company_state_index_rule(p_environment_id, v_profile, p_commit_id, v_user, v_file.path, v_version,
					v_entry -> 'parse');
			elsif v_kind = 'todo' then
				perform public.qorpera_company_state_index_todo(p_environment_id, v_profile, p_commit_id, v_file.path, v_version,
					v_entry -> 'parse');
			elsif v_kind = 'routine' then
				perform public.qorpera_company_state_index_routine(p_environment_id, v_profile, p_commit_id, v_file.path, v_version,
					v_entry -> 'parse');
			end if;
		end loop;
		return;
	end if;

	if v_op = 'move' then
		-- Moved structured files keep their parse on their new versions.
		update public.qorpera_folder_path_versions v set structured = p.structured
		from public.qorpera_folder_path_versions p
		where v.commit_id = p_commit_id and v.unit_no = p_unit_no and v.op = 'move_in' and v.prior_version = p.version
			and p.structured is not null;
		-- The roster and the group chats follow their folders: a rename keeps the id, and so the thread and history.
		v_key := public.qorpera_folder_key(p_eff_path);
		for v_staff in select s.staff_agent_id, s.folder_path from public.qorpera_profile_staff s
			where s.profile_id = v_profile and s.folder_environment_id = p_environment_id and s.folder_retired_at is null
				and s.deleted_at is null
				and (public.qorpera_folder_key(s.folder_path) = v_key
					or public.qorpera_folder_key(s.folder_path) like public.qorpera_folder_under(v_key))
		loop
			v_new_path := p_eff_to || substr(v_staff.folder_path, char_length(p_eff_path) + 1);
			select version into v_version from public.qorpera_folder_path_versions
			where commit_id = p_commit_id and unit_no = p_unit_no and op = 'move_in'
				and key_sha256 = extensions.digest(public.qorpera_folder_key(v_new_path), 'sha256');
			if v_version is null then raise exception 'A moved agent.md has no version in its commit' using errcode = 'XX000'; end if;
			update public.qorpera_profile_staff set folder_path = (select e.path from public.qorpera_folder_entries e
					where e.environment_id = p_environment_id
						and e.key_sha256 = extensions.digest(public.qorpera_folder_key(v_new_path), 'sha256')),
				folder_path_version = v_version, folder_commit_id = p_commit_id, version = version + 1,
				updated_at = greatest(clock_timestamp(), created_at), updated_by_user_id = v_user
			where profile_id = v_profile and staff_agent_id = v_staff.staff_agent_id;
		end loop;
		for v_room in select r.id, r.folder_path from public.qorpera_company_rooms r
			where r.folder_environment_id = p_environment_id and r.folder_path is not null and r.folder_retired_at is null
				and (public.qorpera_folder_key(r.folder_path) = v_key
					or public.qorpera_folder_key(r.folder_path) like public.qorpera_folder_under(v_key))
		loop
			v_new_path := p_eff_to || substr(v_room.folder_path, char_length(p_eff_path) + 1);
			select version into v_version from public.qorpera_folder_path_versions
			where commit_id = p_commit_id and unit_no = p_unit_no and op = 'move_in'
				and key_sha256 = extensions.digest(public.qorpera_folder_key(v_new_path), 'sha256');
			if v_version is null then raise exception 'A moved group.md has no version in its commit' using errcode = 'XX000'; end if;
			update public.qorpera_company_rooms set folder_path = (select e.path from public.qorpera_folder_entries e
					where e.environment_id = p_environment_id
						and e.key_sha256 = extensions.digest(public.qorpera_folder_key(v_new_path), 'sha256')),
				folder_path_version = v_version, folder_commit_id = p_commit_id, version = version + 1, updated_at = clock_timestamp()
			where id = v_room.id;
		end loop;
		-- Connection files follow their path; the vault row is never touched.
		for v_connection in select i.secret_id, i.folder_path from public.qorpera_folder_connection_index i
			where i.environment_id = p_environment_id and i.retired_at is null
				and (public.qorpera_folder_key(i.folder_path) = v_key
					or public.qorpera_folder_key(i.folder_path) like public.qorpera_folder_under(v_key))
		loop
			v_new_path := p_eff_to || substr(v_connection.folder_path, char_length(p_eff_path) + 1);
			select version into v_version from public.qorpera_folder_path_versions
			where commit_id = p_commit_id and unit_no = p_unit_no and op = 'move_in'
				and key_sha256 = extensions.digest(public.qorpera_folder_key(v_new_path), 'sha256');
			if v_version is null then raise exception 'A moved connection file has no version in its commit' using errcode = 'XX000'; end if;
			update public.qorpera_folder_connection_index set folder_path = (select e.path from public.qorpera_folder_entries e
					where e.environment_id = p_environment_id
						and e.key_sha256 = extensions.digest(public.qorpera_folder_key(v_new_path), 'sha256')),
				folder_path_version = v_version, commit_id = p_commit_id, updated_at = clock_timestamp()
			where secret_id = v_connection.secret_id;
		end loop;
		-- Rule files follow their path; the rule keeps its id, so review records still cite it.
		for v_connection in select r.id, r.folder_path from public.qorpera_review_rules r
			where r.profile_id = v_profile and r.folder_environment_id = p_environment_id and r.archived_at is null
				and (public.qorpera_folder_key(r.folder_path) = v_key
					or public.qorpera_folder_key(r.folder_path) like public.qorpera_folder_under(v_key))
		loop
			v_new_path := p_eff_to || substr(v_connection.folder_path, char_length(p_eff_path) + 1);
			select version into v_version from public.qorpera_folder_path_versions
			where commit_id = p_commit_id and unit_no = p_unit_no and op = 'move_in'
				and key_sha256 = extensions.digest(public.qorpera_folder_key(v_new_path), 'sha256');
			if v_version is null then raise exception 'A moved rule file has no version in its commit' using errcode = 'XX000'; end if;
			update public.qorpera_review_rules set folder_path = (select e.path from public.qorpera_folder_entries e
					where e.environment_id = p_environment_id
						and e.key_sha256 = extensions.digest(public.qorpera_folder_key(v_new_path), 'sha256')),
				folder_path_version = v_version, folder_commit_id = p_commit_id, updated_at = clock_timestamp()
			where id = v_connection.id;
		end loop;
		-- Todo files follow their path: a new name is the new key, and a new agent folder the new owner (read after the
		-- roster rows above were repointed).
		for v_connection in select t.id, t.folder_path from public.qorpera_runtime_agent_todos t
			where t.profile_id = v_profile and t.folder_environment_id = p_environment_id and t.folder_retired_at is null
				and (t.folder_path = v_key collate "C"
					or (t.folder_path > (v_key || '/') collate "C" and t.folder_path < (v_key || '0') collate "C"))
		loop
			v_new_path := p_eff_to || substr(v_connection.folder_path, char_length(p_eff_path) + 1);
			select version into v_version from public.qorpera_folder_path_versions
			where commit_id = p_commit_id and unit_no = p_unit_no and op = 'move_in'
				and key_sha256 = extensions.digest(public.qorpera_folder_key(v_new_path), 'sha256');
			if v_version is null then raise exception 'A moved todo file has no version in its commit' using errcode = 'XX000'; end if;
			v_new_path := (select e.path from public.qorpera_folder_entries e where e.environment_id = p_environment_id
				and e.key_sha256 = extensions.digest(public.qorpera_folder_key(v_new_path), 'sha256'));
			update public.qorpera_runtime_agent_todos set folder_path = v_new_path, folder_path_version = v_version,
				folder_commit_id = p_commit_id, todo_key = public.qorpera_company_state_todo_key(v_new_path),
				staff_agent_id = public.qorpera_company_state_todo_owner(p_environment_id, public.qorpera_folder_key(v_new_path)),
				revision = revision + 1, updated_at = clock_timestamp()
			where id = v_connection.id;
		end loop;
		-- Routine files follow their path: a new name is the new key, and a new agent folder the new owner (read after the
		-- roster rows above were repointed), whose runs the routine then makes: a version like the last one with the new
		-- agent, paid by the mover's login (S2), at its schedule position; without a paying login it waits for one.
		select * into v_commit from public.qorpera_folder_commits where id = p_commit_id;
		for v_routine in select r.id, r.folder_path, r.current_version, r.status from public.qorpera_cloud_routines r
			where r.profile_id = v_profile and r.folder_environment_id = p_environment_id and r.folder_retired_at is null
				and (r.folder_path = v_key collate "C"
					or (r.folder_path > (v_key || '/') collate "C" and r.folder_path < (v_key || '0') collate "C"))
		loop
			v_new_path := p_eff_to || substr(v_routine.folder_path, char_length(p_eff_path) + 1);
			select version into v_version from public.qorpera_folder_path_versions
			where commit_id = p_commit_id and unit_no = p_unit_no and op = 'move_in'
				and key_sha256 = extensions.digest(public.qorpera_folder_key(v_new_path), 'sha256');
			if v_version is null then raise exception 'A moved routine file has no version in its commit' using errcode = 'XX000'; end if;
			v_new_path := (select e.path from public.qorpera_folder_entries e where e.environment_id = p_environment_id
				and e.key_sha256 = extensions.digest(public.qorpera_folder_key(v_new_path), 'sha256'));
			v_owner := public.qorpera_company_state_routine_owner(p_environment_id, public.qorpera_folder_key(v_new_path));
			v_next := v_routine.current_version; v_waits := false;
			select * into v_moved from public.qorpera_cloud_routine_versions cv
			where cv.routine_id = v_routine.id and cv.version = v_routine.current_version;
			if v_moved.staff_agent_id is distinct from v_owner then
				select * into v_pay from public.qorpera_company_state_routine_saver_pays(v_commit, v_profile, v_moved);
				if v_pay.binding_id is null then raise exception 'A routine version has no login to pin' using errcode = 'XX000'; end if;
				v_waits := not v_pay.paid and v_routine.status = 'active';
				v_next := v_routine.current_version + 1;
				insert into public.qorpera_cloud_routine_versions(routine_id, version, client_version_id, profile_id, environment_id,
					staff_agent_id, title, prompt, triggers, effort, sponsor_binding_id, sponsor_version, content_sha256, created_by_user_id)
				values (v_routine.id, v_next, extensions.gen_random_uuid(), v_moved.profile_id, v_moved.environment_id, v_owner,
					v_moved.title, v_moved.prompt, v_moved.triggers, v_moved.effort, v_pay.binding_id, v_pay.version,
					public.qorpera_company_state_routine_sha(v_owner, v_moved.title, v_moved.prompt, v_moved.triggers, v_moved.effort,
						v_pay.binding_id, v_pay.version), v_pay.user_id)
				returning created_at into v_created;
				insert into public.qorpera_cloud_routine_schedule_cursors(routine_id, routine_version, trigger_id, last_scheduled_for,
					next_due_at)
				select v_routine.id, v_next, t.value ->> 'id', position.last_scheduled_for, position.next_due_at
				from jsonb_array_elements(v_moved.triggers) t(value)
				cross join lateral public.qorpera_routine_version_schedule_position(v_routine.id, v_routine.current_version, t.value,
					v_created, v_routine.status = 'active', v_routine.status = 'active' and not v_waits) position
				where t.value ->> 'kind' = 'schedule';
			end if;
			update public.qorpera_cloud_routines set folder_path = v_new_path, folder_path_version = v_version,
				folder_commit_id = p_commit_id, routine_key = public.qorpera_company_state_todo_key(v_new_path),
				owner_staff_agent_id = v_owner, current_version = v_next,
				status = case when v_waits then 'paused' else status end,
				pause_reason = case when v_waits then 'needs_model_account' else pause_reason end, updated_at = statement_timestamp()
			where id = v_routine.id;
		end loop;
		return;
	end if;

	if v_op = 'delete' then
		-- Deleting an agent's folder retires it: its runs are fenced (archived), its conversations stay, and a restore
		-- of the folder brings the row back.
		v_key := public.qorpera_folder_key(p_eff_path);
		for v_staff in select s.staff_agent_id, s.employment_status from public.qorpera_profile_staff s
			where s.profile_id = v_profile and s.folder_environment_id = p_environment_id and s.folder_retired_at is null
				and s.deleted_at is null
				and (public.qorpera_folder_key(s.folder_path) = v_key
					or public.qorpera_folder_key(s.folder_path) like public.qorpera_folder_under(v_key))
		loop
			update public.qorpera_profile_staff set folder_retired_at = clock_timestamp(), folder_commit_id = p_commit_id,
				version = version + 1, updated_at = greatest(clock_timestamp(), created_at), updated_by_user_id = v_user
			where profile_id = v_profile and staff_agent_id = v_staff.staff_agent_id;
			if v_staff.employment_status = 'active' then
				update public.qorpera_profile_staff set employment_status = 'archived'
				where profile_id = v_profile and staff_agent_id = v_staff.staff_agent_id;
			end if;
		end loop;
		-- Deleting a group chat's folder closes the chat; its conversation stays, and a restore reopens both.
		for v_room in select r.id, r.session_id from public.qorpera_company_rooms r
			where r.folder_environment_id = p_environment_id and r.folder_path is not null and r.folder_retired_at is null
				and (public.qorpera_folder_key(r.folder_path) = v_key
					or public.qorpera_folder_key(r.folder_path) like public.qorpera_folder_under(v_key))
		loop
			update public.qorpera_company_rooms set status = 'archived', folder_retired_at = clock_timestamp(),
				folder_commit_id = p_commit_id, version = version + 1, updated_at = clock_timestamp()
			where id = v_room.id;
			update public.qorpera_shared_sessions set status = 'closed', updated_at = statement_timestamp()
			where id = v_room.session_id and status <> 'closed';
		end loop;
		-- A connection's file removed (after its account was disconnected): its index row retires.
		update public.qorpera_folder_connection_index i set retired_at = clock_timestamp(), commit_id = p_commit_id, updated_at = clock_timestamp()
		where i.environment_id = p_environment_id and i.retired_at is null
			and (public.qorpera_folder_key(i.folder_path) = v_key
				or public.qorpera_folder_key(i.folder_path) like public.qorpera_folder_under(v_key));
		-- A todo file removed: an open or blocked todo is cancelled, the row retires, and its key becomes a tombstone with a
		-- '.' (no file name has one) and the whole id, so a new file of that name is free and two tombstones never meet; a
		-- restore brings the key back.
		update public.qorpera_runtime_agent_todos t set folder_retired_at = clock_timestamp(), folder_commit_id = p_commit_id,
			state = case when t.state in ('open','blocked') then 'cancelled' else t.state end,
			todo_key = left(t.todo_key, 31) || '.' || replace(t.id::text, '-', ''),
			revision = t.revision + 1, updated_at = clock_timestamp()
		where t.profile_id = v_profile and t.folder_environment_id = p_environment_id and t.folder_retired_at is null
			and (t.folder_path = v_key collate "C"
				or (t.folder_path > (v_key || '/') collate "C" and t.folder_path < (v_key || '0') collate "C"));
		-- A routine file removed: the routine retires (its runs and history stay), and its key becomes a tombstone as a
		-- todo's does; a restore brings both back.
		update public.qorpera_cloud_routines r set status = 'retired', folder_retired_at = clock_timestamp(),
			folder_commit_id = p_commit_id, routine_key = left(r.routine_key, 31) || '.' || replace(r.id::text, '-', ''),
			updated_at = statement_timestamp()
		where r.profile_id = v_profile and r.folder_environment_id = p_environment_id and r.folder_retired_at is null
			and (r.folder_path = v_key collate "C"
				or (r.folder_path > (v_key || '/') collate "C" and r.folder_path < (v_key || '0') collate "C"));
		-- A rule file removed: the rule is archived (review records keep citing it); a restore brings it back.
		update public.qorpera_review_rules r set archived_at = clock_timestamp(), folder_commit_id = p_commit_id, updated_at = clock_timestamp()
		where r.profile_id = v_profile and r.folder_environment_id = p_environment_id and r.archived_at is null
			and (public.qorpera_folder_key(r.folder_path) = v_key
				or public.qorpera_folder_key(r.folder_path) like public.qorpera_folder_under(v_key));
	end if;
end $$;

create or replace function public.qorpera_folder_structured_verify(p_environment_id uuid, p_commit_id uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
	if exists (select 1 from public.qorpera_profile_staff s
		where s.folder_environment_id = p_environment_id and s.folder_path is not null and s.folder_commit_id = p_commit_id
			and s.folder_retired_at is null
			and s.deleted_at is null and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
				and e.key_sha256 = extensions.digest(public.qorpera_folder_key(s.folder_path), 'sha256')
				and e.version = s.folder_path_version and e.path = s.folder_path))
		or exists (select 1 from public.qorpera_company_rooms r
			where r.folder_environment_id = p_environment_id and r.folder_path is not null and r.folder_commit_id = p_commit_id
				and r.folder_retired_at is null
				and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.key_sha256 = extensions.digest(public.qorpera_folder_key(r.folder_path), 'sha256')
					and e.version = r.folder_path_version and e.path = r.folder_path))
		or exists (select 1 from public.qorpera_folder_connection_index c
			where c.environment_id = p_environment_id and c.commit_id = p_commit_id and c.retired_at is null
				and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.key_sha256 = extensions.digest(public.qorpera_folder_key(c.folder_path), 'sha256')
					and e.version = c.folder_path_version and e.path = c.folder_path))
		or exists (select 1 from public.qorpera_review_rules r
			where r.folder_environment_id = p_environment_id and r.folder_path is not null and r.folder_commit_id = p_commit_id
				and r.archived_at is null
				and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.key_sha256 = extensions.digest(public.qorpera_folder_key(r.folder_path), 'sha256')
					and e.version = r.folder_path_version and e.path = r.folder_path))
		or exists (select 1 from public.qorpera_runtime_agent_todos t
			where t.folder_environment_id = p_environment_id and t.folder_path is not null and t.folder_commit_id = p_commit_id
				and t.folder_retired_at is null
				and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.key_sha256 = extensions.digest(public.qorpera_folder_key(t.folder_path), 'sha256')
					and e.version = t.folder_path_version and e.path = t.folder_path))
		or exists (select 1 from public.qorpera_cloud_routines r
			where r.folder_environment_id = p_environment_id and r.folder_path is not null and r.folder_commit_id = p_commit_id
				and r.folder_retired_at is null
				and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.key_sha256 = extensions.digest(public.qorpera_folder_key(r.folder_path), 'sha256')
					and e.version = r.folder_path_version and e.path = r.folder_path))
		or exists (select 1 from public.qorpera_folder_company_index i
			where i.environment_id = p_environment_id and i.commit_id = p_commit_id
				and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.key_sha256 = extensions.digest('vision/vision.md', 'sha256') and e.version = i.vision_path_version)) then
		raise exception 'A structured index row does not point at its file''s current version' using errcode = 'XX000';
	end if;
end $$;

-- 5. The member RPC on folder-v2 ------------------------------------------------------------------------------------

-- A folder-v2 company's routines live in agents/<handle>/routines/: the member RPC refuses a new routine and a file's
-- routine. A routine saved as a row before the company became folder-v2 can still be saved (and so paused) there.
do $$
declare v_definition text;
	v_old constant text := $old$		raise exception 'cloud routine requires authorize access' using errcode = '42501';
	end if;$old$;
	v_new constant text := $new$		raise exception 'cloud routine requires authorize access' using errcode = '42501';
	end if;
	if exists (select 1 from public.qorpera_company_files f where f.profile_id = v_profile_id and f.core = 'folder-v2')
		and not exists (select 1 from public.qorpera_cloud_routines r
			where r.profile_id = v_profile_id and r.client_routine_id = p_client_routine_id and r.folder_path is null) then
		raise exception 'This company keeps its routines in its agents'' routines folders; edit those files' using errcode = '55000';
	end if;$new$;
begin
	v_definition := pg_get_functiondef(
		'public.qorpera_upsert_cloud_routine(uuid,uuid,uuid,uuid,text,text,jsonb,text,uuid,bigint,uuid,text,text,boolean,text,text,uuid[])'::regprocedure);
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Routine save guard anchor differs'; end if;
	execute replace(v_definition, v_old, v_new);
end
$$;

-- The agent tools refuse on a folder-v2 company: its agents write routine files, and the runtime's writers of them come
-- with F2-1b. Before the run's other checks, so nothing is recorded.
do $$
declare v_definition text; v_target regprocedure;
	v_old constant text := $old$	v_run := public.qorpera_native_tool_locked_run(p_binding);
$old$;
	v_new constant text := $new$	v_run := public.qorpera_native_tool_locked_run(p_binding);
	if exists (select 1 from public.qorpera_company_files f where f.profile_id = v_run.profile_id and f.core = 'folder-v2') then
		raise exception 'This company keeps its routines in its agents'' routines folders; write the routine''s file'
			using errcode = '55000'; end if;
$new$;
begin
	foreach v_target in array array['public.qorpera_manage_agent_routine(jsonb,jsonb)'::regprocedure,
		'public.qorpera_decide_agent_routine(jsonb,jsonb)'::regprocedure] loop
		v_definition := pg_get_functiondef(v_target);
		if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
			raise exception 'Routine tool guard anchor differs: %', v_target; end if;
		execute replace(v_definition, v_old, v_new);
	end loop;
end
$$;

-- 6. Grants ------------------------------------------------------------------------------------------------------------

revoke all on function public.qorpera_company_state_instant(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_company_state_routine_owner(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_company_state_routine_trigger(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_company_state_routine_same(public.qorpera_cloud_routine_versions, uuid, jsonb, jsonb)
	from public, anon, authenticated, service_role;
revoke all on function public.qorpera_company_state_routine_sha(uuid, text, text, jsonb, text, uuid, bigint)
	from public, anon, authenticated, service_role;
revoke all on function public.qorpera_company_state_routine_payer(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_company_state_routine_paid(public.qorpera_cloud_routine_versions)
	from public, anon, authenticated, service_role;
revoke all on function public.qorpera_company_state_routine_of_run(uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_company_state_routine_restarts(public.qorpera_cloud_routines, jsonb, jsonb)
	from public, anon, authenticated, service_role;
revoke all on function public.qorpera_company_state_routine_saver_pays(public.qorpera_folder_commits, uuid,
	public.qorpera_cloud_routine_versions) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_company_state_routine_rules(uuid, uuid, jsonb, text, jsonb, boolean)
	from public, anon, authenticated, service_role;
revoke all on function public.qorpera_company_state_index_routine(uuid, uuid, uuid, text, uuid, jsonb)
	from public, anon, authenticated, service_role;
