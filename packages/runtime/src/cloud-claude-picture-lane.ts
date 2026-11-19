import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { type CloudClaudePictures, claudePictureLogin } from "./cloud-claude-picture-command.ts";
import { CHATGPT_PLAN_DIRECTORY, type NativeIsolationConfiguration } from "./cloud-native-isolation.ts";
import { type CloudNativeRunToolAdapters, runCloudNativeRunToolSession } from "./cloud-native-run-tool-session.ts";
import type { CloudNativeToolBinding } from "./cloud-native-tool-authority.ts";
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

	get open(): boolean {
		return this.#session !== undefined;
	}

	close(): Promise<void> {
		this.#closed = true;
		this.#end(this.#session);
		return this.#last;
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

export async function cloudClaudePictureLaneFor(input: {
	readonly identityRoot: string;
	readonly signal: AbortSignal;
	readonly start: CloudClaudePictureSessionStart;
	readonly idleMs?: number;
}): Promise<CloudClaudePictureLane | undefined> {
	const plan = await lstat(join(input.identityRoot, CHATGPT_PLAN_DIRECTORY)).then(
		() => true,
		(error: NodeJS.ErrnoException) => error.code !== "ENOENT",
	);
	if (plan) return undefined;
	const login = await lstat(join(input.identityRoot, "codex", "auth.json")).catch(() => undefined);
	if (!login?.isFile()) return undefined;
	return new CloudClaudePictureLane({
		start: input.start,
		signal: input.signal,
		...(input.idleMs === undefined ? {} : { idleMs: input.idleMs }),
	});
}

export function cloudClaudePictureSessionStart(options: {
	readonly binding: CloudNativeToolBinding;
	readonly controlPlane: Parameters<typeof runCloudNativeRunToolSession>[0]["controlPlane"];
	readonly adapters: () => CloudNativeRunToolAdapters;
	readonly command: readonly [string, ...string[]];
	readonly binarySha256: string;
	readonly identityRoot: string;
	readonly isolation?: NativeIsolationConfiguration;
	readonly timeoutMs?: number;
}): CloudClaudePictureSessionStart {
	return ({ pictures, light, signal }) =>
		runCloudNativeRunToolSession({
			binding: options.binding,
			controlPlane: options.controlPlane,
			beginExecution: async () => undefined,
			tools: options.adapters,
			light: async (_ask, lightSignal) => light(lightSignal),
			pictures,
			command: options.command,
			binarySha256: options.binarySha256,
			identityRoot: options.identityRoot,
			reusedIdentityRoot: true,
			...(options.isolation ? { isolation: options.isolation } : {}),
			signal,
			...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
		});
}

export async function claudeWorkerPictures(input: {
	readonly facts: unknown;
	readonly home: boolean;
	readonly given?: CloudClaudePictures["make"];
	readonly lane: () => Promise<CloudClaudePictureLane | undefined>;
	readonly foreignOwner: NonNullable<CloudClaudePictures["foreignOwner"]>;
}): Promise<{ readonly pictures: CloudClaudePictures; readonly lane?: CloudClaudePictureLane }> {
	const login = claudePictureLogin(input.facts);
	const lane = input.home && login.own && input.given === undefined ? await input.lane() : undefined;
	const made = lane;
	const make = !login.own
		? undefined
		: (input.given ??
			(made ? (picture: CloudPictureInput, signal: AbortSignal) => made.make(picture, signal) : undefined));
	return {
		pictures: {
			make,
			...(login.none === undefined ? {} : { none: login.none }),
			foreignOwner: input.foreignOwner,
		},
		...(lane ? { lane } : {}),
	};
}
