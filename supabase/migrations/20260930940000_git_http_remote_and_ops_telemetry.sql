begin;

set local lock_timeout = '3s';

do $$ begin
	if to_regclass('public.qorpera_code_git_tokens') is not null then
		raise exception 'Git HTTP remote and ops telemetry (20260930940000) is already applied';
	end if;
	if to_regclass('public.qorpera_code_repositories') is null
		or to_regclass('public.qorpera_code_changes') is null
		or to_regclass('public.qorpera_company_site_deployments') is null
		or to_regclass('public.qorpera_surface_jobs') is null
		or to_regclass('public.qorpera_surface_changes') is null
		or to_regprocedure('public.qorpera_runner_orchestrator_dispatch(uuid,text,text,jsonb)') is null
		or to_regprocedure('public.qorpera_company_numbers_answer(uuid,uuid,jsonb,text,jsonb)') is null
		or to_regprocedure('public.qorpera_mail_apply_thread_action(uuid,uuid,text[],text)') is null
		or not exists (select 1 from pg_roles where rolname = 'qorpera_web_router') then
		raise exception 'Git HTTP remote and ops telemetry (20260930940000) requires prior code, surface, mail, and web hosting migrations';
	end if;
end $$;

create temporary table git_ops_tel_before on commit drop as
select p.oid, to_jsonb(p) - 'prosrc' as fields
from pg_proc as p
where p.pronamespace = 'public'::regnamespace
	and p.oid in (
		'public.qorpera_runner_orchestrator_dispatch(uuid,text,text,jsonb)'::regprocedure,
		'public.qorpera_company_numbers_answer(uuid,uuid,jsonb,text,jsonb)'::regprocedure
	);

create function pg_temp.git_ops_tel_patch(p_target regprocedure, p_edits text[])
returns void language plpgsql as $$
declare
	v_definition text := pg_get_functiondef(p_target);
	v_found integer;
begin
	if coalesce(cardinality(p_edits), 0) = 0 or cardinality(p_edits) % 2 <> 0 then
		raise exception '20260930940000 invalid edits for %', p_target;
	end if;
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception '20260930940000 anchor found % time(s) in %, expected 1: %', v_found, p_target, left(p_edits[2 * i - 1], 120);
		end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

alter table public.qorpera_code_changes
	drop constraint qorpera_code_changes_kind_check,
	add constraint qorpera_code_changes_kind_check
		check (kind in ('landing', 'undo', 'restore', 'found', 'import', 'pull', 'push'));

create table public.qorpera_code_git_tokens (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	user_id uuid not null references auth.users(id) on delete cascade,
	label text not null check (char_length(label) between 1 and 80 and label !~ '[[:cntrl:]]'),
	token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
	token_prefix text not null check (token_prefix ~ '^qgit_[A-Za-z0-9_-]{6,16}$'),
	scope text not null check (scope in ('read', 'write')),
	owner text check (owner is null or (char_length(owner) between 1 and 39 and owner ~ '^[a-z0-9][a-z0-9_-]{0,38}$')),
	name text check (name is null or (char_length(name) between 1 and 100 and name ~ '^[a-z0-9_.-]{1,100}$')),
	created_at timestamptz not null default clock_timestamp(),
	expires_at timestamptz not null check (expires_at > created_at),
	last_used_at timestamptz,
	revoked_at timestamptz,
	check ((owner is null) = (name is null))
);

create index qorpera_code_git_tokens_profile_user_idx
	on public.qorpera_code_git_tokens (profile_id, user_id, created_at desc);

create index qorpera_code_git_tokens_env_active_idx
	on public.qorpera_code_git_tokens (environment_id, user_id, expires_at)
	where revoked_at is null;

alter table public.qorpera_code_git_tokens enable row level security;
revoke all on public.qorpera_code_git_tokens
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_create_code_git_token(
	p_environment_id uuid,
	p_label text,
	p_scope text default 'read',
	p_owner text default null,
	p_name text default null,
	p_expires_days integer default 30
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_uid uuid := auth.uid();
	v_env public.qorpera_company_environments%rowtype;
	v_role public.qorpera_profile_role;
	v_label text := btrim(coalesce(p_label, ''));
	v_scope text := lower(btrim(coalesce(p_scope, 'read')));
	v_owner text := nullif(lower(btrim(coalesce(p_owner, ''))), '');
	v_name text := nullif(lower(btrim(coalesce(p_name, ''))), '');
	v_days integer := coalesce(p_expires_days, 30);
	v_now timestamptz := clock_timestamp();
	v_active_count integer;
	v_token text;
	v_sha text;
	v_prefix text;
	v_row public.qorpera_code_git_tokens%rowtype;
begin
	if v_uid is null then
		raise exception 'Authentication is required' using errcode = '42501';
	end if;
	if p_environment_id is null then
		raise exception 'Environment is required' using errcode = '22023';
	end if;

	select * into v_env
	from public.qorpera_company_environments
	where id = p_environment_id;
	if v_env.id is null then
		raise exception 'Company environment not found' using errcode = 'P0002';
	end if;
	if public.qorpera_company_deleting(v_env.profile_id) then
		raise exception 'Company is being deleted' using errcode = '55000';
	end if;

	select m.role into v_role
	from public.qorpera_profile_members as m
	where m.profile_id = v_env.profile_id and m.user_id = v_uid;
	if v_role is null then
		raise exception 'Company membership is required' using errcode = '42501';
	end if;
	if v_scope not in ('read', 'write') then
		raise exception 'Git token scope must be read or write' using errcode = '22023';
	end if;
	if v_scope = 'write' and v_role not in ('owner', 'admin', 'contributor') then
		raise exception 'Write Git tokens require contributor, admin, or owner role' using errcode = '42501';
	end if;
	if char_length(v_label) not between 1 and 80 or v_label ~ '[[:cntrl:]]' then
		raise exception 'Git token label must be 1 to 80 plain characters' using errcode = '22023';
	end if;
	if v_days not between 1 and 90 then
		raise exception 'Git token expiry must be between 1 and 90 days' using errcode = '22023';
	end if;
	if (v_owner is null) <> (v_name is null) then
		raise exception 'Provide both owner and name when scoping a Git token to one repository' using errcode = '22023';
	end if;
	if v_owner is not null then
		if v_owner !~ '^[a-z0-9][a-z0-9_-]{0,38}$' or v_name !~ '^[a-z0-9_.-]{1,100}$' then
			raise exception 'Repository owner or name is invalid' using errcode = '22023';
		end if;
		if not exists (
			select 1 from public.qorpera_code_repositories as repo
			where repo.environment_id = v_env.id
				and repo.owner = v_owner
				and repo.name = v_name
		) then
			raise exception 'Repository not found in this company' using errcode = 'P0002';
		end if;
	end if;

	perform pg_advisory_xact_lock(hashtextextended('qorpera-code-git-tokens:' || v_env.id::text || ':' || v_uid::text, 0));

	select count(*) into v_active_count
	from public.qorpera_code_git_tokens as tok
	where tok.environment_id = v_env.id
		and tok.user_id = v_uid
		and tok.revoked_at is null
		and tok.expires_at > v_now;
	if v_active_count >= 20 then
		raise exception 'Maximum of 20 active Git tokens per member reached; revoke an unused token first' using errcode = '55000';
	end if;

	v_token := 'qgit_' || replace(replace(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+', '-'), '/', '_');
	v_sha := encode(extensions.digest(convert_to(v_token, 'utf8'), 'sha256'), 'hex');
	v_prefix := left(v_token, 12);

	insert into public.qorpera_code_git_tokens (
		profile_id, environment_id, user_id, label, token_sha256, token_prefix, scope, owner, name, created_at, expires_at
	) values (
		v_env.profile_id, v_env.id, v_uid, v_label, v_sha, v_prefix, v_scope, v_owner, v_name,
		v_now, v_now + make_interval(days => v_days)
	)
	returning * into v_row;

	return jsonb_build_object(
		'id', v_row.id,
		'token', v_token,
		'tokenPrefix', v_row.token_prefix,
		'label', v_row.label,
		'scope', v_row.scope,
		'owner', v_row.owner,
		'name', v_row.name,
		'createdAt', v_row.created_at,
		'expiresAt', v_row.expires_at
	);
end $$;

create function public.qorpera_list_code_git_tokens(p_environment_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
	v_uid uuid := auth.uid();
	v_env public.qorpera_company_environments%rowtype;
	v_role public.qorpera_profile_role;
	v_rows jsonb;
begin
	if v_uid is null then
		raise exception 'Authentication is required' using errcode = '42501';
	end if;
	select * into v_env
	from public.qorpera_company_environments
	where id = p_environment_id;
	if v_env.id is null then
		raise exception 'Company environment not found' using errcode = 'P0002';
	end if;
	select m.role into v_role
	from public.qorpera_profile_members as m
	where m.profile_id = v_env.profile_id and m.user_id = v_uid;
	if v_role is null then
		raise exception 'Company membership is required' using errcode = '42501';
	end if;

	select coalesce(jsonb_agg(jsonb_build_object(
		'id', tok.id,
		'userId', tok.user_id,
		'label', tok.label,
		'tokenPrefix', tok.token_prefix,
		'scope', tok.scope,
		'owner', tok.owner,
		'name', tok.name,
		'createdAt', tok.created_at,
		'expiresAt', tok.expires_at,
		'lastUsedAt', tok.last_used_at,
		'revokedAt', tok.revoked_at
	) order by tok.created_at desc, tok.id desc), '[]'::jsonb)
	into v_rows
	from public.qorpera_code_git_tokens as tok
	where tok.environment_id = v_env.id
		and (v_role in ('owner', 'admin') or tok.user_id = v_uid);

	return v_rows;
end $$;

create function public.qorpera_revoke_code_git_token(p_token_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_uid uuid := auth.uid();
	v_row public.qorpera_code_git_tokens%rowtype;
	v_role public.qorpera_profile_role;
begin
	if v_uid is null then
		raise exception 'Authentication is required' using errcode = '42501';
	end if;
	select * into v_row
	from public.qorpera_code_git_tokens
	where id = p_token_id
	for update;
	if v_row.id is null then
		raise exception 'Git token not found' using errcode = 'P0002';
	end if;
	select m.role into v_role
	from public.qorpera_profile_members as m
	where m.profile_id = v_row.profile_id and m.user_id = v_uid;
	if v_role is null or (v_row.user_id <> v_uid and v_role not in ('owner', 'admin')) then
		raise exception 'Permission denied for Git token revocation' using errcode = '42501';
	end if;

	update public.qorpera_code_git_tokens
	set revoked_at = coalesce(revoked_at, clock_timestamp())
	where id = v_row.id
	returning * into v_row;

	return jsonb_build_object(
		'id', v_row.id,
		'revokedAt', v_row.revoked_at
	);
end $$;

create function public.qorpera_verify_code_git_token(
	p_token_sha256 text,
	p_profile_id uuid,
	p_owner text,
	p_name text,
	p_operation text
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_tok public.qorpera_code_git_tokens%rowtype;
	v_role public.qorpera_profile_role;
	v_owner text := lower(btrim(coalesce(p_owner, '')));
	v_name text := lower(btrim(coalesce(p_name, '')));
	v_op text := lower(btrim(coalesce(p_operation, '')));
	v_repo public.qorpera_code_repositories%rowtype;
	v_now timestamptz := clock_timestamp();
	v_default_branch text;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Git token verification requires service_role' using errcode = '42501';
	end if;
	if p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$'
		or p_profile_id is null
		or v_owner !~ '^[a-z0-9][a-z0-9_-]{0,38}$'
		or v_name !~ '^[a-z0-9_.-]{1,100}$'
		or v_op not in ('read', 'write') then
		raise exception 'Git token is invalid or unavailable' using errcode = '42501';
	end if;

	select * into v_tok
	from public.qorpera_code_git_tokens
	where token_sha256 = p_token_sha256;
	if v_tok.id is null
		or v_tok.profile_id <> p_profile_id
		or v_tok.revoked_at is not null
		or v_tok.expires_at <= v_now
		or public.qorpera_company_deleting(v_tok.profile_id) then
		raise exception 'Git token is invalid or unavailable' using errcode = '42501';
	end if;

	if public.qorpera_company_execution_paused(v_tok.profile_id) then
		raise exception 'Company execution is paused' using errcode = '55000';
	end if;

	select m.role into v_role
	from public.qorpera_profile_members as m
	where m.profile_id = v_tok.profile_id and m.user_id = v_tok.user_id;
	if v_role is null then
		raise exception 'Git token is invalid or unavailable' using errcode = '42501';
	end if;
	if v_op = 'write' and (v_tok.scope <> 'write' or v_role not in ('owner', 'admin', 'contributor')) then
		raise exception 'Git token lacks write scope' using errcode = '42501';
	end if;
	if v_tok.owner is not null and (v_tok.owner <> v_owner or v_tok.name <> v_name) then
		raise exception 'Git token is not scoped to this repository' using errcode = '42501';
	end if;

	select * into v_repo
	from public.qorpera_code_repositories
	where environment_id = v_tok.environment_id
		and owner = v_owner
		and name = v_name;
	if v_repo.environment_id is null then
		raise exception 'Git token is invalid or unavailable' using errcode = '42501';
	end if;

	v_default_branch := coalesce(nullif(btrim(coalesce(v_repo.imported_from ->> 'branch', '')), ''), 'main');

	if v_tok.last_used_at is null or v_tok.last_used_at < v_now - interval '60 seconds' then
		update public.qorpera_code_git_tokens
		set last_used_at = v_now
		where id = v_tok.id;
	end if;

	return jsonb_build_object(
		'allowed', true,
		'tokenId', v_tok.id,
		'companyId', v_tok.profile_id,
		'environmentId', v_tok.environment_id,
		'userId', v_tok.user_id,
		'scope', v_tok.scope,
		'owner', v_repo.owner,
		'name', v_repo.name,
		'defaultBranch', v_default_branch
	);
end $$;

create function public.qorpera_record_git_http_push(
	p_environment_id uuid,
	p_owner text,
	p_name text,
	p_token_id uuid,
	p_main_before text,
	p_main_after text,
	p_pushed_refs jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_owner text := lower(btrim(coalesce(p_owner, '')));
	v_name text := lower(btrim(coalesce(p_name, '')));
	v_repo public.qorpera_code_repositories%rowtype;
	v_tok public.qorpera_code_git_tokens%rowtype;
	v_before text := nullif(lower(btrim(coalesce(p_main_before, ''))), '');
	v_after text := nullif(lower(btrim(coalesce(p_main_after, ''))), '');
	v_refs jsonb := coalesce(p_pushed_refs, '[]'::jsonb);
	v_n integer := null;
	v_ref_list text;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Git HTTP push recording requires service_role' using errcode = '42501';
	end if;
	if p_environment_id is null
		or v_owner !~ '^[a-z0-9][a-z0-9_-]{0,38}$'
		or v_name !~ '^[a-z0-9_.-]{1,100}$'
		or (v_before is not null and v_before !~ '^[0-9a-f]{40}$')
		or (v_after is not null and v_after !~ '^[0-9a-f]{40}$')
		or jsonb_typeof(v_refs) <> 'array' then
		raise exception 'Git HTTP push payload is invalid' using errcode = '22023';
	end if;

	select * into v_repo
	from public.qorpera_code_repositories
	where environment_id = p_environment_id
		and owner = v_owner
		and name = v_name
	for update;
	if v_repo.environment_id is null then
		raise exception 'Repository not found' using errcode = 'P0002';
	end if;

	if p_token_id is not null then
		select * into v_tok
		from public.qorpera_code_git_tokens
		where id = p_token_id and environment_id = p_environment_id;
	end if;

	if v_after is not null and v_before is distinct from v_after then
		if exists (
			select 1 from public.qorpera_code_changes as ch
			where ch.environment_id = v_repo.environment_id
				and ch.owner = v_repo.owner
				and ch.name = v_repo.name
				and ch.main_after = v_after
		) then
			return jsonb_build_object('recorded', false, 'changeNumber', null, 'mainAfter', v_after);
		end if;
		if v_repo.last_main is not null
			and v_before is not null
			and v_repo.last_main is distinct from v_before then
			perform public.qorpera_code_change_found(
				v_repo.environment_id,
				v_repo.owner,
				v_repo.name,
				v_repo.last_main,
				v_before
			);
		end if;
		select string_agg(val, ', ') into v_ref_list
		from (
			select elem as val
			from jsonb_array_elements_text(v_refs) as elem
			limit 10
		) as refs;
		v_n := public.qorpera_code_change_append(
			v_repo.environment_id,
			v_repo.owner,
			v_repo.name,
			jsonb_build_object(
				'kind', 'push',
				'state', 'landed',
				'how', 'fast-forward',
				'main_before', v_before,
				'main_after', v_after,
				'head_sha', v_after,
				'owner_user_id', v_tok.user_id,
				'checks_state', 'not_run',
				'title', left(format('Pushed over Git HTTPS (%s)', coalesce(nullif(v_tok.label, ''), 'token')), 380),
				'summary', left(format(
					'Pushed via Git HTTPS token %s. Updated refs: %s.',
					coalesce(v_tok.token_prefix, 'unknown'),
					coalesce(v_ref_list, 'main')
				), 2000)
			)
		);
		update public.qorpera_code_repositories
		set main_sha = v_after
		where environment_id = v_repo.environment_id
			and owner = v_repo.owner
			and name = v_repo.name;
	end if;

	return jsonb_build_object(
		'recorded', v_n is not null,
		'changeNumber', v_n,
		'mainAfter', v_after
	);
end $$;

create table public.qorpera_surface_ops_action_receipts (
	change_id uuid primary key references public.qorpera_surface_changes(id) on delete cascade,
	job_id uuid not null,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	action_kind text not null check (char_length(action_kind) between 1 and 80),
	result jsonb not null default '{}'::jsonb check (jsonb_typeof(result) = 'object'),
	executed_at timestamptz not null default clock_timestamp()
);

create index qorpera_surface_ops_action_receipts_profile_idx
	on public.qorpera_surface_ops_action_receipts (profile_id, executed_at desc);

alter table public.qorpera_surface_ops_action_receipts enable row level security;
revoke all on public.qorpera_surface_ops_action_receipts
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_queue_surface_ops_mail(
	p_profile_id uuid,
	p_environment_id uuid,
	p_user_id uuid,
	p_send_id uuid,
	p_payload jsonb
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	c_address constant text := '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]{1,64}@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$';
	v_settings public.qorpera_mail_settings%rowtype;
	v_mail public.qorpera_company_mail_outbox%rowtype;
	v_mailbox public.qorpera_company_mailboxes%rowtype;
	v_hook public.qorpera_event_hooks%rowtype;
	v_google public.qorpera_google_mailboxes%rowtype;
	v_to_json jsonb;
	v_cc_json jsonb;
	v_to text[];
	v_cc text[] := '{}';
	v_subject text;
	v_raw_body text;
	v_body text;
	v_from text;
	v_member text;
	v_company text;
	v_from_name text;
	v_now timestamptz := clock_timestamp();
	v_recipients integer;
	v_hour bigint;
	v_day bigint;
	v_next timestamptz;
	v_mail_id uuid := extensions.gen_random_uuid();
	v_thread text;
begin
	if p_user_id is null then
		raise exception 'Outbound email action requires an approving company member' using errcode = '42501';
	end if;
	if not exists (
		select 1 from public.qorpera_profile_members as m
		where m.profile_id = p_profile_id
			and m.user_id = p_user_id
			and m.role in ('owner', 'admin', 'contributor')
	) then
		raise exception 'Only a member who can write in the company sends its email' using errcode = '42501';
	end if;

	if jsonb_typeof(p_payload -> 'to') = 'array' then
		v_to_json := p_payload -> 'to';
	elsif jsonb_typeof(p_payload -> 'to') = 'string' and btrim(p_payload ->> 'to') <> '' then
		v_to_json := jsonb_build_array(p_payload ->> 'to');
	else
		raise exception 'Provide 1 to 10 valid recipient email addresses in to' using errcode = '22023';
	end if;
	if jsonb_typeof(p_payload -> 'cc') = 'array' then
		v_cc_json := p_payload -> 'cc';
	elsif p_payload -> 'cc' is null or jsonb_typeof(p_payload -> 'cc') = 'null' then
		v_cc_json := '[]'::jsonb;
	else
		raise exception 'Provide up to 9 valid cc email addresses' using errcode = '22023';
	end if;
	if jsonb_array_length(v_to_json) not between 1 and 10
		or jsonb_array_length(v_cc_json) > 9
		or exists (
			select 1 from jsonb_array_elements(v_to_json || v_cc_json) as item(value)
			where jsonb_typeof(item.value) <> 'string'
				or char_length(item.value #>> '{}') > 254
				or lower(btrim(item.value #>> '{}')) !~ c_address
		) then
		raise exception 'Mail request is invalid' using errcode = '22023';
	end if;

	v_subject := btrim(coalesce(p_payload ->> 'subject', ''));
	if char_length(v_subject) not between 1 and 200 or v_subject ~ '[[:cntrl:]]' then
		raise exception 'Email subject must be 1 to 200 single-line characters' using errcode = '22023';
	end if;
	v_raw_body := rtrim(coalesce(p_payload ->> 'body', p_payload ->> 'text', ''), E' \t\r\n');
	if char_length(v_raw_body) not between 1 and 20000 or btrim(v_raw_body, E' \t\r\n') = '' then
		raise exception 'Email body must be 1 to 20000 characters' using errcode = '22023';
	end if;

	perform pg_advisory_xact_lock(hashtextextended('qorpera-company-mail:' || p_profile_id::text, 0));

	select * into v_mail
	from public.qorpera_company_mail_outbox
	where profile_id = p_profile_id
		and member_user_id = p_user_id
		and member_send_id = p_send_id;
	if found then
		return jsonb_build_object(
			'action', 'mail.send',
			'outboxId', v_mail.id,
			'thread', v_mail.thread,
			'mailboxId', v_mail.mailbox_id,
			'route', v_mail.route,
			'recipientsTo', to_jsonb(v_mail.recipients_to)
		);
	end if;

	select array_agg(address order by first) into v_to
	from (
		select lower(btrim(item.value #>> '{}')) as address, min(item.n) as first
		from jsonb_array_elements(v_to_json) with ordinality as item(value, n)
		group by 1
	) as listed;
	select coalesce(array_agg(address order by first), '{}') into v_cc
	from (
		select lower(btrim(item.value #>> '{}')) as address, min(item.n) as first
		from jsonb_array_elements(v_cc_json) with ordinality as item(value, n)
		group by 1
	) as listed
	where not address = any(v_to);
	v_recipients := cardinality(v_to) + cardinality(v_cc);
	if v_recipients > 10 then
		raise exception 'Mail request is invalid' using errcode = '22023';
	end if;

	select settings.* into v_settings from public.qorpera_mail_settings as settings;
	if not coalesce(v_settings.enabled and v_settings.sending, false) or v_settings.domain is null then
		raise exception 'Sending company mail is switched off' using errcode = '0A000';
	end if;

	if coalesce(p_payload ->> 'mailboxId', '') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
		select * into v_mailbox
		from public.qorpera_company_mailboxes
		where id = (p_payload ->> 'mailboxId')::uuid
			and profile_id = p_profile_id
			and environment_id = p_environment_id
			and removed_at is null;
		if not found then
			raise exception 'No mailbox of this company has that address' using errcode = '42501';
		end if;
	elsif coalesce(btrim(p_payload ->> 'from'), '') <> '' then
		v_from := lower(btrim(p_payload ->> 'from'));
		if v_from like '%@%' and not exists (
			select 1 from public.qorpera_google_mailboxes as google
			where google.address = v_from and google.removed_at is null
		) then
			if v_from <> split_part(v_from, '@', 1) || '@' || v_settings.domain then
				raise exception 'No mailbox of this company has that address' using errcode = '42501';
			end if;
			v_from := split_part(v_from, '@', 1);
		end if;
		select * into v_mailbox
		from public.qorpera_company_mailboxes
		where (local_part = v_from or id = (
				select google.mailbox_id from public.qorpera_google_mailboxes as google
				where google.address = v_from and google.removed_at is null
			))
			and removed_at is null
			and profile_id = p_profile_id
			and environment_id = p_environment_id;
		if not found then
			raise exception 'No mailbox of this company has that address' using errcode = '42501';
		end if;
	else
		select * into v_mailbox
		from public.qorpera_company_mailboxes
		where profile_id = p_profile_id
			and environment_id = p_environment_id
			and removed_at is null
		order by created_at asc, id asc
		limit 1;
		if not found then
			raise exception 'No active company mailbox is connected for sending email' using errcode = '55000';
		end if;
	end if;

	select * into strict v_hook from public.qorpera_event_hooks where id = v_mailbox.hook_id;
	if v_hook.status <> 'active' then
		raise exception 'The mailbox is paused; resume it to send from it' using errcode = '0A000';
	end if;

	select * into v_google
	from public.qorpera_google_mailboxes
	where mailbox_id = v_mailbox.id and removed_at is null;
	if v_google.mailbox_id is not null and (v_google.paused or v_google.state <> 'live') then
		raise exception 'The mailbox is paused; resume it to send from it' using errcode = '0A000';
	end if;

	if exists (
		select 1 from public.qorpera_company_mailboxes as mailbox
		where mailbox.profile_id = p_profile_id
			and mailbox.removed_at is null
			and (
				exists (
					select 1 from unnest(v_to || v_cc) as recipient
					where recipient = substring(recipient from '^[^@]+') || '@' || v_settings.domain
						and public.qorpera_mail_box_part(recipient) = mailbox.local_part
				)
				or exists (
					select 1 from public.qorpera_google_mailboxes as google, unnest(v_to || v_cc) as recipient
					where google.mailbox_id = mailbox.id
						and google.removed_at is null
						and public.qorpera_google_address_key(recipient) = public.qorpera_google_address_key(google.address)
				)
			)
	) then
		raise exception 'Email to your own company''s mailboxes is refused' using errcode = '42501';
	end if;

	if v_recipients > least(v_settings.company_hourly_recipients, v_settings.company_daily_recipients) then
		raise exception 'The company''s email limits allow % recipients an hour and % a day, fewer than this email has',
			v_settings.company_hourly_recipients, v_settings.company_daily_recipients using errcode = '54000';
	end if;

	select
		coalesce(sum(cardinality(recipients_to) + cardinality(recipients_cc))
			filter (where created_at > v_now - interval '1 hour'), 0),
		coalesce(sum(cardinality(recipients_to) + cardinality(recipients_cc)), 0)
	into v_hour, v_day
	from public.qorpera_company_mail_outbox
	where profile_id = p_profile_id
		and created_at > v_now - interval '1 day'
		and (status <> 'cancelled' or attempt_count > 0);
	if v_hour + v_recipients > v_settings.company_hourly_recipients
		or v_day + v_recipients > v_settings.company_daily_recipients then
		select greatest(
			case when v_hour + v_recipients > v_settings.company_hourly_recipients then (
				select sent.created_at + interval '1 hour' from (
					select created_at, id,
						sum(cardinality(recipients_to) + cardinality(recipients_cc)) over (order by created_at desc, id desc) as newer
					from public.qorpera_company_mail_outbox
					where profile_id = p_profile_id
						and created_at > v_now - interval '1 hour'
						and (status <> 'cancelled' or attempt_count > 0)
				) as sent
				where sent.newer > v_settings.company_hourly_recipients - v_recipients
				order by sent.created_at desc, sent.id desc
				limit 1
			) end,
			case when v_day + v_recipients > v_settings.company_daily_recipients then (
				select sent.created_at + interval '1 day' from (
					select created_at, id,
						sum(cardinality(recipients_to) + cardinality(recipients_cc)) over (order by created_at desc, id desc) as newer
					from public.qorpera_company_mail_outbox
					where profile_id = p_profile_id
						and created_at > v_now - interval '1 day'
						and (status <> 'cancelled' or attempt_count > 0)
				) as sent
				where sent.newer > v_settings.company_daily_recipients - v_recipients
				order by sent.created_at desc, sent.id desc
				limit 1
			) end,
			v_now
		) into v_next;
		raise exception 'The company has emailed the % recipients an hour and % a day its limits allow; this email can go after %',
			v_settings.company_hourly_recipients, v_settings.company_daily_recipients,
			to_char(date_trunc('second', v_next + interval '999999 microseconds') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
			using errcode = '54000';
	end if;

	v_member := public.qorpera_mail_display_name(
		(select member.display_name from public.qorpera_profile_members as member
			where member.profile_id = p_profile_id and member.user_id = p_user_id),
		'A member'
	);
	if v_member like '%@%' then
		v_member := 'A member';
	end if;
	v_company := coalesce(
		nullif(public.qorpera_mail_header_safe_name((select profile.name from public.qorpera_profiles as profile where profile.id = p_profile_id)), ''),
		'the company'
	);
	if public.qorpera_mail_name_reads_as_qorpera(v_member)
		or public.qorpera_mail_name_reads_as_qorpera(v_company)
		or public.qorpera_mail_name_reads_as_qorpera(v_mailbox.local_part) then
		raise exception 'Email that would look like it comes from Qorpera is refused; change your name, the company''s or the mailbox''s'
			using errcode = '42501';
	end if;

	v_from_name := v_member || coalesce(' at ' || public.qorpera_mail_company_short_name(v_company), '');
	v_body := v_raw_body || E'\n\n' || format(
		'Drafted by an AI agent and approved by %s for %s.',
		v_member,
		case when v_company = 'No name yet' then 'a new company' else v_company end
	);
	v_thread := public.qorpera_mail_thread_id(v_mailbox.id, 'mail:' || v_mail_id::text);

	insert into public.qorpera_company_mail_outbox (
		id, thread, profile_id, environment_id, mailbox_id, member_user_id,
		member_send_id, from_name, recipients_to, recipients_cc, subject, body
	) values (
		v_mail_id, v_thread, p_profile_id, p_environment_id, v_mailbox.id, p_user_id,
		p_send_id, v_from_name, v_to, v_cc, v_subject, v_body
	)
	returning * into v_mail;

	perform public.qorpera_mail_thread_note(
		v_thread, p_profile_id, p_environment_id, v_mailbox.id, 'sent',
		v_mail.created_at, v_mail.subject, null, v_to[1], null, null, null
	);

	return jsonb_build_object(
		'action', 'mail.send',
		'outboxId', v_mail.id,
		'thread', v_thread,
		'mailboxId', v_mailbox.id,
		'route', v_mail.route,
		'recipientsTo', to_jsonb(v_to)
	);
end $$;

create function public.qorpera_execute_surface_ops_action(
	p_profile_id uuid,
	p_job_id uuid,
	p_change_id uuid,
	p_lease_token uuid default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_job public.qorpera_surface_jobs%rowtype;
	v_change public.qorpera_surface_changes%rowtype;
	v_existing public.qorpera_surface_ops_action_receipts%rowtype;
	v_approved_ids uuid[];
	v_env_id uuid;
	v_kind text;
	v_payload jsonb;
	v_result jsonb;
	v_mail_action text;
	v_threads text[];
	v_sender text;
	v_trash_existing boolean;
	v_thread_id text;
	v_delivery_id uuid;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Surface ops action execution requires service_role' using errcode = '42501';
	end if;
	if p_profile_id is null or p_job_id is null or p_change_id is null then
		raise exception 'Surface ops action request is invalid' using errcode = '22023';
	end if;

	select * into v_job
	from public.qorpera_surface_jobs
	where id = p_job_id and profile_id = p_profile_id
	for update;
	if v_job.id is null then
		raise exception 'Surface job not found' using errcode = 'P0002';
	end if;
	if v_job.kind <> 'land_change' then
		raise exception 'Surface job is not a land_change job' using errcode = '22023';
	end if;
	if v_job.status <> 'running' then
		raise exception 'Surface job is not running' using errcode = '55000';
	end if;
	if v_job.lease_token is not null and p_lease_token is distinct from v_job.lease_token then
		raise exception 'Surface job lease mismatch' using errcode = '55000';
	end if;

	select coalesce(array_agg(x::uuid), '{}'::uuid[]) into v_approved_ids
	from jsonb_array_elements_text(coalesce(v_job.payload -> 'changeIds', '[]'::jsonb)) as x;
	if not (p_change_id = any(v_approved_ids)) then
		raise exception 'Surface change is not approved on this job' using errcode = '42501';
	end if;

	select * into v_change
	from public.qorpera_surface_changes
	where id = p_change_id
		and profile_id = p_profile_id
		and surface_id = v_job.surface_id
	for update;
	if v_change.id is null then
		raise exception 'Surface change not found for job' using errcode = 'P0002';
	end if;
	if v_change.kind <> 'ops_action' then
		raise exception 'Surface change is not an ops_action' using errcode = '22023';
	end if;
	if v_change.status not in ('merging', 'staged') then
		raise exception 'Surface ops change is not open for landing' using errcode = '55000';
	end if;

	select * into v_existing
	from public.qorpera_surface_ops_action_receipts
	where change_id = p_change_id;
	if v_existing.change_id is not null then
		return jsonb_build_object(
			'status', 'landed',
			'replayed', true,
			'actionKind', v_existing.action_kind,
			'receipt', v_existing.result
		);
	end if;

	if v_change.patch_manifest is null or jsonb_typeof(v_change.patch_manifest) <> 'object' then
		raise exception 'Surface ops change has no valid patch_manifest' using errcode = '22023';
	end if;
	v_kind := lower(btrim(coalesce(v_change.patch_manifest ->> 'actionKind', '')));
	v_payload := coalesce(v_change.patch_manifest -> 'actionPayload', '{}'::jsonb);
	if v_kind = '' or char_length(v_kind) > 80 or jsonb_typeof(v_payload) <> 'object' then
		raise exception 'Surface ops change manifest is invalid' using errcode = '22023';
	end if;

	select env.id into v_env_id
	from public.qorpera_company_environments as env
	where env.profile_id = p_profile_id
	order by env.created_at asc, env.id asc
	limit 1;
	if v_env_id is null then
		raise exception 'Company environment not found' using errcode = 'P0002';
	end if;

	if v_kind = 'noop' then
		v_result := jsonb_build_object('action', 'noop');
	elsif v_kind in (
		'mail.trash', 'mail.restore', 'mail.archive', 'mail.unarchive', 'mail.star', 'mail.unstar',
		'inbox.trash', 'inbox.restore', 'inbox.archive', 'inbox.unarchive', 'inbox.star', 'inbox.unstar'
	) then
		v_mail_action := split_part(v_kind, '.', 2);
		if jsonb_typeof(v_payload -> 'threadIds') = 'array' then
			select array_agg(item) into v_threads
			from jsonb_array_elements_text(v_payload -> 'threadIds') as item;
		elsif jsonb_typeof(v_payload -> 'threadId') = 'string' then
			v_threads := array[v_payload ->> 'threadId'];
		end if;
		v_result := public.qorpera_mail_apply_thread_action(p_profile_id, v_env_id, v_threads, v_mail_action);
	elsif v_kind in ('mail.block_sender', 'inbox.block_sender', 'block_sender') then
		v_sender := v_payload ->> 'sender';
		v_trash_existing := case
			when jsonb_typeof(v_payload -> 'trashExisting') = 'boolean' then (v_payload ->> 'trashExisting')::boolean
			when jsonb_typeof(v_payload -> 'trash_existing') = 'boolean' then (v_payload ->> 'trash_existing')::boolean
			else true
		end;
		v_result := public.qorpera_mail_apply_block_sender(
			p_profile_id, v_env_id, v_sender, v_trash_existing, v_job.requested_by_user_id, null
		);
	elsif v_kind in ('mail.unblock_sender', 'inbox.unblock_sender', 'unblock_sender') then
		v_sender := v_payload ->> 'sender';
		v_result := public.qorpera_mail_apply_unblock_sender(p_profile_id, v_env_id, v_sender);
	elsif v_kind in ('mail.unsubscribe', 'inbox.unsubscribe', 'unsubscribe') then
		v_thread_id := v_payload ->> 'threadId';
		if v_thread_id is null then
			v_thread_id := v_payload ->> 'thread_id';
		end if;
		if coalesce(v_payload ->> 'deliveryId', v_payload ->> 'delivery_id', '') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
			v_delivery_id := coalesce(v_payload ->> 'deliveryId', v_payload ->> 'delivery_id')::uuid;
		end if;
		v_result := public.qorpera_execute_mail_unsubscribe(
			p_profile_id,
			v_env_id,
			v_thread_id,
			v_delivery_id,
			v_job.requested_by_user_id,
			null,
			'surface-ops:' || p_change_id::text,
			null
		);
	elsif v_kind in ('mail.send', 'inbox.send_email', 'send_email', 'send_mail') then
		v_result := public.qorpera_queue_surface_ops_mail(
			p_profile_id, v_env_id, v_job.requested_by_user_id, p_change_id, v_payload
		);
	else
		raise exception 'Unsupported ops action kind: %', left(v_kind, 80) using errcode = '22023';
	end if;

	insert into public.qorpera_surface_ops_action_receipts (
		change_id, job_id, profile_id, action_kind, result
	) values (
		p_change_id, p_job_id, p_profile_id, v_kind, coalesce(v_result, '{}'::jsonb)
	);

	return jsonb_build_object(
		'status', 'landed',
		'replayed', false,
		'actionKind', v_kind,
		'receipt', coalesce(v_result, '{}'::jsonb)
	);
end $$;

select pg_temp.git_ops_tel_patch(
	'public.qorpera_runner_orchestrator_dispatch(uuid,text,text,jsonb)'::regprocedure,
	array[
		$old$		when 'qorpera_surface_complete_publish' then
			return public.qorpera_surface_complete_publish(
				(v_args ->> 'p_job_id')::uuid,
				v_args ->> 'p_status',
				v_args ->> 'p_published_head_sha',
				v_args ->> 'p_error_detail',
				(v_args ->> 'p_lease_token')::uuid
			);$old$,
		$new$		when 'qorpera_surface_complete_publish' then
			return public.qorpera_surface_complete_publish(
				(v_args ->> 'p_job_id')::uuid,
				v_args ->> 'p_status',
				v_args ->> 'p_published_head_sha',
				v_args ->> 'p_error_detail',
				(v_args ->> 'p_lease_token')::uuid
			);
		when 'qorpera_execute_surface_ops_action' then
			return public.qorpera_execute_surface_ops_action(
				(v_args ->> 'p_profile_id')::uuid,
				(v_args ->> 'p_job_id')::uuid,
				(v_args ->> 'p_change_id')::uuid,
				(v_args ->> 'p_lease_token')::uuid
			);$new$
	]
);

create table public.qorpera_app_telemetry_hourly (
	site_id uuid not null references public.qorpera_company_sites(id) on delete cascade,
	deployment_id uuid not null references public.qorpera_company_site_deployments(id) on delete cascade,
	hour timestamptz not null check (hour = date_trunc('hour', hour, 'UTC')),
	requests bigint not null default 0 check (requests >= 0),
	status_2xx bigint not null default 0 check (status_2xx >= 0),
	status_3xx bigint not null default 0 check (status_3xx >= 0),
	status_4xx bigint not null default 0 check (status_4xx >= 0),
	status_5xx bigint not null default 0 check (status_5xx >= 0),
	latency_sum_ms bigint not null default 0 check (latency_sum_ms >= 0),
	latency_p50_ms integer not null default 0 check (latency_p50_ms >= 0),
	latency_p95_ms integer not null default 0 check (latency_p95_ms >= 0),
	latency_max_ms integer not null default 0 check (latency_max_ms >= 0),
	updated_at timestamptz not null default clock_timestamp(),
	primary key (site_id, deployment_id, hour)
);

create index qorpera_app_telemetry_hourly_site_hour_idx
	on public.qorpera_app_telemetry_hourly (site_id, hour desc);

create index qorpera_app_telemetry_hourly_hour_idx
	on public.qorpera_app_telemetry_hourly (hour);

alter table public.qorpera_app_telemetry_hourly enable row level security;
revoke all on public.qorpera_app_telemetry_hourly
	from public, anon, authenticated, service_role, qorpera_secret_broker, qorpera_web_router;

create function public.qorpera_ingest_app_telemetry(p_batch jsonb)
returns integer
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	v_count integer := 0;
begin
	if auth.role() is distinct from 'service_role'
		and session_user not in ('postgres', 'service_role', 'qorpera_web_router') then
		raise exception 'App telemetry ingestion requires service_role' using errcode = '42501';
	end if;
	if p_batch is null or jsonb_typeof(p_batch) <> 'array' then
		raise exception 'Telemetry batch must be a JSON array' using errcode = '22023';
	end if;
	if jsonb_array_length(p_batch) > 500 then
		raise exception 'Telemetry batch exceeds maximum of 500 buckets' using errcode = '22023';
	end if;
	if jsonb_array_length(p_batch) = 0 then
		return 0;
	end if;

	with incoming as (
		select
			(elem ->> 'siteId')::uuid as site_id,
			(elem ->> 'deploymentId')::uuid as deployment_id,
			date_trunc('hour', to_timestamp((elem ->> 'hourUnix')::bigint), 'UTC') as hour,
			greatest(0, (elem ->> 'requests')::bigint) as requests,
			greatest(0, coalesce((elem ->> 'status2xx')::bigint, 0)) as status_2xx,
			greatest(0, coalesce((elem ->> 'status3xx')::bigint, 0)) as status_3xx,
			greatest(0, coalesce((elem ->> 'status4xx')::bigint, 0)) as status_4xx,
			greatest(0, coalesce((elem ->> 'status5xx')::bigint, 0)) as status_5xx,
			greatest(0, coalesce((elem ->> 'latencySumMs')::bigint, 0)) as latency_sum_ms,
			greatest(0, least(2147483647, coalesce((elem ->> 'latencyP50Ms')::bigint, 0)))::integer as latency_p50_ms,
			greatest(0, least(2147483647, coalesce((elem ->> 'latencyP95Ms')::bigint, 0)))::integer as latency_p95_ms,
			greatest(0, least(2147483647, coalesce((elem ->> 'latencyMaxMs')::bigint, 0)))::integer as latency_max_ms
		from jsonb_array_elements(p_batch) as elem
		where jsonb_typeof(elem) = 'object'
			and coalesce(elem ->> 'siteId', '') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
			and coalesce(elem ->> 'deploymentId', '') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
			and coalesce(elem ->> 'hourUnix', '') ~ '^[0-9]{9,12}$'
			and coalesce(elem ->> 'requests', '') ~ '^[1-9][0-9]{0,12}$'
	), aggregated as (
		select
			inc.site_id,
			inc.deployment_id,
			inc.hour,
			sum(inc.requests)::bigint as requests,
			sum(inc.status_2xx)::bigint as status_2xx,
			sum(inc.status_3xx)::bigint as status_3xx,
			sum(inc.status_4xx)::bigint as status_4xx,
			sum(inc.status_5xx)::bigint as status_5xx,
			sum(inc.latency_sum_ms)::bigint as latency_sum_ms,
			round(sum(inc.latency_p50_ms::numeric * inc.requests) / nullif(sum(inc.requests), 0))::integer as latency_p50_ms,
			round(sum(inc.latency_p95_ms::numeric * inc.requests) / nullif(sum(inc.requests), 0))::integer as latency_p95_ms,
			max(inc.latency_max_ms)::integer as latency_max_ms
		from incoming as inc
		join public.qorpera_company_site_deployments as dep
			on dep.id = inc.deployment_id and dep.site_id = inc.site_id
		where inc.hour >= date_trunc('hour', clock_timestamp() - interval '35 days', 'UTC')
			and inc.hour <= date_trunc('hour', clock_timestamp() + interval '1 hour', 'UTC')
		group by inc.site_id, inc.deployment_id, inc.hour
	), upserted as (
		insert into public.qorpera_app_telemetry_hourly (
			site_id, deployment_id, hour,
			requests, status_2xx, status_3xx, status_4xx, status_5xx,
			latency_sum_ms, latency_p50_ms, latency_p95_ms, latency_max_ms, updated_at
		)
		select
			agg.site_id, agg.deployment_id, agg.hour,
			agg.requests, agg.status_2xx, agg.status_3xx, agg.status_4xx, agg.status_5xx,
			agg.latency_sum_ms, agg.latency_p50_ms, agg.latency_p95_ms, agg.latency_max_ms, clock_timestamp()
		from aggregated as agg
		on conflict (site_id, deployment_id, hour) do update set
			requests = public.qorpera_app_telemetry_hourly.requests + excluded.requests,
			status_2xx = public.qorpera_app_telemetry_hourly.status_2xx + excluded.status_2xx,
			status_3xx = public.qorpera_app_telemetry_hourly.status_3xx + excluded.status_3xx,
			status_4xx = public.qorpera_app_telemetry_hourly.status_4xx + excluded.status_4xx,
			status_5xx = public.qorpera_app_telemetry_hourly.status_5xx + excluded.status_5xx,
			latency_sum_ms = public.qorpera_app_telemetry_hourly.latency_sum_ms + excluded.latency_sum_ms,
			latency_p50_ms = round(
				(public.qorpera_app_telemetry_hourly.latency_p50_ms::numeric * public.qorpera_app_telemetry_hourly.requests
					+ excluded.latency_p50_ms::numeric * excluded.requests)
				/ nullif(public.qorpera_app_telemetry_hourly.requests + excluded.requests, 0)
			)::integer,
			latency_p95_ms = round(
				(public.qorpera_app_telemetry_hourly.latency_p95_ms::numeric * public.qorpera_app_telemetry_hourly.requests
					+ excluded.latency_p95_ms::numeric * excluded.requests)
				/ nullif(public.qorpera_app_telemetry_hourly.requests + excluded.requests, 0)
			)::integer,
			latency_max_ms = greatest(public.qorpera_app_telemetry_hourly.latency_max_ms, excluded.latency_max_ms),
			updated_at = clock_timestamp()
		returning 1
	)
	select count(*) into v_count from upserted;

	return v_count;
end $$;

create function public.qorpera_company_numbers_app(
	p_profile_id uuid,
	p_now timestamptz,
	p_question text,
	p_params jsonb
)
returns jsonb
language plpgsql stable set search_path = '' as $$
declare
	c_rows constant integer := 2000;
	v_zone text := public.qorpera_company_numbers_zone(p_profile_id);
	v_now_hour timestamptz := date_trunc('hour', p_now, 'UTC');
	v_takes text[];
	v_key text;
	v_site_slug text;
	v_sites uuid[];
	v_hour_from timestamptz;
	v_hour_to timestamptz;
	v_columns text[];
	v_rows jsonb;
	v_more boolean := false;
begin
	v_takes := case p_question
		when 'app-health' then array['site', 'from', 'to']
		when 'app-latency' then array['site', 'from', 'to']
		when 'app-errors' then array['site', 'from', 'to']
	end;
	if v_takes is null then
		raise exception 'No question qorpera/% that you may read', p_question using errcode = 'P0002';
	end if;
	for v_key in select k from jsonb_object_keys(p_params) as k order by k loop
		if not v_key = any (v_takes) then
			raise exception 'The question takes no :%', left(v_key, 60) using errcode = '22023';
		end if;
	end loop;

	if p_params ? 'site' and jsonb_typeof(p_params -> 'site') <> 'null' then
		if jsonb_typeof(p_params -> 'site') <> 'string' or btrim(p_params ->> 'site') = '' then
			raise exception ':site is a site''s name' using errcode = '22023';
		end if;
		v_site_slug := lower(btrim(p_params ->> 'site'));
		select array_agg(site.id order by site.slug collate "C") into v_sites
		from public.qorpera_company_sites as site
		where site.profile_id = p_profile_id
			and site.kind = 'files'
			and site.slug = v_site_slug;
		if v_sites is null or cardinality(v_sites) = 0 then
			raise exception ':site is not one of the company''s sites' using errcode = '22023';
		end if;
	else
		select coalesce(array_agg(site.id order by site.slug collate "C"), '{}') into v_sites
		from public.qorpera_company_sites as site
		where site.profile_id = p_profile_id
			and site.kind = 'files'
			and site.deployment_kind in ('server', 'hybrid');
	end if;

	v_hour_from := public.qorpera_company_numbers_hour(p_params, 'from', v_zone, false);
	if p_question = 'app-health' then
		v_hour_to := coalesce(
			public.qorpera_company_numbers_hour(p_params, 'to', v_zone, true),
			case when v_hour_from is not null
				then greatest(v_hour_from, least(v_hour_from + interval '719 hours', v_now_hour))
				else v_now_hour
			end
		);
		v_hour_from := coalesce(v_hour_from, v_hour_to - interval '23 hours');
		if v_hour_from > v_hour_to then
			raise exception ':from is after :to' using errcode = '22023';
		end if;
		if v_hour_to - v_hour_from > interval '719 hours' then
			raise exception 'From :from to :to is at most 30 days' using errcode = '22023';
		end if;
	else
		v_hour_to := coalesce(
			public.qorpera_company_numbers_hour(p_params, 'to', v_zone, true),
			case when v_hour_from is not null
				then greatest(v_hour_from, least(v_hour_from + interval '167 hours', v_now_hour))
				else v_now_hour
			end
		);
		v_hour_from := coalesce(v_hour_from, v_hour_to - interval '47 hours');
		if v_hour_from > v_hour_to then
			raise exception ':from is after :to' using errcode = '22023';
		end if;
		if (p_params ->> 'from') ~ '^\d{4}-\d{2}-\d{2}$' and (p_params ->> 'to') ~ '^\d{4}-\d{2}-\d{2}$' then
			if (p_params ->> 'to')::date - (p_params ->> 'from')::date > 6 then
				raise exception 'From :from to :to is at most 7 days' using errcode = '22023';
			end if;
		elsif v_hour_to - v_hour_from > interval '167 hours' then
			raise exception 'From :from to :to is at most 7 days' using errcode = '22023';
		end if;
	end if;

	case p_question
	when 'app-health' then
		v_columns := array['site', 'deployment_kind', 'state', 'requests', 'error_rate_pct', 'avg_ms', 'p95_ms'];
		select jsonb_agg(jsonb_build_array(
			row_data.slug,
			row_data.deployment_kind,
			row_data.state,
			row_data.requests,
			row_data.error_rate_pct,
			row_data.avg_ms,
			row_data.p95_ms
		) order by row_data.slug collate "C")
		into v_rows
		from (
			select
				site.slug,
				site.deployment_kind,
				coalesce(dep.state, 'not_live') as state,
				coalesce(stats.requests, 0) as requests,
				case when coalesce(stats.requests, 0) > 0
					then round((stats.status_5xx * 100.0) / stats.requests, 2)
					else 0
				end as error_rate_pct,
				case when coalesce(stats.requests, 0) > 0
					then round(stats.latency_sum_ms::numeric / stats.requests)::integer
					else 0
				end as avg_ms,
				coalesce(stats.p95_ms, 0) as p95_ms
			from public.qorpera_company_sites as site
			left join public.qorpera_company_site_deployments as dep
				on dep.id = site.live_deployment_id
			left join lateral (
				select
					sum(t.requests)::bigint as requests,
					sum(t.status_5xx)::bigint as status_5xx,
					sum(t.latency_sum_ms)::bigint as latency_sum_ms,
					round(sum(t.latency_p95_ms::numeric * t.requests) / nullif(sum(t.requests), 0))::integer as p95_ms
				from public.qorpera_app_telemetry_hourly as t
				where t.site_id = site.id
					and t.hour between v_hour_from and v_hour_to
			) as stats on true
			where site.id = any (v_sites)
			order by site.slug collate "C"
			limit c_rows + 1
		) as row_data;
	when 'app-latency' then
		v_columns := array['site', 'hour', 'hour_local', 'requests', 'avg_ms', 'p50_ms', 'p95_ms', 'max_ms'];
		select jsonb_agg(jsonb_build_array(
			cell.slug,
			to_char(cell.hour at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
			to_char(cell.hour at time zone v_zone, 'YYYY-MM-DD"T"HH24:MI'),
			cell.requests,
			cell.avg_ms,
			cell.p50_ms,
			cell.p95_ms,
			cell.max_ms
		) order by cell.slug collate "C", cell.hour)
		into v_rows
		from (
			select
				site.slug,
				series.hour,
				coalesce(hour_stats.requests, 0) as requests,
				case when coalesce(hour_stats.requests, 0) > 0
					then round(hour_stats.latency_sum_ms::numeric / hour_stats.requests)::integer
					else 0
				end as avg_ms,
				coalesce(hour_stats.p50_ms, 0) as p50_ms,
				coalesce(hour_stats.p95_ms, 0) as p95_ms,
				coalesce(hour_stats.max_ms, 0) as max_ms
			from public.qorpera_company_sites as site
			cross join generate_series(v_hour_from, v_hour_to, interval '1 hour') as series(hour)
			left join lateral (
				select
					sum(t.requests)::bigint as requests,
					sum(t.latency_sum_ms)::bigint as latency_sum_ms,
					round(sum(t.latency_p50_ms::numeric * t.requests) / nullif(sum(t.requests), 0))::integer as p50_ms,
					round(sum(t.latency_p95_ms::numeric * t.requests) / nullif(sum(t.requests), 0))::integer as p95_ms,
					max(t.latency_max_ms)::integer as max_ms
				from public.qorpera_app_telemetry_hourly as t
				where t.site_id = site.id and t.hour = series.hour
			) as hour_stats on true
			where site.id = any (v_sites)
			order by site.slug collate "C", series.hour
			limit c_rows + 1
		) as cell;
	when 'app-errors' then
		v_columns := array['site', 'hour', 'hour_local', 'requests', 'status_2xx', 'status_4xx', 'status_5xx', 'error_rate_pct'];
		select jsonb_agg(jsonb_build_array(
			cell.slug,
			to_char(cell.hour at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
			to_char(cell.hour at time zone v_zone, 'YYYY-MM-DD"T"HH24:MI'),
			cell.requests,
			cell.status_2xx,
			cell.status_4xx,
			cell.status_5xx,
			cell.error_rate_pct
		) order by cell.slug collate "C", cell.hour)
		into v_rows
		from (
			select
				site.slug,
				series.hour,
				coalesce(hour_stats.requests, 0) as requests,
				coalesce(hour_stats.status_2xx, 0) as status_2xx,
				coalesce(hour_stats.status_4xx, 0) as status_4xx,
				coalesce(hour_stats.status_5xx, 0) as status_5xx,
				case when coalesce(hour_stats.requests, 0) > 0
					then round((hour_stats.status_5xx * 100.0) / hour_stats.requests, 2)
					else 0
				end as error_rate_pct
			from public.qorpera_company_sites as site
			cross join generate_series(v_hour_from, v_hour_to, interval '1 hour') as series(hour)
			left join lateral (
				select
					sum(t.requests)::bigint as requests,
					sum(t.status_2xx)::bigint as status_2xx,
					sum(t.status_4xx)::bigint as status_4xx,
					sum(t.status_5xx)::bigint as status_5xx
				from public.qorpera_app_telemetry_hourly as t
				where t.site_id = site.id and t.hour = series.hour
			) as hour_stats on true
			where site.id = any (v_sites)
			order by site.slug collate "C", series.hour
			limit c_rows + 1
		) as cell;
	end case;

	v_rows := coalesce(v_rows, '[]'::jsonb);
	if jsonb_array_length(v_rows) > c_rows then
		v_more := true;
		v_rows := (
			select jsonb_agg(item.value order by item.place)
			from jsonb_array_elements(v_rows) with ordinality as item(value, place)
			where item.place <= c_rows
		);
	end if;
	return jsonb_build_object('columns', to_jsonb(v_columns), 'rows', v_rows, 'more', v_more);
end $$;

select pg_temp.git_ops_tel_patch(
	'public.qorpera_company_numbers_answer(uuid,uuid,jsonb,text,jsonb)'::regprocedure,
	array[
		$old$	if p_question in ('sites', 'site-now', 'site-hours', 'site-days', 'site-pages') then$old$,
		$new$	if p_question in ('app-health', 'app-latency', 'app-errors') then
		v_body := public.qorpera_company_numbers_app(p_profile_id, v_now, p_question, v_params);
		if not exists (select 1 from public.qorpera_company_sites as site
				where site.profile_id = p_profile_id and site.kind = 'files'
					and site.deployment_kind in ('server', 'hybrid')
					and site.live_deployment_id is not null) then
			raise exception 'Not connected: app server metrics appear once the company deploys a server or hybrid app'
				using errcode = '55000'; end if;
		return v_body || jsonb_build_object(
			'asOf', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
			'etag', left(encode(extensions.digest(convert_to(v_body::text, 'utf8'), 'sha256'), 'hex'), 32));
	end if;
	if p_question in ('sites', 'site-now', 'site-hours', 'site-days', 'site-pages') then$new$
	]
);

revoke all on function
	public.qorpera_create_code_git_token(uuid, text, text, text, text, integer),
	public.qorpera_list_code_git_tokens(uuid),
	public.qorpera_revoke_code_git_token(uuid),
	public.qorpera_verify_code_git_token(text, uuid, text, text, text),
	public.qorpera_record_git_http_push(uuid, text, text, uuid, text, text, jsonb),
	public.qorpera_queue_surface_ops_mail(uuid, uuid, uuid, uuid, jsonb),
	public.qorpera_execute_surface_ops_action(uuid, uuid, uuid, uuid),
	public.qorpera_ingest_app_telemetry(jsonb),
	public.qorpera_company_numbers_app(uuid, timestamptz, text, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker, qorpera_web_router;

grant execute on function
	public.qorpera_create_code_git_token(uuid, text, text, text, text, integer),
	public.qorpera_list_code_git_tokens(uuid),
	public.qorpera_revoke_code_git_token(uuid)
	to authenticated;

grant execute on function
	public.qorpera_verify_code_git_token(text, uuid, text, text, text),
	public.qorpera_record_git_http_push(uuid, text, text, uuid, text, text, jsonb),
	public.qorpera_execute_surface_ops_action(uuid, uuid, uuid, uuid)
	to service_role;

grant execute on function
	public.qorpera_ingest_app_telemetry(jsonb)
	to service_role, qorpera_web_router;

do $$
declare v_changed text;
begin
	select string_agg(p.oid::regprocedure::text, ', ') into v_changed
	from git_ops_tel_before as b
	join pg_proc as p on p.oid = b.oid
	where (to_jsonb(p) - 'prosrc') is distinct from b.fields;
	if v_changed is not null then
		raise exception '20260930940000 changed function metadata on: %', v_changed;
	end if;
end $$;

commit;
