-- Carry the agents-only runtime's staff fields through the hosted roster.
--
-- The desktop registry gained `lifecycleState` (setup/active conception
-- lifecycle, orthogonal to employment) and `appearance.creature`. Without
-- these columns the authoritative cloud roster would silently strip them on
-- every sync round-trip: the full-registry replacement would downgrade an
-- active agent back to setup behavior and erase its creature appearance.
-- Existing hosted rows default to 'setup', matching the desktop migration's
-- default for registries that predate the lifecycle field.

alter table public.qorpera_profile_staff
	add column if not exists lifecycle_state text not null default 'setup'
		check (lifecycle_state in ('setup', 'active')),
	add column if not exists appearance_creature text
		check (
			appearance_creature is null
			or (char_length(appearance_creature) between 1 and 64 and appearance_creature = btrim(appearance_creature))
		);

create or replace function public.qorpera_list_profile_staff(p_profile_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_result jsonb;
begin
	if v_user_id is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	if not exists (
		select 1
		from public.qorpera_profile_members as member
		where member.profile_id = p_profile_id and member.user_id = v_user_id
	) then
		raise exception 'profile access denied' using errcode = '42501';
	end if;

	select coalesce(
		jsonb_agg(
			jsonb_build_object(
				'profile_id', staff.profile_id,
				'staff_agent_id', staff.staff_agent_id,
				'display_name', staff.display_name,
				'role', staff.role,
				'charter', staff.charter,
				'template_id', staff.template_id,
				'department_id', staff.department_id,
				'appearance_color', staff.appearance_color,
				'appearance_shape', staff.appearance_shape,
				'appearance_creature', staff.appearance_creature,
				'employment_status', staff.employment_status,
				'lifecycle_state', staff.lifecycle_state,
				'version', staff.version,
				'created_at', staff.created_at,
				'updated_at', staff.updated_at,
				'updated_by_user_id', staff.updated_by_user_id
			)
			order by staff.created_at, staff.staff_agent_id
		),
		'[]'::jsonb
	)
	into v_result
	from public.qorpera_profile_staff as staff
	where staff.profile_id = p_profile_id;

	return v_result;
end
$$;

-- The put RPC gains parameters, which would create an ambiguous overload for
-- PostgREST name-based dispatch; the old signature must go.
drop function if exists public.qorpera_put_profile_staff(
	uuid, uuid, text, text, text, text, text, text, text, text, timestamptz, bigint
);

create function public.qorpera_put_profile_staff(
	p_profile_id uuid,
	p_staff_agent_id uuid,
	p_display_name text,
	p_role text,
	p_charter text,
	p_template_id text,
	p_department_id text,
	p_appearance_color text,
	p_appearance_shape text,
	p_appearance_creature text,
	p_employment_status text,
	p_lifecycle_state text,
	p_created_at timestamptz,
	p_expected_version bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_member_role text;
	v_current public.qorpera_profile_staff%rowtype;
	v_result public.qorpera_profile_staff%rowtype;
begin
	if v_user_id is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	select member.role
	into v_member_role
	from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = v_user_id;
	if v_member_role is null or v_member_role = 'viewer' then
		raise exception 'profile write access denied' using errcode = '42501';
	end if;
	if p_staff_agent_id is null or p_created_at is null then
		raise exception 'staff identity is invalid' using errcode = '22023';
	end if;
	if char_length(p_display_name) not between 1 and 160 or p_display_name <> btrim(p_display_name)
		or char_length(p_role) not between 1 and 320 or p_role <> btrim(p_role)
		or octet_length(convert_to(p_charter, 'utf8')) not between 1 and 32768 or p_charter <> btrim(p_charter)
		or char_length(p_appearance_color) not between 1 and 64 or p_appearance_color <> btrim(p_appearance_color)
		or char_length(p_appearance_shape) not between 1 and 64 or p_appearance_shape <> btrim(p_appearance_shape)
		or (p_appearance_creature is not null and (char_length(p_appearance_creature) not between 1 and 64 or p_appearance_creature <> btrim(p_appearance_creature)))
		or (p_template_id is not null and (char_length(p_template_id) not between 1 and 256 or p_template_id <> btrim(p_template_id)))
		or (p_department_id is not null and (char_length(p_department_id) not between 1 and 256 or p_department_id <> btrim(p_department_id)))
		or p_employment_status not in ('active', 'archived')
		or p_lifecycle_state not in ('setup', 'active') then
		raise exception 'staff record is invalid' using errcode = '22023';
	end if;

	select staff.*
	into v_current
	from public.qorpera_profile_staff as staff
	where staff.profile_id = p_profile_id and staff.staff_agent_id = p_staff_agent_id
	for update;

	if not found then
		if p_expected_version is not null then
			raise exception 'staff version conflict' using errcode = '40001';
		end if;
		insert into public.qorpera_profile_staff (
			profile_id, staff_agent_id, display_name, role, charter, template_id, department_id,
			appearance_color, appearance_shape, appearance_creature, employment_status, lifecycle_state,
			version, created_at, updated_at, updated_by_user_id
		)
		values (
			p_profile_id, p_staff_agent_id, p_display_name, p_role, p_charter, p_template_id, p_department_id,
			p_appearance_color, p_appearance_shape, p_appearance_creature, p_employment_status, p_lifecycle_state,
			1, p_created_at, p_created_at, v_user_id
		)
		returning * into v_result;
	else
		if p_expected_version is null then
			if v_current.display_name = p_display_name
				and v_current.role = p_role
				and v_current.charter = p_charter
				and v_current.template_id is not distinct from p_template_id
				and v_current.department_id is not distinct from p_department_id
				and v_current.appearance_color = p_appearance_color
				and v_current.appearance_shape = p_appearance_shape
				and v_current.appearance_creature is not distinct from p_appearance_creature
				and v_current.employment_status = p_employment_status
				and v_current.lifecycle_state = p_lifecycle_state
				and v_current.created_at = p_created_at then
				v_result := v_current;
			else
				raise exception 'staff version conflict' using errcode = '40001';
			end if;
		elsif v_current.version <> p_expected_version then
			raise exception 'staff version conflict' using errcode = '40001';
		else
			update public.qorpera_profile_staff
			set display_name = p_display_name,
				role = p_role,
				charter = p_charter,
				template_id = p_template_id,
				department_id = p_department_id,
				appearance_color = p_appearance_color,
				appearance_shape = p_appearance_shape,
				appearance_creature = p_appearance_creature,
				employment_status = p_employment_status,
				lifecycle_state = p_lifecycle_state,
				version = version + 1,
				updated_at = statement_timestamp(),
				updated_by_user_id = v_user_id
			where profile_id = p_profile_id and staff_agent_id = p_staff_agent_id
			returning * into v_result;
		end if;
	end if;

	return jsonb_build_object(
		'profile_id', v_result.profile_id,
		'staff_agent_id', v_result.staff_agent_id,
		'display_name', v_result.display_name,
		'role', v_result.role,
		'charter', v_result.charter,
		'template_id', v_result.template_id,
		'department_id', v_result.department_id,
		'appearance_color', v_result.appearance_color,
		'appearance_shape', v_result.appearance_shape,
		'appearance_creature', v_result.appearance_creature,
		'employment_status', v_result.employment_status,
		'lifecycle_state', v_result.lifecycle_state,
		'version', v_result.version,
		'created_at', v_result.created_at,
		'updated_at', v_result.updated_at,
		'updated_by_user_id', v_result.updated_by_user_id
	);
end
$$;

revoke all on function public.qorpera_put_profile_staff(
	uuid, uuid, text, text, text, text, text, text, text, text, text, text, timestamptz, bigint
) from public;
grant execute on function public.qorpera_put_profile_staff(
	uuid, uuid, text, text, text, text, text, text, text, text, text, text, timestamptz, bigint
) to authenticated;
