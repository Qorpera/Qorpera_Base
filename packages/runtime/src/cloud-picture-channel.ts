/**
 * The seam between a run's Codex app-server and the tool that makes pictures, make_picture
 * (deploy/first-node/RUNTIME-INTERFACE-APPS.md §3c): the session attaches its picture lane here once the agent's thread
 * is bound, and only for a Codex login's run. A picture is made on a side thread of the run's own Codex, the one thread
 * of the run with Codex's image feature on; the agent's own thread never has it. The engine behind the tool may change
 * (Jonas, 10 November 2026: one Qorpera tool per capability), so nothing here names Codex's own tool.
 */

/** What the side thread's model is told: it makes one picture and does nothing else. */
export const CLOUD_PICTURE_MAKER_RULE =
	"You make pictures and nothing else. Each message is the description of one picture. Call image_gen.imagegen exactly once, with that description as its prompt, word for word, and no other argument. Never answer in words, never ask a question and never use another tool.";

/** What one picture's description may be: a few paragraphs of plain text. */
export const MAX_CLOUD_PICTURE_PROMPT_BYTES = 4 * 1024;
export const MAX_CLOUD_PICTURE_BYTES = 12 * 1024 * 1024;
/** How long a call waits for its picture: a generation takes up to about two minutes. */
export const CLOUD_PICTURE_MS = 4 * 60_000;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Whether bytes start as a PNG does. */
export function isCloudPicturePng(bytes: Uint8Array): boolean {
	return bytes.byteLength >= PNG_SIGNATURE.byteLength && PNG_SIGNATURE.equals(bytes.subarray(0, PNG_SIGNATURE.length));
}

export interface CloudPictureInput {
	/** What to draw, in words. */
	readonly prompt: string;
}

/** A picture's description as the lane sends it, or an error naming what is wrong; never the description itself. */
export function cloudPictureInput(input: CloudPictureInput): { prompt: string } {
	if (
		typeof input.prompt !== "string" ||
		!input.prompt.trim() ||
		!input.prompt.isWellFormed() ||
		Buffer.byteLength(input.prompt) > MAX_CLOUD_PICTURE_PROMPT_BYTES ||
		// Line breaks and tabs, no other control character.
		[...input.prompt].some((character) => {
			const code = character.charCodeAt(0);
			return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;
		})
	)
		throw new Error("Invalid picture prompt");
	return { prompt: input.prompt };
}

/** A picture made. */
export interface CloudPictureMade {
	/** The PNG as the generator gave it, checked by its signature and its size. */
	readonly png: Buffer;
	/** The prompt the generator was given, as the picture's model wrote it: at most MAX_CLOUD_PICTURE_PROMPT_BYTES, cut
	 * at a character's end when it was longer (`revisedPromptCut`). */
	readonly revisedPrompt?: string;
	readonly revisedPromptCut?: true;
	/** Whether the generator made its background transparent, when it said. */
	readonly transparent?: boolean;
}

/** Why no picture came back, in a closed vocabulary the tool words for the agent. */
export type CloudPictureFailureReason =
	/** The member's plan has no pictures left for now (`usageLimitExceeded` with `limitId` image_gen). */
	| "picture_limit"
	/** The member's ChatGPT usage limit stopped the picture's model turn. */
	| "usage_limit"
	| "spend_cap"
	| "billing_required"
	/** The image tool was called, and the generator refused the prompt or failed. */
	| "refused"
	/** The image tool was never called, and Codex said the member's plan is Free, which has none. */
	| "free_plan"
	/** The image tool was never called, for a reason not known: the model declined the prompt, or this sign-in, its
	 * plan, the model or the thread's config gave it no image tool. */
	| "no_picture"
	/** No picture within the call's time. */
	| "timeout"
	/** What came back is not a usable PNG, or not where the generator keeps it. */
	| "invalid"
	/** The picture is larger than every picture may be. */
	| "too_large"
	/** A picture is being made in this run already. */
	| "busy"
	/** Codex refused a step of the call. */
	| "failed";

export class CloudPictureFailure extends Error {
	readonly reason: CloudPictureFailureReason;
	/** When the member's picture limit resets (Unix seconds), when the provider said. */
	readonly resetsAt?: number;
	constructor(reason: CloudPictureFailureReason, resetsAt?: number) {
		super(`Native picture failed: ${reason}`);
		this.name = "CloudPictureFailure";
		this.reason = reason;
		if (resetsAt !== undefined) this.resetsAt = resetsAt;
	}
}

/** What `make` rejects with when no run's lane is attached: no run, a run on a ChatGPT plan, or a run that ended. */
export class CloudPictureUnavailable extends Error {
	constructor() {
		super("Pictures are not available in this run");
		this.name = "CloudPictureUnavailable";
	}
}

/** Makes one picture on the run's own app-server. */
export type CloudPictureLane = (input: CloudPictureInput, signal: AbortSignal) => Promise<CloudPictureMade>;

/** The run's pictures, asked for by a tool before or after the session that makes them is up. */
export class CloudPictureChannel {
	#lane?: CloudPictureLane;
	/** How long a call waits for its picture; CLOUD_PICTURE_MS when absent. Only tests shorten it. */
	readonly timeoutMs?: number;

	constructor(options: { timeoutMs?: number } = {}) {
		if (options.timeoutMs !== undefined) this.timeoutMs = options.timeoutMs;
	}

	attach(lane: CloudPictureLane | undefined): void {
		this.#lane = lane;
	}

	/** Whether a lane is attached: a run whose login can make pictures, while its process lasts. */
	get attached(): boolean {
		return this.#lane !== undefined;
	}

	make(input: CloudPictureInput, signal: AbortSignal): Promise<CloudPictureMade> {
		return this.#lane ? this.#lane(input, signal) : Promise.reject(new CloudPictureUnavailable());
	}
}
