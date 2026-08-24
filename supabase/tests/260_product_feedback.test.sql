insert into auth.users (id, email, email_confirmed_at)
values (
	'90000000-0000-4000-8000-000000000001',
	'feedback-owner@example.test',
	statement_timestamp()
)
on conflict (id) do nothing;

select set_config(
	'request.jwt.claims',
	'{"sub":"90000000-0000-4000-8000-000000000001","email":"feedback-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;

do $$
declare
	v_first uuid;
	v_duplicate uuid;
begin
	v_first := public.qorpera_submit_product_feedback(
		'90000000-0000-4000-8000-000000000002',
		'bug',
		'  Feedback regression report.  ',
		false,
		'{"operatingSystem":"must be discarded"}'::jsonb
	);
	v_duplicate := public.qorpera_submit_product_feedback(
		'90000000-0000-4000-8000-000000000002',
		'bug',
		'An idempotent retry does not replace the original report.',
		true,
		'{"operatingSystem":"test"}'::jsonb
	);
	if v_first <> v_duplicate then
		raise exception 'feedback retry was not idempotent';
	end if;
	perform set_config('qorpera_test.feedback_id', v_first::text, false);
end
$$;

reset role;
select set_config('request.jwt.claims', '', false);

do $$
begin
	if to_regclass('public.qorpera_product_feedback') is null
		or to_regprocedure('public.qorpera_submit_product_feedback(uuid,text,text,boolean,jsonb)') is null then
		raise exception 'feedback storage or submission RPC is missing';
	end if;
	if has_table_privilege('anon', 'public.qorpera_product_feedback', 'SELECT')
		or has_table_privilege('authenticated', 'public.qorpera_product_feedback', 'SELECT')
		or has_table_privilege('authenticated', 'public.qorpera_product_feedback', 'INSERT') then
		raise exception 'feedback inbox table is exposed to API roles';
	end if;
	if has_function_privilege(
		'anon',
		'public.qorpera_submit_product_feedback(uuid,text,text,boolean,jsonb)',
		'EXECUTE'
	) or not has_function_privilege(
		'authenticated',
		'public.qorpera_submit_product_feedback(uuid,text,text,boolean,jsonb)',
		'EXECUTE'
	) then
		raise exception 'feedback submission RPC grants are invalid';
	end if;
	if (
		select count(*)
		from public.qorpera_product_feedback as feedback
		where feedback.id = current_setting('qorpera_test.feedback_id')::uuid
			and feedback.user_id = '90000000-0000-4000-8000-000000000001'
			and feedback.details = 'Feedback regression report.'
			and feedback.include_diagnostics is false
			and feedback.diagnostics = '{}'::jsonb
	) <> 1 then
		raise exception 'feedback report was not stored with the expected privacy boundary';
	end if;
end
$$;
