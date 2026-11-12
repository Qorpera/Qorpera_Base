-- A context source's whole text has webhook signing secrets cut out before it is paged (perf sprint T7, 8 Nov 2026;
-- the review of #1528, F5). The runtime cuts whsec_ secrets out of everything it sends Codex, but each excerpt and each
-- read_context page is cut on its own: a secret that an excerpt's end or a page's start cuts in two showed whole across
-- the two parts, neither long enough to match. Cut here, on the source's whole text, no secret is left to split.
-- Every excerpt, page, length and hash is then of the cut text, the same for the context (qorpera_describe_company_run_
-- context), read_context (qorpera_read_company_run_context), a card (qorpera_read_company_run_card) and the review's
-- origin, so read_context's handle and the runtime's checks of a whole source's length and hash hold as before.
-- The rule is the runtime's (`redactCloudWebhookSecrets`, cloud-native-tool-boundary.ts): `whsec_` and base64, also
-- URL-encoded and JSON-escaped once or twice, ten units at least, so a cut text never grows and a cut JSON text
-- (history entries are their event's JSON) stays valid JSON. No bundle has to go first: any runtime reads it.
set local lock_timeout = '3s';

create or replace function public.qorpera_redact_webhook_secrets(p_text text)
returns text language sql immutable strict parallel safe set search_path = '' as $$
	select case when strpos(p_text, 'whsec') = 0 then p_text
		else regexp_replace(p_text,
			'whsec(?:_|%5[Ff]|\\{1,2}u005[Ff])(?:[A-Za-z0-9+/=]|%[0-9A-Fa-f]{2}|\\{1,2}(?:/|u[0-9A-Fa-f]{4})){10,}',
			'whsec_[REDACTED]', 'g') end
$$;
revoke all on function public.qorpera_redact_webhook_secrets(text) from public, anon, authenticated;

do $body$
declare
	v_definition text := pg_get_functiondef(
		'public.qorpera_company_context_source(public.qorpera_execution_runs,text,uuid)'::regprocedure);
	v_old constant text := E'''images'',v_images,''text'',coalesce(v_text,''''));';
	v_new constant text := E'''images'',v_images,\n'
		|| E'\t\t-- 20260930657200: the whole text with webhook signing secrets cut out, before any excerpt or page.\n'
		|| E'\t\t''text'',public.qorpera_redact_webhook_secrets(coalesce(v_text,'''')));';
begin
	if strpos(v_definition, '20260930657200') > 0 then
		raise exception '20260930657200 is already applied'; end if;
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception '20260930657200 anchor differs in qorpera_company_context_source'; end if;
	execute replace(v_definition, v_old, v_new);
end
$body$;
