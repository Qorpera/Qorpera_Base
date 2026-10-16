#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTROL_SOCKET, createControlServer } from "./control.ts";
import { SupabaseFolderCore } from "./core.ts";
import { parseMachineProject, parseMachineRef } from "./machines.ts";
import { MountGrants, parseOperatorMounts } from "./mounts.ts";
import { NasObjects } from "./objects.ts";
import { createFolderServer } from "./server.ts";
import { FolderService } from "./service.ts";
import { FolderStaging, GatewayUploads } from "./staging.ts";

/** The node's folder service. Under systemd it takes its configuration and the service credential from
 * `LoadCredential=` (qorpera-folder-config, qorpera-supabase-service-key, and for writes qorpera-folder-gateway-token),
 * its socket from `qorpera-folder-service.socket`, and on a node with coding machines its control socket from
 * `qorpera-folder-control.socket` (named `control`); see deploy/folder-service/. */

function credential(name: string): string {
	const directory = process.env.CREDENTIALS_DIRECTORY;
	if (!directory) throw new Error("CREDENTIALS_DIRECTORY is not set: run under systemd with LoadCredential=");
	return readFileSync(join(directory, name), "utf8").trim();
}

interface Config {
	readonly supabaseUrl: string;
	readonly storageRoot: string;
	readonly cacheMiB?: number;
	readonly mounts: unknown;
	/** The machines on this node that may present the core's run box views: its execution host. */
	readonly runBoxHosts?: unknown;
	/** The LXD projects of this node's company machines: each machine there may present its own desktop views (F3 4a). */
	readonly companyMachineProjects?: unknown;
	/** The LXD projects of this node's coding machines: each machine there may present its own sessions' views (F3 5c). */
	readonly codingMachineProjects?: unknown;
	/** The coding executor's uid: the only one the control socket's file may let connect (F3 5c). */
	readonly codingExecutorUid?: number;
	/** Writes through the mount (F3 step 3): the object gateway that stores the views' bytes. Without it, every view is
	 * read-only. Its token is the credential qorpera-folder-gateway-token. */
	readonly gatewayUrl?: string;
}

function config(): Config {
	const value = JSON.parse(credential("qorpera-folder-config")) as Record<string, unknown>;
	const known = [
		"supabaseUrl",
		"storageRoot",
		"cacheMiB",
		"mounts",
		"runBoxHosts",
		"companyMachineProjects",
		"codingMachineProjects",
		"codingExecutorUid",
		"gatewayUrl",
	];
	for (const key of Object.keys(value)) if (!known.includes(key)) throw new Error(`Unknown configuration key ${key}`);
	if (typeof value.supabaseUrl !== "string" || typeof value.storageRoot !== "string")
		throw new Error("supabaseUrl and storageRoot are required");
	// The unit's MemoryMax is 3G: the cache plus trees, connections and Node itself must fit.
	const cache = value.cacheMiB;
	if (cache !== undefined && (typeof cache !== "number" || !Number.isSafeInteger(cache) || cache < 16 || cache > 2048))
		throw new Error("cacheMiB must be a whole number from 16 to 2048");
	if (value.runBoxHosts !== undefined && !Array.isArray(value.runBoxHosts))
		throw new Error("runBoxHosts must be a list");
	if (value.companyMachineProjects !== undefined && !Array.isArray(value.companyMachineProjects))
		throw new Error("companyMachineProjects must be a list");
	if (value.codingMachineProjects !== undefined && !Array.isArray(value.codingMachineProjects))
		throw new Error("codingMachineProjects must be a list");
	const executor = value.codingExecutorUid;
	if (executor !== undefined && (typeof executor !== "number" || !Number.isSafeInteger(executor) || executor <= 0))
		throw new Error("codingExecutorUid must be the coding executor's uid, not root's");
	if (value.gatewayUrl !== undefined && typeof value.gatewayUrl !== "string")
		throw new Error("gatewayUrl must be a URL");
	return value as unknown as Config;
}

const log = (line: string): void => {
	process.stderr.write(`${line}\n`);
};
const settings = config();
const core = new SupabaseFolderCore({
	projectUrl: settings.supabaseUrl,
	secretKey: credential("qorpera-supabase-service-key"),
});
const objects = new NasObjects({ root: settings.storageRoot, cacheBytes: (settings.cacheMiB ?? 1024) * 1024 * 1024 });
const service = new FolderService({
	core,
	objects,
	...(settings.gatewayUrl
		? {
				staging: new FolderStaging(
					core,
					new GatewayUploads({ url: settings.gatewayUrl, token: credential("qorpera-folder-gateway-token") }),
					objects,
				),
			}
		: {}),
	grants: new MountGrants(
		parseOperatorMounts(settings.mounts),
		Array.isArray(settings.runBoxHosts) ? settings.runBoxHosts.map(parseMachineRef) : [],
		Array.isArray(settings.companyMachineProjects) ? settings.companyMachineProjects.map(parseMachineProject) : [],
		Array.isArray(settings.codingMachineProjects) ? settings.codingMachineProjects.map(parseMachineProject) : [],
	),
	log,
});

/** Socket activation: systemd passes the listening sockets from fd 3 on, named by the units' FileDescriptorName=, and
 * sets their owners, groups and modes. The control socket is `control`; the other is the folder socket. */
function listenFds(): { readonly folder: number; readonly control?: number } {
	const count = Number(process.env.LISTEN_FDS);
	if (process.env.LISTEN_PID !== String(process.pid) || (count !== 1 && count !== 2))
		throw new Error("Start through qorpera-folder-service.socket (expected one or two sockets from systemd)");
	const names = (process.env.LISTEN_FDNAMES ?? "").split(":");
	const fds = Array.from({ length: count }, (_, index) => 3 + index);
	const control = fds.filter((_, index) => names[index] === "control");
	const folder = fds.filter((_, index) => names[index] !== "control");
	if (folder.length !== 1 || control.length > 1)
		throw new Error("Expected the folder socket and at most one socket named control from systemd");
	return { folder: folder[0] as number, ...(control.length === 1 ? { control: control[0] as number } : {}) };
}

const fds = listenFds();
const server = createFolderServer(service, log);
server.listen({ fd: fds.folder }, () => log("folder-service: serving on the socket from systemd"));
let control: ReturnType<typeof createControlServer> | undefined;
if (fds.control !== undefined) {
	if (settings.codingExecutorUid === undefined)
		log("folder-service: codingExecutorUid is not configured; the control socket refuses every connection");
	control = createControlServer({
		target: service,
		path: CONTROL_SOCKET,
		executorUid: settings.codingExecutorUid,
		log,
	});
	control.listen({ fd: fds.control }, () => log("folder-service: serving the control socket from systemd"));
}
service.start();
/** The unit's TimeoutStopSec= is 60s: a clean stop has 45 of them to release and publish its coding views. */
const STOP_DEADLINE_MS = 45_000;
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.on(signal, () => {
		if (stopping) return;
		stopping = true;
		server.close();
		control?.close();
		const deadline = new Promise<false>((resolve) => setTimeout(() => resolve(false), STOP_DEADLINE_MS));
		void Promise.race([service.stopCleanly(), deadline])
			.catch((error: unknown) => {
				log(`folder-service: the clean stop failed: ${(error as Error).message}`);
				return false;
			})
			.then((clean) => {
				// Its coding views stay marked served: the next run refuses them, and their machines restart.
				if (!clean) log("folder-service: stopped without a clean stop");
				process.exit(0);
			});
	});
