-- Company mail, sender names: founder decisions of 1 October 2026 on M2b (relayed by the coordinator; design
-- deploy/first-node/RUNTIME-EVENT-INTAKE.md, "Sending (M2b)").
--
-- Decision 3: email never looks like it comes from Qorpera. Every company sends from the platform's domain, so a
-- company or agent named after the platform would read as the platform itself. A send is refused when the agent's
-- name, the company's name or the mailbox's local part reads as Qorpera, and a mailbox can no longer be created with
-- such a local part. Names are not refused where they are set: the check guards the From line, where it matters.
-- Decisions 1 (the AI line as written, its own last paragraph on every email) and 2 (Auto-Submitted only on automatic
-- replies) are what 20260928309740 already does.

set local lock_timeout = '3s';

-- normalize() takes text apart only in a UTF8 database; anywhere else every send would fail.
do $$
begin
	if current_setting('server_encoding') <> 'UTF8' then
		raise exception 'Mail sender names need a UTF8 database, not %', current_setting('server_encoding'); end if;
end
$$;

create function pg_temp.sender_names_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Mail sender names integration differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- Whether a name reads as Qorpera: compatibility forms and accents taken apart (NFKD), look-alike Cyrillic and Greek
-- letters (capitals listed too, so it does not depend on how the database's locale folds case), small capitals,
-- digits and "@" mapped to the Latin letters they imitate, and everything but letters dropped, so "Q0RPERA",
-- "Qor-pera", "Qörpera", a full-width "Ｑｏｒｐｅｒａ", "QОRPERA" with a Cyrillic О and "qᴏʀᴘᴇʀᴀ" all count.
create function public.qorpera_mail_name_reads_as_qorpera(p_name text)
returns boolean
language sql
immutable
set search_path = ''
as $$
	select regexp_replace(translate(lower(normalize(coalesce(p_name, ''), NFKD)),
		'аеорсхуіԛАЕОРСХУІԚοραεΟΡΑΕᴏʀᴘᴇᴀ01349@',
		'aeopcxyiqaeopcxyiqopaeopaeorpeaoleaqa'), '[^a-z]', '', 'g') like '%qorpera%'
$$;
revoke all on function public.qorpera_mail_name_reads_as_qorpera(text) from public, anon, authenticated, service_role;

-- A send: the names it would go out under, as the header carries them, and the mailbox's address.
select pg_temp.sender_names_patch('public.qorpera_send_agent_mail(jsonb,text,jsonb)'::regprocedure,
	$old$	v_company := public.qorpera_mail_display_name((select profile.name from public.qorpera_profiles as profile
		where profile.id = v_run.profile_id), 'the company');
$old$,
	$new$	v_company := public.qorpera_mail_display_name((select profile.name from public.qorpera_profiles as profile
		where profile.id = v_run.profile_id), 'the company');
	-- Nothing goes out as if from Qorpera (founder decision, 1 October 2026).
	if public.qorpera_mail_name_reads_as_qorpera(v_agent) or public.qorpera_mail_name_reads_as_qorpera(v_company)
		or public.qorpera_mail_name_reads_as_qorpera(v_mailbox.local_part) then
		raise exception 'Email that would look like it comes from Qorpera is refused; a member renames the company, the agent or the mailbox'
			using errcode = '42501'; end if;
$new$);

-- A new mailbox's name.
select pg_temp.sender_names_patch(
	'public.qorpera_create_company_mailbox(uuid,uuid,text,text)'::regprocedure,
	$old$		raise exception 'This mailbox name is reserved' using errcode = '22023';
	end if;
$old$,
	$new$		raise exception 'This mailbox name is reserved' using errcode = '22023';
	end if;
	-- The platform's own name, however it is spelled (founder decision, 1 October 2026).
	if public.qorpera_mail_name_reads_as_qorpera(p_local_part) then
		raise exception 'A mailbox name that reads as Qorpera is reserved' using errcode = '22023';
	end if;
$new$);
