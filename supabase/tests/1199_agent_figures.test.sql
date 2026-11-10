-- 20260930709000: six more agent figures (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §2 "agent.md"). The parse's
-- shape check takes star, cloud, bolt, mushroom, moon and puzzle beside the six that stay, still takes the retired
-- ghost a saved agent.md may name, and refuses every other name as before.
begin;

do $$
declare
	v_agent jsonb := jsonb_build_object('kind','agent','id','11990000-0000-4000-8000-000000000001','name','Mia','role','Sales',
		'agentKind','agent','status','active','colour',null,'figure',null,'model',null,'effort',null,'instructions','Sell.');
	v_figure text; v_problems jsonb;
begin
	if public.qorpera_company_state_parse_problems('agent', v_agent) <> '[]'::jsonb then
		raise exception 'An agent without a figure is refused: %', public.qorpera_company_state_parse_problems('agent', v_agent); end if;
	foreach v_figure in array array['planet','acorn','flame','rocket','crown','heart','star','cloud','bolt','mushroom','moon','puzzle'] loop
		v_problems := public.qorpera_company_state_parse_problems('agent', v_agent || jsonb_build_object('figure', v_figure));
		if v_problems <> '[]'::jsonb then raise exception 'The figure % is refused: %', v_figure, v_problems; end if;
	end loop;
	-- Retired, never offered again, but a saved file that names it is still read.
	v_problems := public.qorpera_company_state_parse_problems('agent', v_agent || jsonb_build_object('figure', 'ghost'));
	if v_problems <> '[]'::jsonb then raise exception 'A saved ghost is refused: %', v_problems; end if;
	foreach v_figure in array array['dragon','brain','Star','star ','','wisp'] loop
		v_problems := public.qorpera_company_state_parse_problems('agent', v_agent || jsonb_build_object('figure', v_figure));
		if jsonb_array_length(v_problems) <> 1 or v_problems -> 0 ->> 'message' is distinct from
			'the platform read this file differently from its rules (figure)' then
			raise exception 'The figure "%" is not refused as a figure: %', v_figure, v_problems; end if;
	end loop;
	-- A figure is a name, never another kind of value.
	v_problems := public.qorpera_company_state_parse_problems('agent', v_agent || jsonb_build_object('figure', 7));
	if jsonb_array_length(v_problems) <> 1 or v_problems -> 0 ->> 'message' is distinct from
		'the platform read this file differently from its rules (figure)' then
		raise exception 'A number is not refused as a figure: %', v_problems; end if;
	-- The colour names did not move.
	foreach v_figure in array array['charcoal','brown','coral','orange','gold','green','teal','blue','purple','pink','gray'] loop
		v_problems := public.qorpera_company_state_parse_problems('agent', v_agent || jsonb_build_object('colour', v_figure));
		if v_problems <> '[]'::jsonb then raise exception 'The colour % is refused: %', v_figure, v_problems; end if;
	end loop;
	v_problems := public.qorpera_company_state_parse_problems('agent', v_agent || jsonb_build_object('colour', 'sky'));
	if jsonb_array_length(v_problems) <> 1 then raise exception 'An unknown colour name is taken: %', v_problems; end if;
end $$;

rollback;
