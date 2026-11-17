import {
	CloudPictureChannel,
	CloudPictureFailure,
	type CloudPictureInput,
	type CloudPictureMade,
} from "./cloud-picture-channel.ts";

export const CLAUDE_PICTURE_IDLE_MS = 10 * 60_000;

export type CloudClaudePictureSessionStart = (input: {
	readonly pictures: CloudPictureChannel;
	readonly light: (signal: AbortSignal) => Promise<void>;
	readonly signal: AbortSignal;
}) => Promise<unknown>;

interface Session {
	readonly channel: CloudPictureChannel;
	readonly ready: Promise<void>;
	readonly ended: Promise<void>;
	readonly stop: () => void;
	idle?: ReturnType<typeof setTimeout>;
}

function aborted(signal: AbortSignal): Promise<"aborted"> {
	return new Promise((resolve) => {
		if (signal.aborted) resolve("aborted");
		else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
	});
}

export class CloudClaudePictureLane {
	readonly #start: CloudClaudePictureSessionStart;
	readonly #signal: AbortSignal;
	readonly #idleMs: number;
	#session?: Session;
	#last: Promise<void> = Promise.resolve();
	#queue: Promise<void> = Promise.resolve();
	#closed = false;
	sessions = 0;
	failure?: string;

	constructor(options: { start: CloudClaudePictureSessionStart; signal: AbortSignal; idleMs?: number }) {
		this.#start = options.start;
		this.#signal = options.signal;
		this.#idleMs = options.idleMs ?? CLAUDE_PICTURE_IDLE_MS;
	}

	make(input: CloudPictureInput, signal: AbortSignal): Promise<CloudPictureMade> {
		const turn = this.#queue.then(() => this.#make(input, signal));
		this.#queue = turn.then(
			() => undefined,
			() => undefined,
		);
		return turn;
	}

	close(): void {
		this.#closed = true;
		this.#end(this.#session);
	}

	async #make(input: CloudPictureInput, signal: AbortSignal): Promise<CloudPictureMade> {
		signal.throwIfAborted();
		if (this.#closed || this.#signal.aborted) throw new CloudPictureFailure("failed");
		const session = this.#session ?? (await this.#open(signal));
		if (session.idle !== undefined) clearTimeout(session.idle);
		try {
			const state = await Promise.race([
				session.ready.then(() => "ready" as const),
				session.ended.then(() => "ended" as const),
				aborted(signal),
			]);
			signal.throwIfAborted();
			if (state !== "ready") throw new CloudPictureFailure("failed");
			return await session.channel.make(input, signal);
		} finally {
			if (this.#session === session) {
				session.idle = setTimeout(() => this.#end(session), this.#idleMs);
				session.idle.unref?.();
			}
		}
	}

	async #open(signal: AbortSignal): Promise<Session> {
		await Promise.race([this.#last, aborted(signal)]);
		signal.throwIfAborted();
		const channel = new CloudPictureChannel();
		let ready: () => void = () => undefined;
		let stop: () => void = () => undefined;
		const readyNow = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const stopped = new Promise<void>((resolve) => {
			stop = resolve;
		});
		const ended = this.#start({
			pictures: channel,
			light: async (lightSignal) => {
				ready();
				await Promise.race([stopped, aborted(lightSignal)]);
			},
			signal: this.#signal,
		}).then(
			() => undefined,
			(error: unknown) => {
				this.failure = error instanceof Error ? error.name : "unknown";
			},
		);
		const session: Session = { channel, ready: readyNow, ended, stop };
		this.#last = ended.then(() => {
			if (session.idle !== undefined) clearTimeout(session.idle);
			if (this.#session === session) this.#session = undefined;
		});
		this.sessions += 1;
		this.#session = session;
		return session;
	}

	#end(session: Session | undefined): void {
		if (!session) return;
		if (session.idle !== undefined) clearTimeout(session.idle);
		if (this.#session === session) this.#session = undefined;
		session.stop();
	}
}
