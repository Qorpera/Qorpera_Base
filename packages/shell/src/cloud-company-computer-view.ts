import { createHash, randomBytes } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { HostedPrimaryDatabase } from "./hosted-primary.ts";
import { registerRendererLoopbackWebSocketUrl } from "./renderer-boundary.ts";

/** Member-device side of the screen watch/drive surface. The shell mints a
 * short-lived single-use view capability with the member's own session,
 * opens one TCP connection to the host viewer gateway (over Tailscale or
 * the private network — the gateway is never public), performs the view
 * handshake, and from there the socket is the live VNC session: watching
 * and driving are the same bytes. The local WebSocket bridge re-serves that
 * socket to exactly one renderer connection so a stock noVNC client can
 * attach without any remote WebSocket endpoint existing anywhere. */

const VIEW_SCHEMA = "qorpera.company-computer-screen-view/v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_HANDSHAKE_BYTES = 4_096;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface CompanyComputerScreenSummary {
	screenId: string;
	screenOrdinal: number;
	displayName: string;
	/** Absent from an older control plane, which means open. */
	powerState?: "open" | "closed";
	attachedStaffAgentId?: string;
	occupyingRunId?: string;
}

export interface CompanyComputerScreensView {
	companyComputerId: string;
	logicalComputerId: string;
	lifecycleState: string;
	/** host:port of the node's viewer gateway, from the registry; absent
	 * until node operations publish it. */
	viewerEndpoint?: string;
	screens: CompanyComputerScreenSummary[];
}

const VIEWER_ENDPOINT_PATTERN = /^[a-z0-9][a-z0-9.-]{0,253}:[0-9]{2,5}$/;

export function parseViewerEndpoint(value: string): { host: string; port: number } {
	if (!VIEWER_ENDPOINT_PATTERN.test(value)) throw new Error("Screen viewer endpoint is invalid");
	const separator = value.lastIndexOf(":");
	const port = Number(value.slice(separator + 1));
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
		throw new Error("Screen viewer endpoint is invalid");
	}
	return { host: value.slice(0, separator), port };
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function uuid(value: unknown, label: string): string {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error(`${label} is invalid`);
	return value;
}

export async function describeCompanyComputerScreens(
	client: SupabaseClient<HostedPrimaryDatabase>,
	environmentId: string,
): Promise<CompanyComputerScreensView | undefined> {
	const { data, error } = await client.rpc("qorpera_describe_company_computer_screens", {
		p_environment_id: environmentId,
	});
	if (error) throw new Error(`Company computer description failed: ${error.message}`);
	if (data === null || data === undefined) return undefined;
	const input = record(data, "Company computer description");
	const computer = record(input.computer, "Company computer description computer");
	const screens = input.screens;
	if (!Array.isArray(screens)) throw new Error("Company computer description screens are invalid");
	const viewerEndpoint = input.viewer_endpoint;
	if (viewerEndpoint !== null && viewerEndpoint !== undefined) {
		if (typeof viewerEndpoint !== "string" || !VIEWER_ENDPOINT_PATTERN.test(viewerEndpoint)) {
			throw new Error("Company computer viewer endpoint is invalid");
		}
	}
	return {
		companyComputerId: uuid(computer.company_computer_id, "Company computer id"),
		logicalComputerId: uuid(computer.logical_computer_id, "Company computer logical computer id"),
		lifecycleState: String(computer.lifecycle_state),
		...(typeof viewerEndpoint === "string" ? { viewerEndpoint } : {}),
		screens: screens.map((entry): CompanyComputerScreenSummary => {
			const screen = record(entry, "Company computer screen");
			if (
				!Number.isSafeInteger(screen.screen_ordinal) ||
				(screen.screen_ordinal as number) < 1 ||
				(screen.screen_ordinal as number) > 32 ||
				typeof screen.display_name !== "string"
			) {
				throw new Error("Company computer screen is invalid");
			}
			const attached = screen.attached_staff_agent_id;
			const occupying = screen.occupying_run_id;
			const power = screen.power_state;
			return {
				screenId: uuid(screen.screen_id, "Company computer screen id"),
				screenOrdinal: screen.screen_ordinal as number,
				displayName: screen.display_name,
				...(power === "open" || power === "closed" ? { powerState: power } : {}),
				...(typeof attached === "string" ? { attachedStaffAgentId: uuid(attached, "Screen staff agent") } : {}),
				...(typeof occupying === "string" ? { occupyingRunId: uuid(occupying, "Screen occupying run") } : {}),
			};
		}),
	};
}

export interface MintedScreenView {
	capability: string;
	expiresAt: string;
	screenOrdinal: number;
}

export async function mintCompanyComputerScreenView(
	client: SupabaseClient<HostedPrimaryDatabase>,
	screenId: string,
): Promise<MintedScreenView> {
	const { data, error } = await client.rpc("qorpera_mint_company_computer_screen_view", {
		p_screen_id: screenId,
	});
	if (error) throw new Error(`Company computer screen view mint failed: ${error.message}`);
	const input = record(data, "Company computer screen view mint");
	const screen = record(input.screen, "Company computer screen view screen");
	if (
		typeof input.capability !== "string" ||
		!CAPABILITY_PATTERN.test(input.capability) ||
		typeof input.expires_at !== "string" ||
		!Number.isSafeInteger(screen.screen_ordinal)
	) {
		throw new Error("Company computer screen view mint is invalid");
	}
	return {
		capability: input.capability,
		expiresAt: input.expires_at,
		screenOrdinal: screen.screen_ordinal as number,
	};
}

/** Attaches a staff agent to a screen with the member's own session; the
 * control plane enforces roster membership and one screen per agent. */
/** Powers a screen on: its desktop session comes up on the shared machine,
 * and if the machine itself is sleeping the provider's power reconciliation
 * starts it. Idempotent when the screen is already open. */
export async function openCompanyComputerScreenPower(
	client: SupabaseClient<HostedPrimaryDatabase>,
	screenId: string,
): Promise<void> {
	const { error } = await client.rpc("qorpera_open_company_computer_screen", { p_screen_id: screenId });
	if (error) throw new Error(`Company computer screen power failed: ${error.message}`);
}

export async function attachCompanyComputerScreen(
	client: SupabaseClient<HostedPrimaryDatabase>,
	screenId: string,
	staffAgentId: string,
): Promise<void> {
	const { error } = await client.rpc("qorpera_attach_company_computer_screen", {
		p_screen_id: screenId,
		p_staff_agent_id: staffAgentId,
	});
	if (error) throw new Error(`Company computer screen attachment failed: ${error.message}`);
}

export interface ConnectCompanyComputerScreenViewInput {
	host: string;
	port: number;
	capability: string;
}

export interface ConnectedScreenView {
	/** Returned explicitly paused: attach a data listener and call resume()
	 * (the bridge below does both). */
	socket: Socket;
	screenOrdinal: number;
	/** Session bytes that arrived in the same chunks as the handshake reply;
	 * consumers must treat them as the head of the VNC stream. */
	remainder: Buffer;
}

/** Opens the gateway leg and completes the view handshake; the resolved
 * socket plus remainder carry the raw VNC session from its first byte. */
export function connectCompanyComputerScreenView(
	input: ConnectCompanyComputerScreenViewInput,
): Promise<ConnectedScreenView> {
	if (!CAPABILITY_PATTERN.test(input.capability)) {
		return Promise.reject(new Error("Company computer screen view capability is invalid"));
	}
	return new Promise((resolveView, rejectView) => {
		const socket = connect(input.port, input.host);
		let buffered = Buffer.alloc(0);
		let settled = false;
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			socket.destroy();
			rejectView(error);
		};
		const onData = (chunk: Buffer): void => {
			buffered = Buffer.concat([buffered, chunk]);
			const newline = buffered.indexOf(0x0a);
			if (newline === -1) {
				if (buffered.byteLength > MAX_HANDSHAKE_BYTES) fail(new Error("Screen view reply is too large"));
				return;
			}
			socket.off("data", onData);
			let reply: Record<string, unknown>;
			try {
				reply = record(JSON.parse(buffered.subarray(0, newline).toString("utf-8")), "Screen view reply");
			} catch {
				fail(new Error("Screen view reply is invalid"));
				return;
			}
			if (reply.ok !== true) {
				fail(new Error(typeof reply.error === "string" ? reply.error : "Screen view was refused"));
				return;
			}
			if (!Number.isSafeInteger(reply.screen_ordinal)) {
				fail(new Error("Screen view reply is invalid"));
				return;
			}
			settled = true;
			socket.pause();
			resolveView({
				socket,
				screenOrdinal: reply.screen_ordinal as number,
				remainder: Buffer.from(buffered.subarray(newline + 1)),
			});
		};
		socket.on("connect", () => {
			socket.write(`${JSON.stringify({ schema: VIEW_SCHEMA, capability: input.capability })}\n`);
		});
		socket.on("data", onData);
		socket.on("error", (error) => fail(new Error(`Screen view gateway is unreachable: ${error.message}`)));
		socket.on("close", () => fail(new Error("Screen view gateway closed during the handshake")));
	});
}

export interface LocalScreenViewBridge {
	port: number;
	url: string;
	close(): Promise<void>;
}

function websocketAccept(key: string): string {
	return createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
}

function websocketFrame(payload: Buffer): Buffer {
	const length = payload.byteLength;
	let header: Buffer;
	if (length < 126) {
		header = Buffer.from([0x82, length]);
	} else if (length < 65_536) {
		header = Buffer.alloc(4);
		header[0] = 0x82;
		header[1] = 126;
		header.writeUInt16BE(length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x82;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(length), 2);
	}
	return Buffer.concat([header, payload]);
}

interface WebsocketDecoder {
	push(chunk: Buffer): Array<{ opcode: number; payload: Buffer }>;
}

function websocketDecoder(): WebsocketDecoder {
	let buffered = Buffer.alloc(0);
	let fragmentOpcode = 0;
	let fragments: Buffer[] = [];
	return {
		push(chunk: Buffer) {
			buffered = Buffer.concat([buffered, chunk]);
			const messages: Array<{ opcode: number; payload: Buffer }> = [];
			for (;;) {
				if (buffered.byteLength < 2) return messages;
				const fin = ((buffered[0] as number) & 0x80) !== 0;
				const opcode = (buffered[0] as number) & 0x0f;
				const masked = ((buffered[1] as number) & 0x80) !== 0;
				let length = (buffered[1] as number) & 0x7f;
				let offset = 2;
				if (length === 126) {
					if (buffered.byteLength < 4) return messages;
					length = buffered.readUInt16BE(2);
					offset = 4;
				} else if (length === 127) {
					if (buffered.byteLength < 10) return messages;
					const wide = buffered.readBigUInt64BE(2);
					if (wide > BigInt(64 * 1024 * 1024)) throw new Error("WebSocket frame is too large");
					length = Number(wide);
					offset = 10;
				}
				/* Browser clients always mask; refusing unmasked frames keeps
				 * the parser inside RFC 6455's client-to-server contract. */
				if (!masked) throw new Error("WebSocket client frames must be masked");
				if (buffered.byteLength < offset + 4 + length) return messages;
				const mask = buffered.subarray(offset, offset + 4);
				const payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));
				for (let index = 0; index < payload.byteLength; index++) {
					payload[index] = (payload[index] as number) ^ (mask[index % 4] as number);
				}
				buffered = buffered.subarray(offset + 4 + length);
				if (opcode === 0) {
					fragments.push(payload);
					if (fin && fragmentOpcode !== 0) {
						messages.push({ opcode: fragmentOpcode, payload: Buffer.concat(fragments) });
						fragmentOpcode = 0;
						fragments = [];
					}
					continue;
				}
				if (!fin) {
					fragmentOpcode = opcode;
					fragments = [payload];
					continue;
				}
				messages.push({ opcode, payload });
			}
		},
	};
}

/** Serves the connected screen socket to exactly one local WebSocket client
 * (the renderer's noVNC), translating frames both ways. Loopback-only; the
 * bridge dies with either side, and a second WebSocket connection is
 * refused rather than splitting one screen session across viewers. */
export function startLocalScreenViewWebSocketBridge(view: ConnectedScreenView): Promise<LocalScreenViewBridge> {
	let attached: Duplex | undefined;
	const route = `/${randomBytes(32).toString("base64url")}`;
	let unregisterRendererUrl = (): void => {};
	const server = createHttpServer((_request, response) => {
		response.writeHead(426, { "content-type": "text/plain" });
		response.end("WebSocket upgrade required\n");
	});
	server.on("upgrade", (request: IncomingMessage, socket: Duplex) => {
		const key = request.headers["sec-websocket-key"];
		if (
			attached ||
			request.url !== route ||
			typeof key !== "string" ||
			request.headers.upgrade?.toLowerCase() !== "websocket"
		) {
			socket.destroy();
			return;
		}
		attached = socket;
		unregisterRendererUrl();
		socket.write(
			[
				"HTTP/1.1 101 Switching Protocols",
				"Upgrade: websocket",
				"Connection: Upgrade",
				`Sec-WebSocket-Accept: ${websocketAccept(key)}`,
				"",
				"",
			].join("\r\n"),
		);
		const decoder = websocketDecoder();
		const teardown = (): void => {
			unregisterRendererUrl();
			socket.destroy();
			view.socket.destroy();
			server.close();
		};
		socket.on("data", (chunk: Buffer) => {
			let messages: Array<{ opcode: number; payload: Buffer }>;
			try {
				messages = decoder.push(chunk);
			} catch {
				teardown();
				return;
			}
			for (const message of messages) {
				if (message.opcode === 8) {
					teardown();
					return;
				}
				if (message.opcode === 9) {
					socket.write(Buffer.concat([Buffer.from([0x8a, message.payload.byteLength]), message.payload]));
					continue;
				}
				if (message.opcode === 1 || message.opcode === 2) view.socket.write(message.payload);
			}
		});
		view.socket.on("data", (chunk: Buffer) => {
			socket.write(websocketFrame(Buffer.from(chunk)));
		});
		socket.on("error", teardown);
		socket.on("close", teardown);
		view.socket.on("error", teardown);
		view.socket.on("close", teardown);
		if (view.remainder.byteLength > 0) socket.write(websocketFrame(view.remainder));
		view.socket.resume();
	});
	return new Promise((resolveStart, rejectStart) => {
		server.once("error", rejectStart);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			const url = `ws://127.0.0.1:${port}${route}`;
			unregisterRendererUrl = registerRendererLoopbackWebSocketUrl(url);
			resolveStart({
				port,
				url,
				close: () =>
					new Promise<void>((resolveClose) => {
						unregisterRendererUrl();
						unregisterRendererUrl = (): void => {};
						attached?.destroy();
						view.socket.destroy();
						server.close(() => resolveClose());
					}),
			});
		});
	});
}
