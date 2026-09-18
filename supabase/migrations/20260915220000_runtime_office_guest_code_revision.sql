-- Guest-code software revisions: a signed statement may list a closed set of
-- guest code entries (root control bundles, image installer, browser child,
-- screen helpers, browser policy) replaced next to the service in place.
-- The database keeps the service-only invariants for everything else: the
-- inventory outside the listed entries stays the image's own build, revisions
-- store the service specification without the file list (the package manifest
-- digest already binds the whole inventory), and a receipt must carry exactly
-- the installed entries. Existing reviewed functions are patched in place.
create function public.qorpera_office_software_guest_code_entry(p_file text)
returns jsonb language sql immutable set search_path='' as $$
 select case p_file
  when 'qorpera-company-computer-preparation.mjs' then jsonb_build_object('path','/opt/qorpera-office/qorpera-company-computer-preparation.mjs','mode',292)
  when 'qorpera-company-computer-preparation-control.mjs' then jsonb_build_object('path','/opt/qorpera-office/qorpera-company-computer-preparation-control.mjs','mode',292)
  when 'qorpera-company-computer-configuration-control.mjs' then jsonb_build_object('path','/opt/qorpera-office/qorpera-company-computer-configuration-control.mjs','mode',292)
  when 'qorpera-company-computer-boot-configuration-control.mjs' then jsonb_build_object('path','/opt/qorpera-office/qorpera-company-computer-boot-configuration-control.mjs','mode',292)
  when 'qorpera-company-computer-boot-service-start-control.mjs' then jsonb_build_object('path','/opt/qorpera-office/qorpera-company-computer-boot-service-start-control.mjs','mode',292)
  when 'qorpera-company-computer-boot-service-restart-control.mjs' then jsonb_build_object('path','/opt/qorpera-office/qorpera-company-computer-boot-service-restart-control.mjs','mode',292)
  when 'qorpera-company-computer-service-start-control.mjs' then jsonb_build_object('path','/opt/qorpera-office/qorpera-company-computer-service-start-control.mjs','mode',292)
  when 'qorpera-company-computer-service-stop-control.mjs' then jsonb_build_object('path','/opt/qorpera-office/qorpera-company-computer-service-stop-control.mjs','mode',292)
  when 'qorpera-company-computer-service-restart-control.mjs' then jsonb_build_object('path','/opt/qorpera-office/qorpera-company-computer-service-restart-control.mjs','mode',292)
  when 'qorpera-company-computer-reset-configuration-control.mjs' then jsonb_build_object('path','/opt/qorpera-office/qorpera-company-computer-reset-configuration-control.mjs','mode',292)
  when 'qorpera-company-computer-reset-service-start-control.mjs' then jsonb_build_object('path','/opt/qorpera-office/qorpera-company-computer-reset-service-start-control.mjs','mode',292)
  when 'qorpera-company-computer-reset-service-restart-control.mjs' then jsonb_build_object('path','/opt/qorpera-office/qorpera-company-computer-reset-service-restart-control.mjs','mode',292)
  when 'qorpera-office-image-install.cjs' then jsonb_build_object('path','/opt/qorpera-office/qorpera-office-image-install.cjs','mode',292)
  when 'office-browser-child.mjs' then jsonb_build_object('path','/usr/local/lib/qorpera/office-browser-child.mjs','mode',292)
  when 'qorpera-screen-session' then jsonb_build_object('path','/usr/local/bin/qorpera-screen-session','mode',365)
  when 'qorpera-screen-xfce' then jsonb_build_object('path','/usr/local/bin/qorpera-screen-xfce','mode',365)
  when 'qorpera-screen-browser' then jsonb_build_object('path','/usr/local/bin/qorpera-screen-browser','mode',365)
  when 'qorpera-browser-policy.json' then jsonb_build_object('path','/usr/local/share/qorpera/browser-policy.json','mode',292)
  else null end $$;
-- A file list: 1..64 unique closed entries with their contract path and mode.
create function public.qorpera_office_software_files(p_value jsonb)
returns void language plpgsql immutable set search_path='' as $$
declare e jsonb; k jsonb; n int;
begin
 if jsonb_typeof(p_value) is distinct from 'array' or jsonb_array_length(p_value)<1 or jsonb_array_length(p_value)>64 then
  raise exception 'Invalid office software file list' using errcode='22023'; end if;
 select count(distinct x->>'file') into n from jsonb_array_elements(p_value) x;
 if n<>jsonb_array_length(p_value) then raise exception 'Invalid office software file list' using errcode='22023'; end if;
 for e in select * from jsonb_array_elements(p_value) loop
  perform public.qorpera_office_software_object(e,array['file','path','bytes','sha256','mode']);
  perform public.qorpera_office_software_strings(e,array['file','path','sha256']);
  k:=public.qorpera_office_software_guest_code_entry(e->>'file');
  if k is null or e->'path' is distinct from k->'path' or e->'mode' is distinct from k->'mode'
   or jsonb_typeof(e->'bytes') is distinct from 'number' or e->>'bytes' !~ '^[1-9][0-9]{0,7}$' or (e->>'bytes')::bigint>33554432 then
   raise exception 'Invalid office software file entry' using errcode='22023'; end if;
  perform public.qorpera_office_software_sha(e->>'sha256');
 end loop;
end $$;
-- A specification (previous inventory) may carry the file list of a guest-code revision.
create or replace function public.qorpera_office_software_specification(p_value jsonb)
returns void language plpgsql immutable set search_path='' as $$
begin
 if p_value ? 'files' then
  perform public.qorpera_office_software_object(p_value,array['packageManifestSha256','sourceCommit','service','files']);
  perform public.qorpera_office_software_files(p_value->'files');
 else
  perform public.qorpera_office_software_object(p_value,array['packageManifestSha256','sourceCommit','service']);
 end if;
 perform public.qorpera_office_software_strings(p_value,array['packageManifestSha256','sourceCommit']);
 perform public.qorpera_office_software_sha(p_value->>'packageManifestSha256');
 if coalesce(p_value->>'sourceCommit','') !~ '^[0-9a-f]{40}$' then raise exception 'Invalid office software source' using errcode='22023'; end if;
 perform public.qorpera_office_software_artifact(p_value->'service');
end $$;
create function public.qorpera_office_software_next(p_value jsonb)
returns void language plpgsql immutable set search_path='' as $$
begin
 if p_value ? 'files' then
  perform public.qorpera_office_software_object(p_value,array['packageManifestSha256','service','files']);
  perform public.qorpera_office_software_files(p_value->'files');
 else
  perform public.qorpera_office_software_object(p_value,array['packageManifestSha256','service']);
 end if;
 perform public.qorpera_office_software_strings(p_value,array['packageManifestSha256']);
end $$;
-- The change kind a statement must declare: guest-code when both inventories
-- list the same closed entries, service-only when neither does.
create function public.qorpera_office_software_change(p_statement jsonb)
returns text language plpgsql immutable set search_path='' as $$
declare a text[]; b text[];
begin
 if (p_statement->'previous' ? 'files') <> (p_statement->'next' ? 'files') then
  raise exception 'Office software file lists differ' using errcode='42501'; end if;
 if not (p_statement->'next' ? 'files') then return 'service-only'; end if;
 select array_agg(x->>'file' order by x->>'file') into a from jsonb_array_elements(p_statement#>'{previous,files}') x;
 select array_agg(x->>'file' order by x->>'file') into b from jsonb_array_elements(p_statement#>'{next,files}') x;
 if a is distinct from b then raise exception 'Office software file lists differ' using errcode='42501'; end if;
 return 'guest-code';
end $$;
create function public.qorpera_office_software_files_changed(p_statement jsonb)
returns boolean language sql immutable set search_path='' as $$
 select exists(select 1 from jsonb_array_elements(coalesce(p_statement#>'{next,files}','[]'::jsonb)) n
  join jsonb_array_elements(coalesce(p_statement#>'{previous,files}','[]'::jsonb)) p on p->>'file'=n->>'file'
  where p->'sha256' is distinct from n->'sha256' or p->'bytes' is distinct from n->'bytes') $$;
-- A receipt carries exactly the installed entries of a guest-code revision and none otherwise.
create function public.qorpera_office_software_receipt(p_receipt jsonb,p_statement jsonb)
returns void language plpgsql immutable set search_path='' as $$
begin
 if p_statement->'next' ? 'files' then
  perform public.qorpera_office_software_object(p_receipt,array['schema','plan','planSha256','state','service','installedAt','files']);
  if p_receipt->'files' is distinct from p_statement#>'{next,files}' then
   raise exception 'Office software installation differs' using errcode='42501'; end if;
 else
  perform public.qorpera_office_software_object(p_receipt,array['schema','plan','planSha256','state','service','installedAt']);
 end if;
end $$;
create function pg_temp.office_guest_code_patch(p_target regprocedure,p_old text,p_new text)
returns void language plpgsql as $$
declare d text:=pg_get_functiondef(p_target);
begin
 if (length(d)-length(replace(d,p_old,'')))/length(p_old)<>1 then raise exception 'Office software integration differs: %',p_target; end if;
 execute replace(d,p_old,p_new);
end $$;
-- begin: next may list files; the declared change kind and the "service must change" rule follow the file lists; revisions compare without the list.
select pg_temp.office_guest_code_patch('public.qorpera_begin_office_software(text,text,text,bigint,text,text)'::regprocedure,
 E' perform public.qorpera_office_software_object(s->''next'',array[''packageManifestSha256'',''service'']);',
 E' perform public.qorpera_office_software_next(s->''next'');');
select pg_temp.office_guest_code_patch('public.qorpera_begin_office_software(text,text,text,bigint,text,text)'::regprocedure,
 E' or s#>>''{acceptance,change}'' is distinct from ''service-only''',
 E' or s#>>''{acceptance,change}'' is distinct from public.qorpera_office_software_change(s)');
select pg_temp.office_guest_code_patch('public.qorpera_begin_office_software(text,text,text,bigint,text,text)'::regprocedure,
 E'  or s#>''{previous,service,sha256}''=s#>''{next,service,sha256}''\n',
 E'  or (s#>''{previous,service,sha256}''=s#>''{next,service,sha256}'' and not public.qorpera_office_software_files_changed(s))\n');
select pg_temp.office_guest_code_patch('public.qorpera_begin_office_software(text,text,text,bigint,text,text)'::regprocedure,
 E' or s->''previous'' is distinct from v_current',
 E' or (s->''previous'')-''files'' is distinct from v_current');
-- ack: the receipt lists the installed entries; the stored revision keeps the service specification only.
select pg_temp.office_guest_code_patch('public.qorpera_ack_office_software_install(uuid,uuid,text,jsonb,text,text)'::regprocedure,
 E' perform public.qorpera_office_software_object(r,array[''schema'',''plan'',''planSha256'',''state'',''service'',''installedAt'']);',
 E' perform public.qorpera_office_software_receipt(r,u.statement);');
select pg_temp.office_guest_code_patch('public.qorpera_ack_office_software_install(uuid,uuid,text,jsonb,text,text)'::regprocedure,
 E'   u.statement->''next''||jsonb_build_object(''sourceCommit'',u.statement#>''{source,commit}''));',
 E'   (u.statement->''next'')-''files''||jsonb_build_object(''sourceCommit'',u.statement#>''{source,commit}''));');
-- enroll: the baseline specification is stored without the list of the first guest-code revision.
select pg_temp.office_guest_code_patch('public.qorpera_enroll_office_software(jsonb,jsonb,jsonb,text,text)'::regprocedure,
 E'   or b.original_service<>p_current or b.evidence_sha256<>p_evidence_sha256 then',
 E'   or b.original_service<>(p_current-''files'') or b.evidence_sha256<>p_evidence_sha256 then');
select pg_temp.office_guest_code_patch('public.qorpera_enroll_office_software(jsonb,jsonb,jsonb,text,text)'::regprocedure,
 E'   values(a.allocation_id,a.activation_id,p_predecessor,p_base,p_current,p_evidence_sha256) returning * into b;',
 E'   values(a.allocation_id,a.activation_id,p_predecessor,p_base,p_current-''files'',p_evidence_sha256) returning * into b;');
select pg_temp.office_guest_code_patch('public.qorpera_enroll_office_software(jsonb,jsonb,jsonb,text,text)'::regprocedure,
 E'  insert into public.qorpera_office_software_revisions values(a.allocation_id,0,p_current);',
 E'  insert into public.qorpera_office_software_revisions values(a.allocation_id,0,p_current-''files'');');
do $$
declare f record;
begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in
  ('qorpera_office_software_guest_code_entry','qorpera_office_software_files','qorpera_office_software_next','qorpera_office_software_change','qorpera_office_software_files_changed','qorpera_office_software_receipt') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 end loop;
end $$;
