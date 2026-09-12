import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH } from "@qorpera/contracts";
import { assertCompanyComputerImageArtifact } from "./cloud-company-computer-linux-host.ts";

const path = COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH;
const same = (a: BigIntStats, b: BigIntStats) =>
	(["dev", "ino", "uid", "gid", "mode", "size", "nlink", "mtimeNs", "ctimeNs"] as const).every(
		(key) => a[key] === b[key],
	);

/** Fixed installed file only, independent of the original package's service
 * digest. Does not measure invocation, grant authority or expose source bytes.
 * The returned descriptor must remain held through the caller's measurement. */
export async function openCompanyComputerInstalledServiceSoftware(signal: AbortSignal) {
	if (
		process.platform !== "linux" ||
		process.getuid?.() !== 0 ||
		process.geteuid?.() !== 0 ||
		process.getgid?.() !== 0 ||
		process.getegid?.() !== 0
	)
		throw new Error("OFFICE_SOFTWARE_MEASUREMENT_ROOT_REQUIRED");
	const parents: { path: string; handle: FileHandle; stat: BigIntStats }[] = [];
	let file: FileHandle | undefined;
	try {
		for (const directory of ["/", "/opt", "/opt/qorpera-office"]) {
			signal.throwIfAborted();
			const parent = parents.at(-1);
			const handle = await open(
				parent ? `/proc/self/fd/${parent.handle.fd}/${directory.split("/").at(-1)}` : "/",
				constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
			try {
				parents.push({ path: directory, handle, stat: await handle.stat({ bigint: true }) });
			} catch (error) {
				await handle.close();
				throw error;
			}
		}
		const verifyParents = async () => {
			signal.throwIfAborted();
			for (const parent of parents) {
				const current = await parent.handle.stat({ bigint: true }),
					named = await lstat(parent.path, { bigint: true });
				if (
					!current.isDirectory() ||
					current.uid !== 0n ||
					current.gid !== 0n ||
					(current.mode & 0o6022n) !== 0n ||
					[current, named].some(
						(s) =>
							s.dev !== parent.stat.dev ||
							s.ino !== parent.stat.ino ||
							s.mode !== parent.stat.mode ||
							s.uid !== parent.stat.uid ||
							s.gid !== parent.stat.gid,
					) ||
					(await realpath(`/proc/self/fd/${parent.handle.fd}`)) !== parent.path
				)
					throw new Error("OFFICE_SOFTWARE_MEASUREMENT_PARENT_CHANGED");
			}
			await assertCompanyComputerImageArtifact(path);
		};
		await verifyParents();
		file = await open(
			`/proc/self/fd/${parents.at(-1)!.handle.fd}/qorpera-company-computer-service.mjs`,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		const identity = await file.stat({ bigint: true });
		if (
			!identity.isFile() ||
			identity.uid !== 0n ||
			identity.gid !== 0n ||
			identity.nlink !== 1n ||
			(identity.mode & 0o7777n) !== 0o444n ||
			identity.size < 1n ||
			identity.size > 32n * 1024n ** 2n
		)
			throw new Error("OFFICE_SOFTWARE_MEASUREMENT_FILE_UNPROTECTED");
		const read = async () => {
			await verifyParents();
			if (!same(identity, await file!.stat({ bigint: true })))
				throw new Error("OFFICE_SOFTWARE_MEASUREMENT_FILE_CHANGED");
			const digest = createHash("sha256"),
				buffer = Buffer.alloc(65536);
			let position = 0;
			while (position <= Number(identity.size)) {
				signal.throwIfAborted();
				const { bytesRead } = await file!.read(
					buffer,
					0,
					Math.min(buffer.length, Number(identity.size) + 1 - position),
					position,
				);
				if (!bytesRead) break;
				position += bytesRead;
				digest.update(buffer.subarray(0, bytesRead));
			}
			if (
				position !== Number(identity.size) ||
				!same(identity, await file!.stat({ bigint: true })) ||
				!same(identity, await lstat(path, { bigint: true }))
			)
				throw new Error("OFFICE_SOFTWARE_MEASUREMENT_FILE_CHANGED");
			await verifyParents();
			return digest.digest("hex");
		};
		const service = Object.freeze({ path, bytes: Number(identity.size), sha256: await read() });
		return {
			service,
			async verify() {
				if ((await read()) !== service.sha256) throw new Error("OFFICE_SOFTWARE_MEASUREMENT_FILE_CHANGED");
			},
			async close() {
				try {
					await file!.close();
				} finally {
					for (const parent of parents.reverse()) await parent.handle.close();
				}
			},
		};
	} catch (error) {
		try {
			await file?.close();
		} finally {
			for (const parent of parents.reverse()) await parent.handle.close();
		}
		throw error;
	}
}
