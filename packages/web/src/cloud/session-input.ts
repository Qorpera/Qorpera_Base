import { readBoundedCloudResponse, withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import { SESSION_PROMPT_SCHEMA } from "./api.ts";
import type { Cloud } from "./client.ts";
import { parseSessionInputReceipt, UUID_PATTERN } from "./parse.ts";
import { createWebSessionAttachments, sessionAttachmentIssue } from "./session-attachments.ts";
import type { SessionInputReceipt } from "./types.ts";

export type SessionInputWriter = (
	sessionId: string,
	clientInputId: string,
	text: string,
	signal: AbortSignal,
	files?: readonly File[],
) => Promise<SessionInputReceipt>;

/** Only queues member input. A tab never executes the resulting staff work. */
export function createWebSessionInputWriter(
	cloud: Cloud,
	memberId: string,
	companySignal: AbortSignal,
	current: (sessionId: string) => void,
): SessionInputWriter {
	const origin = new URL(cloud.config.projectUrl);
	if (
		origin.protocol !== "https:" ||
		origin.username ||
		origin.password ||
		origin.pathname !== "/" ||
		origin.search ||
		origin.hash ||
		!UUID_PATTERN.test(memberId)
	)
		throw new Error("Invalid member input configuration.");
	return (sessionId, clientInputId, text, signal, files = []) =>
		withCloudDeadline(
			async (deadline) => {
				if (
					!UUID_PATTERN.test(sessionId) ||
					!UUID_PATTERN.test(clientInputId) ||
					(!text.trim() && !files.length) ||
					new TextEncoder().encode(text).length > 65536
				)
					throw new Error("Message is empty or too large.");
				const issue = sessionAttachmentIssue(files);
				if (issue) throw new Error(issue);
				const check = () => {
					deadline.throwIfAborted();
					current(sessionId);
				};
				check();
				const images: { objectSha256: string; bytes: number; mediaType: string }[] = [];
				if (files.length) {
					const client = createWebSessionAttachments(cloud, memberId, deadline, check);
					// Read every selected file before staging any upload. File objects are
					// immutable; retries retain these exact selections and the input ID.
					const selected: { bytes: Uint8Array<ArrayBuffer>; mediaType: string }[] = [];
					for (const file of files) {
						const bytes = new Uint8Array(await file.arrayBuffer());
						check();
						if (bytes.length !== file.size) throw new Error("The selected image changed.");
						selected.push({ bytes, mediaType: file.type });
					}
					for (const file of selected) {
						check();
						const image = await client.upload(sessionId, clientInputId, file.bytes, file.mediaType, deadline);
						check();
						images.push({ objectSha256: image.sha256, bytes: image.bytes, mediaType: image.mediaType });
					}
				}
				const { data, error } = await cloud.supabase.auth.getSession();
				check();
				if (
					error ||
					data.session?.user.id !== memberId ||
					!data.session ||
					!/^[A-Za-z0-9._~-]{1,8192}$/.test(data.session.access_token)
				)
					throw new Error("Sign in again before sending a message.");
				const response = await fetch(`${origin.origin}/rest/v1/rpc/qorpera_append_session_input`, {
					method: "POST",
					signal: deadline,
					redirect: "error",
					cache: "no-store",
					credentials: "omit",
					headers: {
						authorization: `Bearer ${data.session.access_token}`,
						apikey: cloud.config.publishableKey,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						p_session_id: sessionId,
						p_client_input_id: clientInputId,
						p_kind: "user_message",
						p_body: { schema: SESSION_PROMPT_SCHEMA, text, images },
					}),
				});
				try {
					check();
					if (response.status !== 200)
						throw new Error("Message submission could not be confirmed. Retry to check the same message.");
					const receipt = parseSessionInputReceipt(
						JSON.parse(
							new TextDecoder("utf-8", { fatal: true }).decode(
								await readBoundedCloudResponse(response, 16384, deadline),
							),
						),
					);
					check();
					return receipt;
				} finally {
					if (!response.body?.locked) void response.body?.cancel().catch(() => undefined);
				}
			},
			files.length ? 75000 : 15000,
			AbortSignal.any([companySignal, signal]),
		);
}
