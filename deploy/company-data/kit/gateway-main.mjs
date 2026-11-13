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
import { readdirSync, readFileSync } from "node:fs";
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

// The run door's secrets: read here, kept in memory, never logged.
let runs = null;
if (process.env.DATA_RUN_DOOR) {
	const secrets = setting("DATA_RUN_SECRETS");
	const read = (file) => {
		try {
			return readFileSync(join(secrets, file), "utf8");
		} catch {
			console.error(`data gateway: the run door's ${file} cannot be read`);
			process.exit(2);
		}
	};
	const token = read("token").trim();
	if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
		console.error("data gateway: the run door's token is not 43 base64url characters");
		process.exit(2);
	}
	runs = { ...address("DATA_RUN_DOOR"), token, cert: read("door.crt"), key: read("door.key") };
}

const gateway = new Gateway({
	store: { host: setting("DATA_STORE_HOST"), port: Number(process.env.DATA_STORE_PORT ?? 5432), logins },
	platform: new Platform({ url: setting("DATA_PLATFORM_URL"), publishableKey: setting("DATA_PLATFORM_KEY") }),
	...(runs ? { runs: { token: runs.token } } : {}),
});
const server = await serve(gateway, { host, port });
const runServer = runs ? await serveRuns(gateway, { host: runs.host, port: runs.port, cert: runs.cert, key: runs.key }) : null;
// The watcher (design §3): every 10 s it ends what runs past its limit and closes writes at a company's size limit.
const stopWatcher = startWatcher(gateway, {
	failed: (error) => console.error(`data gateway: the watcher's look failed: ${error?.code ?? ""} ${String(error?.message ?? error).slice(0, 200)}`),
});
// Names only: never a secret.
console.log(`data gateway: listening on ${host}:${port}, store ${process.env.DATA_STORE_HOST}, secrets ${Object.keys(logins).join(", ")}`);
console.log(runs ? `data gateway: run door listening on ${runs.host}:${runs.port} over TLS` : "data gateway: no run door");

let stopping = false;
const stop = async () => {
	if (stopping) return;
	stopping = true;
	stopWatcher();
	for (const one of [server, runServer]) {
		if (!one) continue;
		one.close();
		one.closeAllConnections();
	}
	await gateway.close();
	process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
