-- 20260930334000: the legacy sweep, step D5 (the runner broker's whole-tree actions). The snapshot-v1 runner lane goes
-- (folder-v2 only, the founder's decision of 3 October). C-R1 left the runner worker only the native company lane, C-R6
-- dropped the broker's Company File revision and output publication lanes from the runtime, and C-R8 left the runtime's
-- broker client only a folder-v2 run's description; the runner-broker Edge Function loses the matching actions here.
-- Dropped: the broker's input, transcript, operation and artifact lists, its object checks (input, legacy input, output,
-- Company File object) and output confirmation, its artifact registration, its model gateway reservation and
-- finalization with the sponsor authority only the reservation read, the runner's direct operation receipts (begin and
-- complete), and the runner's company revision lane (prepare, graph begin/append/complete, snapshot, verification
-- authorize/finalize). Most already refused a folder-v2 company, and the runtime's broker client asks for none of them.
-- Nothing outside the set calls them, and no trigger or policy names them.
-- Kept: the broker's describe and locked job, and the native authority actions. The provider session bind and the
-- transcript append stay too: the Edge Function no longer calls them, but folder-v2 run completion, the action review
-- and the runner's agent message do. The tables stay: step E takes the artifacts, step G the rest.
set local lock_timeout = '3s';

-- The runner's object, list, model and receipt actions. ---------------------------------------------------------------

drop function public.qorpera_runner_broker_list_inputs(uuid,text,uuid,text);
drop function public.qorpera_runner_broker_list_transcript(uuid,text,uuid,text,bigint,integer);
drop function public.qorpera_runner_broker_list_operations(uuid,text,uuid,text,bigint,integer);
drop function public.qorpera_runner_broker_list_artifacts(uuid,text,uuid,text,integer,integer);
drop function public.qorpera_runner_broker_authorize_input_object(uuid,text,uuid,text,text);
drop function public.qorpera_runner_broker_authorize_legacy_input_object(uuid,text,uuid,text,text);
drop function public.qorpera_runner_broker_authorize_output_object(uuid,text,uuid,text,text,bigint,text);
drop function public.qorpera_runner_broker_confirm_output_object(uuid,text,uuid,text,text);
drop function public.qorpera_runner_broker_authorize_company_file_object(uuid,text,uuid,text,text,bigint,text);
drop function public.qorpera_runner_broker_register_artifact(uuid,text,uuid,text,uuid,text,text,text,bigint,text);
drop function public.qorpera_runner_broker_reserve_model_request(uuid,text,uuid,text,uuid,text,text,text,bigint,bigint);
drop function public.qorpera_runner_broker_finalize_model_request(uuid,text,uuid,text,uuid,text,text,bigint,bigint,bigint,jsonb,text);
drop function public.qorpera_runner_model_gateway_authority(uuid);
drop function public.qorpera_begin_run_operation_receipt(uuid,text,uuid,text,uuid,uuid,text,text,text,text,boolean);
drop function public.qorpera_complete_run_operation_receipt(uuid,text,uuid,text,uuid,uuid,text,jsonb,uuid,uuid);

-- The runner's company revision lane. ---------------------------------------------------------------------------------

drop function public.qorpera_runner_prepare_company_revision(uuid,text,uuid,text,uuid,uuid,text,integer,integer,integer,bigint);
drop function public.qorpera_runner_begin_company_revision_graph(uuid,text,uuid,text,uuid,uuid,uuid,text,text,integer,bigint);
drop function public.qorpera_runner_append_company_revision_graph(uuid,text,uuid,text,uuid,uuid,jsonb);
drop function public.qorpera_runner_complete_company_revision_graph(uuid,text,uuid,text,uuid,uuid);
drop function public.qorpera_runner_company_revision_snapshot(uuid,text,uuid,text,uuid,uuid);
drop function public.qorpera_runner_authorize_company_revision_verification(uuid,text,uuid,text,uuid,uuid,uuid);
drop function public.qorpera_runner_finalize_company_revision_verification(uuid,text,uuid,text,uuid,uuid,uuid);

-- Nothing that runs may still name them.
do $$
declare v_name text;
begin
	for v_name in select procedure.oid::regprocedure::text from pg_proc procedure
		where procedure.pronamespace = 'public'::regnamespace
			and procedure.prosrc ~ ('qorpera_((begin|complete)_run_operation_receipt'
				'|runner_((append|begin|complete)_company_revision_graph'
				'|(authorize|finalize)_company_revision_verification|company_revision_snapshot|prepare_company_revision'
				'|model_gateway_authority|broker_(authorize_(company_file|input|legacy_input|output)_object'
				'|confirm_output_object|(finalize|reserve)_model_request|list_(artifacts|inputs|operations|transcript)'
				'|register_artifact)))\M')
	loop
		raise exception 'Function % still names the runner broker''s whole-tree lane', v_name;
	end loop;
end $$;
