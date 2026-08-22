do $$
begin
	if to_regclass('public.qorpera_legacy_session_imports') is not null
		or to_regclass('public.qorpera_legacy_session_import_events') is not null then
		raise exception 'the retired legacy transcript import tables still exist';
	end if;
	if to_regprocedure('public.qorpera_begin_legacy_session_import(uuid,uuid,text,integer)') is not null
		or to_regprocedure('public.qorpera_append_legacy_session_import_event(uuid,uuid,text,jsonb,bigint)') is not null
		or to_regprocedure('public.qorpera_complete_legacy_session_import(uuid)') is not null then
		raise exception 'the retired legacy transcript import RPCs still exist';
	end if;
end
$$;
