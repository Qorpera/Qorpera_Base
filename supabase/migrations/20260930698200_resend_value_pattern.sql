-- 20260930698200: a Resend key's accepted shape is Resend's own (review round 1 of #1581, 9 November 2026). Step 1
-- (20260930695000) took `re_` and 20 to 64 letters, digits or `_`, so a key of lower-case letters alone was accepted,
-- and no guard that cuts a key out of a screen, a tool answer or a context source could tell one from a snake_case name
-- (`re_render_component_tree`). Resend's keys are `re_`, about 8 letters or digits, `_` and about 24 more: the pattern
-- now takes exactly that, with slack (6 to 16, then 16 to 64), so every guard can match the same shape whatever its
-- letters' case and wherever it starts (the runtime's screen guard and tool boundary, and qorpera_redact_webhook_secrets,
-- 20260930698100). A coding value captured under the old shape keeps its versions: only new captures are checked.

do $$
declare v_pattern text := (select known.value_pattern from public.qorpera_coding_value_services as known
	where known.service = 'resend');
begin
	if v_pattern = '^re_[A-Za-z0-9]{6,16}_[A-Za-z0-9]{16,64}$' then
		raise exception '20260930698200 is already applied'; end if;
	if v_pattern is distinct from '^re_[A-Za-z0-9_]{20,64}$' then
		raise exception '20260930698200: the resend pattern differs: %', v_pattern; end if;
end $$;

set local lock_timeout = '3s';

update public.qorpera_coding_value_services
set value_pattern = '^re_[A-Za-z0-9]{6,16}_[A-Za-z0-9]{16,64}$'
where service = 'resend';
