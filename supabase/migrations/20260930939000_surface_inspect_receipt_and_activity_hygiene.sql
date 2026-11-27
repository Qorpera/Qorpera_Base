-- WHY: Keep VM-local coding_run_command receipts (specifically ephemeral /tmp studio-inspect steps) from
-- blocking coding_finish/job completion or leaking failed surface-backed coding runs into Co-Founder chat activity.
set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_list_staff_execution_activity(uuid)') is null
		or to_regprocedure('public.qorpera_activity_hint()') is null
		or to_regprocedure('public.qorpera_folder_begin_run_receipt(jsonb,uuid,text,text,text,boolean)') is null
		or to_regprocedure('public.qorpera_folder_complete_run_job(uuid,text,uuid,text,uuid,uuid,uuid,jsonb)') is null
		or position('20260930925000' in pg_get_functiondef(
			'public.qorpera_list_staff_execution_activity(uuid)'::regprocedure)) = 0
		or position('20260930925000' in pg_get_functiondef(
			'public.qorpera_activity_hint()'::regprocedure)) = 0
		or position('20260930748000' in pg_get_functiondef(
			'public.qorpera_folder_begin_run_receipt(jsonb,uuid,text,text,text,boolean)'::regprocedure)) = 0 then
		raise exception '20260930939000 prerequisites are missing';
	end if;
	if position('20260930939000' in pg_get_functiondef(
		'public.qorpera_list_staff_execution_activity(uuid)'::regprocedure)) > 0
		or position('20260930939000' in pg_get_functiondef(
			'public.qorpera_activity_hint()'::regprocedure)) > 0
		or position('20260930939000' in pg_get_functiondef(
			'public.qorpera_folder_begin_run_receipt(jsonb,uuid,text,text,text,boolean)'::regprocedure)) > 0
		or position('20260930939000' in pg_get_functiondef(
			'public.qorpera_folder_complete_run_job(uuid,text,uuid,text,uuid,uuid,uuid,jsonb)'::regprocedure)) > 0 then
		raise exception '20260930939000 is already applied';
	end if;
end $$;

create temporary table sirah_before as
select p.oid, to_jsonb(p) - 'prosrc' as fields, md5(p.prosrc) as source
from pg_proc as p where p.pronamespace = 'public'::regnamespace;

create function pg_temp.sirah_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_definition text := pg_get_functiondef(p_target);
	v_index integer;
	v_matches integer;
begin
	for v_index in 1 .. coalesce(array_length(p_pairs, 1), 0) by 2 loop
		if p_pairs[v_index] = '' then
			raise exception '20260930939000 empty anchor for %', p_target;
		end if;
		v_matches := (length(v_definition) - length(replace(v_definition, p_pairs[v_index], ''))) / length(p_pairs[v_index]);
		if v_matches <> 1 then
			raise exception '20260930939000 anchor found % time(s) in %, expected 1: %',
				v_matches, p_target, left(p_pairs[v_index], 120);
		end if;
		v_definition := replace(v_definition, p_pairs[v_index], p_pairs[v_index + 1]);
	end loop;
	execute v_definition;
end $$;

select pg_temp.sirah_patch(
	'public.qorpera_list_staff_execution_activity(uuid)'::regprocedure,
	array[
$old$								and not exists (select 1 from public.qorpera_run_operation_receipts as receipt
									where receipt.run_id = run.id and receipt.status in ('executing', 'ambiguous'))$old$,
$new$								-- WHY: 20260930939000 ignores VM-local studio-inspect receipts requiring no company revision when checking activity recovery.
								and not exists (select 1 from public.qorpera_run_operation_receipts as receipt
									where receipt.run_id = run.id and receipt.status in ('executing', 'ambiguous')
										and not (receipt.requires_company_revision is false
											and receipt.logical_operation_key like 'coding_run_command:studio-inspect:%'))$new$
	]
);

select pg_temp.sirah_patch(
	'public.qorpera_activity_hint()'::regprocedure,
	array[
$old$						exists (
							select 1 from public.qorpera_run_operation_receipts as receipt
							where receipt.run_id = run.id and receipt.status in ('executing', 'ambiguous')
						)$old$,
$new$						-- WHY: 20260930939000 ignores VM-local studio-inspect receipts requiring no company revision for activity hints.
						exists (
							select 1 from public.qorpera_run_operation_receipts as receipt
							where receipt.run_id = run.id and receipt.status in ('executing', 'ambiguous')
								and not (receipt.requires_company_revision is false
									and receipt.logical_operation_key like 'coding_run_command:studio-inspect:%')
						)$new$
	]
);

select pg_temp.sirah_patch(
	'public.qorpera_folder_begin_run_receipt(jsonb,uuid,text,text,text,boolean)'::regprocedure,
	array[
$old$	if exists (select 1 from public.qorpera_run_operation_receipts
		where run_id = v_run.id and status in ('executing', 'ambiguous')) then
		raise exception 'run has an unresolved operation' using errcode = '55000'; end if;$old$,
$new$	-- WHY: 20260930939000 keeps failed ephemeral studio-inspect steps from blocking coding_finish or later calls.
	if exists (select 1 from public.qorpera_run_operation_receipts
		where run_id = v_run.id and status in ('executing', 'ambiguous')
			and not (requires_company_revision is false
				and logical_operation_key like 'coding_run_command:studio-inspect:%')) then
		raise exception 'run has an unresolved operation' using errcode = '55000'; end if;$new$
	]
);

select pg_temp.sirah_patch(
	'public.qorpera_folder_complete_run_job(uuid,text,uuid,text,uuid,uuid,uuid,jsonb)'::regprocedure,
	array[
$old$		or exists(select 1 from public.qorpera_run_operation_receipts where run_id = v_run.id and status in ('executing','ambiguous'))$old$,
$new$		-- WHY: 20260930939000 keeps failed ephemeral studio-inspect steps from blocking clean runner job completion.
		or exists(select 1 from public.qorpera_run_operation_receipts where run_id = v_run.id and status in ('executing','ambiguous')
			and not (requires_company_revision is false
				and logical_operation_key like 'coding_run_command:studio-inspect:%'))$new$
	]
);

do $guard$
declare
	v_activity text := pg_get_functiondef('public.qorpera_list_staff_execution_activity(uuid)'::regprocedure);
	v_hint text := pg_get_functiondef('public.qorpera_activity_hint()'::regprocedure);
	v_begin text := pg_get_functiondef('public.qorpera_folder_begin_run_receipt(jsonb,uuid,text,text,text,boolean)'::regprocedure);
	v_complete text := pg_get_functiondef('public.qorpera_folder_complete_run_job(uuid,text,uuid,text,uuid,uuid,uuid,jsonb)'::regprocedure);
	v_owner name;
	v_expected constant regprocedure[] := array[
		'public.qorpera_list_staff_execution_activity(uuid)'::regprocedure,
		'public.qorpera_activity_hint()'::regprocedure,
		'public.qorpera_folder_begin_run_receipt(jsonb,uuid,text,text,text,boolean)'::regprocedure,
		'public.qorpera_folder_complete_run_job(uuid,text,uuid,text,uuid,uuid,uuid,jsonb)'::regprocedure
	];
begin
	if strpos(v_activity, '20260930939000') = 0
		or strpos(v_activity, '20260930925000') = 0
		or strpos(v_activity, '20260930923000') = 0 then
		raise exception '20260930939000 guard failed for qorpera_list_staff_execution_activity';
	end if;
	if strpos(v_hint, '20260930939000') = 0
		or strpos(v_hint, '20260930925000') = 0 then
		raise exception '20260930939000 guard failed for qorpera_activity_hint';
	end if;
	if strpos(v_begin, '20260930939000') = 0
		or strpos(v_begin, '20260930748000') = 0
		or strpos(v_begin, '20260930539000') = 0 then
		raise exception '20260930939000 guard failed for qorpera_folder_begin_run_receipt';
	end if;
	if strpos(v_complete, '20260930939000') = 0 then
		raise exception '20260930939000 guard failed for qorpera_folder_complete_run_job';
	end if;

	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = any(v_expected)
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception '20260930939000 function has an API owner: %', v_owner;
		end if;
	end loop;

	if (select count(*) from pg_temp.sirah_before as prior join pg_proc as patched on patched.oid = prior.oid
			where md5(patched.prosrc) is distinct from prior.source) <> cardinality(v_expected)
		or exists (select 1 from pg_temp.sirah_before as prior left join pg_proc as patched on patched.oid = prior.oid
			where patched.oid is null or to_jsonb(patched) - 'prosrc' is distinct from prior.fields
				or (md5(patched.prosrc) is distinct from prior.source and not (prior.oid = any(v_expected))))
		or exists (select 1 from pg_proc as p where p.pronamespace = 'public'::regnamespace
			and p.oid not in (select prior.oid from pg_temp.sirah_before as prior)) then
		raise exception '20260930939000: catalog changed unexpectedly';
	end if;
end $guard$;

drop function pg_temp.sirah_patch(regprocedure, text[]);
drop table pg_temp.sirah_before;
