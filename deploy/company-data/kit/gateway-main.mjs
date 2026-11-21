// The data gateway's entry in the kit (docker-compose.yml, service data-gateway). It reads its settings from the
// environment and its secrets from files, then serves the gateway (../gateway/gateway.mjs) over HTTP and starts its
// watcher. scripts/package-company-data-gateway.mjs bundles it with the gateway and pg into the one file a machine runs.
//   DATA_STORE_HOST, DATA_STORE_PORT   the store, on the compose network
//   DATA_LOGINS                        a folder of one file per secret, as init.sh writes them (lib.sh says which):
//                                      each file's name, in camelCase, is its key in the gateway's store.logins
//   DATA_PLATFORM_URL, DATA_PLATFORM_KEY   the platform's API and its publishable key
//   DATA_LISTEN                        address:port to listen on (inside the container)
//   DATA_RUN_DOOR, DATA_RUN_SECRETS    the run door (run-door.yml): address:port to listen on, and the folder of its
//                                      token, door.key and door.crt. Unset, no run door listens and the gateway holds
//                                      no run token.
import cluster from "node:cluster";
import { readdirSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { Gateway, Platform, serve, serveRuns, startWatcher } from "../gateway/gateway.mjs";

const setting = (name) => {
	const value = process.env[name];
	if (!value) {
		console.error(`data gateway: ${name} is not set`);
		process.exit(2);
	}
	return value;
};

const folder = setting("DATA_LOGINS");
const logins = {};
for (const file of readdirSync(folder).sort()) {
	if (!/^[a-z]+(-[a-z]+)*$/.test(file)) continue;
	const value = readFileSync(join(folder, file), "utf8").trim();
	if (!value) {
		console.error(`data gateway: the secret ${file} is empty`);
		process.exit(2);
	}
	logins[file.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
}

const address = (name) => {
	const listen = setting(name);
	const at = listen.lastIndexOf(":");
	const port = Number(listen.slice(at + 1));
	if (at < 1 || !Number.isInteger(port) || port < 1 || port > 65535) {
		console.error(`data gateway: ${name} is address:port`);
		process.exit(2);
	}
	return { host: listen.slice(0, at).replace(/^\[|\]$/g, ""), port };
};
const { host, port } = address("DATA_LISTEN");

// The run door's secrets: read here, kept in memory, never logged. A door that cannot start (a secret missing or
// unreadable) stays shut and says why; the members' door starts as always.
let runs = null;
let runsOff = null;
if (process.env.DATA_RUN_DOOR) {
	try {
		const secrets = process.env.DATA_RUN_SECRETS;
		if (!secrets) throw new Error("DATA_RUN_SECRETS is not set");
		const read = (file) => {
			try {
				return readFileSync(join(secrets, file), "utf8");
			} catch (error) {
				throw new Error(`its ${file} cannot be read (${error?.code ?? "error"})`);
			}
		};
		const token = read("token").trim();
		if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("its token is not 43 base64url characters");
		const cert = read("door.crt");
		const key = read("door.key");
		runs = { ...address("DATA_RUN_DOOR"), token, cert, key };
	} catch (error) {
		runsOff = String(error?.message ?? error);
	}
}

const rawWorkers = (process.env.DATA_WORKERS ?? "1").trim().toLowerCase();
const workerCount =
	rawWorkers === "auto"
		? Math.max(1, Math.min(4, availableParallelism()))
		: Math.max(1, Math.min(16, Number.isInteger(Number(rawWorkers)) ? Number(rawWorkers) : 1));

const adminToken = process.env.DATA_ADMIN_TOKEN?.trim() || null;

const gateway = new Gateway({
	store: { host: setting("DATA_STORE_HOST"), port: Number(process.env.DATA_STORE_PORT ?? 5432), logins },
	platform: new Platform({ url: setting("DATA_PLATFORM_URL"), publishableKey: setting("DATA_PLATFORM_KEY") }),
	workers: workerCount,
	...(runs ? { runs: { token: runs.token } } : {}),
	...(adminToken ? { admin: { token: adminToken } } : {}),
	...(cluster.isWorker
		? {
				onAgentRead: ({ pid, delta }) => {
					if (process.connected) process.send?.({ type: "agentRead", pid, delta });
				},
				onDrop: (event) => {
					if (process.connected) process.send?.({ type: "drop", ...event });
				},
				onUnsettledTx: (database, txid) => {
					if (process.connected) process.send?.({ type: "unsettledTx", database, txid });
				},
			}
		: {}),
});

if (workerCount > 1 && cluster.isPrimary) {
	let lastFull = [];
	const workerReads = new Map();
	const broadcast = (message) => {
		for (const worker of Object.values(cluster.workers ?? {})) {
			if (worker?.isConnected()) worker.send(message);
		}
	};
	const stopWatcher = startWatcher(gateway, {
		failed: (error) =>
			console.error(`data gateway: the watcher's look failed: ${error?.code ?? ""} ${String(error?.message ?? error).slice(0, 200)}`),
		onLook: (looked) => {
			lastFull = looked.full;
			broadcast({ type: "full", databases: lastFull });
		},
	});
	let stopping = false;
	const crashTimes = [];
	const restartTimers = new Set();
	const spawnWorker = () => {
		const worker = cluster.fork();
		workerReads.set(worker.id, new Map());
		worker.on("online", () => {
			if (lastFull.length > 0 && worker.isConnected()) worker.send({ type: "full", databases: lastFull });
		});
		worker.on("message", (message) => {
			if (message?.type === "unsettledTx" && typeof message.database === "string" && typeof message.txid === "string") {
				gateway.noteUnsettledTx(message.database, message.txid);
				return;
			}
			if (message?.type === "drop") {
				if (message.kind === "company" && typeof message.database === "string") void gateway.evictCompany(message.database);
				else if (message.kind === "database" && typeof message.database === "string" && typeof message.schema === "string")
					void gateway.evictDatabase(message.database, message.schema, message.n ?? null);
				for (const peer of Object.values(cluster.workers ?? {})) {
					if (peer && peer.id !== worker.id && peer.isConnected()) peer.send(message);
				}
				return;
			}
			if (message?.type !== "agentRead" || !Number.isInteger(message.pid) || !Number.isInteger(message.delta)) return;
			const owned = workerReads.get(worker.id);
			if (!owned) return;
			const next = (owned.get(message.pid) ?? 0) + message.delta;
			if (next > 0) owned.set(message.pid, next);
			else owned.delete(message.pid);
			gateway.setAgentRead(message.pid, message.delta);
		});
		return worker;
	};
	for (let i = 0; i < workerCount; i++) spawnWorker();
	cluster.on("exit", (worker, code, signal) => {
		const owned = workerReads.get(worker.id);
		if (owned) {
			for (const [pid, count] of owned) gateway.setAgentRead(pid, -count);
			workerReads.delete(worker.id);
		}
		if (stopping) return;
		const now = Date.now();
		crashTimes.push(now);
		while (crashTimes.length > 0 && now - crashTimes[0] > 30_000) crashTimes.shift();
		if (crashTimes.length > 10) {
			console.error("data gateway: workers crashed repeatedly within 30s, exiting");
			stopping = true;
			stopWatcher();
			for (const timer of restartTimers) clearTimeout(timer);
			gateway.close().finally(() => process.exit(1));
			return;
		}
		const delay = Math.min(5_000, 200 * 2 ** Math.min(5, crashTimes.length - 1));
		console.error(`data gateway: worker ${worker.process.pid} exited (code=${code} signal=${signal}), restarting in ${delay}ms`);
		const timer = setTimeout(() => {
			restartTimers.delete(timer);
			if (!stopping) spawnWorker();
		}, delay);
		restartTimers.add(timer);
	});
	console.log(
		`data gateway: primary started ${workerCount} workers on ${host}:${port}, store ${process.env.DATA_STORE_HOST}, secrets ${Object.keys(logins).join(", ")}`,
	);
	const stop = async () => {
		if (stopping) return;
		stopping = true;
		stopWatcher();
		for (const timer of restartTimers) clearTimeout(timer);
		restartTimers.clear();
		const active = Object.values(cluster.workers ?? {}).filter(Boolean);
		const drained = Promise.all(
			active.map(
				(worker) =>
					new Promise((resolve) => {
						if (worker.isDead()) return resolve();
						worker.once("exit", resolve);
						worker.kill("SIGTERM");
					}),
			),
		);
		await Promise.race([drained, new Promise((resolve) => setTimeout(resolve, 5_000))]);
		await gateway.close();
		process.exit(0);
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
} else {
	if (cluster.isWorker) {
		process.on("message", (message) => {
			if (message?.type === "full") gateway.setFullDatabases(message.databases);
			else if (message?.type === "drop") {
				if (message.kind === "company" && typeof message.database === "string") void gateway.evictCompany(message.database);
				else if (message.kind === "database" && typeof message.database === "string" && typeof message.schema === "string")
					void gateway.evictDatabase(message.database, message.schema, message.n ?? null);
			}
		});
	}
	const server = await serve(gateway, { host, port });
	let runServer = null;
	if (runs) {
		try {
			runServer = await serveRuns(gateway, { host: runs.host, port: runs.port, cert: runs.cert, key: runs.key });
		} catch (error) {
			runsOff = `it did not start: ${String(error?.message ?? error).slice(0, 200)}`;
		}
	}
	const stopWatcher =
		cluster.isWorker
			? () => undefined
			: startWatcher(gateway, {
					failed: (error) =>
						console.error(`data gateway: the watcher's look failed: ${error?.code ?? ""} ${String(error?.message ?? error).slice(0, 200)}`),
				});
	if (!cluster.isWorker) {
		console.log(`data gateway: listening on ${host}:${port}, store ${process.env.DATA_STORE_HOST}, secrets ${Object.keys(logins).join(", ")}`);
		if (runServer) console.log(`data gateway: run door listening on ${runs.host}:${runs.port} over TLS`);
		else if (runsOff) console.error(`data gateway: run door: off (${runsOff})`);
		else console.log("data gateway: no run door");
	}
	let stopping = false;
	const stop = async () => {
		if (stopping) return;
		stopping = true;
		stopWatcher();
		const closings = [server, runServer].filter(Boolean).map((one) => {
			one.closeIdleConnections?.();
			return new Promise((resolve) => {
				one.close(() => resolve());
			});
		});
		await Promise.race([Promise.all(closings), new Promise((resolve) => setTimeout(resolve, 4_000))]);
		for (const one of [server, runServer]) one?.closeAllConnections?.();
		await gateway.close();
		process.exit(0);
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
}
