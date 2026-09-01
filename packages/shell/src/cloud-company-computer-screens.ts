import { connect } from "node:net";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import {
	assertCompanyComputerScope,
	assertCompanyComputerScreenBinding,
	type CompanyComputerScope,
	type CompanyComputerScreenBinding,
	companyComputerRequest,
} from "./cloud-company-computer-contract.ts";
import {
	assertCompanyComputerScreenRegistry,
	type CompanyComputerScreenRegistry,
	companyComputerScreenBinding,
} from "./cloud-company-computer-state.ts";

/** TigerVNC display/port convention reused from codex/step3-remaining-ops. */
export function companyComputerScreenDisplay(ordinal: number): string {
	if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 32) throw new Error("INVALID_SCREEN_ORDINAL");
	return `:${ordinal}`;
}

export function companyComputerScreenVncPort(ordinal: number): number {
	companyComputerScreenDisplay(ordinal);
	return 5_900 + ordinal;
}

export interface CompanyComputerScreenSessionHandle {
	/** Xvnc AND XFCE are ready, not just a successfully spawned wrapper process. */
	ready: Promise<void>;
	/** Resolves only after the supervisor confirms the entire service is reaped. */
	exited: Promise<void>;
	/** Must stop and reap the entire desktop process group before resolving. */
	stop(): Promise<void>;
}

export interface CompanyComputerScreenLauncher {
	/** Guest-only launcher; reuse the image's qorpera-screen-session wrapper and supervisor. */
	launch(binding: CompanyComputerScreenBinding, signal: AbortSignal): Promise<CompanyComputerScreenSessionHandle>;
}

interface ManagedScreen {
	binding: CompanyComputerScreenBinding;
	session: CompanyComputerScreenSessionHandle;
	ready: boolean;
}

/**
 * Adapted from the historical CloudCompanyComputerScreenManager. Registry state
 * survives service/VM replacement; no process id or stale local attachment is
 * authoritative. A failed display is retried on the next reconcile. Authority
 * outages may preserve pixels, but the independently expiring input leases stop
 * ALL agent/member actions. Never infer an open screen from missing state.
 */
export class CloudCompanyComputerScreenManager {
	readonly #scope: CompanyComputerScope;
	readonly #launcher: CompanyComputerScreenLauncher;
	readonly #sessions = new Map<number, ManagedScreen>();
	readonly #stop = new AbortController();
	#pending: Promise<void> = Promise.resolve();
	#revision = 0;
	#computerGeneration = 0;
	#snapshot?: CompanyComputerScreenRegistry;

	constructor(scope: CompanyComputerScope, launcher: CompanyComputerScreenLauncher) {
		assertCompanyComputerScope(scope, scope);
		this.#scope = Object.freeze({ ...scope });
		this.#launcher = launcher;
	}

	liveVncPort(binding: CompanyComputerScreenBinding): number | undefined {
		assertCompanyComputerScope(binding, this.#scope);
		const live = this.#sessions.get(binding.screenOrdinal);
		if (!live?.ready) return undefined;
		try {
			assertCompanyComputerScreenBinding(binding, live.binding);
		} catch {
			return undefined;
		}
		return companyComputerScreenVncPort(binding.screenOrdinal);
	}

	liveOrdinals(): number[] {
		return [...this.#sessions]
			.filter(([, value]) => value.ready)
			.map(([ordinal]) => ordinal)
			.sort((a, b) => a - b);
	}

	reconcile(snapshot: CompanyComputerScreenRegistry, signal: AbortSignal): Promise<void> {
		const registry = structuredClone(snapshot);
		assertCompanyComputerScreenRegistry(registry);
		assertCompanyComputerScope(registry.scope, this.#scope);
		const combined = AbortSignal.any([signal, this.#stop.signal]);
		const work = this.#pending.then(async () => {
			combined.throwIfAborted();
			if (
				registry.revision < this.#revision ||
				registry.computerGeneration < this.#computerGeneration ||
				(registry.revision === this.#revision && !isDeepStrictEqual(registry, this.#snapshot))
			) {
				throw new Error("STALE_SCREEN_REGISTRY");
			}
			this.#revision = registry.revision;
			this.#computerGeneration = registry.computerGeneration;
			this.#snapshot = registry;
			const desired = new Map(
				registry.screens
					.filter(
						(screen) =>
							registry.lifecycle === "active" &&
							screen.status === "active" &&
							screen.power === "open" &&
							screen.staffAgentId !== null,
					)
					.map((screen) => [screen.ordinal, companyComputerScreenBinding(registry, screen)]),
			);
			for (const [ordinal, live] of this.#sessions) {
				const expected = desired.get(ordinal);
				let matches = expected !== undefined;
				if (expected) {
					try {
						assertCompanyComputerScreenBinding(live.binding, expected);
					} catch {
						matches = false;
					}
				}
				if (matches && live.ready) continue;
				live.ready = false;
				// Do not remove a still-running process after failed shutdown: it remains quarantined.
				await live.session.stop();
				if (this.#sessions.get(ordinal) === live) this.#sessions.delete(ordinal);
			}
			const failures: unknown[] = [];
			for (const [ordinal, binding] of desired) {
				combined.throwIfAborted();
				if (this.#sessions.has(ordinal)) continue;
				try {
					const session = await this.#launcher.launch(binding, combined);
					const live: ManagedScreen = { binding, session, ready: false };
					this.#sessions.set(ordinal, live);
					void session.exited.then(
						() => {
							if (this.#sessions.get(ordinal) === live) this.#sessions.delete(ordinal);
						},
						() => {
							live.ready = false;
						},
					);
					try {
						await companyComputerRequest(() => session.ready, combined, 15_000);
						combined.throwIfAborted();
						if (this.#sessions.get(ordinal) !== live) throw new Error("SCREEN_EXITED_DURING_START");
						live.ready = true;
					} catch (error) {
						await session.stop();
						if (this.#sessions.get(ordinal) === live) this.#sessions.delete(ordinal);
						throw error;
					}
				} catch (error) {
					failures.push(error);
				}
			}
			if (failures.length > 0) throw new AggregateError(failures, "SCREEN_START_FAILED");
		});
		this.#pending = work.catch(() => undefined);
		return work;
	}

	async stopAll(): Promise<void> {
		this.#stop.abort();
		await this.#pending;
		const failures: unknown[] = [];
		for (const [ordinal, live] of this.#sessions) {
			live.ready = false;
			try {
				await live.session.stop();
				if (this.#sessions.get(ordinal) === live) this.#sessions.delete(ordinal);
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length) throw new AggregateError(failures, "SCREEN_STOP_FAILED");
	}
}

/** Bounded loopback probe, including socket cancellation. A random listening port is not a ready screen. */
export async function waitForCompanyComputerScreenReady(
	port: number,
	signal: AbortSignal,
	timeoutMs = 10_000,
): Promise<void> {
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
		throw new Error("INVALID_SCREEN_PROBE");
	}
	const started = performance.now();
	await companyComputerRequest(
		async (requestSignal) => {
			while (performance.now() - started < timeoutMs) {
				requestSignal.throwIfAborted();
				const ready = await new Promise<boolean>((resolve) => {
					const socket = connect({ host: "127.0.0.1", port });
					let received = Buffer.alloc(0);
					const finish = (value: boolean): void => {
						requestSignal.removeEventListener("abort", abort);
						socket.destroy();
						resolve(value);
					};
					const abort = (): void => finish(false);
					requestSignal.addEventListener("abort", abort, { once: true });
					socket.on("data", (bytes: Buffer) => {
						received = Buffer.concat([received, bytes]);
						if (received.length >= 12) finish(received.subarray(0, 12).toString("ascii") === "RFB 003.008\n");
					});
					socket.once("error", () => finish(false));
					socket.once("end", () => finish(false));
					socket.setTimeout(Math.min(500, timeoutMs), () => finish(false));
				});
				if (ready) return;
				await new Promise<void>((resolve) => {
					const done = (): void => {
						clearTimeout(timer);
						requestSignal.removeEventListener("abort", done);
						resolve();
					};
					const timer = setTimeout(done, 100);
					requestSignal.addEventListener("abort", done, { once: true });
					if (requestSignal.aborted) done();
				});
			}
			throw new Error("SCREEN_NOT_READY");
		},
		signal,
		timeoutMs,
	);
}
