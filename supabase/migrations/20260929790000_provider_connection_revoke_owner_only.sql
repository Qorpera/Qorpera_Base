-- Only a connection's owner revokes it without the company's authorize role. qorpera_set_provider_connection_status
-- lets the company's owners and admins change a provider connection's status, and the member who owns a connection
-- revoke it. The owner's clause, `v_connection.owner_user_id = auth.uid() and p_status = 'revoked'`, is NULL for a
-- company-owned connection (owner_user_id is NULL), and a NULL condition does not refuse: anyone signed in who knew
-- the company's and the connection's ids could revoke the company's connection, ending the runner jobs it paid for.
-- The clause now counts only when it is true. Everything else is unchanged: owners and admins change any status, a
-- member revokes their own connection, and the transition check after it stays. A caller without the role who
-- revokes a connection nobody has now gets the authorization error (it got the transition error before).
--
-- An exact-text patch: it fails unless the function has the clause once, with the text given.

create function pg_temp.provider_connection_revoke_patch(p_function regprocedure, p_from text, p_to text) returns void
language plpgsql as $patch$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if (length(v_definition) - length(replace(v_definition, p_from, ''))) / length(p_from) <> 1 then
		raise exception '% does not have the clause this migration expects', p_function; end if;
	execute replace(v_definition, p_from, p_to);
end
$patch$;

select pg_temp.provider_connection_revoke_patch('public.qorpera_set_provider_connection_status(uuid,uuid,text)',
	$from$		or (v_connection.owner_user_id = auth.uid() and p_status = 'revoked')$from$,
	$to$		or coalesce(v_connection.owner_user_id = auth.uid() and p_status = 'revoked', false)$to$);

drop function pg_temp.provider_connection_revoke_patch(regprocedure, text, text);
