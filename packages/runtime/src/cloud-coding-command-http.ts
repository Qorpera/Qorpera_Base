import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { readBoundedCloudResponse, withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import {
	CLOUD_CODING_COMMAND_PAGE_BYTES,
	type CloudCodingCommandRead,
	type CloudCodingCommandReceipt,
	type CloudCodingCommandScope,
	parseCloudCodingCommandRead,
	parseCloudCodingCommandReceipt,
} from "@qorpera/contracts";
import type { CloudCodingCommandGateway } from "./cloud-coding-command-tools.ts";
import { CLOUD_COMMAND_PAGE_HEADER, CloudCommandPages } from "./cloud-command-pages.ts";
import {
	CLOUD_HOME_CHANNEL_HANDSHAKE_MS,
	CLOUD_HOME_CHANNEL_KEEPALIVE_MS,
	CLOUD_HOME_CHANNEL_PATH,
	CLOUD_HOME_CHANNEL_PROTOCOL,
	CLOUD_HOME_CHANNEL_REASON,
	CloudHomeChannelRefused,
	type CloudHomeChannelRequest,
	type CloudHomeChannelSide,
	type CloudHomeSessionAnswer,
	type CloudHomeSessionAuthorized,
	cloudHomeChannelKeepAlive,
	cloudHomeChannelLines,
	cloudHomeChannelWithoutKeepAlive,
	parseCloudHomeChannelHandshake,
} from "./cloud-home-channel.ts";
import {
	CLOUD_MACHINE_SCREEN_RESPONSE_LIMIT,
	CLOUD_MACHINE_WAKE_SCHEMA,
	CloudMachineAccountFillRefusal,
	CloudMachineCodingValueRefusal,
	CloudMachineCommandRefusal,
	type CloudMachineCommandServiceOptions,
	CloudMachineScreenRefusal,
	CloudMemberMachineActRefusal,
	CloudMemberMachinePointerRefusal,
	CloudMemberMachineScreenRefusal,
	CloudMemberMachineStartRefusal,
	cloudMemberMachineActAnswer,
	cloudMemberMachinePointerAnswer,
	cloudMemberMachineScreenAnswer,
	cloudMemberMachineStartAnswer,
	cloudMemberMachineStreamFrame,
	cloudMemberMachineStreamFrameHead,
	parseCloudMachineAccountFillAnswer,
	parseCloudMachineAccountFillHttpRequest,
	parseCloudMachineCodingValueAnswer,
	parseCloudMachineCodingValueHttpRequest,
	parseCloudMachineScreenAnswer,
	parseCloudMachineScreenHttpRequest,
	parseCloudMachineWakeHttpRequest,
	parseCloudMemberMachineActPeerRequest,
	parseCloudMemberMachinePointerPeerRequest,
	parseCloudMemberMachineScreenPeerRequest,
	parseCloudMemberMachineStartPeerRequest,
	parseCloudMemberMachineStreamPeerRequest,
	serveCloudMachineCommand,
} from "./cloud-machine-command-http.ts";
import { type MemberStreamWay, writeMemberStreamMessage } from "./cloud-member-machine-stream-http.ts";
import {
	type CloudNativeToolBinding,
	isNativeJobHolder,
	parseCloudNativeToolBinding,
} from "./cloud-native-tool-authority.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const REQUEST_LIMIT = 128 * 1024;
const RESULT_LIMIT = 128 * 1024;
const ERROR = "Coding command gateway unavailable";
type CommandInput = { commandId: string; inputSha256: string; command: string; timeoutMs: number | null };
export type CloudCodingCommandHttpRequest = Readonly<
	{
		schema: "qorpera.coding-command-http/v1";
		binding: CloudNativeToolBinding;
		scope: CloudCodingCommandScope;
	} & (
		| { action: "start"; input: CommandInput }
		| { action: "read"; input: CloudCodingCommandRead }
		| { action: "cancel"; input: { commandId: string } }
	)
>;

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !== [...keys].sort().join()
	)
		throw new Error(ERROR);
	return value as Record<string, unknown>;
}
function scope(value: unknown): CloudCodingCommandScope {
	const input = record(value, ["workerId", "vmId", "requestId", "turn"]);
	if (
		![input.workerId, input.vmId, input.requestId].every((id) => typeof id === "string" && UUID.test(id)) ||
		!Number.isSafeInteger(input.turn) ||
		Number(input.turn) < 1
	)
		throw new Error(ERROR);
	return Object.freeze({ ...input }) as unknown as CloudCodingCommandScope;
}
function parseRequest(value: unknown, action: string): CloudCodingCommandHttpRequest {
	const valueRecord = record(value, ["schema", "binding", "scope", "action", "input"]);
	if (
		valueRecord.schema !== "qorpera.coding-command-http/v1" ||
		valueRecord.action !== action ||
		!["start", "read", "cancel"].includes(action)
	)
		throw new Error(ERROR);
	const input =
		action === "read"
			? { ...parseCloudCodingCommandRead(valueRecord.input) }
			: record(
					valueRecord.input,
					action === "start" ? ["commandId", "inputSha256", "command", "timeoutMs"] : ["commandId"],
				);
	if (typeof input.commandId !== "string" || !UUID.test(input.commandId)) throw new Error(ERROR);
	if (
		action === "start" &&
		(typeof input.inputSha256 !== "string" ||
			!HASH.test(input.inputSha256) ||
			typeof input.command !== "string" ||
			!input.command.trim() ||
			input.command.includes("\0") ||
			Buffer.from(input.command).toString("utf8") !== input.command ||
			Buffer.byteLength(input.command) > 16384 ||
			Buffer.byteLength(JSON.stringify(input.command)) > 60000 ||
			(input.timeoutMs !== null && (!Number.isSafeInteger(input.timeoutMs) || Number(input.timeoutMs) < 1000)))
	)
		throw new Error(ERROR);
	return Object.freeze({
		schema: "qorpera.coding-command-http/v1",
		binding: parseCloudNativeToolBinding(valueRecord.binding),
		scope: scope(valueRecord.scope),
		action,
		input: Object.freeze({ ...input }),
	}) as CloudCodingCommandHttpRequest;
}
export function parseCloudCodingCommandUrl(value: string, allowLoopback = false): string {
	const url = new URL(value);
	if (
		(url.protocol !== "https:" &&
			!(allowLoopback && url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/"
	)
		throw new Error(ERROR);
	return url.origin;
}
function validToken(value: string): boolean {
	return (
		TOKEN.test(value) &&
		Buffer.from(value, "base64url").length === 32 &&
		Buffer.from(value, "base64url").toString("base64url") === value
	);
}

/** The receipt with nothing of its command (F3 5g-5): none of its output, nor how much it printed or lost, nor whether
 * or how it ended, whatever page was asked. */
function hiddenReceipt(receipt: CloudCodingCommandReceipt, state: CloudCodingCommandHidden): CloudCodingCommandReceipt {
	return parseCloudCodingCommandReceipt({
		...receipt,
		state,
		exitCode: null,
		output: "",
		truncated: false,
		log: { offset: 0, nextOffset: 0, totalBytes: 0, limitBytes: receipt.log.limitBytes, limitReached: false },
	});
}
function isHidden(receipt: CloudCodingCommandReceipt): boolean {
	return (
		(receipt.state === "machine_stopped" || receipt.state === "unconfirmed") &&
		isDeepStrictEqual(receipt, hiddenReceipt(receipt, receipt.state))
	);
}

/** Credential and binding are host-only; no model argument chooses a host,
 * route, VM or cloud authority. There are no automatic effect retries. */
export function createHttpCloudCodingCommandGateway(options: {
	url: string;
	token: string;
	binding: CloudNativeToolBinding;
	/** G2-6b: the run's holder credential, read per request (NativeHostDispatch.holderHeader). Null only for an
	 * executor forwarding to its peer, which holds no run's lease. */
	holder: (() => string) | null;
	authorize: CloudCodingCommandGateway["authorize"];
	/** What the executors said they take for a page (keyholes S1): one per process, shared by its gateways. A gateway
	 * without it learns only from its own answers. */
	pages?: CloudCommandPages;
	allowLoopback?: boolean;
	fetch?: typeof fetch;
}): CloudCodingCommandGateway {
	const origin = parseCloudCodingCommandUrl(options.url, options.allowLoopback);
	if (!validToken(options.token)) throw new Error(ERROR);
	const token = options.token;
	const binding = parseCloudNativeToolBinding(options.binding);
	const holder = options.holder;
	const transport = options.fetch ?? fetch;
	const pages = options.pages ?? new CloudCommandPages();
	const send = async (
		action: "start" | "read" | "cancel",
		admittedScope: CloudCodingCommandScope,
		input: CommandInput | CloudCodingCommandRead,
		signal: AbortSignal,
		/** Set when the executor answered with a refusal of its own (4xx), not a proxy's or a server's failure (5xx). */
		answer: { refused: boolean } = { refused: false },
	): Promise<unknown> => {
		try {
			// A read asks the executor for no more than it said it takes; a smaller page answers it as well.
			const read = action === "read" ? parseCloudCodingCommandRead(input) : undefined;
			const asked = read ? { ...read, limit: Math.min(read.limit ?? 4096, pages.of(origin)) } : input;
			const admitted = parseRequest(
				{ schema: "qorpera.coding-command-http/v1", binding, scope: admittedScope, action, input: asked },
				action,
			);
			const body = JSON.stringify(admitted);
			if (Buffer.byteLength(body) > REQUEST_LIMIT) throw new Error(ERROR);
			return await withCloudDeadline(
				async (requestSignal) => {
					const response = await transport(`${origin}/v1/coding-commands/${action}`, {
						method: "POST",
						redirect: "error",
						signal: requestSignal,
						headers: {
							authorization: `Bearer ${token}`,
							"content-type": "application/json",
							...(holder ? { "x-qorpera-identity": holder() } : {}),
						},
						body,
					});
					pages.heard(origin, response.headers);
					if (!response.ok || response.status !== 200) {
						answer.refused = response.status < 500;
						void response.body?.cancel().catch(() => undefined);
						throw new Error(ERROR);
					}
					const bytes = await readBoundedCloudResponse(response, RESULT_LIMIT, requestSignal);
					const receipt = parseCloudCodingCommandReceipt(
						JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)),
					);
					if (
						receipt.workerId !== admitted.scope.workerId ||
						receipt.commandId !== admitted.input.commandId ||
						(admitted.action === "start" && receipt.inputSha256 !== admitted.input.inputSha256)
					)
						throw new Error(ERROR);
					// A receipt that shows nothing of its command answers any page (F3 5g-5).
					if (
						admitted.action === "read" &&
						!isHidden(receipt) &&
						((!admitted.input.tail && receipt.log.offset !== (admitted.input.offset ?? 0)) ||
							Buffer.byteLength(receipt.output) > (admitted.input.limit ?? 4096))
					)
						throw new Error(ERROR);
					return receipt;
				},
				30000,
				signal,
			);
		} catch {
			throw new Error(ERROR);
		}
	};
	/** A call; a read once more when the executor stopped saying what it takes (one rolled back under this process),
	 * since such an executor refuses a page past what it takes and says nothing, and a refused read showed nothing. A
	 * failure that is not the executor's refusal (5xx, no answer) is never asked again. */
	const request = async (
		action: "start" | "read" | "cancel",
		admittedScope: CloudCodingCommandScope,
		input: CommandInput | CloudCodingCommandRead,
		signal: AbortSignal,
	): Promise<unknown> => {
		// What a read may ask the executor for now; nothing for any other call, or a read that does not parse (`send`
		// refuses it).
		const limit = (): number => {
			try {
				return action === "read" ? Math.min(parseCloudCodingCommandRead(input).limit ?? 4096, pages.of(origin)) : 0;
			} catch {
				return 0;
			}
		};
		const asked = limit();
		const answer = { refused: false };
		try {
			return await send(action, admittedScope, input, signal, answer);
		} catch (error) {
			if (!answer.refused || limit() >= asked) throw error;
			return send(action, admittedScope, input, signal);
		}
	};
	return Object.freeze<CloudCodingCommandGateway>({
		authorize: options.authorize,
		start: (s, input, signal) => request("start", s, input, signal),
		read: (s, input, signal) => request("read", s, input, signal),
		cancel: (s, commandId, signal) => request("cancel", s, { commandId }, signal),
	});
}

/** How a command's receipt shows nothing of the command (F3 5g-5): `machine_stopped` for one started on a disk its
 * machine no longer has, or on another machine; `unconfirmed` for one the host can say nothing of now. */
export type CloudCodingCommandHidden = "machine_stopped" | "unconfirmed";
/** A call's work on the executor that holds the command's machine. */
export interface CloudCodingCommandExecution {
	readonly receipt: unknown;
	/** Whether the receipt shows nothing of its command, and as what; undefined when it shows it. The service asks it
	 * once, after its final authorization and right before it sends the answer: the one check that decides it. */
	hidden(signal: AbortSignal): Promise<CloudCodingCommandHidden | undefined>;
}

export interface CloudCodingCommandServiceOptions {
	token: string;
	/** G2-6b: whether the request's holder credential (x-qorpera-identity) holds its binding's run lease
	 * (qorpera_native_binding_proven), asked before anything else about the binding. It resolves only for a proven
	 * binding. Null only on the executors' peer listener: its own token is held by executors alone, and each proved the
	 * guest's holder at its own ingress before forwarding. */
	proveBinding: ((binding: CloudNativeToolBinding, holder: string, signal: AbortSignal) => Promise<void>) | null;
	/** Recheck the current native binding, request lease, worker/VM/turn and
	 * original command receipt. For start also compare command+timeout against
	 * its canonical admitted arguments. Return the original command input hash. */
	authorize(request: CloudCodingCommandHttpRequest, signal: AbortSignal): Promise<{ inputSha256: string }>;
	/** Trusted host composition constructs the fixed LXD guest transport after
	 * SQL authority checks; never execute a shell on the host. */
	execute(request: CloudCodingCommandHttpRequest, signal: AbortSignal): Promise<CloudCodingCommandExecution>;
	/** Company machines' commands on the same ingress (/v1/machine-commands/*),
	 * when this executor routes them. */
	machines?: CloudMachineCommandServiceOptions;
	/**
	 * The agent's home on the same ingress (slice 1): the one route that keeps a channel open, so a run's Codex can
	 * run its own shell and file tools on its machine. `authorize` is SQL's
	 * (`qorpera_authorize_home_session`), asked after the holder is proven and before a byte reaches the machine;
	 * `open` starts `codex exec-server --listen stdio` on the machine as its agent account (or, for a channel of kind
	 * `sftp`, OpenSSH's `sftp-server`: Claude Code's file channel, slice C1), on this node's own machine
	 * or, for a machine another node holds, through that node's peer listener (as a machine command is forwarded).
	 */
	home?: {
		authorize(
			request: { binding: CloudNativeToolBinding; machineId: string; sessionId: string },
			signal: AbortSignal,
		): Promise<CloudHomeSessionAnswer>;
		open(
			authority: CloudHomeSessionAuthorized,
			request: CloudHomeChannelRequest,
			signal: AbortSignal,
		): Promise<CloudHomeChannelSide>;
	};
	host?: "127.0.0.1" | "::1";
	port?: number;
	/** How often an open home channel says it is still there (CLOUD_HOME_CHANNEL_KEEPALIVE): the tests' own shorter one. */
	homeKeepAliveMs?: number;
}

async function readRequest(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
	const declared = request.headers["content-length"];
	if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > REQUEST_LIMIT)) throw new Error(ERROR);
	const chunks: Buffer[] = [];
	let count = 0;
	const abort = (): void => {
		request.destroy();
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		for await (const value of request) {
			signal.throwIfAborted();
			const bytes = Buffer.from(value);
			count += bytes.length;
			if (count > REQUEST_LIMIT) throw new Error(ERROR);
			chunks.push(bytes);
		}
		return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks, count)));
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
/** One JSON answer, within its bound: a receipt's (128 KiB), or a screen's with its picture (machine_screen). Each says
 * what a page of a command's log may ask this executor for (keyholes S1). */
function replyJson(reply: ServerResponse, status: number, value: unknown, limit = RESULT_LIMIT): void {
	const body = JSON.stringify(value);
	if (Buffer.byteLength(body) > limit) throw new Error(ERROR);
	reply.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		[CLOUD_COMMAND_PAGE_HEADER]: String(CLOUD_CODING_COMMAND_PAGE_BYTES),
	});
	reply.end(body);
}
/** Loopback-only backend for a separately configured TLS proxy; the bearer
 * credential comes from private systemd credential provisioning. */
export class HttpCloudCodingCommandService {
	readonly #options: CloudCodingCommandServiceOptions;
	readonly #token: Buffer;
	readonly #controllers = new Set<AbortController>();
	#server?: Server;
	constructor(options: CloudCodingCommandServiceOptions) {
		if (
			!validToken(options.token) ||
			(options.host !== undefined && !["127.0.0.1", "::1"].includes(options.host)) ||
			(options.homeKeepAliveMs !== undefined &&
				(!Number.isSafeInteger(options.homeKeepAliveMs) || options.homeKeepAliveMs < 1)) ||
			!Number.isSafeInteger(options.port ?? 0) ||
			(options.port ?? 0) < 0 ||
			(options.port ?? 0) > 65535
		)
			throw new Error(ERROR);
		this.#options = Object.freeze({ ...options });
		this.#token = Buffer.from(`Bearer ${options.token}`);
	}
	#waitForWritableDrain(socket: Socket, signal: AbortSignal): Promise<boolean> {
		if (socket.destroyed || !socket.writable || signal.aborted) return Promise.resolve(false);
		return new Promise<boolean>((resolve) => {
			const done = (ok: boolean): void => {
				socket.removeListener("drain", onDrain);
				socket.removeListener("close", onEnd);
				socket.removeListener("error", onEnd);
				signal.removeEventListener("abort", onEnd);
				resolve(ok);
			};
			const onDrain = (): void => done(true);
			const onEnd = (): void => done(false);
			socket.once("drain", onDrain);
			socket.once("close", onEnd);
			socket.once("error", onEnd);
			signal.addEventListener("abort", onEnd, { once: true });
		});
	}

	#scheduleSocketDestroy(socket: Socket): void {
		if (socket.destroyed) return;
		const timer = setTimeout(() => socket.destroy(), 2000);
		timer.unref();
		socket.once("close", () => clearTimeout(timer));
	}

	/**
	 * One run's channel to its home (slice 1), on an upgraded socket: the transport token, then the run's holder
	 * proven as every other route proves it, then the handshake line, then SQL's authority for this session, and only
	 * then the machine. Anything that does not hold ends the socket with one line saying why, in the words the host
	 * gives the model, and never an address, a token or a session of another run.
	 */
	async #home(request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
		const home = this.#options.home;
		const prove = this.#options.proveBinding;
		const controller = new AbortController();
		this.#controllers.add(controller);
		const onSocketClose = (): void => controller.abort();
		socket.once("close", onSocketClose);
		const bearer = Buffer.from(String(request.headers.authorization ?? ""));
		const header = request.headers["x-qorpera-identity"];
		// The run's ingress proves the run's holder; a peer listener takes none, as for a machine command: only
		// executors hold its token, and the forwarding one proved the holder at its own ingress.
		const holder = typeof header === "string" && isNativeJobHolder(header) ? header : undefined;
		socket.on("error", () => undefined);
		// Bytes that came in behind the request's own head belong to the channel.
		if (head.byteLength > 0) socket.unshift(head);
		let endedGracefully = false;
		const endGracefully = (payload: string): void => {
			endedGracefully = true;
			socket.end(payload);
		};
		const refuse = (reason: string): void => {
			// Before the upgrade is completed there is no channel to answer on, so the socket simply ends.
			endGracefully(
				`HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\nx-qorpera-home: ${reason}\r\n\r\n`,
			);
		};
		let side: CloudHomeChannelSide | undefined;
		let stopKeepAlive = (): void => undefined;
		try {
			if (
				!home ||
				request.method !== "GET" ||
				request.url !== CLOUD_HOME_CHANNEL_PATH ||
				String(request.headers.upgrade ?? "").toLowerCase() !== CLOUD_HOME_CHANNEL_PROTOCOL ||
				bearer.length !== this.#token.length ||
				!timingSafeEqual(bearer, this.#token) ||
				(prove && holder === undefined)
			) {
				refuse("unavailable");
				return;
			}
			socket.write(
				`HTTP/1.1 101 Switching Protocols\r\nupgrade: ${CLOUD_HOME_CHANNEL_PROTOCOL}\r\nconnection: Upgrade\r\n\r\n`,
			);
			const reader = cloudHomeChannelLines(socket);
			let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
			let first: IteratorResult<string>;
			try {
				first = await Promise.race([
					reader.next(),
					new Promise<never>((_resolve, reject) => {
						handshakeTimer = setTimeout(() => reject(new Error(ERROR)), CLOUD_HOME_CHANNEL_HANDSHAKE_MS);
						handshakeTimer.unref();
					}),
				]);
			} finally {
				clearTimeout(handshakeTimer);
			}
			const handshake = first.done ? undefined : parseCloudHomeChannelHandshake(first.value);
			if (!handshake) {
				endGracefully(`${JSON.stringify({ ok: false, reason: "unavailable" })}\n`);
				return;
			}
			// WHY: keep reading the upgraded socket during async authorize/open so peer EOF/FIN aborts controller promptly.
			const nextRead = reader.next();
			void nextRead.then(
				(item) => {
					if (item.done) controller.abort();
				},
				() => controller.abort(),
			);
			const binding = parseCloudNativeToolBinding(handshake.binding);
			if (prove && holder !== undefined) await prove(binding, holder, controller.signal);
			const authority = await home.authorize(
				{ binding, machineId: handshake.machineId, sessionId: handshake.sessionId },
				controller.signal,
			);
			if (authority.state !== "authorized") {
				endGracefully(`${JSON.stringify({ ok: false, reason: authority.reason })}\n`);
				return;
			}
			// One session's authority for every kind of channel (slice C1): the kind only says what runs on the machine.
			side = await home.open(authority, { binding, holder, kind: handshake.kind ?? "exec" }, controller.signal);
			socket.write(`${JSON.stringify({ ok: true, sessionId: authority.sessionId, machine: authority.machine })}\n`);
			// A front ends an upgraded connection that is quiet for its read timeout: while the channel is open this end
			// says it is there, and the run's own such lines go no further than here.
			stopKeepAlive = cloudHomeChannelKeepAlive(
				socket,
				this.#options.homeKeepAliveMs ?? CLOUD_HOME_CHANNEL_KEEPALIVE_MS,
			);
			const machine = side;
			// Either side ending ends the other (review round 1, F3): the exec-server on the machine waits on its
			// stdin, so a run's slot that went must not leave a process running there, and a machine whose channel
			// closed must not leave the slot waiting for an answer that cannot come.
			const fromMachine = (async () => {
				try {
					for await (const line of machine.lines) {
						if (!socket.writable || socket.destroyed) break;
						if (!socket.write(`${line}\n`)) {
							if (!(await this.#waitForWritableDrain(socket, controller.signal))) break;
						}
					}
				} finally {
					socket.destroy();
				}
			})();
			const clientLines = (async function* () {
				const resumed = await nextRead;
				if (!resumed.done) {
					yield resumed.value;
					yield* reader;
				}
			})();
			try {
				for await (const line of cloudHomeChannelWithoutKeepAlive(clientLines)) machine.write(line);
			} finally {
				await side.close().catch(() => undefined);
				side = undefined;
			}
			await fromMachine.catch(() => undefined);
		} catch (error) {
			// A peer's refusal keeps its reason, so the run's host can tell the model which it is; anything else is
			// only "unavailable", never the error's own words.
			const reason =
				error instanceof CloudHomeChannelRefused && CLOUD_HOME_CHANNEL_REASON.test(error.reason)
					? error.reason
					: "unavailable";
			if (socket.writable) endGracefully(`${JSON.stringify({ ok: false, reason })}\n`);
		} finally {
			stopKeepAlive();
			socket.removeListener("close", onSocketClose);
			this.#controllers.delete(controller);
			controller.abort();
			await side?.close().catch(() => undefined);
			if (endedGracefully) this.#scheduleSocketDestroy(socket);
			else socket.destroy();
		}
	}

	async start(signal?: AbortSignal): Promise<number> {
		if (this.#server) throw new Error(ERROR);
		signal?.throwIfAborted();
		const server = createServer((request, reply) => {
			void this.#handle(request, reply);
		});
		// The home's channel (slice 1). An upgraded socket leaves the per-request bounds below behind, which a channel
		// that lives as long as a model's turn cannot keep; every other route stays exactly as it is.
		if (this.#options.home)
			server.on("upgrade", (request, socket, head) => void this.#home(request, socket as Socket, head));
		this.#server = server;
		server.requestTimeout = 15000;
		server.headersTimeout = 10000;
		server.keepAliveTimeout = 1000;
		server.maxRequestsPerSocket = 10;
		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error): void => {
					reject(error);
				};
				server.once("error", onError);
				server.listen(this.#options.port ?? 0, this.#options.host ?? "127.0.0.1", () => {
					server.off("error", onError);
					resolve();
				});
			});
			const address = server.address();
			if (!address || typeof address === "string") throw new Error(ERROR);
			const abort = (): void => {
				void this.close();
			};
			signal?.addEventListener("abort", abort, { once: true });
			server.once("close", () => signal?.removeEventListener("abort", abort));
			if (signal?.aborted) {
				await this.close();
				throw new Error(ERROR);
			}
			return address.port;
		} catch {
			this.#server = undefined;
			server.close();
			throw new Error(ERROR);
		}
	}
	async close(): Promise<void> {
		const server = this.#server;
		this.#server = undefined;
		for (const controller of this.#controllers) controller.abort();
		if (!server) return;
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections();
		});
	}
	async #handle(request: IncomingMessage, reply: ServerResponse): Promise<void> {
		const controller = new AbortController();
		this.#controllers.add(controller);
		const timeout = setTimeout(() => controller.abort(), 30000);
		const disconnect = (): void => {
			if (!reply.writableFinished) controller.abort();
		};
		reply.once("close", disconnect);
		try {
			const authorization = Buffer.from(request.headers.authorization ?? "");
			const route = /^\/v1\/coding-commands\/(start|read|cancel)$/.exec(request.url ?? "");
			const machineRoute = this.#options.machines
				? /^\/v1\/machine-commands\/(start|read|cancel)$/.exec(request.url ?? "")
				: null;
			const wakeRoute = this.#options.machines?.wake && request.url === "/v1/machine-commands/wake";
			// save_coding_value (20260930705000): the machine's clipboard helper, for one executing receipt.
			const codingValueRoute =
				this.#options.machines?.codingValue && request.url === "/v1/machine-commands/coding-value";
			const accountFillRoute =
				this.#options.machines?.accountFill && request.url === "/v1/machine-commands/account-fill";
			// machine_screen (20260930708000): the machine's screen helper, for a look or one executing receipt.
			const screenRoute = this.#options.machines?.screen && request.url === "/v1/machine-commands/screen";
			// A member's look (20260930712000): on the peer listener only (no run's lease to prove), from another executor.
			const memberScreenRoute =
				this.#options.proveBinding === null &&
				this.#options.machines?.memberScreen &&
				request.url === "/v1/machine-commands/member-screen";
			// A member's action (20260930713000): on the peer listener only, from another executor, as the look.
			const memberActRoute =
				this.#options.proveBinding === null &&
				this.#options.machines?.memberAct &&
				request.url === "/v1/machine-commands/member-act";
			// A member's start of the desktop (20260930714000): on the peer listener only, from another executor, as the look.
			const memberStartRoute =
				this.#options.proveBinding === null &&
				this.#options.machines?.memberStart &&
				request.url === "/v1/machine-commands/member-start";
			// A member's pointer move (20260930744000): on the peer listener only, from another executor, as the look.
			const memberPointerRoute =
				this.#options.proveBinding === null &&
				this.#options.machines?.memberPointer &&
				request.url === "/v1/machine-commands/member-pointer";
			// A member's live picture (20260930745000): on the peer listener only, from the executor that admitted the stream.
			const memberStreamRoute =
				this.#options.proveBinding === null &&
				this.#options.machines?.memberStream &&
				request.url === "/v1/machine-commands/member-stream";
			const holder = request.headers["x-qorpera-identity"];
			if (
				request.method !== "POST" ||
				(!route &&
					!machineRoute &&
					!wakeRoute &&
					!codingValueRoute &&
					!accountFillRoute &&
					!screenRoute &&
					!memberScreenRoute &&
					!memberActRoute &&
					!memberStartRoute &&
					!memberPointerRoute &&
					!memberStreamRoute) ||
				request.headers["content-type"] !== "application/json" ||
				authorization.length !== this.#token.length ||
				!timingSafeEqual(authorization, this.#token) ||
				(this.#options.proveBinding !== null && !isNativeJobHolder(holder))
			)
				throw new Error(ERROR);
			const body = await readRequest(request, controller.signal);
			// G2-6b: the run's own lease proves the binding before either route asks anything about it (a machine
			// start's authorization already records the command).
			if (this.#options.proveBinding !== null)
				await this.#options.proveBinding(
					parseCloudNativeToolBinding((body as { binding?: unknown } | null)?.binding),
					holder as string,
					controller.signal,
				);
			controller.signal.throwIfAborted();
			if (wakeRoute && this.#options.machines?.wake) {
				const told = await this.#options.machines.wake(parseCloudMachineWakeHttpRequest(body), controller.signal);
				replyJson(reply, 200, { schema: CLOUD_MACHINE_WAKE_SCHEMA, told });
				return;
			}
			if (codingValueRoute && this.#options.machines?.codingValue) {
				const admitted = parseCloudMachineCodingValueHttpRequest(body);
				try {
					replyJson(
						reply,
						200,
						parseCloudMachineCodingValueAnswer(
							admitted,
							await this.#options.machines.codingValue(admitted, controller.signal),
						),
					);
				} catch (error) {
					// Only a refusal the agent can act on is told apart, by its fixed code.
					if (!(error instanceof CloudMachineCodingValueRefusal)) throw error;
					replyJson(reply, 409, { code: error.code });
				}
				return;
			}
			if (accountFillRoute && this.#options.machines?.accountFill) {
				const admitted = parseCloudMachineAccountFillHttpRequest(body);
				try {
					replyJson(
						reply,
						200,
						parseCloudMachineAccountFillAnswer(
							admitted,
							await this.#options.machines.accountFill(admitted, controller.signal),
						),
					);
				} catch (error) {
					// Only a refusal the agent can act on is told apart, by its fixed code (and the vault's own words).
					if (!(error instanceof CloudMachineAccountFillRefusal)) throw error;
					replyJson(reply, 409, {
						code: error.code,
						...(error.vault !== undefined ? { vault: error.vault } : {}),
					});
				}
				return;
			}
			if (screenRoute && this.#options.machines?.screen) {
				const admitted = parseCloudMachineScreenHttpRequest(body);
				try {
					replyJson(
						reply,
						200,
						parseCloudMachineScreenAnswer(
							admitted,
							await this.#options.machines.screen(admitted, controller.signal),
						),
						CLOUD_MACHINE_SCREEN_RESPONSE_LIMIT,
					);
				} catch (error) {
					// Only a refusal the agent can act on is told apart, by its fixed code.
					if (!(error instanceof CloudMachineScreenRefusal)) throw error;
					replyJson(reply, 409, { code: error.code });
				}
				return;
			}
			if (memberScreenRoute && this.#options.machines?.memberScreen) {
				const admitted = parseCloudMemberMachineScreenPeerRequest(body);
				try {
					replyJson(
						reply,
						200,
						cloudMemberMachineScreenAnswer(
							admitted,
							await this.#options.machines.memberScreen(admitted, controller.signal),
						),
						CLOUD_MACHINE_SCREEN_RESPONSE_LIMIT,
					);
				} catch (error) {
					// Only a refusal the member's window acts on is told apart, by its fixed code.
					if (!(error instanceof CloudMemberMachineScreenRefusal)) throw error;
					replyJson(reply, 409, { code: error.code });
				}
				return;
			}
			if (memberActRoute && this.#options.machines?.memberAct) {
				// The body holds what the member typed: it is read here and passed on, and never logged or answered.
				const admitted = parseCloudMemberMachineActPeerRequest(body);
				try {
					replyJson(
						reply,
						200,
						cloudMemberMachineActAnswer(
							admitted,
							await this.#options.machines.memberAct(admitted, controller.signal),
						),
					);
				} catch (error) {
					// Only a refusal the member's window acts on is told apart, by its fixed code.
					if (!(error instanceof CloudMemberMachineActRefusal)) throw error;
					replyJson(reply, 409, { code: error.code });
				}
				return;
			}
			if (memberStreamRoute && this.#options.machines?.memberStream) {
				const admitted = parseCloudMemberMachineStreamPeerRequest(body);
				// A live picture lasts while it is watched (its own bound, 8 h), not a command's 30 s; it ends when the asking
				// executor closes its request.
				clearTimeout(timeout);
				let begun = false;
				const begin = () => {
					if (begun) return;
					begun = true;
					reply.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store" });
					reply.flushHeaders();
				};
				const way: MemberStreamWay = { unflushed: 0 };
				const sink = {
					ready: begin,
					send: async (message: Buffer) => {
						if (controller.signal.aborted) throw new Error(ERROR);
						begin();
						// The head and the picture as writes in one, corked: the picture's bytes are never copied here. Waiting
						// for the asking executor to drain ends with this request too: nothing of it waits past the stream's end
						// (review r2 F3 of #1746); and at most MEMBER_STREAM_UNFLUSHED_MESSAGES wait unflushed.
						await writeMemberStreamMessage(
							reply,
							way,
							cloudMemberMachineStreamFrameHead(1, message.byteLength),
							message,
							controller.signal,
						);
					},
				};
				let reason: string;
				try {
					reason = await this.#options.machines.memberStream(admitted, sink, controller.signal);
				} catch (error) {
					// Only a refusal before anything was sent is told apart, by its fixed code.
					if (!begun && error instanceof CloudMemberMachinePointerRefusal) {
						replyJson(reply, 409, { code: error.code });
						return;
					}
					if (!begun) throw error;
					reason = "STREAM_UNAVAILABLE";
				}
				begin();
				reply.end(cloudMemberMachineStreamFrame(2, Buffer.from(reason, "utf8")));
				return;
			}
			if (memberPointerRoute && this.#options.machines?.memberPointer) {
				const admitted = parseCloudMemberMachinePointerPeerRequest(body);
				try {
					replyJson(
						reply,
						200,
						cloudMemberMachinePointerAnswer(
							admitted,
							await this.#options.machines.memberPointer(admitted, controller.signal),
						),
					);
				} catch (error) {
					// Only a refusal the member's window acts on is told apart, by its fixed code.
					if (!(error instanceof CloudMemberMachinePointerRefusal)) throw error;
					replyJson(reply, 409, { code: error.code });
				}
				return;
			}
			if (memberStartRoute && this.#options.machines?.memberStart) {
				const admitted = parseCloudMemberMachineStartPeerRequest(body);
				try {
					replyJson(
						reply,
						200,
						cloudMemberMachineStartAnswer(
							admitted,
							await this.#options.machines.memberStart(admitted, controller.signal),
						),
					);
				} catch (error) {
					// Only a refusal the member's window acts on is told apart, by its fixed code.
					if (!(error instanceof CloudMemberMachineStartRefusal)) throw error;
					replyJson(reply, 409, { code: error.code });
				}
				return;
			}
			if (machineRoute && this.#options.machines) {
				try {
					replyJson(
						reply,
						200,
						await serveCloudMachineCommand(this.#options.machines, body, machineRoute[1], controller.signal),
					);
				} catch (error) {
					// Only a refusal the agent can act on is told apart, by its fixed code (and its folder cause, 6e-2a).
					if (!(error instanceof CloudMachineCommandRefusal)) throw error;
					replyJson(reply, 409, {
						code: error.code,
						...(error.folderLost !== undefined ? { folderLost: error.folderLost } : {}),
					});
				}
				return;
			}
			if (!route) throw new Error(ERROR);
			const admitted = parseRequest(body, route[1]);
			const authority = await this.#options.authorize(admitted, controller.signal);
			if (
				!HASH.test(authority.inputSha256) ||
				(admitted.action === "start" && authority.inputSha256 !== admitted.input.inputSha256)
			)
				throw new Error(ERROR);
			controller.signal.throwIfAborted();
			const executed = await this.#options.execute(admitted, controller.signal);
			const receipt = parseCloudCodingCommandReceipt(executed.receipt);
			const after = await this.#options.authorize(admitted, controller.signal);
			controller.signal.throwIfAborted();
			if (
				after.inputSha256 !== authority.inputSha256 ||
				receipt.inputSha256 !== authority.inputSha256 ||
				receipt.workerId !== admitted.scope.workerId ||
				receipt.commandId !== admitted.input.commandId
			)
				throw new Error(ERROR);
			// F3 5g-5: whether anything of the command is shown is decided here, once, after every authorization of the call
			// (the executor's last one may have marked the machine for a new disk, and another turn may have rebuilt it
			// meanwhile); only then is the answer built.
			const hidden = await executed.hidden(controller.signal);
			if (hidden !== undefined && hidden !== "machine_stopped" && hidden !== "unconfirmed") throw new Error(ERROR);
			controller.signal.throwIfAborted();
			replyJson(reply, 200, hidden ? hiddenReceipt(receipt, hidden) : receipt);
		} catch {
			if (!reply.headersSent && !reply.destroyed) replyJson(reply, 403, { error: "coding_command_unavailable" });
			else reply.destroy();
		} finally {
			clearTimeout(timeout);
			reply.off("close", disconnect);
			this.#controllers.delete(controller);
		}
	}
}
