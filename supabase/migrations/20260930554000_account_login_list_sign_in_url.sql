-- The account logins list says `enabled` only where a sign-in would become an account sign-in (3 November 2026, found
-- by #1403's builder).
--
-- qorpera_list_account_model_logins answered `enabled` when the switch is on and the shared vault serves the company.
-- The sign-in scope (qorpera_model_login_session_scope, 20260930548000) and the linking also need the company to take
-- sign-ins in the vault (qorpera_model_login_sign_in_url). So a company the shared vault serves but that does not take
-- vault sign-ins (its registration not finished, or an operator switched it back to node sign-ins) read `enabled`, and
-- Settings → AI subscriptions began a sign-in there that became a company-only (node) login. Now `enabled` asks the
-- same three things as the scope: the switch, the shared vault and the vault's sign-in address.
--
-- Locks: none (one function body is replaced). Marker 20260930554000.

do $$
declare
	v_target regprocedure := 'public.qorpera_list_account_model_logins(uuid)'::regprocedure;
	v_definition text := pg_get_functiondef(v_target);
	v_anchor text := E'and public.qorpera_company_account_vault(p_profile_id) is not null,';
	v_count integer;
begin
	if position('20260930554000' in v_definition) > 0 then return; end if;
	v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
	if v_count <> 1 then
		raise exception 'qorpera_list_account_model_logins differs from 20260930548000 (% matches)', v_count;
	end if;
	execute replace(v_definition, v_anchor,
		E'and public.qorpera_company_account_vault(p_profile_id) is not null\n'
			|| E'\t\t\t-- 20260930554000: the company takes sign-ins in the vault, as the sign-in scope requires.\n'
			|| E'\t\t\tand public.qorpera_model_login_sign_in_url(p_profile_id) is not null,');
end
$$;
