import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { handleMailOutbox, type MailOutboxStore, ResendSender } from "./mail-outbox.ts";

function required(name: string): string {
	const value = Deno.env.get(name)?.trim();
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

/** The project's secret keys and the legacy service role key: the callers pg_cron may present. */
function secretKeys(): string[] {
	const keys: string[] = [];
	try {
		const parsed: unknown = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
			keys.push(...Object.values(parsed).filter((value): value is string => typeof value === "string" && value.length > 20));
	} catch {
		// Only the legacy key, then.
	}
	const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
	if (legacy) keys.push(legacy);
	return [...new Set(keys)];
}

const supabaseUrl = required("SUPABASE_URL");
const sender = new ResendSender(required("RESEND_API_KEY"));

function store(secretKey: string): MailOutboxStore {
	const client = createClient(supabaseUrl, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
	const fail = async (mailId: string, leaseId: string, message: string, retryable: boolean) => {
		const { data, error } = await client.rpc("qorpera_fail_company_mail", {
			p_mail_id: mailId,
			p_lease_id: leaseId,
			p_error: message,
			p_retryable: retryable,
		});
		if (error || data !== true) throw new Error("The mail failure could not be recorded");
	};
	return {
		async claim(limit, leaseId) {
			const { data, error } = await client.rpc("qorpera_claim_company_mail", { p_limit: limit, p_lease_id: leaseId });
			if (error) throw new Error("The mail claim failed");
			return data;
		},
		async complete(job, providerMessageId) {
			const { data, error } = await client.rpc("qorpera_complete_company_mail", {
				p_mail_id: job.mailId,
				p_lease_id: job.leaseId,
				p_provider_message_id: providerMessageId,
			});
			if (error || data !== true) throw new Error("The mail completion failed");
		},
		fail,
	};
}

Deno.serve((request) => handleMailOutbox(request, { keys: secretKeys(), store, sender }));
