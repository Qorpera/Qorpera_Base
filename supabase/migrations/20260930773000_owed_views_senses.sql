-- 20260930773000: the Co-Founder learns which views the company is owed (company views step 4, slice O1;
-- lanes/company-views-20261114/DESIGN-4.md). Jonas, 15 November 2026: when the company has something, it is owed a view
-- of it; the platform checks the view exists, the agents decide how it looks.
--
-- An owed view is the interface app at a fixed folder of the Company File: apps/products, apps/money (later apps/ads).
-- The database cannot read an app.toml (apps are no structured kind; their bytes are only in the object store), so a
-- view is known by its folder, and it is made when the folder entry apps/<name>/app.toml is a file. The website's view
-- has no folder: the platform draws it, so it is never in this list.
--
-- qorpera_describe_company_senses (20260930765000) gains one key, `views`: the views owed now, in a fixed order, each
-- {name, app, made}; one that is not owed now is not listed, and nothing of an app's own text is read.
-- * products: owed when the company has a vision, the file QorperaOS/vision/vision.md (every company sells something).
-- * money: owed when a bank is connected with a live consent. Live, as the bank sync (20260930523000) keeps it: the
--   company's sync follows a bank secret of this environment that is still active, its status is waiting (connected,
--   first fetch to come), current or failed (a first fetch that failed and is tried again), never ended (the bank said
--   the consent ended) or disconnected, and the consent's end the bank gave (consent_until) is unknown or still ahead.
-- * ads: owed when an ads door exists (step 6); never owed until then, so not in the list yet.
-- Folder keys are the lowercase path (qorpera_folder_key), so Apps/Money/app.toml is the same folder as apps/money; an
-- app.toml anywhere else (apps/money-2/, apps/money/old/, archive/apps/money/) is no owed view. A deleted app.toml has
-- no entry, so the view is not made. The list is at most two short entries, so the 8,192-byte bound of the answer and
-- the part no cut reaches (about 5 KiB at most) hold as before.
--
-- The patched body carries the marker 20260930773000.

set local lock_timeout = '3s';

create function pg_temp.views773_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if position('20260930773000' in v_definition) > 0 then
		raise exception '20260930773000 is already in %', p_function; end if;
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930773000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.views773_replace('public.qorpera_describe_company_senses(jsonb)'::regprocedure,
	$old$		'reading', case when v_saved_at is null then null$old$,
	$new$		-- 20260930773000: the views the company is owed now and whether each app is made (apps/<name>/app.toml is
		-- a file). products: the company has a vision. money: a bank connected with a live consent (the sync of an
		-- active bank secret of this environment, waiting, current or failed, its consent not past its end). ads: when
		-- the ads door exists (step 6), never before.
		'views', (select coalesce(jsonb_agg(jsonb_build_object('name', owed.name, 'app', 'apps/' || owed.name,
				'made', ('apps/' || owed.name || '/app.toml') = any (files.keys)) order by owed.at), '[]'::jsonb)
			from (select coalesce(array_agg(entry.key_text), '{}') as keys
				from public.qorpera_folder_entries as entry
				where entry.environment_id = v_run.environment_id and entry.kind = 'file'
					and entry.key_sha256 in (extensions.digest('qorperaos/vision/vision.md', 'sha256'),
						extensions.digest('apps/products/app.toml', 'sha256'),
						extensions.digest('apps/money/app.toml', 'sha256'))) as files
			cross join lateral (values
				(1, 'products', 'qorperaos/vision/vision.md' = any (files.keys)),
				(2, 'money', exists (select 1 from public.qorpera_bank_syncs as sync
					join public.qorpera_cloud_secrets as secret on secret.id = sync.secret_id
					where sync.profile_id = v_run.profile_id and secret.environment_id = v_run.environment_id
						and secret.status = 'active' and sync.status in ('waiting', 'current', 'failed')
						and (sync.consent_until is null or sync.consent_until > v_now)))) as owed(at, name, owed)
			where owed.owed),
		'reading', case when v_saved_at is null then null$new$);

comment on function public.qorpera_describe_company_senses(jsonb) is
	'The plain facts the Co-Founder''s company run writes the company''s reading from (QorperaOS/vision/reading.md): '
	'agents with their work, routines and waiting wakes, the team''s changes, unanswered cards, members'' logins '
	'(20260930765000), and the views the company is owed now (apps/products, apps/money) with whether each app is made '
	'(20260930773000). The Co-Founder''s run only; at most 8,192 bytes, the agents cut last.';

-- The deploy guard: the patched body carries the marker, and the function is still the platform's definer read.
do $guard$
begin
	if not exists (select 1 from pg_proc where oid = 'public.qorpera_describe_company_senses(jsonb)'::regprocedure
		and strpos(prosrc, '20260930773000') > 0 and strpos(prosrc, '20260930765000') > 0 and prosecdef
		and proconfig = array['search_path=""']) then
		raise exception '20260930773000 is missing from public.qorpera_describe_company_senses(jsonb)'; end if;
end $guard$;

drop function pg_temp.views773_replace(regprocedure, text, text);
