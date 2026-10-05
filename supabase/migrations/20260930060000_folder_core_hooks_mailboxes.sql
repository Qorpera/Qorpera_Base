-- Company folder core, C4 (E1, Q1): hooks and mailboxes on folder-v2, each described by a connection file
-- (deploy/first-node/RUNTIME-COMPANY-FOLDER-EVENTS.md §3; agreed with the coordinator, A1 and F2 on 4 October 2026).
--
-- Until now creating a hook or a mailbox refused every folder-v2 company (0A000, "… come with their connection file"),
-- and since 3 October every company is folder-v2. The database stays the authority for a hook: its address, proof,
-- limits, status and delivery receipts (contract events amendment, item 2). The company folder describes each hook in
-- connections/hook-<name>.md and each mailbox in connections/mailbox-<name>.md, converged by P22's writer after the
-- change commits, as the vault's account files are (core §3: no change waits for, or fails on, a file).
-- * Two structured kinds, hook and mailbox, at those two prefixes of connections/ (before a vault connection's), so a
--   vault file can never take either prefix: a move from one to the other is a kind change, which the folder refuses,
--   and the vault's file names skip them. Their settings are the platform's (hook: id, name, proof, status,
--   max_body_bytes, per_minute, created_by, created_at; mailbox: id, address, status, created_by, created_at); the body
--   is the company's. A file never shows a hook's address (a capability) or a signing secret.
-- * qorpera_folder_hook_index, one row per hook or mailbox file, in the human-task index's style; rules (the platform
--   writes the settings to match the hook, everyone else only the body; one file per hook; only the platform removes a
--   file, once its hook is removed); apply writes, repoints and retires the rows; verify checks them; erasure removes
--   retired rows under its roots, as it does the table index's.
-- * P22's marks and work gain subject_kind ('vault', 'hook' or 'mailbox'), part of the work row's key (A1): the claim
--   reads the state by kind (qorpera_folder_hook_file_state for a hook or a mailbox), never by "no secret has this id".
--   P22a's invariants stay: a mark is a plain insert that waits on nothing, and the claim never touches a hook row.
--   Triggers on qorpera_event_hooks mark a folder-v2 hook due when a field its file shows changes, and a new mail domain
--   marks every folder-v2 mailbox (its file shows its address).
-- * A unit that writes a hook's or a mailbox's file takes the hook FOR SHARE at rank 5, so a removal and a file write
--   serialize: either the removal waits for the write and the next claim deletes the file, or the write sees the hook
--   removed and is refused.
-- * Creating a hook or a mailbox, and pausing, resuming or removing one, get a folder-v2 branch in core §3's order: the
--   fence and the company row KEY SHARE and the member at rank 1 (qorpera_folder_company_enter), the hook row FOR NO KEY
--   UPDATE at rank 5 (qorpera_event_hooks joins the structured lock last, where E2's routine saves will take it FOR
--   SHARE), and for a creation a per-company advisory lock, taken last, for the caps the company row lock used to
--   serialize. The snapshot-v1 path is unchanged.
-- Every inserted text names this migration (20260930060000), for the deploy guards.

do $$ begin
	if to_regclass('public.qorpera_folder_hook_index') is not null then
		raise exception 'E1 (20260930060000) is already applied'; end if;
end $$;

set local lock_timeout = '3s';

create function pg_temp.e1_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'E1 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. Where the files sit -------------------------------------------------------------------------------------------------

select pg_temp.e1_replace('public.qorpera_structured_path_kind(text)'::regprocedure,
	$old$		when p_key ~ '^connections/[^/]*\.md$' then 'connection'$old$,
	$new$		-- 20260930060000 (E1): a hook's and a mailbox's files, before the vault's.
		when p_key ~ '^connections/hook-[^/]*\.md$' then 'hook'
		when p_key ~ '^connections/mailbox-[^/]*\.md$' then 'mailbox'
		when p_key ~ '^connections/[^/]*\.md$' then 'connection'$new$);

select pg_temp.e1_replace('public.qorpera_company_state_path_problems(text,boolean)'::regprocedure,
	$old$		elsif v_kind in ('rule','connection','human-task','contact') then -- 20260929999000 (H1)$old$,
	$new$		elsif v_kind in ('rule','connection','hook','mailbox','human-task','contact') then -- H1; 20260930060000 (E1)$new$);

-- 2. The index ---------------------------------------------------------------------------------------------------------

create table public.qorpera_folder_hook_index (
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	-- The hook's id (qorpera_event_hooks.id); a mailbox's file names its hook's.
	id uuid not null,
	-- No foreign key to qorpera_profiles: its KEY SHARE would come in apply, after the paths (as the connection index).
	profile_id uuid not null,
	kind text not null check (kind in ('hook','mailbox')),
	folder_path text collate "C" not null,
	folder_key text collate "C" not null,
	folder_path_version uuid not null,
	commit_id uuid not null,
	retired_at timestamptz,
	updated_at timestamptz not null default clock_timestamp(),
	primary key (environment_id, id)
);
-- Not unique, so apply's update of a row never needs more than the row.
create index qorpera_folder_hook_index_key on public.qorpera_folder_hook_index(environment_id, folder_key);
alter table public.qorpera_folder_hook_index enable row level security;
revoke all on public.qorpera_folder_hook_index from public, anon, authenticated, service_role;
grant select on public.qorpera_folder_hook_index to service_role;
comment on table public.qorpera_folder_hook_index is
	'E1: one row per hook or mailbox file (connections/hook-<n>.md, connections/mailbox-<n>.md), an index of the company folder.';

-- 3. What a file says --------------------------------------------------------------------------------------------------

-- The settings a hook's or a mailbox's file should show, from the hook's current rows (plain reads): `present` false for a
-- removed or missing hook, one of the other kind, a mailbox without its row or the mail domain, or a company not on
-- folder-v2; otherwise the settings by an allow-list (never the address of a hook, never a secret), `path`, the name a new
-- file takes, `body`, the purpose a new file starts with, and `current`, the file the index points at, if any.
create function public.qorpera_folder_hook_file_state(p_kind text, p_hook_id uuid, p_environment_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_hook public.qorpera_event_hooks%rowtype; v_box public.qorpera_company_mailboxes%rowtype; v_domain text;
	v_present boolean; v_settings jsonb; v_name text; v_path text; v_current jsonb;
begin
	-- 20260930060000 (E1): the allow-list of a hook's and a mailbox's file; nothing else of the hook's rows leaves.
	if p_kind is null or p_kind not in ('hook','mailbox') then
		raise exception 'Hook file kind is invalid' using errcode = '22023'; end if;
	select hook.* into v_hook from public.qorpera_event_hooks as hook where hook.id = p_hook_id;
	if p_kind = 'mailbox' then
		select box.* into v_box from public.qorpera_company_mailboxes as box where box.hook_id = p_hook_id;
		select settings.domain into v_domain from public.qorpera_mail_settings as settings;
	end if;
	v_present := v_hook.id is not null and v_hook.environment_id = p_environment_id and v_hook.status in ('active','paused')
		and (v_hook.proof = 'mail') = (p_kind = 'mailbox')
		and public.qorpera_environment_is_folder_v2(v_hook.environment_id)
		and (p_kind = 'hook' or (v_box.id is not null and v_box.removed_at is null and v_domain is not null));
	if v_present then
		if p_kind = 'hook' then
			v_settings := jsonb_build_object('id', v_hook.id, 'name', v_hook.name, 'proof', v_hook.proof, 'status', v_hook.status,
				'maxBodyBytes', v_hook.max_body_bytes, 'perMinute', v_hook.per_minute,
				'createdBy', coalesce(v_hook.created_by_user_id, v_hook.created_by_staff_agent_id),
				'createdAt', public.qorpera_company_state_instant_text(v_hook.created_at));
			v_name := v_hook.name;
		else
			v_settings := jsonb_build_object('id', v_hook.id, 'address', v_box.local_part || '@' || v_domain,
				'status', v_hook.status,
				'createdBy', coalesce(v_box.created_by_user_id, v_hook.created_by_user_id, v_hook.created_by_staff_agent_id),
				'createdAt', public.qorpera_company_state_instant_text(v_box.created_at));
			v_name := v_box.local_part;
		end if;
		-- The folder's name rule (lowercase letters, digits and single hyphens, at most 64 characters with the prefix). The
		-- writer adds -2, -3 … when the commit answers that the name is taken.
		v_name := btrim(regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'), '-');
		v_name := p_kind || '-' || coalesce(nullif(rtrim(left(v_name, 63 - char_length(p_kind)), '-'), ''), 'x');
		v_path := 'connections/' || v_name || '.md';
	end if;
	select jsonb_build_object('path', entry.path, 'version', entry.version, 'manifestSha256', entry.manifest_sha256,
		'fileSha256', entry.file_sha256, 'bytes', entry.bytes, 'mediaType', entry.media_type)
	into v_current
	from public.qorpera_folder_hook_index as index_row
	join public.qorpera_folder_entries as entry on entry.environment_id = index_row.environment_id
		and entry.key_sha256 = extensions.digest(index_row.folder_key, 'sha256') and entry.kind = 'file'
	where index_row.environment_id = p_environment_id and index_row.id = p_hook_id and index_row.retired_at is null;
	return jsonb_build_object('present', coalesce(v_present, false), 'settings', v_settings, 'path', v_path,
		'body', case when v_present then v_hook.purpose end, 'current', v_current);
end $$;
revoke all on function public.qorpera_folder_hook_file_state(text, uuid, uuid) from public, anon, authenticated, service_role;

-- The parse's shape (the parser's own, checked again here).
select pg_temp.e1_replace('public.qorpera_company_state_parse_problems(text,jsonb)'::regprocedure,
	$old$	if cardinality(v_bad) = 0 and v_named is null then return '[]'::jsonb; end if;$old$,
	$new$	-- 20260930060000 (E1): a hook's and a mailbox's file.
	if p_kind = 'hook' then
		if (select array_agg(k order by k collate "C") from jsonb_object_keys(p_parse) k) is distinct from
			array['createdAt','createdBy','id','kind','maxBodyBytes','name','perMinute','proof','purpose','status'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if jsonb_typeof(p_parse -> 'name') is distinct from 'string' or (p_parse ->> 'name') !~ '^[a-z][a-z0-9-]{0,63}$' then
			v_bad := array_append(v_bad, 'name'); end if;
		if coalesce(p_parse ->> 'proof', '') not in ('address','stripe','github','hmac-sha256') then
			v_bad := array_append(v_bad, 'proof'); end if;
		if jsonb_typeof(p_parse -> 'maxBodyBytes') is distinct from 'number' or (p_parse ->> 'maxBodyBytes') !~ '^[0-9]{4,6}$'
			or (p_parse ->> 'maxBodyBytes')::integer not between 1024 and 262144 then
			v_bad := array_append(v_bad, 'maxBodyBytes'); end if;
		if jsonb_typeof(p_parse -> 'perMinute') is distinct from 'number' or (p_parse ->> 'perMinute') !~ '^[0-9]{1,3}$'
			or (p_parse ->> 'perMinute')::integer not between 1 and 120 then
			v_bad := array_append(v_bad, 'perMinute'); end if;
	elsif p_kind = 'mailbox' then
		if (select array_agg(k order by k collate "C") from jsonb_object_keys(p_parse) k) is distinct from
			array['address','createdAt','createdBy','id','kind','purpose','status'] then
			v_bad := array_append(v_bad, 'keys'); end if;
		if not public.qorpera_company_state_one_line(p_parse -> 'address', 3, 254, true)
			or (p_parse ->> 'address') !~ '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?@[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$' then
			v_bad := array_append(v_bad, 'address'); end if;
	end if;
	if p_kind in ('hook','mailbox') then
		if coalesce(p_parse ->> 'id', '') !~ c_uuid then v_bad := array_append(v_bad, 'id'); end if;
		if coalesce(p_parse ->> 'status', '') not in ('active','paused') then v_bad := array_append(v_bad, 'status'); end if;
		if coalesce(p_parse ->> 'createdBy', '') !~ c_uuid then v_bad := array_append(v_bad, 'createdBy'); end if;
		if jsonb_typeof(p_parse -> 'createdAt') is distinct from 'string'
			or (p_parse ->> 'createdAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{0,5}[1-9])?Z$' then
			v_bad := array_append(v_bad, 'createdAt');
		else
			begin
				perform (p_parse ->> 'createdAt')::timestamptz;
			exception when others then v_bad := array_append(v_bad, 'createdAt');
			end;
		end if;
		if jsonb_typeof(p_parse -> 'purpose') is distinct from 'string' or octet_length(p_parse ->> 'purpose') > 32768
			or (p_parse ->> 'purpose') <> btrim(p_parse ->> 'purpose', E' \t\n\r') then
			v_bad := array_append(v_bad, 'purpose'); end if;
	end if;
	if cardinality(v_bad) = 0 and v_named is null then return '[]'::jsonb; end if;$new$);

select pg_temp.e1_replace('public.qorpera_company_state_checked(jsonb,text,text,jsonb)'::regprocedure,
	$old$'connection','rule',$old$,
	$new$'connection','hook','mailbox' /* 20260930060000 (E1) */,'rule',$new$);

-- 4. The rules ---------------------------------------------------------------------------------------------------------

-- The database rules for one hook or mailbox file. Returns a refusal or null.
create function public.qorpera_company_state_hook_rules(p_environment_id uuid, p_profile_id uuid, p_actor jsonb, p_key text,
	p_kind text, p_parse jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
	v_id uuid := (p_parse ->> 'id')::uuid; v_row public.qorpera_folder_hook_index; v_at public.qorpera_folder_hook_index;
	v_base jsonb; v_hook public.qorpera_event_hooks%rowtype; v_state jsonb; v_problem text;
	v_what text := case when p_kind = 'mailbox' then 'mailbox' else 'hook' end;
begin
	-- 20260930060000 (E1).
	select * into v_row from public.qorpera_folder_hook_index i where i.environment_id = p_environment_id and i.id = v_id;
	select * into v_at from public.qorpera_folder_hook_index i
	where i.environment_id = p_environment_id and i.retired_at is null and i.folder_key = p_key;
	-- The file's last parse, trusted only through the index: a file saved before E1 was never checked.
	if v_at.id is not null then
		select v.structured -> 'parse' into v_base from public.qorpera_folder_path_versions v where v.version = v_at.folder_path_version;
	end if;
	select hook.* into v_hook from public.qorpera_event_hooks as hook where hook.id = v_id;
	if v_at.id is not null and v_at.id <> v_id then
		v_problem := 'id never changes; it is ' || v_at.id;
	elsif v_hook.id is null or v_hook.profile_id is distinct from p_profile_id
		or v_hook.environment_id is distinct from p_environment_id or (v_hook.proof = 'mail') <> (p_kind = 'mailbox') then
		v_problem := 'no ' || v_what || ' of this company has the id ' || (p_parse ->> 'id');
	elsif v_row.id is not null and v_row.retired_at is null and v_row.folder_key <> p_key then
		v_problem := 'this ' || v_what || ' already has the file ' || left(v_row.folder_path, 100);
	elsif p_actor ->> 'kind' is distinct from 'platform' then
		if v_base is null or (v_base - 'purpose') <> (p_parse - 'purpose') then
			v_problem := 'the settings of a ' || v_what || ' are the platform''s; change only the text below them'; end if;
	else
		v_state := public.qorpera_folder_hook_file_state(p_kind, v_id, p_environment_id);
		if not (v_state ->> 'present')::boolean or (v_state -> 'settings') <> (p_parse - array['kind','purpose']) then
			v_problem := 'the settings must match the ' || v_what; end if;
	end if;
	if v_problem is null then return null; end if;
	return jsonb_build_object('ok', false, 'reason', 'structured_rule',
		'problems', jsonb_build_array(public.qorpera_company_state_problem('value', null, null, v_problem)));
end $$;
revoke all on function public.qorpera_company_state_hook_rules(uuid, uuid, jsonb, text, text, jsonb)
	from public, anon, authenticated, service_role;

-- The index writer. A row is free to move when it is retired (a restore) or already at this key.
create function public.qorpera_company_state_index_hook(p_environment_id uuid, p_profile_id uuid, p_commit_id uuid,
	p_path text, p_version uuid, p_kind text, p_parse jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_count bigint;
begin
	-- 20260930060000 (E1).
	insert into public.qorpera_folder_hook_index as i(environment_id, id, profile_id, kind, folder_path, folder_key,
		folder_path_version, commit_id)
	values (p_environment_id, (p_parse ->> 'id')::uuid, p_profile_id, p_kind, p_path, public.qorpera_folder_key(p_path),
		p_version, p_commit_id)
	on conflict (environment_id, id) do update set kind = excluded.kind, folder_path = excluded.folder_path,
		folder_key = excluded.folder_key, folder_path_version = excluded.folder_path_version, commit_id = excluded.commit_id,
		retired_at = null, updated_at = clock_timestamp()
	where i.retired_at is not null or i.folder_key = excluded.folder_key;
	get diagnostics v_count = row_count;
	if v_count = 0 then raise exception 'Another change set wrote a file for this hook' using errcode = '23505'; end if;
end $$;
revoke all on function public.qorpera_company_state_index_hook(uuid, uuid, uuid, text, uuid, text, jsonb)
	from public, anon, authenticated, service_role;

-- Decide: a hook's or a mailbox's file goes only when the platform removes it after its hook is removed; each file's rules;
-- one file per hook within a unit.
select pg_temp.e1_replace('public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$	v_p16 jsonb := '{}'::jsonb;$old$,
	$new$	v_p16 jsonb := '{}'::jsonb; v_e1_hooks text[] := '{}';$new$);
select pg_temp.e1_replace('public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$		-- A todo with a working worker stays where it is, its folder too: cancel the worker first.$old$,
	$new$		-- 20260930060000 (E1): a hook's or a mailbox's file goes only when the platform removes it after the hook is removed.
		if v_op = 'delete' and v_row.kind = 'file' and public.qorpera_structured_path_kind(v_key) in ('hook','mailbox')
			and (p_actor ->> 'kind' is distinct from 'platform'
				or exists (select 1 from public.qorpera_folder_hook_index i
					join public.qorpera_event_hooks h on h.id = i.id
					where i.environment_id = p_environment_id and i.retired_at is null and i.folder_key = v_key
						and h.status <> 'removed')) then
			return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
				public.qorpera_company_state_problem('value', null, null,
					'a hook''s or a mailbox''s file goes when the hook or mailbox is removed'))); end if;
		-- A todo with a working worker stays where it is, its folder too: cancel the worker first.$new$);
select pg_temp.e1_replace('public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$		elsif v_checked ->> 'kind' = 'rule' then$old$,
	$new$		-- 20260930060000 (E1): a hook's and a mailbox's files.
		elsif v_checked ->> 'kind' in ('hook','mailbox') then
			if (v_checked -> 'parse' ->> 'id') = any (v_e1_hooks) then
				return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
					public.qorpera_company_state_problem('value', null, null,
						'two hook or mailbox files in one change carry the same id'))); end if;
			v_e1_hooks := array_append(v_e1_hooks, v_checked -> 'parse' ->> 'id');
			v_rule := public.qorpera_company_state_hook_rules(p_environment_id, v_profile, p_actor, v_file.key,
				v_checked ->> 'kind', v_checked -> 'parse');
			if v_rule is not null then return v_rule; end if;
		elsif v_checked ->> 'kind' = 'rule' then$new$);

-- Apply: write the rows; a move repoints them; a delete retires them.
select pg_temp.e1_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$			elsif v_kind = 'rule' then$old$,
	$new$			-- 20260930060000 (E1): a hook's and a mailbox's files.
			elsif v_kind in ('hook','mailbox') then
				perform public.qorpera_company_state_index_hook(p_environment_id, v_profile, p_commit_id, v_file.path, v_version,
					v_kind, v_entry -> 'parse');
			elsif v_kind = 'rule' then$new$);
select pg_temp.e1_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$		-- Todo files follow their path: a new name is the new key, and a new agent folder the new owner (read after the$old$,
	$new$		-- Hook and mailbox files follow their path and keep their id (20260930060000, E1); every row at or under the source
		-- finds its moved entry, or the commit stops.
		select count(*) into v_h2_rows from public.qorpera_folder_hook_index i
		where i.environment_id = p_environment_id and i.retired_at is null
			and (i.folder_key = v_key or i.folder_key like public.qorpera_folder_under(v_key));
		update public.qorpera_folder_hook_index i set folder_path = e.path, folder_key = e.key_text, folder_path_version = e.version,
			commit_id = p_commit_id, updated_at = clock_timestamp()
		from public.qorpera_folder_entries e
		where i.environment_id = p_environment_id and i.retired_at is null
			and (i.folder_key = v_key or i.folder_key like public.qorpera_folder_under(v_key))
			and e.environment_id = p_environment_id
			and e.key_sha256 = extensions.digest(public.qorpera_folder_key(p_eff_to || substr(i.folder_path, char_length(p_eff_path) + 1)), 'sha256');
		get diagnostics v_h2_moved = row_count;
		if v_h2_moved <> v_h2_rows then raise exception 'A moved hook file has no version in its commit' using errcode = 'XX000'; end if;
		-- Todo files follow their path: a new name is the new key, and a new agent folder the new owner (read after the$new$);
select pg_temp.e1_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$		-- A connection's file removed (after its account was disconnected): its index row retires.$old$,
	$new$		-- A hook's or a mailbox's file removed: its row retires; a restore revives it (20260930060000, E1).
		update public.qorpera_folder_hook_index i set retired_at = clock_timestamp(), commit_id = p_commit_id,
			updated_at = clock_timestamp()
		where i.environment_id = p_environment_id and i.retired_at is null
			and (i.folder_key = v_key or i.folder_key like public.qorpera_folder_under(v_key));
		-- A connection's file removed (after its account was disconnected): its index row retires.$new$);

-- Verify: every hook row this commit wrote points at its file's current version.
select pg_temp.e1_replace('public.qorpera_folder_structured_verify(uuid,uuid)'::regprocedure,
	$old$		or exists (select 1 from public.qorpera_folder_company_index i$old$,
	$new$		-- 20260930060000 (E1): hook and mailbox rows.
		or exists (select 1 from public.qorpera_folder_hook_index h
			where h.environment_id = p_environment_id and h.commit_id = p_commit_id and h.retired_at is null
				and not exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.key_sha256 = extensions.digest(h.folder_key, 'sha256') and e.version = h.folder_path_version
					and e.path = h.folder_path))
		or exists (select 1 from public.qorpera_folder_company_index i$new$);

-- The targets: a unit that writes a hook's or a mailbox's file takes the hook FOR SHARE at rank 5 (review r1 F1). A removal
-- takes it FOR NO KEY UPDATE there, so it waits for the write to commit (and the writer that claims the removal then finds
-- the file and deletes it), or the write waits for the removal and its rules see the hook removed. Without the lock a file
-- written after a writer saw "no file" for a removed hook would stay with nothing due to remove it.
select pg_temp.e1_replace('public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)'::regprocedure,
	$old$		-- 20260930016000 (P16): the table rows and the company index row a unit writes or relies on, at rank 5.$old$,
	$new$		-- 20260930060000 (E1): the hook of a hook's or a mailbox's file the unit writes, FOR SHARE at rank 5.
		for v_entry in select e.value from jsonb_array_elements(case when v_op in ('write','new_folder')
				and jsonb_typeof(v_unit -> 'structured') = 'array' then v_unit -> 'structured' else '[]'::jsonb end) e
			where e.value ->> 'kind' in ('hook','mailbox') and coalesce(e.value -> 'parse' ->> 'id', '') ~ c_uuid loop
			rank := 5; tbl := 'qorpera_event_hooks'; key := v_entry -> 'parse' ->> 'id'; mode := 'share';
			return next;
		end loop;
		-- 20260930016000 (P16): the table rows and the company index row a unit writes or relies on, at rank 5.$new$);

-- The lock: hooks at rank 5, after every other table there (E2's routine saves take them FOR SHARE), keyed by the hook id.
select pg_temp.e1_replace('public.qorpera_folder_structured_lock(uuid,jsonb,smallint,smallint)'::regprocedure,
	$old$			'qorpera_folder_table_index' /* 20260930016000 (P16) */], t ->> 'tbl'),$old$,
	$new$			'qorpera_folder_table_index' /* 20260930016000 (P16) */,
			'qorpera_event_hooks' /* 20260930060000 (E1) */], t ->> 'tbl'),$new$);
select pg_temp.e1_replace('public.qorpera_folder_structured_lock(uuid,jsonb,smallint,smallint)'::regprocedure,
	$old$		else
			raise exception 'Folder lock target table % is unknown', v_target.tbl using errcode = 'XX000';$old$,
	$new$		elsif v_target.tbl = 'qorpera_event_hooks' then
			-- key: the hook's id (20260930060000, E1).
			execute 'select 1 from public.qorpera_event_hooks where id = $1' || v_clause using v_target.key::uuid;
		else
			raise exception 'Folder lock target table % is unknown', v_target.tbl using errcode = 'XX000';$new$);

-- Erasure: the retired hook rows under its roots, as the table rows (P18c).
select pg_temp.e1_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$	delete from public.qorpera_folder_connection_index where secret_id = any(v_connections);
$old$,
	$new$	delete from public.qorpera_folder_connection_index where secret_id = any(v_connections);
	-- 20260930060000 (E1): the hook and mailbox rows, retired, whose file lies before its root's cutoff.
	delete from public.qorpera_folder_hook_index i using jsonb_array_elements(v_roots) r
	where i.environment_id = p_environment_id and i.retired_at is not null
		and public.qorpera_folder_erasure_covers(r ->> 'key', i.folder_key)
		and public.qorpera_folder_erasure_row_before(r, i.commit_id, i.folder_path_version);
$new$);

-- 5. P22's marks and work, by kind ------------------------------------------------------------------------------------

-- A vault file never takes a hook's or a mailbox's prefix.
select pg_temp.e1_replace('public.qorpera_folder_connection_file_state(uuid)'::regprocedure,
	$old$		v_name := coalesce(nullif(rtrim(left(v_name, 64), '-'), ''), 'connection');$old$,
	$new$		v_name := coalesce(nullif(rtrim(left(v_name, 64), '-'), ''), 'connection');
		-- 20260930060000 (E1): hook- and mailbox- name a hook's and a mailbox's files.
		if v_name ~ '^(hook|mailbox)-' then v_name := rtrim(left('connection-' || v_name, 64), '-'); end if;$new$);

alter table public.qorpera_folder_connection_file_marks
	add column subject_kind text not null default 'vault' check (subject_kind in ('vault','hook','mailbox'));
drop index public.qorpera_folder_connection_file_marks_secret;
create index qorpera_folder_connection_file_marks_subject
	on public.qorpera_folder_connection_file_marks(subject_kind, secret_id, id);
alter table public.qorpera_folder_connection_file_work
	add column subject_kind text not null default 'vault' check (subject_kind in ('vault','hook','mailbox'));
alter table public.qorpera_folder_connection_file_work drop constraint qorpera_folder_connection_file_work_pkey,
	add primary key (subject_kind, secret_id);
comment on column public.qorpera_folder_connection_file_work.secret_id is
	'The subject''s id: a vault secret''s (subject_kind vault) or a hook''s (hook, mailbox). 20260930060000 (E1).';

-- One mark for a hook or a mailbox in a folder-v2 environment, when a field its file shows changes. Plain reads only.
create function public.qorpera_folder_hook_file_mark()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	-- 20260930060000 (E1): the hook marks its file due; the writer converges the file later.
	if not public.qorpera_environment_is_folder_v2(new.environment_id) then return null; end if;
	insert into public.qorpera_folder_connection_file_marks(secret_id, profile_id, environment_id, subject_kind)
	values (new.id, new.profile_id, new.environment_id, case when new.proof = 'mail' then 'mailbox' else 'hook' end);
	return null;
end $$;
revoke all on function public.qorpera_folder_hook_file_mark() from public, anon, authenticated, service_role;
create trigger qorpera_folder_hook_file_mark_insert
	after insert on public.qorpera_event_hooks
	for each row execute function public.qorpera_folder_hook_file_mark();
create trigger qorpera_folder_hook_file_mark_update
	after update of status, name, max_body_bytes, per_minute on public.qorpera_event_hooks
	for each row when (old.status is distinct from new.status or old.name is distinct from new.name
		or old.max_body_bytes is distinct from new.max_body_bytes or old.per_minute is distinct from new.per_minute)
	execute function public.qorpera_folder_hook_file_mark();

-- A mailbox's file shows its address, which carries the mail domain: a new domain marks every live folder-v2 mailbox due
-- (review r1 F2). An operator's change, rare; its marks key-share the companies' rows like any mark.
create function public.qorpera_folder_mailbox_domain_mark()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	-- 20260930060000 (E1).
	insert into public.qorpera_folder_connection_file_marks(secret_id, profile_id, environment_id, subject_kind)
	select hook.id, hook.profile_id, hook.environment_id, 'mailbox'
	from public.qorpera_event_hooks as hook
	join public.qorpera_company_mailboxes as box on box.hook_id = hook.id and box.removed_at is null
	where hook.proof = 'mail' and hook.status <> 'removed' and public.qorpera_environment_is_folder_v2(hook.environment_id)
	order by hook.id;
	return null;
end $$;
revoke all on function public.qorpera_folder_mailbox_domain_mark() from public, anon, authenticated, service_role;
create trigger qorpera_folder_mailbox_domain_mark
	after update of domain on public.qorpera_mail_settings
	for each row when (old.domain is distinct from new.domain)
	execute function public.qorpera_folder_mailbox_domain_mark();

-- The claim, by kind: P22a's, with the kind part of every key, the state read by kind, and P14a's creation guard kept.
create or replace function public.qorpera_claim_connection_file(p_worker uuid, p_lease_seconds integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_work public.qorpera_folder_connection_file_work%rowtype; v_consumed bigint;
begin
	-- 20260930006000 (P22a): a claim never waits for a vault change or a company being deleted. It locks only work rows,
	-- the marks it consumes and the key share of the companies it creates work rows for, each SKIP LOCKED (only another
	-- claim's new work rows can make it wait, briefly, in (kind, id) order); the vault and the hooks are read plainly.
	-- 20260930060000 (E1): a subject is a vault secret, a hook or a mailbox; its kind is part of every key.
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_worker is null or p_lease_seconds is null or p_lease_seconds not between 30 and 900 then
		raise exception 'Connection file claim is invalid' using errcode = '22023'; end if;
	-- A marked subject with no work row yet gets one, in (kind, id) order (two claims may wait for each other's new rows
	-- only in that one order, never in a cycle), and only when its company's row can be key-shared at once: the insert's
	-- key check needs it, and a company held for deletion is skipped until its purge ends, so no claim waits behind one.
	-- An existing work row is left alone (an insert that met it would wait for a writer holding it).
	insert into public.qorpera_folder_connection_file_work(subject_kind, secret_id, profile_id, environment_id)
	select distinct on (mark.subject_kind, mark.secret_id) mark.subject_kind, mark.secret_id, mark.profile_id,
		mark.environment_id
	from public.qorpera_folder_connection_file_marks as mark
	where not exists (select 1 from public.qorpera_folder_connection_file_work as work
			where work.subject_kind = mark.subject_kind and work.secret_id = mark.secret_id)
		and mark.profile_id in (select company.id from public.qorpera_profiles as company
			where company.id in (select pending.profile_id from public.qorpera_folder_connection_file_marks as pending
				where not exists (select 1 from public.qorpera_folder_connection_file_work as work
					where work.subject_kind = pending.subject_kind and work.secret_id = pending.secret_id))
			for key share skip locked)
	order by mark.subject_kind, mark.secret_id
	on conflict (subject_kind, secret_id) do nothing;
	select work.* into v_work from public.qorpera_folder_connection_file_work as work
	where (work.dirty or exists (select 1 from public.qorpera_folder_connection_file_marks as mark
			where mark.subject_kind = work.subject_kind and mark.secret_id = work.secret_id))
		and (work.lease_until is null or work.lease_until < clock_timestamp())
		and (work.not_before is null or work.not_before <= clock_timestamp())
		-- 20260930010000 (P14a): not while the company's folder-v2 creation is not made yet.
		and not exists (select 1 from public.qorpera_folder_company_creations as creation
			where creation.profile_id = work.profile_id and creation.state is distinct from 'completed')
	order by coalesce((select min(mark.created_at) from public.qorpera_folder_connection_file_marks as mark
		where mark.subject_kind = work.subject_kind and mark.secret_id = work.secret_id), work.updated_at),
		work.subject_kind, work.secret_id
	limit 1
	for update skip locked;
	if v_work.secret_id is null then return null; end if;
	-- The marks this statement sees are covered by the state read below (their transactions committed); a mark that
	-- commits later stays and makes the subject due again. A mark another transaction holds (a purge) is skipped.
	delete from public.qorpera_folder_connection_file_marks where id in (
		select mark.id from public.qorpera_folder_connection_file_marks as mark
		where mark.subject_kind = v_work.subject_kind and mark.secret_id = v_work.secret_id
		for update skip locked);
	get diagnostics v_consumed = row_count;
	update public.qorpera_folder_connection_file_work
	set generation = generation + 1, dirty = true, lease_owner = p_worker,
		lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds), attempts = attempts + 1,
		updated_at = clock_timestamp()
	where subject_kind = v_work.subject_kind and secret_id = v_work.secret_id
	returning * into v_work;
	return jsonb_build_object('schema', 'qorpera.connection-file-claim/v1', 'subjectKind', v_work.subject_kind,
		'secretId', v_work.secret_id, 'environmentId', v_work.environment_id, 'generation', v_work.generation,
		'attempt', v_work.attempts,
		'operationKey', case v_work.subject_kind when 'vault' then 'connection-file:' else v_work.subject_kind || '-file:' end
			|| v_work.secret_id || ':' || v_work.generation,
		'leaseUntil', v_work.lease_until, 'marks', v_consumed)
		|| case when v_work.subject_kind = 'vault' then public.qorpera_folder_connection_file_state(v_work.secret_id)
			else public.qorpera_folder_hook_file_state(v_work.subject_kind, v_work.secret_id, v_work.environment_id) end;
end $$;
revoke all on function public.qorpera_claim_connection_file(uuid, integer) from public, anon, authenticated;
grant execute on function public.qorpera_claim_connection_file(uuid, integer) to service_role;

-- The finish, by kind (a vault secret's when the kind is left out, as before).
drop function public.qorpera_finish_connection_file(uuid, uuid, bigint, text);
create function public.qorpera_finish_connection_file(p_worker uuid, p_secret_id uuid, p_generation bigint,
	p_problem text default null, p_subject_kind text default 'vault')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_work public.qorpera_folder_connection_file_work%rowtype;
begin
	-- 20260930006000 (P22a): only the work row is locked. 20260930060000 (E1): by kind.
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_worker is null or p_secret_id is null or p_generation is null
		or coalesce(p_subject_kind, '') not in ('vault','hook','mailbox')
		or (p_problem is not null and p_problem !~ '^[a-z][a-z0-9_]{0,63}$') then
		raise exception 'Connection file finish is invalid' using errcode = '22023'; end if;
	select work.* into v_work from public.qorpera_folder_connection_file_work as work
	where work.subject_kind = p_subject_kind and work.secret_id = p_secret_id for update;
	if v_work.secret_id is null or v_work.lease_owner is distinct from p_worker or v_work.generation <> p_generation then
		return jsonb_build_object('schema', 'qorpera.connection-file-finish/v1', 'finished', false);
	end if;
	if p_problem is not null then
		update public.qorpera_folder_connection_file_work
		set lease_owner = null, lease_until = null, last_problem = p_problem,
			not_before = clock_timestamp() + least(make_interval(secs => power(2, least(attempts, 10))::integer),
				interval '10 minutes'),
			updated_at = clock_timestamp()
		where subject_kind = p_subject_kind and secret_id = p_secret_id;
	else
		-- The row stays, so the next claim's generation (its operation key) is new: a reused key would replay.
		update public.qorpera_folder_connection_file_work
		set dirty = false, lease_owner = null, lease_until = null, attempts = 0, not_before = null, last_problem = null,
			updated_at = clock_timestamp()
		where subject_kind = p_subject_kind and secret_id = p_secret_id;
	end if;
	return jsonb_build_object('schema', 'qorpera.connection-file-finish/v1', 'finished', true);
end $$;
revoke all on function public.qorpera_finish_connection_file(uuid, uuid, bigint, text, text) from public, anon, authenticated;
grant execute on function public.qorpera_finish_connection_file(uuid, uuid, bigint, text, text) to service_role;

-- 6. Creating, pausing and removing on folder-v2 ------------------------------------------------------------------------

create or replace function public.qorpera_create_event_hook(
	p_profile_id uuid,
	p_environment_id uuid,
	p_name text,
	p_purpose text,
	p_proof text default 'address',
	p_max_body_bytes integer default null,
	p_per_minute integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_role text := public.qorpera_member_role(p_profile_id)::text;
	v_hook public.qorpera_event_hooks%rowtype;
	v_core text;
begin
	if auth.uid() is null or v_role is null or v_role not in ('owner', 'admin') then
		raise exception 'Only owners and admins can create hooks' using errcode = '42501';
	end if;
	if not exists (
		select 1 from public.qorpera_company_environments as environment
		where environment.id = p_environment_id and environment.profile_id = p_profile_id
	) then
		raise exception 'The company environment is invalid' using errcode = '22023';
	end if;
	if p_name is null or p_name !~ '^[a-z][a-z0-9-]{0,63}$' or p_name like 'mail-%' then
		raise exception 'A hook name uses lowercase letters, digits and hyphens, starts with a letter and has at most 64 characters'
			using errcode = '22023';
	end if;
	if p_purpose is null or char_length(btrim(p_purpose)) not between 1 and 512 or p_purpose ~ '[[:cntrl:]]' then
		raise exception 'A hook needs a purpose of one line, 1 to 512 characters' using errcode = '22023';
	end if;
	if p_proof is null or p_proof not in ('address', 'stripe', 'github', 'hmac-sha256') then
		raise exception 'A hook is proven by its address, or by a Stripe, GitHub or HMAC-SHA256 signature'
			using errcode = '22023';
	end if;
	if p_max_body_bytes is not null and p_max_body_bytes not between 1024 and 262144 then
		raise exception 'A hook body limit is between 1 KiB and 256 KiB' using errcode = '22023';
	end if;
	if p_per_minute is not null and p_per_minute not between 1 and 120 then
		raise exception 'A hook accepts between 1 and 120 deliveries a minute' using errcode = '22023';
	end if;
	if public.qorpera_environment_is_folder_v2(p_environment_id) then
		-- 20260930060000 (E1): a folder-v2 company's hook, in core §3's order: the fence and the company row KEY SHARE and
		-- the member at rank 1, then a per-company advisory lock for the caps and the live names (the company row is never
		-- locked more strongly on folder-v2), taken last and waiting on nothing after it. Its file follows the commit.
		perform public.qorpera_folder_company_enter(p_environment_id, p_profile_id, jsonb_build_array(
			jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members', 'key', p_profile_id::text || ':' || auth.uid()::text,
				'mode', 'keyshare', 'required', true)), false);
		if public.qorpera_company_deleting(p_profile_id)
			or coalesce(public.qorpera_member_role(p_profile_id)::text not in ('owner', 'admin'), true) then
			raise exception 'Only owners and admins can create hooks' using errcode = '42501';
		end if;
		perform pg_advisory_xact_lock(hashtextextended('qorpera.event-hooks:' || p_profile_id::text, 0));
	else
		-- Serialize hook creation per company so the limit of 50 holds, then check the company again:
		-- a deletion request may have committed while this call waited. No key update: it conflicts
		-- with itself and with the gc fence, not with foreign keys to the company.
		perform 1 from public.qorpera_profiles where id = p_profile_id for no key update;
		if public.qorpera_company_deleting(p_profile_id) then
			raise exception 'Only owners and admins can create hooks' using errcode = '42501';
		end if;
		-- The Company File row, shared: qorpera_folder_enable locks it for update before it looks for
		-- hooks, so a company never becomes folder-v2 with a hook created alongside.
		select file.core into v_core from public.qorpera_company_files as file
		where file.environment_id = p_environment_id for share;
		if v_core = 'folder-v2' then
			raise exception 'Hooks for folder companies come with their connection file' using errcode = '0A000';
		end if;
	end if;
	if (select count(*) from public.qorpera_event_hooks as hook
		where hook.profile_id = p_profile_id and hook.status <> 'removed') >= 50 then
		raise exception 'A company has at most 50 hooks' using errcode = '54000';
	end if;
	if exists (
		select 1 from public.qorpera_event_hooks as hook
		where hook.profile_id = p_profile_id and hook.environment_id = p_environment_id
			and hook.name = p_name and hook.status <> 'removed'
	) then
		raise exception 'A hook with this name already exists' using errcode = '23505';
	end if;
	insert into public.qorpera_event_hooks (
		profile_id, environment_id, name, purpose, proof, address, max_body_bytes, per_minute,
		created_by_user_id
	) values (
		p_profile_id, p_environment_id, p_name, btrim(p_purpose), p_proof,
		translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_'),
		coalesce(p_max_body_bytes, 65536), coalesce(p_per_minute, 60), auth.uid()
	) returning * into v_hook;
	return public.qorpera_event_hook_descriptor(v_hook, true);
end
$$;

create or replace function public.qorpera_create_company_mailbox(p_profile_id uuid, p_environment_id uuid, p_local_part text,
	p_purpose text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_role text := public.qorpera_member_role(p_profile_id)::text;
	v_domain text;
	v_core text;
	v_name text;
	v_hook public.qorpera_event_hooks%rowtype;
begin
	if auth.uid() is null or v_role is null or v_role not in ('owner', 'admin') then
		raise exception 'Only owners and admins can create mailboxes' using errcode = '42501';
	end if;
	if p_environment_id is null or not exists (select 1 from public.qorpera_company_environments
		where id = p_environment_id and profile_id = p_profile_id) then
		raise exception 'The environment is not this company''s' using errcode = '22023';
	end if;
	if p_local_part is null or p_local_part !~ '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$' or p_local_part ~ '\.\.' then
		raise exception 'A mailbox name is 1 to 64 lowercase letters, digits, dots, hyphens and underscores'
			using errcode = '22023';
	end if;
	-- Names every mail domain keeps for itself (RFC 2142) or that invite abuse.
	if p_local_part in ('postmaster', 'abuse', 'hostmaster', 'webmaster', 'admin', 'administrator', 'root',
		'security', 'noc', 'noreply', 'no-reply', 'mailer-daemon', 'www', 'ftp', 'uucp', 'usenet', 'news') then
		raise exception 'This mailbox name is reserved' using errcode = '22023';
	end if;
	-- The platform's own name, however it is spelled (founder decision, 1 October 2026).
	if public.qorpera_mail_name_reads_as_qorpera(p_local_part) then
		raise exception 'A mailbox name that reads as Qorpera is reserved' using errcode = '22023';
	end if;
	if p_purpose is null or char_length(btrim(p_purpose)) not between 1 and 512 or p_purpose ~ '[[:cntrl:]]' then
		raise exception 'A mailbox purpose is one line of at most 512 characters' using errcode = '22023';
	end if;
	select settings.domain into v_domain from public.qorpera_mail_settings as settings;
	if v_domain is null then
		raise exception 'Company mail is not set up yet' using errcode = '0A000';
	end if;
	if public.qorpera_environment_is_folder_v2(p_environment_id) then
		-- 20260930060000 (E1): as a folder-v2 hook's creation (qorpera_create_event_hook): the fence, the company row and the
		-- member, then the company's advisory lock. Its file follows the commit.
		perform public.qorpera_folder_company_enter(p_environment_id, p_profile_id, jsonb_build_array(
			jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members', 'key', p_profile_id::text || ':' || auth.uid()::text,
				'mode', 'keyshare', 'required', true)), false);
		if public.qorpera_company_deleting(p_profile_id)
			or coalesce(public.qorpera_member_role(p_profile_id)::text not in ('owner', 'admin'), true) then
			raise exception 'Only owners and admins can create mailboxes' using errcode = '42501';
		end if;
		perform pg_advisory_xact_lock(hashtextextended('qorpera.event-hooks:' || p_profile_id::text, 0));
		-- Then the mail domain FOR SHARE, last (review r2 F2): a new domain's marks see only committed mailboxes, so a
		-- creation waits for an open domain change and its file shows the new address, and a domain change waits for an
		-- open creation and then marks it. A domain change takes no company lock that this waits behind.
		select settings.domain into v_domain from public.qorpera_mail_settings as settings for share;
		if v_domain is null then
			raise exception 'Company mail is not set up yet' using errcode = '0A000';
		end if;
	else
		-- As hook creation: the company row without its key (serializes creations, waits for the gc fence), the
		-- deletion recheck, then the Company File row shared.
		perform 1 from public.qorpera_profiles where id = p_profile_id for no key update;
		if public.qorpera_company_deleting(p_profile_id) then
			raise exception 'Only owners and admins can create mailboxes' using errcode = '42501';
		end if;
		select file.core into v_core from public.qorpera_company_files as file
		where file.environment_id = p_environment_id for share;
		if v_core = 'folder-v2' then
			raise exception 'Mailboxes for folder companies come with their connection file' using errcode = '0A000';
		end if;
	end if;
	if (select count(*) from public.qorpera_company_mailboxes
		where profile_id = p_profile_id and removed_at is null) >= 20 then
		raise exception 'A company has at most 20 mailboxes' using errcode = '54000';
	end if;
	if (select count(*) from public.qorpera_event_hooks as hook
		where hook.profile_id = p_profile_id and hook.status <> 'removed') >= 50 then
		raise exception 'A company has at most 50 hooks' using errcode = '54000';
	end if;
	if exists (select 1 from public.qorpera_company_mailboxes
		where local_part = p_local_part and removed_at is null) then
		raise exception 'This address is taken' using errcode = '23505';
	end if;
	-- mail-<local part>, or with a short digest when the local part does not fit a hook name as it is, so
	-- two addresses never share a name ('a.b' and 'a_b').
	v_name := 'mail-' || p_local_part;
	if v_name !~ '^[a-z][a-z0-9-]{0,63}$' then
		v_name := 'mail-' || left(regexp_replace(p_local_part, '[^a-z0-9-]', '-', 'g'), 52) || '-'
			|| left(encode(extensions.digest(p_local_part, 'sha256'), 'hex'), 6);
	end if;
	if exists (select 1 from public.qorpera_event_hooks as hook where hook.profile_id = p_profile_id
		and hook.environment_id = p_environment_id and hook.name = v_name and hook.status <> 'removed') then
		raise exception 'A hook with this name already exists' using errcode = '23505';
	end if;
	begin
		insert into public.qorpera_event_hooks (
			profile_id, environment_id, name, purpose, proof, address, max_body_bytes, per_minute, created_by_user_id
		) values (
			p_profile_id, p_environment_id, v_name, btrim(p_purpose), 'mail',
			translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_'),
			262144, 120, auth.uid()
		) returning * into v_hook;
		insert into public.qorpera_company_mailboxes (hook_id, profile_id, environment_id, local_part, created_by_user_id)
		values (v_hook.id, p_profile_id, p_environment_id, p_local_part, auth.uid());
	exception when unique_violation then
		raise exception 'This address is taken' using errcode = '23505';
	end;
	return public.qorpera_event_hook_descriptor(v_hook, true);
end
$$;

create or replace function public.qorpera_set_event_hook_status(p_hook_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_hook public.qorpera_event_hooks%rowtype;
	v_role text;
begin
	if auth.uid() is null or coalesce(public.qorpera_member_role(
		(select hook.profile_id from public.qorpera_event_hooks as hook where hook.id = p_hook_id))::text not in ('owner', 'admin'), true) then
		raise exception 'Only owners and admins can change hooks' using errcode = '42501';
	end if;
	select hook.* into v_hook from public.qorpera_event_hooks as hook where hook.id = p_hook_id;
	if public.qorpera_environment_is_folder_v2(v_hook.environment_id) then
		-- 20260930060000 (E1): on folder-v2, core §3's order: the fence and the company row KEY SHARE, the member at rank 1,
		-- then the hook FOR NO KEY UPDATE at rank 5, as a routine save that names it takes it FOR SHARE (E2). No key
		-- changes, so a receive's foreign key check (key share) does not wait for this lock either.
		perform public.qorpera_folder_company_enter(v_hook.environment_id, v_hook.profile_id, jsonb_build_array(
			jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members', 'key',
				v_hook.profile_id::text || ':' || auth.uid()::text, 'mode', 'keyshare', 'required', true),
			jsonb_build_object('rank', 5, 'tbl', 'qorpera_event_hooks', 'key', v_hook.id::text, 'mode', 'nokeyupdate',
				'required', true)), false);
		select hook.* into v_hook from public.qorpera_event_hooks as hook where hook.id = p_hook_id;
	else
		-- No key changes, so a receive's foreign key check (key share) does not wait for this lock.
		select hook.* into v_hook from public.qorpera_event_hooks as hook where hook.id = p_hook_id for no key update;
	end if;
	v_role := public.qorpera_member_role(v_hook.profile_id)::text;
	if v_hook.id is null or auth.uid() is null or v_role is null or v_role not in ('owner', 'admin') then
		raise exception 'Only owners and admins can change hooks' using errcode = '42501';
	end if;
	if p_status is null or p_status not in ('active', 'paused', 'removed') then
		raise exception 'A hook is active, paused or removed' using errcode = '22023';
	end if;
	if v_hook.status = 'removed' then
		raise exception 'This hook was removed' using errcode = '55000';
	end if;
	if v_hook.status <> p_status then
		update public.qorpera_event_hooks
		set status = p_status,
			removed_at = case when p_status = 'removed' then statement_timestamp() end,
			updated_at = statement_timestamp()
		where id = v_hook.id
		returning * into v_hook;
	end if;
	return public.qorpera_event_hook_descriptor(v_hook, v_hook.status <> 'removed');
end
$$;

-- 7. The deploy guard: every patched body carries the marker -------------------------------------------------------------

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_structured_path_kind(text)', 'public.qorpera_company_state_path_problems(text,boolean)',
		'public.qorpera_company_state_parse_problems(text,jsonb)', 'public.qorpera_company_state_checked(jsonb,text,text,jsonb)',
		'public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)',
		'public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)',
		'public.qorpera_folder_structured_verify(uuid,uuid)',
		'public.qorpera_folder_structured_lock(uuid,jsonb,smallint,smallint)',
		'public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)',
		'public.qorpera_folder_erase(uuid,jsonb,jsonb,text)', 'public.qorpera_folder_connection_file_state(uuid)',
		'public.qorpera_claim_connection_file(uuid,integer)',
		'public.qorpera_finish_connection_file(uuid,uuid,bigint,text,text)',
		'public.qorpera_create_event_hook(uuid,uuid,text,text,text,integer,integer)',
		'public.qorpera_create_company_mailbox(uuid,uuid,text,text)', 'public.qorpera_set_event_hook_status(uuid,text)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930060000') = 0 then
			raise exception 'E1 marker is missing in %', v_function; end if;
	end loop;
end $guard$;
