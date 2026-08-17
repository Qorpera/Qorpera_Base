-- Realtime is an acceleration layer for durable cloud synchronization.
--
-- Shared-session rows are small invalidation records: every durable event
-- append advances updated_at. Profile-staff rows likewise wake the roster
-- synchronizer without streaming company files or trail payloads over the
-- Realtime channel. The persisted polling loops remain the recovery path.

do $$
declare
	v_table text;
begin
	foreach v_table in array array['qorpera_shared_sessions', 'qorpera_profile_staff']
	loop
		if not exists (
			select 1
			from pg_catalog.pg_publication_tables
			where pubname = 'supabase_realtime'
				and schemaname = 'public'
				and tablename = v_table
		) then
			execute format('alter publication supabase_realtime add table public.%I', v_table);
		end if;
	end loop;
end
$$;
