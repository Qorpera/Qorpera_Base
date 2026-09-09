-- The full Step 4 source closure has outgrown the original 64 KiB manifest.
-- Apply before the unreleased v15 activation; keep all source hashes and the
-- immutable-bundle/checksum constraints. Measure logical bytes, not TOAST size.
alter table public.qorpera_runtime_bundles drop constraint qorpera_runtime_bundles_manifest_check;
alter table public.qorpera_runtime_bundles add constraint qorpera_runtime_bundles_manifest_check
 check (jsonb_typeof(manifest)='object' and octet_length(manifest::text)<=131072);
