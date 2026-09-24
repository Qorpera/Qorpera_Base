import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readlink, rename, rm, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { cloudCodingSessionLayout } from "@qorpera/contracts";
import { type CodingGuestConfiguration, parseCodingGuestConfiguration } from "./cloud-coding-guest-configuration.ts";

const executeFile = promisify(execFile);
/** Guest uids from this value on belong to one session each and are registered
 * per boot; lower ones are the image's own coding user. */
export const CODING_SESSION_UID_BASE = 200000;
export interface CodingSessionGuestPorts {
	/** Trusted test composition only. */
	userdbRoot?: string;
	runtimeRoot?: string;
	protectedUid?: number;
	system?: (executable: string, args: readonly string[]) => Promise<string>;
}

function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
async function system(executable: string, args: readonly string[]): Promise<string> {
	try {
		return (await executeFile(executable, [...args], { env: { PATH: "/usr/bin:/bin", LANG: "C" }, timeout: 30000 }))
			.stdout;
	} catch {
		throw new Error("CODING_GUEST_SESSION_SERVICE_UNCONFIRMED");
	}
}
async function protectedDirectory(path: string, owner: number, create: boolean): Promise<void> {
	if (create)
		await mkdir(path, { mode: 0o755 }).catch((error) => {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		});
	const info = await lstat(path);
	if (!info.isDirectory() || info.uid !== owner || (info.mode & 0o7022) !== 0)
		throw new Error("CODING_GUEST_SESSION_PATH_UNPROTECTED");
}
/** A record file is published once per boot and afterwards only compared. */
async function record(directory: string, name: string, content: string, owner: number): Promise<void> {
	const path = join(directory, name);
	try {
		const info = await lstat(path);
		const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const opened = await handle.stat();
			if (
				!info.isFile() ||
				opened.ino !== info.ino ||
				opened.uid !== owner ||
				opened.nlink !== 1 ||
				(opened.mode & 0o7777) !== 0o644 ||
				(await handle.readFile("utf8")) !== content
			)
				throw new Error("CODING_GUEST_SESSION_USER_CHANGED");
		} finally {
			await handle.close();
		}
		return;
	} catch (error) {
		if (!missing(error)) throw error;
	}
	const temporary = join(directory, `.qorpera-coding-${randomUUID()}.tmp`);
	const handle = await open(
		temporary,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o644,
	);
	try {
		await handle.writeFile(content);
		await handle.chmod(0o644);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temporary, path);
}
async function link(directory: string, name: string, target: string): Promise<void> {
	try {
		if ((await readlink(join(directory, name))) !== target) throw new Error("CODING_GUEST_SESSION_USER_CHANGED");
	} catch (error) {
		if (!missing(error)) throw error;
		await symlink(target, join(directory, name));
	}
}

/** systemd runs a unit only as a user it can resolve; a session's own uid has
 * no entry in the image. Registers it as a boot-local userdb record
 * (nss-systemd reads /run/userdb), named after the uid, home in the session's
 * folder, no login shell. The image's own coding user needs nothing. */
export async function registerCodingSessionUser(
	guest: CodingGuestConfiguration,
	ports: CodingSessionGuestPorts = {},
): Promise<void> {
	if (guest.uid < CODING_SESSION_UID_BASE) return;
	if (guest.gid !== guest.uid) throw new Error("CODING_GUEST_SESSION_USER_INVALID");
	const directory = ports.userdbRoot ?? "/run/userdb",
		owner = ports.protectedUid ?? 0,
		name = `qorpera-coding-${guest.uid}`;
	await protectedDirectory(directory, owner, true);
	await record(
		directory,
		`${name}.user`,
		JSON.stringify({
			userName: name,
			uid: guest.uid,
			gid: guest.gid,
			homeDirectory: guest.homePath,
			shell: "/usr/sbin/nologin",
			disposition: "regular",
		}),
		owner,
	);
	await record(
		directory,
		`${name}.group`,
		JSON.stringify({ groupName: name, gid: guest.gid, disposition: "regular" }),
		owner,
	);
	await link(directory, `${guest.uid}.user`, `${name}.user`);
	await link(directory, `${guest.gid}.group`, `${name}.group`);
}

export async function removeCodingSessionUser(uid: number, ports: CodingSessionGuestPorts = {}): Promise<void> {
	if (!Number.isSafeInteger(uid) || uid < CODING_SESSION_UID_BASE) return;
	const directory = ports.userdbRoot ?? "/run/userdb",
		name = `qorpera-coding-${uid}`;
	for (const entry of [`${uid}.user`, `${uid}.group`, `${name}.user`, `${name}.group`])
		await unlink(join(directory, entry)).catch((error) => {
			if (!missing(error)) throw error;
		});
}

/** The end of a session's turn inside the member's machine, as root: its
 * command slice is stopped and must be seen stopped, the guest's writes are
 * flushed to the NAS, and its boot-local configuration, lease and user record
 * are removed. Its NAS folders are not touched; the host detaches them next. */
export async function detachCloudCodingGuestSession(
	workerId: string,
	ports: CodingSessionGuestPorts = {},
): Promise<void> {
	if (!ports.system && (process.platform !== "linux" || process.getuid?.() !== 0))
		throw new Error("CODING_GUEST_SESSION_ROOT_REQUIRED");
	const layout = cloudCodingSessionLayout(workerId),
		runtimeRoot = ports.runtimeRoot ?? layout.runtimeRoot,
		owner = ports.protectedUid ?? 0,
		call = ports.system ?? system;
	let uid: number | undefined;
	try {
		await protectedDirectory(runtimeRoot, owner, false);
		const path = join(runtimeRoot, "configuration", "guest.json");
		const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const info = await handle.stat();
			if (
				!info.isFile() ||
				info.uid !== owner ||
				info.nlink !== 1 ||
				(info.mode & 0o7777) !== 0o444 ||
				info.size > 8192
			)
				throw new Error("CODING_GUEST_SESSION_PATH_UNPROTECTED");
			const guest = parseCodingGuestConfiguration(JSON.parse(await handle.readFile("utf8")));
			if (guest.workerId !== workerId) throw new Error("CODING_GUEST_SESSION_SCOPE_CHANGED");
			uid = guest.uid;
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (!missing(error)) throw error;
	}
	const quiesce = async () => {
		const load = (await call("/usr/bin/systemctl", ["show", layout.slice, "--property=LoadState", "--value"])).trim();
		if (load === "loaded") {
			await call("/usr/bin/systemctl", ["stop", layout.slice]);
			const state = (
				await call("/usr/bin/systemctl", ["show", layout.slice, "--property=ActiveState", "--value"])
			).trim();
			if (state !== "inactive" && state !== "failed") throw new Error("CODING_GUEST_SESSION_STOP_UNCONFIRMED");
		} else if (load !== "not-found") throw new Error("CODING_GUEST_SESSION_STOP_UNCONFIRMED");
	};
	await quiesce();
	await call("/usr/bin/sync", []);
	if (uid !== undefined) await removeCodingSessionUser(uid, ports);
	await rm(runtimeRoot, { recursive: true, force: true });
	// Without its configuration no command of the session can start any more;
	// one that started between the first stop and the removal (so the watchdog,
	// which lists sessions by that folder, would never see it) stops now.
	await quiesce();
}
