import { withTimeoutScope } from "../_shared/abort-timeout.ts";
import { preferredServiceKey, readBoundedJson, withAbortSignal } from "../_shared/http-guards.ts";
import { createPostgrestClient } from "../_shared/postgrest-rpc.ts";
import { handleMailIntake, type MailProvider, type MailStore, MailStoreError } from "./mail-intake.ts";

const MAX_PROVIDER_BODY_BYTES = 4 * 1024 * 1024;

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

const supabase = createPostgrestClient(required("SUPABASE_URL"), serviceKey(), { timeoutMs: 15_000 });
const resendApiKey = required("RESEND_API_KEY");
const secret = required("RESEND_WEBHOOK_SECRET");

const store: MailStore = {
	async receive(emailId, recipients, message, signal) {
		const { data, error } = await withAbortSignal(
			supabase.rpc("qorpera_receive_mail", {
				p_email_id: emailId,
				p_recipients: recipients,
				p_message: message,
			}),
			signal,
		);
		if (error) throw new MailStoreError(error.code ?? undefined, error.message);
		if (!data || typeof data !== "object" || Array.isArray(data))
			throw new MailStoreError(undefined, "The mail door answered without an object");
		return data as Record<string, unknown>;
	},
};

const provider: MailProvider = {
	async fetch(emailId, parentSignal) {
		return withTimeoutScope(
			8_000,
			async (signal) => {
				const response = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
					headers: { authorization: `Bearer ${resendApiKey}` },
					redirect: "error",
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
				const body = await readBoundedJson(response, MAX_PROVIDER_BODY_BYTES, {
					signal,
					ignoreContentLength: response.headers.has("content-encoding"),
					sizeErrorMessage: "Resend answer exceeded size limit",
				});
				if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Resend answered without an object");
				return body as Record<string, unknown>;
			},
			parentSignal,
		);
	},
};

Deno.serve((request) => handleMailIntake(request, { secret, store, provider }));
