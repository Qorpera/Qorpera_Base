-- 20260930693000: an agent asks for a coding value in its thread (Jonas, 9 November 2026: coding values happen behind
-- the scenes, not in Settings). A coding value is a vault secret with the connector `environment`
-- (20260928549440): a coding session gets it as an environment variable. A secret card that names that connector may
-- now also name the repository whose coding sessions need it, `repository` (owner/name in lower case, as GitHub
-- compares them); the member's browser saves the value and, for an owner or admin, gives the company's value to that
-- repository with the grant call that already exists (qorpera_grant_coding_environment_secret). The card itself
-- carries no value either way.
--
-- The kernel's validator lets `repository` in only beside `connectorId: environment`, and such a card's name must be
-- one a coding value may have (qorpera_coding_environment_name_allowed: no HOME, PATH, GIT_*, a provider's login...),
-- so a card never asks for a value the capture would refuse.

create function pg_temp.secret_card_coding_value_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if position('20260930693000' in v_definition) > 0 then
		raise exception '20260930693000 is already in %', p_function; end if;
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930693000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.secret_card_coding_value_replace('public.qorpera_interaction_request_valid(jsonb)'::regprocedure,
	$old$		return v_payload - 'name' - 'label' - 'purpose' - 'kind' - 'connectorId' = '{}'::jsonb$old$,
	$new$		return v_payload - 'name' - 'label' - 'purpose' - 'kind' - 'connectorId' - /* 20260930693000 */'repository'
				= '{}'::jsonb
			and (not v_payload ? 'repository' or (coalesce(v_payload ->> 'connectorId', '') = 'environment'
				and coalesce(v_payload ->> 'repository', '')
					~ '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?/[a-z0-9_][a-z0-9_.-]{0,99}$'))
			and (coalesce(v_payload ->> 'connectorId', '') <> 'environment'
				or public.qorpera_coding_environment_name_allowed(coalesce(v_payload ->> 'name', '')))$new$);

drop function pg_temp.secret_card_coding_value_replace(regprocedure, text, text);
