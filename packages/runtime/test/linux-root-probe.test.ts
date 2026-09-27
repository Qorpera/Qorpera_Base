import { describe, expect, it } from "vitest";
import { linuxRootProbeArguments, linuxRootProbeEnabled, runLinuxRootProbe } from "./fixtures/linux-root-probe.ts";
import { linuxRootProbeStatus } from "./fixtures/linux-root-probe-custody.ts";

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
	it("diagnostics retain only kernel custody fields, excluding paths and unrelated process data", () => {
		expect(
			linuxRootProbeStatus(
				"Name:\tprivate-path\nUid:\t0\t0\t0\t0\nCapEff:\t000000000000000b\nNoNewPrivs:\t1\nVmSize:\t123 kB\nGid:\tinvalid\n",
			),
		).toEqual({ Uid: "0 0 0 0", CapEff: "000000000000000b", NoNewPrivs: "1" });
	});
	it("rejects ambiguous paths before invoking a privileged process", () => {
		for (const path of ["relative", "/tmp/probe\nfile", "\0"])
			expect(() => linuxRootProbeArguments(path, "/usr/bin/node")).toThrow("INVALID_LINUX_PROBE_PATH");
	});
	it.skipIf(linuxRootProbeEnabled)("does not implicitly elevate an ordinary developer test run", () => {
		expect(() => runLinuxRootProbe("/tmp/probe.mjs")).toThrow("LINUX_ROOT_PROBE_NOT_ENABLED");
	});
});
