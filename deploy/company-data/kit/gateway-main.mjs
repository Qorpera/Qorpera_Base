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
import {
	createDirectoryPublicReader,
	createHttpPublicReader,
	Gateway,
	Platform,
	serve,
	serveRuns,
	startWatcher,
} from "../gateway/gateway.mjs";

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

const failConfig = (message) => {
	console.error(`data gateway: ${message}`);
	process.exit(2);
};

const readOptionalToken = (envName, fileEnvName, minLength = 32) => {
	const raw = process.env[envName]?.trim() || "";
	const file = process.env[fileEnvName]?.trim() || "";
	if (raw && file) failConfig(`set only one of ${envName} or ${fileEnvName}`);
	let value = raw;
	if (file) {
		try {
			value = readFileSync(file, "utf8").trim();
		} catch (error) {
			failConfig(`${fileEnvName} cannot be read (${error?.code ?? "error"})`);
		}
		if (!value) failConfig(`${fileEnvName} is empty`);
	}
	if (!value) return null;
	if (value.length < minLength || /[\r\n\0]/.test(value)) {
		failConfig(`${file ? fileEnvName : envName} must be at least ${minLength} single-line characters`);
	}
	return value;
};

const readOptionalInt = (envName, min, max, fallback) => {
	const raw = process.env[envName]?.trim() || "";
	if (!raw) return fallback;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
		failConfig(`${envName} must be an integer from ${min} to ${max}`);
	}
	return parsed;
};

const buildFolderReader = ({ urlEnv, dirEnv, tokenEnv, tokenFileEnv, cacheEnv }) => {
	const url = process.env[urlEnv]?.trim() || "";
	const dir = process.env[dirEnv]?.trim() || "";
	if (url && dir) failConfig(`set only one of ${urlEnv} or ${dirEnv}`);
	if (url) {
		const token = readOptionalToken(tokenEnv, tokenFileEnv, 1);
		const cacheMs = readOptionalInt(cacheEnv, 0, 60_000, 0);
		try {
			return createHttpPublicReader({ url, token, cacheMs });
		} catch (error) {
			failConfig(String(error?.message ?? error));
		}
	}
	if (dir) {
		try {
			return createDirectoryPublicReader({ rootDir: dir });
		} catch (error) {
			failConfig(String(error?.message ?? error));
		}
	}
	return null;
};

const adminToken = readOptionalToken("DATA_ADMIN_TOKEN", "DATA_ADMIN_TOKEN_FILE");
const directLoginToken = readOptionalToken("DATA_DIRECT_LOGIN_TOKEN", "DATA_DIRECT_LOGIN_TOKEN_FILE");
const directHost = process.env.DATA_DIRECT_HOST?.trim() || null;
const directPort = readOptionalInt("DATA_DIRECT_PORT", 1, 65535, null);
const hookToken = readOptionalToken("DATA_HOOK_TOKEN", "DATA_HOOK_TOKEN_FILE");
const publicReader = buildFolderReader({
	urlEnv: "DATA_PUBLIC_READER_URL",
	dirEnv: "DATA_PUBLIC_DIR",
	tokenEnv: "DATA_PUBLIC_READER_TOKEN",
	tokenFileEnv: "DATA_PUBLIC_READER_TOKEN_FILE",
	cacheEnv: "DATA_PUBLIC_READER_CACHE_MS",
});
const hookReader = buildFolderReader({
	urlEnv: "DATA_HOOK_READER_URL",
	dirEnv: "DATA_HOOK_DIR",
	tokenEnv: "DATA_HOOK_READER_TOKEN",
	tokenFileEnv: "DATA_HOOK_READER_TOKEN_FILE",
	cacheEnv: "DATA_HOOK_READER_CACHE_MS",
});
const triggerToken = readOptionalToken("DATA_TRIGGER_TOKEN", "DATA_TRIGGER_TOKEN_FILE");
const triggerWakeUrl = process.env.DATA_TRIGGER_WAKE_URL?.trim() || null;
const triggerWakeToken = readOptionalToken("DATA_TRIGGER_WAKE_TOKEN", "DATA_TRIGGER_WAKE_TOKEN_FILE", 1);
const triggerWakeTimeoutMs = readOptionalInt("DATA_TRIGGER_WAKE_TIMEOUT_MS", 500, 30_000, 5_000);

const safeSend = (target, message) => {
	try {
		target?.send?.(message, () => undefined);
	} catch {}
};

const broadcastToWorkers = (message) => {
	for (const worker of Object.values(cluster.workers ?? {})) {
		if (worker?.isConnected()) safeSend(worker, message);
	}
};

const pendingTriggerRpc = new Map();
let triggerRpcSeq = 0;
const callPrimaryTriggerRpc = (op, payload) =>
	new Promise((resolve, reject) => {
		if (!process.connected) {
			reject(Object.assign(new Error("The data gateway primary is unavailable"), { status: 503 }));
			return;
		}
		const reqId = `${process.pid}:${++triggerRpcSeq}`;
		const timer = setTimeout(() => {
			pendingTriggerRpc.delete(reqId);
			reject(Object.assign(new Error("Trigger operation timed out"), { status: 503 }));
		}, 10_000);
		timer.unref?.();
		pendingTriggerRpc.set(reqId, { resolve, reject, timer });
		safeSend(process, { type: "triggerRpc", reqId, op, payload });
	});

const pendingTestSchemaRpc = new Map();
let testSchemaRpcSeq = 0;
const callPrimaryTestSchemaRpc = (op, payload) =>
	new Promise((resolve, reject) => {
		if (!process.connected) {
			reject(Object.assign(new Error("The data gateway primary is unavailable"), { status: 503 }));
			return;
		}
		const reqId = `${process.pid}:${++testSchemaRpcSeq}`;
		const timer = setTimeout(() => {
			pendingTestSchemaRpc.delete(reqId);
			reject(Object.assign(new Error("Test schema operation timed out"), { status: 503 }));
		}, 10_000);
		timer.unref?.();
		pendingTestSchemaRpc.set(reqId, { resolve, reject, timer });
		safeSend(process, { type: "testSchemaRpc", reqId, op, payload });
	});

const testSchemaConfig = cluster.isWorker
	? {
			reaper: false,
			rpc: {
				reserve: (payload) => callPrimaryTestSchemaRpc("reserve", payload),
				release: (payload) => callPrimaryTestSchemaRpc("release", payload),
				touch: (payload) => callPrimaryTestSchemaRpc("touch", payload),
				check: (payload) => callPrimaryTestSchemaRpc("check", payload),
				expiries: (payload) => callPrimaryTestSchemaRpc("expiries", payload),
			},
		}
	: null;

const directLoginConfig =
	directLoginToken || directHost || directPort !== null
		? {
				...(directLoginToken ? { token: directLoginToken } : {}),
				...(directHost ? { host: directHost } : {}),
				...(directPort !== null ? { port: directPort } : {}),
			}
		: null;

const triggerConfig =
	triggerToken || triggerWakeUrl || cluster.isWorker
		? {
				...(triggerToken ? { token: triggerToken } : {}),
				...(triggerWakeUrl
					? {
							wakeUrl: triggerWakeUrl,
							wakeToken: triggerWakeToken,
							wakeTimeoutMs: triggerWakeTimeoutMs,
							onWakeError: (error) =>
								console.error(`data gateway: trigger wake failed: ${String(error?.message ?? error).slice(0, 200)}`),
						}
					: {}),
				...(cluster.isWorker
					? {
							rpc: {
								register: (payload) => callPrimaryTriggerRpc("register", payload),
								list: (payload) => callPrimaryTriggerRpc("list", payload),
								unregister: (payload) => callPrimaryTriggerRpc("unregister", payload),
							},
						}
					: {}),
			}
		: null;

let gateway;
try {
	gateway = new Gateway({
		store: { host: setting("DATA_STORE_HOST"), port: Number(process.env.DATA_STORE_PORT ?? 5432), logins },
		platform: new Platform({ url: setting("DATA_PLATFORM_URL"), publishableKey: setting("DATA_PLATFORM_KEY") }),
		workers: workerCount,
		...(runs ? { runs: { token: runs.token } } : {}),
		...(adminToken ? { admin: { token: adminToken } } : {}),
		...(directLoginConfig ? { directLogin: directLoginConfig } : {}),
		...(hookToken ? { hooks: { token: hookToken, ...(hookReader ? { reader: hookReader } : {}) } } : {}),
		...(publicReader ? { publicReader } : {}),
		...(triggerConfig ? { triggers: triggerConfig } : {}),
		...(testSchemaConfig ? { testSchemas: testSchemaConfig } : {}),
		...(workerCount > 1 && cluster.isPrimary
			? {
					onTestSchemaDrop: (event) => {
						broadcastToWorkers({ type: "testSchemaDrop", ...event });
					},
				}
			: {}),
		...(cluster.isWorker
			? {
					onAgentRead: ({ pid, delta }) => {
						if (process.connected) safeSend(process, { type: "agentRead", pid, delta });
					},
					onDrop: (event) => {
						if (process.connected) safeSend(process, { type: "drop", ...event });
					},
					onTestSchemaDrop: (event) => {
						if (process.connected) safeSend(process, { type: "testSchemaDrop", ...event });
					},
					onUnsettledTx: (database, txid) => {
						if (process.connected) safeSend(process, { type: "unsettledTx", database, txid });
					},
				}
			: {}),
	});
} catch (error) {
	failConfig(String(error?.message ?? error));
}

if (workerCount > 1 && cluster.isPrimary) {
	let lastFull = [];
	const workerReads = new Map();
	const stopWatcher = startWatcher(gateway, {
		failed: (error) =>
			console.error(`data gateway: the watcher's look failed: ${error?.code ?? ""} ${String(error?.message ?? error).slice(0, 200)}`),
		onLook: (looked) => {
			lastFull = looked.full;
			broadcastToWorkers({ type: "full", databases: lastFull });
			if (Array.isArray(looked.ended) && looked.ended.length > 0) {
				broadcastToWorkers({ type: "signalled", pids: looked.ended.map((row) => row.pid) });
			}
		},
	});
	let stopping = false;
	const crashTimes = [];
	const restartTimers = new Set();
	const spawnWorker = () => {
		const worker = cluster.fork();
		worker.on("error", () => undefined);
		workerReads.set(worker.id, new Map());
		worker.on("online", () => {
			if (lastFull.length > 0 && worker.isConnected()) safeSend(worker, { type: "full", databases: lastFull });
		});
		worker.on("message", (message) => {
			if (message?.type === "unsettledTx" && typeof message.database === "string" && typeof message.txid === "string") {
				gateway.noteUnsettledTx(message.database, message.txid);
				return;
			}
			if (message?.type === "triggerRpc" && typeof message.reqId === "string") {
				void (async () => {
					try {
						let result;
						if (message.op === "register") {
							await gateway.registerDataTrigger(message.payload);
							result =
								gateway.listDataTriggers(message.payload.environmentId).find((item) => item.id === message.payload.id) ?? {
									id: message.payload.id,
									environmentId: message.payload.environmentId,
									database: message.payload.database,
								};
						} else if (message.op === "list") {
							result = gateway.listDataTriggers(message.payload.environmentId, { database: message.payload.database ?? null });
						} else if (message.op === "unregister") {
							result = gateway.unregisterDataTrigger(message.payload.id, message.payload.environmentId);
						} else {
							throw Object.assign(new Error("Unknown trigger operation"), { status: 400 });
						}
						if (worker.isConnected()) safeSend(worker, { type: "triggerRpcReply", reqId: message.reqId, ok: true, result });
					} catch (error) {
						if (worker.isConnected()) {
							safeSend(worker, {
								type: "triggerRpcReply",
								reqId: message.reqId,
								ok: false,
								status: Number.isInteger(error?.status) ? error.status : 500,
								message: typeof error?.message === "string" ? error.message : "The data gateway failed",
							});
						}
					}
				})();
				return;
			}
			if (message?.type === "testSchemaRpc" && typeof message.reqId === "string") {
				void (async () => {
					try {
						let result;
						if (message.op === "reserve") {
							result = await gateway.reserveTestSchema(message.payload);
						} else if (message.op === "release") {
							result = gateway.releaseTestSchema(message.payload.database, message.payload.schema);
						} else if (message.op === "touch") {
							result = gateway.touchTestSchema(message.payload);
						} else if (message.op === "check") {
							result = gateway.checkTestSchema(message.payload.database, message.payload.schema);
						} else if (message.op === "expiries") {
							result = gateway.testSchemaExpiries(message.payload.database);
						} else {
							throw Object.assign(new Error("Unknown test schema operation"), { status: 400 });
						}
						if (worker.isConnected()) safeSend(worker, { type: "testSchemaRpcReply", reqId: message.reqId, ok: true, result });
					} catch (error) {
						if (worker.isConnected()) {
							safeSend(worker, {
								type: "testSchemaRpcReply",
								reqId: message.reqId,
								ok: false,
								status: Number.isInteger(error?.status) ? error.status : 500,
								message: typeof error?.message === "string" ? error.message : "The data gateway failed",
							});
						}
					}
				})();
				return;
			}
			if (message?.type === "testSchemaDrop" && typeof message.database === "string" && typeof message.schema === "string") {
				void gateway.evictTestSchema(message.database, message.schema);
				for (const peer of Object.values(cluster.workers ?? {})) {
					if (peer && peer.id !== worker.id && peer.isConnected()) safeSend(peer, message);
				}
				return;
			}
			if (message?.type === "drop") {
				if (message.kind === "company" && typeof message.database === "string") void gateway.evictCompany(message.database);
				else if (message.kind === "database" && typeof message.database === "string" && typeof message.schema === "string")
					void gateway.evictDatabase(message.database, message.schema, message.n ?? null);
				for (const peer of Object.values(cluster.workers ?? {})) {
					if (peer && peer.id !== worker.id && peer.isConnected()) safeSend(peer, message);
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
			else if (message?.type === "signalled" && Array.isArray(message.pids)) gateway.noteSignalled(message.pids);
			else if (message?.type === "testSchemaDrop" && typeof message.database === "string" && typeof message.schema === "string") {
				void gateway.evictTestSchema(message.database, message.schema);
			} else if (message?.type === "triggerRpcReply" && typeof message.reqId === "string") {
				const pending = pendingTriggerRpc.get(message.reqId);
				if (!pending) return;
				pendingTriggerRpc.delete(message.reqId);
				clearTimeout(pending.timer);
				if (message.ok) pending.resolve(message.result);
				else pending.reject(Object.assign(new Error(message.message ?? "The data gateway failed"), { status: message.status ?? 500 }));
			} else if (message?.type === "testSchemaRpcReply" && typeof message.reqId === "string") {
				const pending = pendingTestSchemaRpc.get(message.reqId);
				if (!pending) return;
				pendingTestSchemaRpc.delete(message.reqId);
				clearTimeout(pending.timer);
				if (message.ok) pending.resolve(message.result);
				else pending.reject(Object.assign(new Error(message.message ?? "The data gateway failed"), { status: message.status ?? 500 }));
			} else if (message?.type === "drop") {
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
		const enabledDoors = [
			adminToken || directLoginToken ? "direct-login" : null,
			publicReader ? "public-reader" : null,
			hookToken ? "hook-data" : null,
			(adminToken || triggerToken) && triggerWakeUrl ? "triggers" : null,
		].filter(Boolean);
		if (enabledDoors.length > 0) console.log(`data gateway: external doors enabled: ${enabledDoors.join(", ")}`);
	}
	let stopping = false;
	const stop = async () => {
		if (stopping) return;
		stopping = true;
		stopWatcher();
		for (const pending of pendingTriggerRpc.values()) {
			clearTimeout(pending.timer);
			pending.reject(Object.assign(new Error("The data gateway is stopping"), { status: 503 }));
		}
		pendingTriggerRpc.clear();
		for (const pending of pendingTestSchemaRpc.values()) {
			clearTimeout(pending.timer);
			pending.reject(Object.assign(new Error("The data gateway is stopping"), { status: 503 }));
		}
		pendingTestSchemaRpc.clear();
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
