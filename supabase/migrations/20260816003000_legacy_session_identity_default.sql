-- Keep the v1 session RPC valid while new clients supply an explicit trail id.

alter table public.qorpera_shared_sessions
	alter column client_session_id set default extensions.gen_random_uuid();
