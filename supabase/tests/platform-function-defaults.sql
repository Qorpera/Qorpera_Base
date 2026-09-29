-- Supabase's default privileges in production: every new function in public is executable by anon,
-- authenticated and service_role (deploy/first-node/RUNTIME-STEP-1.md, the 2026-08-27 permission audit).
-- scripts/test-hosted-db-cluster.mjs applies this after bootstrap.sql and before the migrations in every
-- database it builds (the SQL suite and the hosted-db scripts), so a function a migration revokes from
-- PUBLIC only stays callable by the API roles here too, as it does in production, and every SQL test sees
-- production's function ACLs (20260929570000; 001_api_function_allowlist).
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
