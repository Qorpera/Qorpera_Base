-- The hosted database grants EXECUTE directly to API roles by default.
-- Revoking PUBLIC alone does not remove those grants. Keep the provider-only
-- refresh RPC closed at the SQL boundary as well as its auth.role() guard.
revoke all on function public.qorpera_prepare_company_computer_image_refresh(uuid, text, text)
	from public, anon, authenticated;
grant execute on function public.qorpera_prepare_company_computer_image_refresh(uuid, text, text)
	to service_role;
