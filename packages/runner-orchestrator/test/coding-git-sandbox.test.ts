import { spawnSync } from "node:child_process";
import { mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCodingBrokerGitRunner } from "../src/coding-git.ts";
import { codingGitSandboxPlan, codingGitSocketFilter } from "../src/coding-git-sandbox.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const linux = process.platform === "linux" && process.getuid?.() !== 0;
const sandbox = { bubblewrapPath: process.env.QORPERA_TEST_BWRAP };
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "coding-sandbox-test-")));
	roots.push(root);
	return {
		cwd: root,
		scratchRoot: root,
		network: false,
		args: ["--version"],
		signal: new AbortController().signal,
		env: {
			PATH: "/usr/bin:/bin",
			HOME: root,
			XDG_CONFIG_HOME: root,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
		},
	};
}
describe("mandatory coding Git parser containment", () => {
	it("uses architecture-specific UNIX-socket denial and refuses unknown architectures", () => {
		expect(codingGitSocketFilter("x64").readUInt32LE(12)).toBe(0xc000003e);
		expect(codingGitSocketFilter("arm64").readUInt32LE(12)).toBe(0xc00000b7);
		expect(() => codingGitSocketFilter("unknown")).toThrow("ARCH_UNSUPPORTED");
	});
	it.runIf(linux)("fails closed without a sandbox executable", async () => {
		const command = await fixture();
		await expect(
			createCodingBrokerGitRunner({ bubblewrapPath: join(command.scratchRoot, "absent") })(command),
		).rejects.toThrow();
	});
	it.runIf(linux)("executes real Git in a fresh namespace without host files, credentials, or network", async () => {
		const command = await fixture();
		const host = await realpath(await mkdtemp(join(tmpdir(), "coding-host-secret-")));
		roots.push(host);
		const secret = join(host, "credential");
		await writeFile(secret, "host-secret", { mode: 0o600 });
		const plan = await codingGitSandboxPlan(command, sandbox);
		expect(plan.args).toContain("--unshare-net");
		expect(plan.args).toContain("--disable-userns");
		expect(plan.args).not.toContain(host);
		const run = createCodingBrokerGitRunner(sandbox);
		let version: string;
		try {
			version = await run(command);
		} catch (error) {
			// This fixed synthetic fixture has no repository token. Reproduce its
			// exact setup once for host diagnostics; production errors stay redacted
			// and a successful replay never turns the original failure into a pass.
			const filterPath = join(command.scratchRoot, "diagnostic.seccomp");
			await writeFile(filterPath, codingGitSocketFilter(), { flag: "wx", mode: 0o600 });
			const filter = await open(filterPath, "r");
			try {
				const result = spawnSync(
					"/usr/bin/prlimit",
					[
						"--as=1073741824",
						"--cpu=30",
						"--fsize=268435456",
						"--nofile=64",
						"--nproc=512",
						"--core=0",
						"--",
						plan.executable,
						...plan.args,
						"/usr/bin/git",
						"--version",
					],
					{
						cwd: command.cwd,
						env: command.env,
						stdio: ["ignore", "pipe", "pipe", filter.fd],
						encoding: "utf8",
						timeout: 5000,
						maxBuffer: 4096,
					},
				);
				console.error(
					JSON.stringify({
						schema: "qorpera.coding-git-sandbox-fixture-diagnostic/v1",
						status: result.status,
						signal: result.signal,
						spawnCode: result.error && "code" in result.error ? result.error.code : null,
						stderr: result.stderr?.slice(0, 2048),
					}),
				);
			} finally {
				await filter.close();
			}
			throw error;
		}
		expect(version).toMatch(/^git version /);
		// Trusted fixture alias deliberately probes a compromised parser's reach.
		const probe = `!test ! -e '${secret}' && test ! -e /run && test ! -e /home && test -e /proc/self && printf isolated`;
		expect(await run({ ...command, args: ["-c", `alias.probe=${probe}`, "probe"] })).toBe("isolated");
		const socketProbe =
			'!/usr/bin/python3 -c \'import errno,socket;\ntry: socket.socket(socket.AF_UNIX)\nexcept OSError as e: assert e.errno == errno.EPERM; print("blocked")\nelse: raise AssertionError("socket escaped")\'';
		expect(await run({ ...command, network: true, args: ["-c", `alias.probe=${socketProbe}`, "probe"] })).toBe(
			"blocked\n",
		);
		await expect(run({ ...command, env: { ...command.env, GIT_CONFIG_VALUE_0: "secret" } })).rejects.toThrow(
			"ENV_INVALID",
		);
		await expect(run({ ...command, cwd: host })).rejects.toThrow("PATH_INVALID");
	});
});
