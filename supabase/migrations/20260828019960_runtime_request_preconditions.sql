-- Extend the non-retryable precondition boundary to the active Step 0/2
-- request-version, context, approval and custody APIs. These inputs bind an
-- already selected version/digest/ticket: retrying the identical transaction
-- cannot repair them. Real engine serialization errors and transient storage
-- fences are not rewritten, and the gateway's bounded PT409 head retry stays
-- distinct. A missing company at the shared authority lock is an access denial,
-- not a retryable transaction. Legacy runner/routine APIs are not changed here.
--
-- Rewrite only the reviewed SQLSTATE literal in this closed function set.
-- pg_get_functiondef + CREATE OR REPLACE retains the installed definition,
-- argument defaults, security settings, OID, owner and EXECUTE grants. Fail
-- closed if an expected function or its exact error-code count has drifted.
do $$
declare v_identity text; v_oid regprocedure; v_body text; v_definition text; v_code text;
	v_expected_count integer; v_count integer;
begin
	for v_identity,v_expected_count,v_code in select * from (values
		('public.qorpera_complete_cloud_secret_capture(uuid,text,uuid,text,text,text)',1,'PT412'),
		('public.qorpera_confirm_company_path_read(uuid,jsonb,uuid,integer,text)',1,'PT412'),
		('public.qorpera_decide_member_identity_recovery(uuid,uuid,uuid,text,text,uuid,text)',1,'PT412'),
		('public.qorpera_list_company_paths(uuid,text,text,uuid,integer,jsonb)',1,'PT412'),
		('public.qorpera_read_company_run_context(jsonb,text,uuid,text,integer,integer)',1,'PT412'),
		('public.qorpera_review_company_path_proposal(uuid,text,text)',1,'PT412'),
		('public.qorpera_set_company_path_resource(uuid,text,text,text,text,uuid)',1,'PT412'),
		('public.qorpera_tombstone_profile_staff(uuid,uuid,bigint,uuid,uuid,uuid)',1,'PT412'),
		('public.qorpera_lock_profile_gc_fence(uuid)',1,'42501')
	) as target(identity,expected_count,code) loop
		v_oid := to_regprocedure(v_identity);
		if v_oid is null then raise exception 'Runtime precondition function is unavailable: %',v_identity; end if;
		select prosrc,pg_get_functiondef(oid) into strict v_body,v_definition from pg_proc where oid = v_oid;
		v_count := (length(v_body)-length(replace(v_body,'''40001''','')))/length('''40001''');
		if v_count <> v_expected_count
			or v_body !~ 'using errcode[[:space:]]*=[[:space:]]*''40001'''
			or strpos(v_body,'''PT412''') <> 0 then
			raise exception 'Runtime precondition function differs: %',v_identity;
		end if;
		execute replace(v_definition,'''40001''',quote_literal(v_code));
	end loop;
end
$$;
