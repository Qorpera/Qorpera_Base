-- The company data store's logins and its template database (deploy/first-node/RUNTIME-COMPANY-DATABASES.md §2). Run
-- once on a new server, as its superuser, in the database `postgres`, with psql:
--   psql -v ON_ERROR_STOP=1 -v admin_password=… -v owner_password=… -v write_password=… -v read_password=…
--        -v watch_password=… -f cluster.sql
-- Then run template.sql inside `qorpera_company_template`.
--
-- The gateway is the only thing that holds these logins. Each of the three doors is a member only of the company
-- roles of its own kind and inherits nothing: a statement that runs as a company's read role cannot become its
-- write or owner role, and cannot go back to a login that could.

-- Makes and drops company databases and their roles; used for nothing else. It takes each role it makes so it can
-- hand the role's schema to it.
create role qorpera_data_admin login createdb createrole password :'admin_password';
alter role qorpera_data_admin set createrole_self_grant = 'set, inherit';
-- Runs steps as a database folder's owner role, and keeps the gateway's own records.
create role qorpera_data_owner login noinherit password :'owner_password';
-- Runs named changes as a database folder's write role.
create role qorpera_data_write login noinherit password :'write_password';
-- Runs questions as a database folder's read role.
create role qorpera_data_read login noinherit password :'read_password';
-- Reads sizes and running statements, and ends what runs too long.
create role qorpera_data_watch login password :'watch_password' in role pg_signal_backend, pg_read_all_stats;

-- What a statement may use, whichever company role it runs as: a role's own settings apply only when it logs in, and
-- the company roles never do. A login cannot lift its temp file limit.
alter role qorpera_data_owner set temp_file_limit = '256MB';
alter role qorpera_data_write set temp_file_limit = '256MB';
alter role qorpera_data_read set temp_file_limit = '256MB';
alter role qorpera_data_owner set work_mem = '16MB';
alter role qorpera_data_write set work_mem = '16MB';
alter role qorpera_data_read set work_mem = '16MB';
alter role qorpera_data_owner set max_parallel_workers_per_gather = 0;
alter role qorpera_data_write set max_parallel_workers_per_gather = 0;
alter role qorpera_data_read set max_parallel_workers_per_gather = 0;

revoke connect on database postgres from public;
grant connect on database postgres to qorpera_data_admin, qorpera_data_watch;

create database qorpera_company_template;
