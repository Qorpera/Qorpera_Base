import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { connect, createServer, isIP, type Server, type Socket } from "node:net";

/** Guest screen agent for the Company Computer (transport ratified
 * 2026-08-26, deploy/first-node/STEP-3-SCREENS-DECISION.md): one desktop
 * session per registered screen, reconciled against the control-plane
 * registry so the cloud stays the single writer for which screens exist.
 * Screens are parallel work surfaces, never security boundaries. Every
 * desktop session must bind its VNC socket to guest loopback only; the sole
 * way in is the viewer listener below, which accepts connections exclusively
 * from the trusted host bridge address holding the provider-delivered viewer
 * token. Members' live watch-and-take-over path rides that brokered leg;
 * nothing here is ever publicly reachable. */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ATTACH_SCHEMA = "qorpera.company-computer-screen-attach/v1";
const MAX_ATTACH_HANDSHAKE_BYTES = 4_096;
const ATTACH_HANDSHAKE_TIMEOUT_MS = 5_000;
const SESSION_STOP_ESCALATION_MS = 5_000;
const MIN_SCREEN_POLL_SECONDS = 5;
const MAX_SCREEN_POLL_SECONDS = 3_600;

/** VNC convention: display :N serves TCP port 5900 + N, so the screen
 * ordinal doubles as the display number and fixes the loopback port. */
export const COMPANY_COMPUTER_SCREEN_VNC_PORT_BASE = 5_900;

export function companyComputerScreenDisplay(ordinal: number): string {
	return `:${ordinal}`;
}

export function companyComputerScreenVncPort(ordinal: number): number {
	return COMPANY_COMPUTER_SCREEN_VNC_PORT_BASE + ordinal;
}

export interface CompanyComputerScreenRecord {
	screenId: string;
	screenOrdinal: number;
	displayName: string;
	status: "active" | "retired";
	attachedStaffAgentId?: string;
	occupyingRunId?: string;
}

export interface CompanyComputerScreensControlPlane {
	listScreens(companyComputerId: string, signal?: AbortSignal): Promise<CompanyComputerScreenRecord[]>;
}

export function parseCompanyComputerScreenRecords(value: unknown): CompanyComputerScreenRecord[] {
	if (!Array.isArray(value)) throw new Error("Company computer screen listing is invalid");
	return value.map((entry): CompanyComputerScreenRecord => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error("Company computer screen record is invalid");
		}
		const input = entry as Record<string, unknown>;
		const attached = input.attached_staff_agent_id;
		const occupying = input.occupying_run_id;
		if (
			typeof input.screen_id !== "string" ||
			!UUID_PATTERN.test(input.screen_id) ||
			!Number.isSafeInteger(input.screen_ordinal) ||
			(input.screen_ordinal as number) < 1 ||
			(input.screen_ordinal as number) > 32 ||
			typeof input.display_name !== "string" ||
			(input.status !== "active" && input.status !== "retired") ||
			(attached !== null &&
				attached !== undefined &&
				(typeof attached !== "string" || !UUID_PATTERN.test(attached))) ||
			(occupying !== null &&
				occupying !== undefined &&
				(typeof occupying !== "string" || !UUID_PATTERN.test(occupying)))
		) {
			throw new Error("Company computer screen record is invalid");
		}
		return {
			screenId: input.screen_id,
			screenOrdinal: input.screen_ordinal as number,
			displayName: input.display_name,
			status: input.status,
			...(typeof attached === "string" ? { attachedStaffAgentId: attached } : {}),
			...(typeof occupying === "string" ? { occupyingRunId: occupying } : {}),
		};
	});
}

export class SupabaseCompanyComputerScreensControlPlane implements CompanyComputerScreensControlPlane {
	readonly #supabaseUrl: string;
	readonly #serviceKey: string;
	readonly #fetch: typeof fetch;

	constructor(supabaseUrl: string, serviceKey: string, fetchImplementation: typeof fetch = fetch) {
		this.#supabaseUrl = supabaseUrl;
		this.#serviceKey = serviceKey;
		this.#fetch = fetchImplementation;
	}

	async listScreens(companyComputerId: string, signal?: AbortSignal): Promise<CompanyComputerScreenRecord[]> {
		const headers: Record<string, string> = { apikey: this.#serviceKey, "content-type": "application/json" };
		if (this.#serviceKey.startsWith("eyJ") && this.#serviceKey.split(".").length === 3) {
			headers.authorization = `Bearer ${this.#serviceKey}`;
		}
		const response = await this.#fetch(
			new URL("/rest/v1/rpc/qorpera_list_company_computer_screens", this.#supabaseUrl),
			{
				method: "POST",
				headers,
				body: JSON.stringify({ p_company_computer_id: companyComputerId }),
				signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
			},
		);
		if (!response.ok) throw new Error(`Company computer screen listing failed (${response.status})`);
		return parseCompanyComputerScreenRecords(await response.json());
	}
}

/** Mirrors the screens block of qorpera.company-computer-bootstrap/v1;
 * unknown keys are ignored so an older agent keeps starting under a newer
 * provider. */
export interface CloudCompanyComputerScreensConfig {
	viewerHost: string;
	viewerPort: number;
	viewerTrustedSource: string;
	pollSeconds: number;
}

export function parseCloudCompanyComputerScreensConfig(value: unknown): CloudCompanyComputerScreensConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Company computer screens configuration is invalid");
	}
	const input = value as Record<string, unknown>;
	const viewerHost = input.viewer_host;
	const viewerPort = input.viewer_port;
	const viewerTrustedSource = input.viewer_trusted_source;
	const pollSeconds = input.poll_seconds;
	if (typeof viewerHost !== "string" || isIP(viewerHost) === 0) {
		throw new Error("Company computer screens viewer host is invalid");
	}
	if (!Number.isSafeInteger(viewerPort) || (viewerPort as number) < 1_024 || (viewerPort as number) > 65_535) {
		throw new Error("Company computer screens viewer port is invalid");
	}
	if (typeof viewerTrustedSource !== "string" || isIP(viewerTrustedSource) !== 4) {
		throw new Error("Company computer screens viewer trusted source is invalid");
	}
	if (
		!Number.isSafeInteger(pollSeconds) ||
		(pollSeconds as number) < MIN_SCREEN_POLL_SECONDS ||
		(pollSeconds as number) > MAX_SCREEN_POLL_SECONDS
	) {
		throw new Error("Company computer screens poll interval is invalid");
	}
	return {
		viewerHost,
		viewerPort: viewerPort as number,
		viewerTrustedSource,
		pollSeconds: pollSeconds as number,
	};
}

export interface CompanyComputerScreenSessionHandle {
	stop(): Promise<void>;
	exited: Promise<void>;
}

export interface CompanyComputerScreenLaunch {
	ordinal: number;
	display: string;
	vncPort: number;
}

export interface CompanyComputerScreenLauncher {
	launch(screen: CompanyComputerScreenLaunch): Promise<CompanyComputerScreenSessionHandle>;
}

interface SpawnedScreenProcess {
	kill(signal?: NodeJS.Signals): boolean;
	once(event: "exit", listener: () => void): unknown;
	once(event: "error", listener: (error: Error) => void): unknown;
}

export type CompanyComputerScreenSpawn = (command: string, args: readonly string[]) => SpawnedScreenProcess;

const defaultScreenSpawn: CompanyComputerScreenSpawn = (command, args) =>
	spawn(command, [...args], { stdio: "ignore", shell: false });

/** Runs the image's per-screen desktop command — Xvnc plus the XFCE session,
 * or a wrapper script — with {ordinal}, {display}, and {vnc_port}
 * substituted per argument and no shell in between. The command must bind
 * its VNC socket to loopback only (TigerVNC's -localhost); the viewer
 * listener is the single brokered way in. */
export class ExecCompanyComputerScreenLauncher implements CompanyComputerScreenLauncher {
	readonly #command: readonly string[];
	readonly #spawn: CompanyComputerScreenSpawn;

	constructor(command: readonly string[], spawnImplementation: CompanyComputerScreenSpawn = defaultScreenSpawn) {
		const joined = command.join(" ");
		if (
			command.length < 1 ||
			command.some((argument) => !argument.trim()) ||
			(!joined.includes("{ordinal}") && !joined.includes("{display}") && !joined.includes("{vnc_port}"))
		) {
			throw new Error("Company computer screen command must reference {ordinal}, {display}, or {vnc_port}");
		}
		this.#command = [...command];
		this.#spawn = spawnImplementation;
	}

	async launch(screen: CompanyComputerScreenLaunch): Promise<CompanyComputerScreenSessionHandle> {
		const [command, ...args] = this.#command.map((argument) =>
			argument
				.replaceAll("{ordinal}", String(screen.ordinal))
				.replaceAll("{display}", screen.display)
				.replaceAll("{vnc_port}", String(screen.vncPort)),
		);
		const child = this.#spawn(command as string, args);
		const exited = new Promise<void>((resolveExit) => {
			child.once("exit", () => resolveExit());
			child.once("error", () => resolveExit());
		});
		return {
			exited,
			stop: async () => {
				child.kill("SIGTERM");
				let escalation: NodeJS.Timeout | undefined;
				await Promise.race([
					exited,
					new Promise<void>((resolveEscalation) => {
						escalation = setTimeout(() => {
							child.kill("SIGKILL");
							resolveEscalation();
						}, SESSION_STOP_ESCALATION_MS);
					}),
				]);
				if (escalation) clearTimeout(escalation);
				await exited;
			},
		};
	}
}

/** Converges live desktop sessions to the registry: active screens run,
 * everything else stops. A session that dies stays absent until the next
 * reconcile relaunches it, so crash recovery needs no extra machinery. */
export class CloudCompanyComputerScreenManager {
	readonly #launcher: CompanyComputerScreenLauncher;
	readonly #sessions = new Map<number, CompanyComputerScreenSessionHandle>();

	constructor(launcher: CompanyComputerScreenLauncher) {
		this.#launcher = launcher;
	}

	liveVncPort(ordinal: number): number | undefined {
		return this.#sessions.has(ordinal) ? companyComputerScreenVncPort(ordinal) : undefined;
	}

	liveOrdinals(): number[] {
		return [...this.#sessions.keys()].sort((left, right) => left - right);
	}

	async reconcile(records: readonly CompanyComputerScreenRecord[]): Promise<void> {
		const desired = new Set(
			records.filter((record) => record.status === "active").map((record) => record.screenOrdinal),
		);
		for (const [ordinal, session] of [...this.#sessions]) {
			if (desired.has(ordinal)) continue;
			this.#sessions.delete(ordinal);
			await session.stop();
		}
		for (const ordinal of [...desired].sort((left, right) => left - right)) {
			if (this.#sessions.has(ordinal)) continue;
			const session = await this.#launcher.launch({
				ordinal,
				display: companyComputerScreenDisplay(ordinal),
				vncPort: companyComputerScreenVncPort(ordinal),
			});
			this.#sessions.set(ordinal, session);
			void session.exited.then(() => {
				if (this.#sessions.get(ordinal) === session) this.#sessions.delete(ordinal);
			});
		}
	}

	async stopAll(): Promise<void> {
		for (const [ordinal, session] of [...this.#sessions]) {
			this.#sessions.delete(ordinal);
			await session.stop();
		}
	}
}

export interface CompanyComputerScreenViewer {
	port: number;
	close(): Promise<void>;
}

export interface StartCompanyComputerScreenViewerInput {
	host: string;
	port: number;
	trustedSource: string;
	viewerToken: string;
	liveVncPort: (ordinal: number) => number | undefined;
	/** Loopback address the desktop sessions bind to; tests override it. */
	vncHost?: string;
}

function normalizedRemoteAddress(address: string | undefined): string {
	if (!address) return "";
	return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

function tokenMatches(expected: string, received: unknown): boolean {
	if (typeof received !== "string" || !TOKEN_PATTERN.test(received)) return false;
	return timingSafeEqual(
		createHash("sha256").update(expected).digest(),
		createHash("sha256").update(received).digest(),
	);
}

/** The guest-side attach surface: raw TCP, one newline-terminated JSON
 * handshake naming the screen, then a byte-for-byte pipe to that screen's
 * loopback VNC socket. Only the trusted host bridge address holding the
 * provider-delivered viewer token may attach; per-member capabilities are
 * checked where member traffic terminates, before this leg is opened. */
export function startCompanyComputerScreenViewer(
	input: StartCompanyComputerScreenViewerInput,
): Promise<CompanyComputerScreenViewer> {
	if (!TOKEN_PATTERN.test(input.viewerToken)) {
		return Promise.reject(new Error("Company computer screen viewer token is invalid"));
	}
	const vncHost = input.vncHost ?? "127.0.0.1";
	const openSockets = new Set<Socket>();
	const server: Server = createServer((socket) => {
		openSockets.add(socket);
		socket.once("close", () => openSockets.delete(socket));
		if (normalizedRemoteAddress(socket.remoteAddress) !== input.trustedSource) {
			socket.destroy();
			return;
		}
		let buffered = Buffer.alloc(0);
		let settled = false;
		const refuse = (error: string): void => {
			settled = true;
			socket.off("data", onData);
			socket.end(`${JSON.stringify({ ok: false, error })}\n`);
		};
		const timeout = setTimeout(() => {
			if (!settled) refuse("attach handshake timed out");
		}, ATTACH_HANDSHAKE_TIMEOUT_MS);
		const onData = (chunk: Buffer): void => {
			buffered = Buffer.concat([buffered, chunk]);
			const newline = buffered.indexOf(0x0a);
			if (newline === -1) {
				if (buffered.byteLength > MAX_ATTACH_HANDSHAKE_BYTES) {
					clearTimeout(timeout);
					refuse("attach handshake is too large");
				}
				return;
			}
			clearTimeout(timeout);
			socket.off("data", onData);
			const remainder = buffered.subarray(newline + 1);
			let handshake: Record<string, unknown>;
			try {
				const parsed: unknown = JSON.parse(buffered.subarray(0, newline).toString("utf-8"));
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
				handshake = parsed as Record<string, unknown>;
			} catch {
				refuse("attach handshake is invalid");
				return;
			}
			if (handshake.schema !== ATTACH_SCHEMA || !tokenMatches(input.viewerToken, handshake.token)) {
				refuse("attach handshake is not authorized");
				return;
			}
			const ordinal = handshake.screen_ordinal;
			const upstreamPort = Number.isSafeInteger(ordinal) ? input.liveVncPort(ordinal as number) : undefined;
			if (upstreamPort === undefined) {
				refuse("screen has no live session");
				return;
			}
			settled = true;
			const upstream: Socket = connect(upstreamPort, vncHost);
			let piped = false;
			const teardown = (): void => {
				socket.destroy();
				upstream.destroy();
			};
			upstream.on("connect", () => {
				piped = true;
				socket.write(`${JSON.stringify({ ok: true, screen_ordinal: ordinal })}\n`);
				if (remainder.byteLength > 0) upstream.write(remainder);
				socket.pipe(upstream);
				upstream.pipe(socket);
			});
			upstream.on("error", () => {
				if (piped) {
					teardown();
					return;
				}
				socket.end(`${JSON.stringify({ ok: false, error: "screen session is unreachable" })}\n`);
			});
			socket.on("error", teardown);
			upstream.on("close", () => {
				if (piped) teardown();
			});
			socket.on("close", teardown);
		};
		socket.on("data", onData);
		socket.on("error", () => {
			clearTimeout(timeout);
			socket.destroy();
		});
	});
	return new Promise((resolveStart, rejectStart) => {
		server.once("error", rejectStart);
		server.listen(input.port, input.host, () => {
			const address = server.address();
			resolveStart({
				port: typeof address === "object" && address ? address.port : input.port,
				close: () =>
					new Promise<void>((resolveClose) => {
						/* Live piped attachments would hold server.close open
						 * forever; shutdown severs them. */
						for (const open of [...openSockets]) open.destroy();
						server.close(() => resolveClose());
					}),
			});
		});
	});
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolveDelay) => {
		if (signal.aborted) {
			resolveDelay();
			return;
		}
		const finish = (): void => {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolveDelay();
		};
		const timer = setTimeout(finish, milliseconds);
		signal.addEventListener("abort", finish, { once: true });
	});
}

export interface RunCloudCompanyComputerScreenAgentInput {
	config: CloudCompanyComputerScreensConfig;
	companyComputerId: string;
	viewerToken: string;
	controlPlane: CompanyComputerScreensControlPlane;
	launcher: CompanyComputerScreenLauncher;
	signal: AbortSignal;
	onError?: (error: unknown) => void;
}

/** The standing screen loop for the Company Computer guest. Control-plane
 * failures are reported and retried on the next tick: staff keep their live
 * desktops through a shed cloud, and the registry re-converges when it
 * returns. */
export async function runCloudCompanyComputerScreenAgent(
	input: RunCloudCompanyComputerScreenAgentInput,
): Promise<void> {
	const manager = new CloudCompanyComputerScreenManager(input.launcher);
	const viewer = await startCompanyComputerScreenViewer({
		host: input.config.viewerHost,
		port: input.config.viewerPort,
		trustedSource: input.config.viewerTrustedSource,
		viewerToken: input.viewerToken,
		liveVncPort: (ordinal) => manager.liveVncPort(ordinal),
	});
	try {
		while (!input.signal.aborted) {
			try {
				await manager.reconcile(await input.controlPlane.listScreens(input.companyComputerId, input.signal));
			} catch (error) {
				if (!input.signal.aborted) input.onError?.(error);
			}
			await abortableDelay(input.config.pollSeconds * 1_000, input.signal);
		}
	} finally {
		await viewer.close();
		await manager.stopAll();
	}
}
