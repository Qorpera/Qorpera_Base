import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { PaidComputerGuardPhysical, PaidComputerHostClock, PaidComputerMachine } from "../../packages/runner-orchestrator/src/computer-paid-guard.ts";
import { LxdPaidComputerUsageCapture as OriginalCapture } from "../../packages/runner-orchestrator/src/computer-paid-usage-lxd.ts";
import type { LxdClockClient } from "../../packages/runner-orchestrator/src/lxd-client.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0 ? value : null;
type Phase = "host-before" | "physical-before" | "guest-clock" | "physical-after" | "host-after";
interface Step {
	phase: Phase;
	durationMs: number;
	returned: boolean;
	hostMachineIdSha256: string | null;
	bootId: string | null;
	uptimeMs: number | null;
	state: "running" | "stopped" | "absent" | "other" | null;
}
interface Capture {
	schema: "qorpera.acceptance-guard-capture/v1";
	captureId: string;
	allocationId: string | null;
	physicalId: string | null;
	startedAt: string;
	durationMs: number;
	confirmed: boolean;
	aborted: boolean;
	code: string;
	hostBracketMs: number | null;
	steps: Step[];
}

/** Acceptance-only constructor substitution. The original capture receives the
 * same ports, arguments, signals and returned objects. No diagnostic I/O runs
 * inside its host-clock bracket; neither result nor rejection is replaced. */
export class LxdPaidComputerUsageCapture extends OriginalCapture {
	readonly #context: AsyncLocalStorage<Capture>;
	readonly #report: (capture: Capture) => void;
	readonly #now: () => number;
	constructor(client: LxdClockClient, physical: PaidComputerGuardPhysical, clock: () => Promise<PaidComputerHostClock>,
		options: { report?: (capture: Capture) => void; now?: () => number } = {}) {
		const context = new AsyncLocalStorage<Capture>(), now = options.now ?? (() => performance.now());
		async function phase<T>(name: Phase, call: () => Promise<T>, project: (value: T, step: Step) => void): Promise<T> {
			const record = context.getStore(), started = now();
			const step: Step = { phase: name, durationMs: 0, returned: false, hostMachineIdSha256: null, bootId: null, uptimeMs: null, state: null };
			record?.steps.push(step);
			try { const value = await call(); step.returned = true; try { project(value, step); } catch { /* Diagnostic projection is never authority. */ } return value; }
			finally { step.durationMs = Math.max(0, Math.floor(now() - started)); }
		}
		super({ readInstanceClock: (...args) => phase("guest-clock", () => client.readInstanceClock(...args), (value, step) => {
			step.bootId = UUID.test(value.bootId) ? value.bootId : null; step.uptimeMs = integer(value.uptimeMs);
		}) }, {
			inspect: (...args) => phase(context.getStore()?.steps.some(step => step.phase === "physical-before") ? "physical-after" : "physical-before",
				() => physical.inspect(...args), (value, step) => { step.state = ["running", "stopped", "absent", "other"].includes(value) ? value : null; }),
			start: (...args) => physical.start(...args), startSettled: (...args) => physical.startSettled(...args), stop: (...args) => physical.stop(...args),
		}, () => phase(context.getStore()?.steps.some(step => step.phase === "host-before") ? "host-after" : "host-before", clock, (value, step) => {
			step.hostMachineIdSha256 = SHA.test(value.hostMachineIdSha256) ? value.hostMachineIdSha256 : null;
			step.bootId = UUID.test(value.hostBootId) ? value.hostBootId : null; step.uptimeMs = integer(value.uptimeMs);
		}));
		this.#context = context; this.#now = now;
		this.#report = options.report ?? ((capture) => console.log(JSON.stringify(capture)));
	}
	override async capture(machine: PaidComputerMachine, signal: AbortSignal) {
		const started = this.#now();
		const record: Capture = { schema: "qorpera.acceptance-guard-capture/v1", captureId: randomUUID(),
			allocationId: UUID.test(machine.allocationId) ? machine.allocationId : null,
			physicalId: UUID.test(machine.physicalInstanceId) ? machine.physicalInstanceId : null,
			startedAt: new Date().toISOString(), durationMs: 0, confirmed: false, aborted: false,
			code: "CAPTURE_UNCONFIRMED", hostBracketMs: null, steps: [] };
		return this.#context.run(record, async () => {
			try { const value = await super.capture(machine, signal); record.confirmed = true; return value; }
			finally {
				record.durationMs = Math.max(0, Math.floor(this.#now() - started)); record.aborted = signal.aborted;
				const before = record.steps.find(step => step.phase === "host-before" && step.returned);
				const after = record.steps.find(step => step.phase === "host-after" && step.returned);
				if (before?.uptimeMs !== null && before?.uptimeMs !== undefined && after?.uptimeMs !== null && after?.uptimeMs !== undefined)
					record.hostBracketMs = after.uptimeMs - before.uptimeMs;
				const failed = record.steps.find(step => !step.returned);
				record.code = record.confirmed ? "CONFIRMED" : record.aborted ? "ABORTED" : failed ?
					(failed.phase.startsWith("host-") ? "HOST_CLOCK_FAILED" : failed.phase === "guest-clock" ? "GUEST_CLOCK_FAILED" : "PHYSICAL_INSPECTION_FAILED") :
					[before, after].some(step => step && (step.hostMachineIdSha256 !== machine.hostMachineIdSha256 || step.bootId !== machine.hostBootId)) ? "HOST_IDENTITY_DIFFERS" :
					record.steps.some(step => step.phase.startsWith("physical-") && step.state !== "running") ? "PHYSICAL_NOT_RUNNING" :
					record.hostBracketMs !== null && record.hostBracketMs < 0 ? "HOST_CLOCK_BACKWARD" :
					record.hostBracketMs !== null && record.hostBracketMs > 1000 ? "HOST_BRACKET_EXCEEDED" : "CAPTURE_UNCONFIRMED";
				// Reporting is observational, including when its destination is broken.
				try { this.#report(record); } catch { /* Never change guard authority or the original error. */ }
			}
		});
	}
}
