-- Group subtitles belong to the canonical room document, alongside its name
-- and purpose. An absent subtitle retains the client's default "Group chat".
alter table public.qorpera_company_rooms
	add column subtitle text check (subtitle is null or char_length(subtitle) <= 256);

-- Keep the existing organization validation, revision checks and room deletion
-- behavior; extend only the room document's permitted fields and projection.
do $$
declare v_definition text; v_patch text[];
begin
	v_definition := pg_get_functiondef('public.qorpera_project_organization_document(jsonb,jsonb,text,uuid,uuid)'::regprocedure);
	foreach v_patch slice 1 in array array[
		array[
			$old$or v_document - array['schema','roomId','key','name','purpose','status','projectId','members','version'] <> '{}'::jsonb$old$,
			$new$or v_document - array['schema','roomId','key','name','subtitle','purpose','status','projectId','members','version'] <> '{}'::jsonb
			or (v_document ? 'subtitle' and (jsonb_typeof(v_document -> 'subtitle') is distinct from 'string'
				or char_length(v_document ->> 'subtitle') > 256))$new$
		],
		array[
			$old$insert into public.qorpera_company_rooms(id,profile_id,environment_id,room_key,name,purpose,status,project_id,version,$old$,
			$new$insert into public.qorpera_company_rooms(id,profile_id,environment_id,room_key,name,subtitle,purpose,status,project_id,version,$new$
		],
		array[
			$old$values (v_id,v_profile_id,v_environment_id,v_document ->> 'key',btrim(v_document ->> 'name'),v_document ->> 'purpose',$old$,
			$new$values (v_id,v_profile_id,v_environment_id,v_document ->> 'key',btrim(v_document ->> 'name'),v_document ->> 'subtitle',v_document ->> 'purpose',$new$
		],
		array[
			$old$on conflict (id) do update set room_key = excluded.room_key,name = excluded.name,purpose = excluded.purpose,$old$,
			$new$on conflict (id) do update set room_key = excluded.room_key,name = excluded.name,subtitle = excluded.subtitle,purpose = excluded.purpose,$new$
		]
	] loop
		if (length(v_definition) - length(replace(v_definition, v_patch[1], ''))) / length(v_patch[1]) <> 1 then
			raise exception 'Organization room subtitle projection differs'; end if;
		v_definition := replace(v_definition, v_patch[1], v_patch[2]);
	end loop;
	execute v_definition;
end
$$;

create or replace function public.qorpera_list_company_rooms(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
	if auth.uid() is null or not public.qorpera_can_read_profile(p_profile_id) then
		raise exception 'Company rooms access denied' using errcode = '42501'; end if;
	return coalesce((select jsonb_agg((jsonb_build_object('roomId',room.id,'key',room.room_key,'name',room.name,
			'purpose',room.purpose,'status',room.status,'projectId',room.project_id,'sessionId',room.session_id,
			'version',room.version,'environmentId',room.environment_id,'members',(
				select coalesce(jsonb_agg(jsonb_build_object('kind',member.principal_kind,'id',member.principal_id)
					order by member.principal_kind,member.principal_id),'[]'::jsonb)
				from public.qorpera_company_room_members member where member.room_id = room.id and member.status = 'active'))
			|| case when room.subtitle is null then '{}'::jsonb else jsonb_build_object('subtitle',room.subtitle) end)
			order by room.status,room.name,room.id)
		from public.qorpera_company_rooms room where room.profile_id = p_profile_id),'[]'::jsonb);
end
$$;
