import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	companyComputerBootAdoptionReceipt,
	companyComputerBootAdoptionReceiptPath,
	companyComputerBootDirectory,
	companyComputerPreparationAdoptionReceipt,
	companyComputerResumeObservationCanonical,
	parseCompanyComputerBootConfigurationRequest,
	parseCompanyComputerPreparationRequest,
} from "@qorpera/contracts";
import { expect, vi } from "vitest";
import { LxdOfficeBootConfigurationWorker } from "../../src/lxd-office-boot-configuration-worker.ts";
import { officeStopHash as hash } from "../../src/lxd-office-stop-evidence.ts";
import { officeResumeWorkerFixture } from "./office-resume-worker.ts";
import { serviceStartId as id } from "./office-service-start.ts";

export async function officeBootConfigurationWorkerFixture(roots: string[], resumed = true) {
	const f = await officeResumeWorkerFixture(roots);
	if (resumed) await f.run();
	return createOfficeBootConfigurationWorkerFixture(f);
}

export async function createOfficeBootConfigurationWorkerFixture(
	f: Awaited<ReturnType<typeof officeResumeWorkerFixture>>,
) {
	const input = {
		intentId: f.activation.request.intentId,
		request: f.request,
		serviceBootstrapPath: f.activation.request.serviceBootstrapPath,
	};
	const names = {
		index: join(f.root, `boot-configuration-intent-${f.binding.allocationId}-${f.request.activationId}.json`),
		observation: join(
			f.root,
			`boot-configuration-observation-${f.binding.allocationId}-${f.request.activationId}.json`,
		),
		done: join(f.root, `boot-configuration-completed-${f.binding.allocationId}-${f.request.activationId}.json`),
		journal: join(f.root, `boot-configuration-${f.binding.allocationId}-${f.request.activationId}`),
	};
	let staged: Buffer | undefined;
	const state = { install: true };
	const stage = vi
		.spyOn(f.client, "pushOfficeBootConfigurationRequest")
		.mockImplementation(async (_p, _n, sha, bytes, checked) => {
			checked.throwIfAborted();
			expect(hash(bytes)).toBe(sha);
			expect(JSON.parse(await readFile(names.index, "utf8")).requestSha256).toBe(sha);
			staged = Buffer.from(bytes);
		});
	const readStage = vi
		.spyOn(f.client, "readOfficeBootConfigurationRequest")
		.mockImplementation(async (_p, _n, sha, bytes, checked) => {
			checked.throwIfAborted();
			expect(staged?.length).toBe(bytes);
			expect(hash(staged!)).toBe(sha);
			return { uid: 0, gid: 0, mode: 0o400, content: Buffer.from(staged!) };
		});
	const exec = vi
		.spyOn(f.client, "submitOfficeBootConfiguration")
		.mockImplementation(async (project, instanceName, command, checked) => {
			checked.throwIfAborted();
			expect(JSON.parse(await readFile(join(names.journal, "000000.json"), "utf8")).kind).toBe("dispatch");
			const body = parseCompanyComputerBootConfigurationRequest(JSON.parse(staged!.toString()));
			const originalBytes = await readFile(join(f.root, `preparation-request-${f.binding.allocationId}.json`)),
				original = parseCompanyComputerPreparationRequest(JSON.parse(originalBytes.toString())),
				bootObservationSha256 = hash(
					Buffer.from(companyComputerResumeObservationCanonical(body.observation, body.bootIntent.request)),
				),
				receipt = companyComputerBootAdoptionReceipt(
					original,
					hash(originalBytes),
					hash(Buffer.from(`${JSON.stringify(companyComputerPreparationAdoptionReceipt(original))}\n`)),
					body.bootIntent.request,
					body.observation,
					bootObservationSha256,
				),
				receiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`),
				files = Object.fromEntries(
					Object.entries(COMPANY_COMPUTER_CONFIGURATION_FILES).map(([key, file]) => {
						const content = Buffer.from(body.material[key as keyof typeof COMPANY_COMPUTER_CONFIGURATION_FILES]);
						if (state.install)
							f.guest.set(`${companyComputerBootDirectory(command.bootId)}/credentials/${file}`, {
								uid: 0,
								gid: 0,
								mode: 0o400,
								content,
							});
						return [file, { bytes: content.length, sha256: hash(content) }];
					}),
				);
			if (state.install) {
				f.guest.set(companyComputerBootAdoptionReceiptPath(command.bootId), {
					uid: 0,
					gid: 0,
					mode: 0o444,
					content: receiptBytes,
				});
				f.guest.set(`${companyComputerBootDirectory(command.bootId)}/configuration-completion.json`, {
					uid: 0,
					gid: 0,
					mode: 0o600,
					content: Buffer.from(
						`${JSON.stringify({ schema: "qorpera.office-boot-configuration-completion/v1", command, bootIntentId: body.bootIntent.request.bootIntentId, activationId: body.bootIntent.request.activationId, originPreparationSha256: hash(originalBytes), adoptionReceiptSha256: hash(receiptBytes), bootObservationSha256, files })}\n`,
					),
				});
			}
			return { project, instanceName, operationId: id(115) };
		});
	const poll = vi.spyOn(f.client, "inspectOfficeBootConfiguration").mockResolvedValue("succeeded");
	const create = () =>
		new LxdOfficeBootConfigurationWorker(
			{ policy: f.policy, check: f.check },
			{ call: f.registry },
			{
				client: f.client,
				kernelLock: f.kernelLock,
				readProtected: f.readProtected,
				readCredential: f.readCredential,
			},
		);
	return {
		...f,
		resume: f,
		input,
		names,
		state,
		stage,
		readStage,
		exec,
		poll,
		create,
		run: (signal: AbortSignal = new AbortController().signal) => create().reconcile(input, signal),
		staged: () => staged,
	};
}
