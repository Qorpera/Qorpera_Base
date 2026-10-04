-- Minimal Supabase-owned schemas required to execute the Qorpera migrations in
-- a disposable stock PostgreSQL instance. Production Supabase owns these
-- objects; tests only reproduce the contracts referenced by this repository.

create schema extensions;
create extension pgcrypto with schema extensions;
create extension dblink;

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;

create table auth.users (
	id uuid primary key,
	email text,
	email_confirmed_at timestamptz,
	-- Present on real Supabase auth.users; the friends listing reads display
	-- names from it, so the fixture must carry it too.
	raw_user_meta_data jsonb not null default '{}'::jsonb,
	created_at timestamptz not null default statement_timestamp()
);

create function auth.jwt()
returns jsonb
language sql
stable
as $$
	select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

create function auth.uid()
returns uuid
language sql
stable
as $$
	select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

create function auth.role()
returns text
language sql
stable
as $$
	select coalesce(nullif(auth.jwt() ->> 'role', ''), 'anon')
$$;

create schema storage;

create table storage.buckets (
	id text primary key,
	name text not null unique,
	public boolean not null default false,
	file_size_limit bigint,
	allowed_mime_types text[]
);

create table storage.objects (
	id uuid primary key default extensions.gen_random_uuid(),
	bucket_id text not null references storage.buckets(id) on delete cascade,
	name text not null,
	metadata jsonb,
	-- Supabase Storage preserves x-metadata through preflight and final upload.
	user_metadata jsonb,
	created_at timestamptz not null default statement_timestamp(),
	updated_at timestamptz not null default statement_timestamp(),
	unique (bucket_id, name)
);

alter table storage.objects enable row level security;

create function storage.foldername(name text)
returns text[]
language sql
immutable
as $$
	select coalesce(
		array_agg(path_part.value order by path_part.ordinality)
			filter (where path_part.ordinality < array_length(string_to_array(name, '/'), 1)),
		array[]::text[]
	)
	from unnest(string_to_array(name, '/')) with ordinality as path_part(value, ordinality)
$$;

create publication supabase_realtime;

-- Realtime authorization surface: private-channel joins are authorized by
-- evaluating RLS on realtime.messages as the connecting user, with the
-- channel topic exposed through realtime.topic(). Production Supabase owns
-- and partitions this table; the fixture reproduces only the contract the
-- policies exercise.
create schema realtime;

create table realtime.messages (
	id uuid not null default extensions.gen_random_uuid(),
	topic text not null,
	extension text not null,
	payload jsonb,
	event text,
	private boolean default false,
	inserted_at timestamptz not null default statement_timestamp(),
	updated_at timestamptz not null default statement_timestamp(),
	primary key (inserted_at, id)
);

alter table realtime.messages enable row level security;

create function realtime.topic()
returns text
language sql
stable
as $$
	select nullif(current_setting('realtime.topic', true), '')
$$;

-- Broadcast from the database, as the platform defines it: the row is the
-- message, and a failure is only a warning to the caller.
create function realtime.send(payload jsonb, event text, topic text, private boolean default true)
returns void
language plpgsql
as $$
begin
	begin
		execute format('set local realtime.topic to %L', topic);
		insert into realtime.messages (payload, event, topic, private, extension)
		values (payload, event, topic, private, 'broadcast');
	exception
		when others then
			raise warning 'ErrorSendingBroadcastMessage: %', sqlerrm;
	end;
end
$$;

-- Reproduce the platform's default privilege posture so migration-level
-- revokes and RLS policies are exercised the way production exercises them:
-- schemas usable, tables and sequences default-granted (which the protected
-- tables then explicitly revoke). Production also default-grants functions
-- (deploy/first-node/RUNTIME-STEP-1.md, the 2026-08-27 permission audit); the
-- hosted-db cluster (scripts/test-hosted-db-cluster.mjs) adds that with
-- platform-function-defaults.sql, which the scripts that load this file
-- themselves do not yet. Without this block every role-based
-- test would fail on schema access and prove nothing about the actual
-- separation model.
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema storage to anon, authenticated, service_role;
grant execute on all functions in schema extensions to anon, authenticated, service_role;
grant execute on function auth.jwt() to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.role() to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
grant all on storage.objects to authenticated, service_role;
grant select on storage.buckets to authenticated, service_role;
-- Matching the platform posture on realtime.messages: table privileges are
-- broad and the row policies decide — an anon denial must come from policy
-- scope, not a missing grant.
grant usage on schema realtime to anon, authenticated, service_role;
grant execute on function realtime.topic() to anon, authenticated, service_role;
grant select, insert on realtime.messages to anon, authenticated, service_role;
grant execute on function storage.foldername(text) to anon, authenticated, service_role;

-- Test databases only (never a migration): every node the tests observe also reports a healthy agent exit
-- (deploy/agent-exit; migration 20260930052000). From 20260930052100 on, a node without one takes no new Company
-- Computer or agent's machine and no new coding machine, so without this every test that places one would need its
-- own exit report. The node's observation row is the moment: each insert or update of it reports a healthy exit for
-- that node, as current as the observation (a test that ages the observation ages the exit with it). Tests of the exit's health itself switch this off for their transaction with
-- `select set_config('qorpera_test.agent_exit_real', 'on', true);` (supabase/tests/896, 897).
create schema qorpera_test_support;
create function qorpera_test_support.agent_exit_healthy() returns trigger language plpgsql as $$
begin
	if to_regclass('public.qorpera_runtime_node_agent_exit') is not null
		and current_setting('qorpera_test.agent_exit_real', true) is distinct from 'on' then
		insert into public.qorpera_runtime_node_agent_exit (node_id, observation_id, observed_at, checked_at, healthy, problem_count)
		values (new.node_id, extensions.gen_random_uuid(), new.observed_at, new.observed_at, true, 0)
		on conflict (node_id) do update set observation_id = excluded.observation_id, observed_at = excluded.observed_at,
			checked_at = excluded.checked_at, healthy = true, problem_count = 0, received_at = clock_timestamp();
	end if;
	return new;
end
$$;
create function qorpera_test_support.attach_agent_exit_healthy() returns event_trigger language plpgsql as $$
begin
	if exists (select 1 from pg_event_trigger_ddl_commands() c
		where c.command_tag = 'CREATE TABLE' and c.object_identity = 'public.qorpera_runtime_node_observations') then
		create trigger qorpera_test_agent_exit_healthy after insert or update on public.qorpera_runtime_node_observations
			for each row execute function qorpera_test_support.agent_exit_healthy();
		-- Also for the fixtures that write nodes with session_replication_role = replica.
		alter table public.qorpera_runtime_node_observations enable always trigger qorpera_test_agent_exit_healthy;
	end if;
end
$$;
create event trigger qorpera_test_attach_agent_exit_healthy on ddl_command_end when tag in ('CREATE TABLE')
	execute function qorpera_test_support.attach_agent_exit_healthy();
