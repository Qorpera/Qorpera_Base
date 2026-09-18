import { isDeepStrictEqual } from "node:util";
import {
	type CompanyComputerPreparationCommand,
	type CompanyComputerServiceStopAcknowledgement,
	type CompanyComputerServiceStopInspection,
	type CompanyComputerServiceStopRequest,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerServiceStopAcknowledgement,
	parseCompanyComputerServiceStopChallenge,
	parseCompanyComputerServiceStopCompletion,
	parseCompanyComputerServiceStopInspection,
	parseCompanyComputerServiceStopRequest,
} from "@qorpera/contracts";

export interface LxdOfficeStopRegistry {
	call(
		method:
			| "qorpera_prepare_runtime_office_stop"
			| "qorpera_ack_runtime_office_stop"
			| "qorpera_runtime_office_stop_status",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}
/** Current SQL challenges and physical acknowledgement only. The lifecycle
 * worker supplies independently measured root evidence under its kernel lock.
 * A new monotonic challenge window must cover inspection through ack; metadata
 * recovery after an uncertain ack never repeats stop or extends the window. */
export class LxdOfficeStopControl {
	readonly #request;
	readonly #command;
	readonly #registry: LxdOfficeStopRegistry;
	readonly #deadlines = new Map<string, number>();
	#pending = false;
	#receipt: CompanyComputerServiceStopAcknowledgement | undefined;
	constructor(
		request: CompanyComputerServiceStopRequest,
		command: CompanyComputerPreparationCommand,
		registry: LxdOfficeStopRegistry,
	) {
		this.#request = parseCompanyComputerServiceStopRequest(request);
		this.#command = parseCompanyComputerPreparationCommand(command);
		if (this.#command.bootId !== this.#request.revocation.request.startup.bootId)
			throw new Error("OFFICE_STOP_BOOT_DIFFERS");
		this.#registry = registry;
	}
	prepare(inspectionId: string, caller: AbortSignal) {
		parseCompanyComputerPreparationCommand({ ...this.#command, commandId: inspectionId });
		if (
			inspectionId === this.#command.commandId ||
			this.#receipt ||
			(!this.#deadlines.has(inspectionId) && this.#deadlines.size >= 64)
		)
			throw new Error("OFFICE_STOP_INSPECTION_UNAVAILABLE");
		const started = performance.now();
		return this.#call(
			"qorpera_prepare_runtime_office_stop",
			{
				p_request: this.#request.revocation.request,
				p_command: this.#command,
				p_inspection_id: inspectionId,
				p_start_completion_sha256: this.#request.startCompletionSha256,
			},
			(value) => {
				const challenge = parseCompanyComputerServiceStopChallenge(
					value,
					this.#request,
					this.#command,
					inspectionId,
				);
				const deadline = Math.min(started + challenge.validForMs, this.#deadlines.get(inspectionId) ?? Infinity);
				this.#deadlines.set(inspectionId, deadline);
				const remaining = Math.floor(deadline - performance.now());
				if (remaining < 1) throw new Error("expired");
				return Object.freeze({ ...challenge, validForMs: remaining });
			},
			caller,
		);
	}
	acknowledge(value: CompanyComputerServiceStopInspection, caller: AbortSignal) {
		const completion = parseCompanyComputerServiceStopCompletion(value.stop, this.#command, this.#request),
			inspection = parseCompanyComputerServiceStopInspection(value, value.inspectionId, completion, this.#request);
		const deadline = this.#deadlines.get(inspection.inspectionId);
		if (deadline === undefined || deadline <= performance.now()) throw new Error("OFFICE_STOP_INSPECTION_EXPIRED");
		return this.#call(
			"qorpera_ack_runtime_office_stop",
			{ p_request: this.#request.revocation.request, p_inspection: inspection },
			(value) => {
				const receipt = this.#parseReceipt(value);
				if (!isDeepStrictEqual(receipt.inspection, inspection)) throw new Error("inspection changed");
				this.#receipt = receipt;
				return receipt;
			},
			caller,
			deadline,
		);
	}
	status(caller: AbortSignal) {
		return this.#call(
			"qorpera_runtime_office_stop_status",
			{ p_request: this.#request.revocation.request },
			(value) => {
				if (value === null) {
					if (this.#receipt) throw new Error("acknowledgement lost");
					return null;
				}
				const receipt = this.#parseReceipt(value);
				this.#receipt = receipt;
				return receipt;
			},
			caller,
		);
	}
	#parseReceipt(value: unknown) {
		const receipt = parseCompanyComputerServiceStopAcknowledgement(value, this.#request, this.#command);
		if (this.#receipt && !isDeepStrictEqual(this.#receipt, receipt)) throw new Error("acknowledgement changed");
		return receipt;
	}
	async #call<T>(
		method: Parameters<LxdOfficeStopRegistry["call"]>[0],
		args: Record<string, unknown>,
		parse: (value: unknown) => T,
		caller: AbortSignal,
		deadline = performance.now() + 5000,
	): Promise<T> {
		caller.throwIfAborted();
		if (this.#pending) throw new Error("OFFICE_STOP_REQUEST_PENDING");
		const remaining = Math.ceil(Math.min(5000, deadline - performance.now()));
		if (remaining < 1) throw new Error("OFFICE_STOP_REQUEST_EXPIRED");
		const signal = AbortSignal.any([caller, AbortSignal.timeout(remaining)]);
		this.#pending = true;
		let abort = () => {};
		const stopped = new Promise<never>((_, reject) => {
			abort = () => reject(new Error("OFFICE_STOP_REQUEST_UNCONFIRMED"));
			signal.addEventListener("abort", abort, { once: true });
		});
		const operation = (async () => {
			signal.throwIfAborted();
			const result = await this.#registry.call(method, structuredClone(args), signal);
			signal.throwIfAborted();
			if (performance.now() >= deadline) throw new Error("expired");
			return parse(result);
		})()
			.catch((error) => {
				throw new Error("OFFICE_STOP_REQUEST_UNCONFIRMED", { cause: error });
			})
			.finally(() => {
				this.#pending = false;
			});
		try {
			return await Promise.race([operation, stopped]);
		} finally {
			signal.removeEventListener("abort", abort);
		}
	}
}
