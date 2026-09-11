import { createHash, X509Certificate } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
	type LxdNativeCompanyOffice,
	readLxdNativeCompanyOffices,
	validateLxdNativeCompanyOffices,
} from "./lxd-company-office.ts";

export interface LxdNativeCompanyRuntimeConfig {
	mode: "company-path-v1";
	codexPath: string;
	binarySha256: string;
	objectGatewayUrl: string;
	objectGatewayToken: string;
	secretBroker: {
		origin: string;
		runtimeToken: string;
		caCertificate: string;
		caSha256: string;
	};
	network: string;
	recoveryVolumePrefix: string;
	recoveryVolumeSize: string;
	offices?: LxdNativeCompanyOffice[];
}

function exactHttpsOrigin(value: string, label: string): string {
	let origin: URL;
	try {
		origin = new URL(value);
	} catch {
		throw new Error(`${label} must be an HTTPS origin`);
	}
	if (
		origin.protocol !== "https:" ||
		origin.username ||
		origin.password ||
		origin.search ||
		origin.hash ||
		origin.pathname !== "/" ||
		![origin.origin, `${origin.origin}/`].includes(value)
	) {
		throw new Error(`${label} must be an HTTPS origin`);
	}
	return origin.origin;
}

function privateToken(path: string, label: string): string {
	if (!isAbsolute(path) || realpathSync(path) !== resolve(path)) {
		throw new Error(`${label} file must be an absolute physical path`);
	}
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	let token: string;
	try {
		const metadata = fstatSync(descriptor);
		if (
			!metadata.isFile() ||
			metadata.size > 256 ||
			(metadata.mode & 0o077) !== 0 ||
			(metadata.uid !== 0 && metadata.uid !== process.getuid?.())
		) {
			throw new Error(`${label} file has unsafe ownership, permissions, or size`);
		}
		const bytes = Buffer.alloc(257);
		let length = 0;
		while (length < bytes.length) {
			const read = readSync(descriptor, bytes, length, bytes.length - length, null);
			if (read === 0) break;
			length += read;
		}
		if (length > 256) throw new Error(`${label} file exceeds its size limit`);
		token = bytes.subarray(0, length).toString("utf-8").trim();
	} finally {
		closeSync(descriptor);
	}
	if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error(`${label} is invalid`);
	return token;
}

function pinnedCaCertificate(path: string, expectedSha256: string): string {
	if (!isAbsolute(path) || realpathSync(path) !== resolve(path)) {
		throw new Error("Cloud secret broker CA file must be an absolute physical path");
	}
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	let encoded: Buffer;
	try {
		const metadata = fstatSync(descriptor);
		if (
			!metadata.isFile() ||
			metadata.size < 1 ||
			metadata.size > 16 * 1024 ||
			(metadata.mode & 0o022) !== 0 ||
			(metadata.uid !== 0 && metadata.uid !== process.getuid?.())
		) {
			throw new Error("Cloud secret broker CA file has unsafe ownership, permissions, or size");
		}
		encoded = Buffer.alloc(metadata.size);
		let length = 0;
		while (length < encoded.length) {
			const read = readSync(descriptor, encoded, length, encoded.length - length, null);
			if (read === 0) break;
			length += read;
		}
		if (length !== encoded.length) throw new Error("Cloud secret broker CA file changed while reading");
	} finally {
		closeSync(descriptor);
	}
	if (!/^[0-9a-f]{64}$/.test(expectedSha256)) throw new Error("Cloud secret broker CA digest is invalid");
	if (createHash("sha256").update(encoded).digest("hex") !== expectedSha256) {
		throw new Error("Cloud secret broker CA digest does not match its pinned authority");
	}
	let certificate: X509Certificate;
	try {
		certificate = new X509Certificate(encoded);
	} catch {
		throw new Error("Cloud secret broker CA certificate is invalid");
	}
	if (!certificate.ca) throw new Error("Cloud secret broker CA certificate is not a certificate authority");
	return encoded.toString("utf-8");
}

export function validateLxdNativeCompanyRuntime(config: LxdNativeCompanyRuntimeConfig): void {
	const keys = [
		"mode",
		"codexPath",
		"binarySha256",
		"objectGatewayUrl",
		"objectGatewayToken",
		"secretBroker",
		"network",
		"recoveryVolumePrefix",
		"recoveryVolumeSize",
		...(config.offices !== undefined ? ["offices"] : []),
	];
	if (
		Object.keys(config).length !== keys.length ||
		Object.keys(config).some((key) => !keys.includes(key)) ||
		typeof config.mode !== "string" ||
		typeof config.codexPath !== "string" ||
		typeof config.binarySha256 !== "string" ||
		typeof config.objectGatewayUrl !== "string" ||
		typeof config.objectGatewayToken !== "string" ||
		typeof config.network !== "string" ||
		typeof config.recoveryVolumePrefix !== "string" ||
		typeof config.recoveryVolumeSize !== "string" ||
		config.mode !== "company-path-v1" ||
		!/^\/[A-Za-z0-9_./-]+$/.test(config.codexPath) ||
		resolve(config.codexPath) !== config.codexPath ||
		!/^[0-9a-f]{64}$/.test(config.binarySha256) ||
		!/^[A-Za-z0-9_-]{43}$/.test(config.objectGatewayToken) ||
		!config.secretBroker ||
		Object.keys(config.secretBroker).sort().join() !== "caCertificate,caSha256,origin,runtimeToken" ||
		!/^https:\/\//.test(config.secretBroker.origin) ||
		!/^[A-Za-z0-9_-]{43}$/.test(config.secretBroker.runtimeToken) ||
		!/^[0-9a-f]{64}$/.test(config.secretBroker.caSha256) ||
		createHash("sha256").update(config.secretBroker.caCertificate).digest("hex") !== config.secretBroker.caSha256 ||
		config.secretBroker.runtimeToken === config.objectGatewayToken ||
		!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(config.network) ||
		!/^[a-z][a-z0-9-]{0,25}$/.test(config.recoveryVolumePrefix) ||
		!/^[1-9][0-9]*(?:MiB|GiB)$/.test(config.recoveryVolumeSize)
	) {
		throw new Error("Governed native company runtime configuration is invalid");
	}
	exactHttpsOrigin(config.objectGatewayUrl, "Native company object gateway");
	exactHttpsOrigin(config.secretBroker.origin, "Cloud secret broker");
	let certificate: X509Certificate;
	try {
		certificate = new X509Certificate(config.secretBroker.caCertificate);
	} catch {
		throw new Error("Cloud secret broker CA certificate is invalid");
	}
	if (!certificate.ca) throw new Error("Cloud secret broker CA certificate is not a certificate authority");
	if (config.offices !== undefined)
		validateLxdNativeCompanyOffices(config.offices, [config.objectGatewayToken, config.secretBroker.runtimeToken]);
}

/** Explicit, separate rollout lane. Partial configuration must not select the legacy runtime. */
export function lxdNativeCompanyRuntimeFromEnvironment(
	environment: NodeJS.ProcessEnv,
): LxdNativeCompanyRuntimeConfig | undefined {
	const names = [
		"QORPERA_NATIVE_RUNTIME",
		"QORPERA_NATIVE_CODEX_FENCE_PATH",
		"QORPERA_NATIVE_CODEX_FENCE_SHA256",
		"QORPERA_NATIVE_OBJECT_GATEWAY_URL",
		"QORPERA_LXD_NATIVE_OBJECT_TOKEN_FILE",
		"QORPERA_LXD_COMPANY_NETWORK",
		"QORPERA_LXD_RECOVERY_VOLUME_PREFIX",
		"QORPERA_LXD_RECOVERY_VOLUME_SIZE",
		"QORPERA_CLOUD_SECRET_BROKER_URL",
		"QORPERA_LXD_CLOUD_SECRET_RUNTIME_TOKEN_FILE",
		"QORPERA_LXD_CLOUD_SECRET_CA_FILE",
		"QORPERA_LXD_CLOUD_SECRET_CA_SHA256",
	];
	if (environment.QORPERA_NATIVE_OBJECT_GATEWAY_TOKEN !== undefined) {
		throw new Error("The provider requires a private native object-token file, not a token in its environment");
	}
	if (environment.QORPERA_CLOUD_SECRET_BROKER_TOKEN !== undefined) {
		throw new Error(
			"The provider requires a private cloud secret runtime-token file, not a token in its environment",
		);
	}
	if (environment.QORPERA_COMPANY_COMPUTER_TOKEN !== undefined)
		throw new Error("Native office transport requires protected route and credential files");
	if (
		names.every((name) => environment[name] === undefined) &&
		environment.QORPERA_LXD_OFFICE_ROUTES_FILE === undefined
	)
		return undefined;
	const values = names.map((name) => {
		const value = environment[name];
		if (!value || value !== value.trim() || /[\0\r\n]/.test(value)) {
			throw new Error(`Governed native company runtime requires ${name}`);
		}
		return value;
	});
	if (values[0] !== "company-path-v1") throw new Error("Native company runtime mode is unsupported");
	const token = privateToken(values[4] as string, "Native object-token");
	const secretBroker = {
		origin: exactHttpsOrigin(values[8] as string, "Cloud secret broker"),
		runtimeToken: privateToken(values[9] as string, "Cloud secret runtime-token"),
		caCertificate: pinnedCaCertificate(values[10] as string, values[11] as string),
		caSha256: values[11] as string,
	};
	const config: LxdNativeCompanyRuntimeConfig = {
		mode: "company-path-v1",
		codexPath: values[1] as string,
		binarySha256: values[2] as string,
		objectGatewayUrl: values[3] as string,
		objectGatewayToken: token,
		secretBroker,
		network: values[5] as string,
		recoveryVolumePrefix: values[6] as string,
		recoveryVolumeSize: values[7] as string,
		...(environment.QORPERA_LXD_OFFICE_ROUTES_FILE !== undefined
			? { offices: readLxdNativeCompanyOffices(environment.QORPERA_LXD_OFFICE_ROUTES_FILE, privateToken) }
			: {}),
	};
	validateLxdNativeCompanyRuntime(config);
	return config;
}
