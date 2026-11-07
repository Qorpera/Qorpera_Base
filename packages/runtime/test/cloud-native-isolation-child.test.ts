import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CHILD = fileURLToPath(new URL("../src/cloud-native-isolation-child.ts", import.meta.url));
/** Larger than a Unix socket's send buffer (212,992 bytes by default), as a PNG in a tool result is. */
const LARGE_MESSAGE_BYTES = 1024 * 1024;

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

	/** Built as the runtime bundle builds it, and run with no flags, as the host runs it. */
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
});
