-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930657200: a context source's whole text has webhook signing secrets cut out before it is paged, so no excerpt
-- or page boundary can split one into two parts that each pass, and every excerpt's length and hash is of the cut text.
-- The values are made up for this test: never a real secret. The continuation is replaced with one that answers a text
-- with them where the test needs them (its own builders have tests of their own: 519, 848, 892).
select pg_temp.base_claims('service_role');

create or replace function public.qorpera_run_continuation(p_run public.qorpera_execution_runs)
returns jsonb language sql stable security definer set search_path = '' as $$
	select case when current_setting('qorpera_test.t7_text', true) in ('', '0') then null
		else jsonb_build_object('schema', 'qorpera.machine-event-continuation/v1',
			'outputTail', current_setting('qorpera_test.t7_text')) end
$$;

do $$
declare
	b jsonb := current_setting('qorpera_test.base_binding')::jsonb;
	v_run public.qorpera_execution_runs;
	v_fake constant text := 'whsec_' || repeat('T7fakeNotASecret', 2) || '0000';
	v_text text; v_content jsonb; v_page jsonb; v_lead text; v_at integer;
begin
	select * into strict v_run from public.qorpera_execution_runs where id = (b ->> 'runId')::uuid;

	-- The rule, as the runtime's: plain, URL-encoded (inside and in the prefix), JSON-escaped once (\/ as PHP, + as
	-- .NET) and twice (in a JSON string), and not a bare or short whsec_.
	perform pg_temp.base_assert(public.qorpera_redact_webhook_secrets('a ' || v_fake || ' b') = 'a whsec_[REDACTED] b',
		'plain');
	perform pg_temp.base_assert(public.qorpera_redact_webhook_secrets('k=whsec_T7f%2Bake%2FNotASecret%3D%3D;')
		= 'k=whsec_[REDACTED];', 'URL-encoded, an escape in the first ten');
	perform pg_temp.base_assert(public.qorpera_redact_webhook_secrets('k=whsec%5FT7fakeNotASecret;') = 'k=whsec_[REDACTED];',
		'URL-encoded prefix');
	perform pg_temp.base_assert(public.qorpera_redact_webhook_secrets('"whsec_T7f\/akeNotASecret\/AA"')
		= '"whsec_[REDACTED]"', 'JSON-escaped slash');
	perform pg_temp.base_assert(public.qorpera_redact_webhook_secrets('"whsec_T7f+akeNotASecret"')
		= '"whsec_[REDACTED]"', 'JSON-escaped plus');
	perform pg_temp.base_assert(public.qorpera_redact_webhook_secrets('"whsec_T7f\\/ake\\u002BNotASecret"')
		= '"whsec_[REDACTED]"', 'escaped twice, as inside a JSON string');
	perform pg_temp.base_assert(public.qorpera_redact_webhook_secrets('whsec_ whsec_short') = 'whsec_ whsec_short',
		'a bare or short whsec_ stays');

	-- A secret the first excerpt's end (4 KiB) would cut in two: cut out of the whole text first, so neither the excerpt
	-- nor the next page holds a part of it. Where the output starts in the continuation's text is measured first.
	perform set_config('qorpera_test.t7_text', 'T7MARK', true);
	v_at := strpos(public.qorpera_run_continuation(v_run)::text, 'T7MARK') - 1;
	perform set_config('qorpera_test.t7_text', repeat('x', 4090 - v_at) || v_fake || ' ' || repeat('y', 9000), true);
	perform pg_temp.base_assert(strpos(public.qorpera_run_continuation(v_run)::text, v_fake) = 4091,
		'the raw secret straddles 4 KiB');
	v_text := public.qorpera_company_context_source(v_run, 'continuation', v_run.id) ->> 'text';
	perform pg_temp.base_assert(strpos(v_text, 'T7fake') = 0 and strpos(v_text, 'whsec_[REDACTED]') > 0,
		'the whole text is cut');
	perform pg_temp.base_assert(strpos(v_text, 'whsec_[REDACTED]') < 4097
		and strpos(v_text, 'whsec_[REDACTED]') + 16 > 4097, 'the cut stands where the excerpt ends');
	v_content := public.qorpera_describe_company_run_context(b) #> '{continuation,content}';
	v_page := public.qorpera_company_context_excerpt(v_text, (v_content ->> 'nextOffset')::integer, 16384);
	perform pg_temp.base_assert(strpos(v_content ->> 'text', 'T7fake') = 0 and strpos(v_page ->> 'text', 'T7fake') = 0,
		'neither part holds a part of it');
	v_lead := right(v_content ->> 'text', 10) || left(v_page ->> 'text', 10);
	perform pg_temp.base_assert(strpos(v_lead, 'T7') = 0, 'the parts join on the cut: ' || v_lead);
	-- The handle is the cut text's: its length and hash, the same for the context and for each page read_context reads.
	perform pg_temp.base_assert((v_content ->> 'originalBytes')::integer = octet_length(v_text)
		and v_content ->> 'sha256' = encode(extensions.digest(convert_to(v_text, 'utf8'), 'sha256'), 'hex')
		and v_page ->> 'sha256' = v_content ->> 'sha256', 'the handle is the cut text''s');

	-- A continuation without one is the same text as before.
	perform set_config('qorpera_test.t7_text', 'Nothing secret here: whsec_ alone.', true);
	v_text := public.qorpera_company_context_source(v_run, 'continuation', v_run.id) ->> 'text';
	perform pg_temp.base_assert(v_text = public.qorpera_run_continuation(v_run)::text, 'no secret, no change');

	-- The body names its migration.
	perform pg_temp.base_assert(strpos(pg_get_functiondef(
		'public.qorpera_company_context_source(public.qorpera_execution_runs,text,uuid)'::regprocedure), '20260930657200') > 0,
		'the body names its migration');
end
$$;
