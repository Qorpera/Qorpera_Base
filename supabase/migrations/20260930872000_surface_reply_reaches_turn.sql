-- WHY: a folder surface turn starts a fresh agent thread and read only the session's first prompt, so a member's reply
-- (an answer to the session's question too) never reached the agent. The turn's prompt now carries the conversation.
set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)') is null
		or to_regprocedure('public.qorpera_surface_shared_product_folder_roots(uuid)') is null
		or to_regprocedure('public.qorpera_surface_utf8_left(text,integer)') is null
		or to_regclass('public.qorpera_surface_message_images') is null then
		raise exception '20260930872000 requires 20260930857000, 20260930861000 and 20260930865000';
	end if;
end $$;

create function pg_temp.srrt_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930872000: invalid replacement pairs for %', p_target;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930872000: anchor matched % time(s) in %: %', v_hits, p_target, left(p_pairs[v_i], 120);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

select pg_temp.srrt_patch('public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)'::regprocedure, array[
$old$	v_conflict_paths text[];
begin$old$,
$new$	v_conflict_paths text[];
	v_prompt text;
	v_conversation text;
	v_said integer;
	v_kept integer;
	v_question text;
begin$new$,
$old$	return jsonb_build_object(
		'sessionId', v_session.id,$old$,
$new$	v_prompt := v_session.prompt;
	-- WHY: code_repo turns get the latest reply as dispatch.followUp and their earlier turns from the coding session.
	if v_surface.source_kind is distinct from 'code_repo' then
		with said as (
			select m.id, m.created_at, m.author_kind, m.author_user_id, m.profile_id, btrim(m.body) as body,
				row_number() over (order by m.created_at desc, m.id desc) as n,
				count(*) over () as total
			from public.qorpera_surface_session_messages m
			where m.session_id = v_session.id
				and m.author_kind in ('member', 'session')
				and nullif(btrim(m.body), '') is not null
				and not (
					m.author_kind = 'member'
					and btrim(m.body) = btrim(coalesce(v_session.prompt, ''))
					and not exists (
						select 1 from public.qorpera_surface_session_messages earlier
						where earlier.session_id = m.session_id
							and (earlier.created_at < m.created_at or (earlier.created_at = m.created_at and earlier.id < m.id))
					)
				)
		),
		newest as (
			select s.id, s.created_at, s.total,
				case when s.author_kind = 'session' then 'You'
					else coalesce(nullif(left(regexp_replace(btrim(coalesce(pm.display_name, '')), '\s+', ' ', 'g'), 80), ''),
						'A teammate') end
					|| E':\n'
					|| case when octet_length(s.body) > 4000
						then public.qorpera_surface_utf8_left(s.body, 3980) || E'\n[message cut]'
						else s.body end
					|| case when coalesce(jsonb_array_length(r.images), 0) = 1 then E'\n[1 image attached]'
						when coalesce(jsonb_array_length(r.images), 0) > 1 then E'\n[' || jsonb_array_length(r.images) || ' images attached]'
						else '' end as line
			from said s
			left join public.qorpera_profile_members pm
				on s.author_kind = 'member' and pm.profile_id = s.profile_id and pm.user_id = s.author_user_id
			left join public.qorpera_surface_message_images r on r.message_id = s.id
			where s.n <= 40
		),
		kept as (
			select k.*, sum(octet_length(k.line) + 2) over (order by k.created_at desc, k.id desc rows unbounded preceding) as running
			from newest k
		)
		select coalesce(max(k.total), 0)::integer, count(*)::integer,
			string_agg(k.line, E'\n\n' order by k.created_at, k.id)
		into v_said, v_kept, v_conversation
		from kept k
		where k.running <= 24000;
		v_question := nullif(btrim(coalesce(v_session.question ->> 'text', '')), '');
		if v_question is not null and jsonb_typeof(v_session.question -> 'options') = 'array'
			and jsonb_array_length(v_session.question -> 'options') > 0 then
			v_question := v_question || E'\nOptions: ' || (
				select string_agg(o, '; ' order by n) from jsonb_array_elements_text(v_session.question -> 'options') with ordinality x(o, n)
			);
		end if;
		if v_kept > 0 or v_question is not null then
			v_prompt := coalesce(v_session.prompt, '')
				|| case when v_kept > 0 then
					E'\n\n## The conversation since this request\nOldest first. "You" is what you said in earlier turns of this session. '
					|| E'Act on the newest member message; the request above is where the session began.'
					|| case when v_said > v_kept then E'\n(' || (v_said - v_kept) || ' earlier messages are left out.)' else '' end
					|| E'\n\n' || v_conversation
					else '' end
				|| case when v_question is not null then E'\n\n## Your open question\n' || public.qorpera_surface_utf8_left(v_question, 2000)
					else '' end;
		end if;
	end if;
	return jsonb_build_object(
		'sessionId', v_session.id,$new$,
$old$		'prompt', v_session.prompt,$old$,
$new$		'prompt', v_prompt,$new$
]);

drop function pg_temp.srrt_patch(regprocedure, text[]);
