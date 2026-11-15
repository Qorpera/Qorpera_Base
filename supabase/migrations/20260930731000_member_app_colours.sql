-- 20260930731000: a member's own colours in the apps drawer (Jonas, 12 November 2026: "I would like for all the icons
-- to share the same color as their group" and "you should also be able to change their colors"). A member's own
-- arrangement of the drawer (20260930728000) takes `colours`: an app's or a group's key and one of the agents' palette
-- colours (AGENT_COLOURS in @qorpera/cloud-client). Like the rest of the document it is the member's alone, Reset
-- sidebar counts it and takes it away, and Undo puts it back. No table changes.

create function pg_temp.app_colours_replace(p_function regprocedure, p_old text, p_new text) returns void
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if position('20260930731000' in v_definition) > 0 and position('20260930731000' in p_new) > 0 then
		raise exception '20260930731000 is already in %', p_function; end if;
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '% is not the text 20260930731000 expects at: %', p_function, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- The document's shape: `colours` may stand beside `places` and `groups`.
select pg_temp.app_colours_replace('public.qorpera_member_app_layout_valid(jsonb)'::regprocedure,
	$old$p_layout - array['schema','places','groups'] = '{}'::jsonb$old$,
	$new$p_layout - array['schema','places','groups','colours'] = '{}'::jsonb$new$);
select pg_temp.app_colours_replace('public.qorpera_member_app_layout_valid(jsonb)'::regprocedure,
	$old$				or not (grouped.value ? 'name' or grouped.value ? 'removed' or grouped.value ? 'mine'))$old$,
	$new$				or not (grouped.value ? 'name' or grouped.value ? 'removed' or grouped.value ? 'mine'))
		-- 20260930731000: the member's own colours, absent or an object of at most 300, each a drawer key or a group's
		-- and one of the palette's colours by name.
		and coalesce(jsonb_typeof(p_layout -> 'colours'), 'object') = 'object'
		and (select count(*) from jsonb_object_keys(case when jsonb_typeof(p_layout -> 'colours') = 'object'
			then p_layout -> 'colours' else '{}' end)) <= 300
		and not exists (
			select 1 from jsonb_each(case when jsonb_typeof(p_layout -> 'colours') = 'object'
				then p_layout -> 'colours' else '{}' end) coloured(key, value)
			where coloured.key !~ '^(page:(mailbox|members|bank)|app:[a-z0-9-]{1,64}|concepts|sites|whats-new|group:[a-z0-9-]{1,40})$'
				or jsonb_typeof(coloured.value) is distinct from 'string'
				or coalesce(coloured.value #>> '{}' not in ('charcoal', 'brown', 'coral', 'orange', 'gold', 'green', 'teal',
					'blue', 'purple', 'pink', 'gray'), true))$new$);

-- A document with colours alone is still the member's own; only one with nothing left is no row.
select pg_temp.app_colours_replace('public.qorpera_set_member_app_layout(uuid,jsonb,timestamptz)'::regprocedure,
	$old$	if p_layout -> 'places' = '{}'::jsonb and p_layout -> 'groups' = '{}'::jsonb then$old$,
	$new$	if p_layout -> 'places' = '{}'::jsonb and p_layout -> 'groups' = '{}'::jsonb
		and coalesce(p_layout -> 'colours', '{}'::jsonb) = '{}'::jsonb then -- 20260930731000$new$);

-- Reset sidebar's count: each colour the member chose is one more change.
select pg_temp.app_colours_replace('public.qorpera_sidebar_own_summary(uuid,uuid)'::regprocedure,
	$old$				+ (select count(*) from jsonb_object_keys(layout.layout -> 'groups'))$old$,
	$new$				+ (select count(*) from jsonb_object_keys(layout.layout -> 'groups'))
				-- 20260930731000
				+ (select count(*) from jsonb_object_keys(coalesce(layout.layout -> 'colours', '{}'::jsonb)))$new$);

drop function pg_temp.app_colours_replace(regprocedure, text, text);
