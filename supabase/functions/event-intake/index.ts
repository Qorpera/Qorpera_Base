import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { createTimedFetch, preferredServiceKey, withAbortSignal } from "../_shared/http-guards.ts";
import { handleEventIntake, type IntakeStore, IntakeStoreError } from "./event-intake.ts";

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

const supabase = createClient(required("SUPABASE_URL"), serviceKey(), {
	auth: { persistSession: false, autoRefreshToken: false },
	global: { fetch: createTimedFetch({ timeoutMs: 15_000 }) },
});

const store: IntakeStore = {
	async receive(address, contentType, headers, bodyBase64, signal) {
		const { data, error } = await withAbortSignal(
			supabase.rpc("qorpera_receive_event", {
				p_address: address,
				p_content_type: contentType,
				p_headers: headers,
				p_body_base64: bodyBase64,
			}),
			signal,
		);
		if (error) throw new IntakeStoreError(error.code ?? undefined, error.message);
		if (!data || typeof data !== "object" || Array.isArray(data))
			throw new IntakeStoreError(undefined, "The intake answered without an object");
		return data as Record<string, unknown>;
	},
};

Deno.serve((request) => handleEventIntake(request, store));
