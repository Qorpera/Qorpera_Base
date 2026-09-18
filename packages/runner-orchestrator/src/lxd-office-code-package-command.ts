import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { LxdOfficeCodePackageClient, LxdOperationReference, LxdOperationState } from "./lxd-client.ts";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan, parseLxdOfficeGuestBinding } from "./lxd-office-guest.ts";
import { officeCanonical, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import { checkDirectory, code, publish, readRecord } from "./lxd-office-journal-files.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface LxdOfficeCodePackageCommand {
	readonly provisionId: string;
	readonly commandId: string;
	readonly purpose: "bootstrap" | "measure";
	readonly pin: { bytes: number; sha256: string };
	readonly args: readonly string[];
	readonly packetSha256: string;
}
export interface LxdOfficeCodePackageCommandResult {
	state: LxdOperationState | "unknown";
	reference?: LxdOperationReference;
}
/** Provider-local dispatch fence. A retained dispatch with no acceptance is
 * unknown forever; neither timeout, missing LXD operation nor repeated calls
 * redispatch it. A successful exec still requires independent root readback. */
export async function runLxdOfficeCodePackageCommand(
	root: string,
	bindingValue: LxdOfficeGuestBinding,
	commandValue: LxdOfficeCodePackageCommand,
	client: Pick<LxdOfficeCodePackageClient, "submitOfficeCodePackageTool" | "inspectOfficeCodePackageTool">,
	signal: AbortSignal,
	authorize: () => Promise<void>,
): Promise<LxdOfficeCodePackageCommandResult> {
	signal.throwIfAborted();
	const command = structuredClone(commandValue);
	officeRecord(command, ["provisionId", "commandId", "purpose", "pin", "args", "packetSha256"]);
	officeRecord(command.pin, ["bytes", "sha256"]);
	await checkDirectory(root);
	const binding = parseLxdOfficeGuestBinding(bindingValue),
		name = lxdOfficeGuestPlan(binding).request.name;
	if (
		!UUID.test(command.provisionId) ||
		!UUID.test(command.commandId) ||
		!["bootstrap", "measure"].includes(command.purpose) ||
		!Number.isSafeInteger(command.pin.bytes) ||
		command.pin.bytes < 1 ||
		command.pin.bytes > 16 * 1024 ** 2 ||
		!Array.isArray(command.args) ||
		command.args.length > 7 ||
		!command.args.every((a) => typeof a === "string" && a.length < 100)
	)
		throw new Error("OFFICE_CODE_PACKAGE_COMMAND_UNCONFIRMED");
	officeSha(command.pin.sha256);
	officeSha(command.packetSha256);
	const identity = { schema: "qorpera.lxd-office-code-package-command/v1", binding, command },
		prefix = `code-package-command-${command.provisionId}-`,
		stem = `${prefix}${command.commandId}`;
	const read = async (suffix: string) => {
		try {
			return (await readRecord(join(root, `${stem}${suffix}.json`), 32768)).value;
		} catch (error) {
			if (code(error, "ENOENT")) return undefined;
			throw error;
		}
	};
	const record = async (suffix: string, value: unknown) => {
		if (
			!(await publish(root, `${stem}${suffix}.json`, Buffer.from(officeCanonical(value)))) ||
			!isDeepStrictEqual(await read(suffix), value)
		)
			throw new Error("OFFICE_CODE_PACKAGE_COMMAND_CONFLICT");
	};
	const retained = await read("");
	let reference: LxdOperationReference | undefined;
	if (retained === undefined) {
		if ((await read("-accepted")) !== undefined || (await read("-completed")) !== undefined)
			throw new Error("OFFICE_CODE_PACKAGE_COMMAND_UNCONFIRMED");
		const directory = await opendir(root);
		let scanned = 0,
			attempts = 0;
		for await (const entry of directory) {
			if (++scanned > 32768) throw new Error("OFFICE_CODE_PACKAGE_JOURNAL_LIMIT");
			if (
				entry.name.startsWith(prefix) &&
				new RegExp(`^${prefix}[0-9a-f-]{36}\\.json$`).test(entry.name) &&
				++attempts >= 4096
			)
				throw new Error("OFFICE_CODE_PACKAGE_ATTEMPT_LIMIT");
		}
		await record("", identity);
		await authorize();
		signal.throwIfAborted();
		// Any throw after the dispatch record stays unknown. No repair or retry.
		reference = await client.submitOfficeCodePackageTool(
			binding.project,
			name,
			command.provisionId,
			command.purpose,
			command.pin,
			command.args,
			signal,
		);
		if (
			!isDeepStrictEqual(reference, {
				project: binding.project,
				instanceName: name,
				operationId: reference.operationId,
			}) ||
			!UUID.test(reference.operationId)
		)
			throw new Error("OFFICE_CODE_PACKAGE_REFERENCE_UNCONFIRMED");
		// Retain acceptance even if cancellation arrived with this reply.
		await record("-accepted", { schema: "qorpera.lxd-office-code-package-accepted/v1", reference });
	} else {
		if (!isDeepStrictEqual(retained, identity)) throw new Error("OFFICE_CODE_PACKAGE_COMMAND_CONFLICT");
		const accepted = await read("-accepted");
		if (accepted === undefined) {
			if ((await read("-completed")) !== undefined) throw new Error("OFFICE_CODE_PACKAGE_COMMAND_UNCONFIRMED");
			return { state: "unknown" };
		}
		const r = officeRecord(accepted, ["schema", "reference"]),
			ref = officeRecord(r.reference, ["project", "instanceName", "operationId"]);
		if (
			r.schema !== "qorpera.lxd-office-code-package-accepted/v1" ||
			ref.project !== binding.project ||
			ref.instanceName !== name ||
			typeof ref.operationId !== "string" ||
			!UUID.test(ref.operationId)
		)
			throw new Error("OFFICE_CODE_PACKAGE_REFERENCE_UNCONFIRMED");
		reference = { project: binding.project, instanceName: name, operationId: ref.operationId };
	}
	const completed = await read("-completed");
	if (completed !== undefined) {
		const c = officeRecord(completed, ["schema", "reference", "state"]);
		if (
			c.schema !== "qorpera.lxd-office-code-package-completed/v1" ||
			!isDeepStrictEqual(c.reference, reference) ||
			!["succeeded", "failed"].includes(c.state as string)
		)
			throw new Error("OFFICE_CODE_PACKAGE_COMPLETION_UNCONFIRMED");
		return { state: c.state as "succeeded" | "failed", reference };
	}
	signal.throwIfAborted();
	const state = await client.inspectOfficeCodePackageTool(reference, signal);
	signal.throwIfAborted();
	if (state === "succeeded" || state === "failed")
		await record("-completed", { schema: "qorpera.lxd-office-code-package-completed/v1", reference, state });
	return { state, reference };
}
