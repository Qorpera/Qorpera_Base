-- The storage insert policy evaluates qorpera_profile_object_writes_allowed
-- as the authenticated caller, but 20260816018000 revoked PUBLIC without
-- granting anyone execute — this project has no default function grants, so
-- every desktop publication upload failed with "permission denied" from the
-- moment that migration swapped the policy onto the wrapper. Its rollback-only
-- QA never uploaded an object, so the first real publication (the live smoke
-- on 2026-08-18) was the first caller to hit it.

grant execute on function public.qorpera_profile_object_writes_allowed(uuid) to authenticated;
