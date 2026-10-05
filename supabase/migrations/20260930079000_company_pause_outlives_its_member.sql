-- Deleting an account always works once its companies let it go (coordinator, 5 October 2026).
--
-- Company delete (20260928249150) pauses the company with a row that names the member who asked for the deletion
-- (qorpera_company_execution_pauses.paused_by_user_id). That reference was ON DELETE RESTRICT, so the last member, who
-- deleted their company and was told the company lets its members go (20260928249180), could not delete their own
-- account until the purge: 23503 on qorpera_company_execution_pauses_paused_by_user_id_fkey. The pause belongs to the
-- company, not to the person, so it outlives them: the reference becomes nullable and ON DELETE SET NULL. The company
-- stays paused and its deletion goes on; only the name goes. Nothing reads the column as required: the node update's
-- pause proof (qorpera_node_update_pause_proof) reports it as it is, so a pause whose member left changes the proof and
-- an update in progress asks for its drain again, which is the safe direction.
--
-- The pause table is legacy for members (member-facing execution controls were removed on 24 September); if it goes
-- with the old core in the sweep's steps C or F, this goes with it.

set local lock_timeout = '3s';

-- The pause table first, in the same statement as the change, so the migration never holds auth.users while it waits
-- for a writer of the pause table (as 20260928249180 does; a bare LOCK TABLE fails where each statement commits).
do $$
begin
	lock table public.qorpera_company_execution_pauses in access exclusive mode;
	alter table public.qorpera_company_execution_pauses
		alter column paused_by_user_id drop not null,
		drop constraint qorpera_company_execution_pauses_paused_by_user_id_fkey,
		add constraint qorpera_company_execution_pauses_paused_by_user_id_fkey
			foreign key (paused_by_user_id) references auth.users(id) on delete set null;
end
$$;

comment on column public.qorpera_company_execution_pauses.paused_by_user_id is
	'The member who paused the company (company delete: who asked for the deletion), or null once that account is deleted (20260930079000).';
