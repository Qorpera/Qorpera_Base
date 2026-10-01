import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { handleEventIntake, type IntakeStore, IntakeStoreError } from "./event-intake.ts";

function required(name: string): string {
	const value = Deno.env.get(name)?.trim();
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

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

const supabase = createClient(required("SUPABASE_URL"), serviceKey(), {
	auth: { persistSession: false, autoRefreshToken: false },
});

const store: IntakeStore = {
	async receive(address, contentType, headers, bodyBase64) {
		const { data, error } = await supabase.rpc("qorpera_receive_event", {
			p_address: address,
			p_content_type: contentType,
			p_headers: headers,
			p_body_base64: bodyBase64,
		});
		if (error) throw new IntakeStoreError(error.code ?? undefined, error.message);
		if (!data || typeof data !== "object" || Array.isArray(data))
			throw new IntakeStoreError(undefined, "The intake answered without an object");
		return data as Record<string, unknown>;
	},
};

Deno.serve((request) => handleEventIntake(request, store));
