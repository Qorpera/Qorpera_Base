import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import type { ClientRequestArgs } from "node:http";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { createSecureContext, type SecureContext, connect as tlsConnect } from "node:tls";
import { readLxdOfficeCredentialFile, readLxdOfficeProtectedFile } from "./lxd-office-physical-host.ts";

/** Each service's own access to LXD's loopback HTTPS listener (WS15 V2-A1..A6), in place of its socket group. The
 * listener record is `listener.json` (root's, 0644); each account's client certificate and key are
 * `<account>/client.crt` and `<account>/client.key`, root's, in a 0750 folder of the account's group, the key 0440. */
export const LXD_ACCESS_ROOT = "/etc/qorpera-lxd-ids";
const LISTENER_SCHEMA = "qorpera.lxd-listener/v1";
const LISTENER_KEYS = "certificateSha256,origin,schema";
/** Loopback only, with an explicit port; no path, query or user part. */
const LISTENER_ORIGIN = /^https:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/;
const ACCOUNT = /^[a-z_][a-z0-9_-]{0,31}$/;
const MAX_LISTENER_BYTES = 4096;
const MAX_IDENTITY_BYTES = 16384;
/** The TCP connect and the TLS handshake; a call's own deadline still covers both. */
const HANDSHAKE_MS = 5000;

/** Opens one pinned connection for node:http's `createConnection`. It returns nothing and hands the socket over only
 * after the handshake and the pin check, so node:http sends no request byte to an unpinned server. */
export type LxdHttpsConnection = NonNullable<ClientRequestArgs["createConnection"]>;

export class LxdHttpsAccess {
	readonly host: "127.0.0.1" | "::1";
	readonly port: number;
	/** SHA-256 of the listener's certificate (DER, lower-case hex): the pin, and /1.0's certificate_fingerprint. */
	readonly serverCertificateSha256: string;
	/** SHA-256 of this account's client certificate: how LXD names the caller (auth_user_name). */
	readonly identitySha256: string;
	/** Holds the key; the key's bytes are not kept. */
	readonly #context: SecureContext;

	private constructor(
		host: "127.0.0.1" | "::1",
		port: number,
		serverCertificateSha256: string,
		identitySha256: string,
		context: SecureContext,
	) {
		this.host = host;
		this.port = port;
		this.serverCertificateSha256 = serverCertificateSha256;
		this.identitySha256 = identitySha256;
		this.#context = context;
	}

	/** Checks the three files' bytes. Zeroes `key` whether or not they hold. */
	static fromFiles(listener: Buffer, certificate: Buffer, key: Buffer): LxdHttpsAccess {
		try {
			let record: unknown;
			try {
				record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(listener));
			} catch {
				throw new Error("LXD_LISTENER_INVALID");
			}
			if (
				typeof record !== "object" ||
				record === null ||
				Array.isArray(record) ||
				Object.keys(record).sort().join() !== LISTENER_KEYS
			)
				throw new Error("LXD_LISTENER_INVALID");
			const { schema, origin, certificateSha256 } = record as Record<string, unknown>;
			const matched = typeof origin === "string" ? LISTENER_ORIGIN.exec(origin) : null;
			const port = Number(matched?.[2]);
			if (
				schema !== LISTENER_SCHEMA ||
				!matched ||
				port > 65535 ||
				typeof certificateSha256 !== "string" ||
				!/^[0-9a-f]{64}$/.test(certificateSha256)
			)
				throw new Error("LXD_LISTENER_INVALID");
			let identitySha256: string;
			let context: SecureContext;
			try {
				const text = certificate.toString("latin1");
				if (text.split("-----BEGIN ").length !== 2 || !text.startsWith("-----BEGIN CERTIFICATE-----"))
					throw new Error("one certificate");
				const parsed = new X509Certificate(certificate);
				if (!parsed.checkPrivateKey(createPrivateKey({ key, format: "pem" }))) throw new Error("identity");
				identitySha256 = parsed.fingerprint256.replaceAll(":", "").toLowerCase();
				// TLS 1.3 only, as LXD's listener (V2-A8); no ALPN, since it offers only h2 (V2-A10).
				context = createSecureContext({ cert: certificate, key, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" });
			} catch {
				throw new Error("LXD_IDENTITY_INVALID");
			}
			if (identitySha256 === certificateSha256) throw new Error("LXD_IDENTITY_INVALID");
			return new LxdHttpsAccess(
				matched[1] === "[::1]" ? "::1" : "127.0.0.1",
				port,
				certificateSha256,
				identitySha256,
				context,
			);
		} finally {
			key.fill(0);
		}
	}

	/** A request's connection. Pass the request's own signal: node:http waits for this connection without watching
	 * the signal itself. */
	connection(signal?: AbortSignal): LxdHttpsConnection {
		return (_options, oncreate) => {
			// node:http takes an error alone, as its own request passes one; its type asks for a socket every time.
			const done = oncreate as (error: Error | null, socket?: Duplex) => void;
			if (signal?.aborted) {
				done(new Error("LXD_HTTPS_STOPPED"));
				return undefined;
			}
			const socket = tlsConnect({
				host: this.host,
				port: this.port,
				secureContext: this.#context,
				// The pin below is the server check: LXD's certificate is its own, under no CA.
				rejectUnauthorized: false,
				checkServerIdentity: () => undefined,
			});
			let settled = false;
			const settle = (error?: Error): void => {
				if (settled) return;
				settled = true;
				clearTimeout(deadline);
				signal?.removeEventListener("abort", stopped);
				if (!error) {
					done(null, socket);
					return;
				}
				socket.destroy();
				done(error);
			};
			const stopped = (): void => settle(new Error("LXD_HTTPS_STOPPED"));
			// A whole-handshake deadline: a server that answers slowly cannot stretch it.
			const deadline = setTimeout(() => settle(new Error("LXD_HTTPS_HANDSHAKE_TIMEOUT")), HANDSHAKE_MS);
			// Stays attached: until node:http adds its own listener, an error must not go unhandled.
			socket.on("error", () => settle(new Error("LXD_HTTPS_UNAVAILABLE")));
			socket.once("close", () => settle(new Error("LXD_HTTPS_UNAVAILABLE")));
			signal?.addEventListener("abort", stopped, { once: true });
			socket.once("secureConnect", () => {
				const raw = socket.getPeerCertificate(true)?.raw;
				if (!raw || createHash("sha256").update(raw).digest("hex") !== this.serverCertificateSha256)
					settle(new Error("LXD_HTTPS_SERVER_UNPINNED"));
				else if (socket.getProtocol() !== "TLSv1.3" || socket.alpnProtocol)
					settle(new Error("LXD_HTTPS_UNAVAILABLE"));
				else settle();
			});
			return undefined;
		};
	}
}

/** This process's access, read with the protected readers: root's files on local disk, no links, the key readable
 * only by root and this process's group. */
export async function readLxdHttpsAccess(
	root = LXD_ACCESS_ROOT,
	account = userInfo().username,
): Promise<LxdHttpsAccess> {
	if (!ACCOUNT.test(account)) throw new Error("LXD_IDENTITY_INVALID");
	let listener: Buffer;
	try {
		listener = await readLxdOfficeProtectedFile(join(root, "listener.json"), MAX_LISTENER_BYTES);
	} catch (error) {
		throw new Error("LXD_LISTENER_INVALID", { cause: error });
	}
	let certificate: Buffer;
	let key: Buffer;
	try {
		certificate = await readLxdOfficeProtectedFile(join(root, account, "client.crt"), MAX_IDENTITY_BYTES);
		key = await readLxdOfficeCredentialFile(join(root, account, "client.key"), MAX_IDENTITY_BYTES);
	} catch (error) {
		throw new Error("LXD_IDENTITY_INVALID", { cause: error });
	}
	return LxdHttpsAccess.fromFiles(listener, certificate, key);
}
