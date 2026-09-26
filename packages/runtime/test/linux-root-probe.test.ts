import { describe, expect, it } from "vitest";
import { linuxRootProbeArguments, linuxRootProbeEnabled, runLinuxRootProbe } from "./fixtures/linux-root-probe.ts";

describe("explicit disposable Linux root filesystem probes", () => {
	it("isolates physical custody checks without Docker, host writable mounts or network", () => {
		const args = linuxRootProbeArguments("/tmp/owned/probe.mjs", "/opt/node/bin/node");
		expect(args.slice(0, 2)).toEqual(["-n", "/usr/bin/bwrap"]);
		for (const flag of ["--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts", "--clearenv"])
			expect(args).toContain(flag);
		expect(args).not.toContain("--unshare-user");
		expect(args).not.toContain("--bind");
		expect(args).not.toContain("/home");
		expect(args).not.toContain("/run");
		expect(args).not.toContain("CAP_SYS_ADMIN");
		expect(args.slice(-3)).toEqual(["--", "/probe-node", "/probe.mjs"]);
	});
	it("rejects ambiguous paths before invoking a privileged process", () => {
		for (const path of ["relative", "/tmp/probe\nfile", "\0"])
			expect(() => linuxRootProbeArguments(path, "/usr/bin/node")).toThrow("INVALID_LINUX_PROBE_PATH");
	});
	it.skipIf(linuxRootProbeEnabled)("does not implicitly elevate an ordinary developer test run", () => {
		expect(() => runLinuxRootProbe("/tmp/probe.mjs")).toThrow("LINUX_ROOT_PROBE_NOT_ENABLED");
	});
});
