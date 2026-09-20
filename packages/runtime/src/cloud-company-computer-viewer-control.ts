import { createHash, createHmac, type Hmac, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
	assertCompanyComputerScope,
	type CompanyComputerScope,
	companyComputerRequest,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import {
	type CompanyComputerViewerGrant,
	parseCompanyComputerViewerGrant,
} from "@qorpera/cloud-client/cloud-company-computer-viewer";
import { COMPANY_COMPUTER_VIEW_TOKEN } from "@qorpera/cloud-client/node/company-computer-view-protocol";
import type { CompanyComputerViewerAuthority } from "./cloud-company-computer-viewer-gateway.ts";

export interface CompanyComputerViewerRegistry {
	call(
		method:
			| "qorpera_redeem_runtime_office_viewer"
			| "qorpera_check_runtime_office_viewer"
			| "qorpera_admit_runtime_office_viewer_input_window"
			| "qorpera_release_runtime_office_viewer",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}

/** The registry never confirms a longer input window; one second is the bound
 * the contract already accepts for the browser egress relay's re-check. */
export const COMPANY_COMPUTER_VIEWER_INPUT_WINDOW_MS = 1_000;
/** Hard bound on one ledger row. The gateway renews well before reaching it. */
export const COMPANY_COMPUTER_VIEWER_INPUT_WINDOW_PACKETS = 4_096;

/** One ledger row: a contiguous sequence range and the keyed chain over its
 * per-packet commitments. Raw keys and pointer positions never leave memory. */
interface InputWindowReport {
	first: number;
	count: number;
	commitment: string | null;
}
interface ViewerSession {
	grant: CompanyComputerViewerGrant;
	deadline: number;
	key: Buffer;
	sequence: number;
	window?: { first: number; count: number; chain: Hmac };
	previousCommitment: string;
	/** Closed windows whose ledger row is unconfirmed; retried once at release. */
	unreported: InputWindowReport[];
	windowDeadline: number;
	admitting: boolean;
	inputStopped: boolean;
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

/** Per-office trusted gateway adapter. The browser supplies a one-time member
 * ticket, never a cloud service credential or a caller-selected identity. */
export class CloudCompanyComputerViewerControl implements CompanyComputerViewerAuthority {
	readonly #scope: CompanyComputerScope;
	readonly #control: CompanyComputerViewerRegistry;
	readonly #sessions = new Map<string, ViewerSession>();

	constructor(options: { scope: CompanyComputerScope; control: CompanyComputerViewerRegistry }) {
		assertCompanyComputerScope(options.scope, options.scope);
		this.#scope = Object.freeze({ ...options.scope });
		this.#control = options.control;
	}

	#grant(value: unknown, previous?: CompanyComputerViewerGrant): CompanyComputerViewerGrant {
		const grant = parseCompanyComputerViewerGrant(value, previous);
		assertCompanyComputerScope(grant.binding, this.#scope);
		return grant;
	}
	#session(value: CompanyComputerViewerGrant) {
		const grant = this.#grant(value);
		const session = this.#sessions.get(grant.viewerSessionId);
		if (!session || session.deadline <= performance.now()) throw new Error("VIEWER_EXPIRED");
		this.#grant(grant, session.grant);
		return session;
	}

	async redeem(capability: string, signal: AbortSignal): Promise<CompanyComputerViewerGrant> {
		if (!COMPANY_COMPUTER_VIEW_TOKEN.test(capability)) throw new Error("INVALID_VIEWER_TICKET");
		const started = performance.now();
		const result = await companyComputerRequest(
			(s) =>
				this.#control.call(
					"qorpera_redeem_runtime_office_viewer",
					{
						p_scope: this.#scope,
						p_capability_sha256: createHash("sha256").update(capability).digest("hex"),
					},
					s,
				),
			signal,
		);
		const grant = this.#grant(result);
		const deadline = started + grant.validForMs;
		if (deadline <= performance.now() || this.#sessions.has(grant.viewerSessionId))
			throw new Error("VIEWER_TICKET_UNCONFIRMED");
		this.#sessions.set(grant.viewerSessionId, {
			grant: structuredClone(grant),
			deadline,
			key: randomBytes(32),
			sequence: 0,
			previousCommitment: "",
			unreported: [],
			windowDeadline: 0,
			admitting: false,
			inputStopped: false,
		});
		return grant;
	}

	async check(value: CompanyComputerViewerGrant, signal: AbortSignal): Promise<CompanyComputerViewerGrant> {
		const session = this.#session(value);
		const grant = this.#grant(value, session.grant);
		const started = performance.now();
		const result = await companyComputerRequest(
			(s) => this.#control.call("qorpera_check_runtime_office_viewer", { p_grant: grant }, s),
			signal,
		);
		this.#session(grant);
		const next = this.#grant(result, grant);
		if (started + next.validForMs <= performance.now()) throw new Error("VIEWER_EXPIRED");
		session.grant = structuredClone(next);
		session.deadline = started + next.validForMs;
		return next;
	}

	/** Hot path: synchronous and local. Validates one packet, consumes its
	 * sequence and folds its keyed commitment into the open window. Returns the
	 * number of packets in that window. */
	recordInput(value: CompanyComputerViewerGrant, input: { sequence: number; bytes: Uint8Array }): number {
		const grant = this.#grant(value);
		const session = this.#session(grant);
		const bytes = Buffer.from(input.bytes);
		try {
			if (
				(grant.mode !== "control" && grant.mode !== "shared") ||
				!Number.isSafeInteger(input.sequence) ||
				input.sequence !== session.sequence + 1 ||
				!(
					(bytes.length === 8 && bytes[0] === 4 && bytes[1] <= 1 && bytes[2] === 0 && bytes[3] === 0) ||
					(bytes.length === 6 && bytes[0] === 5 && bytes.readUInt16BE(2) < 1920 && bytes.readUInt16BE(4) < 1200)
				)
			)
				throw new Error("INVALID_VIEWER_INPUT");
			// Input is only dispatched under a window the registry confirmed. A
			// refused, failed or lapsed window is never reopened by a late packet.
			if (session.inputStopped || session.windowDeadline <= performance.now())
				throw new Error("VIEWER_INPUT_WINDOW_CLOSED");
			if (session.window && session.window.count >= COMPANY_COMPUTER_VIEWER_INPUT_WINDOW_PACKETS)
				throw new Error("VIEWER_INPUT_WINDOW_FULL");
			// Consume locally before dispatch: a sequence is never forwarded twice.
			session.sequence = input.sequence;
			session.window ??= {
				first: input.sequence,
				count: 0,
				chain: createHmac("sha256", session.key)
					.update("window:")
					.update(session.previousCommitment)
					.update(":")
					.update(String(input.sequence))
					.update(":"),
			};
			// The same keyed per-packet commitment as per-packet admission stored;
			// only the chain over a window's commitments reaches the ledger.
			session.window.chain.update(
				createHmac("sha256", session.key).update(String(input.sequence)).update(":").update(bytes).digest(),
			);
			return ++session.window.count;
		} finally {
			bytes.fill(0);
		}
	}

	/** One registry round trip per window, never per packet. It re-validates
	 * everything per-packet admission validated and records the audit row of the
	 * packets dispatched since the previous call. */
	async admitInputWindow(value: CompanyComputerViewerGrant, signal: AbortSignal): Promise<{ validForMs: number }> {
		const grant = this.#grant(value);
		const session = this.#session(grant);
		if ((grant.mode !== "control" && grant.mode !== "shared") || session.inputStopped || session.admitting)
			throw new Error("INVALID_VIEWER_INPUT");
		// Close the open window before waiting. Packets dispatched while this
		// call is in flight belong to the next window, so the ledger's sequence
		// ranges stay contiguous: the next first sequence is this last plus one.
		const report = this.#closeWindow(session);
		session.admitting = true;
		const started = performance.now();
		try {
			const result = await companyComputerRequest(
				(s) =>
					this.#control.call(
						"qorpera_admit_runtime_office_viewer_input_window",
						this.#windowArgs(grant, report),
						s,
					),
				signal,
				COMPANY_COMPUTER_VIEWER_INPUT_WINDOW_MS,
			);
			// A refusal still recorded the dispatched window; nothing is left to report.
			if (isRecord(result) && Object.keys(result).join() === "state" && result.state === "refused") {
				session.unreported = session.unreported.filter((entry) => entry !== report);
				throw new Error("VIEWER_INPUT_REFUSED");
			}
			if (
				!isRecord(result) ||
				Object.keys(result).sort().join() !== "state,validForMs" ||
				result.state !== "admitted" ||
				!Number.isSafeInteger(result.validForMs) ||
				(result.validForMs as number) < 1 ||
				(result.validForMs as number) > COMPANY_COMPUTER_VIEWER_INPUT_WINDOW_MS
			)
				throw new Error("VIEWER_INPUT_UNCONFIRMED");
			session.unreported = session.unreported.filter((entry) => entry !== report);
			const validForMs = result.validForMs as number;
			if (started + validForMs <= performance.now()) throw new Error("VIEWER_INPUT_UNCONFIRMED");
			this.#session(grant);
			signal.throwIfAborted();
			session.windowDeadline = started + validForMs;
			return { validForMs };
		} catch (error) {
			// Refused, lost or late: this connection dispatches no further input.
			session.inputStopped = true;
			session.windowDeadline = 0;
			throw error;
		} finally {
			session.admitting = false;
		}
	}

	#closeWindow(session: ViewerSession): InputWindowReport {
		const open = session.window;
		session.window = undefined;
		const report: InputWindowReport = open
			? {
					first: open.first,
					count: open.count,
					commitment: open.chain.update(":").update(String(open.count)).digest("hex"),
				}
			: { first: session.sequence + 1, count: 0, commitment: null };
		if (report.commitment) {
			session.previousCommitment = report.commitment;
			session.unreported.push(report);
		}
		return report;
	}
	#windowArgs(grant: CompanyComputerViewerGrant, report: InputWindowReport): Record<string, unknown> {
		return {
			p_grant: grant,
			p_first_sequence: report.first,
			p_count: report.count,
			p_window_commitment: report.commitment,
		};
	}

	async release(value: CompanyComputerViewerGrant, signal: AbortSignal): Promise<void> {
		const grant = this.#grant(value);
		const session = this.#sessions.get(grant.viewerSessionId);
		this.#sessions.delete(grant.viewerSessionId);
		if (session) {
			// Input dispatched under the last window has no later renewal to carry
			// its audit. Report it before the viewer ends; the registry records a
			// dispatched window even when it refuses further authority. A replayed
			// range is refused there, so an unknown earlier outcome is never doubled.
			session.inputStopped = true;
			this.#closeWindow(session);
			for (const report of session.unreported.splice(0))
				await companyComputerRequest(
					(s) =>
						this.#control.call(
							"qorpera_admit_runtime_office_viewer_input_window",
							this.#windowArgs(grant, report),
							s,
						),
					signal,
					2_000,
				).catch(() => undefined);
			session.key.fill(0);
		}
		const result = await companyComputerRequest(
			(s) => this.#control.call("qorpera_release_runtime_office_viewer", { p_grant: grant }, s),
			signal,
		);
		if (
			!result ||
			typeof result !== "object" ||
			Array.isArray(result) ||
			Object.keys(result).join() !== "state" ||
			!("state" in result) ||
			result.state !== "released"
		)
			throw new Error("VIEWER_RELEASE_UNCONFIRMED");
	}
}
