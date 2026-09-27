import { createHash, randomUUID } from "node:crypto";
import { parseCompanyComputerFileImport } from "@qorpera/cloud-client/cloud-file-transfer";
import { afterEach, expect, it, vi } from "vitest";
import { CloudCompanyComputerFileImports } from "../src/cloud-company-computer-file-imports.ts";
import { CloudNativeToolRun } from "../src/cloud-native-tool-authority.ts";
import { computerBinding, computerLease, computerOperation } from "./fixtures/company-computer.ts";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
	vi.restoreAllMocks();
});
async function fixture() {
	const native = nativeToolAuthorityFixture();
	const run = await CloudNativeToolRun.open(
		native.binding,
		{ describeToolAuthority: async () => native.authority },
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
	const stop = new AbortController(),
		context = {
			identity: run.identity,
			receiptId: randomUUID(),
			idempotencyKey: "a".repeat(64),
			signal: stop.signal,
		};
	const bytes = Uint8Array.from([0, 255, 10, 128]),
		sha256 = createHash("sha256").update(bytes).digest("hex"),
		assetId = randomUUID();
	const action = parseCompanyComputerFileImport({
		kind: "transfer",
		action: "import",
		source: { realm: "object_storage", assetId, sha256 },
		destination: { realm: "company_computer", path: "incoming/$(literal).bin" },
	});
	const operation = {
		...computerOperation(),
		tool: "computer_transfer",
		arguments: action,
		target: { realm: "company_computer", binding, resources: { officeGrantId: randomUUID(), officeGrantVersion: 1 } },
	};
	const asset = {
		schema: "qorpera.file-transfer-asset/v1",
		assetId,
		sha256,
		bytes: bytes.length,
		mediaType: "application/octet-stream",
		source: {
			realm: "company_computer",
			companyComputerId: randomUUID(),
			screenId: randomUUID(),
			path: "export.bin",
		},
		destination: { realm: "object_storage" },
	};
	const result = {
		schema: "qorpera.file-import-result/v1",
		transferId: context.receiptId,
		source: action.source,
		destination: { ...action.destination, companyComputerId: scope.companyComputerId, screenId: binding.screenId },
		bytes: bytes.length,
		mediaType: asset.mediaType,
	};
	const steps: string[] = [];
	const call = vi.fn(async (_method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => {
		signal.throwIfAborted();
		steps.push(String(args.p_action));
		return structuredClone(args.p_action === "authorize" ? asset : result);
	});
	const get = vi.fn(async () => {
		steps.push("get");
		return bytes;
	});
	const write = vi.fn(async (_file: { path: string; bytes: Uint8Array; sha256: string }, signal: AbortSignal) => {
		signal.throwIfAborted();
		steps.push("write");
	});
	const importer = new CloudCompanyComputerFileImports({ run, scope, registry: { call }, objects: () => ({ get }) });
	return {
		run,
		scope,
		lease,
		context,
		stop,
		action,
		operation,
		asset,
		result,
		bytes,
		call,
		get,
		write,
		steps,
		perform: () => importer.perform(lease, context, operation, write),
	};
}
it("rechecks one immutable source after download and records the original receipt only after writing", async () => {
	const f = await fixture();
	await expect(f.perform()).resolves.toEqual(f.result);
	expect(f.steps).toEqual(["authorize", "get", "authorize", "write", "confirm"]);
	expect(f.call).toHaveBeenCalledWith(
		"qorpera_native_office_file_import",
		expect.objectContaining({
			p_receipt_id: f.context.receiptId,
			p_idempotency_sha256: createHash("sha256").update(f.context.idempotencyKey).digest("hex"),
			p_action: "confirm",
		}),
		expect.any(AbortSignal),
	);
	expect(f.get).toHaveBeenCalledWith(`${f.scope.companyId}/${f.asset.sha256}`);
	expect(f.write).toHaveBeenCalledExactlyOnceWith(
		{ path: f.action.destination.path, bytes: f.bytes, sha256: f.asset.sha256 },
		expect.any(AbortSignal),
	);
});
it.each(["member_device", "company_file", "isolated_worker", "company_computer"])(
	"refuses implicit source realm %s",
	(realm) => {
		expect(() =>
			parseCompanyComputerFileImport({
				kind: "transfer",
				action: "import",
				source: { realm, assetId: randomUUID(), sha256: "a".repeat(64) },
				destination: { realm: "company_computer", path: "a" },
			}),
		).toThrow();
	},
);
it("refuses raw hashes, malformed destinations and arbitrary flags", async () => {
	const f = await fixture();
	for (const action of [
		{ ...f.action, overwrite: true },
		{ ...f.action, source: { realm: "object_storage", sha256: f.asset.sha256 } },
		{ ...f.action, destination: { realm: "company_computer", path: "../secret" } },
	])
		expect(() => parseCompanyComputerFileImport(action)).toThrow();
});
it.each(["source", "destination"] as const)(
	"refuses an isolated-worker %s before source reads or workbench writes",
	async (side) => {
		const f = await fixture();
		Object.assign(f.operation.arguments[side], { realm: "isolated_worker" });
		await expect(f.perform()).rejects.toThrow("INVALID_CLOUD_FILE_TRANSFER_REALM");
		expect(f.call).not.toHaveBeenCalled();
		expect(f.get).not.toHaveBeenCalled();
		expect(f.write).not.toHaveBeenCalled();
	},
);
it.each(["assetId", "sha256"])("rejects mismatched authorized %s before storage I/O", async (field) => {
	const f = await fixture();
	Object.assign(f.asset, { [field]: field === "assetId" ? randomUUID() : "b".repeat(64) });
	await expect(f.perform()).rejects.toThrow("OFFICE_IMPORT_SOURCE_CHANGED");
	expect(f.get).not.toHaveBeenCalled();
	expect(f.write).not.toHaveBeenCalled();
});
it("refuses changed download bytes before the second authority check or write", async () => {
	const f = await fixture();
	f.get.mockResolvedValueOnce(Uint8Array.from([1, 2, 3, 4]));
	await expect(f.perform()).rejects.toThrow("OFFICE_IMPORT_SOURCE_CHANGED");
	expect(f.write).not.toHaveBeenCalled();
	expect(f.call).toHaveBeenCalledOnce();
});
it("refuses revocation or altered source metadata after slow object I/O", async () => {
	const f = await fixture();
	f.call.mockResolvedValueOnce(f.asset).mockRejectedValueOnce(new Error("REVOKED"));
	await expect(f.perform()).rejects.toThrow("REVOKED");
	expect(f.write).not.toHaveBeenCalled();
	const g = await fixture();
	g.call.mockResolvedValueOnce(g.asset).mockResolvedValueOnce({ ...g.asset, mediaType: "text/plain" });
	await expect(g.perform()).rejects.toThrow("OFFICE_IMPORT_SOURCE_CHANGED");
	expect(g.write).not.toHaveBeenCalled();
});
it("does not confirm or retry a rejected physical installation", async () => {
	const f = await fixture();
	f.write.mockRejectedValueOnce(new Error("EEXIST"));
	await expect(f.perform()).rejects.toThrow("EEXIST");
	expect(f.steps).toEqual(["authorize", "get", "authorize"]);
	expect(f.write).toHaveBeenCalledOnce();
});
it("cancellation after physical write leaves confirmation unknown without replaying the write", async () => {
	const f = await fixture();
	f.write.mockImplementationOnce(async () => {
		f.stop.abort();
	});
	await expect(f.perform()).rejects.toThrow();
	expect(f.call).toHaveBeenCalledTimes(2);
	expect(f.write).toHaveBeenCalledOnce();
});
it.each(["transferId", "bytes", "destination", "mediaType"])("rejects a mismatched confirmed %s", async (field) => {
	const f = await fixture();
	Object.assign(f.result, {
		[field]:
			field === "bytes"
				? 99
				: field === "destination"
					? { ...f.result.destination, screenId: randomUUID() }
					: field === "transferId"
						? randomUUID()
						: "text/plain",
	});
	await expect(f.perform()).rejects.toThrow();
	expect(f.write).toHaveBeenCalledOnce();
});
it("copies operation and downloaded bytes across awaited callbacks", async () => {
	const f = await fixture();
	f.write.mockImplementationOnce(async (file) => {
		expect(file.bytes).not.toBe(f.bytes);
		f.operation.arguments.destination.path = "changed";
	});
	await expect(f.perform()).resolves.toEqual(f.result);
});

async function companyFileFixture() {
	const f = await fixture();
	const source = { realm: "company_file" as const, path: "Shared/report.bin", version: randomUUID() };
	f.operation.arguments.source = source;
	const manifest = new TextEncoder().encode(
		JSON.stringify({
			schema: "qorpera.cloud-file-manifest/v1",
			fileSha256: f.asset.sha256,
			bytes: f.bytes.length,
			mediaType: "application/octet-stream",
			chunks: [{ sha256: f.asset.sha256, bytes: f.bytes.length }],
		}),
	);
	const authorized = {
		schema: "qorpera.company-file-transfer-source/v1",
		companyId: f.scope.companyId,
		environmentId: f.scope.environmentId,
		source,
		sha256: f.asset.sha256,
		manifestSha256: createHash("sha256").update(manifest).digest("hex"),
		manifestBytes: manifest.length,
		bytes: f.bytes.length,
		mediaType: "application/octet-stream",
	};
	const result = {
		...f.result,
		source: {
			...source,
			assetId: randomUUID(),
			sha256: authorized.sha256,
			manifestSha256: authorized.manifestSha256,
		},
	};
	f.call.mockImplementation(async (_method, args) => {
		f.steps.push(String(args.p_action));
		return structuredClone(args.p_action === "authorize" ? authorized : result);
	});
	f.get
		.mockImplementation(async () => {
			f.steps.push("get");
			return manifest;
		})
		.mockResolvedValueOnce(manifest)
		.mockResolvedValueOnce(f.bytes);
	return { ...f, source, authorized, result, manifest };
}
it("imports the authorized binary Company File version and confirms its immutable source closure", async () => {
	const f = await companyFileFixture();
	await expect(f.perform()).resolves.toEqual(f.result);
	expect(f.call).toHaveBeenCalledTimes(3);
	expect(f.get).toHaveBeenCalledTimes(2);
	expect(f.write).toHaveBeenCalledExactlyOnceWith(
		{ path: f.action.destination.path, bytes: f.bytes, sha256: f.authorized.sha256 },
		expect.any(AbortSignal),
	);
	expect(f.steps.filter((step) => step !== "get")).toEqual(["authorize", "authorize", "write", "confirm"]);
});
it.each(["companyId", "environmentId", "source"])(
	"refuses an authorized Company File %s mismatch before reading",
	async (field) => {
		const f = await companyFileFixture();
		Object.assign(f.authorized, {
			[field]: field === "source" ? { ...f.source, version: randomUUID() } : randomUUID(),
		});
		await expect(f.perform()).rejects.toThrow("OFFICE_IMPORT_SOURCE_CHANGED");
		expect(f.get).not.toHaveBeenCalled();
		expect(f.write).not.toHaveBeenCalled();
	},
);
it("rechecks Company File version and grant after binary download", async () => {
	const f = await companyFileFixture();
	f.call.mockResolvedValueOnce(f.authorized).mockRejectedValueOnce(new Error("PATH_VERSION_CHANGED"));
	await expect(f.perform()).rejects.toThrow("PATH_VERSION_CHANGED");
	expect(f.write).not.toHaveBeenCalled();
});
it.each(["version", "path", "sha256", "manifestSha256"])(
	"rejects changed Company File confirmation %s",
	async (field) => {
		const f = await companyFileFixture();
		Object.assign(f.result.source, {
			[field]: field === "path" ? "another.bin" : field === "version" ? randomUUID() : "b".repeat(64),
		});
		await expect(f.perform()).rejects.toThrow("OFFICE_IMPORT_UNCONFIRMED");
		expect(f.write).toHaveBeenCalledOnce();
	},
);
