-- Attended replies paged the hire charter and the current request through
-- read_context at 1 KiB a page, one model round per page (five rounds on a
-- typical working reply, measured 21-22 Sep). Ship whole sources in the
-- admitted context for ordinary sizes and let one page carry 16 KiB. The
-- 1 MiB context bound, the hashes and the pageable protocol are unchanged.
create or replace function public.qorpera_company_context_excerpt(p_text text,p_offset integer,p_limit integer)
returns jsonb language plpgsql immutable security definer set search_path = '' as $$
declare v_text text; v_size integer; v_characters integer;
begin
	if p_text is null or p_offset is null or p_offset < 0 or p_offset > char_length(p_text)
		or p_limit is null or p_limit not between 4 and 65536 then
		raise exception 'Cloud context range is invalid' using errcode = '22023'; end if;
	v_text := substr(p_text,p_offset + 1,p_limit);
	while octet_length(v_text) > p_limit loop
		v_text := left(v_text,char_length(v_text) - greatest(1,(octet_length(v_text) - p_limit + 3) / 4));
	end loop;
	v_size := octet_length(p_text); v_characters := char_length(v_text);
	return jsonb_build_object('text',v_text,'originalBytes',v_size,
		'sha256',encode(extensions.digest(convert_to(p_text,'utf8'),'sha256'),'hex'),
		'offset',p_offset,'nextOffset',case when p_offset + v_characters < char_length(p_text) then p_offset + v_characters else null end,
		'truncated',p_offset <> 0 or v_characters < char_length(p_text));
end
$$;

do $$
declare
	v_definition text := pg_get_functiondef('public.qorpera_describe_company_run_context(jsonb)'::regprocedure);
	v_pair text[];
begin
	foreach v_pair slice 1 in array array[
		-- current human requests and startup cues: 1 KiB -> 16 KiB
		[$old$public.qorpera_company_context_excerpt(v_source ->> 'text',0,1024)));
	end loop;$old$,
		 $new$public.qorpera_company_context_excerpt(v_source ->> 'text',0,16384)));
	end loop;$new$],
		-- historical messages: 512 B -> 2 KiB (32 messages at most)
		[$old$public.qorpera_company_context_excerpt(v_source ->> 'text',0,512)))$old$,
		 $new$public.qorpera_company_context_excerpt(v_source ->> 'text',0,2048)))$new$],
		-- hire charter (job specification): 4 KiB -> 16 KiB (before the job clause, which becomes 4 KiB)
		[$old$v_spec := (v_source-'text') || jsonb_build_object('content',public.qorpera_company_context_excerpt(v_source ->> 'text',0,4096));$old$,
		 $new$v_spec := (v_source-'text') || jsonb_build_object('content',public.qorpera_company_context_excerpt(v_source ->> 'text',0,16384));$new$],
		-- job: 1 KiB -> 4 KiB
		[$old$v_job := (v_source-'text') || jsonb_build_object('content',public.qorpera_company_context_excerpt(v_source ->> 'text',0,1024));$old$,
		 $new$v_job := (v_source-'text') || jsonb_build_object('content',public.qorpera_company_context_excerpt(v_source ->> 'text',0,4096));$new$]
	] loop
		if (length(v_definition) - length(replace(v_definition,v_pair[1],''))) / length(v_pair[1]) <> 1 then
			raise exception 'Context excerpt clause differs: %', left(v_pair[1],60); end if;
		v_definition := replace(v_definition,v_pair[1],v_pair[2]);
	end loop;
	execute v_definition;
end
$$;
