import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PaidComputerHostClock, PaidComputerPrestartRecord } from "./computer-paid-guard.ts";

/** Only public prepare identity is persisted. Lease and executor credentials
 * are supplied separately to the live RPC, never to the guard journal. */
export function computerPrestartRequest(entry: PaidComputerPrestartRecord): Record<string, unknown> {
	const value: unknown = JSON.parse(entry.intent.prepareRequestText);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("COMPUTER_PRESTART_INVALID");
	return value as Record<string, unknown>;
}

export function computerPrestartExpired(entry: PaidComputerPrestartRecord, clock: PaidComputerHostClock): boolean {
	const request = computerPrestartRequest(entry);
	return (
		entry.intent.hostBootId !== clock.hostBootId ||
		clock.uptimeMs < entry.requestStartedUptimeMs ||
		clock.uptimeMs >= entry.requestStartedUptimeMs + Number(request.windowMs)
	);
}

export function computerPrestartDigest(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function assertComputerAbandonmentReceipt(value: unknown, entry: PaidComputerPrestartRecord): void {
	const receipt = value as Record<string, unknown> | null;
	if (
		!receipt ||
		typeof receipt !== "object" ||
		Array.isArray(receipt) ||
		receipt.schema !== "qorpera.computer-abandonment-receipt/v1" ||
		receipt.permitId !== entry.intent.permitId ||
		receipt.state !== "abandoned_before_dispatch" ||
		receipt.debitedUs !== "0" ||
		typeof receipt.releasedUs !== "string" ||
		!/^(0|[1-9][0-9]*)$/.test(receipt.releasedUs) ||
		typeof receipt.reservationReleased !== "boolean" ||
		!entry.abandonment ||
		!isDeepStrictEqual(receipt.abandonment, entry.abandonment)
	)
		throw new Error("COMPUTER_ABANDONMENT_UNCONFIRMED");
}
