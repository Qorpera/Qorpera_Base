import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import {
	type AttachmentFetchStore,
	handleMailAttachments,
	ResendAttachments,
	StorageObjectSink,
} from "./mail-attachments.ts";

function required(name: string): string {
	const value = Deno.env.get(name)?.trim();
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

/** The project's secret keys and the legacy service role key: the callers pg_cron and pg_net may present. */
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
const provider = new ResendAttachments(required("RESEND_API_KEY"));

function store(secretKey: string): AttachmentFetchStore {
	const client = createClient(supabaseUrl, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
	return {
		async claim(limit, leaseId) {
			const { data, error } = await client.rpc("qorpera_claim_mail_attachment_fetches", {
				p_limit: limit,
				p_lease_id: leaseId,
			});
			if (error) throw new Error("The attachment claim failed");
			return data;
		},
		async complete(job, stored) {
			const { data, error } = await client.rpc("qorpera_complete_mail_attachment_fetch", {
				p_fetch_id: job.fetchId,
				p_lease_id: job.leaseId,
				p_file_sha256: stored.fileSha256,
				p_bytes: stored.bytes,
				p_chunks: stored.chunks,
			});
			if (error || data !== true) throw new Error("The attachment completion failed");
		},
		async fail(job, message, retryable) {
			const { data, error } = await client.rpc("qorpera_fail_mail_attachment_fetch", {
				p_fetch_id: job.fetchId,
				p_lease_id: job.leaseId,
				p_error: message,
				p_retryable: retryable,
			});
			if (error || data !== true) throw new Error("The attachment failure could not be recorded");
		},
	};
}

Deno.serve((request) =>
	handleMailAttachments(request, {
		keys: secretKeys(),
		store,
		sink: (secretKey) => new StorageObjectSink(supabaseUrl, secretKey),
		provider,
	}),
);
