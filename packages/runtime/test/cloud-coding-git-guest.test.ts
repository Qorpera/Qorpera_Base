import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	CODING_GIT_SEED_CHUNK_BYTES,
	type CodingGitGuestConfiguration,
	type CodingGitGuestPorts,
	type CodingGitGuestRequest,
	executeCodingGitGuestRepository,
	runCodingGitGuest,
} from "../src/cloud-coding-git-guest.ts";

const exec = promisify(execFile),
	id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
/** `commits` in the seeded base's history; `bytes` of random data in the first. */
async function fixture({ commits = 1, bytes = 0 } = {}) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "coding-git-guest-test-")));
	roots.push(root);
	await mkdir(join(root, "inbox"), { mode: 0o755 });
	await mkdir(join(root, "workspace"), { mode: 0o755 });
	// The session's folders, moved under the test's temporary custody root.
	const folders = {
		workspacePath: join(root, "workspace"),
		homePath: join(root, "home"),
		cachePath: join(root, "cache"),
		outputRoot: join(root, "output"),
	};
	const guest: CodingGitGuestConfiguration = {
		schema: "qorpera.coding-command-guest/v4",
		workerId: id(1),
		vmId: id(2),
		bootId: id(3),
		uid: 1000,
		gid: 1000,
		...folders,
		resourceProfile: {
			maxLogBytes: 67108864,
		},
	};
	const config = join(root, "guest.json");
	await writeFile(config, JSON.stringify(guest), { mode: 0o444 });
	const env = {
		PATH: "/usr/bin:/bin",
		HOME: root,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.invalid",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.invalid",
	};
	const source = join(root, "source");
	await mkdir(source, { mode: 0o755 });
	const gitIn = async (cwd: string, ...args: string[]) =>
		(await exec("/usr/bin/git", args, { cwd, env })).stdout.trim();
	const git = (...args: string[]) => gitIn(source, ...args);
	await git("init", "--template=", ".");
	await writeFile(join(source, "README.md"), "hello\n");
	if (bytes > 0) await writeFile(join(source, "data.bin"), randomBytes(bytes));
	await git("add", ".");
	await git("commit", "-m", "seed");
	for (let commit = 1; commit < commits; commit++) {
		await writeFile(join(source, "README.md"), `hello ${commit}\n`);
		await git("commit", "-am", `base ${commit}`);
	}
	const headSha = await git("rev-parse", "HEAD"),
		ref = `refs/heads/qorpera/coding/${id(1)}`;
	await git("update-ref", ref, headSha);
	await git("bundle", "create", join(root, "source.bundle"), ref);
	const bundle = await readFile(join(root, "source.bundle"));
	const request: CodingGitGuestRequest = {
		schema: "qorpera.coding-git-transfer/v1",
		workerId: id(1),
		vmId: id(2),
		transferId: id(4),
		action: "seed",
		repository: { host: "github.com", owner: "qorpera", name: "example", baseBranch: "main" },
		headSha,
		bundleBytes: bundle.length,
		bundleSha256: createHash("sha256").update(bundle).digest("hex"),
	};
	const execute = (input: CodingGitGuestRequest, configuration: CodingGitGuestConfiguration, directory: string) =>
		executeCodingGitGuestRepository(
			input,
			configuration,
			directory,
			process.platform === "linux"
				? undefined
				: async (args, cwd, environment) =>
						(await exec("/usr/bin/git", [...args], { cwd, env: environment, encoding: "buffer" })).stdout,
		);
	const ports: CodingGitGuestPorts = {
		assertStorage: async () => undefined,
		root,
		configurationPath: config,
		folders,
		protectedUid: process.getuid?.(),
		protectedDirectoryRoot: root,
		inspectMachine: async () => guest.bootId,
		execute,
	};
	const stage = async (input = request) => {
		await writeFile(join(root, "inbox", `${input.transferId}.git.json`), JSON.stringify(input), { mode: 0o444 });
		await runCodingGitGuest("prepare", id(1), input.transferId, ports);
	};
	const seed = async () => {
		await stage();
		for (let index = 0; index < Math.ceil(bundle.length / CODING_GIT_SEED_CHUNK_BYTES); index++)
			await writeFile(
				join(root, "git", request.transferId, `${String(index).padStart(6, "0")}.base64`),
				bundle
					.subarray(index * CODING_GIT_SEED_CHUNK_BYTES, (index + 1) * CODING_GIT_SEED_CHUNK_BYTES)
					.toString("base64"),
				{ mode: 0o444 },
			);
		return runCodingGitGuest("seed", id(1), request.transferId, ports);
	};
	/** Export `headSha` as a new transfer; the bundle and its prerequisites. */
	const exported = async (transferId: string, headSha = request.headSha) => {
		const input = { ...request, action: "export" as const, transferId, headSha, bundleSha256: null, bundleBytes: 0 };
		await stage(input);
		const receipt = await runCodingGitGuest("export", id(1), transferId, ports);
		const parts: Buffer[] = [];
		for (let index = 0; index < (receipt?.chunkCount ?? 0); index++)
			parts.push(await readFile(join(root, "git", transferId, `${String(index).padStart(6, "0")}.bundle`)));
		const output = Buffer.concat(parts),
			file = join(root, `${transferId}.bundle`);
		await writeFile(file, output);
		const header = output.subarray(0, output.indexOf("\n\n")).toString().split("\n");
		return {
			receipt,
			file,
			prerequisites: header.filter((line) => line.startsWith("-")).map((line) => line.slice(1, 41)),
			heads: header.filter((line) => /^[0-9a-f]{40} /.test(line)),
		};
	};
	const workspace = (...args: string[]) => gitIn(folders.workspacePath, ...args);
	return { root, guest, request, bundle, ports, stage, seed, config, git, workspace, exported };
}
describe("protected credential-free guest Git transfer", () => {
	it("seeds real files and the fixed worker branch, then exports a complete bundle through protected chunks", async () => {
		const f = await fixture();
		const seeded = await f.seed();
		expect(seeded?.bundleSha256).toBe(f.request.bundleSha256);
		expect(await readFile(join(f.guest.workspacePath, "README.md"), "utf8")).toBe("hello\n");
		expect(await readFile(join(f.guest.workspacePath, ".git", "HEAD"), "utf8")).toBe(
			`ref: refs/heads/qorpera/coding/${f.request.workerId}\n`,
		);
		const request = {
			...f.request,
			action: "export" as const,
			transferId: id(5),
			bundleSha256: null,
			bundleBytes: 0,
		};
		await f.stage(request);
		const receipt = await runCodingGitGuest("export", id(1), request.transferId, f.ports);
		const output = await readFile(join(f.root, "git", request.transferId, "000000.bundle"));
		expect(createHash("sha256").update(output).digest("hex")).toBe(receipt?.bundleSha256);
		expect(await runCodingGitGuest("export", id(1), request.transferId, f.ports)).toEqual(receipt);
	});
	it("ignores malicious workspace Git config during export", async () => {
		const f = await fixture();
		await f.seed();
		await writeFile(
			join(f.guest.workspacePath, ".git", "config"),
			'[core]\nrepositoryFormatVersion = 999\n[remote "origin"]\nurl = ext::evil\n',
		);
		const request = {
			...f.request,
			action: "export" as const,
			transferId: id(5),
			bundleSha256: null,
			bundleBytes: 0,
		};
		await f.stage(request);
		expect((await runCodingGitGuest("export", id(1), request.transferId, f.ports))?.headSha).toBe(request.headSha);
	});
	it("cannot reseed a modified workspace with a fresh transfer identity", async () => {
		const f = await fixture();
		await f.seed();
		await writeFile(join(f.guest.workspacePath, "README.md"), "keep my edits\n");
		await expect(runCodingGitGuest("seed", id(1), f.request.transferId, f.ports)).resolves.toMatchObject({
			action: "seed",
		});
		const changed = { ...f.request, transferId: id(8) };
		await f.stage(changed);
		await writeFile(join(f.root, "git", changed.transferId, "000000.base64"), f.bundle.toString("base64"), {
			mode: 0o444,
		});
		await expect(runCodingGitGuest("seed", id(1), changed.transferId, f.ports)).rejects.toThrow();
		expect(await readFile(join(f.guest.workspacePath, "README.md"), "utf8")).toBe("keep my edits\n");
	});
	it("rejects a digest mismatch before initializing any Git repository", async () => {
		const f = await fixture();
		f.request.bundleSha256 = "f".repeat(64);
		await expect(f.seed()).rejects.toThrow("CODING_GIT_SEED_DIGEST_CHANGED");
		await expect(readFile(join(f.guest.workspacePath, ".git", "HEAD"))).rejects.toThrow();
	});
	it("refuses a changed repository export or changed branch", async () => {
		const f = await fixture();
		await f.seed();
		const request = {
			...f.request,
			action: "export" as const,
			transferId: id(5),
			bundleSha256: null,
			bundleBytes: 0,
			repository: { ...f.request.repository, name: "elsewhere" },
		};
		await f.stage(request);
		await expect(runCodingGitGuest("export", id(1), request.transferId, f.ports)).rejects.toThrow(
			"CODING_GIT_GUEST_REPOSITORY_CHANGED",
		);
		const normal = { ...request, transferId: id(6), repository: f.request.repository };
		await f.stage(normal);
		await writeFile(join(f.guest.workspacePath, ".git", "HEAD"), "ref: refs/heads/other\n");
		await expect(runCodingGitGuest("export", id(1), normal.transferId, f.ports)).rejects.toThrow(
			"CODING_GIT_BRANCH_CHANGED",
		);
	});
	it("does not rerun an uncertain export child", async () => {
		const f = await fixture();
		await f.seed();
		let attempts = 0;
		f.ports.execute = async () => {
			attempts++;
			throw new Error("lost child result");
		};
		const request = {
			...f.request,
			action: "export" as const,
			transferId: id(5),
			bundleSha256: null,
			bundleBytes: 0,
		};
		await f.stage(request);
		await expect(runCodingGitGuest("export", id(1), request.transferId, f.ports)).rejects.toThrow();
		await expect(runCodingGitGuest("export", id(1), request.transferId, f.ports)).rejects.toThrow();
		expect(attempts).toBe(1);
	});
	it("rejects writable guest configuration and a reboot", async () => {
		const f = await fixture();
		await f.stage();
		await chmod(f.config, 0o644);
		await expect(runCodingGitGuest("seed", id(1), f.request.transferId, f.ports)).rejects.toThrow(
			"CODING_GIT_GUEST_CONFIG_MODE",
		);
		await chmod(f.config, 0o444);
		f.ports.inspectMachine = async () => id(9);
		await expect(runCodingGitGuest("seed", id(1), f.request.transferId, f.ports)).rejects.toThrow(
			"CODING_GIT_GUEST_BOOT_CHANGED",
		);
	});
	it("exports while the session's own commands keep running", async () => {
		// A session standing by keeps its servers and long commands running while
		// a turn publishes; the export bundles the exact submitted commit.
		const f = await fixture();
		await f.seed();
		const request = {
			...f.request,
			action: "export" as const,
			transferId: id(5),
			bundleSha256: null,
			bundleBytes: 0,
		};
		await f.stage(request);
		expect((await runCodingGitGuest("export", id(1), request.transferId, f.ports))?.headSha).toBe(request.headSha);
	});
	it("exports from a volume seeded on an earlier machine of the member", async () => {
		const f = await fixture();
		await f.seed();
		// The session's folders outlived the machine that seeded them; this turn runs on another.
		await chmod(f.config, 0o644);
		await writeFile(f.config, JSON.stringify({ ...f.guest, vmId: id(7) }));
		await chmod(f.config, 0o444);
		const request = {
			...f.request,
			vmId: id(7),
			action: "export" as const,
			transferId: id(5),
			bundleSha256: null,
			bundleBytes: 0,
		};
		await f.stage(request);
		expect(await runCodingGitGuest("export", id(1), request.transferId, f.ports)).toMatchObject({
			vmId: id(7),
			headSha: request.headSha,
		});
	});
	it("takes a seed in chunks as large as an LXD file push", async () => {
		const f = await fixture({ bytes: 300000 });
		expect(f.bundle.length).toBeGreaterThan(CODING_GIT_SEED_CHUNK_BYTES);
		expect(await f.seed()).toMatchObject({ bundleBytes: f.bundle.length, chunkCount: 2 });
		expect(await readFile(join(f.guest.workspacePath, "data.bin"))).toHaveLength(300000);
	});
	it("records the seeded base and exports only the commits since it", async () => {
		const f = await fixture({ commits: 2 });
		await f.seed();
		expect(await readFile(join(f.guest.workspacePath, ".git", "refs", "qorpera", "base"), "utf8")).toBe(
			`${f.request.headSha}\n`,
		);
		await writeFile(join(f.guest.workspacePath, "README.md"), "changed\n");
		await f.workspace("commit", "-am", "work");
		const head = await f.workspace("rev-parse", "HEAD");
		const thin = await f.exported(id(5), head);
		expect(thin.prerequisites).toEqual([f.request.headSha]);
		expect(thin.heads).toEqual([`${head} refs/heads/qorpera/coding/${id(1)}`]);
		// The repository has the base, so the bundle is whole there.
		await f.git("bundle", "verify", thin.file);
		// Refs the session's own Git packed read the same.
		await f.workspace("pack-refs", "--all");
		expect((await f.exported(id(6), head)).prerequisites).toEqual([f.request.headSha]);
	});
	it("exports an unchanged head without its parents", async () => {
		const f = await fixture({ commits: 2 });
		await f.seed();
		const unchanged = await f.exported(id(5));
		expect(unchanged.prerequisites).toEqual([await f.git("rev-parse", "HEAD^")]);
		expect(unchanged.heads).toEqual([`${f.request.headSha} refs/heads/qorpera/coding/${id(1)}`]);
		await f.git("bundle", "verify", unchanged.file);
	});
	it("exports the whole history when the base ref is gone or names no commit", async () => {
		const f = await fixture({ commits: 2 });
		await f.seed();
		const base = join(f.guest.workspacePath, ".git", "refs", "qorpera", "base");
		await rm(base);
		expect((await f.exported(id(5))).prerequisites).toEqual([]);
		await writeFile(base, "not a commit\n");
		expect((await f.exported(id(6))).prerequisites).toEqual([]);
	});
	it("refuses a transfer for another session", async () => {
		const f = await fixture();
		await expect(runCodingGitGuest("prepare", id(8), f.request.transferId, f.ports)).rejects.toThrow("SCOPE_CHANGED");
	});
});
