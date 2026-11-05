-- 20260930578000: a question card's option may carry a picture (Jonas, 5 November 2026: a choice between something
-- visual is big boxes to pick from, not a long text). An option's `preview` is a path of the company's folder to an image
-- the agent made, or `app:<name>` for an interface app; the web draws such options as big boxes. The runtime checks its
-- shape before it asks (packages/runtime/src/cloud-thread-interactions.ts); the kernel's validator only lets the key in,
-- as text of at most 512 characters, beside the option's other keys.

create function pg_temp.question_option_previews_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if position('20260930578000' in v_definition) > 0 then
		raise exception '20260930578000 is already in %', p_function; end if;
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930578000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.question_option_previews_replace('public.qorpera_interaction_request_valid(jsonb)'::regprocedure,
	$old$or v_option - 'label' - 'value' - 'description' - 'style' <> '{}'::jsonb$old$,
	$new$or v_option - 'label' - 'value' - 'description' - 'style' - /* 20260930578000 */'preview' <> '{}'::jsonb
				or (v_option ? 'preview' and not public.qorpera_interaction_text_valid(v_option -> 'preview', 1, 512))$new$);

drop function pg_temp.question_option_previews_replace(regprocedure, text, text);
