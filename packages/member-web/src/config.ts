export interface MemberWebConfig {
	schema: "qorpera.member-web-config/v1";
	supabaseUrl: string;
	publishableKey: string;
	officeViewerOrigin: string | null;
}
function origin(value: unknown, websocket = false): string {
	if (typeof value !== "string" || value.length > 2048) throw new Error("Invalid web service origin");
	const url = new URL(value);
	if (
		url.origin !== value ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/" ||
		(websocket
			? url.protocol !== "wss:"
			: url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1"))
	)
		throw new Error("Invalid web service origin");
	return value;
}
/** Public deployment configuration only. No token, native identity, provider
 * endpoint or service credential may enter the static web application. */
export function parseMemberWebConfig(value: unknown): MemberWebConfig {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !== "officeViewerOrigin,publishableKey,schema,supabaseUrl"
	)
		throw new Error("Invalid web configuration");
	const row = value as Record<string, unknown>;
	if (
		row.schema !== "qorpera.member-web-config/v1" ||
		typeof row.publishableKey !== "string" ||
		row.publishableKey.length > 8192
	)
		throw new Error("Invalid web configuration");
	const key = row.publishableKey;
	if (!/^sb_publishable_[A-Za-z0-9_-]{8,}$/.test(key)) {
		const parts = key.split(".");
		try {
			if (parts.length !== 3 || parts.some((part) => !part || !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
			const payload = JSON.parse(atob(parts[1].replaceAll("-", "+").replaceAll("_", "/")));
			if (payload.role !== "anon" || payload.sub) throw new Error();
		} catch {
			throw new Error("Web configuration requires a public publishable key");
		}
	}
	return {
		schema: row.schema,
		supabaseUrl: origin(row.supabaseUrl),
		publishableKey: key,
		officeViewerOrigin: row.officeViewerOrigin === null ? null : origin(row.officeViewerOrigin, true),
	};
}

export function memberWebCsp(config: MemberWebConfig): string {
	return `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ${config.supabaseUrl}${config.officeViewerOrigin ? ` ${config.officeViewerOrigin}` : ""}; img-src data: blob:; font-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}
