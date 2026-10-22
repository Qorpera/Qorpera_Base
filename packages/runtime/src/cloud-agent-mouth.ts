const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const CLOUD_AGENT_SEND_SCHEMA = "qorpera.agent-send/v1";
/** How an agent links a file of the company folder in a message: a markdown link whose target is `folder:` and the
 * file's company path, which the app opens in the folder's view (21 October 2026). */
export const CLOUD_FOLDER_LINK_EXAMPLE = "[sales-dashboard.html](folder:sales/sales-dashboard.html)";
export const CLOUD_AGENT_SEND_INSTRUCTIONS =
	"send_message sends a message to this conversation. It is your only public voice: ordinary assistant text, reasoning, tool calls and tool results stay private. " +
	"phase progress keeps people informed and does not end your turn. When the reply policy asks you to acknowledge a request, do it with one short progress message before you start work, and never acknowledge twice in the same run. " +
	"phase final delivers this turn's result, a concrete blocker or a decision request, and it ends the turn at once: " +
	"nothing after it runs, so finish every file change, check and coworker message before it. " +
	"Never end with a promise such as I'll do it: say what is done and where it is, and when work goes on after the turn, what runs it (a worker, or a todo behind it). " +
	`Link every file you made or changed in the company folder as a markdown link to folder: and its company path, such as ${CLOUD_FOLDER_LINK_EXAMPLE}. ` +
	"If a send's result was lost, retry with the same idempotencyKey and exactly the same arguments. Never include private reasoning or credentials.";

export interface CloudAgentSendInput {
	idempotencyKey: string;
	text: string;
	phase: "progress" | "final";
}

export interface CloudAgentSendReceipt {
	schema: typeof CLOUD_AGENT_SEND_SCHEMA;
	runId: string;
	sessionId: string;
	messageId: string;
	phase: "progress" | "final";
	sequence: number;
}

export function parseCloudAgentSendInput(value: unknown): CloudAgentSendInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid send arguments");
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).some((key) => !["idempotencyKey", "text", "phase"].includes(key)) ||
		typeof input.idempotencyKey !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.idempotencyKey) ||
		typeof input.text !== "string" ||
		!input.text.trim() ||
		input.text.includes("\0") ||
		Buffer.byteLength(input.text, "utf-8") > 64 * 1024 ||
		(input.phase !== "progress" && input.phase !== "final")
	) {
		throw new Error("Invalid send arguments");
	}
	return { idempotencyKey: input.idempotencyKey, text: input.text, phase: input.phase };
}

export function parseCloudAgentSendReceipt(value: unknown, runId: string): CloudAgentSendReceipt {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid send receipt");
	const receipt = value as Record<string, unknown>;
	if (
		receipt.schema !== CLOUD_AGENT_SEND_SCHEMA ||
		receipt.runId !== runId ||
		typeof receipt.sessionId !== "string" ||
		!UUID_PATTERN.test(receipt.sessionId) ||
		typeof receipt.messageId !== "string" ||
		!UUID_PATTERN.test(receipt.messageId) ||
		(receipt.phase !== "progress" && receipt.phase !== "final") ||
		!Number.isSafeInteger(receipt.sequence) ||
		(receipt.sequence as number) < 1 ||
		Object.keys(receipt).some(
			(key) => !["schema", "runId", "sessionId", "messageId", "phase", "sequence"].includes(key),
		)
	) {
		throw new Error("Invalid send receipt");
	}
	return {
		schema: CLOUD_AGENT_SEND_SCHEMA,
		runId,
		sessionId: receipt.sessionId,
		messageId: receipt.messageId,
		phase: receipt.phase,
		sequence: receipt.sequence as number,
	};
}

/** A run's public voice inside the cloud VM, never a desktop service: the company
 * runtime's `send_message` tool delivers through `send`, in process.
 * The callback commits through the cloud authority before returning a receipt.
 * No provider output stream is connected to it or to the transcript.
 */
export class CloudAgentMouth {
	readonly #runId: string;
	readonly #send: (input: CloudAgentSendInput) => Promise<CloudAgentSendReceipt>;
	readonly #signal?: AbortSignal;
	readonly #receipts = new Map<string, CloudAgentSendReceipt>();
	#pending: Promise<void> = Promise.resolve();
	#closed = false;

	constructor(
		runId: string,
		send: (input: CloudAgentSendInput) => Promise<CloudAgentSendReceipt>,
		signal?: AbortSignal,
	) {
		if (!UUID_PATTERN.test(runId)) throw new Error("Invalid mouth run id");
		this.#runId = runId;
		this.#send = send;
		this.#signal = signal;
	}

	async finish(requireFinalSend = true): Promise<{ messageCount: number; finalMessageId: string | null }> {
		await this.#pending;
		this.#closed = true;
		this.#signal?.throwIfAborted();
		const final = [...this.#receipts.values()].find((receipt) => receipt.phase === "final");
		if (!final && (requireFinalSend || this.#receipts.size > 0)) {
			throw new Error("Native agent turn ended without a final send");
		}
		return { messageCount: this.#receipts.size, finalMessageId: final?.messageId ?? null };
	}

	/** Trusted in-process tool adapter. No listener, bearer or recipient selector. */
	send(value: CloudAgentSendInput): Promise<CloudAgentSendReceipt> {
		const input = parseCloudAgentSendInput(value);
		const delivery = this.#pending.then(async () => {
			if (this.#closed) throw new Error("Mouth is closed");
			this.#signal?.throwIfAborted();
			const receipt = parseCloudAgentSendReceipt(await this.#send(input), this.#runId);
			if (receipt.phase !== input.phase) throw new Error("Send receipt phase changed");
			this.#receipts.set(receipt.messageId, receipt);
			return receipt;
		});
		this.#pending = delivery.then(
			() => undefined,
			() => undefined,
		);
		return delivery;
	}

	/** Refuses every send that has not started and waits for the one in flight. */
	async close(): Promise<void> {
		this.#closed = true;
		await this.#pending;
	}
}
