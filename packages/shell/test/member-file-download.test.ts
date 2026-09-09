import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudMemberCompanyFileDownload } from "@qorpera/cloud-client/cloud-member-company-file";
import type { CloudMemberFileExportDownload } from "@qorpera/cloud-client/cloud-member-file-exports";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveSelectedMemberExport, saveSelectedMemberFile } from "../src/member-file-download.ts";

const version = "00000000-0000-4000-8000-000000000001";
const selection = { realm: "company_file", path: "documents/æble.bin", version } as const;
const roots: string[] = [];
const exportSelection = { realm: "object_storage", assetId: version, sha256: "a".repeat(64) } as const;
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(bytes = Buffer.from([0, 255, 128, 10, 1])) {
	const root = await mkdtemp(join(tmpdir(), "qorpera-member-download-"));
	roots.push(root);
	const destination = join(root, "chosen.bin"),
		controller = new AbortController(),
		state = { current: true };
	const file: CloudMemberCompanyFileDownload = {
		source: {
			...selection,
			companyId: version,
			environmentId: version,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			manifestSha256: "a".repeat(64),
		},
		bytes,
		mediaType: "application/octet-stream",
	};
	const chooseDestination = vi.fn<Parameters<typeof saveSelectedMemberFile>[0]["chooseDestination"]>(
		async () => destination,
	);
	const download = vi.fn<Parameters<typeof saveSelectedMemberFile>[0]["download"]>(async () => file);
	const options = {
		selection: { ...selection } as { realm: "company_file"; path: string; version: string },
		signal: controller.signal,
		current: () => state.current,
		chooseDestination,
		download,
	};
	return {
		root,
		destination,
		file,
		options,
		state,
		controller,
		chooseDestination,
		download,
		save: () => saveSelectedMemberFile(options),
	};
}

describe("native member file save", () => {
	it.each([Buffer.from([0, 255, 128, 10, 1]), Buffer.alloc(0)])(
		"writes the verified binary bytes only to the selected destination",
		async (bytes) => {
			const f = await fixture(bytes),
				result = await f.save();
			expect(f.chooseDestination).toHaveBeenCalledWith("æble.bin");
			expect(f.download).toHaveBeenCalledWith(selection, f.controller.signal);
			expect(await readFile(f.destination)).toEqual(bytes);
			expect(await readdir(f.root)).toEqual(["chosen.bin"]);
			expect(result).toEqual({ saved: true, source: f.file.source, bytes: bytes.length });
			expect(JSON.stringify(result)).not.toContain(f.root);
		},
	);
	it("allows replacing the exact name confirmed by the chooser and preserves a symlink target", async () => {
		const f = await fixture(),
			victim = join(f.root, "existing.bin");
		await writeFile(victim, "original");
		await symlink(victim, f.destination);
		await f.save();
		expect(await readFile(victim, "utf8")).toBe("original");
		expect(await readFile(f.destination)).toEqual(Buffer.from(f.file.bytes));
	});
	it("does not fetch or write when the member cancels", async () => {
		const f = await fixture();
		f.chooseDestination.mockResolvedValue(null);
		expect(await f.save()).toEqual({ saved: false });
		expect(f.download).not.toHaveBeenCalled();
		expect(await readdir(f.root)).toEqual([]);
	});
	it("keeps an existing destination unchanged when authority or integrity verification fails", async () => {
		const f = await fixture();
		await writeFile(f.destination, "keep");
		f.download.mockRejectedValue(new Error("Selected Company File version changed"));
		await expect(f.save()).rejects.toThrow("version changed");
		expect(await readFile(f.destination, "utf8")).toBe("keep");
		expect(await readdir(f.root)).toEqual(["chosen.bin"]);
	});
	it.each([
		null,
		{ ...selection, realm: "member_device" },
		{ ...selection, path: "../local" },
		{ ...selection, version: null },
		{ ...selection, destination: "/private/other" },
	])("rejects a malformed selection before opening the chooser", async (value) => {
		const f = await fixture();
		await expect(saveSelectedMemberFile({ ...f.options, selection: value })).rejects.toThrow();
		expect(f.chooseDestination).not.toHaveBeenCalled();
		expect(f.download).not.toHaveBeenCalled();
	});
	it("copies the selection before the chooser can yield", async () => {
		const f = await fixture();
		f.chooseDestination.mockImplementation(async () => {
			f.options.selection.path = "documents/other.bin";
			return f.destination;
		});
		await f.save();
		expect(f.download).toHaveBeenCalledWith(selection, f.controller.signal);
	});
	it.each(["member-change", "window-close"])("refuses a %s during the chooser before any cloud I/O", async (mode) => {
		const f = await fixture();
		f.chooseDestination.mockImplementation(async () => {
			if (mode === "member-change") f.state.current = false;
			else f.controller.abort();
			return f.destination;
		});
		await expect(f.save()).rejects.toThrow();
		expect(f.download).not.toHaveBeenCalled();
		expect(await readdir(f.root)).toEqual([]);
	});
	it.each(["member-change", "window-close"])(
		"keeps the destination intact after a %s during download",
		async (mode) => {
			const f = await fixture();
			await writeFile(f.destination, "keep");
			f.download.mockImplementation(async () => {
				if (mode === "member-change") f.state.current = false;
				else f.controller.abort();
				return f.file;
			});
			await expect(f.save()).rejects.toThrow();
			expect(await readFile(f.destination, "utf8")).toBe("keep");
			expect(await readdir(f.root)).toEqual(["chosen.bin"]);
		},
	);
	it("refuses a returned source with a different selected version before writing", async () => {
		const f = await fixture();
		f.file.source.version = "00000000-0000-4000-8000-000000000002";
		await expect(f.save()).rejects.toThrow("identity changed");
		expect(await readdir(f.root)).toEqual([]);
	});
	it("does not expose a native destination in a filesystem error", async () => {
		const f = await fixture();
		f.chooseDestination.mockResolvedValue(join(f.root, "missing", "chosen.bin"));
		await expect(f.save()).rejects.toThrow("The download could not be saved. Check the destination and try again.");
		expect(await readdir(f.root)).toEqual([]);
	});
});

describe("native shared export save", () => {
	async function exported(bytes = Buffer.from([0, 255, 128])) {
		const f = await fixture(bytes);
		const file: CloudMemberFileExportDownload = {
			source: { ...exportSelection, companyId: version, environmentId: version },
			bytes,
			asset: {
				schema: "qorpera.file-transfer-asset/v1",
				assetId: version,
				sha256: exportSelection.sha256,
				bytes: bytes.length,
				mediaType: "application/octet-stream",
				source: {
					realm: "company_computer",
					path: "exports/report.bin",
					companyComputerId: version,
					screenId: version,
				},
				destination: { realm: "object_storage" },
			},
		};
		const download = vi.fn<Parameters<typeof saveSelectedMemberExport>[0]["download"]>(async () => file);
		const options = {
			...f.options,
			selection: { ...exportSelection, assetId: String(exportSelection.assetId) },
			name: file.asset.source.path,
			download,
		};
		return { ...f, file, download, options, save: () => saveSelectedMemberExport(options) };
	}
	it.each([Buffer.alloc(0), Buffer.from([0, 255, 128])])(
		"saves verified exports without returning native paths",
		async (bytes) => {
			const f = await exported(bytes);
			expect(await f.save()).toEqual({ saved: true, source: f.file.source, bytes: bytes.length });
			expect(f.chooseDestination).toHaveBeenCalledWith("report.bin");
			expect(f.download).toHaveBeenCalledWith(exportSelection, f.controller.signal);
			expect(await readFile(f.destination)).toEqual(bytes);
			expect(await readdir(f.root)).toEqual(["chosen.bin"]);
		},
	);
	it("cancels before cloud access and snapshots source before the chooser yields", async () => {
		const f = await exported();
		f.chooseDestination.mockResolvedValueOnce(null);
		expect(await f.save()).toEqual({ saved: false });
		expect(f.download).not.toHaveBeenCalled();
		f.chooseDestination.mockImplementation(async () => {
			f.options.selection.assetId = "00000000-0000-4000-8000-000000000002";
			return f.destination;
		});
		await f.save();
		expect(f.download).toHaveBeenCalledWith(exportSelection, f.controller.signal);
	});
	it.each(["revoked", "member-change", "window-close", "source-change", "asset-change"])(
		"preserves an existing destination on %s",
		async (mode) => {
			const f = await exported();
			await writeFile(f.destination, "keep");
			f.download.mockImplementation(async () => {
				if (mode === "revoked") throw new Error("Access unavailable");
				if (mode === "member-change") f.state.current = false;
				if (mode === "window-close") f.controller.abort();
				if (mode === "source-change") f.file.source.sha256 = "b".repeat(64);
				if (mode === "asset-change") f.file.asset.assetId = "00000000-0000-4000-8000-000000000002";
				return f.file;
			});
			await expect(f.save()).rejects.toThrow();
			expect(await readFile(f.destination, "utf8")).toBe("keep");
			expect(await readdir(f.root)).toEqual(["chosen.bin"]);
		},
	);
	it.each([
		{ ...exportSelection, path: "/local" },
		{ ...exportSelection, realm: "member_device" },
	])("rejects renderer filesystem selections", async (selection) => {
		const f = await exported();
		await expect(saveSelectedMemberExport({ ...f.options, selection })).rejects.toThrow();
		expect(f.chooseDestination).not.toHaveBeenCalled();
		expect(f.download).not.toHaveBeenCalled();
	});
});
