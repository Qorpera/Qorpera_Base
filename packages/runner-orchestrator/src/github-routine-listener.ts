import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
	compileRoutineTrigger,
	type GitHubRoutineEvent,
	type GitHubRoutineListener,
	parseRoutinePolicy,
	policyInteger,
	policyRecord,
	type RoutinePolicy,
	routineInstant,
	routineUuid,
} from "./routine-policy.ts";

export const GITHUB_WEBHOOK_MAX_BYTES = 256 * 1024;
export const GITHUB_WEBHOOK_MAX_DEPTH = 32;
export const GITHUB_WEBHOOK_MAX_NODES = 16_384;

export interface GitHubListenerBinding {
	routineId: string;
	version: number;
	epoch: number;
	activeSince: string;
	status: "active" | "paused" | "retired";
	suspended: boolean;
	trigger: GitHubRoutineListener;
	policy: RoutinePolicy;
}

export interface NormalizedGitHubEvent {
	schema: "qorpera.github-event/v1";
	source: "github";
	trust: "external";
	event: GitHubRoutineEvent;
	action: "opened" | "edited" | "reopened" | "synchronize" | "closed" | "review_requested";
	installationId: string;
	repositoryId: string;
	pullRequestId: string;
	number: number;
	senderId: string;
	updatedAt: string;
	headSha: string;
	reviewTarget: string | null;
}

export interface VerifiedGitHubDelivery {
	schema: "qorpera.github-delivery/v1";
	routineId: string;
	version: number;
	epoch: number;
	triggerId: string;
	connectionId: string;
	deliveryId: string;
	bodySha256: string;
	eventKey: string;
	receivedAt: string;
	event: NormalizedGitHubEvent;
}

export interface GitHubDeliveryReceipt {
	schema: "qorpera.github-delivery-receipt/v1";
	status: "admitted" | "duplicate" | "ignored" | "denied";
	occurrenceId: string | null;
}

export interface GitHubListenerAdapters {
	/** Step 7's trusted bridge resolves the pinned webhook secret, never a model-visible connector token. */
	resolveWebhookSecret(connectionId: string, signal: AbortSignal): Promise<Uint8Array>;
	/** MUST apply policy/activation/freshness and Step 7 grants inside the durable admission transaction, including ignored receipts. */
	admit(delivery: VerifiedGitHubDelivery, signal: AbortSignal): Promise<GitHubDeliveryReceipt>;
}

class WebhookRejection extends Error {
	readonly status: number;
	constructor(status: number) {
		super("GitHub webhook rejected");
		this.status = status;
	}
}

/** GitHub signs bytes, not parsed/re-serialized JSON or delivery headers. */
export function verifyGitHubWebhook(body: Uint8Array, signature: string | null, secret: Uint8Array): boolean {
	if (!signature || !/^sha256=[0-9a-f]{64}$/.test(signature) || secret.byteLength === 0 || secret.byteLength > 4096)
		return false;
	const expected = createHmac("sha256", secret).update(body).digest();
	return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}

async function abortableWebhookCall<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	let onAbort: () => void = () => undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(new WebhookRejection(408));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([call(), aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

async function boundedBody(request: Request, signal: AbortSignal): Promise<Uint8Array> {
	const length = request.headers.get("content-length");
	if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > GITHUB_WEBHOOK_MAX_BYTES))
		throw new WebhookRejection(413);
	if (!request.body) throw new WebhookRejection(400);
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const chunk = await abortableWebhookCall(() => reader.read(), signal);
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > GITHUB_WEBHOOK_MAX_BYTES) throw new WebhookRejection(413);
			chunks.push(chunk.value);
		}
		if (length !== null && bytes !== Number(length)) throw new WebhookRejection(400);
		return Buffer.concat(chunks, bytes);
	} finally {
		// Do not wait indefinitely for an untrusted stream's cancellation hook.
		void reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

function boundedJson(bytes: Uint8Array): Record<string, unknown> {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new WebhookRejection(400);
	}
	let depth = 0,
		quoted = false,
		escaped = false;
	for (const char of text) {
		if (quoted) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') quoted = false;
		} else if (char === '"') quoted = true;
		else if (char === "{" || char === "[") {
			if (++depth > GITHUB_WEBHOOK_MAX_DEPTH) throw new WebhookRejection(413);
		} else if (char === "}" || char === "]") depth--;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new WebhookRejection(400);
	}
	const pending: unknown[] = [parsed];
	let nodes = 0;
	while (pending.length) {
		if (++nodes > GITHUB_WEBHOOK_MAX_NODES) throw new WebhookRejection(413);
		const item = pending.pop();
		if (item && typeof item === "object") pending.push(...Object.values(item));
	}
	try {
		return policyRecord(parsed, "webhook payload");
	} catch {
		throw new WebhookRejection(400);
	}
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

function githubId(value: unknown): string {
	// Do not silently round an identity parsed from an unsafe JSON number.
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new WebhookRejection(400);
	return String(value);
}

function githubTime(value: unknown): string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value))
		throw new WebhookRejection(400);
	const canonical = `${value.slice(0, -1)}.000Z`;
	try {
		routineInstant(canonical);
	} catch {
		throw new WebhookRejection(400);
	}
	return canonical;
}

function normalizePullRequest(payload: Record<string, unknown>): NormalizedGitHubEvent | undefined {
	const action = payload.action;
	if (typeof action !== "string") throw new WebhookRejection(400);
	if (
		action !== "opened" &&
		action !== "edited" &&
		action !== "reopened" &&
		action !== "synchronize" &&
		action !== "closed" &&
		action !== "review_requested"
	)
		return undefined;
	const pr = policyRecord(payload.pull_request, "GitHub pull request"),
		repository = policyRecord(payload.repository, "GitHub repository");
	const sender = policyRecord(payload.sender, "GitHub sender"),
		installation = policyRecord(payload.installation, "GitHub App installation");
	const head = policyRecord(pr.head, "GitHub pull request head"),
		base = policyRecord(pr.base, "GitHub pull request base");
	const baseRepository = policyRecord(base.repo, "GitHub base repository");
	if (githubId(baseRepository.id) !== githubId(repository.id) || sender.login === "ghost")
		throw new WebhookRejection(403);
	if (
		typeof head.sha !== "string" ||
		!/^[0-9a-f]{40}$/.test(head.sha) ||
		typeof pr.merged !== "boolean" ||
		!Number.isSafeInteger(pr.number) ||
		payload.number !== pr.number ||
		(pr.state !== "open" && pr.state !== "closed")
	)
		throw new WebhookRejection(400);
	// Title/body edits remain valid after closure or merge. Other actions still
	// require their corresponding state; a merged PR cannot be open.
	if (
		(pr.merged && pr.state !== "closed") ||
		(action === "closed" && pr.state !== "closed") ||
		(action !== "closed" && action !== "edited" && pr.state !== "open")
	)
		throw new WebhookRejection(400);
	if (action === "closed" && !pr.merged) return undefined;
	let reviewTarget: string | null = null;
	if (action === "review_requested") {
		if (Boolean(payload.requested_reviewer) === Boolean(payload.requested_team)) throw new WebhookRejection(400);
		reviewTarget = payload.requested_reviewer
			? `user:${githubId(policyRecord(payload.requested_reviewer, "reviewer").id)}`
			: `team:${githubId(policyRecord(payload.requested_team, "review team").id)}`;
	}
	const event: GitHubRoutineEvent =
		action === "opened"
			? "pull_request.opened"
			: action === "closed"
				? "pull_request.merged"
				: action === "review_requested"
					? "pull_request.review_requested"
					: "pull_request.updated";
	return Object.freeze({
		schema: "qorpera.github-event/v1",
		source: "github",
		trust: "external",
		event,
		action,
		installationId: githubId(installation.id),
		repositoryId: githubId(repository.id),
		pullRequestId: githubId(pr.id),
		number: policyInteger(pr.number, 1, Number.MAX_SAFE_INTEGER),
		senderId: githubId(sender.id),
		updatedAt: githubTime(pr.updated_at),
		headSha: head.sha,
		reviewTarget,
	});
}

/** Stateless cloud HTTP adapter. It never starts a listener, creates a queue, resolves model credentials, or executes work. */
export async function handleGitHubRoutineWebhook(
	request: Request,
	binding: GitHubListenerBinding | undefined,
	adapters: GitHubListenerAdapters | undefined,
	now: string,
): Promise<Response> {
	const reply = (status: number) => new Response(null, { status });
	if (
		!binding ||
		!adapters ||
		typeof adapters.resolveWebhookSecret !== "function" ||
		typeof adapters.admit !== "function"
	)
		return reply(503);
	if (request.method !== "POST") return reply(405);
	if (
		!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "") ||
		request.headers.has("content-encoding")
	)
		return reply(415);
	const deliveryId = request.headers.get("x-github-delivery");
	if (!deliveryId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deliveryId))
		return reply(400);
	const eventHeader = request.headers.get("x-github-event");
	if (!eventHeader || eventHeader.includes(",") || eventHeader.length > 100) return reply(400);
	const signal = AbortSignal.any([request.signal, AbortSignal.timeout(8000)]);
	try {
		const policy = parseRoutinePolicy(binding.policy),
			trigger = compileRoutineTrigger([binding.trigger], policy);
		if (trigger.kind !== "listener" || trigger.source !== "github") return reply(503);
		routineUuid(binding.routineId);
		policyInteger(binding.version, 1, Number.MAX_SAFE_INTEGER);
		policyInteger(binding.epoch, 1, Number.MAX_SAFE_INTEGER);
		routineInstant(now);
		routineInstant(binding.activeSince);
		if (typeof binding.suspended !== "boolean" || !["active", "paused", "retired"].includes(binding.status))
			return reply(503);
		const body = await boundedBody(request, signal);
		const secret = await abortableWebhookCall(
			() => adapters.resolveWebhookSecret(trigger.connectionId, signal),
			signal,
		);
		if (!verifyGitHubWebhook(body, request.headers.get("x-hub-signature-256"), secret)) return reply(401);
		if (eventHeader !== "pull_request") return reply(204);
		const payload = boundedJson(body);
		let event: NormalizedGitHubEvent | undefined;
		try {
			event = normalizePullRequest(payload);
		} catch (error) {
			if (error instanceof WebhookRejection) throw error;
			throw new WebhookRejection(400);
		}
		if (!event) return reply(204);
		if (
			event.installationId !== trigger.installationId ||
			event.repositoryId !== trigger.repositoryId ||
			(trigger.actors.mode === "allowlist" && !trigger.actors.ids.includes(event.senderId))
		)
			return reply(403);
		// Even a paused/quiet/unselected delivery gets a durable decision. A
		// cached binding cannot safely decide current eligibility or forget an
		// ignored signed event that could otherwise replay after a resume.
		const delivery: VerifiedGitHubDelivery = Object.freeze({
			schema: "qorpera.github-delivery/v1",
			routineId: binding.routineId,
			version: binding.version,
			epoch: binding.epoch,
			triggerId: trigger.id,
			connectionId: trigger.connectionId,
			deliveryId: deliveryId.toLowerCase(),
			bodySha256: createHash("sha256").update(body).digest("hex"),
			// A changed unsigned delivery GUID cannot turn identical signed bytes
			// into another event. Canonicalization also catches re-serialized JSON.
			eventKey: createHash("sha256").update(canonicalJson(payload)).digest("hex"),
			receivedAt: now,
			event,
		});
		const receipt = await abortableWebhookCall(() => adapters.admit(delivery, signal), signal);
		if (
			receipt.schema !== "qorpera.github-delivery-receipt/v1" ||
			!["admitted", "duplicate", "ignored", "denied"].includes(receipt.status) ||
			(receipt.status === "admitted" && receipt.occurrenceId === null) ||
			((receipt.status === "ignored" || receipt.status === "denied") && receipt.occurrenceId !== null)
		)
			return reply(503);
		if (receipt.occurrenceId !== null) routineUuid(receipt.occurrenceId);
		return reply(receipt.status === "denied" ? 403 : 202);
	} catch (error) {
		// Never reflect a secret bridge, database, raw payload or signature error.
		return reply(error instanceof WebhookRejection ? error.status : signal.aborted ? 408 : 503);
	}
}
