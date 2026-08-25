-- Supabase grants new public-schema functions to its API roles. Keep feedback
-- submission authenticated at the ACL boundary as well as inside the function.
revoke all on function public.qorpera_submit_product_feedback(uuid, text, text, boolean, jsonb) from anon;
