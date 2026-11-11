-- 20260929023450: a runtime bundle's manifest may be up to 512 KiB of its jsonb text; it was 256 KiB since
-- 20260924060000. Bundle 234 (11 November 2026) is the first over 256 KiB: its runtime and the migrations it names
-- (every migration file is part of a bundle's manifest) passed 262,144 bytes at its cut.
--
-- Why this file sits in the release train's range (20260929...) and not with the feature migrations (20260930...): on a
-- fresh chain, applied in file order, every release's activation registers its manifest, and v234's
-- (20260929023499_runtime_bundle_activation_v234) must already find the wider check, so this comes right before it. On
-- production the roll runs it in `migrate`, before the switch runs the activation; v234's activation refuses to run
-- without it. The generator's own bound on the same text (scripts/generate-cloud-runtime-bundle.mjs) moves with it in the
-- same release.
--
-- The new check is wider than the old one, so every existing row passes it; it is checked (validated) as it is added.

set local lock_timeout = '3s';

alter table public.qorpera_runtime_bundles drop constraint qorpera_runtime_bundles_manifest_check;
alter table public.qorpera_runtime_bundles add constraint qorpera_runtime_bundles_manifest_check
	check (jsonb_typeof(manifest) = 'object' and octet_length(manifest::text) <= 524288);

comment on constraint qorpera_runtime_bundles_manifest_check on public.qorpera_runtime_bundles is
	'A runtime bundle''s manifest: a JSON object of at most 512 KiB of jsonb text (20260929023450; 256 KiB before).';
