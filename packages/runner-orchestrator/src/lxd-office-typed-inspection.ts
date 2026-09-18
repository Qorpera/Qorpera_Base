import { randomUUID } from "node:crypto";
import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { type CompanyComputerPreparationCommand, parseCompanyComputerPreparationCommand } from "@qorpera/contracts";
import type { LxdInstanceFile, LxdOperationReference, LxdOperationState } from "./lxd-client.ts";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeCanonical } from "./lxd-office-image-provenance.ts";
import { publish, readRecord } from "./lxd-office-journal-files.ts";

const WINDOW_MS = 5000;
const MAX_INSPECTION_ATTEMPTS = 256;

/** A finite recovery budget also bounds guest nonce files. Do not erase an
 * uncertain operation to reclaim a slot: exhaustion needs explicit reviewed
 * recovery. The supervisor does not issue inspections on normal active ticks. */
async function assertInspectionBudget(
	root: string,
	allocationId: string,
	signal: AbortSignal,
	purpose: InspectionPurpose,
) {
	const prefix = `${purpose}-inspection-${allocationId}-`;
	const attempts = new Set<string>();
	const directory = await opendir(root);
	let count = 0;
	for await (const entry of directory) {
		signal.throwIfAborted();
		if (++count > 4096) throw new Error("inspection journal scan limit");
		if (!entry.name.startsWith(prefix)) continue;
		const match =
			/^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:-accepted)?\.json$/.exec(
				entry.name.slice(prefix.length),
			);
		if (!match || !entry.isFile()) throw new Error("invalid inspection record");
		attempts.add(match[1]);
		if (attempts.size >= MAX_INSPECTION_ATTEMPTS) throw new Error("inspection recovery budget exhausted");
	}
}
type InspectionPurpose = "boot-service" | "boot-service-restart" | "reset-service" | "reset-service-restart";
interface Client {
	submit(
		project: string,
		name: string,
		command: CompanyComputerPreparationCommand,
		inspectionId: string,
		signal: AbortSignal,
	): Promise<LxdOperationReference>;
	inspect(reference: LxdOperationReference, signal: AbortSignal): Promise<LxdOperationState>;
	readInstanceFile(
		project: string,
		name: string,
		path: string,
		limit: number,
		signal: AbortSignal,
	): Promise<LxdInstanceFile>;
}
interface Protocol<Request, Completion> {
	purpose: InspectionPurpose;
	parseRequest(value: unknown): Readonly<Request>;
	parseCompletion(value: unknown, command: CompanyComputerPreparationCommand, request: Request): Readonly<Completion>;
	parseInspection(
		value: unknown,
		inspectionId: string,
		completion: Completion,
		request: Request,
	): { readonly start: Completion };
}
/** A new inspection has one lifetime, including durable dispatch, LXD exec,
 * polling, protected readback and its consumer's SQL transition. Retained
 * operations cannot be reopened to manufacture freshness. A replacement
 * provider issues a new read-only inspection; it never retries a start.
 * The lifecycle supervisor must serialize this with all other phases and hold
 * the kernel lock. authorize must recheck that lock, physical/cloud authority,
 * boot and retained configuration without replaying preparation or copying. */
export class LxdOfficeTypedInspectionControl<Request, Completion> {
	readonly #root: string;
	readonly #binding: LxdOfficeGuestBinding;
	readonly #client: Client;
	readonly #protocol: Protocol<Request, Completion>;
	#busy = false;
	constructor(root: string, binding: LxdOfficeGuestBinding, client: Client, protocol: Protocol<Request, Completion>) {
		this.#protocol = protocol;
		this.#root = root;
		this.#binding = lxdOfficeGuestPlan(binding).binding;
		this.#client = client;
	}
	async inspectAndUse<T>(
		commandValue: CompanyComputerPreparationCommand,
		requestValue: Request,
		completionValue: Completion,
		authorize: (signal: AbortSignal) => Promise<AbortSignal>,
		use: (
			completion: Readonly<Completion>,
			signal: AbortSignal,
			assertFresh: () => void,
			deadline: number,
		) => Promise<T>,
		caller: AbortSignal,
		settle = false,
	): Promise<T> {
		caller.throwIfAborted();
		if (this.#busy)
			throw new Error(`OFFICE_${this.#protocol.purpose.replaceAll("-", "_").toUpperCase()}_INSPECTION_PENDING`);
		const command = parseCompanyComputerPreparationCommand(commandValue);
		const request = this.#protocol.parseRequest(requestValue);
		const completion = this.#protocol.parseCompletion(completionValue, command, request);
		this.#busy = true;
		const signal = AbortSignal.any([caller, AbortSignal.timeout(WINDOW_MS)]);
		const started = performance.now();
		const fresh = () => {
			signal.throwIfAborted();
			const elapsed = performance.now() - started;
			if (elapsed < 0 || elapsed >= WINDOW_MS) throw new Error("inspection expired");
		};
		let abort = () => {};
		const stopped = new Promise<never>((_resolve, reject) => {
			abort = () =>
				reject(
					new Error(`OFFICE_${this.#protocol.purpose.replaceAll("-", "_").toUpperCase()}_INSPECTION_UNCONFIRMED`),
				);
			signal.addEventListener("abort", abort, { once: true });
		});
		const operation = (async () => {
			let retainedAuthority = signal;
			const checked = async () => {
				fresh();
				retainedAuthority.throwIfAborted();
				const authority = AbortSignal.any([retainedAuthority, await authorize(signal)]);
				retainedAuthority = authority;
				fresh();
				authority.throwIfAborted();
				return authority;
			};
			const inspectionId = randomUUID();
			if (inspectionId === command.commandId) throw new Error("nonce collision");
			const prefix = `${this.#protocol.purpose}-inspection-${this.#binding.allocationId}-${inspectionId}`;
			const dispatch = {
				schema: `qorpera.lxd-office-${this.#protocol.purpose}-inspection-dispatch/v1`,
				binding: this.#binding,
				inspectionId,
				command,
				completion,
			};
			await checked();
			await assertInspectionBudget(this.#root, this.#binding.allocationId, signal, this.#protocol.purpose);
			fresh();
			if (!(await publish(this.#root, `${prefix}.json`, Buffer.from(officeCanonical(dispatch)))))
				throw new Error("inspection already dispatched");
			const verifyDispatch = async () => {
				fresh();
				if (!isDeepStrictEqual((await readRecord(join(this.#root, `${prefix}.json`))).value, dispatch))
					throw new Error("dispatch changed");
				return checked();
			};
			const name = lxdOfficeGuestPlan(this.#binding).request.name;
			const reference = await this.#client.submit(
				this.#binding.project,
				name,
				command,
				inspectionId,
				await verifyDispatch(),
			);
			if (
				!isDeepStrictEqual(reference, {
					project: this.#binding.project,
					instanceName: name,
					operationId: reference.operationId,
				}) ||
				typeof reference.operationId !== "string" ||
				!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(reference.operationId)
			)
				throw new Error("operation differs");
			// Retain acceptance even if cancellation arrived with the response.
			if (
				!(await publish(
					this.#root,
					`${prefix}-accepted.json`,
					Buffer.from(
						officeCanonical({
							schema: `qorpera.lxd-office-${this.#protocol.purpose}-inspection-accepted/v1`,
							inspectionId,
							reference,
						}),
					),
				))
			)
				throw new Error("acceptance changed");
			for (;;) {
				const state = await this.#client.inspect(reference, await verifyDispatch());
				fresh();
				if (state === "succeeded") break;
				if (state !== "pending") throw new Error("inspection failed");
				await delay(50, undefined, { signal });
			}
			const file = await this.#client.readInstanceFile(
				this.#binding.project,
				name,
				`/run/qorpera-office-preparation/${this.#protocol.purpose}-inspection-${inspectionId}.json`,
				16384,
				await verifyDispatch(),
			);
			fresh();
			if (file.uid !== 0 || file.gid !== 0 || file.mode !== 0o600) throw new Error("inspection custody");
			const observation = this.#protocol.parseInspection(
				JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(file.content)),
				inspectionId,
				completion,
				request,
			);
			const authority = await verifyDispatch();
			fresh();
			const assertFresh = () => {
				fresh();
				authority.throwIfAborted();
			};
			const result = await use(observation.start, authority, assertFresh, started + WINDOW_MS);
			fresh();
			authority.throwIfAborted();
			return result;
		})()
			.catch((error) => {
				throw new Error(
					`OFFICE_${this.#protocol.purpose.replaceAll("-", "_").toUpperCase()}_INSPECTION_UNCONFIRMED`,
					{ cause: error },
				);
			})
			.finally(() => {
				this.#busy = false;
			});
		try {
			return await Promise.race([operation, stopped]);
		} finally {
			signal.removeEventListener("abort", abort);
			if (settle) await operation.catch(() => {});
		}
	}
}
