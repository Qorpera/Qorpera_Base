import { readBoundedCloudResponse, withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import { createClient } from "@supabase/supabase-js";
import { type MemberWebConfig, parseMemberWebConfig } from "./config.ts";

const storageKey = "qorpera.member-web.auth";
/** Only this application's session and PKCE verifier. Never clear other apps'
 * origin storage, even when local sign-out cannot reach Auth. */
export function webAuthStorage(storage: Storage) {
	return {
		getItem: (key: string) => storage.getItem(key),
		setItem: (key: string, value: string) => storage.setItem(key, value),
		removeItem: (key: string) => storage.removeItem(key),
		clear() {
			for (const key of Object.keys(storage)) {
				if (key === storageKey || key.startsWith(`${storageKey}-`)) storage.removeItem(key);
			}
		},
	};
}
export async function loadMemberWebConfig(pageUrl: string, request: typeof fetch = fetch): Promise<MemberWebConfig> {
	const url = new URL("/config.json", pageUrl);
	return withCloudDeadline(
		async (signal) => {
			const response = await request(url, {
				signal,
				redirect: "error",
				cache: "no-store",
				credentials: "same-origin",
			});
			if (response.status !== 200) {
				void response.body?.cancel().catch(() => undefined);
				throw new Error("Web configuration is unavailable");
			}
			return parseMemberWebConfig(
				JSON.parse(
					new TextDecoder("utf-8", { fatal: true }).decode(
						await readBoundedCloudResponse(response, 16384, signal),
					),
				),
			);
		},
		8000,
		new AbortController().signal,
	);
}

export function createWebAuth(config: MemberWebConfig, storage: Storage, request: typeof fetch = fetch) {
	const settings = parseMemberWebConfig(config),
		local = webAuthStorage(storage);
	const boundedAuthFetch: typeof fetch = async (input, init) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		if (url.origin !== settings.supabaseUrl || !url.pathname.startsWith("/auth/v1/"))
			throw new Error("Invalid sign-in endpoint");
		return withCloudDeadline(
			async (signal) => {
				const response = await request(input, {
					...init,
					signal,
					redirect: "error",
					cache: "no-store",
					credentials: "omit",
				});
				const bytes = await readBoundedCloudResponse(response, 1024 * 1024, signal);
				return new Response([204, 205, 304].includes(response.status) ? null : Uint8Array.from(bytes), {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				});
			},
			10000,
			init?.signal ?? new AbortController().signal,
		);
	};
	const client = createClient(settings.supabaseUrl, settings.publishableKey, {
		global: { fetch: boundedAuthFetch },
		auth: {
			flowType: "pkce",
			storageKey,
			storage: local,
			persistSession: true,
			autoRefreshToken: true,
			detectSessionInUrl: true,
		},
	});
	return { client, clear: () => local.clear() };
}

export function webOAuthDestination(value: string, config: MemberWebConfig): string {
	const url = new URL(value);
	if (
		url.origin !== config.supabaseUrl ||
		url.pathname !== "/auth/v1/authorize" ||
		url.username ||
		url.password ||
		url.hash
	)
		throw new Error("Invalid sign-in destination");
	return url.href;
}
