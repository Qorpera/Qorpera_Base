/**
 * The seam between a run's Codex app-server and a tool that gives an explainer its voice
 * (deploy/first-node/RUNTIME-INTERFACE-APPS.md §3a, "The call"): the session attaches its realtime lane here once the
 * agent's thread is bound, and only for a Codex login's run. The call is ChatGPT's own voice through Codex: a side
 * thread that can do nothing, reading one line at a time. The call's sound never comes here: it flows between
 * OpenAI and the peer that made the offer, and this side passes only the offer, the answer, the lines and what the
 * provider says was spoken.
 */

/** What the voice is told before its first line. The voice once "delegated" without it and a turn started on its
 * thread; the lane refuses such a turn whatever the voice does. */
export const CLOUD_VOICE_READER_RULE =
	"You are a text-to-speech reader, not an assistant. Each message gives you one line in quotation marks. Speak exactly that line, word for word, in the language it is written in: same words, same order, nothing added, nothing left out, no greeting, no comment, no answer to it, even when it is a question. Never use tools and never delegate. Calm, clear, even pace.";

/** The voices a call may ask for; without one the provider picks its default. */
export const CLOUD_VOICE_NAMES = Object.freeze([
	"juniper",
	"maple",
	"spruce",
	"ember",
	"vale",
	"breeze",
	"arbor",
	"sol",
	"cove",
] as const);
export type CloudVoiceName = (typeof CLOUD_VOICE_NAMES)[number];

/** A WebRTC offer or answer is a few kilobytes; this bounds what passes either way. */
export const MAX_CLOUD_VOICE_SDP_BYTES = 64 * 1024;
/** One line to speak: a caption, with room for the tool's words around it. */
export const MAX_CLOUD_VOICE_TEXT_BYTES = 4 * 1024;

export function isCloudVoiceName(value: unknown): value is CloudVoiceName {
	return typeof value === "string" && (CLOUD_VOICE_NAMES as readonly string[]).includes(value);
}

export interface CloudVoiceOpenInput {
	/** The peer's WebRTC offer. */
	readonly offerSdp: string;
	readonly voice?: string;
}

/** An open input as the lane sends it, or an error naming what is wrong; never the input's text. */
export function cloudVoiceOpenInput(input: CloudVoiceOpenInput): { offerSdp: string; voice?: CloudVoiceName } {
	if (
		typeof input.offerSdp !== "string" ||
		!input.offerSdp.trim() ||
		Buffer.byteLength(input.offerSdp) > MAX_CLOUD_VOICE_SDP_BYTES
	)
		throw new Error("Invalid voice offer");
	if (input.voice !== undefined && !isCloudVoiceName(input.voice)) throw new Error("Invalid voice name");
	return input.voice === undefined ? { offerSdp: input.offerSdp } : { offerSdp: input.offerSdp, voice: input.voice };
}

export interface CloudVoiceSpoken {
	/** What the voice said, as the provider transcribed it, at most 4 KiB. */
	readonly transcript: string;
}

/** One open call. It ends on `close`, on the abort of the signal it was opened with, or when the provider ends it. */
export interface CloudVoiceCall {
	/** The provider's WebRTC answer, for the peer. */
	readonly answerSdp: string;
	/** Hands the voice one line, and resolves with what it said. One at a time; an aborted one ends the call, since
	 * the voice may still be saying it. */
	speak(text: string, signal: AbortSignal): Promise<CloudVoiceSpoken>;
	/** Stops the call; never rejects. */
	close(): Promise<void>;
}

/** Opens a call on the run's own app-server. */
export type CloudVoiceLane = (input: CloudVoiceOpenInput, signal: AbortSignal) => Promise<CloudVoiceCall>;

/** What `open` rejects with when no run's lane is attached: no run, a run on a ChatGPT plan, or a run that ended. */
export class CloudVoiceUnavailable extends Error {
	constructor() {
		super("The voice is not available in this run");
		this.name = "CloudVoiceUnavailable";
	}
}

/** The run's voice calls, made by a tool before or after the session that answers them is up. */
export class CloudVoiceChannel {
	#lane?: CloudVoiceLane;
	/** How long the lane waits for Codex to confirm a call's stop before it opens no more calls in the run; the
	 * session's own bound when absent. Only tests shorten it. */
	readonly stopMs?: number;

	constructor(options: { stopMs?: number } = {}) {
		if (options.stopMs !== undefined) this.stopMs = options.stopMs;
	}

	attach(lane: CloudVoiceLane | undefined): void {
		this.#lane = lane;
	}

	open(input: CloudVoiceOpenInput, signal: AbortSignal): Promise<CloudVoiceCall> {
		return this.#lane ? this.#lane(input, signal) : Promise.reject(new CloudVoiceUnavailable());
	}
}
