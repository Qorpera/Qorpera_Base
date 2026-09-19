import type { ChildProcess } from "node:child_process";

export class NativeProcessSettlementError extends Error {
	constructor(options?: ErrorOptions) {
		super("Native process settlement unconfirmed", options);
	}
}

/** Inspect ordinary and aggregate error chains without looping on cyclic causes.
 * An oversized graph is conservatively unconfirmed rather than losing a marker. */
export function hasUnconfirmedNativeProcessSettlement(error: unknown): boolean {
	const pending: unknown[] = [error];
	const seen = new Set<Error>();
	while (pending.length > 0) {
		const current = pending.pop();
		if (!(current instanceof Error) || seen.has(current)) continue;
		if (current instanceof NativeProcessSettlementError) return true;
		seen.add(current);
		if (seen.size > 128) return true;
		pending.push(current.cause);
		if (current instanceof AggregateError) {
			if (current.errors.length > 128) return true;
			pending.push(...current.errors);
		}
	}
	return false;
}

/** A synchronous transport-close failure cannot skip stopping the writer.
 * The transport error survives when settlement/cleanup succeeds. */
export async function closeNativeTransportThenSettle(
	closeTransport: () => void,
	settleAndCleanup: () => Promise<void>,
): Promise<void> {
	try {
		closeTransport();
	} finally {
		await settleAndCleanup();
	}
}

/** For the dedicated PID-namespace supervisor only. Its confirmed termination
 * removes the namespace init and all descendants, including detached sessions. */
export async function stopNativeNamespaceChild(child: ChildProcess, timeoutMs = 2000): Promise<void> {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
		throw new Error("Invalid settlement deadline");
	try {
		child.kill("SIGKILL");
	} catch (error) {
		throw new NativeProcessSettlementError({ cause: error });
	}
	if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
	await new Promise<void>((resolve, reject) => {
		const finish = () => {
			clearTimeout(timer);
			child.removeListener("close", finish);
			resolve();
		};
		const timer = setTimeout(() => {
			child.removeListener("close", finish);
			reject(new NativeProcessSettlementError());
		}, timeoutMs);
		child.once("close", finish);
		if (child.exitCode !== null || child.signalCode !== null) finish();
	});
}
