-- 20260930698100: a context source's whole text has coding value keys cut out too, as webhook signing secrets are
-- (20260930657200), before it is paged (coding value capture, step 2; the coordinator, 9 November 2026). An agent takes
-- npm, GitHub, Stripe and Resend keys into the vault itself (20260930695000) and never sees them; one that reached a
-- source anyway (a command's output, a page an agent read) is cut out of every excerpt and read_context page, as the
-- runtime cuts it out of every tool answer and everything it sends Codex (`redactCloudWebhookSecrets`,
-- cloud-native-tool-boundary.ts, whose rules these are, unit for unit):
-- * `whsec_` and base64, as before;
-- * npm's `npm_` and GitHub's `ghp_` with 36 letters or digits at least, GitHub's `github_pat_` with 82 letters, digits
--   or `_` at least, Stripe's `sk_`/`rk_` with `test_` or `live_` and 24 letters or digits at least, and Resend's `re_`
--   with 20 letters, digits or `_` at least where it starts a word (or follows a JSON escape such as `\n`) and has a
--   capital letter in its first 80 characters, so a snake_case name is never cut.
-- Each `_` may be URL-encoded (`%5F`) or JSON-escaped once or twice (`_`), as a whsec_ prefix may; each cut keeps
-- its prefix and is never longer than what it replaces, and never ends inside an escape, so a cut JSON text stays valid.
-- The function keeps its name and its callers; no bundle has to go first: any runtime reads it.
set local lock_timeout = '3s';

create or replace function public.qorpera_redact_webhook_secrets(p_text text)
returns text language plpgsql immutable strict parallel safe set search_path = '' as $$
declare
	v_text text := p_text;
	v_sep constant text := '(?:_|%5[Ff]|\\{1,2}u005[Ff])';
	v_word constant text := '(?:[A-Za-z0-9_]|%5[Ff]|\\{1,2}u005[Ff])';
begin
	-- 20260930698100: a webhook signing secret (20260930657200), then each coding value key, each only where its prefix
	-- is in the text at all.
	if strpos(v_text, 'whsec') > 0 then
		v_text := regexp_replace(v_text,
			'whsec(?:_|%5[Ff]|\\{1,2}u005[Ff])(?:[A-Za-z0-9+/=]|%[0-9A-Fa-f]{2}|\\{1,2}(?:/|u[0-9A-Fa-f]{4})){10,}',
			'whsec_[REDACTED]', 'g');
	end if;
	if strpos(v_text, 'npm') > 0 then
		v_text := regexp_replace(v_text, 'npm' || v_sep || '[A-Za-z0-9]{36,}', 'npm_[REDACTED]', 'g');
	end if;
	if strpos(v_text, 'ghp') > 0 then
		v_text := regexp_replace(v_text, 'ghp' || v_sep || '[A-Za-z0-9]{36,}', 'ghp_[REDACTED]', 'g');
	end if;
	if strpos(v_text, 'github') > 0 then
		v_text := regexp_replace(v_text, 'github' || v_sep || 'pat' || v_sep || v_word || '{82,}', 'github_pat_[REDACTED]',
			'g');
	end if;
	if strpos(v_text, 'test') > 0 or strpos(v_text, 'live') > 0 then
		v_text := regexp_replace(v_text, '([sr]k)' || v_sep || '(?:test|live)' || v_sep || '[A-Za-z0-9]{24,}',
			'\1_[REDACTED]', 'g');
	end if;
	if strpos(v_text, 're') > 0 then
		v_text := regexp_replace(v_text, '(?:(?<![A-Za-z0-9_])|(?<=\\[nrt]))re' || v_sep || '(?=[A-Za-z0-9_%\\]{0,80}[A-Z])'
			|| v_word || '{20,}', 're_[REDACTED]', 'g');
	end if;
	return v_text;
end
$$;
revoke all on function public.qorpera_redact_webhook_secrets(text) from public, anon, authenticated;

do $guard$ begin
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_redact_webhook_secrets(text)'::regprocedure),
			'20260930698100') = 0 then
		raise exception '20260930698100 marker is missing'; end if;
end $guard$;
