import { preferredServiceKey } from "../_shared/http-guards.ts";
import { DEFAULT_SITES_ORIGIN, handleSiteServe, PostgrestSiteStore, webOrigins } from "./site-serve.ts";

function required(name: string): string {
	const value = Deno.env.get(name)?.trim();
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

function serviceKey(): string {
	const key = preferredServiceKey((name) => Deno.env.get(name));
	if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
	return key;
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
// The web's exact origins (the stack's QORPERA_WEB_ORIGINS, as other functions read it): the production app when unset.
const web = webOrigins(Deno.env.get("QORPERA_WEB_ORIGINS"));

Deno.serve((request) => handleSiteServe(request, { origin, store, webOrigins: web }));
