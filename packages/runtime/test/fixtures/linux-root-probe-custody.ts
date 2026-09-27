import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { chown, lstat, mkdtemp, open, rm } from "node:fs/promises";

/** Only kernel identity/capability fields; never emit environment or file bytes. */
export function linuxRootProbeStatus(text: string): Record<string, string> {
	return Object.fromEntries(
		text.split("\n").flatMap((line) => {
			const match = /^(Uid|Gid|CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs|Seccomp):\s+([0-9a-f\t ]+)$/.exec(line);
			return match ? [[match[1], match[2].trim().replace(/\s+/g, " ")]] : [];
		}),
	);
}
function metadata() {
	const kernelText = (path: string) => {
		try {
			return readFileSync(path, "utf8").slice(0, 4096).trim();
		} catch {
			return "unavailable";
		}
	};
	return {
		process: linuxRootProbeStatus(kernelText("/proc/self/status")),
		threads: readdirSync("/proc/self/task")
			.filter((id) => /^\d+$/.test(id))
			.slice(0, 32)
			.map((id) => linuxRootProbeStatus(kernelText(`/proc/self/task/${id}/status`))),
		uidMap: kernelText("/proc/self/uid_map"),
		gidMap: kernelText("/proc/self/gid_map"),
		lsm: kernelText("/proc/self/attr/current"),
	};
}

/** Fail early on a host sandbox that cannot exercise real ownership changes.
 * Both async path and descriptor syscalls must work under the three requested
 * capabilities; a failure reports their actual kernel custody, not a fallback. */
export async function assertLinuxRootProbeCustody(): Promise<void> {
	assert.equal(process.platform, "linux");
	assert.equal(process.getuid?.(), 0);
	const directory = await mkdtemp("/tmp/root-custody-preflight-"),
		path = `${directory}/owned`,
		handle = await open(path, "wx", 0o600);
	let phase = "path_chown";
	try {
		await chown(path, 1001, 1002);
		assert.equal((await lstat(path)).uid, 1001);
		assert.equal((await lstat(path)).gid, 1002);
		phase = "descriptor_chown";
		await handle.chown(0, 0);
		assert.equal((await handle.stat()).uid, 0);
		assert.equal((await handle.stat()).gid, 0);
		phase = "capabilities";
		const status = linuxRootProbeStatus(readFileSync("/proc/self/status", "utf8"));
		assert.equal(BigInt(`0x${status.CapEff}`), 0xbn, "Only CHOWN, DAC_OVERRIDE and FOWNER may be effective");
	} catch (error) {
		console.error(JSON.stringify({ schema: "qorpera.linux-root-probe-custody/v1", phase, ...metadata() }));
		throw error;
	} finally {
		await handle.close();
		await rm(directory, { recursive: true, force: true });
	}
}
