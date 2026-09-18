import { createHash } from "node:crypto";
import {
	COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
	companyComputerPreparationAdoptionReceipt,
	parseCompanyComputerPreparationRequest,
} from "@qorpera/contracts";
import { expect, vi } from "vitest";
import { LxdOfficePreparationWorker } from "../../src/lxd-office-preparation-worker.ts";
import { officeBootWorkerFixture } from "./office-boot-worker.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const signal = (): AbortSignal => new AbortController().signal;
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
// Real private local journals; explicit synthetic daemon, protected policy,
// kernel and cloud ports. Separate Unix HTTP / Linux probes cover those seams.
export async function officePreparationWorkerFixture(roots: string[], booted = true) {
	const f = await officeBootWorkerFixture(roots);
	if (booted) await f.worker.reconcile(f.request, signal());
	f.submit.mockClear();
	f.file.mockClear();
	f.check.mockClear();
	f.call.mockClear();
	const guest = new Map<string, { content: Buffer; uid: number; gid: number; mode: number }>([
		["/proc/sys/kernel/random/boot_id", { content: Buffer.from(`${id(4)}\n`), uid: 0, gid: 0, mode: 0o444 }],
		["/run/qorpera-office-preparation/control.lock", { content: Buffer.alloc(0), uid: 0, gid: 0, mode: 0o600 }],
	]);
	f.file.mockImplementation(async (_project, _name, path) => {
		const value = guest.get(path);
		if (!value) throw new Error("guest file missing");
		return { ...value, content: Buffer.from(value.content) };
	});
	let staged: Buffer | undefined;
	const stage = vi
		.spyOn(f.client, "pushOfficePreparationRequest")
		.mockImplementation(async (_project, _name, sha, bytes) => {
			expect(hash(bytes)).toBe(sha);
			staged = Buffer.from(bytes);
		});
	const readStage = vi
		.spyOn(f.client, "readOfficePreparationRequest")
		.mockImplementation(async (_project, _name, sha, bytes) => {
			if (!staged || staged.length !== bytes || hash(staged) !== sha) throw new Error("staging mismatch");
			return { content: Buffer.from(staged), uid: 0, gid: 0, mode: 0o400 };
		});
	const exec = vi
		.spyOn(f.client, "submitOfficePreparation")
		.mockImplementation(async (project, instanceName, command) => {
			if (!staged) throw new Error("request missing");
			const request = parseCompanyComputerPreparationRequest(JSON.parse(staged.toString()));
			const report = {
				schema: "qorpera.office-guest-preparation-result/v1",
				state: "prepared",
				scope: request.scope,
				computerGeneration: request.computerGeneration,
				allocationId: request.allocationId,
				instanceSha256: request.instanceSha256,
				imageSha256: request.imageSha256,
				bootstrapSha256: request.bootstrapSha256,
				bootId: request.bootId,
				copy: request.copy,
				workbenchMount: request.workbenchMount,
				requestSha256: command.requestSha256,
				contentSha256: hash(JSON.stringify(request.entries)),
				observationSha256: "a".repeat(64),
				entries: request.entries.length,
				totalBytes: request.entries.reduce((sum, entry) => sum + entry.bytes, 0),
				invocationId: "b".repeat(32),
			};
			const reportBytes = encode(report);
			const receiptBytes = encode(companyComputerPreparationAdoptionReceipt(request));
			guest.set(COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH, { content: receiptBytes, uid: 0, gid: 0, mode: 0o444 });
			const completion = {
				schema: "qorpera.office-preparation-completion/v2",
				command,
				invocationId: report.invocationId,
				reportSha256: hash(reportBytes),
				adoptionReceiptSha256: hash(receiptBytes),
				report,
			};
			guest.set("/run/qorpera-office-preparation/result.json", {
				content: reportBytes,
				uid: 0,
				gid: 0,
				mode: 0o600,
			});
			guest.set("/run/qorpera-office-preparation/completion.json", {
				content: encode(completion),
				uid: 0,
				gid: 0,
				mode: 0o600,
			});
			return { project, instanceName, operationId: id(20) };
		});
	const poll = vi.spyOn(f.client, "inspectOfficePreparation").mockResolvedValue("succeeded");
	const create = () =>
		new LxdOfficePreparationWorker(
			{ policy: f.policy, check: f.check },
			{ call: f.call },
			{ client: f.client, kernelLock: f.kernelLock, readProtected: f.readProtected },
		);
	const names = {
		index: `preparation-intent-${f.binding.allocationId}.json`,
		request: `preparation-request-${f.binding.allocationId}.json`,
		observation: `preparation-observation-${f.binding.allocationId}.json`,
		completion: `preparation-completed-${f.binding.allocationId}.json`,
		journal: `preparation-${f.binding.allocationId}`,
	};
	return { ...f, create, worker: create(), guest, stage, readStage, exec, poll, names, staged: () => staged };
}
