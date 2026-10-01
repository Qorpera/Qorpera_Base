#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SupabaseFolderCore } from "./core.ts";
import { LxdMachines } from "./machines.ts";
import { MountGrants, parseOperatorMounts } from "./mounts.ts";
import { NasObjects } from "./objects.ts";
import { createFolderServer } from "./server.ts";
import { FolderService } from "./service.ts";

/** The node's folder service. Under systemd it takes its configuration and the service credential from
 * `LoadCredential=` (qorpera-folder-config, qorpera-supabase-service-key) and its socket from
 * `qorpera-folder-service.socket`; see deploy/folder-service/. */

function credential(name: string): string {
	const directory = process.env.CREDENTIALS_DIRECTORY;
	if (!directory) throw new Error("CREDENTIALS_DIRECTORY is not set: run under systemd with LoadCredential=");
	return readFileSync(join(directory, name), "utf8").trim();
}

interface Config {
	readonly supabaseUrl: string;
	readonly storageRoot: string;
	readonly lxdSocket?: string;
	readonly cacheMiB?: number;
	readonly mounts: unknown;
}

function config(): Config {
	const value = JSON.parse(credential("qorpera-folder-config")) as Record<string, unknown>;
	const known = ["supabaseUrl", "storageRoot", "lxdSocket", "cacheMiB", "mounts"];
	for (const key of Object.keys(value)) if (!known.includes(key)) throw new Error(`Unknown configuration key ${key}`);
	if (typeof value.supabaseUrl !== "string" || typeof value.storageRoot !== "string")
		throw new Error("supabaseUrl and storageRoot are required");
	if (value.lxdSocket !== undefined && typeof value.lxdSocket !== "string")
		throw new Error("lxdSocket must be a path");
	if (value.cacheMiB !== undefined && (!Number.isSafeInteger(value.cacheMiB) || (value.cacheMiB as number) < 16))
		throw new Error("cacheMiB must be a whole number of at least 16");
	return value as unknown as Config;
}

const log = (line: string): void => {
	process.stderr.write(`${line}\n`);
};
const settings = config();
const service = new FolderService({
	core: new SupabaseFolderCore({
		projectUrl: settings.supabaseUrl,
		secretKey: credential("qorpera-supabase-service-key"),
	}),
	objects: new NasObjects({ root: settings.storageRoot, cacheBytes: (settings.cacheMiB ?? 1024) * 1024 * 1024 }),
	grants: new MountGrants(parseOperatorMounts(settings.mounts), new LxdMachines(settings.lxdSocket)),
	log,
});
const server = createFolderServer(service, log);
// Socket activation: systemd passes the listening socket as fd 3 and sets its owner, group and mode.
if (process.env.LISTEN_FDS !== "1" || process.env.LISTEN_PID !== String(process.pid))
	throw new Error("Start through qorpera-folder-service.socket (expected exactly one socket from systemd)");
server.listen({ fd: 3 }, () => log("folder-service: serving on the socket from systemd"));
service.start();
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.on(signal, () => {
		service.stop();
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 5_000).unref();
	});
