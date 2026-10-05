-- Deleting an account always works once its companies let it go (coordinator, 5 October 2026).
--
-- Company delete (20260928249150) pauses the company with a row that names the member who asked for the deletion
-- (qorpera_company_execution_pauses.paused_by_user_id). That reference was ON DELETE RESTRICT, so the last member, who
-- deleted their company and was told the company lets its members go (20260928249180), could not delete their own
-- account until the purge: 23503 on qorpera_company_execution_pauses_paused_by_user_id_fkey. The pause belongs to the
-- company, not to the person, so it outlives them, and so does its record of who paused it: the column keeps its value
-- and loses only the foreign key, as the deletion row's requested_by_user_id never had one. Nulling it instead would
-- change the node update's pause proof (qorpera_node_update_pause_proof names pausedByUserId) under an update whose
-- drain was already authorized, and that authorization cannot be asked for again, so the update would be stranded and
-- its node holdings would keep the company from its purge. Keeping the value keeps the proof as it was.
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
		drop constraint qorpera_company_execution_pauses_paused_by_user_id_fkey;
end
$$;

comment on column public.qorpera_company_execution_pauses.paused_by_user_id is
	'The member who paused the company (company delete: who asked for the deletion). No foreign key: the record outlives a deleted account, and the node update pause proof keeps naming it (20260930079000).';
