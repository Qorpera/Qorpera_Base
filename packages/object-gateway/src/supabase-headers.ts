/** Configured JWT API keys also carry their signed role in Authorization.
 * Opaque API keys are not bearer tokens; an explicit member JWT always wins. */
export function supabaseRequestHeaders(apiKey: string, memberToken?: string): Record<string, string> {
	const headers: Record<string, string> = { apikey: apiKey };
	const bearer =
		memberToken ?? (/^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(apiKey) ? apiKey : undefined);
	if (bearer) headers.authorization = `Bearer ${bearer}`;
	return headers;
}
