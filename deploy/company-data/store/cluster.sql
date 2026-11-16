-- The company data store's logins and its template database (deploy/first-node/RUNTIME-COMPANY-DATABASES.md §2). Run
-- once on a new server, as its superuser, in the database `postgres`, with psql:
--   psql -v ON_ERROR_STOP=1 -v admin_password=… -v keeper_password=… -v watch_password=… -f cluster.sql
-- Then run template.sql inside `qorpera_company_template`.
--
-- The gateway is the only thing that holds these logins. A company's SQL never runs on one of them: each database
-- folder has its own three logins (owner, write, read), made by the admin when the gateway makes the folder, each a
-- member of nothing. PostgreSQL checks SET ROLE against the session's login, so a session of one folder can switch to
-- no other folder's role.

-- Makes and drops company databases and their folders' logins; used for nothing else. It takes each role it makes so
-- it can hand the role's schema to it, and may set a company database's temp file limit.
create role qorpera_data_admin login createdb createrole password :'admin_password';
alter role qorpera_data_admin set createrole_self_grant = 'set, inherit';
grant set on parameter temp_file_limit to qorpera_data_admin;
-- And keep a company's errors, statements and their context out of the server's log: they carry the company's values
-- (gateway.mjs, LOG_SETTINGS, says why each). A company's errors reach the caller through the gateway, and the watcher
-- sees slow statements.
grant set on parameter log_min_messages, log_error_verbosity, log_min_error_statement, log_statement, log_min_duration_statement,
	log_min_duration_sample, log_transaction_sample_rate, log_lock_waits, log_temp_files to qorpera_data_admin;
-- The gateway's own records in each company's database (its folders, the steps it applied, the texts it holds by
-- hash) and its LISTEN. It never runs a company's SQL, and is a member of nothing.
create role qorpera_data_keeper login noinherit password :'keeper_password';
-- Reads sizes and running statements, and ends what runs too long.
create role qorpera_data_watch login password :'watch_password' in role pg_signal_backend, pg_read_all_stats;
create role qorpera_data_recorder nologin;

revoke connect on database postgres from public;
grant connect on database postgres to qorpera_data_admin, qorpera_data_watch;

create database qorpera_company_template;
