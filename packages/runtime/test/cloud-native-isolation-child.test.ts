import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CHILD = fileURLToPath(new URL("../src/cloud-native-isolation-child.ts", import.meta.url));
/** Larger than a Unix socket's send buffer (212,992 bytes by default), as a PNG in a tool result is. */
const LARGE_MESSAGE_BYTES = 1024 * 1024;
/** The pinned Codex build's sha256, as the runner image pins it. */
const CODEX_PIN: string = JSON.parse(
	readFileSync(
		new URL("../../../deploy/first-node/native-codex/guest-package-manifest.json", import.meta.url),
		"utf8",
	),
).nativeCompany.binarySha256;
/** The pinned Codex: the file QORPERA_CODEX_FENCE_BINARY names, else, on a test machine (run-on-node's set-up marker),
 * where the test machines keep it. There the test must run: a missing file or another build fails it, never skips it.
 * Elsewhere, with neither, it skips. QORPERA_CODEX_FENCE_UNPINNED=1 runs a build that is not yet the pin. */
const CODEX =
	process.env.QORPERA_CODEX_FENCE_BINARY ||
	(existsSync("/etc/qorpera-test-machine-versions") ? "/opt/qorpera-codex-fence/codex" : undefined);
const O_NONBLOCK = 0o4000;

/**
 * The native program, not in Node, so any O_NONBLOCK on what it inherited is the entry's: it goes out through the
 * entry's proxy twice, once ended by the relay and once by itself, then writes one large message to its stdout as Codex's
 * writer does (a write_all that takes any error as the end), and records what it saw.
 */
const PROGRAM = `#!/usr/bin/python3
import fcntl, json, os, socket, sys, time, urllib.parse
proxy = urllib.parse.urlparse(os.environ["HTTPS_PROXY"])
first = socket.create_connection((proxy.hostname, proxy.port))
first.sendall(b"hello")
answer = b""
while True:
    chunk = first.recv(4096)
    if not chunk:
        break
    answer += chunk
first.close()
second = socket.create_connection((proxy.hostname, proxy.port))
second.sendall(b"bye")
second.close()
time.sleep(0.1)
written, error = 0, None
message = b"x" * ${LARGE_MESSAGE_BYTES}
try:
    while written < len(message):
        written += os.write(1, message[written:])
except OSError as cause:
    error = cause.errno
blocking = lambda fd: not fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_NONBLOCK
with open(sys.argv[1], "w") as out:
    json.dump({"answer": answer.decode(), "stdout": blocking(1), "stderr": blocking(2), "written": written, "error": error}, out)
`;

describe.skipIf(process.platform !== "linux")("the native entry", () => {
	let root: string;
	let relay: Server;
	let relayed: string;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "q-native-entry-"));
		relayed = "";
		// The host's relay: ends the connection itself on "hello", and notes a connection the program ended.
		relay = createServer((socket) => {
			socket.on("error", () => undefined);
			socket.on("data", (chunk) => {
				relayed += chunk;
				if (String(chunk) === "hello") socket.end("echo:hello");
			});
			socket.on("end", () => {
				relayed += "<end>";
			});
		});
		await new Promise<void>((resolve) => relay.listen(join(root, "relay.sock"), resolve));
	});
	afterEach(async () => {
		await new Promise((resolve) => relay.close(resolve));
		await rm(root, { recursive: true, force: true });
	});

	/** Its own source without its types (the runtime bundle's build adds only a banner and its target), run with no flags,
	 * as the host runs it. */
	const built = async (): Promise<string> => {
		const path = join(root, "entry.mjs");
		await writeFile(path, transformSync(await readFile(CHILD, "utf8"), { loader: "ts", format: "esm" }).code);
		return path;
	};

	it("still says when it could not start", async () => {
		const entry = spawn(process.execPath, [await built(), "relative-path"], { stdio: ["ignore", "ignore", "pipe"] });
		let said = "";
		entry.stderr.on("data", (chunk) => {
			said += chunk;
		});
		expect(await new Promise((resolve) => entry.once("close", resolve))).toBe(1);
		expect(said).toBe("Native namespace entry failed\n");
	});

	it("leaves the program's stdout and stderr blocking after its connections, so a large message waits for its reader", async () => {
		const program = join(root, "program.py");
		const result = join(root, "result.json");
		await writeFile(program, PROGRAM);
		await chmod(program, 0o755);
		const entry = spawn(process.execPath, [await built(), join(root, "relay.sock"), program, result], {
			stdio: ["pipe", "pipe", "pipe"],
			cwd: root,
		});
		// The host reads late: long enough for a writer that does not wait to find the buffer full.
		let received = 0;
		const closed = new Promise<number | null>((resolve) => entry.once("close", resolve));
		entry.stderr.resume();
		await new Promise((resolve) => setTimeout(resolve, 500));
		entry.stdout.on("data", (chunk: Buffer) => {
			received += chunk.length;
		});
		expect(await closed).toBe(0);
		// Each side's end reaches the other: the relay's ended the first connection, the program's the second.
		expect(relayed).toBe("hello<end>bye<end>");
		expect(JSON.parse(await readFile(result, "utf8"))).toEqual({
			answer: "echo:hello",
			stdout: true,
			stderr: true,
			written: LARGE_MESSAGE_BYTES,
			error: null,
		});
		expect(received).toBe(LARGE_MESSAGE_BYTES);
	}, 20_000);

	// No model and no network: the answer to a skills/list of many folders is a large message, as a PNG's echo is.
	it.skipIf(!CODEX)(
		"keeps the real Codex answering after a message larger than its socket's buffer",
		async () => {
			const codex = CODEX as string;
			expect(existsSync(codex), `${codex} is missing: push the pinned Codex (deploy/test-machine/README.md)`).toBe(
				true,
			);
			if (process.env.QORPERA_CODEX_FENCE_UNPINNED !== "1") {
				const hash = createHash("sha256");
				for await (const chunk of createReadStream(codex)) hash.update(chunk as Buffer);
				expect(hash.digest("hex"), `${codex} is not the pinned build`).toBe(CODEX_PIN);
			}
			const entry = spawn(
				process.execPath,
				[await built(), join(root, "relay.sock"), codex, "app-server", "--listen", "stdio://"],
				{
					cwd: root,
					detached: true,
					stdio: ["pipe", "pipe", "pipe"],
					env: { HOME: root, CODEX_HOME: root, PATH: process.env.PATH, NO_COLOR: "1" },
				},
			);
			try {
				entry.stderr.resume();
				const answers = new Map<number, number>();
				const waiting = new Map<number, () => void>();
				let line: Buffer[] = [];
				entry.stdout.on("data", (chunk: Buffer) => {
					for (let rest = chunk; ; ) {
						const end = rest.indexOf(10);
						if (end < 0) {
							line.push(rest);
							return;
						}
						const whole = Buffer.concat([...line, rest.subarray(0, end)]);
						line = [];
						rest = rest.subarray(end + 1);
						const id = (JSON.parse(whole.toString()) as { id?: unknown }).id;
						if (typeof id === "number") {
							answers.set(id, whole.length);
							waiting.get(id)?.();
						}
					}
				});
				const ask = (id: number, method: string, params: unknown): Promise<number> => {
					entry.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
					return new Promise((resolve) => {
						waiting.set(id, () => resolve(answers.get(id) as number));
					});
				};
				await ask(1, "initialize", {
					clientInfo: { name: "entry-test", version: "1" },
					capabilities: { experimentalApi: true },
				});
				entry.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
				const [pid] = (await readFile(`/proc/${entry.pid}/task/${entry.pid}/children`, "utf8")).trim().split(/\s+/);
				// A connection through the entry's proxy, opened and ended, as the entry's first ones are.
				const environment = (await readFile(`/proc/${pid}/environ`, "utf8")).split("\0");
				const proxy = new URL(environment.find((item) => item.startsWith("HTTPS_PROXY="))?.split("=")[1] as string);
				await new Promise((resolve) => {
					const socket = connect(Number(proxy.port), proxy.hostname, () => socket.write("hello"));
					socket.resume();
					socket.on("error", resolve);
					socket.on("close", resolve);
				});
				const nonblocking = async (fd: number): Promise<boolean> => {
					const flags = (await readFile(`/proc/${pid}/fdinfo/${fd}`, "utf8")).match(
						/flags:\s+(\d+)/,
					)?.[1] as string;
					return (Number.parseInt(flags, 8) & O_NONBLOCK) !== 0;
				};
				expect([await nonblocking(1), await nonblocking(2)]).toEqual([false, false]);
				// The host reads late, so that a writer that does not wait finds the buffer full.
				entry.stdout.pause();
				const cwds = Array.from({ length: 100 }, (_, index) => join(root, `no-such-folder-${index}`));
				const large = ask(2, "skills/list", { cwds, forceReload: true });
				await new Promise((resolve) => setTimeout(resolve, 1000));
				entry.stdout.resume();
				expect(await large).toBeGreaterThan(212_992);
				// The link is alive: the writer did not end.
				expect(await ask(3, "config/read", { includeLayers: false, cwd: root })).toBeGreaterThan(0);
			} finally {
				process.kill(-(entry.pid as number), "SIGKILL");
				await new Promise((resolve) => entry.once("close", resolve));
			}
		},
		30_000,
	);
});
