-- @fixture 410_chat_images.test.sql until "-- The chat image checks start here (411 runs everything above this line)."
-- Chat images on folder-v2 (20260930260000): the orphan sweep and its schedule. A day after an input's last upload, an
-- input never posted loses its images folder, a posted one the images it does not list, and the row goes; a row with no
-- folder just goes, and a fresh one waits. The sweep commits as the platform's service caller and gives the caller's
-- claims back. The schedule: two pg_cron jobs, the same on a second run; the hourly job sweeps with no JWT.

-- 1. The sweep. In Nora's thread: 21 uploaded and never posted, 22 begun and never saved, 23 with two images posted with
-- one, 24 uploaded and posted with none, 25 uploaded within the day. In the group chat: 26 uploaded and never posted.
do $$
declare
	ns uuid := pg_temp.thread('nora'); ls uuid := pg_temp.chat('launch'); root constant text := 'agents/nora/memory/thread';
	x constant jsonb := pg_temp.image('twenty-three x'); y constant jsonb := pg_temp.image('twenty-three y');
	member_claims constant text := '{"role":"authenticated","sub":"63400000-0000-4000-8000-000000000001"}';
	v_role text; n integer; c integer;
begin
	perform pg_temp.upload(pg_temp.u(1), ns, pg_temp.cid(21), 'twenty-one');
	perform pg_temp.begin_image(pg_temp.u(1), ns, pg_temp.cid(22), pg_temp.file('twenty-two'));
	perform pg_temp.begin_image(pg_temp.u(1), ns, pg_temp.cid(23), x);
	perform pg_temp.save_image(pg_temp.u(1), ns, pg_temp.cid(23), x);
	perform pg_temp.begin_image(pg_temp.u(1), ns, pg_temp.cid(23), y);
	perform pg_temp.save_image(pg_temp.u(1), ns, pg_temp.cid(23), y);
	perform pg_temp.say(pg_temp.u(1), ns, pg_temp.cid(23), 'Only the first', jsonb_build_array(pg_temp.img(x)));
	perform pg_temp.upload(pg_temp.u(1), ns, pg_temp.cid(24), 'twenty-four');
	perform pg_temp.say(pg_temp.u(1), ns, pg_temp.cid(24), 'No image after all');
	perform pg_temp.upload(pg_temp.u(1), ns, pg_temp.cid(25), 'twenty-five');
	perform pg_temp.upload(pg_temp.u(1), ls, pg_temp.cid(26), 'twenty-six');
	update public.qorpera_room_image_uploads set updated_at = updated_at - interval '25 hours'
	where client_input_id <> pg_temp.cid(25);

	perform set_config('request.jwt.claims', member_claims, true);
	v_role := coalesce(current_setting('request.jwt.claim.role', true), '');
	n := public.qorpera_room_image_orphan_sweep();
	if current_setting('request.jwt.claims') is distinct from member_claims
		or coalesce(current_setting('request.jwt.claim.role', true), '') is distinct from v_role then
		raise exception 'The sweep gives the caller''s claims back: %', current_setting('request.jwt.claims'); end if;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	if n <> 5 then raise exception 'The sweep took five rows, not %', n; end if;

	if pg_temp.version(root || '/images/' || pg_temp.cid(21)) is not null
		or pg_temp.version(root || '/images/' || pg_temp.cid(24)) is not null
		or pg_temp.version(format('agents/groups/launch/memory/images/%s', pg_temp.cid(26))) is not null then
		raise exception 'An input never posted, or posted with no image, loses its images folder'; end if;
	if pg_temp.version(format('%s/images/%s/%s.png', root, pg_temp.cid(23), y ->> 'fileSha256')) is not null
		or pg_temp.version(format('%s/images/%s/%s.png', root, pg_temp.cid(23), x ->> 'fileSha256')) is null
		or pg_temp.version(root || '/images/' || pg_temp.cid(23)) is null then
		raise exception 'A posted input keeps the images it lists, and only those'; end if;
	if pg_temp.version(format('%s/images/%s/%s.png', root, pg_temp.cid(25), pg_temp.file('twenty-five') ->> 'fileSha256')) is null then
		raise exception 'An upload within the day stays'; end if;
	select count(*) into c from public.qorpera_room_image_uploads
	where client_input_id in (pg_temp.cid(21), pg_temp.cid(22), pg_temp.cid(23), pg_temp.cid(24), pg_temp.cid(26));
	if c <> 0 or not exists (select 1 from public.qorpera_room_image_uploads where client_input_id = pg_temp.cid(25)) then
		raise exception 'The swept rows go and the fresh one stays'; end if;
	select count(*) into c from public.qorpera_folder_commits
	where environment_id = '63400000-0000-4000-8000-000000000020' and operation_key like 'chat-image-sweep:%';
	if c <> 4 or exists (select 1 from public.qorpera_folder_commits where environment_id = '63400000-0000-4000-8000-000000000020'
		and operation_key like 'chat-image-sweep:%' and actor_kind <> 'platform') then
		raise exception 'One commit as the platform for each input with images to delete, not %', c; end if;
	if public.qorpera_room_image_orphan_sweep() <> 0 then raise exception 'A second sweep finds nothing'; end if;
end $$;

-- 2. The schedule: the sweep hourly, and a daily cleanup of its run log. The job runs with no JWT.
do $$
declare
	v jsonb; v_command text; ns uuid := pg_temp.thread('nora');
	dir constant text := 'agents/nora/memory/thread/images/' || pg_temp.cid(27);
begin
	perform pg_temp.upload(pg_temp.u(1), ns, pg_temp.cid(27), 'twenty-seven');
	update public.qorpera_room_image_uploads set updated_at = updated_at - interval '25 hours' where client_input_id = pg_temp.cid(27);
	if to_regnamespace('cron') is null then
		if public.qorpera_schedule_room_image_sweep() ->> 'scheduled' is distinct from 'false' then
			raise exception 'The sweep claimed a schedule without pg_cron'; end if;
		-- A stand-in with pg_cron's schedule-by-name contract (as 879).
		create schema cron;
		create table cron.job(jobid bigint generated always as identity primary key, schedule text not null,
			command text not null, jobname text not null, username text not null default current_user, unique (jobname, username));
		create table cron.job_run_details(runid bigint generated always as identity primary key, jobid bigint, end_time timestamptz);
		create function cron.schedule(p_name text, p_schedule text, p_command text) returns bigint language sql as $f$
			insert into cron.job(jobname, schedule, command) values (p_name, p_schedule, p_command)
			on conflict (jobname, username) do update set schedule = excluded.schedule, command = excluded.command
			returning jobid
		$f$;
	end if;
	v := public.qorpera_schedule_room_image_sweep();
	if v ->> 'scheduled' is distinct from 'true' or jsonb_array_length(v -> 'jobs') <> 2
		or public.qorpera_schedule_room_image_sweep() -> 'jobs' <> v -> 'jobs'
		or (select schedule from cron.job where jobname = 'qorpera-room-image-sweep') is distinct from '41 * * * *'
		or (select schedule from cron.job where jobname = 'qorpera-room-image-sweep-log') is distinct from '29 3 * * *' then
		raise exception 'The sweep is not scheduled once, hourly, with a daily cleanup: %', v; end if;
	select command into v_command from cron.job where jobname = 'qorpera-room-image-sweep';
	if v_command is distinct from 'select public.qorpera_room_image_orphan_sweep()' then
		raise exception 'The sweep''s command: %', v_command; end if;
	-- The commands run as the job's owner, with no JWT.
	perform set_config('request.jwt.claims', '', true);
	execute v_command;
	execute (select command from cron.job where jobname = 'qorpera-room-image-sweep-log');
	if current_setting('request.jwt.claims') <> '' then
		raise exception 'The job''s sweep leaves no claims behind: %', current_setting('request.jwt.claims'); end if;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	if pg_temp.version(dir) is not null or exists (select 1 from public.qorpera_room_image_uploads where client_input_id = pg_temp.cid(27)) then
		raise exception 'The job swept the input never posted'; end if;
end $$;

rollback;
