-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930657100: a run's context shows the first 4 KiB of its continuation again, as before 20260930617000, and
-- read_context reads on from there: its pages pass the tool boundary, which cuts webhook signing secrets out, and this
-- context does not. (It replaces 1104, which pinned 617000's 16 KiB.) The continuation's own builders have tests of
-- their own (519, 848, 892): here the function is replaced with one that answers a text of a chosen length, so this test
-- is only about how much of it the run is shown.
select pg_temp.base_claims('service_role');

create or replace function public.qorpera_run_continuation(p_run public.qorpera_execution_runs)
returns jsonb language sql stable security definer set search_path = '' as $$
	select case when current_setting('qorpera_test.t7_pad', true) in ('', '0') then null
		else jsonb_build_object('schema', 'qorpera.machine-event-continuation/v1', 'pad',
			repeat('x', current_setting('qorpera_test.t7_pad')::integer)) end
$$;

do $$
declare
	b jsonb := current_setting('qorpera_test.base_binding')::jsonb;
	v_content jsonb; v_whole text; v_context jsonb;
begin
	-- No continuation: none shown.
	perform set_config('qorpera_test.t7_pad', '0', true);
	v_context := public.qorpera_describe_company_run_context(b);
	perform pg_temp.base_assert(jsonb_typeof(v_context -> 'continuation') = 'null', 'no continuation: ' || (v_context ->> 'continuation'));

	-- 3 KiB comes whole.
	perform set_config('qorpera_test.t7_pad', '3000', true);
	v_content := public.qorpera_describe_company_run_context(b) #> '{continuation,content}';
	perform pg_temp.base_assert((v_content ->> 'truncated')::boolean = false and v_content -> 'nextOffset' = 'null'::jsonb
		and octet_length(v_content ->> 'text') = (v_content ->> 'originalBytes')::integer,
		'3 KiB comes whole: truncated ' || (v_content ->> 'truncated') || ', ' || octet_length(v_content ->> 'text') || ' bytes');

	-- 9 KiB, which 617000 showed whole: the first 4 KiB, with the handle read_context goes on from.
	perform set_config('qorpera_test.t7_pad', '9000', true);
	v_context := public.qorpera_describe_company_run_context(b);
	v_content := v_context #> '{continuation,content}';
	perform pg_temp.base_assert(octet_length(v_content ->> 'text') = 4096 and (v_content ->> 'truncated')::boolean
		and (v_content ->> 'nextOffset')::integer = 4096 and (v_content ->> 'offset')::integer = 0,
		'9 KiB shows 4 KiB: ' || octet_length(v_content ->> 'text') || ' bytes, next ' || coalesce(v_content ->> 'nextOffset', 'none'));
	v_whole := public.qorpera_run_continuation((select r from public.qorpera_execution_runs r where r.id = (b ->> 'runId')::uuid))::text;
	perform pg_temp.base_assert(v_content ->> 'text' = left(v_whole, 4096)
		and (v_content ->> 'originalBytes')::integer = octet_length(v_whole)
		and v_content ->> 'sha256' = encode(extensions.digest(convert_to(v_whole, 'utf8'), 'sha256'), 'hex'),
		'the excerpt is the start of the same text, with its hash');

	-- 40 KiB: still 4 KiB.
	perform set_config('qorpera_test.t7_pad', '40000', true);
	v_content := public.qorpera_describe_company_run_context(b) #> '{continuation,content}';
	perform pg_temp.base_assert(octet_length(v_content ->> 'text') = 4096 and (v_content ->> 'nextOffset')::integer = 4096,
		'40 KiB shows 4 KiB: ' || octet_length(v_content ->> 'text') || ' bytes');
end
$$;
