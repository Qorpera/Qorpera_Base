import type { JsonValue } from "@qorpera/contracts";

export const COMPANY_COMPUTER_TOOL_VERSION = "qorpera.company-computer-tools/v2";
export const COMPANY_COMPUTER_MAX_LEASE_MS = 30_000;
export const COMPANY_COMPUTER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Cloud registry identities, never model arguments or a hostname supplied by a member. */
export interface CompanyComputerScope {
	readonly companyId: string;
	readonly environmentId: string;
	readonly companyComputerId: string;
	readonly logicalComputerId: string;
}

export interface CompanyComputerScreenBinding extends CompanyComputerScope {
	readonly computerGeneration: number;
	readonly screenId: string;
	readonly screenOrdinal: number;
	readonly screenGeneration: number;
	readonly staffAgentId: string;
}

export type CompanyComputerDriver =
	| { readonly kind: "agent"; readonly runId: string; readonly staffAgentId: string }
	| { readonly kind: "member"; readonly memberId: string; readonly sessionId: string };

export interface CompanyComputerScreenLease {
	readonly binding: CompanyComputerScreenBinding;
	readonly leaseId: string;
	readonly epoch: number;
	readonly driver: CompanyComputerDriver;
	/** Remaining server time, bounded by screen, run, member and grant expiry. */
	readonly validForMs: number;
}

/** A projection of Step 2 CloudNativeToolIdentity, not a new principal or credential system. */
export interface CompanyComputerRunIdentity {
	readonly companyId: string;
	readonly environmentId: string;
	readonly runId: string;
	readonly staffAgentId: string;
	readonly requesterUserId: string;
}

/** Structural adapter for Step 2 CloudNativeToolRun. No implementation or permissive default here. */
export interface CompanyComputerRun {
	readonly identity: CompanyComputerRunIdentity;
	readonly signal: AbortSignal;
	assertActive(signal: AbortSignal): Promise<void>;
}

export type CompanyComputerToolContent = { kind: "text"; value: string } | { kind: "json"; value: JsonValue };

/** Matches Step 2 CloudNativeToolOperations.execute. The existing ledger owns retries and ambiguity. */
export interface CompanyComputerOperation {
	readonly tool: string;
	readonly toolVersion: string;
	readonly logicalOperationKey: string;
	readonly arguments: JsonValue;
	readonly target: { [key: string]: JsonValue };
	readonly requiresCompanyRevision: boolean;
}

export interface CompanyComputerEffectContext {
	identity: CompanyComputerRunIdentity;
	receiptId: string;
	idempotencyKey: string;
	signal: AbortSignal;
}

export interface CompanyComputerOperations {
	execute(options: {
		operation: CompanyComputerOperation;
		authorize: (
			operation: CompanyComputerOperation,
			identity: CompanyComputerRunIdentity,
			signal: AbortSignal,
		) => Promise<void>;
		perform: (
			operation: CompanyComputerOperation,
			context: CompanyComputerEffectContext,
		) => Promise<{ content: CompanyComputerToolContent }>;
		signal: AbortSignal;
	}): Promise<CompanyComputerToolContent>;
}

/** Compatible with Step 2 CloudNativeTool; the host wraps ALL results and failures as untrusted data. */
export interface CompanyComputerTool {
	readonly name: string;
	readonly description: string;
	readonly source: "runtime";
	readonly inputSchema: { [key: string]: JsonValue };
	parseArguments(value: JsonValue): JsonValue;
	execute(
		value: JsonValue,
		context: { readonly companyId: string; readonly runId: string; readonly signal: AbortSignal },
	): Promise<CompanyComputerToolContent>;
}

export function assertCompanyComputerScope(actual: CompanyComputerScope, expected: CompanyComputerScope): void {
	for (const key of ["companyId", "environmentId", "companyComputerId", "logicalComputerId"] as const) {
		if (!COMPANY_COMPUTER_UUID.test(actual[key]) || actual[key] !== expected[key]) {
			throw new Error("COMPUTER_BINDING_MISMATCH");
		}
	}
}

export function assertCompanyComputerScreenBinding(
	actual: CompanyComputerScreenBinding,
	expected: CompanyComputerScreenBinding,
): void {
	assertCompanyComputerScope(actual, expected);
	for (const key of ["screenId", "staffAgentId"] as const) {
		if (!COMPANY_COMPUTER_UUID.test(actual[key]) || actual[key] !== expected[key]) {
			throw new Error("SCREEN_BINDING_MISMATCH");
		}
	}
	for (const key of ["computerGeneration", "screenGeneration", "screenOrdinal"] as const) {
		if (!Number.isSafeInteger(actual[key]) || actual[key] < 1 || actual[key] !== expected[key]) {
			throw new Error("SCREEN_BINDING_MISMATCH");
		}
	}
	if (actual.screenOrdinal > 32) throw new Error("SCREEN_BINDING_MISMATCH");
}

export function sameCompanyComputerDriver(left: CompanyComputerDriver, right: CompanyComputerDriver): boolean {
	return left.kind === "agent"
		? right.kind === "agent" && left.runId === right.runId && left.staffAgentId === right.staffAgentId
		: right.kind === "member" && left.memberId === right.memberId && left.sessionId === right.sessionId;
}

export function assertCompanyComputerDriver(driver: CompanyComputerDriver): void {
	if (
		(driver.kind === "agent" &&
			COMPANY_COMPUTER_UUID.test(driver.runId) &&
			COMPANY_COMPUTER_UUID.test(driver.staffAgentId)) ||
		(driver.kind === "member" &&
			COMPANY_COMPUTER_UUID.test(driver.memberId) &&
			COMPANY_COMPUTER_UUID.test(driver.sessionId))
	)
		return;
	throw new Error("INVALID_SCREEN_DRIVER");
}

export function assertCompanyComputerLease(
	lease: CompanyComputerScreenLease,
	expected: CompanyComputerScreenBinding,
	driver: CompanyComputerDriver,
): void {
	assertCompanyComputerScreenBinding(lease.binding, expected);
	assertCompanyComputerDriver(lease.driver);
	if (
		!COMPANY_COMPUTER_UUID.test(lease.leaseId) ||
		!Number.isSafeInteger(lease.epoch) ||
		lease.epoch < 1 ||
		!Number.isSafeInteger(lease.validForMs) ||
		lease.validForMs < 1 ||
		lease.validForMs > COMPANY_COMPUTER_MAX_LEASE_MS ||
		!sameCompanyComputerDriver(lease.driver, driver) ||
		(driver.kind === "agent" && driver.staffAgentId !== expected.staffAgentId)
	)
		throw new Error("INVALID_SCREEN_LEASE");
}

/** Trusted guest preflight rejection: no navigation, input, shell or asset effect was dispatched. */
export class CompanyComputerActionNotStartedError extends Error {
	constructor(
		message:
			| "BROWSER_TARGET_AMBIGUOUS"
			| "BROWSER_TAB_AMBIGUOUS"
			| "BROWSER_TAB_UNAVAILABLE"
			| "BROWSER_TARGET_CLOSED",
	) {
		super(message);
		this.name = "CompanyComputerActionNotStartedError";
	}
}

/** Bounded component I/O; this does not authorize an operation or cancel remote effects by itself. */
export function companyComputerRequest<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	signal: AbortSignal,
	timeoutMs = 5_000,
): Promise<T> {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
		return Promise.reject(new Error("INVALID_COMPUTER_TIMEOUT"));
	}
	const stop = new AbortController();
	const combined = AbortSignal.any([signal, stop.signal]);
	const timer = setTimeout(() => stop.abort(), timeoutMs);
	let abort = (): void => {};
	return new Promise<T>((resolve, reject) => {
		abort = (): void => reject(new Error("COMPUTER_REQUEST_STOPPED"));
		combined.addEventListener("abort", abort, { once: true });
		if (combined.aborted) abort();
		else
			Promise.resolve()
				.then(() => {
					combined.throwIfAborted();
					return operation(combined);
				})
				.then(resolve, reject);
	}).finally(() => {
		clearTimeout(timer);
		combined.removeEventListener("abort", abort);
	});
}
