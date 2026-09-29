import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { handleMailIntake, type MailProvider, type MailStore, MailStoreError } from "./mail-intake.ts";

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
const resendApiKey = required("RESEND_API_KEY");
const secret = required("RESEND_WEBHOOK_SECRET");

const store: MailStore = {
	async receive(emailId, recipient, message) {
		const { data, error } = await supabase.rpc("qorpera_receive_mail", {
			p_email_id: emailId,
			p_recipient: recipient,
			p_message: message,
		});
		if (error) throw new MailStoreError(error.code ?? undefined, error.message);
		if (!data || typeof data !== "object" || Array.isArray(data))
			throw new MailStoreError(undefined, "The mail door answered without an object");
		return data as Record<string, unknown>;
	},
};

const provider: MailProvider = {
	async fetch(emailId) {
		const response = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
			headers: { authorization: `Bearer ${resendApiKey}` },
			signal: AbortSignal.timeout(15_000),
		});
		if (response.status === 404) return null;
		if (!response.ok) throw new Error(`Resend returned HTTP ${response.status}`);
		const body: unknown = await response.json();
		if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Resend answered without an object");
		return body as Record<string, unknown>;
	},
};

Deno.serve((request) => handleMailIntake(request, { secret, store, provider }));
