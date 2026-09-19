import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { HttpCloudCodingControl } from "./cloud-coding-control.ts";
import { CloudCodingCompletionListener } from "./cloud-coding-listener.ts";
import { systemdCredentialMetadataIsSafe } from "./systemd-credential.ts";

/** Dedicated cloud service. It owns no model process, VM or public mouth. */
export async function runCloudCodingListenerMain(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
	if (process.platform !== "linux" || !process.getuid?.() || !process.geteuid?.())
		throw new Error("UNPRIVILEGED_LINUX_REQUIRED");
	const directory = environment.CREDENTIALS_DIRECTORY;
	if (!directory || resolve(directory) !== directory || (await realpath(directory)) !== directory)
		throw new Error("CODING_LISTENER_CREDENTIALS_REQUIRED");
	const stop = new AbortController();
	const shutdown = () => stop.abort();
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	const read = async (name: "qorpera-coding-listener-config" | "qorpera-coding-registry"): Promise<string> => {
		stop.signal.throwIfAborted();
		const handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
		let bytes: Buffer | undefined;
		try {
			const metadata = await handle.stat();
			if (
				!systemdCredentialMetadataIsSafe({ ...metadata, isFile: metadata.isFile() }, process.getuid?.(), 8192) ||
				metadata.size < 1 ||
				metadata.nlink !== 1
			)
				throw new Error("CODING_LISTENER_CREDENTIAL_UNSAFE");
			bytes = await handle.readFile();
			if (bytes.length !== metadata.size) throw new Error("CODING_LISTENER_CREDENTIAL_CHANGED");
			return new TextDecoder("utf8", { fatal: true }).decode(bytes).trim();
		} finally {
			bytes?.fill(0);
			await handle.close();
		}
	};
	try {
		const config: unknown = JSON.parse(await read("qorpera-coding-listener-config"));
		if (
			!config ||
			typeof config !== "object" ||
			Array.isArray(config) ||
			Object.keys(config).sort().join() !== "owner,supabaseUrl" ||
			!("owner" in config) ||
			!("supabaseUrl" in config) ||
			typeof config.owner !== "string" ||
			typeof config.supabaseUrl !== "string"
		)
			throw new Error("CODING_LISTENER_CONFIG_INVALID");
		const control = new HttpCloudCodingControl({
			supabaseUrl: config.supabaseUrl,
			serviceRoleKey: await read("qorpera-coding-registry"),
		});
		const listener = new CloudCodingCompletionListener(control, config.owner);
		while (!stop.signal.aborted) {
			try {
				const result = await listener.tick(stop.signal);
				if (result.inspected) console.log(JSON.stringify({ event: "coding-completion-listener", ...result }));
			} catch {
				if (!stop.signal.aborted) console.error("CODING_LISTENER_TICK_UNCONFIRMED");
			}
			await setTimeout(5000, undefined, { signal: stop.signal }).catch(() => undefined);
		}
	} finally {
		process.off("SIGINT", shutdown);
		process.off("SIGTERM", shutdown);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	runCloudCodingListenerMain().catch(() => {
		console.error("CODING_LISTENER_START_FAILED");
		process.exitCode = 1;
	});
}
