import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseCompanyComputerPreparationCommand } from "@qorpera/contracts";
import type { LxdOfficePreparationClient } from "./lxd-client.ts";
import { officeDigest, officeRecord } from "./lxd-office-image-provenance.ts";
import { code, readRecord } from "./lxd-office-journal-files.ts";
import { parseLxdOfficeLifecycleRequest } from "./lxd-office-lifecycle-journal.ts";
import { readLxdOfficeProtectedFile } from "./lxd-office-physical-host.ts";
import {
	type LxdOfficePreparationIdentity,
	LxdOfficePreparationJournal,
	type LxdOfficePreparationOperationResult,
} from "./lxd-office-preparation-journal.ts";

/** Resolve retained transport evidence only. Never dispatch preparation or
 * reconcile working files. The original failed/unknown attempt stays intact;
 * only a protected review and a separately settled operation can supersede it.
 * Later boots locate that review through the retained initial lifecycle request,
 * but the lifecycle record itself grants no recovery authority. */
export async function readLxdOfficePreparationRecovery(
	root: string,
	identity: LxdOfficePreparationIdentity,
	client: LxdOfficePreparationClient,
	signal: AbortSignal,
	original: LxdOfficePreparationOperationResult,
	reviewPath?: string,
	readProtected = readLxdOfficeProtectedFile,
) {
	signal.throwIfAborted();
	// A successful original attempt needs no operator recovery or obsolete
	// storage-review access, including when active work is reconciled later.
	if (original.state === "succeeded") return { operation: original };
	if (reviewPath === undefined) {
		if (!["unknown", "failed"].includes(original.state)) return { operation: original };
		const lifecycle = officeRecord(
			(await readRecord(join(root, `lifecycle-${identity.intentId}-7.json`), 65536)).value,
			["schema", "intentId", "configurationSha256", "phase", "previousSha256", "context"],
		);
		const context = officeRecord(lifecycle.context, ["allocationId", "observationSha256", "request"]);
		const request = parseLxdOfficeLifecycleRequest(context.request);
		if (
			lifecycle.schema !== "qorpera.lxd-office-lifecycle-phase/v1" ||
			lifecycle.intentId !== identity.intentId ||
			lifecycle.phase !== "activation" ||
			context.allocationId !== identity.binding.allocationId ||
			context.observationSha256 !== request.observationSha256 ||
			request.intentId !== identity.intentId
		)
			throw new Error("OFFICE_PREPARATION_RECOVERY_UNCONFIRMED");
		reviewPath = request.reviewPath;
	}
	const path = `${reviewPath}.preparation-recovery`;
	let recoveryBytes: Buffer;
	try {
		recoveryBytes = await readProtected(path, 16384);
	} catch (error) {
		if (!code(error, "ENOENT")) throw error;
		return { operation: original };
	}
	const recovery = officeRecord(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(recoveryBytes)), [
		"schema",
		"recoveryId",
		"identitySha256",
		"originalOperationId",
		"acceptedSha256",
	]);
	const recoveryId = parseCompanyComputerPreparationCommand({
		...identity.command,
		commandId: recovery.recoveryId,
	}).commandId;
	if (
		recovery.schema !== "qorpera.lxd-office-preparation-recovery/v1" ||
		!["unknown", "failed"].includes(original.state) ||
		!original.operationId ||
		recovery.originalOperationId !== original.operationId ||
		recovery.identitySha256 !== officeDigest(identity) ||
		recovery.acceptedSha256 !==
			createHash("sha256")
				.update((await readRecord(join(root, `preparation-${identity.binding.allocationId}`, "000001.json"))).bytes)
				.digest("hex")
	)
		throw new Error("OFFICE_PREPARATION_RECOVERY_UNCONFIRMED");
	const journal = await LxdOfficePreparationJournal.open(
		join(root, `preparation-recovery-${identity.binding.allocationId}-${recoveryId}`),
		identity,
		client,
	);
	const operation = await journal.observe(signal);
	if (operation.state !== "succeeded" || !operation.operationId || operation.operationId === original.operationId)
		throw new Error("OFFICE_PREPARATION_RECOVERY_UNCONFIRMED");
	if (!(await readProtected(path, 16384)).equals(recoveryBytes))
		throw new Error("OFFICE_PREPARATION_RECOVERY_CHANGED");
	signal.throwIfAborted();
	return { operation, recoveryBytes };
}
