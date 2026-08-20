import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimCompanyRuntimeLock, releaseCompanyRuntimeLock, scaffoldCompany } from "@qorpera/pi-coding-agent/company";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudCompanyProjection } from "../src/cloud-company-projection.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "qorpera-company-projection-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("cloud Company File projection", () => {
	it("exposes and imports only the logical Company File surface", async () => {
		const parent = await temporaryDirectory();
		const root = join(parent, "company");
		const projectionRoot = join(parent, "projection", "Company File");
		scaffoldCompany(root);
		await writeFile(join(root, "company.md"), "company\n", "utf-8");
		await mkdir(join(root, "trail"), { recursive: true });
		await writeFile(join(root, "trail", "runtime.jsonl"), "private\n", "utf-8");
		const runtimeLock = claimCompanyRuntimeLock(root);
		const userData = await temporaryDirectory();
		const projection = new CloudCompanyProjection({
			companyRoot: root,
			projectionRoot,
			userData,
			profileId: "11111111-1111-4111-8111-111111111111",
			canWrite: () => true,
			onChanged: async () => undefined,
			runtimeLock,
		});
		try {
			await projection.refresh();
			await expect(readFile(join(projectionRoot, "company.md"), "utf-8")).resolves.toBe("company\n");
			expect(existsSync(join(projectionRoot, "trail"))).toBe(false);
			expect(existsSync(join(projectionRoot, ".git"))).toBe(false);
			await writeFile(join(projectionRoot, "company.md"), "edited\n", "utf-8");
			await writeFile(join(projectionRoot, "new-file.md"), "new\n", "utf-8");
			await projection.importChanges();
			await expect(readFile(join(root, "company.md"), "utf-8")).resolves.toBe("edited\n");
			await expect(readFile(join(root, "new-file.md"), "utf-8")).resolves.toBe("new\n");
		} finally {
			projection.close();
			releaseCompanyRuntimeLock(runtimeLock);
		}
	});

	it("reverts native Explorer edits when the account is read-only", async () => {
		const parent = await temporaryDirectory();
		const root = join(parent, "company");
		const projectionRoot = join(parent, "projection", "Company File");
		scaffoldCompany(root);
		await writeFile(join(root, "company.md"), "canonical\n", "utf-8");
		const runtimeLock = claimCompanyRuntimeLock(root);
		const userData = await temporaryDirectory();
		const projection = new CloudCompanyProjection({
			companyRoot: root,
			projectionRoot,
			userData,
			profileId: "11111111-1111-4111-8111-111111111111",
			canWrite: () => false,
			onChanged: async () => undefined,
			runtimeLock,
		});
		try {
			await projection.refresh();
			await writeFile(join(projectionRoot, "company.md"), "unauthorized\n", "utf-8");
			await vi.waitFor(
				async () => expect(await readFile(join(projectionRoot, "company.md"), "utf-8")).toBe("canonical\n"),
				{ timeout: 3_000 },
			);
			await expect(readFile(join(root, "company.md"), "utf-8")).resolves.toBe("canonical\n");
			await expect(projection.importChanges()).rejects.toThrow("read-only");
		} finally {
			projection.close();
			releaseCompanyRuntimeLock(runtimeLock);
		}
	});

	it("does not refresh over an Explorer edit while the import debounce is pending", async () => {
		const parent = await temporaryDirectory();
		const root = join(parent, "company");
		const projectionRoot = join(parent, "projection", "Company File");
		const userData = await temporaryDirectory();
		scaffoldCompany(root);
		await writeFile(join(root, "company.md"), "canonical\n", "utf-8");
		const runtimeLock = claimCompanyRuntimeLock(root);
		const projection = new CloudCompanyProjection({
			companyRoot: root,
			projectionRoot,
			userData,
			profileId: "11111111-1111-4111-8111-111111111111",
			canWrite: () => true,
			onChanged: async () => undefined,
			runtimeLock,
		});
		try {
			await projection.refresh();
			await writeFile(join(projectionRoot, "company.md"), "pending native edit\n", "utf-8");
			await vi.waitFor(() => expect(projection.hasPendingChanges()).toBe(true));
			await expect(projection.refresh()).rejects.toThrow("pending Explorer changes");
			await expect(readFile(join(projectionRoot, "company.md"), "utf-8")).resolves.toBe("pending native edit\n");
			await projection.importChanges();
			await expect(readFile(join(root, "company.md"), "utf-8")).resolves.toBe("pending native edit\n");
		} finally {
			projection.close();
			releaseCompanyRuntimeLock(runtimeLock);
		}
	});

	it("recovers an Explorer edit made before the watcher debounce after restart", async () => {
		const parent = await temporaryDirectory();
		const root = join(parent, "company");
		const projectionRoot = join(parent, "projection", "Company File");
		const userData = await temporaryDirectory();
		scaffoldCompany(root);
		await writeFile(join(root, "company.md"), "canonical\n", "utf-8");
		const runtimeLock = claimCompanyRuntimeLock(root);
		const options = {
			companyRoot: root,
			projectionRoot,
			userData,
			profileId: "11111111-1111-4111-8111-111111111111",
			canWrite: () => true,
			onChanged: async () => undefined,
			runtimeLock,
		};
		const first = new CloudCompanyProjection(options);
		try {
			await first.refresh();
			await writeFile(join(projectionRoot, "company.md"), "survives restart\n", "utf-8");
			first.close();
			const restarted = new CloudCompanyProjection(options);
			try {
				await expect(restarted.refresh()).rejects.toThrow("pending Explorer changes");
				await expect(readFile(join(projectionRoot, "company.md"), "utf-8")).resolves.toBe("survives restart\n");
				await restarted.importChanges();
				await expect(readFile(join(root, "company.md"), "utf-8")).resolves.toBe("survives restart\n");
			} finally {
				restarted.close();
			}
		} finally {
			first.close();
			releaseCompanyRuntimeLock(runtimeLock);
		}
	});

	it("imports only the Explorer delta and preserves unrelated newer company work", async () => {
		const parent = await temporaryDirectory();
		const root = join(parent, "company");
		const projectionRoot = join(parent, "projection", "Company File");
		const userData = await temporaryDirectory();
		scaffoldCompany(root);
		await writeFile(join(root, "a.md"), "base a\n", "utf-8");
		const runtimeLock = claimCompanyRuntimeLock(root);
		const projection = new CloudCompanyProjection({
			companyRoot: root,
			projectionRoot,
			userData,
			profileId: "11111111-1111-4111-8111-111111111111",
			canWrite: () => true,
			onChanged: async () => undefined,
			runtimeLock,
		});
		try {
			await projection.refresh();
			await writeFile(join(projectionRoot, "a.md"), "explorer a\n", "utf-8");
			await writeFile(join(root, "b.md"), "new agent b\n", "utf-8");
			await projection.importChanges();
			await expect(readFile(join(root, "a.md"), "utf-8")).resolves.toBe("explorer a\n");
			await expect(readFile(join(root, "b.md"), "utf-8")).resolves.toBe("new agent b\n");
		} finally {
			projection.close();
			releaseCompanyRuntimeLock(runtimeLock);
		}
	});

	it("keeps a second Explorer edit pending when it lands after import inspection", async () => {
		const parent = await temporaryDirectory();
		const root = join(parent, "company");
		const projectionRoot = join(parent, "projection", "Company File");
		const userData = await temporaryDirectory();
		scaffoldCompany(root);
		await writeFile(join(root, "company.md"), "base\n", "utf-8");
		const runtimeLock = claimCompanyRuntimeLock(root);
		let releaseApply: (() => void) | undefined;
		let reachedApply: (() => void) | undefined;
		const applyGate = new Promise<void>((resolve) => {
			releaseApply = resolve;
		});
		const applyReached = new Promise<void>((resolve) => {
			reachedApply = resolve;
		});
		const projection = new CloudCompanyProjection({
			companyRoot: root,
			projectionRoot,
			userData,
			profileId: "11111111-1111-4111-8111-111111111111",
			canWrite: () => true,
			onChanged: async () => undefined,
			beforeImportApply: async () => {
				reachedApply?.();
				await applyGate;
			},
			runtimeLock,
		});
		try {
			await projection.refresh();
			await writeFile(join(projectionRoot, "company.md"), "first edit\n", "utf-8");
			const importing = projection.importChanges();
			await applyReached;
			await writeFile(join(projectionRoot, "late.md"), "second edit\n", "utf-8");
			releaseApply?.();
			await importing;
			expect(projection.hasPendingChanges()).toBe(true);
			expect(existsSync(join(root, "late.md"))).toBe(false);
			await projection.importChanges();
			await expect(readFile(join(root, "late.md"), "utf-8")).resolves.toBe("second edit\n");
		} finally {
			projection.close();
			releaseCompanyRuntimeLock(runtimeLock);
		}
	});

	it("reports a same-path conflict without overwriting either side", async () => {
		const parent = await temporaryDirectory();
		const root = join(parent, "company");
		const projectionRoot = join(parent, "projection", "Company File");
		const userData = await temporaryDirectory();
		scaffoldCompany(root);
		await writeFile(join(root, "company.md"), "base\n", "utf-8");
		const runtimeLock = claimCompanyRuntimeLock(root);
		const projection = new CloudCompanyProjection({
			companyRoot: root,
			projectionRoot,
			userData,
			profileId: "11111111-1111-4111-8111-111111111111",
			canWrite: () => true,
			onChanged: async () => undefined,
			runtimeLock,
		});
		try {
			await projection.refresh();
			await writeFile(join(projectionRoot, "company.md"), "explorer\n", "utf-8");
			await writeFile(join(root, "company.md"), "agent\n", "utf-8");
			await expect(projection.importChanges()).rejects.toThrow("conflict");
			await expect(readFile(join(projectionRoot, "company.md"), "utf-8")).resolves.toBe("explorer\n");
			await expect(readFile(join(root, "company.md"), "utf-8")).resolves.toBe("agent\n");
		} finally {
			projection.close();
			releaseCompanyRuntimeLock(runtimeLock);
		}
	});
});
