-- Company folder core C4, E4b (Q1): a member opens only address hooks on folder-v2 (deploy/first-node/
-- RUNTIME-COMPANY-FOLDER-EVENTS.md §6; decided with the coordinator on 9 October 2026).
--
-- A signed hook needs its signing secret before any delivery can verify, and on folder-v2 only the vault gives it one:
-- E3b's secret, which the company's secret broker makes when an agent opens a GitHub or HMAC hook
-- (qorpera_folder_open_signed_hook), and E3c's, which it takes from Stripe's screen. Members never paste a secret, so a
-- signed hook made by qorpera_create_event_hook would have none and never verify: every sender would be answered
-- not_ready. That call now refuses a signed proof on a folder-v2 company, as the host's manage_hook does and with the
-- same words (0A000): "A Stripe hook comes later: its secret is taken from Stripe's screen", or "A signed hook is opened
-- through the vault" for GitHub and HMAC. The check comes after the request's own checks (a member who is not an owner
-- or admin still gets 42501, a bad proof 22023) and before any lock. Address hooks, mailboxes and the snapshot-v1 branch
-- are unchanged.
--
-- W1b's member capture (qorpera_begin_cloud_secret_capture with connector event_hook) stays snapshot-v1's: on a
-- folder-v2 company it now refuses that connector with 0A000 ("A hook's signing secret comes from the vault"), after
-- its own checks and before any lock, so no member pastes a hook's secret there either, as a new secret or over the
-- vault's. Other connectors are unchanged.
-- Every inserted text names this migration (20260930280000), for the deploy guards.

do $$ begin
	if to_regprocedure('public.qorpera_folder_open_signed_hook(uuid,text,jsonb,jsonb,uuid,uuid,uuid,text,bytea,text)') is null then
		raise exception 'E4b (20260930280000) needs E3b-1 (20260930160000)'; end if;
	if position('20260930280000' in pg_get_functiondef(
		'public.qorpera_create_event_hook(uuid,uuid,text,text,text,integer,integer)'::regprocedure)) > 0 then
		raise exception 'E4b (20260930280000) is already applied'; end if;
end $$;

set local lock_timeout = '3s';

create function pg_temp.e4b_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'E4b anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.e4b_replace('public.qorpera_create_event_hook(uuid,uuid,text,text,text,integer,integer)'::regprocedure,
	$old$	if public.qorpera_environment_is_folder_v2(p_environment_id) then
$old$,
	$new$	if public.qorpera_environment_is_folder_v2(p_environment_id) then
		-- 20260930280000 (E4b): a member opens only an address hook here. A signed hook's secret comes from the vault
		-- (an agent's manage_hook through the company's secret broker; Stripe's from Stripe's screen), and members never
		-- paste one. Refused as the host's manage_hook refuses it, before any lock.
		if p_proof = 'stripe' then
			raise exception 'A Stripe hook comes later: its secret is taken from Stripe''s screen' using errcode = '0A000'; end if;
		if p_proof <> 'address' then
			raise exception 'A signed hook is opened through the vault' using errcode = '0A000'; end if;
$new$);

select pg_temp.e4b_replace('public.qorpera_begin_cloud_secret_capture(uuid,uuid,text,uuid,text,text,text,uuid)'::regprocedure,
	$old$		raise exception 'secret capture scope is invalid' using errcode = '22023';
	end if;
$old$,
	$new$		raise exception 'secret capture scope is invalid' using errcode = '22023';
	end if;
	-- 20260930280000 (E4b): on folder-v2 a hook's signing secret comes only from the vault (an agent's manage_hook, or
	-- Stripe's screen). No member pastes one, as a new secret or over the vault's; refused before any lock.
	if p_connector_id = 'event_hook' and public.qorpera_company_is_folder_v2(p_profile_id) then
		raise exception 'A hook''s signing secret comes from the vault' using errcode = '0A000';
	end if;
$new$);
