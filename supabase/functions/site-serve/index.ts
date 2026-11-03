import { DEFAULT_SITES_ORIGIN, handleSiteServe, PostgrestSiteStore } from "./site-serve.ts";

function required(name: string): string {
	const value = Deno.env.get(name)?.trim();
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

/** The project's first secret key, else the legacy service role key: the two RPCs are the service role's only. */
function serviceKey(): string {
	try {
		const parsed: unknown = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const key = Object.values(parsed).find(
				(value): value is string => typeof value === "string" && value.length > 20,
			);
			if (key) return key;
		}
	} catch {
		// Fall back to the legacy service role key.
	}
	return required("SUPABASE_SERVICE_ROLE_KEY");
}

/** The sites origin: an https origin and nothing more (no path, query or credentials). */
function sitesOrigin(): string {
	const value = Deno.env.get("QORPERA_SITES_ORIGIN")?.trim() || DEFAULT_SITES_ORIGIN;
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
		throw new Error("QORPERA_SITES_ORIGIN must be an https origin");
	return url.origin;
}

const origin = sitesOrigin();
const store = new PostgrestSiteStore(required("SUPABASE_URL"), serviceKey());

Deno.serve((request) => handleSiteServe(request, { origin, store }));
