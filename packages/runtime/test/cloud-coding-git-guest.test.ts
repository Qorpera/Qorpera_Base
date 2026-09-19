import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	CODING_GIT_CHUNK_BYTES,
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
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "coding-git-guest-test-")));
	roots.push(root);
	await mkdir(join(root, "inbox"), { mode: 0o755 });
	await mkdir(join(root, "workspace"), { mode: 0o755 });
	const guest: CodingGitGuestConfiguration = {
		schema: "qorpera.coding-command-guest/v2",
		workerId: id(1),
		vmId: id(2),
		bootId: id(3),
		uid: 1000,
		gid: 1000,
		workspacePath: join(root, "workspace"),
		homePath: join(root, "home"),
		cachePath: join(root, "cache"),
		outputRoot: join(root, "output"),
		resourceProfile: {
			maxTimeoutMs: 1800000,
			memoryBytes: 2147483648,
			tasksMax: 256,
			cpuQuotaPercent: 200,
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
	const git = async (...args: string[]) => (await exec("/usr/bin/git", args, { cwd: source, env })).stdout.trim();
	await git("init", "--template=", ".");
	await writeFile(join(source, "README.md"), "hello\n");
	await git("add", "README.md");
	await git("commit", "-m", "seed");
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
		protectedUid: process.getuid?.(),
		protectedDirectoryRoot: root,
		inspectMachine: async () => guest.bootId,
		system: async () => "",
		execute,
	};
	const stage = async (input = request) => {
		await writeFile(join(root, "inbox", `${input.transferId}.git.json`), JSON.stringify(input), { mode: 0o444 });
		await runCodingGitGuest("prepare", input.transferId, ports);
	};
	const seed = async () => {
		await stage();
		for (let index = 0; index < Math.ceil(bundle.length / CODING_GIT_CHUNK_BYTES); index++)
			await writeFile(
				join(root, "git", request.transferId, `${String(index).padStart(6, "0")}.base64`),
				bundle.subarray(index * CODING_GIT_CHUNK_BYTES, (index + 1) * CODING_GIT_CHUNK_BYTES).toString("base64"),
				{ mode: 0o444 },
			);
		return runCodingGitGuest("seed", request.transferId, ports);
	};
	return { root, guest, request, bundle, ports, stage, seed, config };
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
		const receipt = await runCodingGitGuest("export", request.transferId, f.ports);
		const output = await readFile(join(f.root, "git", request.transferId, "000000.bundle"));
		expect(createHash("sha256").update(output).digest("hex")).toBe(receipt?.bundleSha256);
		expect(await runCodingGitGuest("export", request.transferId, f.ports)).toEqual(receipt);
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
		expect((await runCodingGitGuest("export", request.transferId, f.ports))?.headSha).toBe(request.headSha);
	});
	it("cannot reseed a modified workspace with a fresh transfer identity", async () => {
		const f = await fixture();
		await f.seed();
		await writeFile(join(f.guest.workspacePath, "README.md"), "keep my edits\n");
		await expect(runCodingGitGuest("seed", f.request.transferId, f.ports)).resolves.toMatchObject({ action: "seed" });
		const changed = { ...f.request, transferId: id(8) };
		await f.stage(changed);
		await writeFile(join(f.root, "git", changed.transferId, "000000.base64"), f.bundle.toString("base64"), {
			mode: 0o444,
		});
		await expect(runCodingGitGuest("seed", changed.transferId, f.ports)).rejects.toThrow();
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
		await expect(runCodingGitGuest("export", request.transferId, f.ports)).rejects.toThrow(
			"CODING_GIT_GUEST_REPOSITORY_CHANGED",
		);
		const normal = { ...request, transferId: id(6), repository: f.request.repository };
		await f.stage(normal);
		await writeFile(join(f.guest.workspacePath, ".git", "HEAD"), "ref: refs/heads/other\n");
		await expect(runCodingGitGuest("export", normal.transferId, f.ports)).rejects.toThrow(
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
		await expect(runCodingGitGuest("export", request.transferId, f.ports)).rejects.toThrow();
		await expect(runCodingGitGuest("export", request.transferId, f.ports)).rejects.toThrow();
		expect(attempts).toBe(1);
	});
	it("rejects writable guest configuration and a reboot", async () => {
		const f = await fixture();
		await f.stage();
		await chmod(f.config, 0o644);
		await expect(runCodingGitGuest("seed", f.request.transferId, f.ports)).rejects.toThrow(
			"CODING_GIT_GUEST_CONFIG_MODE",
		);
		await chmod(f.config, 0o444);
		f.ports.inspectMachine = async () => id(9);
		await expect(runCodingGitGuest("seed", f.request.transferId, f.ports)).rejects.toThrow(
			"CODING_GIT_GUEST_BOOT_CHANGED",
		);
	});
	it("refuses export while an actual command unit remains running", async () => {
		const f = await fixture();
		await f.seed();
		let executions = 0;
		f.ports.execute = async () => {
			executions++;
			return Buffer.from("should not run");
		};
		f.ports.system = async (_executable, args) =>
			args[0] === "list-units"
				? `qorpera-coding-${id(9)}.service loaded active running build\n`
				: `LoadState=loaded\nActiveState=active\nSubState=running\nControlGroup=/system.slice/qorpera-coding-${id(9)}.service\nTasksCurrent=2\n`;
		const request = {
			...f.request,
			action: "export" as const,
			transferId: id(5),
			bundleSha256: null,
			bundleBytes: 0,
		};
		await f.stage(request);
		await expect(runCodingGitGuest("export", request.transferId, f.ports)).rejects.toThrow(
			"WORKSPACE_COMMANDS_ACTIVE",
		);
		expect(executions).toBe(0);
	});
	it("allows a retained exited command only when systemd confirms no processes", async () => {
		const f = await fixture();
		await f.seed();
		f.ports.system = async (_executable, args) =>
			args[0] === "list-units"
				? `qorpera-coding-${id(9)}.service loaded active exited completed\n`
				: "LoadState=loaded\nActiveState=active\nSubState=exited\nControlGroup=\nTasksCurrent=[not set]\n";
		const request = {
			...f.request,
			action: "export" as const,
			transferId: id(5),
			bundleSha256: null,
			bundleBytes: 0,
		};
		await f.stage(request);
		expect((await runCodingGitGuest("export", request.transferId, f.ports))?.headSha).toBe(request.headSha);
	});
});
