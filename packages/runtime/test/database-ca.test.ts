import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer, type Server } from "node:tls";
import { type DatabaseCaCredentials, databaseTls } from "@qorpera/runtime/database-ca";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let dir = "";
function openssl(args: string[]) {
	execFileSync("openssl", args, { stdio: "ignore" });
}
function selfSigned(tag: string, ca: boolean) {
	const key = join(dir, `${tag}.key`);
	const cert = join(dir, `${tag}.crt`);
	openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key]);
	openssl([
		"req",
		"-new",
		"-x509",
		"-key",
		key,
		"-out",
		cert,
		"-days",
		"2",
		"-subj",
		`/CN=qorpera-test-${tag}`,
		"-addext",
		`basicConstraints=critical,CA:${ca ? "TRUE" : "FALSE"}`,
	]);
	return { key, cert, bytes: readFileSync(cert) };
}
function serverCertificate(tag: string, issuer: { key: string; cert: string }, name: string) {
	const key = join(dir, `${tag}.key`);
	openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key]);
	openssl(["req", "-new", "-key", key, "-out", join(dir, `${tag}.csr`), "-subj", `/CN=${name}`]);
	writeFileSync(join(dir, `${tag}.ext`), `subjectAltName=DNS:${name}\nbasicConstraints=critical,CA:FALSE\n`);
	openssl([
		"x509",
		"-req",
		"-in",
		join(dir, `${tag}.csr`),
		"-CA",
		issuer.cert,
		"-CAkey",
		issuer.key,
		"-set_serial",
		"1",
		"-days",
		"2",
		"-extfile",
		join(dir, `${tag}.ext`),
		"-out",
		join(dir, `${tag}.crt`),
	]);
	return { key: readFileSync(key), cert: readFileSync(join(dir, `${tag}.crt`)) };
}

let ownCa: ReturnType<typeof selfSigned>;
let otherCa: ReturnType<typeof selfSigned>;
let notCa: ReturnType<typeof selfSigned>;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "qorpera-database-ca-"));
	ownCa = selfSigned("own", true);
	otherCa = selfSigned("other", true);
	notCa = selfSigned("leaf", false);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const refused = (credentials: DatabaseCaCredentials) => () => databaseTls(credentials, "Test service");

describe("databaseTls", () => {
	it("trusts our pinned CA and fails closed when missing or half-supplied", () => {
		const pin = createHash("sha256").update(ownCa.bytes).digest("hex");
		expect(
			databaseTls(
				{
					ownCa: ownCa.bytes,
					ownCaSha256: pin,
				},
				"Test service",
			),
		).toEqual({ ca: ownCa.bytes.toString("utf8"), rejectUnauthorized: true });
		expect(refused({})).toThrow("Test service database CA is invalid");
		expect(refused({ ownCa: ownCa.bytes })).toThrow("Test service database CA is invalid");
		expect(refused({ ownCaSha256: pin })).toThrow("Test service database CA is invalid");
	});

	it("refuses a pin the file does not match", () => {
		expect(
			refused({
				ownCa: ownCa.bytes,
				ownCaSha256: createHash("sha256").update(otherCa.bytes).digest("hex"),
			}),
		).toThrow("Test service database CA is invalid");
		expect(
			refused({
				ownCa: Buffer.concat([ownCa.bytes, Buffer.from("\n")]),
				ownCaSha256: createHash("sha256").update(ownCa.bytes).digest("hex"),
			}),
		).toThrow("Test service database CA is invalid");
		for (const pin of [
			"",
			createHash("sha256").update(ownCa.bytes).digest("hex").toUpperCase(),
			createHash("sha256").update(ownCa.bytes).digest("hex").slice(1),
			"x".repeat(64),
		]) {
			expect(refused({ ownCa: ownCa.bytes, ownCaSha256: pin })).toThrow("Test service database CA is invalid");
		}
	});

	it("refuses an own CA file that is not exactly one CA certificate, even with a matching pin", () => {
		const two = Buffer.concat([ownCa.bytes, otherCa.bytes]);
		const notPem = Buffer.from("not a certificate\n");
		for (const bytes of [two, notCa.bytes, notPem, Buffer.alloc(0)]) {
			expect(
				refused({
					ownCa: bytes,
					ownCaSha256: createHash("sha256").update(bytes).digest("hex"),
				}),
			).toThrow("Test service database CA is invalid");
		}
	});
});

describe("verify-full with our own CA", () => {
	let server: Server;
	let port = 0;
	let wrongName: Server;
	let wrongNamePort = 0;
	const listen = async (certificate: { key: Buffer; cert: Buffer }) => {
		const listening = createServer({ key: certificate.key, cert: certificate.cert }, (socket) => socket.end());
		await new Promise<void>((resolveListen) => listening.listen(0, "127.0.0.1", resolveListen));
		return listening;
	};
	beforeAll(async () => {
		server = await listen(serverCertificate("database", ownCa, "database.qorpera.test"));
		port = (server.address() as AddressInfo).port;
		wrongName = await listen(serverCertificate("elsewhere", ownCa, "elsewhere.qorpera.test"));
		wrongNamePort = (wrongName.address() as AddressInfo).port;
	});
	afterAll(async () => {
		await new Promise((resolveClose) => server.close(resolveClose));
		await new Promise((resolveClose) => wrongName.close(resolveClose));
	});
	const handshake = (options: { ca: string; rejectUnauthorized: true }, to: number) =>
		new Promise<string>((resolveHandshake) => {
			const socket = connect({ ...options, host: "127.0.0.1", port: to, servername: "database.qorpera.test" });
			socket.once("secureConnect", () => {
				socket.destroy();
				resolveHandshake("verified");
			});
			socket.once("error", (error: NodeJS.ErrnoException) => {
				socket.destroy();
				resolveHandshake(error.code ?? "error");
			});
		});

	it("verifies the server's certificate and name against our own CA, and refuses wrong names or issuers", async () => {
		const own = databaseTls(
			{
				ownCa: ownCa.bytes,
				ownCaSha256: createHash("sha256").update(ownCa.bytes).digest("hex"),
			},
			"Test service",
		);
		expect(await handshake(own, port)).toBe("verified");
		expect(await handshake(own, wrongNamePort)).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
		const other = databaseTls(
			{
				ownCa: otherCa.bytes,
				ownCaSha256: createHash("sha256").update(otherCa.bytes).digest("hex"),
			},
			"Test service",
		);
		expect(await handshake(other, port)).not.toBe("verified");
	});
});
