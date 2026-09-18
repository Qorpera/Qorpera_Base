import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { lxdOfficeDeleteDispositionPath } from "../../src/lxd-office-delete-disposition.ts";
import { reconcileLxdOfficeDeleteMetadata } from "../../src/lxd-office-delete-reconciliation.ts";
import { LxdOfficeOperationJournal } from "../../src/lxd-office-operations.ts";
import * as physical from "../../src/lxd-office-physical-host.ts";
import {
	officeDeleteDispositionContextFor,
	officeDeleteDispositionFixture,
} from "../helpers/office-delete-disposition-fixture.ts";
import type { officeResetWorkerFixture } from "./office-reset-worker.ts";

/** Production journal/metadata composition with synthetic SQL and protected
 * filesystem ports. This does not prove a live physical execution fence. */
export async function recoverOfficeResetDelete(
	f: Pick<
		Awaited<ReturnType<typeof officeResetWorkerFixture>>,
		"ticks" | "registry" | "poll" | "run" | "root" | "binding" | "paths" | "plan" | "planSha256" | "journalRoot"
	>,
) {
	await f.ticks(3);
	expect(f.registry.state.phase).toBe("powered_off");
	f.poll.mockRejectedValueOnce(new Error("accepted result evicted"));
	await expect(f.run()).resolves.toMatchObject({ state: "unknown", phase: "powered_off" });
	const history = await LxdOfficeOperationJournal.readHistory(f.root, f.binding.allocationId);
	const accepted = history.events.at(-1)!;
	expect(accepted).toMatchObject({ kind: "accepted", action: "delete", state: null });
	const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
	const phaseHash = async (n: number): Promise<string> =>
		JSON.parse(await readFile(f.paths.phase(n), "utf8")).evidenceSha256;
	const { document: sample } = officeDeleteDispositionFixture();
	const document = {
		...sample,
		resetId: f.plan.resetId,
		planSha256: f.planSha256,
		deleteCommandId: f.plan.commands.deleteCommandId,
		operationId: accepted.operationId!,
		nextCreateCommandId: f.plan.commands.createCommandId,
		journal: {
			authoritySha256: hash(await readFile(join(f.journalRoot, "authority.json"))),
			acceptedHeadSha256: history.journalHeadSha256,
			eventCount: history.events.length,
		},
		stopAcknowledgementSha256: await phaseHash(2),
		custodyEvidenceSha256: await phaseHash(3),
		poweredOffPhaseSha256: await phaseHash(4),
	};
	const { context, bytes } = await officeDeleteDispositionContextFor(f.plan, document);
	const receiptPath = lxdOfficeDeleteDispositionPath(f.binding.allocationId, document.auditId);
	const protectedRead = vi.spyOn(physical, "readLxdOfficeProtectedFile").mockImplementation(async (path) => {
		if (path !== receiptPath) throw new Error("unexpected protected receipt");
		return bytes;
	});
	const original = new Map<string, Buffer>();
	for (const name of await readdir(f.journalRoot))
		original.set(join(f.journalRoot, name), await readFile(join(f.journalRoot, name)));
	for (let n = 1; n <= 4; n++) original.set(f.paths.phase(n), await readFile(f.paths.phase(n)));
	// Simulate the separate committed operator RPC before product metadata
	// reconciliation. No provider RPC is permitted to manufacture this state.
	f.registry.state.phase = "root_deleted";
	f.registry.state.revision++;
	await reconcileLxdOfficeDeleteMetadata(f.root, context, async () => {});
	return {
		context,
		protectedRead,
		preserved: async () => {
			for (const [path, bytes] of original) expect(await readFile(path)).toEqual(bytes);
		},
	};
}
