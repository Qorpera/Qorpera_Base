import { spawn } from "node:child_process";
import { realpathSync, writeSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { isAbsolute, resolve } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

/**
 * Keeps the native program's stdout and stderr blocking. Node creates process.stdout and process.stderr when they are
 * first read, and its own code reads them: Readable.pipe compares its destination with both, and a net.Socket's destroy
 * compares itself with stderr. Creating one sets O_NONBLOCK on the socket behind it, and the program inherits that very
 * open file. Codex's stdout writer takes any failed write as the end of the connection, so one message over the socket's
 * buffer (a PNG in a tool result, a large file's arguments) would leave the run silent for good, its lease renewing
 * (7 Nov 2026). So here they are plain writers of the same descriptors, and the real streams are never made.
 */
function keepInheritedStdioBlocking(): void {
	for (const [name, fd] of [
		["stdout", 1],
		["stderr", 2],
	] as const) {
		const stream = new Writable({
			write(chunk: Buffer, _encoding, done) {
				try {
					writeSync(fd, chunk);
					done();
				} catch (error) {
					done(error as Error);
				}
			},
		});
		Object.defineProperty(process, name, { configurable: true, enumerable: true, value: stream });
	}
}

/** Runs inside the empty network/PID namespace. The only outbound transport
 * is the mounted, host-filtered Unix relay; TLS remains native end-to-end. */
export async function runNativeIsolationChild(args: string[]): Promise<void> {
	keepInheritedStdioBlocking();
	const [relayPath, command, ...commandArgs] = args;
	if (!relayPath || !isAbsolute(relayPath) || !command || !isAbsolute(command))
		throw new Error("Invalid native namespace entry");
	const sockets = new Set<Socket>();
	const server = createServer((client) => {
		if (sockets.size >= 16) {
			client.destroy();
			return;
		}
		const relay = createConnection(relayPath);
		sockets.add(client);
		sockets.add(relay);
		const close = (): void => {
			client.destroy();
			relay.destroy();
			sockets.delete(client);
			sockets.delete(relay);
		};
		client.on("error", close);
		relay.on("error", close);
		client.once("close", close);
		relay.once("close", close);
		client.setTimeout(30_000, close);
		relay.setTimeout(30_000, close);
		client.pipe(relay);
		relay.pipe(client);
	});
	await new Promise<void>((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolveListen();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Native namespace proxy unavailable");
	const proxy = `http://127.0.0.1:${address.port}`;
	const child = spawn(command, commandArgs, {
		stdio: "inherit",
		env: {
			...process.env,
			HTTPS_PROXY: proxy,
			HTTP_PROXY: proxy,
			https_proxy: proxy,
			http_proxy: proxy,
			ALL_PROXY: proxy,
			all_proxy: proxy,
			NO_PROXY: "",
			no_proxy: "",
		},
	});
	const stop = (): void => {
		child.kill("SIGTERM");
	};
	server.on("error", () => child.kill("SIGKILL"));
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	try {
		process.exitCode = await new Promise<number>((resolveExit, reject) => {
			child.once("error", reject);
			child.once("exit", (code) => resolveExit(code ?? 1));
		});
	} finally {
		process.removeListener("SIGTERM", stop);
		process.removeListener("SIGINT", stop);
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	}
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
	runNativeIsolationChild(process.argv.slice(2)).catch(() => {
		process.stderr.write("Native namespace entry failed\n");
		process.exitCode = 1;
	});
}
