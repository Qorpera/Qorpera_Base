import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { killChildTree, killChildTreeSync } from "../src/agent-runtime.ts";

/**
 * Regression: the shell's agent child is a wrapper (codex.exe "sandbox")
 * around the real agent process, and plain ChildProcess.kill() on Windows
 * terminates only the wrapper — the wrapped subtree survived app quit.
 * These tests stand in a node→node tree for the codex→agent tree and
 * require the WHOLE tree to be dead after a reap.
 */

// Parent prints its grandchild's pid, then idles like an agent would.
const TREE_SCRIPT = [
	"const {spawn}=require('node:child_process');",
	"const grandchild=spawn(process.execPath,['-e','setTimeout(()=>{},600000)'],{stdio:'ignore'});",
	"console.log(String(grandchild.pid));",
	"setTimeout(()=>{},600000);",
].join("");

const spawned: Array<{ child: ChildProcessWithoutNullStreams; grandchildPid?: number }> = [];

function spawnTree(): ChildProcessWithoutNullStreams {
	const child = spawn(process.execPath, ["-e", TREE_SCRIPT], {
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	}) as ChildProcessWithoutNullStreams;
	spawned.push({ child });
	return child;
}

async function readGrandchildPid(child: ChildProcessWithoutNullStreams): Promise<number> {
	let buffer = "";
	for await (const chunk of child.stdout) {
		buffer += String(chunk);
		const line = buffer.split("\n")[0]?.trim();
		if (line) {
			const pid = Number(line);
			expect(Number.isInteger(pid) && pid > 0).toBe(true);
			spawned[spawned.length - 1]!.grandchildPid = pid;
			return pid;
		}
	}
	throw new Error("tree parent never reported its grandchild pid");
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForDeath(pid: number, timeoutMs = 10_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!pidAlive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return !pidAlive(pid);
}

afterEach(() => {
	// Never leak the fixture trees, even when an assertion failed first.
	for (const entry of spawned) {
		const pids = [entry.child.pid, entry.grandchildPid].filter((pid): pid is number => Boolean(pid));
		for (const pid of pids) {
			if (!pidAlive(pid)) continue;
			try {
				if (process.platform === "win32")
					execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
				else process.kill(pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
	}
	spawned.length = 0;
});

describe("agent child tree reaping", () => {
	it("killChildTree terminates the direct child", async () => {
		const child = spawnTree();
		await readGrandchildPid(child);
		killChildTree(child);
		await once(child, "close");
		expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
	});

	it("killChildTree on an already-exited child is a no-op", async () => {
		const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", windowsHide: true });
		await once(child, "close");
		expect(() => killChildTree(child as ChildProcessWithoutNullStreams)).not.toThrow();
	});
});

describe.skipIf(process.platform !== "win32")("agent child tree reaping (Windows tree kill)", () => {
	it("killChildTree kills the wrapped grandchild, not just the wrapper", async () => {
		const child = spawnTree();
		const grandchildPid = await readGrandchildPid(child);
		expect(pidAlive(grandchildPid)).toBe(true);
		killChildTree(child);
		await once(child, "close");
		expect(await waitForDeath(grandchildPid)).toBe(true);
	});

	it("killChildTreeSync kills the whole tree before returning (quit path)", async () => {
		const child = spawnTree();
		const grandchildPid = await readGrandchildPid(child);
		expect(pidAlive(grandchildPid)).toBe(true);
		killChildTreeSync(child);
		// taskkill has returned; termination itself is asynchronous but immediate.
		expect(await waitForDeath(grandchildPid, 5_000)).toBe(true);
		await once(child, "close");
	});
});
