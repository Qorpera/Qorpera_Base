-- Company mail (P6, Q1): Qorpera's own company sends under its own name (design deploy/first-node/RUNTIME-EVENT-INTAKE.md,
-- "Sending (M2b)"). It lands only with the founder's yes.
--
-- Decision 3 of 1 October (20260928319810) refuses a send when the agent's name, the company's name or the mailbox's
-- local part reads as Qorpera, because every company sends from the platform's domain and such mail would look like it
-- comes from the platform. Qorpera itself now runs as a company on the platform, and it is the platform: its mail may
-- say so.
-- * qorpera_mail_settings.own_company_profile_id names that one company. It is null until an operator sets it; the
--   table stays closed to every API role, as before.
-- * qorpera_send_agent_mail skips the company-name and agent-name checks for that company only. The mailbox-name check
--   stays for every company (mailbox names that read as Qorpera stay reserved where a mailbox is made), and every other
--   company whose name or agent's name reads as Qorpera is refused as before.
-- The inserted text names this migration (20260930475000), for the deploy guard.

do $$ begin
	if to_regprocedure('public.qorpera_mail_name_reads_as_qorpera(text)') is null then
		raise exception 'The own company sender (20260930475000) needs the sender names (20260928319810)'; end if;
	if exists (select 1 from pg_attribute where attrelid = 'public.qorpera_mail_settings'::regclass
		and attname = 'own_company_profile_id' and not attisdropped) then
		raise exception 'The own company sender (20260930475000) is already applied'; end if;
end $$;

set local lock_timeout = '3s';

alter table public.qorpera_mail_settings
	add column own_company_profile_id uuid references public.qorpera_profiles(id) on delete set null;
comment on column public.qorpera_mail_settings.own_company_profile_id is
	'Qorpera''s own company: it may send under a company or agent name that reads as Qorpera. Set by operators only.';

create function pg_temp.own_company_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Own company sender integration differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

select pg_temp.own_company_patch('public.qorpera_send_agent_mail(jsonb,text,jsonb)'::regprocedure,
	$old$	-- Nothing goes out as if from Qorpera (founder decision, 1 October 2026).
	if public.qorpera_mail_name_reads_as_qorpera(v_agent) or public.qorpera_mail_name_reads_as_qorpera(v_company)
		or public.qorpera_mail_name_reads_as_qorpera(v_mailbox.local_part) then
$old$,
	$new$	-- Nothing goes out as if from Qorpera (founder decision, 1 October 2026), except from Qorpera's own company, under
	-- its own name and its agents' names (20260930475000). No company sends from a mailbox named after the platform.
	if ((public.qorpera_mail_name_reads_as_qorpera(v_agent) or public.qorpera_mail_name_reads_as_qorpera(v_company))
			and v_run.profile_id is distinct from (select settings.own_company_profile_id
				from public.qorpera_mail_settings as settings))
		or public.qorpera_mail_name_reads_as_qorpera(v_mailbox.local_part) then
$new$);

-- The deploy guard: the patched body carries the marker.
do $guard$ begin
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_send_agent_mail(jsonb,text,jsonb)'::regprocedure),
		'20260930475000') = 0 then
		raise exception 'The own company sender marker is missing in qorpera_send_agent_mail'; end if;
end $guard$;
