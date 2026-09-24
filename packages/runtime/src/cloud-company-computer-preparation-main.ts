import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPANY_COMPUTER_PREPARATION_MAX_BYTES } from "@qorpera/contracts";
import { assertCompanyComputerImageArtifact } from "./cloud-company-computer-linux-host.ts";
import { prepareCompanyComputerGuest } from "./cloud-company-computer-preparation.ts";
import { assertGuestImageSelfUpdateMasked, GUEST_IMAGE_SELF_UPDATE_ENABLED } from "./lxd-guest-image-updates.ts";

const requestPath = "/etc/qorpera-office/preparation.json";
async function readRequest(signal: AbortSignal): Promise<Buffer> {
	signal.throwIfAborted();
	await assertCompanyComputerImageArtifact(requestPath);
	const file = await open(requestPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await file.stat({ bigint: true });
		if (
			!before.isFile() ||
			before.uid !== 0n ||
			before.nlink !== 1n ||
			(before.mode & 0o6022n) !== 0n ||
			before.size < 1n ||
			before.size > BigInt(COMPANY_COMPUTER_PREPARATION_MAX_BYTES)
		)
			throw new Error("OFFICE_PREPARATION_REQUEST_UNPROTECTED");
		const bytes = Buffer.alloc(Number(before.size) + 1);
		let length = 0;
		while (length < bytes.length) {
			signal.throwIfAborted();
			const read = await file.read(bytes, length, bytes.length - length, null);
			if (!read.bytesRead) break;
			length += read.bytesRead;
		}
		const after = await file.stat({ bigint: true });
		if (
			length !== Number(before.size) ||
			(["dev", "ino", "uid", "gid", "mode", "size", "nlink", "mtimeNs", "ctimeNs"] as const).some(
				(key) => before[key] !== after[key],
			)
		)
			throw new Error("OFFICE_PREPARATION_REQUEST_CHANGED");
		signal.throwIfAborted();
		return bytes.subarray(0, length);
	} finally {
		await file.close();
	}
}

/** The provider captures one bounded JSON report from this read-only process.
 * Only systemd's invocation identity is read from the environment; credentials,
 * endpoints, inherited configuration and executable arguments are not accepted.
 * A report is evidence for provider review, never admission. */
export async function runCompanyComputerPreparationMain(): Promise<
	Awaited<ReturnType<typeof prepareCompanyComputerGuest>> & { requestSha256: string; invocationId: string }
> {
	if (process.platform !== "linux" || !process.getuid?.() || process.getuid() !== process.geteuid?.())
		throw new Error("UNPRIVILEGED_LINUX_OFFICE_REQUIRED");
	const invocationId = process.env.INVOCATION_ID;
	if (!invocationId || !/^(?!0{32}$)[0-9a-f]{32}$/.test(invocationId))
		throw new Error("OFFICE_PREPARATION_INVOCATION_REQUIRED");
	const stop = new AbortController();
	const shutdown = () => stop.abort();
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(300000)]);
	try {
		// No company state is copied into an image that can update itself.
		await assertGuestImageSelfUpdateMasked();
		const bytes = await readRequest(signal);
		const result = await prepareCompanyComputerGuest(
			JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)),
			signal,
		);
		if (!bytes.equals(await readRequest(signal))) throw new Error("OFFICE_PREPARATION_REQUEST_CHANGED");
		signal.throwIfAborted();
		return { ...result, requestSha256: createHash("sha256").update(bytes).digest("hex"), invocationId };
	} finally {
		stop.abort();
		process.removeListener("SIGINT", shutdown);
		process.removeListener("SIGTERM", shutdown);
	}
}

if (
	process.argv[1] &&
	["cloud-company-computer-preparation-main.ts", "qorpera-company-computer-preparation.mjs"].includes(
		basename(process.argv[1]),
	) &&
	realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
) {
	if (process.argv.length === 3 && process.argv[2] === "--help")
		console.log(
			"Read-only office guest preparation. Requires protected provider configuration; emits evidence without admission.",
		);
	else if (process.argv.length !== 2) {
		console.error("Office preparation accepts only --help; configuration must be provider-installed.");
		process.exitCode = 1;
	} else
		runCompanyComputerPreparationMain()
			.then((result) => console.log(JSON.stringify(result)))
			.catch((error: unknown) => {
				console.error(
					error instanceof Error && error.message.startsWith(`${GUEST_IMAGE_SELF_UPDATE_ENABLED}:`)
						? error.message
						: "Office preparation could not verify the configured boot and copied state.",
				);
				process.exitCode = 1;
			});
}
