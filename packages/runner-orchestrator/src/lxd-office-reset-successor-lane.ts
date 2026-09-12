import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	COMPANY_COMPUTER_CONFIGURATION_LIMITS,
	COMPANY_COMPUTER_RESET_CONFIGURATION_CLAIM,
	COMPANY_COMPUTER_RESET_CONFIGURATION_COMPLETION,
	type CompanyComputerPreparationCommand,
	type CompanyComputerResetConfigurationCompletion,
	type CompanyComputerResetPlan,
	type CompanyComputerResetServiceStartCompletion,
	type CompanyComputerResetSuccessor,
	companyComputerBootDirectory,
	parseCompanyComputerResetConfigurationCompletion,
	parseCompanyComputerResetServiceStartCompletion,
	parseCompanyComputerResetServiceStartRequest,
} from "@qorpera/contracts";
import type { LxdOfficeResetSuccessorClient } from "./lxd-client.ts";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeCanonical } from "./lxd-office-image-provenance.ts";
import { code } from "./lxd-office-journal-files.ts";
import { LxdOfficeResetServiceInspectionControl } from "./lxd-office-reset-service-inspection.ts";
import {
	openLxdOfficeResetConfigurationJournal,
	openLxdOfficeResetServiceStartJournal,
} from "./lxd-office-reset-successor-journal.ts";

const RUN = "/run/qorpera-office-preparation";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const decode = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
/** Identity the reset worker has already bound before any guest effect: the
 * intent, protected plan, retained binding, fresh boot and the acknowledged
 * restore digest that stands in for a boot observation on the new root. */
export interface LxdOfficeResetSuccessorLaneContext {
	intentId: string;
	plan: CompanyComputerResetPlan;
	binding: LxdOfficeGuestBinding;
	bootId: string;
	restoreSha256: string;
}
/** Guest-side handoff on the recreated root: fresh credential installation
 * through the protected reset configuration helper, one ordinary service
 * start and a nonce-bound inspection. The worker owns every authority check,
 * command identity and retained record; the lane owns only the closed guest
 * transport and its durable dispatch journals. */
export interface LxdOfficeResetSuccessorLane {
	configure(
		input: LxdOfficeResetSuccessorLaneContext & {
			command: CompanyComputerPreparationCommand;
			/** Exact staged packet bytes; `command.requestSha256` is their digest. */
			request: Buffer;
			expected: CompanyComputerResetConfigurationCompletion;
		},
		signal: AbortSignal,
	): Promise<CompanyComputerResetConfigurationCompletion["files"]>;
	start(
		input: LxdOfficeResetSuccessorLaneContext & {
			command: CompanyComputerPreparationCommand;
			configuration: CompanyComputerResetConfigurationCompletion;
			successor: CompanyComputerResetSuccessor;
			/** SQL already records an invocation: observe a prior dispatch, never start. */
			claimed: boolean;
		},
		signal: AbortSignal,
	): Promise<CompanyComputerResetServiceStartCompletion>;
	inspect(
		input: LxdOfficeResetSuccessorLaneContext & {
			command: CompanyComputerPreparationCommand;
			successor: CompanyComputerResetSuccessor;
			completion: CompanyComputerResetServiceStartCompletion;
		},
		signal: AbortSignal,
	): Promise<{ serviceInvocationId: string; configurationSha256: string }>;
}
export function createLxdOfficeResetSuccessorLane(
	root: string,
	client: LxdOfficeResetSuccessorClient,
): LxdOfficeResetSuccessorLane {
	const guest = async (
		binding: LxdOfficeGuestBinding,
		path: string,
		limit: number,
		mode: number,
		signal: AbortSignal,
	) => {
		const file = await client.readInstanceFile(
			binding.project,
			lxdOfficeGuestPlan(binding).request.name,
			path,
			limit,
			signal,
		);
		if (file.uid !== 0 || file.gid !== 0 || file.mode !== mode || file.content.length > limit) {
			file.content.fill(0);
			throw new Error("reset guest custody differs");
		}
		return file.content;
	};
	const lock = async (binding: LxdOfficeGuestBinding, signal: AbortSignal) => {
		if ((await guest(binding, `${RUN}/control.lock`, 1, 0o600, signal)).length !== 0)
			throw new Error("reset guest lock differs");
	};
	const exists = async (name: string) => {
		try {
			await lstat(join(root, name));
			return true;
		} catch (error) {
			if (!code(error, "ENOENT")) throw error;
			return false;
		}
	};
	const staged = async (
		binding: LxdOfficeGuestBinding,
		purpose: "reset-configuration" | "reset-service-start",
		command: CompanyComputerPreparationCommand,
		bytes: Buffer,
		signal: AbortSignal,
	) => {
		const project = binding.project,
			name = lxdOfficeGuestPlan(binding).request.name;
		await lock(binding, signal);
		if (purpose === "reset-configuration")
			await client.pushOfficeResetConfigurationRequest(project, name, command.requestSha256, bytes, signal);
		else await client.pushOfficeResetServiceStartRequest(project, name, command.requestSha256, bytes, signal);
		const file =
			purpose === "reset-configuration"
				? await client.readOfficeResetConfigurationRequest(
						project,
						name,
						command.requestSha256,
						bytes.length,
						signal,
					)
				: await client.readOfficeResetServiceStartRequest(
						project,
						name,
						command.requestSha256,
						bytes.length,
						signal,
					);
		try {
			if (file.uid !== 0 || file.gid !== 0 || file.mode !== 0o400 || !file.content.equals(bytes))
				throw new Error("reset staging changed");
		} finally {
			file.content.fill(0);
		}
		signal.throwIfAborted();
	};
	/** The acknowledged reset configuration on the fresh root, read back with
	 * its claim and the installed credential digests. */
	const configured = async (
		binding: LxdOfficeGuestBinding,
		bootId: string,
		expected: CompanyComputerResetConfigurationCompletion,
		signal: AbortSignal,
	) => {
		const directory = companyComputerBootDirectory(bootId);
		if (expected.command.bootId !== bootId) throw new Error("reset configuration boot differs");
		const bytes = await guest(
			binding,
			`${directory}/${COMPANY_COMPUTER_RESET_CONFIGURATION_COMPLETION}`,
			16384,
			0o600,
			signal,
		);
		const completion = parseCompanyComputerResetConfigurationCompletion(decode(bytes), expected);
		const claim = await guest(
			binding,
			`${directory}/${COMPANY_COMPUTER_RESET_CONFIGURATION_CLAIM}`,
			4096,
			0o600,
			signal,
		);
		if (
			!isDeepStrictEqual(decode(claim), {
				schema: "qorpera.office-reset-configuration-claim/v1",
				command: expected.command,
				resetId: expected.resetId,
				rootIncarnationId: expected.rootIncarnationId,
				activationId: expected.activationId,
			})
		)
			throw new Error("reset configuration claim differs");
		for (const [key, file] of Object.entries(COMPANY_COMPUTER_CONFIGURATION_FILES)) {
			const content = await guest(
				binding,
				`${directory}/credentials/${file}`,
				COMPANY_COMPUTER_CONFIGURATION_LIMITS[key as keyof typeof COMPANY_COMPUTER_CONFIGURATION_LIMITS],
				0o400,
				signal,
			);
			try {
				if (content.length !== completion.files[file].bytes || hash(content) !== completion.files[file].sha256)
					throw new Error("reset credentials differ");
			} finally {
				content.fill(0);
			}
		}
		signal.throwIfAborted();
		return { completion, sha256: hash(bytes) };
	};
	return {
		async configure(input, signal) {
			const { binding, bootId, command, request, expected, plan, intentId, restoreSha256 } = input;
			if (
				hash(request) !== command.requestSha256 ||
				command.bootId !== bootId ||
				!isDeepStrictEqual(expected.command, command) ||
				expected.resetId !== plan.resetId ||
				expected.activationId !== plan.successorActivationId
			)
				throw new Error("reset configuration packet differs");
			const identity = {
				intentId,
				binding,
				bootObservationSha256: restoreSha256,
				command,
				activationId: plan.successorActivationId,
				resetId: plan.resetId,
				originPreparationSha256: expected.originPreparationSha256,
			};
			const journal = await openLxdOfficeResetConfigurationJournal(
				root,
				identity,
				client,
				await exists(`reset-configuration-${binding.allocationId}-${plan.successorActivationId}`),
			);
			let operation = await journal.observe(signal);
			if (operation.state === "not_dispatched") {
				await staged(binding, "reset-configuration", command, request, signal);
				operation = await journal.reconcile(signal);
			}
			if (operation.state !== "succeeded")
				throw new Error(`OFFICE_RESET_CONFIGURATION_${operation.state.toUpperCase()}`);
			return (await configured(binding, bootId, expected, signal)).completion.files;
		},
		async start(input, signal) {
			const { binding, bootId, command, configuration, successor, claimed, plan, intentId, restoreSha256 } = input;
			const request = parseCompanyComputerResetServiceStartRequest(successor),
				bytes = Buffer.from(officeCanonical(request));
			if (
				hash(bytes) !== command.requestSha256 ||
				command.bootId !== bootId ||
				request.request.attestation.bootId !== bootId ||
				request.request.resetId !== plan.resetId ||
				request.request.attestation.activationId !== plan.successorActivationId ||
				command.commandId === configuration.command.commandId
			)
				throw new Error("reset start packet differs");
			const evidence = await configured(binding, bootId, configuration, signal);
			const identity = {
				intentId,
				binding,
				bootObservationSha256: restoreSha256,
				command,
				activationId: plan.successorActivationId,
				resetId: plan.resetId,
				configurationObservationSha256: request.request.attestation.configurationObservationSha256,
			};
			const journal = await openLxdOfficeResetServiceStartJournal(
				root,
				identity,
				client,
				await exists(`reset-service-start-${binding.allocationId}-${plan.successorActivationId}`),
			);
			let operation = await journal.observe(signal);
			if (operation.state === "not_dispatched") {
				if (claimed) throw new Error("reset invocation already claimed");
				await staged(binding, "reset-service-start", command, bytes, signal);
				operation = await journal.reconcile(signal);
			}
			let file: Buffer;
			try {
				file = await guest(binding, `${RUN}/reset-service-start-completion.json`, 8192, 0o600, signal);
			} catch (error) {
				signal.throwIfAborted();
				throw new Error(
					`OFFICE_RESET_SERVICE_START_${
						operation.state === "succeeded" || operation.state === "not_dispatched"
							? "UNKNOWN"
							: operation.state.toUpperCase()
					}`,
					{ cause: error },
				);
			}
			const completion = parseCompanyComputerResetServiceStartCompletion(decode(file), command, request);
			if (completion.configurationCompletionSha256 !== evidence.sha256)
				throw new Error("reset start configuration differs");
			return completion;
		},
		async inspect(input, signal) {
			const request = parseCompanyComputerResetServiceStartRequest(input.successor);
			return new LxdOfficeResetServiceInspectionControl(root, input.binding, client).inspectAndUse(
				input.command,
				request,
				input.completion,
				async () => signal,
				async (start) => ({
					serviceInvocationId: start.serviceInvocationId,
					configurationSha256: start.configurationSha256,
				}),
				signal,
			);
		},
	};
}
