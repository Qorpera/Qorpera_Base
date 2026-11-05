-- 20260930569000: a coworker message to an agent hired a moment ago says the agent is still starting, not that it
-- cannot receive the sender's context.
--
-- A hire commits the agent's folder; its default grant on the company's shared root, its kickoff input and its first
-- run come from the agent's converge (qorpera_folder_converge_agent) a few seconds later. A message sent in between
-- met the audience check of qorpera_folder_send_coworker_message (qorpera_folder_parent_reads_allowed) with a recipient
-- that could read nothing yet, and was refused 42501 'Coworker audience cannot receive this context'. On 4 November
-- 2026 two Co-Founders (Armbånd.dk 16:27-16:28, Lærdom 16:28) hired and messaged at once, were refused, told their
-- founders the new agents had not started, and one asked the founder to start them by hand. The converges ran 6 to 9
-- seconds after each hire and started the agents anyway. Earlier hires the same day worked because their messages
-- came after the converge.
--
-- Now, when the audience check fails and the recipient is such a hire (no grant of any kind on a live shared root, no
-- first run recorded, and not the Co-Founder, whose first run comes with its creation), the message is refused 55000
-- 'Coworker recipient is still starting' instead. The runtime (cloud-wake-bus.ts, callCoworkerMessage) asks again for
-- up to a minute, so the hirer's message arrives once the converge ran, and otherwise tells the agent the hire is
-- starting on its own. Every other audience refusal is as before.
--
-- Unchanged: who may call, every earlier check, its order and its error; the locks and their order; the receipt (the
-- refusal rolls the whole call back, its receipt begin too, so asking again with the same key is the same message);
-- the tables, grants and data. The new reads are plain reads of qorpera_company_path_resources,
-- qorpera_company_path_grants, qorpera_agent_first_runs and qorpera_company_cofounders.
-- The pre-check refuses unless the body is exactly the one it replaces, by md5 (production's at v198), and the anchor
-- must occur once. The catalog check refuses unless exactly this public function changed, only in its body.
-- Deploy order: either. An older runtime relays the new refusal's text as it relayed the old one.
-- Every inserted text names this migration (20260930569000), for the deploy guard.

do $$
begin
	if exists (select 1 from pg_proc where oid = to_regprocedure(
			'public.qorpera_folder_send_coworker_message(jsonb,uuid,text,text,boolean)') and strpos(prosrc, '20260930569000') > 0) then
		raise exception '20260930569000 is already applied'; end if;
	if md5(coalesce((select prosrc from pg_proc where oid = to_regprocedure(
			'public.qorpera_folder_send_coworker_message(jsonb,uuid,text,text,boolean)')), '')) <> 'cdcc70bcfb8df56e2a77639216406e18' then
		raise exception '20260930569000: qorpera_folder_send_coworker_message differs from its pinned body'; end if;
end $$;

set local lock_timeout = '3s';

create temporary table cw569_before as
select p.oid, to_jsonb(p) - 'prosrc' as fields, md5(p.prosrc) as source, null::text as expected
from pg_proc as p where p.pronamespace = 'public'::regnamespace;

create function pg_temp.cw569_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930569000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	update pg_temp.cw569_before as prior set expected = md5(replace(
		(select p.prosrc from pg_proc as p where p.oid = p_function), p_old, p_new)) where prior.oid = p_function;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.cw569_replace('public.qorpera_folder_send_coworker_message(jsonb,uuid,text,text,boolean)'::regprocedure,
	$old$	if not public.qorpera_folder_parent_reads_allowed(v_audience) then
		raise exception 'Coworker audience cannot receive this context' using errcode = '42501'; end if;
$old$,
	$new$	if not public.qorpera_folder_parent_reads_allowed(v_audience) then
		-- 20260930569000: a hire whose converge has not run yet (no grant on a live shared root, no first run, not the
		-- Co-Founder) is still starting; the runtime asks again. Every other recipient is refused as before.
		if not exists (select 1 from public.qorpera_company_path_resources as root
				join public.qorpera_company_path_grants as g on g.resource_id = root.id
				where root.environment_id = v_run.environment_id and root.path = '' and root.path_match = 'subtree'
					and root.scope = 'company_shared' and root.revoked_at is null
					and g.principal_kind = 'staff_agent' and g.principal_id = p_recipient_staff_id)
			and not exists (select 1 from public.qorpera_agent_first_runs as first
				where first.profile_id = v_run.profile_id and first.staff_agent_id = p_recipient_staff_id)
			and not exists (select 1 from public.qorpera_company_cofounders as cofounder
				where cofounder.profile_id = v_run.profile_id and cofounder.staff_agent_id = p_recipient_staff_id) then
			raise exception 'Coworker recipient is still starting' using errcode = '55000'; end if;
		raise exception 'Coworker audience cannot receive this context' using errcode = '42501'; end if;
$new$);

-- The catalog check: only this function's body changed, by its replacement; no public function came or went.
do $$
begin
	if exists (select 1 from pg_temp.cw569_before as prior
			left join pg_proc as p on p.oid = prior.oid
			where p.oid is null or to_jsonb(p) - 'prosrc' <> prior.fields
				or md5(p.prosrc) <> coalesce(prior.expected, prior.source))
		or exists (select 1 from pg_proc as p where p.pronamespace = 'public'::regnamespace
			and not exists (select 1 from pg_temp.cw569_before as prior where prior.oid = p.oid)) then
		raise exception '20260930569000 changed more than its replacement'; end if;
end $$;

drop table pg_temp.cw569_before;
drop function pg_temp.cw569_replace(regprocedure, text, text);
