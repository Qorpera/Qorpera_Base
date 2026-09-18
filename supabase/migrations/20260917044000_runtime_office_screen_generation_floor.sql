-- 2026-09-17 amendment: a new screen never reuses a generation that is still fenced.
--
-- An office's retained privacy challenge keeps the drains of the screens it
-- fenced (ordinal, screen generation, epoch). A reset deletes the screen rows
-- but keeps the office and its challenge, and a new row started again at
-- generation 1, so the next screen on the same ordinal could carry the same
-- generation as the fenced, deleted one. The office service compares a viewer
-- or run binding with the fence of equal generation and refused it with
-- SCREEN_BINDING_MISMATCH: no screen on that ordinal could be viewed or used.
-- A new screen row now starts above every generation the office still fences
-- for its ordinal, and existing rows in that state are lifted once.

create function public.qorpera_runtime_office_screen_generation_floor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_fenced bigint;
begin
	select max((drain -> 'binding' ->> 'screenGeneration')::bigint) into v_fenced
	from public.qorpera_runtime_offices office,
		jsonb_array_elements(coalesce(office.privacy_challenge -> 'drains', '[]'::jsonb)) drain
	where office.id = new.office_id
		and (drain -> 'binding' ->> 'screenOrdinal')::integer = new.ordinal
		and drain -> 'binding' ->> 'screenId' is distinct from new.id::text;
	if v_fenced is not null and new.generation <= v_fenced then new.generation := v_fenced + 1; end if;
	return new;
end
$$;
revoke all on function public.qorpera_runtime_office_screen_generation_floor() from public, anon, authenticated, service_role;

create trigger qorpera_runtime_office_screen_generation_floor
	before insert on public.qorpera_runtime_office_screens
	for each row execute function public.qorpera_runtime_office_screen_generation_floor();

update public.qorpera_runtime_office_screens screen
set generation = fenced.generation + 1, epoch = screen.epoch + 1, touched_at = clock_timestamp()
from (
	select office.id as office_id, (drain -> 'binding' ->> 'screenOrdinal')::integer as ordinal,
		max((drain -> 'binding' ->> 'screenGeneration')::bigint) as generation,
		array_agg(drain -> 'binding' ->> 'screenId') as screen_ids
	from public.qorpera_runtime_offices office,
		jsonb_array_elements(coalesce(office.privacy_challenge -> 'drains', '[]'::jsonb)) drain
	group by office.id, (drain -> 'binding' ->> 'screenOrdinal')::integer
) fenced
where screen.office_id = fenced.office_id and screen.ordinal = fenced.ordinal
	and not (screen.id::text = any(fenced.screen_ids))
	and screen.generation <= fenced.generation
	and screen.lease_id is null;
