import { connect } from "node:net";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
	type CompanyComputerScreenBinding,
	companyComputerRequest,
} from "@qorpera/cloud-client/cloud-company-computer-contract";

/** TigerVNC display/port convention reused from codex/step3-remaining-ops. */
export function companyComputerScreenDisplay(ordinal: number): string {
	if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 32) throw new Error("INVALID_SCREEN_ORDINAL");
	return `:${ordinal}`;
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

/** Bounded private Unix-socket probe, including cancellation. A listening socket is not desktop readiness. */
export async function waitForCompanyComputerScreenReady(
	socketPath: string,
	signal: AbortSignal,
	timeoutMs = 10_000,
): Promise<void> {
	if (
		socketPath !== resolve(socketPath) ||
		Buffer.byteLength(socketPath) > 103 ||
		/[\x00-\x1f\x7f]/.test(socketPath) ||
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1
	) {
		throw new Error("INVALID_SCREEN_PROBE");
	}
	const started = performance.now();
	await companyComputerRequest(
		async (requestSignal) => {
			while (performance.now() - started < timeoutMs) {
				requestSignal.throwIfAborted();
				const ready = await new Promise<boolean>((resolve) => {
					const socket = connect({ path: socketPath });
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
