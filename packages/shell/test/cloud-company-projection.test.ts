import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimCompanyRuntimeLock, releaseCompanyRuntimeLock, scaffoldCompany } from "@qorpera/pi-coding-agent/company";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CloudCompanyProjection,
	cloudCompanyProjectionHasPersistedChanges,
	cloudCompanyProjectionRoot,
} from "../src/cloud-company-projection.ts";

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
		await writeFile(join(root, "authority.toml"), "[tools]\n", "utf-8");
		await mkdir(join(root, "inbox"), { recursive: true });
		await writeFile(join(root, "inbox", "event.json"), "operational\n", "utf-8");
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
			expect(existsSync(join(projectionRoot, "authority.toml"))).toBe(false);
			await expect(readFile(join(projectionRoot, "inbox", "event.json"), "utf-8")).resolves.toBe("operational\n");
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
			await projection.refresh();
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
				await restarted.refresh();
				await expect(readFile(join(projectionRoot, "company.md"), "utf-8")).resolves.toBe("survives restart\n");
				await expect(
					cloudCompanyProjectionHasPersistedChanges({
						companyRoot: root,
						projectionRoot,
						userData,
						profileId: "11111111-1111-4111-8111-111111111111",
					}),
				).resolves.toBe(true);
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

	it("migrates the legacy folder name without losing a pending Explorer edit", async () => {
		const parent = await temporaryDirectory();
		const root = join(parent, "company");
		const userData = await temporaryDirectory();
		const profileId = "11111111-1111-4111-8111-111111111111";
		const legacyRoot = join(userData, "company-file-projections", profileId, "Company File");
		const projectionRoot = cloudCompanyProjectionRoot(userData, profileId);
		scaffoldCompany(root);
		await writeFile(join(root, "company.md"), "canonical\n", "utf-8");
		const runtimeLock = claimCompanyRuntimeLock(root);
		const first = new CloudCompanyProjection({
			companyRoot: root,
			projectionRoot: legacyRoot,
			userData,
			profileId,
			canWrite: () => true,
			onChanged: async () => undefined,
			runtimeLock,
		});
		try {
			await first.refresh();
			first.close();
			await new Promise((resolve) => setTimeout(resolve, 250));
			await writeFile(join(legacyRoot, "company.md"), "pending edit\n", "utf-8");

			const migrated = new CloudCompanyProjection({
				companyRoot: root,
				projectionRoot,
				userData,
				profileId,
				canWrite: () => true,
				onChanged: async () => undefined,
				runtimeLock,
			});
			try {
				expect(migrated.path).toBe(projectionRoot);
				expect(existsSync(legacyRoot)).toBe(false);
				await migrated.refresh();
				await expect(readFile(join(projectionRoot, "company.md"), "utf-8")).resolves.toBe("pending edit\n");
				await expect(
					cloudCompanyProjectionHasPersistedChanges({ companyRoot: root, projectionRoot, userData, profileId }),
				).resolves.toBe(true);
				await migrated.importChanges();
				await expect(readFile(join(root, "company.md"), "utf-8")).resolves.toBe("pending edit\n");
			} finally {
				migrated.close();
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

	it("rolls back a partially installed Explorer import and retries the durable delta", async () => {
		const parent = await temporaryDirectory();
		const root = join(parent, "company");
		const projectionRoot = join(parent, "projection", "Company File");
		const userData = await temporaryDirectory();
		scaffoldCompany(root);
		await writeFile(join(root, "a.md"), "base a\n", "utf-8");
		await writeFile(join(root, "b.md"), "base b\n", "utf-8");
		const runtimeLock = claimCompanyRuntimeLock(root);
		let interrupt = true;
		const projection = new CloudCompanyProjection({
			companyRoot: root,
			projectionRoot,
			userData,
			profileId: "11111111-1111-4111-8111-111111111111",
			canWrite: () => true,
			onChanged: async () => undefined,
			afterImportRootApply: async () => {
				if (interrupt) throw new Error("simulated process stop during Explorer import");
			},
			runtimeLock,
		});
		try {
			await projection.refresh();
			await writeFile(join(projectionRoot, "a.md"), "edited a\n", "utf-8");
			await writeFile(join(projectionRoot, "b.md"), "edited b\n", "utf-8");
			await expect(projection.importChanges()).rejects.toThrow("simulated process stop");
			await expect(readFile(join(root, "a.md"), "utf-8")).resolves.toBe("base a\n");
			await expect(readFile(join(root, "b.md"), "utf-8")).resolves.toBe("base b\n");
			expect(projection.hasPendingChanges()).toBe(true);
			interrupt = false;
			await projection.importChanges();
			await expect(readFile(join(root, "a.md"), "utf-8")).resolves.toBe("edited a\n");
			await expect(readFile(join(root, "b.md"), "utf-8")).resolves.toBe("edited b\n");
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

	it("handles file and directory kind changes in both directions", async () => {
		const parent = await temporaryDirectory();
		const root = join(parent, "company");
		const projectionRoot = join(parent, "projection", "Company File");
		const userData = await temporaryDirectory();
		scaffoldCompany(root);
		await mkdir(join(root, "records"), { recursive: true });
		await writeFile(join(root, "records", "old.md"), "old\n", "utf-8");
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
			await rm(join(projectionRoot, "records"), { recursive: true });
			await writeFile(join(projectionRoot, "records"), "now a file\n", "utf-8");
			await projection.importChanges();
			await expect(readFile(join(root, "records"), "utf-8")).resolves.toBe("now a file\n");

			await rm(join(projectionRoot, "records"));
			await mkdir(join(projectionRoot, "records"));
			await writeFile(join(projectionRoot, "records", "new.md"), "now a folder\n", "utf-8");
			await projection.importChanges();
			await expect(readFile(join(root, "records", "new.md"), "utf-8")).resolves.toBe("now a folder\n");
		} finally {
			projection.close();
			releaseCompanyRuntimeLock(runtimeLock);
		}
	});

	it("does not import its own partial refresh while the mirror is in progress", async () => {
		const parent = await temporaryDirectory();
		const root = join(parent, "company");
		const projectionRoot = join(parent, "projection", "Company File");
		const userData = await temporaryDirectory();
		scaffoldCompany(root);
		await writeFile(join(root, "company.md"), "base\n", "utf-8");
		const runtimeLock = claimCompanyRuntimeLock(root);
		let blockRefresh = false;
		let releaseRefresh: (() => void) | undefined;
		let reachedRefresh: (() => void) | undefined;
		const refreshGate = new Promise<void>((resolve) => {
			releaseRefresh = resolve;
		});
		const refreshReached = new Promise<void>((resolve) => {
			reachedRefresh = resolve;
		});
		const onChanged = vi.fn(async () => undefined);
		const projection = new CloudCompanyProjection({
			companyRoot: root,
			projectionRoot,
			userData,
			profileId: "11111111-1111-4111-8111-111111111111",
			canWrite: () => true,
			onChanged,
			beforeRefreshCommit: async () => {
				if (!blockRefresh) return;
				reachedRefresh?.();
				await refreshGate;
			},
			runtimeLock,
		});
		try {
			await projection.refresh();
			await writeFile(join(root, "company.md"), "new canonical\n", "utf-8");
			await writeFile(join(root, "second.md"), "new file\n", "utf-8");
			blockRefresh = true;
			const refreshing = projection.refresh();
			await refreshReached;
			await new Promise((resolve) => setTimeout(resolve, 750));
			expect(onChanged).not.toHaveBeenCalled();
			await expect(readFile(join(root, "second.md"), "utf-8")).resolves.toBe("new file\n");
			releaseRefresh?.();
			await refreshing;
			await expect(readFile(join(projectionRoot, "second.md"), "utf-8")).resolves.toBe("new file\n");
		} finally {
			releaseRefresh?.();
			projection.close();
			releaseCompanyRuntimeLock(runtimeLock);
		}
	});

	it("preserves an Explorer edit that lands while a staged refresh is waiting", async () => {
		const parent = await temporaryDirectory();
		const root = join(parent, "company");
		const projectionRoot = join(parent, "projection", "Company File");
		const userData = await temporaryDirectory();
		scaffoldCompany(root);
		await writeFile(join(root, "company.md"), "base\n", "utf-8");
		const runtimeLock = claimCompanyRuntimeLock(root);
		let blockRefresh = false;
		let releaseRefresh: (() => void) | undefined;
		let reachedRefresh: (() => void) | undefined;
		const refreshGate = new Promise<void>((resolve) => {
			releaseRefresh = resolve;
		});
		const refreshReached = new Promise<void>((resolve) => {
			reachedRefresh = resolve;
		});
		const projection = new CloudCompanyProjection({
			companyRoot: root,
			projectionRoot,
			userData,
			profileId: "11111111-1111-4111-8111-111111111111",
			canWrite: () => true,
			onChanged: async () => undefined,
			beforeRefreshCommit: async () => {
				if (!blockRefresh) return;
				reachedRefresh?.();
				await refreshGate;
			},
			runtimeLock,
		});
		try {
			await projection.refresh();
			await writeFile(join(root, "remote.md"), "remote\n", "utf-8");
			blockRefresh = true;
			const refreshing = projection.refresh();
			await refreshReached;
			await writeFile(join(projectionRoot, "company.md"), "native edit\n", "utf-8");
			releaseRefresh?.();
			await refreshing;
			await expect(readFile(join(projectionRoot, "company.md"), "utf-8")).resolves.toBe("native edit\n");
			expect(projection.hasPendingChanges()).toBe(true);
			await projection.importChanges();
			await expect(readFile(join(root, "company.md"), "utf-8")).resolves.toBe("native edit\n");
			await expect(readFile(join(root, "remote.md"), "utf-8")).resolves.toBe("remote\n");
		} finally {
			releaseRefresh?.();
			projection.close();
			releaseCompanyRuntimeLock(runtimeLock);
		}
	});

	it("recovers a refresh stopped after prepare without reclassifying cloud changes as Explorer edits", async () => {
		const parent = await temporaryDirectory();
		const root = join(parent, "company");
		const projectionRoot = join(parent, "projection", "Company File");
		const userData = await temporaryDirectory();
		scaffoldCompany(root);
		await writeFile(join(root, "company.md"), "base\n", "utf-8");
		const runtimeLock = claimCompanyRuntimeLock(root);
		let interrupt = false;
		const projection = new CloudCompanyProjection({
			companyRoot: root,
			projectionRoot,
			userData,
			profileId: "11111111-1111-4111-8111-111111111111",
			canWrite: () => true,
			onChanged: async () => undefined,
			beforeRefreshInstall: async () => {
				if (interrupt) throw new Error("simulated stop before projection install");
			},
			runtimeLock,
		});
		try {
			await projection.refresh();
			await writeFile(join(root, "company.md"), "new cloud bytes\n", "utf-8");
			interrupt = true;
			await expect(projection.refresh()).rejects.toThrow("simulated stop");
			expect(projection.hasPendingChanges()).toBe(false);
			await expect(readFile(join(projectionRoot, "company.md"), "utf-8")).resolves.toBe("base\n");
			interrupt = false;
			await projection.refresh();
			await expect(readFile(join(projectionRoot, "company.md"), "utf-8")).resolves.toBe("new cloud bytes\n");
		} finally {
			projection.close();
			releaseCompanyRuntimeLock(runtimeLock);
		}
	});
});
