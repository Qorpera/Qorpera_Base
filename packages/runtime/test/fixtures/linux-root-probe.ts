import { execFileSync } from "node:child_process";
import { lstatSync, type Stats } from "node:fs";
import { isAbsolute } from "node:path";

const rootProbeHelper = "/usr/local/libexec/qorpera-test-root-bwrap";

export const linuxRootProbeEnabled = process.platform === "linux" && process.env.QORPERA_LINUX_ROOT_PROBES === "1";

/** Only the disposable Linux acceptance job enables this privileged fixture.
 * The probe sees read-only system code plus fresh writable /tmp and /opt, no
 * host credentials or network. Real root IDs preserve the chown assertions. */
export function linuxRootProbeArguments(bundle: string, executable: string): string[] {
	for (const path of [bundle, executable]) {
		if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error("INVALID_LINUX_PROBE_PATH");
	}
	return [
		"-n",
		rootProbeHelper,
		"--unshare-pid",
		"--unshare-net",
		"--unshare-ipc",
		"--unshare-uts",
		"--die-with-parent",
		"--new-session",
		"--cap-drop",
		"ALL",
		"--cap-add",
		"CAP_CHOWN",
		"--cap-add",
		"CAP_DAC_OVERRIDE",
		"--cap-add",
		"CAP_FOWNER",
		"--ro-bind",
		"/usr",
		"/usr",
		"--ro-bind",
		"/bin",
		"/bin",
		"--ro-bind",
		"/lib",
		"/lib",
		"--ro-bind-try",
		"/lib64",
		"/lib64",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--tmpfs",
		"/tmp",
		"--tmpfs",
		"/opt",
		"--ro-bind",
		bundle,
		"/probe.mjs",
		"--ro-bind",
		executable,
		"/probe-node",
		"--chdir",
		"/",
		"--clearenv",
		"--setenv",
		"PATH",
		"/usr/bin:/bin",
		"--setenv",
		"HOME",
		"/tmp",
		"--setenv",
		"TMPDIR",
		"/tmp",
		"--",
		"/probe-node",
		"/probe.mjs",
	];
}

export function assertLinuxRootProbeHelper(helper: Pick<Stats, "isFile" | "uid" | "gid" | "nlink" | "mode">): void {
	if (
		!helper.isFile() ||
		helper.uid !== 0 ||
		helper.gid !== 0 ||
		helper.nlink !== 1 ||
		(helper.mode & 0o7777) !== 0o700
	)
		throw new Error("INVALID_LINUX_ROOT_PROBE_HELPER_CUSTODY");
}

export function runLinuxRootProbe(bundle: string): string {
	if (!linuxRootProbeEnabled) throw new Error("LINUX_ROOT_PROBE_NOT_ENABLED");
	// Ubuntu's ordinary bwrap profile deliberately denies all child capabilities.
	// CI installs this separate byte-identical root-only helper, preserving the
	// system profile and every ordinary/unprivileged bwrap consumer unchanged.
	assertLinuxRootProbeHelper(lstatSync(rootProbeHelper));
	return execFileSync("/usr/bin/sudo", linuxRootProbeArguments(bundle, process.execPath), {
		env: { PATH: "/usr/bin:/bin", LANG: "C" },
		encoding: "utf8",
		timeout: 60000,
		maxBuffer: 1048576,
	});
}
