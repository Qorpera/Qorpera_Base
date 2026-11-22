import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { withTimeoutScope } from "../_shared/abort-timeout.ts";
import { handleMailIntake, type MailProvider, type MailStore, MailStoreError } from "./mail-intake.ts";

const MAX_PROVIDER_BODY_BYTES = 4 * 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

async function readBoundedJson(response: Response, limit: number): Promise<unknown> {
	const declared = response.headers.get("content-length");
	if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) {
		void response.body?.cancel().catch(() => undefined);
		throw new Error("Resend answer exceeded size limit");
	}
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Resend answered without a body");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > limit) throw new Error("Resend answer exceeded size limit");
			chunks.push(value);
		}
	} finally {
		void reader.cancel().catch(() => undefined);
	}
	let merged: Uint8Array;
	if (chunks.length === 1) {
		merged = chunks[0]!;
	} else {
		merged = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			merged.set(chunk, offset);
			offset += chunk.byteLength;
		}
	}
	return JSON.parse(UTF8_DECODER.decode(merged));
}

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
	async receive(emailId, recipients, message) {
		const { data, error } = await supabase.rpc("qorpera_receive_mail", {
			p_email_id: emailId,
			p_recipients: recipients,
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
		return withTimeoutScope(8_000, async (signal) => {
			const response = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
				headers: { authorization: `Bearer ${resendApiKey}` },
				signal,
			});
			if (response.status === 404) {
				void response.body?.cancel().catch(() => undefined);
				return null;
			}
			if (!response.ok) {
				void response.body?.cancel().catch(() => undefined);
				throw new Error(`Resend returned HTTP ${response.status}`);
			}
			const body: unknown = await readBoundedJson(response, MAX_PROVIDER_BODY_BYTES);
			if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Resend answered without an object");
			return body as Record<string, unknown>;
		});
	},
};

Deno.serve((request) => handleMailIntake(request, { secret, store, provider }));
