import { createHash, createHmac, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
	assertCompanyComputerScope,
	COMPANY_COMPUTER_UUID,
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
			| "qorpera_admit_runtime_office_viewer_input"
			| "qorpera_release_runtime_office_viewer",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}

/** Per-office trusted gateway adapter. The browser supplies a one-time member
 * ticket, never a cloud service credential or a caller-selected identity. */
export class CloudCompanyComputerViewerControl implements CompanyComputerViewerAuthority {
	readonly #scope: CompanyComputerScope;
	readonly #control: CompanyComputerViewerRegistry;
	readonly #sessions = new Map<
		string,
		{ grant: CompanyComputerViewerGrant; deadline: number; key: Buffer; sequence: number }
	>();

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

	async forwardInput(
		value: CompanyComputerViewerGrant,
		input: { sequence: number; sha256: string; bytes: Uint8Array },
		forward: () => void,
		signal: AbortSignal,
	): Promise<void> {
		const grant = this.#grant(value);
		const session = this.#session(grant);
		const bytes = Buffer.from(input.bytes);
		try {
			if (
				(grant.mode !== "control" && grant.mode !== "shared") ||
				!Number.isSafeInteger(input.sequence) ||
				input.sequence !== session.sequence + 1 ||
				createHash("sha256").update(bytes).digest("hex") !== input.sha256 ||
				!(
					(bytes.length === 8 && bytes[0] === 4 && bytes[1] <= 1 && bytes[2] === 0 && bytes[3] === 0) ||
					(bytes.length === 6 && bytes[0] === 5 && bytes.readUInt16BE(2) < 1920 && bytes.readUInt16BE(4) < 1200)
				)
			) {
				throw new Error("INVALID_VIEWER_INPUT");
			}
			// Consume locally before waiting too. A lost admission response never
			// causes a duplicate dispatch; closing requires held-input drain.
			session.sequence = input.sequence;
			const started = performance.now();
			const commitment = createHmac("sha256", session.key)
				.update(String(input.sequence))
				.update(":")
				.update(bytes)
				.digest("hex");
			const result = await companyComputerRequest(
				(s) =>
					this.#control.call(
						"qorpera_admit_runtime_office_viewer_input",
						{
							p_grant: grant,
							p_sequence: input.sequence,
							p_input_commitment: commitment,
						},
						s,
					),
				signal,
			);
			if (
				!result ||
				typeof result !== "object" ||
				Array.isArray(result) ||
				Object.keys(result).sort().join() !== "inputId,state,validForMs" ||
				!("state" in result) ||
				result.state !== "admitted" ||
				!("inputId" in result) ||
				typeof result.inputId !== "string" ||
				!COMPANY_COMPUTER_UUID.test(result.inputId) ||
				!("validForMs" in result) ||
				!Number.isSafeInteger(result.validForMs) ||
				(result.validForMs as number) < 1 ||
				(result.validForMs as number) > 5000 ||
				started + (result.validForMs as number) <= performance.now()
			)
				throw new Error("VIEWER_INPUT_UNCONFIRMED");
			this.#session(grant);
			signal.throwIfAborted();
			forward();
		} finally {
			bytes.fill(0);
		}
	}

	async release(value: CompanyComputerViewerGrant, signal: AbortSignal): Promise<void> {
		const grant = this.#grant(value);
		const session = this.#sessions.get(grant.viewerSessionId);
		this.#sessions.delete(grant.viewerSessionId);
		session?.key.fill(0);
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
