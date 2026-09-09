import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudMemberCompanyFileClient } from "../src/cloud-member-company-editor.ts";
import { MemberFileUploadSession } from "../src/member-file-upload.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function fixture(bytes = Uint8Array.from([0, 255, 128, 10])) {
	const root = await mkdtemp(join(tmpdir(), "qorpera-member-upload-"));
	roots.push(root);
	const selectedPath = join(root, "æble.bin");
	await writeFile(selectedPath, bytes);
	const controller = new AbortController(),
		state = { current: true };
	const chooseFile = vi.fn(async (): Promise<string | null> => selectedPath);
	const upload = vi.fn<CloudMemberCompanyFileClient["upload"]>(async (input) => ({
		source: {
			realm: "member_file",
			name: input.name,
			bytes: input.bytes.length,
			sha256: sha(input.bytes),
			mediaType: input.mediaType,
		},
		command: {
			commandId: input.operationKey,
			companyId: input.operationKey,
			environmentId: input.operationKey,
			expiresAt: "2099-01-01T00:00:00Z",
			planSha256: "b".repeat(64),
			state: "review_required",
			result: null,
			plan: {
				schema: "qorpera.company-path-mutation/v1",
				path: input.path,
				operationKey: input.operationKey,
				expectedVersion: input.expectedVersion,
				entry: {
					kind: "file",
					path: input.path,
					executable: false,
					file: {
						bytes: input.bytes.length,
						fileSha256: sha(input.bytes),
						manifestSha256: "a".repeat(64),
						mediaType: "application/octet-stream",
					},
				},
			},
		},
	}));
	const session = new MemberFileUploadSession({
		chooseFile,
		upload,
		signal: controller.signal,
		current: () => state.current,
	});
	return { root, selectedPath, bytes, controller, state, chooseFile, upload, session };
}

describe("native selected member upload", () => {
	it.each([0, 4, 8388608])("reads exactly the selected %i bytes and exposes no local path", async (size) => {
		const f = await fixture(new Uint8Array(size).fill(128));
		const selected = (await f.session.choose())!;
		expect(selected).toEqual({ id: expect.any(String), name: "æble.bin", bytes: size, sha256: sha(f.bytes) });
		expect(f.upload).not.toHaveBeenCalled();
		const result = await f.session.submit({ id: selected.id, path: "documents/upload.bin", expectedVersion: null });
		expect(Buffer.from(f.upload.mock.calls[0][0].bytes).equals(f.bytes)).toBe(true);
		expect(JSON.stringify({ selected, result })).not.toContain(f.root);
	});
	it("retains the selected bytes and operation after a lost response even when the source changes", async () => {
		const f = await fixture(),
			selected = (await f.session.choose())!;
		const intent = { id: selected.id, path: "selected.bin", expectedVersion: null };
		f.upload.mockRejectedValueOnce(new Error("Lost response"));
		await expect(f.session.submit(intent)).rejects.toThrow("Lost response");
		await writeFile(f.selectedPath, "Changed since the member chose it");
		await expect(f.session.choose()).rejects.toThrow("exact pending upload");
		await expect(f.session.submit({ ...intent, path: "other.bin" })).rejects.toThrow("exact pending upload");
		await f.session.submit(intent);
		expect(f.chooseFile).toHaveBeenCalledTimes(1);
		expect(f.upload.mock.calls[0][0]).toEqual(f.upload.mock.calls[1][0]);
		expect(f.upload.mock.calls[1][0].bytes).toEqual(f.bytes);
	});
	it("does not submit a cancelled choice", async () => {
		const f = await fixture();
		f.chooseFile.mockResolvedValue(null);
		expect(await f.session.choose()).toBeNull();
		expect(f.upload).not.toHaveBeenCalled();
		await expect(f.session.submit({ id: "unknown", path: "x", expectedVersion: null })).rejects.toThrow();
	});
	it.each(["directory", "symlink", "oversize", "missing"])(
		"refuses a %s without a local path in the error",
		async (kind) => {
			const f = await fixture();
			const candidate = join(f.root, "candidate");
			if (kind === "directory") await mkdir(candidate);
			if (kind === "symlink") await symlink(f.selectedPath, candidate);
			if (kind === "oversize") {
				await writeFile(candidate, "");
				await truncate(candidate, 8388609);
			}
			f.chooseFile.mockResolvedValue(candidate);
			await expect(f.session.choose()).rejects.toThrow(
				"Choose a regular file of at most 8 MiB that is not changing.",
			);
			expect(f.upload).not.toHaveBeenCalled();
		},
	);
	it.each(["revoke", "close"])("fences %s while the native chooser is open", async (kind) => {
		const f = await fixture();
		f.chooseFile.mockImplementation(async () => {
			if (kind === "close") f.controller.abort();
			else f.state.current = false;
			return f.selectedPath;
		});
		await expect(f.session.choose()).rejects.toThrow();
		expect(f.upload).not.toHaveBeenCalled();
	});
	it("serializes chooser and upload requests and discards retained selections on close", async () => {
		const f = await fixture();
		let finish!: (value: string | null) => void;
		f.chooseFile.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const choosing = f.session.choose();
		await expect(f.session.choose()).rejects.toThrow("current upload");
		finish(f.selectedPath);
		const selected = (await choosing)!;
		f.session.clear();
		await expect(f.session.submit({ id: selected.id, path: "x", expectedVersion: null })).rejects.toThrow();
	});
	it("refuses destination substitution and extra filesystem fields before submission", async () => {
		const f = await fixture(),
			selected = (await f.session.choose())!;
		for (const input of [
			{ id: selected.id, path: "../x", expectedVersion: null },
			{ id: selected.id, path: "x", expectedVersion: "bad" },
			{ id: selected.id, path: "x", expectedVersion: null, localPath: f.selectedPath },
		])
			await expect(f.session.submit(input)).rejects.toThrow();
		expect(f.upload).not.toHaveBeenCalled();
	});
});
