import { createHash, randomUUID } from "node:crypto";
import {
	CLOUD_FILE_TRANSFER_MAX_BYTES,
	parseCompanyComputerFileExport,
	parseWorkbenchFilePath,
} from "@qorpera/cloud-client/cloud-file-transfer";
import { afterEach, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "../../shell/test/fixtures/native-tool-authority-fixture.ts";
import { CloudCompanyComputerFileExports } from "../src/cloud-company-computer-file-transfers.ts";
import { CloudNativeToolRun } from "../src/cloud-native-tool-authority.ts";
import { computerBinding, computerLease, computerOperation } from "./fixtures/company-computer.ts";

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
	vi.restoreAllMocks();
});
async function fixture() {
	const source = nativeToolAuthorityFixture();
	const run = await CloudNativeToolRun.open(
		source.binding,
		{ describeToolAuthority: async () => source.authority },
		new AbortController().signal,
	);
	runs.push(run);
	const scope = {
		companyId: run.identity.companyId,
		environmentId: run.identity.environmentId,
		companyComputerId: randomUUID(),
		logicalComputerId: randomUUID(),
	};
	const binding = { ...computerBinding(), ...scope, staffAgentId: run.identity.staffAgentId };
	const lease = {
		...computerLease(),
		binding,
		driver: { kind: "agent" as const, runId: run.identity.runId, staffAgentId: run.identity.staffAgentId },
	};
	const stop = new AbortController();
	const context = {
		identity: run.identity,
		receiptId: randomUUID(),
		idempotencyKey: "a".repeat(64),
		signal: stop.signal,
	};
	const action = parseCompanyComputerFileExport({
		kind: "transfer",
		action: "export",
		source: { realm: "company_computer", path: "output/report.bin" },
		destination: { realm: "object_storage" },
		mediaType: "application/octet-stream",
	});
	const operation = {
		...computerOperation(),
		tool: "computer_transfer",
		arguments: action,
		target: { realm: "company_computer", binding, resources: { officeGrantId: randomUUID(), officeGrantVersion: 1 } },
	};
	const bytes = Uint8Array.from([0, 255, 1, 2]);
	const asset = {
		schema: "qorpera.file-transfer-asset/v1",
		assetId: randomUUID(),
		sha256: createHash("sha256").update(bytes).digest("hex"),
		bytes: bytes.length,
		mediaType: action.mediaType,
		source: { ...action.source, companyComputerId: scope.companyComputerId, screenId: binding.screenId },
		destination: action.destination,
	};
	const steps: string[] = [];
	const call = vi.fn(async (_method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => {
		signal.throwIfAborted();
		steps.push(String(args.p_action));
		return args.p_action === "authorize" ? { state: "authorized" } : structuredClone(asset);
	});
	const put = vi.fn(async (_path: string, _bytes: Uint8Array, _media: string) => {
		steps.push("put");
		return "stored" as const;
	});
	const exports = new CloudCompanyComputerFileExports({ run, scope, registry: { call }, objects: () => ({ put }) });
	return {
		run,
		scope,
		lease,
		stop,
		context,
		operation,
		bytes,
		asset,
		call,
		put,
		steps,
		exports,
		publish: () => exports.publish(bytes, lease, context, operation),
	};
}
it.each(["/etc/passwd", "../secret", "a/../b", "a//b", "a/./b", "a\\b", "a\0b", "a/", "x".repeat(256)])(
	"refuses non-workbench path %s",
	(path) => {
		expect(() => parseWorkbenchFilePath(path)).toThrow();
	},
);
it("preserves literal names and refuses implicit realm substitutions", () => {
	expect(parseWorkbenchFilePath('output/`quote` $(value) "name".bin')).toBe('output/`quote` $(value) "name".bin');
	expect(() =>
		parseCompanyComputerFileExport({
			kind: "transfer",
			action: "export",
			source: { realm: "member_device", path: "selected" },
			destination: { realm: "object_storage" },
			mediaType: "text/plain",
		}),
	).toThrow();
});
it("binds immutable bytes, explicit source and destination to the original receipt", async () => {
	const f = await fixture();
	await expect(f.publish()).resolves.toEqual(f.asset);
	expect(f.steps).toEqual(["authorize", "put", "publish"]);
	expect(f.put).toHaveBeenCalledWith(`${f.scope.companyId}/${f.asset.sha256}`, f.bytes, f.asset.mediaType);
	const args = f.call.mock.calls[0][1];
	expect(args.p_binding).toEqual(f.run.binding);
	expect(args.p_receipt_id).toBe(f.context.receiptId);
	expect(args.p_idempotency_sha256).toBe(createHash("sha256").update(f.context.idempotencyKey).digest("hex"));
	expect(JSON.parse(args.p_envelope as string).operation).toEqual(f.operation);
});
it.each(["source", "destination"] as const)(
	"refuses an isolated-worker %s before authority or storage I/O",
	async (side) => {
		const f = await fixture();
		Object.assign(f.operation.arguments[side], { realm: "isolated_worker" });
		await expect(f.publish()).rejects.toThrow("INVALID_CLOUD_FILE_TRANSFER_REALM");
		expect(f.call).not.toHaveBeenCalled();
		expect(f.put).not.toHaveBeenCalled();
	},
);
it("owns input bytes before awaiting authority", async () => {
	const f = await fixture();
	const expected = Uint8Array.from(f.bytes);
	const pending = f.publish();
	f.bytes.fill(127);
	await pending;
	expect(f.put.mock.calls[0][1]).toEqual(expected);
});
it("refuses unconfirmed admission before storage", async () => {
	const f = await fixture();
	f.call.mockResolvedValueOnce({ state: "authorized", bypass: true });
	await expect(f.publish()).rejects.toThrow("UNCONFIRMED");
	expect(f.put).not.toHaveBeenCalled();
});
it("does not publish after object I/O cancellation", async () => {
	const f = await fixture();
	f.put.mockImplementationOnce(async () => {
		f.stop.abort();
		return "stored";
	});
	await expect(f.publish()).rejects.toThrow();
	expect(f.call).toHaveBeenCalledTimes(1);
});
it.each(["source", "bytes", "mediaType", "sha256"])("refuses substituted published %s", async (field) => {
	const f = await fixture();
	if (field === "source") f.asset.source.path = "different.bin";
	if (field === "bytes") f.asset.bytes++;
	if (field === "mediaType") f.asset.mediaType = "text/plain";
	if (field === "sha256") f.asset.sha256 = "b".repeat(64);
	await expect(f.publish()).rejects.toThrow("UNCONFIRMED");
});
it("bounds file bytes before any authority or storage request", async () => {
	const f = await fixture();
	await expect(
		f.exports.publish(new Uint8Array(CLOUD_FILE_TRANSFER_MAX_BYTES + 1), f.lease, f.context, f.operation),
	).rejects.toThrow();
	expect(f.call).not.toHaveBeenCalled();
	expect(f.put).not.toHaveBeenCalled();
});
