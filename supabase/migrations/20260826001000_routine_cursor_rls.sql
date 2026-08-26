-- The routine schedule cursor table shipped without row-level security and
-- with full anon/authenticated grants, so anyone holding the public project
-- key could read or corrupt orchestrator scheduling state (Supabase advisor
-- finding rls_disabled_in_public, 2026-08-23). Its only legitimate consumer
-- is the service-role orchestrator, which bypasses RLS entirely: enabling
-- RLS with no policies and dropping the public grants closes the exposure
-- without touching any working path.

alter table public.qorpera_cloud_routine_schedule_cursors enable row level security;
revoke all on table public.qorpera_cloud_routine_schedule_cursors from anon, authenticated;
