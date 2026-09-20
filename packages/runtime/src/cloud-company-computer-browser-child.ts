import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Runs inside the browser's otherwise empty network namespace. The Unix
 * relay is its only route out. DevTools stays on inherited descriptors 3/4;
 * there is no debugging listener available to a page, desktop or shell. */
export async function runCompanyComputerBrowserChild(args: string[]): Promise<void> {
	const [relayPath, executable, ...browserArgs] = args;
	if (relayPath !== "/run/qorpera/egress.sock" || executable !== "/usr/lib/qorpera-chromium/chrome")
		throw new Error("INVALID_OFFICE_BROWSER_ENTRY");
	const sockets = new Set<Socket>();
	const server = createServer((peer) => {
		if (sockets.size >= 128) {
			peer.destroy();
			return;
		}
		const upstream = createConnection(relayPath);
		sockets.add(peer);
		sockets.add(upstream);
		const close = (): void => {
			peer.destroy();
			upstream.destroy();
		};
		for (const socket of [peer, upstream]) {
			socket.on("error", close);
			socket.once("close", () => {
				sockets.delete(socket);
				close();
			});
			socket.setTimeout(30000, close);
		}
		peer.pipe(upstream);
		upstream.pipe(peer);
	});
	await new Promise<void>((ready, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			ready();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("OFFICE_BROWSER_PROXY_UNAVAILABLE");
	const child = spawn(
		executable,
		[
			// The launch service supplies its uniquely owned startup URL. Appending
			// a second anonymous blank here would create an unowned tab each start.
			...browserArgs,
			`--proxy-server=http://127.0.0.1:${address.port}`,
			"--proxy-bypass-list=<-loopback>",
		],
		{
			stdio: ["ignore", "inherit", "inherit", 3, 4],
			env: { ...process.env },
		},
	);
	const stop = (): void => {
		child.kill("SIGTERM");
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	server.on("error", () => child.kill("SIGKILL"));
	try {
		process.exitCode = await new Promise<number>((exited, reject) => {
			child.once("error", reject);
			child.once("close", (code) => exited(code ?? 1));
		});
	} finally {
		process.removeListener("SIGTERM", stop);
		process.removeListener("SIGINT", stop);
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((closed) => server.close(() => closed()));
	}
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
	runCompanyComputerBrowserChild(process.argv.slice(2)).catch(() => {
		process.stderr.write("Office browser entry failed\n");
		process.exitCode = 1;
	});
}
