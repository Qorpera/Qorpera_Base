import {
	assertCompanyComputerScreenBinding,
	type CompanyComputerScreenBinding,
} from "./cloud-company-computer-contract.ts";

export const COMPANY_COMPUTER_VIEW_SCHEMA = "qorpera.company-computer-screen-view/v2";
export const COMPANY_COMPUTER_VIEW_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_BUFFER = 256 * 1024;

export interface CompanyComputerViewCloseEvent {
	code: number;
	reason: string;
	wasClean: boolean;
}

// DOM and Node's native WebSocket declare different error-event subtypes.
// Like EventTarget handlers, accept either; this transport ignores diagnostics.
type WebSocketEventHandler<E> = { handle(event: E): void }["handle"];

/** The native browser WebSocket surface; transport injection is for host adapters/tests. */
export interface CompanyComputerWebSocket {
	binaryType: string;
	readonly readyState: number;
	readonly bufferedAmount: number;
	onopen: ((event: Event) => void) | null;
	onmessage: ((event: MessageEvent) => void) | null;
	onerror: WebSocketEventHandler<Event> | null;
	onclose: WebSocketEventHandler<CompanyComputerViewCloseEvent> | null;
	send(bytes: ArrayBuffer | ArrayBufferView<ArrayBuffer>): void;
	close(): void;
}

/** Configured, trusted service endpoint. Never accept a URL from a tool result,
 * page, model, ticket response, or guest desktop. Tickets travel only as bytes. */
export function assertCompanyComputerViewerUrl(value: string, companyComputerId: string): void {
	const url = new URL(value);
	if (
		url.protocol !== "wss:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== `/office/${companyComputerId}/view` ||
		url.href !== value
	)
		throw new Error("INVALID_VIEWER_URL");
}

/** An already-authenticated raw channel supported by noVNC. It hides the ticket
 * and framing, queues initial RFB bytes until attachment, and never reconnects.
 * The server still owns all input, lease, privacy and clipboard enforcement. */
export interface CompanyComputerViewChannel {
	readonly readyState: number;
	readonly protocol: string;
	binaryType: string;
	onopen: ((event: Event) => void) | null;
	onmessage: ((event: { data: ArrayBuffer }) => void) | null;
	onerror: ((event: Event) => void) | null;
	onclose: ((event: CompanyComputerViewCloseEvent) => void) | null;
	send(bytes: ArrayBuffer | ArrayBufferView<ArrayBuffer>): void;
	close(): void;
}

export async function connectCompanyComputerViewChannel(options: {
	url: string;
	capability: string;
	binding: CompanyComputerScreenBinding;
	mode: "watch" | "shared" | "control";
	validForMs: number;
	signal: AbortSignal;
	createWebSocket?: (url: string) => CompanyComputerWebSocket;
}): Promise<CompanyComputerViewChannel> {
	const binding = structuredClone(options.binding);
	assertCompanyComputerScreenBinding(binding, binding);
	assertCompanyComputerViewerUrl(options.url, binding.companyComputerId);
	if (
		!COMPANY_COMPUTER_VIEW_TOKEN.test(options.capability) ||
		!["watch", "shared", "control"].includes(options.mode) ||
		!Number.isSafeInteger(options.validForMs) ||
		options.validForMs < 1 ||
		options.validForMs > 30000
	)
		throw new Error("INVALID_VIEW_REQUEST");
	options.signal.throwIfAborted();
	// Copy only the handshake bytes, then clear them on send/close. The returned
	// channel has no reference to the capability or the caller's options object.
	const ticket = new TextEncoder().encode(
		`${JSON.stringify({ schema: COMPANY_COMPUTER_VIEW_SCHEMA, capability: options.capability })}\n`,
	);
	const mode = options.mode;
	const signal = options.signal;
	const socket = (options.createWebSocket ?? ((url) => new WebSocket(url)))(options.url);
	socket.binaryType = "arraybuffer";
	return new Promise((resolve, reject) => {
		let state = 0;
		let handshake = new Uint8Array(0);
		let queued: ArrayBuffer[] = [];
		let queuedBytes = 0;
		let receiver: CompanyComputerViewChannel["onmessage"] = null;
		let flushing = false;
		let sent = false;
		// The first view of a screen starts its desktop in the guest, which takes
		// longer than a warm attach; giving up early also cancels that start.
		const timeout = setTimeout(() => fail(), Math.min(25000, options.validForMs));
		const discard = (): void => {
			ticket.fill(0);
			handshake.fill(0);
			handshake = new Uint8Array(0);
			for (const bytes of queued) new Uint8Array(bytes).fill(0);
			queued = [];
			queuedBytes = 0;
		};
		const close = (failed = false): void => {
			if (state === 3) return;
			state = 3;
			clearTimeout(timeout);
			signal.removeEventListener("abort", fail);
			discard();
			try {
				socket.close();
			} catch {
				/* Transport is already unavailable. */
			}
			reject(new Error("VIEW_UNAVAILABLE"));
			queueMicrotask(() => channel.onclose?.({ code: failed ? 1006 : 1000, reason: "", wasClean: !failed }));
		};
		const fail = (): void => {
			if (state === 3) return;
			close(true);
			channel.onerror?.(new Event("error"));
		};
		const flush = (): void => {
			if (flushing || state !== 1 || !receiver) return;
			flushing = true;
			queueMicrotask(() => {
				flushing = false;
				try {
					while (state === 1 && receiver && queued.length) {
						const bytes = queued.shift()!;
						queuedBytes -= bytes.byteLength;
						receiver({ data: bytes });
					}
				} catch {
					fail();
				}
			});
		};
		const enqueue = (bytes: Uint8Array): void => {
			if (!bytes.byteLength) return;
			if (queuedBytes + bytes.byteLength > MAX_BUFFER) throw new Error("VIEW_BUFFER_EXCEEDED");
			queued.push(bytes.slice().buffer);
			queuedBytes += bytes.byteLength;
			flush();
		};
		const channel: CompanyComputerViewChannel = {
			get readyState() {
				return state;
			},
			protocol: "",
			get binaryType() {
				return "arraybuffer";
			},
			set binaryType(value: string) {
				if (value !== "arraybuffer") fail();
			},
			onopen: null,
			onerror: null,
			onclose: null,
			get onmessage() {
				return receiver;
			},
			set onmessage(value) {
				receiver = value;
				flush();
			},
			send(bytes) {
				if (
					state !== 1 ||
					signal.aborted ||
					socket.readyState !== 1 ||
					!(bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes)) ||
					bytes.byteLength > MAX_BUFFER ||
					socket.bufferedAmount + bytes.byteLength > MAX_BUFFER
				) {
					fail();
					throw new Error("VIEW_UNAVAILABLE");
				}
				try {
					socket.send(bytes);
				} catch {
					fail();
					throw new Error("VIEW_UNAVAILABLE");
				}
			},
			close: () => close(),
		};
		socket.onopen = () => {
			if (state !== 0 || sent) {
				fail();
				return;
			}
			sent = true;
			try {
				socket.send(ticket);
			} catch {
				fail();
			}
			ticket.fill(0);
		};
		socket.onerror = fail;
		socket.onclose = () => {
			if (state === 3) return;
			close(true);
			// Do not forward an untrusted service close reason into UI/telemetry.
		};
		socket.onmessage = (event) => {
			try {
				if (state === 3) return;
				if (!sent || !(event.data instanceof ArrayBuffer) || event.data.byteLength > MAX_BUFFER)
					throw new Error("INVALID_VIEW_FRAME");
				const bytes = new Uint8Array(event.data);
				if (state === 1) {
					enqueue(bytes);
					return;
				}
				const combined = new Uint8Array(handshake.length + bytes.length);
				combined.set(handshake);
				combined.set(bytes, handshake.length);
				handshake = combined;
				const newline = handshake.indexOf(10);
				if (newline > 4096 || (newline < 0 && handshake.length > 4096) || handshake.length > MAX_BUFFER)
					throw new Error("INVALID_VIEW_HANDSHAKE");
				if (newline < 0) return;
				const reply = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(handshake.subarray(0, newline)));
				if (
					!reply ||
					typeof reply !== "object" ||
					Array.isArray(reply) ||
					Object.keys(reply).sort().join() !== "binding,mode,ok" ||
					reply.ok !== true ||
					reply.mode !== mode ||
					!reply.binding ||
					Object.keys(reply.binding).sort().join() !== Object.keys(binding).sort().join()
				)
					throw new Error("INVALID_VIEW_HANDSHAKE");
				assertCompanyComputerScreenBinding(reply.binding, binding);
				if (signal.aborted) throw new Error("VIEW_ABORTED");
				state = 1;
				clearTimeout(timeout);
				enqueue(handshake.subarray(newline + 1));
				handshake.fill(0);
				handshake = new Uint8Array(0);
				resolve(channel);
			} catch {
				fail();
			}
		};
		signal.addEventListener("abort", fail, { once: true });
		if (signal.aborted) fail();
	});
}
