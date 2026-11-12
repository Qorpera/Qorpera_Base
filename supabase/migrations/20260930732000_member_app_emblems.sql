-- 20260930732000: a member's own icons in the apps drawer (Jonas, 12 November 2026: "change the icons of the
-- interfaces and have a generate icon button too"; design page 6gSTTCcz3D8AjBpV3GmrH6, "yes, perfect"). A member's own
-- arrangement of the drawer (20260930728000, colours since 20260930731000) takes `emblems`: an app's key and the icon
-- the member picked for it, a built-in emblem's name or `custom:<id>`, one of the app's own icons
-- (`apps/<name>/icons/<id>.svg`). The web draws only names it knows; a group keeps its stacked cards, so no group key.
-- Like the rest of the document it is the member's alone, Reset sidebar counts it and takes it away, and Undo puts it
-- back. No table changes.

create function pg_temp.app_emblems_replace(p_function regprocedure, p_old text, p_new text) returns void
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if position('20260930732000' in v_definition) > 0 and position('20260930732000' in p_new) > 0 then
		raise exception '20260930732000 is already in %', p_function; end if;
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '% is not the text 20260930732000 expects at: %', p_function, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.app_emblems_replace('public.qorpera_member_app_layout_valid(jsonb)'::regprocedure,
	$old$p_layout - array['schema','places','groups','colours'] = '{}'::jsonb$old$,
	$new$p_layout - array['schema','places','groups','colours','emblems'] = '{}'::jsonb$new$);
select pg_temp.app_emblems_replace('public.qorpera_member_app_layout_valid(jsonb)'::regprocedure,
	$old$				or coalesce(coloured.value #>> '{}' not in ('charcoal', 'brown', 'coral', 'orange', 'gold', 'green', 'teal',
					'blue', 'purple', 'pink', 'gray'), true))$old$,
	$new$				or coalesce(coloured.value #>> '{}' not in ('charcoal', 'brown', 'coral', 'orange', 'gold', 'green', 'teal',
					'blue', 'purple', 'pink', 'gray'), true))
		-- 20260930732000: the member's own icons, absent or an object of at most 300, each an app's key (no group's) and a
		-- built-in emblem's name or custom:<id>.
		and coalesce(jsonb_typeof(p_layout -> 'emblems'), 'object') = 'object'
		and (select count(*) from jsonb_object_keys(case when jsonb_typeof(p_layout -> 'emblems') = 'object'
			then p_layout -> 'emblems' else '{}' end)) <= 300
		and not exists (
			select 1 from jsonb_each(case when jsonb_typeof(p_layout -> 'emblems') = 'object'
				then p_layout -> 'emblems' else '{}' end) chosen(key, value)
			where chosen.key !~ '^(page:(mailbox|members|bank)|app:[a-z0-9-]{1,64}|concepts|sites|whats-new)$'
				or jsonb_typeof(chosen.value) is distinct from 'string'
				or coalesce(chosen.value #>> '{}' !~ '^(custom:[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?|[a-z]{2,20})$', true))$new$);

select pg_temp.app_emblems_replace('public.qorpera_set_member_app_layout(uuid,jsonb,timestamptz)'::regprocedure,
	$old$		and coalesce(p_layout -> 'colours', '{}'::jsonb) = '{}'::jsonb then -- 20260930731000$old$,
	$new$		and coalesce(p_layout -> 'colours', '{}'::jsonb) = '{}'::jsonb
		and coalesce(p_layout -> 'emblems', '{}'::jsonb) = '{}'::jsonb then -- 20260930731000, 20260930732000$new$);

select pg_temp.app_emblems_replace('public.qorpera_sidebar_own_summary(uuid,uuid)'::regprocedure,
	$old$				+ (select count(*) from jsonb_object_keys(coalesce(layout.layout -> 'colours', '{}'::jsonb)))$old$,
	$new$				+ (select count(*) from jsonb_object_keys(coalesce(layout.layout -> 'colours', '{}'::jsonb)))
				-- 20260930732000
				+ (select count(*) from jsonb_object_keys(coalesce(layout.layout -> 'emblems', '{}'::jsonb)))$new$);

drop function pg_temp.app_emblems_replace(regprocedure, text, text);
