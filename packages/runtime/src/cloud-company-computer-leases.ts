import { performance } from "node:perf_hooks";
import {
	assertCompanyComputerLease,
	assertCompanyComputerScope,
	assertCompanyComputerScreenBinding,
	CompanyComputerActionNotStartedError,
	type CompanyComputerDriver,
	type CompanyComputerOperation,
	type CompanyComputerRun,
	type CompanyComputerScope,
	type CompanyComputerScreenBinding,
	type CompanyComputerScreenLease,
	companyComputerRequest,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import { companyComputerAuthorityUnanswered } from "./cloud-company-computer-registry-http.ts";

/**
 * Only the authenticated screen registry adapter may emit this after a definitive
 * transaction refusal with no lease admitted. Never translate transport failures,
 * timeouts, revoked authority or a possibly committed claim into this error.
 */
export class CompanyComputerScreenAdmissionRefusedError extends Error {
	constructor(reason: "SCREEN_OCCUPIED" | "SCREEN_CAPACITY_EXHAUSTED") {
		super(reason);
		this.name = "CompanyComputerScreenAdmissionRefusedError";
	}
}

/** Implement with the existing authenticated cloud registry; never expose service credentials to a desktop process. */
export interface CompanyComputerScreenLeaseControl {
	/**
	 * Atomically ensure/open the agent's screen, validate its run and claim one fresh lease.
	 * A definitive occupancy/capacity refusal with no lease admitted may use
	 * CompanyComputerScreenAdmissionRefusedError.
	 */
	acquire(scope: CompanyComputerScope, signal: AbortSignal): Promise<CompanyComputerScreenLease>;
	/** No implicit reacquisition, reassignment or identity substitution on renewal. */
	renew(lease: CompanyComputerScreenLease, signal: AbortSignal): Promise<CompanyComputerScreenLease>;
	check(lease: CompanyComputerScreenLease, signal: AbortSignal): Promise<CompanyComputerScreenLease>;
	/** Exact lease id + epoch cleanup; releasing an old lease cannot clear a new driver's lease. */
	release(lease: CompanyComputerScreenLease, signal: AbortSignal): Promise<void>;
}

/**
 * Replaces the historical DISPLAY-only, best-effort renewal bridge. Failure is
 * terminal for this handle and aborts computer actions; a new tool session must
 * obtain fresh authority. Desktop processes and persistent browser bytes are
 * not destroyed when a run releases occupancy.
 */
export class CompanyComputerScreenLeaseHandle {
	readonly signal: AbortSignal;
	readonly #run: CompanyComputerRun;
	readonly #control: CompanyComputerScreenLeaseControl;
	readonly #stop = new AbortController();
	readonly #driver: CompanyComputerDriver;
	#lease: CompanyComputerScreenLease;
	#deadline = 0;
	#expiry?: ReturnType<typeof setTimeout>;
	#renewal?: ReturnType<typeof setTimeout>;
	#renewAt = 0;
	#renewing = false;
	#refreshing: Promise<void> | undefined;
	#released?: Promise<void>;

	private constructor(
		run: CompanyComputerRun,
		control: CompanyComputerScreenLeaseControl,
		lease: CompanyComputerScreenLease,
	) {
		this.#run = run;
		this.#control = control;
		this.#lease = structuredClone(lease);
		this.#driver = { kind: "agent", runId: run.identity.runId, staffAgentId: run.identity.staffAgentId };
		this.signal = AbortSignal.any([run.signal, this.#stop.signal]);
		this.signal.addEventListener(
			"abort",
			() => {
				clearTimeout(this.#expiry);
				clearTimeout(this.#renewal);
			},
			{ once: true },
		);
	}

	static async acquire(
		run: CompanyComputerRun,
		scope: CompanyComputerScope,
		control: CompanyComputerScreenLeaseControl,
	): Promise<CompanyComputerScreenLeaseHandle> {
		assertCompanyComputerScope(scope, scope);
		if (scope.companyId !== run.identity.companyId || scope.environmentId !== run.identity.environmentId) {
			throw new Error("COMPUTER_RUN_MISMATCH");
		}
		await run.assertActive(run.signal);
		const started = performance.now();
		const lease = await companyComputerRequest((signal) => control.acquire(scope, signal), run.signal);
		assertCompanyComputerScope(lease.binding, scope);
		assertCompanyComputerLease(lease, lease.binding, {
			kind: "agent",
			runId: run.identity.runId,
			staffAgentId: run.identity.staffAgentId,
		});
		const handle = new CompanyComputerScreenLeaseHandle(run, control, lease);
		try {
			handle.#accept(lease, started, true);
			await handle.assertActive(run.signal);
			return handle;
		} catch {
			await handle.close().catch(() => undefined);
			throw new Error("SCREEN_LEASE_UNAVAILABLE");
		}
	}

	get lease(): CompanyComputerScreenLease {
		return structuredClone(this.#lease);
	}

	#assertDeadline(): void {
		this.signal.throwIfAborted();
		if (performance.now() >= this.#deadline) {
			this.#stop.abort();
			throw new Error("SCREEN_LEASE_EXPIRED");
		}
	}

	#accept(lease: CompanyComputerScreenLease, started: number, renewed: boolean): void {
		this.signal.throwIfAborted();
		assertCompanyComputerLease(lease, this.#lease.binding, this.#driver);
		if (
			lease.leaseId !== this.#lease.leaseId ||
			lease.epoch !== this.#lease.epoch ||
			started + lease.validForMs <= performance.now()
		) {
			throw new Error("SCREEN_LEASE_CHANGED");
		}
		this.#lease = structuredClone(lease);
		this.#deadline = started + lease.validForMs;
		clearTimeout(this.#expiry);
		clearTimeout(this.#renewal);
		this.#expiry = setTimeout(() => this.#stop.abort(), Math.max(1, this.#deadline - performance.now()));
		const now = performance.now();
		const desiredRenewAt = now + Math.min(10_000, (this.#deadline - now) / 2);
		// A check can shorten validity but cannot postpone an already scheduled
		// renewal. Only a positively confirmed renewal starts a new interval.
		this.#renewAt = renewed ? desiredRenewAt : Math.min(this.#renewAt, desiredRenewAt);
		this.#renewal = setTimeout(
			() => {
				void this.#refresh(true, this.signal).catch(() => undefined);
			},
			Math.max(1, this.#renewAt - performance.now()),
		);
	}

	async #refresh(renew: boolean, signal: AbortSignal): Promise<void> {
		const combined = AbortSignal.any([signal, this.signal]);
		if (this.#refreshing) {
			const refreshing = this.#refreshing;
			const renewing = this.#renewing;
			await companyComputerRequest(() => refreshing, combined);
			this.#assertDeadline();
			// Joining a check proves current validity; it does not perform the
			// renewal that became due while the check was in flight.
			if (renew && !renewing) return this.#refresh(true, signal);
			return;
		}
		this.#renewing = renew;
		this.#refreshing = (async () => {
			this.#assertDeadline();
			await this.#run.assertActive(combined);
			this.#assertDeadline();
			const started = performance.now();
			const lease = await companyComputerRequest(
				(requestSignal) =>
					renew ? this.#control.renew(this.lease, requestSignal) : this.#control.check(this.lease, requestSignal),
				combined,
			);
			this.#assertDeadline();
			this.#accept(lease, started, renew);
		})();
		try {
			await this.#refreshing;
		} catch {
			this.#stop.abort();
			throw new Error("SCREEN_LEASE_UNAVAILABLE");
		} finally {
			this.#refreshing = undefined;
		}
	}

	assertActive(signal: AbortSignal): Promise<void> {
		return this.#refresh(false, signal);
	}

	close(): Promise<void> {
		this.#stop.abort();
		this.#released ??= companyComputerRequest(
			(signal) => this.#control.release(this.lease, signal),
			new AbortController().signal,
		);
		return this.#released;
	}
}

interface ActiveScreenAction {
	binding: CompanyComputerScreenBinding;
	epoch: number;
	stop: AbortController;
	drained: Promise<void>;
}

/**
 * The action's own work failed and has ended: a page that did not load in
 * time, a target that never became clickable, a command stopped at its own
 * limit and confirmed exited. Nothing of it is still running. Only the guest
 * automation raises this, around its own calls; the message is the underlying one.
 */
export class CompanyComputerActionFailedError extends Error {
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : "COMPUTER_ACTION_FAILED", { cause });
		this.name = "CompanyComputerActionFailedError";
	}
}

/**
 * The gate returned this failure knowing that nothing of the action is still
 * running and nothing had to be stopped; `cause` is the failure itself. Each
 * is created for one action, so a shared error object can never carry the
 * mark to another. A deadline that passed while the work ran never is one. The
 * caller drains the action's resource after the gate returned, then reports
 * the cause.
 */
export class CompanyComputerActionSettledFailure extends Error {
	constructor(failure: unknown) {
		super(failure instanceof Error ? failure.message : "COMPUTER_ACTION_FAILED", { cause: failure });
		this.name = "CompanyComputerActionSettledFailure";
	}
}

/** A failed shutdown is not proof that effects stopped; retain the physical-slot quarantine. */
export class CompanyComputerActionDrainError extends Error {
	constructor() {
		super("COMPUTER_ACTION_NOT_DRAINED");
	}
}

/**
 * Guest-side single-action interlock, not an executor or work queue. All work
 * runs through injected established automation. A cancelled call that has not
 * actually stopped remains quarantined; timeouts never authorize another driver.
 */
export class CompanyComputerScreenActionGate {
	readonly #active = new Map<string, ActiveScreenAction>();
	readonly #fences = new Map<string, { binding: CompanyComputerScreenBinding; epoch: number }>();
	readonly #replacing = new Set<string>();

	async perform<T>(options: {
		lease: CompanyComputerScreenLease;
		operation: CompanyComputerOperation;
		signal: AbortSignal;
		/** Step 2 exact effect check plus current screen/profile lease, at the guest dispatch boundary. */
		authorize: (signal: AbortSignal) => Promise<void>;
		execute: (signal: AbortSignal) => Promise<T>;
		/** Stop control channels on cancellation/failure; the slot stays occupied until this actually settles. */
		drainOnFailure?: () => Promise<void>;
	}): Promise<T> {
		const { lease } = options;
		assertCompanyComputerLease(lease, lease.binding, lease.driver);
		const key = `${lease.binding.companyComputerId}:${lease.binding.screenOrdinal}`;
		const refuse = (reason: string): never => {
			// Refused before any work: nothing of this action ran.
			throw new CompanyComputerActionSettledFailure(new Error(reason));
		};
		if (this.#replacing.has(key)) refuse("SCREEN_REPLACEMENT_PENDING");
		const fence = this.#fences.get(key);
		if (fence) {
			assertCompanyComputerScreenBinding(lease.binding, fence.binding);
			if (lease.epoch < fence.epoch) refuse("SCREEN_DRIVER_FENCED");
		}
		if (this.#active.has(key)) refuse("SCREEN_ACTION_STILL_RUNNING");
		const stop = new AbortController();
		const signal = AbortSignal.any([options.signal, stop.signal]);
		let finish = (): void => {};
		const active: ActiveScreenAction = {
			binding: structuredClone(lease.binding),
			epoch: lease.epoch,
			stop,
			drained: new Promise<void>((resolve) => {
				finish = resolve;
			}),
		};
		this.#active.set(key, active);
		let stopping: Promise<void> | undefined;
		const stopAutomation = (): void => {
			stopping ??= Promise.resolve().then(() => options.drainOnFailure?.());
			void stopping.catch(() => undefined);
		};
		signal.addEventListener("abort", stopAutomation, { once: true });
		// Keep the actual work promise, not its timeout race, as the drain condition.
		const work = (async () => {
			let phase: "authorize" | "execute" | "result" = "authorize";
			try {
				signal.throwIfAborted();
				await options.authorize(signal);
				signal.throwIfAborted();
				phase = "execute";
				const result = await options.execute(signal);
				phase = "result";
				signal.throwIfAborted();
				await options.authorize(signal);
				signal.throwIfAborted();
				return result;
			} catch (error) {
				// Nothing of this action is still running, and nothing is stopped, when:
				// - its work failed with one of the guest's typed errors (a pre-effect
				//   targeting refusal, or its own page or command work failed and ended)
				//   and its authority, checked again, holds or got no answer;
				// - an authority check outside the work (before it, or the final one)
				//   got no answer: a revocation is a refusal, and is handled below.
				// Such a failure is marked settled, so its resource can be drained.
				// Anything else, refusals and cancellation stop automation and keep
				// the resource for the supervisor.
				let failure = error;
				let settled = false;
				if (
					!signal.aborted &&
					phase === "execute" &&
					(error instanceof CompanyComputerActionNotStartedError ||
						error instanceof CompanyComputerActionFailedError)
				) {
					try {
						await options.authorize(signal);
						signal.throwIfAborted();
						settled = true;
					} catch (authorizationError) {
						failure = authorizationError;
						settled = !signal.aborted && companyComputerAuthorityUnanswered(authorizationError);
						if (!settled) stopAutomation();
					}
				} else if (!signal.aborted && phase !== "execute" && companyComputerAuthorityUnanswered(error)) {
					settled = true;
				} else {
					stopAutomation();
				}
				if (stopping) {
					try {
						await stopping;
					} catch {
						throw new CompanyComputerActionDrainError();
					}
				}
				throw settled ? new CompanyComputerActionSettledFailure(failure) : failure;
			} finally {
				// Stay armed through the final authority check AND any asynchronous drain.
				signal.removeEventListener("abort", stopAutomation);
			}
		})();
		const drained = (): void => {
			if (this.#active.get(key) === active) this.#active.delete(key);
			finish();
		};
		void work.then(drained, (error: unknown) => {
			if (!(error instanceof CompanyComputerActionDrainError)) drained();
		});
		return companyComputerRequest(() => work, signal, lease.validForMs).finally(() => stop.abort());
	}

	/** The control plane may complete a pending takeover only after this acknowledgement. */
	async fence(
		binding: CompanyComputerScreenBinding,
		epoch: number,
		signal: AbortSignal,
	): Promise<{
		computerGeneration: number;
		screenGeneration: number;
		epoch: number;
	}> {
		assertCompanyComputerScreenBinding(binding, binding);
		if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("INVALID_SCREEN_FENCE");
		const key = `${binding.companyComputerId}:${binding.screenOrdinal}`;
		const previous = this.#fences.get(key);
		if (previous) {
			assertCompanyComputerScreenBinding(binding, previous.binding);
			if (epoch < previous.epoch) throw new Error("STALE_SCREEN_FENCE");
		}
		const active = this.#active.get(key);
		if (active) {
			assertCompanyComputerScreenBinding(binding, active.binding);
			if (active.epoch >= epoch) throw new Error("STALE_SCREEN_FENCE");
		}
		this.#fences.set(key, { binding: structuredClone(binding), epoch });
		if (active) {
			active.stop.abort();
			await companyComputerRequest(() => active.drained, signal);
		}
		signal.throwIfAborted();
		return { computerGeneration: binding.computerGeneration, screenGeneration: binding.screenGeneration, epoch };
	}

	/**
	 * Called by the authenticated registry reconciler after close/reassignment or
	 * VM recovery. Never erase fences merely because a new generation arrived.
	 * The supplied supervisor proof must stop/reap the old desktop and browser
	 * control channels; a timeout leaves the old fence installed.
	 */
	async replaceBinding(options: {
		previous: CompanyComputerScreenBinding;
		next: CompanyComputerScreenBinding;
		fenceEpoch: number;
		signal: AbortSignal;
		assertReplacementReady: (signal: AbortSignal) => Promise<void>;
	}): Promise<void> {
		const { previous, next } = options;
		assertCompanyComputerScreenBinding(previous, previous);
		assertCompanyComputerScreenBinding(next, next);
		assertCompanyComputerScope(next, previous);
		if (
			next.screenId !== previous.screenId ||
			next.screenOrdinal !== previous.screenOrdinal ||
			next.computerGeneration < previous.computerGeneration ||
			(next.computerGeneration === previous.computerGeneration && next.screenGeneration <= previous.screenGeneration)
		) {
			throw new Error("INVALID_SCREEN_REPLACEMENT");
		}
		const key = `${next.companyComputerId}:${next.screenOrdinal}`;
		if (this.#replacing.has(key)) throw new Error("SCREEN_REPLACEMENT_PENDING");
		this.#replacing.add(key);
		try {
			await this.fence(previous, options.fenceEpoch, options.signal);
			await companyComputerRequest(options.assertReplacementReady, options.signal);
			options.signal.throwIfAborted();
			const fence = this.#fences.get(key);
			if (this.#active.has(key) || !fence || fence.epoch !== options.fenceEpoch)
				throw new Error("SCREEN_REPLACEMENT_SUPERSEDED");
			assertCompanyComputerScreenBinding(fence.binding, previous);
			this.#fences.set(key, { binding: structuredClone(next), epoch: options.fenceEpoch });
		} finally {
			this.#replacing.delete(key);
		}
	}
}
