import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { configuredSecretKeys, createTimedFetch, preferredServiceKey } from "../_shared/http-guards.ts";
import {
	handleMailOutbox,
	type MailOutboxStore,
	ObjectGatewayReader,
	ResendSender,
	StorageObjectReader,
} from "./mail-outbox.ts";

function required(name: string): string {
	const value = Deno.env.get(name)?.trim();
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

const supabaseUrl = required("SUPABASE_URL");
const RPC_FETCH = createTimedFetch({ timeoutMs: 15_000 });
let cachedClient:
	| { readonly key: string; readonly client: ReturnType<typeof createClient> }
	| undefined;

function serviceClient(fallbackKey: string): ReturnType<typeof createClient> {
	// WHY: Prefer locally verified SUPABASE_SERVICE_ROLE_KEY over KMS sb_secret keys and reuse the timed client across cron calls.
	const key = preferredServiceKey((name) => Deno.env.get(name)) ?? fallbackKey;
	if (!cachedClient || cachedClient.key !== key) {
		cachedClient = {
			key,
			client: createClient(supabaseUrl, key, {
				auth: { persistSession: false, autoRefreshToken: false },
				global: { fetch: RPC_FETCH },
			}),
		};
	}
	return cachedClient.client;
}

const objectGatewayUrl = Deno.env.get("QORPERA_OBJECT_GATEWAY_URL")?.trim() || undefined;
const objectGatewayInternalToken = Deno.env.get("QORPERA_OBJECT_GATEWAY_INTERNAL_TOKEN")?.trim() || undefined;
if (Boolean(objectGatewayUrl) !== Boolean(objectGatewayInternalToken)) {
	throw new Error("QORPERA_OBJECT_GATEWAY_URL and QORPERA_OBJECT_GATEWAY_INTERNAL_TOKEN must be set together");
}
const gatewayObjects =
	objectGatewayUrl && objectGatewayInternalToken
		? new ObjectGatewayReader(objectGatewayUrl, objectGatewayInternalToken)
		: undefined;
const sender = new ResendSender(required("RESEND_API_KEY"));

function store(secretKey: string): MailOutboxStore {
	const client = serviceClient(secretKey);
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
		async messageIdsDue(limit) {
			const { data, error } = await client.rpc("qorpera_company_mail_message_ids_due", { p_limit: limit });
			if (error) throw new Error("The mail message ids could not be read");
			return data;
		},
		async recordMessageId(mailId, providerMessageId, messageId) {
			const { error } = await client.rpc("qorpera_record_company_mail_message_id", {
				p_mail_id: mailId,
				p_provider_message_id: providerMessageId,
				p_message_id: messageId,
			});
			if (error) throw new Error("The mail message id could not be recorded");
		},
	};
}

Deno.serve((request) =>
	handleMailOutbox(request, {
		keys: configuredSecretKeys((name) => Deno.env.get(name)),
		store,
		objects: (secretKey) =>
			gatewayObjects ??
			new StorageObjectReader(supabaseUrl, preferredServiceKey((name) => Deno.env.get(name)) ?? secretKey),
		sender,
	}),
);
