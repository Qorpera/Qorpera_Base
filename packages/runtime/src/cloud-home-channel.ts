// The channel from a run's sealed slot to its home machine (lanes/agent-box-20261113, slice 1).
//
// `machine_run` is one request and one answer. Codex's own tools need a channel that stays open: its exec-server
// streams a command's output as it comes and takes stdin back (P1 measured 1,097 output notifications in one run).
// So this is the one streaming route of the coding executor's ingress: an HTTP upgrade on the same listener, with the
// same transport token and the same proof of the run's holder, and then plain JSON-RPC lines, one per line, both ways.
//
//   the run's host (cloud-codex-home.ts) --upgrade--> the executor's ingress --> `codex exec-server` on the machine
//
// Why an upgrade and not another POST: the ingress bounds a request at 15 s and 10 per socket, which a channel that
// lives as long as a turn cannot keep. An upgraded socket leaves that per-request machinery behind, and both ends of
// this one are ours, so it carries our own lines rather than WebSocket frames (the office viewer's gateway does the
// framing because a browser is its other end; here nothing needs it).
//
// The handshake is the first line ON the socket, never the URL or a header: a run's holder and its binding are not
// things to put in a request line that proxies and logs keep.

import { StringDecoder } from "node:string_decoder";
import { type JsonValue, POSTGRES_UUID_PATTERN } from "@qorpera/contracts";
import type { CloudNativeToolBinding } from "./cloud-native-tool-authority.ts";

export const CLOUD_HOME_CHANNEL_PATH = "/v1/home-session";
export const CLOUD_HOME_CHANNEL_PROTOCOL = "qorpera-home-session/1";
/** The handshake, and each line after it. A command's output chunk is far below this; a line over it ends the channel. */
export const CLOUD_HOME_CHANNEL_LINE_BYTES = 8 * 1024 * 1024;
/** How long the ingress waits for the handshake line after the upgrade. */
export const CLOUD_HOME_CHANNEL_HANDSHAKE_MS = 10_000;
/** The whole of opening a channel from the run's side: the connection, the upgrade and the handshake together. */
export const CLOUD_HOME_CHANNEL_OPEN_MS = 20_000;

/** The first line the run's host writes: whose channel this is, and which machine it wants. */
export interface CloudHomeChannelHandshake {
	schema: typeof CLOUD_HOME_CHANNEL_PROTOCOL;
	binding: CloudNativeToolBinding;
	machineId: string;
	sessionId: string;
}

/** The ingress's one line back, before any byte of the machine's: the session, or why there is none. */
export type CloudHomeChannelReady =
	| { readonly ok: true; readonly sessionId: string; readonly machine: string }
	| { readonly ok: false; readonly reason: string };

/** What SQL answers the ingress for one session (`qorpera_authorize_home_session`), as the executor parses it. */
export interface CloudHomeSessionAuthorized {
	readonly state: "authorized";
	readonly sessionId: string;
	readonly machineId: string;
	readonly machine: string;
	readonly placementId: string;
	/** The machine's boot SQL authorized: the guest's own shell checks it again when it starts the exec-server. */
	readonly bootId: string;
	readonly executorOwner: string;
	readonly providerId: string;
}

/** Who asked for a channel, as the ingress passes it to `open`, so an executor that does not hold the machine can
 * forward the channel to the one that does (as a machine command is forwarded). */
export interface CloudHomeChannelRequest {
	readonly binding: CloudNativeToolBinding;
	/** The run's holder as its own ingress read it; a peer listener takes none (only executors hold its token). */
	readonly holder: string | undefined;
}

export type CloudHomeSessionAnswer =
	| CloudHomeSessionAuthorized
	| { readonly state: "refused"; readonly reason: string };

/** A refusal's reason as it travels: one of SQL's or the ingress's own codes, never words, an address or an id. */
export const CLOUD_HOME_CHANNEL_REASON = /^[A-Z][A-Z_]{0,63}$/;

/**
 * The ingress said no, with its reason (the machine is not running, this boot is over, the home is busy with another
 * run's work). The run's host turns the reason into words the model can act on; a forwarding executor passes it on
 * to the run unchanged.
 */
export class CloudHomeChannelRefused extends Error {
	readonly reason: string;

	constructor(reason: string) {
		super(`cloud_home_channel_unavailable: ${reason}`);
		this.reason = reason;
	}
}

/** One side of the channel: the machine's, as the executor's host opens it, and the run's, as its host sees it. */
export interface CloudHomeChannelSide {
	write(line: string): void;
	lines: AsyncIterable<string>;
	close(): Promise<void>;
}

/**
 * Each complete line of a stream of bytes, in order, decoded as UTF-8 across chunk boundaries: a character split
 * between two reads must arrive whole, or a command, a path or a file's text would change on its way through this
 * host (review round 1, F9). One reader per connection, used by both ends of the channel.
 */
export async function* cloudHomeChannelLines(chunks: AsyncIterable<Buffer | Uint8Array>): AsyncGenerator<string> {
	const decoder = new StringDecoder("utf8");
	let rest = "";
	for await (const chunk of chunks) {
		rest += decoder.write(Buffer.from(chunk));
		if (Buffer.byteLength(rest) > CLOUD_HOME_CHANNEL_LINE_BYTES) throw new Error("Home line too large");
		let end = rest.indexOf("\n");
		while (end >= 0) {
			yield rest.slice(0, end);
			rest = rest.slice(end + 1);
			end = rest.indexOf("\n");
		}
	}
}

export function cloudHomeChannelHandshake(input: {
	binding: CloudNativeToolBinding;
	machineId: string;
	sessionId: string;
}): string {
	if (!POSTGRES_UUID_PATTERN.test(input.machineId) || !POSTGRES_UUID_PATTERN.test(input.sessionId))
		throw new Error("Invalid home session identity");
	return JSON.stringify({
		schema: CLOUD_HOME_CHANNEL_PROTOCOL,
		binding: input.binding,
		machineId: input.machineId,
		sessionId: input.sessionId,
	} satisfies CloudHomeChannelHandshake);
}

/** The handshake as the ingress reads it, or undefined for anything else: nothing of it is trusted beyond its shape. */
export function parseCloudHomeChannelHandshake(line: string): CloudHomeChannelHandshake | undefined {
	let value: JsonValue;
	try {
		value = JSON.parse(line) as JsonValue;
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).sort().join() !== "binding,machineId,schema,sessionId" ||
		record.schema !== CLOUD_HOME_CHANNEL_PROTOCOL ||
		typeof record.machineId !== "string" ||
		!POSTGRES_UUID_PATTERN.test(record.machineId) ||
		typeof record.sessionId !== "string" ||
		!POSTGRES_UUID_PATTERN.test(record.sessionId) ||
		!record.binding ||
		typeof record.binding !== "object" ||
		Array.isArray(record.binding)
	)
		return undefined;
	return {
		schema: CLOUD_HOME_CHANNEL_PROTOCOL,
		binding: record.binding as CloudNativeToolBinding,
		machineId: record.machineId,
		sessionId: record.sessionId,
	};
}
