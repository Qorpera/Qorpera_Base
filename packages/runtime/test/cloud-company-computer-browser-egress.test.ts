import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createConnection, createServer as createNetServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer, connect as tlsConnect } from "node:tls";
import {
	companyComputerBrowserEgressHost,
	startCompanyComputerBrowserEgress,
} from "@qorpera/runtime/cloud-company-computer-browser-egress";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { computerDeferred } from "./fixtures/company-computer.ts";

let certificateRoot: string;
let cert: Buffer;
let key: Buffer;
const cleanups: Array<() => Promise<unknown>> = [];
beforeAll(async () => {
	certificateRoot = await mkdtemp(join(await realpath(tmpdir()), "office-egress-cert-"));
	const generated = spawnSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			join(certificateRoot, "key.pem"),
			"-out",
			join(certificateRoot, "cert.pem"),
			"-days",
			"1",
			"-subj",
			"/CN=browser.example",
			"-addext",
			"subjectAltName=DNS:browser.example",
		],
		{ timeout: 15000, stdio: "ignore" },
	);
	if (generated.status !== 0) throw new Error("Disposable certificate generation failed");
	cert = await readFile(join(certificateRoot, "cert.pem"));
	key = await readFile(join(certificateRoot, "key.pem"));
});
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});
afterAll(async () => {
	await rm(certificateRoot, { recursive: true, force: true });
});

async function fixture(extra: Partial<Parameters<typeof startCompanyComputerBrowserEgress>[0]> = {}) {
	// Leave room for the Unix socket name under macOS's isolated test TMPDIR.
	const root = await mkdtemp(join(await realpath(tmpdir()), "oe-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const signal = new AbortController();
	const assertActive = vi.fn(async (_signal: AbortSignal) => undefined);
	const onFailure = vi.fn();
	const transport = {
		resolve: vi.fn(async (_host: string, _signal: AbortSignal) => ["93.184.216.34"]),
		connect: vi.fn((_address: string) => new Socket()),
	};
	const options = { root, assertActive, signal: signal.signal, onFailure, transport, ...extra };
	const relay = await startCompanyComputerBrowserEgress(options);
	cleanups.push(() => relay.close());
	const peer = createConnection(relay.path);
	peer.on("error", () => undefined);
	cleanups.push(async () => {
		peer.destroy();
	});
	await once(peer, "connect");
	return { root, signal, assertActive, onFailure, transport, options, relay, peer };
}

const header = "CONNECT browser.example:443 HTTP/1.1\r\nHost: browser.example:443\r\n\r\n";
async function denied(peer: Socket, bytes: string) {
	const closed = once(peer, "close");
	peer.write(bytes);
	await closed;
}

describe("office browser public HTTPS relay", () => {
	it("accepts canonical DNS origins and refuses IP, local, malformed and alternate numeric destinations", () => {
		expect(companyComputerBrowserEgressHost("browser.example")).toBe("browser.example");
		expect(companyComputerBrowserEgressHost("xn--bcher-kva.example")).toBe("xn--bcher-kva.example");
		for (const host of [
			"localhost",
			"app.localhost",
			"app.local",
			"127.0.0.1",
			"127.1",
			"2130706433",
			"0x7f.0.0.1",
			"0177.0.0.1",
			"[::1]",
			"Browser.example",
			"browser.example.",
			"browser..example",
			"-bad.example",
			"user@browser.example",
		])
			expect(() => companyComputerBrowserEgressHost(host)).toThrow("OFFICE_BROWSER_DESTINATION_DENIED");
	});
	it.each([
		"GET https://browser.example/ HTTP/1.1\r\n\r\n",
		"CONNECT browser.example:80 HTTP/1.1\r\nHost: browser.example:80\r\n\r\n",
		"CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n",
		"CONNECT browser.example:443 HTTP/1.1\r\n\r\n",
		"CONNECT browser.example:443 HTTP/1.1\r\nHost: different.example:443\r\n\r\n",
		"CONNECT browser.example:443 HTTP/1.1\r\nHost: browser.example:443\r\nAuthorization: synthetic\r\n\r\n",
		"CONNECT browser.example:443 HTTP/1.1\r\nHost: browser.example:443\r\nProxy-Authorization: synthetic\r\n\r\n",
		"CONNECT browser.example:443 HTTP/1.1\r\nHost: browser.example:443\r\nHost: browser.example:443\r\n\r\n",
	])("rejects an unauthorized proxy header before DNS: %s", async (request) => {
		const f = await fixture();
		await denied(f.peer, request);
		expect(f.transport.resolve).not.toHaveBeenCalled();
		expect(f.transport.connect).not.toHaveBeenCalled();
	});
	it("rejects any private or invalid answer in a DNS set without dialing", async () => {
		for (const address of [
			"127.0.0.1",
			"10.0.0.1",
			"192.168.0.91",
			"169.254.169.254",
			"100.64.0.1",
			"::1",
			"::ffff:127.0.0.1",
		]) {
			const f = await fixture();
			f.transport.resolve.mockResolvedValue(["93.184.216.34", address]);
			await denied(f.peer, header);
			expect(f.transport.connect).not.toHaveBeenCalled();
		}
	});
	it("keeps TLS end to end and closes an established encrypted tunnel on revocation", async () => {
		const upstream = createTlsServer({ cert, key }, (socket) => {
			socket.on("error", () => undefined);
			socket.on("data", (bytes) => socket.write(Buffer.concat([Buffer.from("reply:"), bytes])));
		});
		upstream.on("tlsClientError", () => undefined);
		await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
		cleanups.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
		const address = upstream.address();
		if (!address || typeof address === "string") throw new Error("Fixture listener missing");
		const f = await fixture();
		// The destination transport is deliberately synthetic. Real TLS runs
		// through the actual Unix relay; no public server or credential is used.
		f.transport.connect.mockImplementation((literal) => {
			expect(literal).toBe("93.184.216.34");
			return createConnection({ host: "127.0.0.1", port: address.port });
		});
		const connected = once(f.peer, "data");
		f.peer.write(header);
		expect((await connected)[0].toString()).toBe("HTTP/1.1 200 Connection Established\r\n\r\n");
		const tls = tlsConnect({ socket: f.peer, servername: "browser.example", ca: cert, rejectUnauthorized: true });
		tls.on("error", () => undefined);
		await once(tls, "secureConnect");
		expect(tls.authorized).toBe(true);
		const response = once(tls, "data");
		tls.write("synthetic browser bytes");
		expect((await response)[0].toString()).toBe("reply:synthetic browser bytes");
		expect(f.transport.resolve).toHaveBeenCalledTimes(1);
		f.assertActive.mockRejectedValue(new Error("fixture consent revoked"));
		const closed = once(tls, "close");
		await closed;
		expect(f.onFailure).toHaveBeenCalledOnce();
		await f.relay.close();
	});
	it("pauses its network without ending the browser while authority says nobody is present, and waits out no answer only for the grace", async () => {
		const echo = createNetServer((socket) => {
			socket.on("error", () => undefined);
			socket.pipe(socket);
		});
		await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
		cleanups.push(() => new Promise<void>((resolve) => echo.close(() => resolve())));
		const address = echo.address();
		if (!address || typeof address === "string") throw new Error("Fixture listener missing");
		const paused = new Error("fixture: nobody present");
		const unanswered = new Error("fixture: no answer");
		const f = await fixture({
			classifyFailure: (error) => (error === paused ? "paused" : error === unanswered ? "unanswered" : "refused"),
			graceMs: 2500,
		});
		f.transport.connect.mockImplementation(() => createConnection({ host: "127.0.0.1", port: address.port }));
		const tunnel = async (peer: Socket) => {
			const connected = once(peer, "data");
			peer.write(header);
			expect((await connected)[0].toString()).toBe("HTTP/1.1 200 Connection Established\r\n\r\n");
		};
		await tunnel(f.peer);
		// Nobody entitled present: the established tunnel goes, the relay stays.
		f.assertActive.mockRejectedValue(paused);
		await once(f.peer, "close");
		const refused = createConnection(f.relay.path);
		refused.on("error", () => undefined);
		await once(refused, "connect");
		await denied(refused, header);
		await new Promise((resolve) => setTimeout(resolve, 3000));
		expect(f.onFailure).not.toHaveBeenCalled();
		// Somebody is back: traffic flows again through the same relay.
		f.assertActive.mockResolvedValue(undefined);
		const again = createConnection(f.relay.path);
		again.on("error", () => undefined);
		cleanups.push(async () => {
			again.destroy();
		});
		await once(again, "connect");
		await tunnel(again);
		// No answer at all: paused as well, and ended once the grace has passed.
		f.assertActive.mockRejectedValue(unanswered);
		await once(again, "close");
		expect(f.onFailure).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(f.onFailure).toHaveBeenCalledOnce(), { timeout: 5000 });
	}, 20000);
	it("rechecks authority after DNS and cannot open a socket after revocation", async () => {
		const f = await fixture();
		f.transport.resolve.mockImplementation(async () => {
			f.assertActive.mockRejectedValue(new Error("fixture revoked"));
			return ["93.184.216.34"];
		});
		await denied(f.peer, header);
		expect(f.transport.connect).not.toHaveBeenCalled();
	});
	it("waits for an in-flight DNS operation during shutdown and never dials its late result", async () => {
		const f = await fixture();
		const dns = computerDeferred<string[]>();
		f.transport.resolve.mockImplementation(() => dns.promise);
		f.peer.write(header);
		await vi.waitFor(() => expect(f.transport.resolve).toHaveBeenCalledOnce());
		let stopped = false;
		const closing = f.relay.close().then(() => {
			stopped = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(stopped).toBe(false);
		expect(f.transport.resolve.mock.calls[0][1].aborted).toBe(true);
		dns.resolve(["93.184.216.34"]);
		await closing;
		expect(f.transport.connect).not.toHaveBeenCalled();
	});
	it("requires private storage and live authority before publishing a listener", async () => {
		const f = await fixture();
		await f.relay.close();
		await chmod(f.root, 0o755);
		await expect(startCompanyComputerBrowserEgress(f.options)).rejects.toThrow("UNSAFE_OFFICE_BROWSER_EGRESS_ROOT");
		await chmod(f.root, 0o700);
		await expect(startCompanyComputerBrowserEgress({ ...f.options, signal: AbortSignal.abort() })).rejects.toThrow();
	});
});
