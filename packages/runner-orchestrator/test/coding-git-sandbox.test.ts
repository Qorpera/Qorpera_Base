import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
		expect(await run(command)).toMatch(/^git version /);
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
	it.runIf(linux)("streams stdin and stdout if asked, up to the caller's limit, and keeps the default's", async () => {
		const command = await fixture();
		const run = createCodingBrokerGitRunner(sandbox);
		const sink = (limit: number) => {
			const chunks: Buffer[] = [];
			return { chunks, output: { limit, write: (chunk: Buffer) => void chunks.push(chunk) } };
		};
		// The input reaches Git's stdin, past the pipe's own buffer, and the output reaches the sink, not the result.
		const input = Buffer.alloc(1024 ** 2, "stream mode\n");
		const blob = createHash("sha1")
			.update(Buffer.concat([Buffer.from(`blob ${input.length}\0`), input]))
			.digest("hex");
		const hashed = sink(1024);
		expect(await run({ ...command, args: ["hash-object", "--stdin"], input, output: hashed.output })).toBe("");
		expect(Buffer.concat(hashed.chunks).toString()).toBe(`${blob}\n`);
		// A streamed stdout has the caller's limit instead of 64 KiB, and Git is killed past it.
		const print = ["-c", "alias.print=!yes stream | head -c 300000", "print"];
		const whole = sink(300_000);
		expect(await run({ ...command, args: print, output: whole.output })).toBe("");
		expect(Buffer.concat(whole.chunks).length).toBe(300_000);
		const over = sink(299_999);
		await expect(run({ ...command, args: print, output: over.output })).rejects.toThrow(
			"CODING_GIT_PROCESS_UNCONFIRMED",
		);
		expect(Buffer.concat(over.chunks).length).toBeLessThan(300_000);
		// A sink that throws stops Git, and nothing more reaches it.
		let writes = 0;
		const refusing = {
			limit: 300_000,
			write: () => {
				writes++;
				throw new Error("enough");
			},
		};
		await expect(run({ ...command, args: print, output: refusing })).rejects.toThrow(
			"CODING_GIT_PROCESS_UNCONFIRMED",
		);
		expect(writes).toBe(1);
		// Without a sink, stdout and stderr together still stop at 64 KiB, and stdin stays closed.
		await expect(run({ ...command, args: print })).rejects.toThrow("CODING_GIT_PROCESS_UNCONFIRMED");
		expect(await run({ ...command, args: ["-c", "alias.read=!wc -c", "read"] })).toMatch(/^\s*0\n$/);
	});
});
