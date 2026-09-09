import { randomUUID } from "node:crypto";
import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
	type CompanyComputerPreparationCommand,
	type CompanyComputerServiceStopCompletion,
	type CompanyComputerServiceStopRequest,
	parseCompanyComputerServiceStopInspection,
} from "@qorpera/contracts";
import type { LxdOfficeServiceStopClient } from "./lxd-client.ts";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeCanonical } from "./lxd-office-image-provenance.ts";
import { publish, readRecord } from "./lxd-office-journal-files.ts";
import type { LxdOfficeStopControl } from "./lxd-office-stop-control.ts";
import { officeStopDecode } from "./lxd-office-stop-evidence.ts";

/** Called only by the serialized stop worker. Every attempt is durable before
 * SQL challenge preparation, has a new nonce, and consumes one of 64 slots.
 * Neither a lost reply nor a new provider can reopen an old freshness window.
 * The caller retains the lock until all client and registry IO has settled. */
export async function inspectAndAcknowledgeLxdOfficeStop(
	root: string,
	binding: LxdOfficeGuestBinding,
	command: CompanyComputerPreparationCommand,
	request: CompanyComputerServiceStopRequest,
	completion: CompanyComputerServiceStopCompletion,
	client: LxdOfficeServiceStopClient,
	control: LxdOfficeStopControl,
	authorize: (signal: AbortSignal) => Promise<AbortSignal>,
	caller: AbortSignal,
) {
	const prefix = `stop-inspection-${binding.allocationId}-${request.revocation.request.transitionId}-`;
	const attempts = new Set<string>();
	const dir = await opendir(root);
	let count = 0;
	for await (const entry of dir) {
		caller.throwIfAborted();
		if (++count > 4096) throw new Error("stop inspection scan limit");
		if (!entry.name.startsWith(prefix)) continue;
		const match =
			/^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:-accepted)?\.json$/.exec(
				entry.name.slice(prefix.length),
			);
		if (!match || !entry.isFile()) throw new Error("invalid stop inspection record");
		attempts.add(match[1]);
		if (attempts.size >= 64) throw new Error("stop inspection budget exhausted");
	}
	const inspectionId = randomUUID();
	if (inspectionId === command.commandId) throw new Error("nonce collision");
	const recordName = `${prefix}${inspectionId}.json`;
	const dispatch = {
		schema: "qorpera.lxd-office-stop-inspection-dispatch/v1",
		binding,
		command,
		inspectionId,
		completion,
	};
	await authorize(caller);
	if (!(await publish(root, recordName, Buffer.from(officeCanonical(dispatch))))) throw new Error("nonce reused");
	const before = performance.now();
	const challenge = await control.prepare(inspectionId, caller);
	// Conservatively include preparation latency again; never extend SQL's
	// remaining validity by starting a fresh five-second client timer.
	const deadline = before + challenge.validForMs;
	const remaining = Math.floor(deadline - performance.now());
	if (remaining < 1) throw new Error("stop inspection expired");
	let authority = AbortSignal.any([caller, AbortSignal.timeout(remaining)]);
	const fresh = () => {
		authority.throwIfAborted();
		if (performance.now() >= deadline) throw new Error("stop inspection expired");
	};
	const checked = async () => {
		fresh();
		if (!isDeepStrictEqual((await readRecord(join(root, recordName))).value, dispatch))
			throw new Error("stop inspection dispatch changed");
		authority = AbortSignal.any([authority, await authorize(authority)]);
		fresh();
		return authority;
	};
	const name = lxdOfficeGuestPlan(binding).request.name;
	const reference = await client.submitOfficeServiceStopInspection(
		binding.project,
		name,
		command,
		inspectionId,
		await checked(),
	);
	if (
		!isDeepStrictEqual(reference, {
			project: binding.project,
			instanceName: name,
			operationId: reference.operationId,
		}) ||
		typeof reference.operationId !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(reference.operationId)
	)
		throw new Error("stop inspection operation differs");
	// Preserve accepted identity even when cancellation accompanies the reply.
	if (
		!(await publish(
			root,
			`${prefix}${inspectionId}-accepted.json`,
			Buffer.from(
				officeCanonical({
					schema: "qorpera.lxd-office-stop-inspection-accepted/v1",
					inspectionId,
					reference,
				}),
			),
		))
	)
		throw new Error("stop inspection acceptance changed");
	for (;;) {
		const state = await client.inspectOfficeServiceStop(reference, await checked());
		fresh();
		if (state === "succeeded") break;
		if (state !== "pending") throw new Error("stop inspection failed");
		await delay(50, undefined, { signal: authority });
	}
	const file = await client.readInstanceFile(
		binding.project,
		name,
		`/run/qorpera-office-preparation/service-stop-inspection-${inspectionId}.json`,
		65536,
		await checked(),
	);
	fresh();
	if (file.uid !== 0 || file.gid !== 0 || file.mode !== 0o600 || file.content.length > 65536)
		throw new Error("stop inspection custody");
	const inspection = parseCompanyComputerServiceStopInspection(
		officeStopDecode(file.content),
		inspectionId,
		completion,
		request,
	);
	const receipt = await control.acknowledge(inspection, await checked());
	fresh();
	return receipt;
}
