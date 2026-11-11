-- The bound on a runtime bundle's manifest (20260929023450): at most 512 KiB of its jsonb text, up from 256 KiB
-- (20260924060000). A manifest just over 256 KiB registers; one just over 512 KiB is refused by the check; the check's
-- definition is exactly the new one. The rows are tried inside a rolled-back subtransaction (a registered bundle is never
-- updated or deleted), under a key of their own, so no other test meets them.

create function pg_temp.same(p_got text, p_want text, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;
-- A manifest of exactly p_bytes bytes of jsonb text: {"filler": "aaa...", "schema": "qorpera.runtime-bundle/v2"}.
create function pg_temp.manifest_of(p_bytes integer) returns jsonb language sql as $$
	select jsonb_build_object('schema', 'qorpera.runtime-bundle/v2', 'filler', repeat('a', p_bytes - 53))
$$;
-- Registers a bundle with that manifest and rolls it back: 'ok', or the refusal's code and words.
create function pg_temp.register(p_bytes integer) returns text language plpgsql as $$
declare v_manifest jsonb := pg_temp.manifest_of(p_bytes);
begin
	insert into public.qorpera_runtime_bundles(bundle_key, version, manifest, sha256)
	values ('qorpera.test-manifest-limit-1217', 1, v_manifest,
		encode(extensions.digest(convert_to(v_manifest::text, 'utf8'), 'sha256'), 'hex'));
	raise exception 'registered-and-rolled-back';
exception when others then
	return case when sqlerrm = 'registered-and-rolled-back' then 'ok' else sqlstate || ' ' || sqlerrm end;
end $$;

-- The check, exactly.
do $$ begin
	perform pg_temp.same((select pg_get_constraintdef(oid) from pg_constraint
		where conrelid = 'public.qorpera_runtime_bundles'::regclass and conname = 'qorpera_runtime_bundles_manifest_check'),
		'CHECK (((jsonb_typeof(manifest) = ''object''::text) AND (octet_length((manifest)::text) <= 524288)))', 'the manifest check');
	perform pg_temp.same((select convalidated::text from pg_constraint
		where conrelid = 'public.qorpera_runtime_bundles'::regclass and conname = 'qorpera_runtime_bundles_manifest_check'),
		'true', 'the manifest check is validated');
end $$;

-- The test manifests are the sizes they say.
do $$ begin
	perform pg_temp.same(octet_length(pg_temp.manifest_of(262145)::text)::text, '262145', 'a manifest just over 256 KiB');
	perform pg_temp.same(octet_length(pg_temp.manifest_of(524288)::text)::text, '524288', 'a manifest of 512 KiB');
	perform pg_temp.same(octet_length(pg_temp.manifest_of(524289)::text)::text, '524289', 'a manifest just over 512 KiB');
end $$;

-- Just over 256 KiB registers (the old check refused it), 512 KiB registers, one byte more is refused.
do $$ begin
	perform pg_temp.same(pg_temp.register(262145), 'ok', 'a manifest just over 256 KiB');
	perform pg_temp.same(pg_temp.register(524288), 'ok', 'a manifest of 512 KiB');
	perform pg_temp.same(pg_temp.register(524289),
		'23514 new row for relation "qorpera_runtime_bundles" violates check constraint "qorpera_runtime_bundles_manifest_check"',
		'a manifest just over 512 KiB');
	perform pg_temp.same((select count(*)::text from public.qorpera_runtime_bundles where bundle_key = 'qorpera.test-manifest-limit-1217'),
		'0', 'nothing of the tries stays');
end $$;
