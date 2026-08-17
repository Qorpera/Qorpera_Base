-- Minimal Supabase-owned schemas required to execute the Qorpera migrations in
-- a disposable stock PostgreSQL instance. Production Supabase owns these
-- objects; tests only reproduce the contracts referenced by this repository.

create schema extensions;
create extension pgcrypto with schema extensions;

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;

create table auth.users (
	id uuid primary key,
	email text,
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
