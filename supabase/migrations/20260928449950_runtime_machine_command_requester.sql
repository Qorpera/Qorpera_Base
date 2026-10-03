-- Each machine command records the member its run works for (2026-10-02), as the machine itself does
-- (qorpera_company_machines.requested_by_user_id, 20260928259050): the run identity's requesterUserId. It is
-- attribution only: computer hours are the company's, and members are never billed. The folder on every machine
-- (F3) attributes what a command saves by it; until then nothing reads it. The kernel writes it when it first
-- authorizes the command (qorpera_authorize_machine_command, action start; an idempotent repeat changes nothing). It
-- always equals the requester of the command's own run (a start is refused for any other run), so commands made before
-- this take it from their run and the column is NOT NULL, as the machine's is.
-- The insert's foreign key check takes a KEY SHARE lock on the requester's auth.users row, as the machine's insert
-- already does at the same point; nothing in Qorpera locks auth.users rows otherwise.

set local lock_timeout = '3s';

alter table public.qorpera_company_machine_commands
	add column requested_by_user_id uuid references auth.users(id) on delete restrict;
update public.qorpera_company_machine_commands command set requested_by_user_id = run.requested_by_user_id
from public.qorpera_execution_runs run where run.id = command.run_id;
alter table public.qorpera_company_machine_commands alter column requested_by_user_id set not null;

create function pg_temp.machine_command_requester_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Machine command requester patch differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

select pg_temp.machine_command_requester_patch(
	'public.qorpera_authorize_machine_command(jsonb,jsonb,text,uuid,text,jsonb)'::regprocedure,
	$old$			insert into public.qorpera_company_machine_commands(id, machine_id, run_id, staff_agent_id, placement_id, command_head, notify)
			values (p_command_id, v_machine.id, v_receipt.run_id, (v_identity ->> 'staffAgentId')::uuid, v_placement.id, p_detail ->> 'commandHead',
				(p_detail ->> 'notify')::boolean)
$old$,
	$new$			insert into public.qorpera_company_machine_commands(id, machine_id, run_id, staff_agent_id, placement_id, command_head, notify,
				requested_by_user_id)
			values (p_command_id, v_machine.id, v_receipt.run_id, (v_identity ->> 'staffAgentId')::uuid, v_placement.id, p_detail ->> 'commandHead',
				(p_detail ->> 'notify')::boolean, (v_identity ->> 'requesterUserId')::uuid) -- 20260929361500: the member the run works for
$new$);
