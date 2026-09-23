import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { checkDirectory } from "./lxd-office-journal-files.ts";

export interface CodingGitSandboxOptions {
	/** Operator-selected, pinned Bubblewrap binary. No PATH lookup or fallback. */
	bubblewrapPath?: string;
}

/** seccomp_data architecture and socket argument checks. Block UNIX sockets
 * even for HTTPS Git, whose network namespace is shared for outbound access.
 * The fresh PID/proc namespace and mount tree hide host processes and files. */
export function codingGitSocketFilter(architecture: string = process.arch): Buffer {
	const platform =
		architecture === "x64"
			? { audit: 0xc000003e, socket: 41 }
			: architecture === "arm64"
				? { audit: 0xc00000b7, socket: 198 }
				: undefined;
	if (!platform) throw new Error("CODING_GIT_SANDBOX_ARCH_UNSUPPORTED");
	const instructions = [
		[0x20, 0, 0, 4], // LD architecture
		[0x15, 1, 0, platform.audit],
		[0x06, 0, 0, 0x80000000], // KILL_PROCESS for another ABI
		[0x20, 0, 0, 0], // LD syscall
		[0x35, 0, 1, 0x40000000], // refuse x32 ABI as well
		[0x06, 0, 0, 0x80000000],
		// io_uring socket operations would bypass the socket syscall filter.
		...[425, 426, 427].flatMap((syscall) => [
			[0x15, 0, 1, syscall],
			[0x06, 0, 0, 0x00050001],
		]),
		[0x15, 0, 3, platform.socket],
		[0x20, 0, 0, 16], // LD socket domain
		[0x15, 0, 1, 1], // AF_UNIX
		[0x06, 0, 0, 0x00050001], // ERRNO EPERM
		[0x06, 0, 0, 0x7fff0000], // ALLOW
	];
	const result = Buffer.alloc(instructions.length * 8);
	instructions.forEach(([op, yes, no, value], index) => {
		result.writeUInt16LE(op, index * 8);
		result.writeUInt8(yes, index * 8 + 2);
		result.writeUInt8(no, index * 8 + 3);
		result.writeUInt32LE(value, index * 8 + 4);
	});
	return result;
}

export async function codingGitSandboxPlan(
	input: { scratchRoot: string; cwd: string; network: boolean },
	options: CodingGitSandboxOptions = {},
): Promise<{ executable: string; args: string[] }> {
	if (process.platform !== "linux" || process.getuid?.() === 0)
		throw new Error("CODING_GIT_BROKER_REQUIRES_UNPRIVILEGED_LINUX");
	const executable = options.bubblewrapPath ?? "/usr/bin/bwrap";
	if (!isAbsolute(executable) || executable.includes("\0")) throw new Error("CODING_GIT_SANDBOX_UNAVAILABLE");
	const binary = await lstat(executable);
	if (
		!binary.isFile() ||
		(binary.mode & 0o022) !== 0 ||
		(binary.mode & 0o111) === 0 ||
		![0, process.getuid?.()].includes(binary.uid)
	)
		throw new Error("CODING_GIT_SANDBOX_UNAVAILABLE");
	await checkDirectory(input.scratchRoot);
	const scratch = await realpath(input.scratchRoot),
		cwd = await realpath(input.cwd);
	const child = relative(scratch, cwd);
	if (
		scratch !== input.scratchRoot ||
		cwd !== input.cwd ||
		child === ".." ||
		child.startsWith(`..${sep}`) ||
		isAbsolute(child) ||
		scratch === "/"
	)
		throw new Error("CODING_GIT_SANDBOX_PATH_INVALID");
	const args = [
		"--unshare-user",
		"--unshare-pid",
		"--unshare-ipc",
		"--unshare-uts",
		"--disable-userns",
		"--die-with-parent",
		"--new-session",
		"--cap-drop",
		"ALL",
	];
	if (!input.network) args.push("--unshare-net");
	// Only operating-system binaries/libraries. Never expose /etc, /run, /home,
	// the executor journal, the LXD socket, or the host /proc tree.
	for (const path of ["/usr", "/bin", "/lib", "/lib64"]) {
		try {
			await lstat(path);
			args.push("--ro-bind", path, path);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
	}
	if (input.network) {
		for (const path of ["/etc/ssl/certs", "/etc/resolv.conf", "/etc/nsswitch.conf", "/etc/hosts"])
			args.push("--ro-bind", path, path);
	}
	args.push(
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--tmpfs",
		"/tmp",
		"--bind",
		scratch,
		scratch,
		"--chdir",
		cwd,
		"--seccomp",
		"3",
		"--",
	);
	return { executable, args };
}
