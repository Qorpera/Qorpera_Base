import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { performance } from "node:perf_hooks";
import type { Duplex } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import {
	assertCompanyComputerLease,
	assertCompanyComputerScope,
	COMPANY_COMPUTER_TOOL_VERSION,
	COMPANY_COMPUTER_UUID,
	type CompanyComputerOperation,
	type CompanyComputerScope,
	type CompanyComputerScreenLease,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import { CloudCompanyComputerEffectControl } from "./cloud-company-computer-effect-control.ts";
import type { CompanyComputerGuestEndpoint } from "./cloud-company-computer-endpoint.ts";
import {
	COMPANY_COMPUTER_NATIVE_MAX_REQUEST,
	COMPANY_COMPUTER_NATIVE_MAX_RESPONSE,
	COMPANY_COMPUTER_NATIVE_MAX_SCREENSHOT_RESPONSE,
	COMPANY_COMPUTER_NATIVE_SCHEMA,
	type CompanyComputerNativeDescriptor,
	officeNativeRecord,
	parseCompanyComputerNativeDescriptor,
} from "./cloud-company-computer-native-client.ts";
import type { HttpCloudCompanyComputerRegistry } from "./cloud-company-computer-registry-http.ts";
import { parseCompanyComputerAction } from "./cloud-company-computer-tools.ts";
import {
	type CloudNativeToolBinding,
	CloudNativeToolRun,
	cloudToolRequest,
	isNativeJobHolder,
	parseCloudNativeToolBinding,
} from "./cloud-native-tool-authority.ts";

export interface CompanyComputerNativeGuestSession {
	endpoint: Pick<CompanyComputerGuestEndpoint, "perform" | "authorize" | "capabilities" | "resourceTarget">;
	/** Stop and reap this session's resources, including idle browser channels.
	 * No screen/VM power change or profile-byte deletion. */
	close(): Promise<void>;
	/** True once the guest itself ended this session (its screen was drained)
	 * and finished reaping it. The same lease may then open a fresh one. */
	ended?(): boolean;
	/** A screenshot published without storage (folder-v2): its pixels, once, for the perform answer. */
	screenshot?(receiptId: string): Uint8Array | undefined;
}
/** The guest refused to create a session and created nothing; the gateway keeps no capacity for it. */
export class CompanyComputerGuestSessionRefusedError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "CompanyComputerGuestSessionRefusedError";
	}
}
export type CompanyComputerNativeGuestSessionFactory = (options: {
	run: CloudNativeToolRun;
	descriptor: CompanyComputerNativeDescriptor;
	lease: CompanyComputerScreenLease;
	effects: CloudCompanyComputerEffectControl;
}) => Promise<CompanyComputerNativeGuestSession>;

interface Session {
	key: string;
	run: CloudNativeToolRun;
	lease: CompanyComputerScreenLease;
	guest: CompanyComputerNativeGuestSession;
	active: Set<Promise<unknown>>;
	closing?: Promise<void>;
	reopening?: Promise<void>;
	/** A failed reopen is not retried before this time; the action fails as the old session would. */
	reopenAfter?: number;
	closed: boolean;
	released: boolean;
}
const sameLease = (left: CompanyComputerScreenLease, right: CompanyComputerScreenLease): boolean =>
	isDeepStrictEqual({ ...left, validForMs: 0 }, { ...right, validForMs: 0 });

/** Office-host receiver. The bearer selects a trusted host transport only;
 * native principals are re-derived from SQL. Every guest effect consumes the
 * existing receipt through CompanyComputerGuestEndpoint/EffectControl. */
export class CompanyComputerNativeGateway {
	readonly #scope: CompanyComputerScope;
	readonly #generation: number;
	readonly #token: Buffer;
	readonly #registry: HttpCloudCompanyComputerRegistry;
	readonly #createSession: CompanyComputerNativeGuestSessionFactory;
	readonly #admit: () => void;
	readonly #admitWork: () => void;
	readonly #sessions = new Map<string, Promise<Session>>();
	readonly #completed: string[] = [];
	readonly #stop = new AbortController();
	#inflight = 0;
	#activeSessions = 0;

	constructor(options: {
		scope: CompanyComputerScope;
		computerGeneration: number;
		token: string;
		registry: HttpCloudCompanyComputerRegistry;
		createSession: CompanyComputerNativeGuestSessionFactory;
		/** Service startup/shutdown barrier, before body reads or SQL effects. */
		admit?: () => void;
		/** Fresh supervisor state for new work only; exact cleanup remains available. */
		admitWork?: () => void;
	}) {
		assertCompanyComputerScope(options.scope, options.scope);
		if (
			!Number.isSafeInteger(options.computerGeneration) ||
			options.computerGeneration < 1 ||
			!/^[A-Za-z0-9_-]{43}$/.test(options.token)
		)
			throw new Error("INVALID_OFFICE_NATIVE_CONFIGURATION");
		this.#scope = Object.freeze({ ...options.scope });
		this.#generation = options.computerGeneration;
		this.#token = Buffer.from(`Bearer ${options.token}`);
		this.#registry = options.registry;
		this.#createSession = options.createSession;
		this.#admit = options.admit ?? (() => {});
		this.#admitWork = options.admitWork ?? (() => {});
	}
	#checkLease(lease: CompanyComputerScreenLease, run: CloudNativeToolRun): void {
		officeNativeRecord(lease, "binding,driver,epoch,leaseId,validForMs");
		officeNativeRecord(
			lease.binding,
			"companyComputerId,companyId,computerGeneration,environmentId,logicalComputerId,screenGeneration,screenId,screenOrdinal,staffAgentId",
		);
		officeNativeRecord(lease.driver, "kind,runId,staffAgentId");
		assertCompanyComputerScope(lease.binding, this.#scope);
		assertCompanyComputerLease(lease, lease.binding, {
			kind: "agent",
			runId: run.identity.runId,
			staffAgentId: run.identity.staffAgentId,
		});
		if (lease.binding.computerGeneration !== this.#generation || run.identity.audienceKind !== "company")
			throw new Error("OFFICE_NATIVE_BINDING_CHANGED");
	}
	async #open(
		key: string,
		nativeBinding: unknown,
		lease: CompanyComputerScreenLease,
		operation: CompanyComputerOperation,
		claimGuestOwnership: () => void,
	): Promise<Session> {
		const binding = parseCloudNativeToolBinding(nativeBinding);
		const run = await CloudNativeToolRun.open(
			binding,
			{
				describeToolAuthority: (bound, signal) =>
					this.#registry.call("qorpera_describe_native_tool_authority", { p_binding: bound }, signal),
			},
			this.#stop.signal,
		);
		try {
			this.#checkLease(lease, run);
			const descriptor = parseCompanyComputerNativeDescriptor(
				await this.#registry.call("qorpera_native_office_descriptor", { p_binding: binding }, run.signal),
				run,
			);
			if (!descriptor) throw new Error("OFFICE_UNAVAILABLE");
			assertCompanyComputerScope(descriptor.scope, this.#scope);
			const effects = new CloudCompanyComputerEffectControl({ run, scope: this.#scope, control: this.#registry });
			await effects.assertAuthorized({ operation, identity: run.identity, lease, receipt: null }, run.signal);
			// Composition creates bound adapters only. Guest launch/input still
			// belongs inside the endpoint's admitted perform and shared gate.
			claimGuestOwnership();
			const guest = await cloudToolRequest(async (signal) => {
				const created = await this.#createSession({ run, descriptor, lease: structuredClone(lease), effects });
				if (signal.aborted) {
					await created.close();
					throw new Error("OFFICE_NATIVE_CLOSED");
				}
				return created;
			}, run.signal);
			const session: Session = {
				key,
				run,
				lease: structuredClone(lease),
				guest,
				active: new Set(),
				closed: false,
				released: false,
			};
			if (
				!isDeepStrictEqual(guest.endpoint.resourceTarget, descriptor.resources) ||
				!isDeepStrictEqual(guest.endpoint.capabilities, descriptor.capabilities)
			) {
				await guest.close();
				throw new Error("OFFICE_GUEST_CONFIGURATION_DIFFERS");
			}
			run.signal.addEventListener(
				"abort",
				() => {
					void this.#close(session).catch(() => undefined);
				},
				{ once: true },
			);
			if (run.signal.aborted) {
				await this.#close(session);
			}
			return session;
		} catch (error) {
			run.close();
			throw error;
		}
	}
	#close(session: Session): Promise<void> {
		if (session.closing) return session.closing;
		session.closed = true;
		session.closing = cloudToolRequest(
			async (signal) => {
				session.run.close();
				await Promise.allSettled([...session.active]);
				await session.guest.close();
				signal.throwIfAborted();
				// Persist lease release after physical cleanup. Late requests cannot
				// recreate a closed session, even after local tombstones are pruned.
				const result = officeNativeRecord(
					await this.#registry.call(
						"qorpera_native_office_screen",
						{
							p_binding: session.run.binding,
							p_scope: this.#scope,
							p_action: "release",
							p_lease: session.lease,
						},
						signal,
					),
					"state",
				);
				if (result.state !== "released") throw new Error("OFFICE_NATIVE_RELEASE_UNCONFIRMED");
				session.released = true;
				this.#activeSessions--;
				this.#completed.push(session.key);
				if (this.#completed.length > 1024) this.#sessions.delete(this.#completed.shift()!);
			},
			new AbortController().signal,
			20000,
		);
		return session.closing;
	}
	/**
	 * The guest ended this run's session under a lease that is still the run's
	 * (its desktop went away mid-run). Open a fresh one with the same lease and
	 * configuration, so the run keeps its computer. It grants nothing: the next
	 * action still passes the endpoint's authorization and effect receipt.
	 */
	#reopen(session: Session): Promise<void> {
		session.reopening ??= (async () => {
			const descriptor = parseCompanyComputerNativeDescriptor(
				await this.#registry.call(
					"qorpera_native_office_descriptor",
					{ p_binding: session.run.binding },
					session.run.signal,
				),
				session.run,
			);
			if (!descriptor) throw new Error("OFFICE_UNAVAILABLE");
			assertCompanyComputerScope(descriptor.scope, this.#scope);
			const effects = new CloudCompanyComputerEffectControl({
				run: session.run,
				scope: this.#scope,
				control: this.#registry,
			});
			// The fresh session takes the old one's place at once, whatever happens
			// next, so the run's own close reaps it. A changed configuration needs no
			// check here: its endpoint refuses every operation the run was admitted with.
			session.guest = await this.#createSession({
				run: session.run,
				descriptor,
				lease: structuredClone(session.lease),
				effects,
			});
			if (session.closed) {
				// The run's close may already have closed the session it replaced.
				await session.guest.close().catch(() => undefined);
				throw new Error("OFFICE_NATIVE_CLOSED");
			}
		})()
			.catch((error: unknown) => {
				session.reopenAfter = performance.now() + 3000;
				throw error;
			})
			.finally(() => {
				session.reopening = undefined;
			});
		return session.reopening;
	}
	/**
	 * G2-6c: the run's own lease proves the binding (its x-qorpera-identity holder, qorpera_native_binding_proven with
	 * this computer's registry key) before anything else is asked about it: on every perform, the session's open
	 * included, and on every release, which ends the session and records its screen lease's release. A gate only; the
	 * descriptor and the effect receipts still check the run. The holder never reaches a log or an error.
	 */
	async #prove(binding: CloudNativeToolBinding, holder: unknown, signal: AbortSignal): Promise<void> {
		if (
			!isNativeJobHolder(holder) ||
			(await this.#registry.call(
				"qorpera_native_binding_proven",
				{ p_binding: binding, p_holder: holder },
				signal,
			)) !== true
		)
			throw new Error("OFFICE_NATIVE_UNPROVEN");
	}
	async #dispatch(value: unknown, holder: unknown, signal: AbortSignal): Promise<unknown> {
		const action = value && typeof value === "object" && "action" in value ? value.action : undefined;
		// A vault_fill carries the box the vault sealed to this computer (company accounts A1-3), nothing else does.
		const sealed = action === "perform" && value && typeof value === "object" && "fill" in value;
		const body = officeNativeRecord(
			value,
			action === "release"
				? "action,lease,nativeBinding,schema"
				: sealed
					? "action,fill,lease,nativeBinding,operation,receipt,schema"
					: "action,lease,nativeBinding,operation,receipt,schema",
		);
		if (body.schema !== COMPANY_COMPUTER_NATIVE_SCHEMA || (action !== "perform" && action !== "release"))
			throw new Error("INVALID_OFFICE_NATIVE_MESSAGE");
		const binding = parseCloudNativeToolBinding(body.nativeBinding);
		const lease = body.lease as CompanyComputerScreenLease;
		officeNativeRecord(lease, "binding,driver,epoch,leaseId,validForMs");
		if (!COMPANY_COMPUTER_UUID.test(lease.leaseId)) throw new Error("INVALID_OFFICE_LEASE");
		const key = `${JSON.stringify(binding)}:${lease.leaseId}`;
		if (action === "release") {
			await this.#prove(binding, holder, signal);
			const pending = this.#sessions.get(key);
			if (!pending) throw new Error("OFFICE_NATIVE_SESSION_UNCONFIRMED");
			const session = await pending;
			this.#checkLease(lease, session.run);
			if (!sameLease(lease, session.lease)) throw new Error("OFFICE_NATIVE_BINDING_CHANGED");
			await cloudToolRequest(() => this.#close(session), signal, 20000);
			return { schema: COMPANY_COMPUTER_NATIVE_SCHEMA, state: "released", leaseId: lease.leaseId };
		}
		this.#admitWork();
		const op = officeNativeRecord(
			body.operation,
			"arguments,logicalOperationKey,requiresCompanyRevision,target,tool,toolVersion",
		);
		const parsedAction = parseCompanyComputerAction(op.arguments);
		if (
			op.tool !== `computer_${parsedAction.kind}` ||
			op.toolVersion !== COMPANY_COMPUTER_TOOL_VERSION ||
			op.requiresCompanyRevision !== false ||
			typeof op.logicalOperationKey !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(op.logicalOperationKey) ||
			!isDeepStrictEqual(parsedAction, op.arguments)
		)
			throw new Error("INVALID_OFFICE_OPERATION");
		const operation = op as unknown as CompanyComputerOperation;
		if (sealed !== (parsedAction.kind === "browser" && parsedAction.action === "vault_fill"))
			throw new Error("INVALID_OFFICE_OPERATION");
		let fill: Readonly<Record<string, string>> | undefined;
		if (sealed) {
			const box = officeNativeRecord(body.fill, "ciphertext,ephemeralPublicKey,iv,schema,tag");
			if (!Object.values(box).every((part) => typeof part === "string" && part.length > 0 && part.length <= 8192))
				throw new Error("INVALID_OFFICE_OPERATION");
			fill = Object.freeze({ ...(box as Record<string, string>) });
		}
		const receipt = officeNativeRecord(body.receipt, "idempotencyKey,receiptId");
		if (
			typeof receipt.receiptId !== "string" ||
			!COMPANY_COMPUTER_UUID.test(receipt.receiptId) ||
			typeof receipt.idempotencyKey !== "string" ||
			!/^[0-9a-f]{64}$/.test(receipt.idempotencyKey)
		)
			throw new Error("INVALID_OFFICE_RECEIPT");
		await this.#prove(binding, holder, signal);
		let pending = this.#sessions.get(key);
		if (!pending) {
			if (this.#activeSessions >= 64) throw new Error("OFFICE_NATIVE_CAPACITY_EXHAUSTED");
			this.#activeSessions++;
			let guestOwned = false;
			pending = this.#open(key, binding, lease, operation, () => {
				guestOwned = true;
			});
			this.#sessions.set(key, pending);
			void pending.catch((error: unknown) => {
				// Rejected authority did not create any guest resources, nor did a
				// guest that refused to create a session. Unknown factory/cleanup
				// outcomes retain capacity until service recovery.
				if (!guestOwned || error instanceof CompanyComputerGuestSessionRefusedError) {
					this.#sessions.delete(key);
					this.#activeSessions--;
				}
			});
		}
		const session = await cloudToolRequest(() => pending!, signal);
		this.#checkLease(lease, session.run);
		if (session.closed || !sameLease(lease, session.lease)) throw new Error("OFFICE_NATIVE_CLOSED");
		const result = (async () => {
			const combined = AbortSignal.any([signal, session.run.signal]);
			await session.run.assertActive(combined);
			if (session.guest.ended?.()) {
				if ((session.reopenAfter ?? 0) > performance.now()) throw new Error("OFFICE_SESSION_CLOSED");
				await cloudToolRequest(() => this.#reopen(session), combined);
			}
			await session.guest.endpoint.authorize(operation, session.run.identity, lease, combined);
			const content = await session.guest.endpoint.perform(operation, lease, {
				identity: session.run.identity,
				receiptId: receipt.receiptId as string,
				idempotencyKey: receipt.idempotencyKey as string,
				signal: combined,
				...(fill ? { fill } : {}),
			});
			await session.run.assertActive(combined);
			// A screenshot stored nowhere travels in its answer, the only answer that may carry pixels.
			const image =
				operation.tool === "computer_screenshot"
					? session.guest.screenshot?.(receipt.receiptId as string)
					: undefined;
			return {
				schema: COMPANY_COMPUTER_NATIVE_SCHEMA,
				receiptId: receipt.receiptId,
				idempotencyKey: receipt.idempotencyKey,
				content,
				...(image ? { image: Buffer.from(image).toString("base64") } : {}),
			};
		})();
		session.active.add(result);
		try {
			return await result;
		} finally {
			session.active.delete(result);
		}
	}

	async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const authorization = Buffer.from(request.headers.authorization ?? "");
		if (
			this.#stop.signal.aborted ||
			this.#inflight >= 32 ||
			request.method !== "POST" ||
			request.url !== `/office/${this.#scope.companyComputerId}/native` ||
			request.headers.origin !== undefined ||
			request.headers["content-type"] !== "application/json" ||
			authorization.length !== this.#token.length ||
			!timingSafeEqual(authorization, this.#token)
		) {
			response.writeHead(403, { "cache-control": "no-store", connection: "close" });
			response.end();
			return;
		}
		this.#inflight++;
		const stop = new AbortController();
		const aborted = (): void => {
			if (!response.writableFinished) stop.abort();
		};
		request.once("aborted", aborted);
		response.once("close", aborted);
		try {
			const result = await cloudToolRequest(
				async (signal) => {
					this.#admit();
					const chunks: Buffer[] = [];
					let length = 0;
					const body = await cloudToolRequest(async (s) => {
						for await (const chunk of request) {
							s.throwIfAborted();
							const bytes = Buffer.from(chunk);
							length += bytes.length;
							if (length > COMPANY_COMPUTER_NATIVE_MAX_REQUEST)
								throw new Error("OFFICE_NATIVE_REQUEST_TOO_LARGE");
							chunks.push(bytes);
						}
						return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
					}, signal);
					this.#admit();
					return this.#dispatch(body, request.headers["x-qorpera-identity"], signal);
				},
				AbortSignal.any([stop.signal, this.#stop.signal]),
				25000,
			);
			const bytes = Buffer.from(JSON.stringify(result));
			if (
				bytes.length >
				(result && typeof result === "object" && "image" in result
					? COMPANY_COMPUTER_NATIVE_MAX_SCREENSHOT_RESPONSE
					: COMPANY_COMPUTER_NATIVE_MAX_RESPONSE)
			)
				throw new Error("OFFICE_NATIVE_RESPONSE_TOO_LARGE");
			response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
			response.end(bytes);
		} catch {
			stop.abort();
			if (!response.headersSent && !response.destroyed) {
				response.writeHead(503, { "cache-control": "no-store", connection: "close" });
				response.end();
			}
		} finally {
			request.off("aborted", aborted);
			response.off("close", aborted);
			this.#inflight--;
		}
	}
	async close(): Promise<void> {
		this.#stop.abort();
		this.#token.fill(0);
		const results = await cloudToolRequest(
			() =>
				Promise.allSettled(
					[...this.#sessions.entries()].map(async ([key, pending]) => {
						try {
							await this.#close(await pending);
						} catch (error) {
							if (this.#sessions.has(key)) throw error;
						}
					}),
				),
			new AbortController().signal,
			25000,
		);
		if (results.some((result) => result.status === "rejected")) throw new Error("OFFICE_NATIVE_DRAIN_UNCONFIRMED");
	}
}

export async function startCompanyComputerNativeGateway(options: {
	host: string;
	port: number;
	tls: { cert: Buffer; key: Buffer };
	gateway: CompanyComputerNativeGateway;
	/** Service owner stops sibling listeners and physical resources. */
	onFailure?: () => void;
}): Promise<{ port: number; close(): Promise<void> }> {
	if (
		!options.host ||
		/[\s/]/.test(options.host) ||
		!Number.isSafeInteger(options.port) ||
		options.port < 0 ||
		options.port > 65535 ||
		!options.tls.cert.length ||
		!options.tls.key.length
	)
		throw new Error("INVALID_OFFICE_NATIVE_TLS");
	const sockets = new Set<Duplex>();
	const server = createServer(
		{ ...options.tls, minVersion: "TLSv1.3", handshakeTimeout: 5000 },
		(request, response) => {
			void options.gateway.handle(request, response).catch(() => response.destroy());
		},
	);
	server.maxConnections = 64;
	server.maxHeadersCount = 32;
	server.headersTimeout = 5000;
	server.requestTimeout = 10000;
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	server.on("clientError", (_error, socket) => socket.destroy());
	server.on("tlsClientError", (_error, socket) => socket.destroy());
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, options.host, () => {
			server.off("error", reject);
			resolve();
		});
	});
	server.on("error", () => {
		for (const socket of sockets) socket.destroy();
		options.onFailure?.();
		void options.gateway.close().catch(() => undefined);
	});
	const address = server.address();
	return {
		port: typeof address === "object" && address ? address.port : options.port,
		close: async () => {
			const closing = new Promise<void>((resolve) => server.close(() => resolve()));
			for (const socket of sockets) socket.destroy();
			try {
				await options.gateway.close();
			} finally {
				await closing;
			}
		},
	};
}
