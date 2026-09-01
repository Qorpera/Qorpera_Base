import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export interface LxdNativeCompanyRuntimeConfig {
	mode: "company-path-v1";
	codexPath: string;
	binarySha256: string;
	objectGatewayUrl: string;
	objectGatewayToken: string;
	network: string;
	recoveryVolumePrefix: string;
	recoveryVolumeSize: string;
}

export function validateLxdNativeCompanyRuntime(config: LxdNativeCompanyRuntimeConfig): void {
	const keys = [
		"mode",
		"codexPath",
		"binarySha256",
		"objectGatewayUrl",
		"objectGatewayToken",
		"network",
		"recoveryVolumePrefix",
		"recoveryVolumeSize",
	];
	if (
		Object.keys(config).length !== keys.length ||
		Object.keys(config).some((key) => !keys.includes(key)) ||
		Object.values(config).some((value) => typeof value !== "string") ||
		config.mode !== "company-path-v1" ||
		typeof config.codexPath !== "string" ||
		!/^\/[A-Za-z0-9_./-]+$/.test(config.codexPath) ||
		resolve(config.codexPath) !== config.codexPath ||
		!/^[0-9a-f]{64}$/.test(config.binarySha256) ||
		!/^[A-Za-z0-9_-]{43}$/.test(config.objectGatewayToken) ||
		!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(config.network) ||
		!/^[a-z][a-z0-9-]{0,25}$/.test(config.recoveryVolumePrefix) ||
		!/^[1-9][0-9]*(?:MiB|GiB)$/.test(config.recoveryVolumeSize)
	) {
		throw new Error("Governed native company runtime configuration is invalid");
	}
	let gateway: URL;
	try {
		gateway = new URL(config.objectGatewayUrl);
	} catch {
		throw new Error("Native company object gateway must be an HTTPS origin");
	}
	if (
		gateway.protocol !== "https:" ||
		gateway.username ||
		gateway.password ||
		gateway.search ||
		gateway.hash ||
		gateway.pathname !== "/" ||
		![gateway.origin, `${gateway.origin}/`].includes(config.objectGatewayUrl)
	) {
		throw new Error("Native company object gateway must be an HTTPS origin");
	}
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
	];
	if (environment.QORPERA_NATIVE_OBJECT_GATEWAY_TOKEN !== undefined) {
		throw new Error("The provider requires a private native object-token file, not a token in its environment");
	}
	if (names.every((name) => environment[name] === undefined)) return undefined;
	const values = names.map((name) => {
		const value = environment[name];
		if (!value || value !== value.trim() || /[\0\r\n]/.test(value)) {
			throw new Error(`Governed native company runtime requires ${name}`);
		}
		return value;
	});
	if (values[0] !== "company-path-v1") throw new Error("Native company runtime mode is unsupported");
	const tokenPath = values[4] as string;
	if (!isAbsolute(tokenPath) || realpathSync(tokenPath) !== resolve(tokenPath)) {
		throw new Error("Native object-token file must be an absolute physical path");
	}
	const descriptor = openSync(tokenPath, constants.O_RDONLY | constants.O_NOFOLLOW);
	let token: string;
	try {
		const metadata = fstatSync(descriptor);
		if (
			!metadata.isFile() ||
			metadata.size > 256 ||
			(metadata.mode & 0o077) !== 0 ||
			(metadata.uid !== 0 && metadata.uid !== process.getuid?.())
		) {
			throw new Error("Native object-token file has unsafe ownership, permissions, or size");
		}
		const bytes = Buffer.alloc(257);
		let length = 0;
		while (length < bytes.length) {
			const read = readSync(descriptor, bytes, length, bytes.length - length, null);
			if (read === 0) break;
			length += read;
		}
		if (length > 256) throw new Error("Native object-token file exceeds its size limit");
		token = bytes.subarray(0, length).toString("utf-8").trim();
	} finally {
		closeSync(descriptor);
	}
	const config: LxdNativeCompanyRuntimeConfig = {
		mode: "company-path-v1",
		codexPath: values[1] as string,
		binarySha256: values[2] as string,
		objectGatewayUrl: values[3] as string,
		objectGatewayToken: token,
		network: values[5] as string,
		recoveryVolumePrefix: values[6] as string,
		recoveryVolumeSize: values[7] as string,
	};
	validateLxdNativeCompanyRuntime(config);
	return config;
}
