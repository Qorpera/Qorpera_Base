import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface CloudPreviewEndpoints {
	schema: "qorpera.desktop-preview/v1";
	projectUrl: string;
	publishableKey: string;
	objectGatewayUrl: string;
	nativeProviderUrl: string;
}

export interface CloudPreview extends CloudPreviewEndpoints {
	root: string;
	home: string;
	userData: string;
	sessionData: string;
	logs: string;
	crashDumps: string;
	agentDir: string;
	githubConfigDir: string;
	gitConfigPath: string;
}

function contained(path: string, parent: string): boolean {
	const suffix = relative(parent, path);
	return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
}

function privateDirectory(path: string): void {
	try {
		mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const stat = lstatSync(path);
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		(process.platform !== "win32" && (stat.mode & 0o077) !== 0) ||
		(process.getuid && stat.uid !== process.getuid())
	) {
		throw new Error("Cloud preview storage must be a private, owned directory without symlinks.");
	}
}

/** An explicit non-production launch, never an endpoint fallback. It uses the
 * normal account and Company File code with separate local display/auth state.
 * Target changes require a new directory, so sessions cannot cross projects. */
export function prepareCloudPreview(
	argv: readonly string[],
	protectedPaths: { home: string; userData: string },
	production: { projectUrl: string; objectGatewayUrl: string },
	environment: NodeJS.ProcessEnv,
): CloudPreview | undefined {
	const arguments_ = argv.filter((argument) => argument.startsWith("--cloud-preview"));
	if (arguments_.length === 0) return undefined;
	if (arguments_.length !== 1 || !arguments_[0]!.startsWith("--cloud-preview=")) {
		throw new Error("Use one --cloud-preview=/absolute/path/preview.json argument.");
	}
	if (argv.some((argument) => argument.startsWith("--smoke") || argument.startsWith("--company"))) {
		throw new Error("Cloud preview cannot bypass sign-in or open a local company.");
	}
	// A preview must not discover credentials from the invoking terminal.
	if (
		Object.entries(environment).some(
			([key, value]) =>
				Boolean(value) &&
				(/(?:_API_KEY|_TOKEN)$/.test(key) ||
					["QORPERA_PACKAGE_DIR", "QORPERA_RUNTIME_NODE", "QORPERA_NATIVE_PROVIDER_URL"].includes(key)),
		)
	) {
		throw new Error("Launch cloud preview without ambient provider credentials or runtime overrides.");
	}
	const path = arguments_[0]!.slice("--cloud-preview=".length);
	if (!isAbsolute(path) || basename(path) !== "preview.json") {
		throw new Error("Cloud preview requires an absolute preview.json path.");
	}
	const root = realpathSync(dirname(path));
	if (!/^qorpera-cloud-preview-[A-Za-z0-9-]+$/.test(basename(root))) {
		throw new Error("Cloud preview requires a dedicated qorpera-cloud-preview-* directory.");
	}
	for (const protectedPath of Object.values(protectedPaths)) {
		let actual = resolve(protectedPath);
		const missing: string[] = [];
		for (;;) {
			try {
				actual = join(realpathSync(actual), ...missing.reverse());
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(actual) === actual) throw error;
				missing.push(basename(actual));
				actual = dirname(actual);
			}
		}
		if (contained(root, actual) || contained(actual, root)) {
			throw new Error("Cloud preview storage must be separate from the regular home and app data.");
		}
	}
	privateDirectory(root);
	const configPath = join(root, "preview.json");
	const stat = lstatSync(configPath);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) {
		throw new Error("Cloud preview configuration must be a bounded regular file.");
	}
	const value: unknown = JSON.parse(readFileSync(configPath, "utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid cloud preview config.");
	const config = value as Record<string, unknown>;
	const keys = ["schema", "projectUrl", "publishableKey", "objectGatewayUrl", "nativeProviderUrl"];
	if (
		Object.keys(config).length !== keys.length ||
		Object.keys(config).some((key) => !keys.includes(key)) ||
		config.schema !== "qorpera.desktop-preview/v1" ||
		typeof config.projectUrl !== "string" ||
		!/^https:\/\/[a-z]{20}\.supabase\.co$/.test(config.projectUrl) ||
		config.projectUrl === production.projectUrl ||
		typeof config.publishableKey !== "string" ||
		!/^sb_publishable_[A-Za-z0-9_-]{16,256}$/.test(config.publishableKey)
	) {
		throw new Error("Cloud preview requires a distinct project and its public publishable key.");
	}
	for (const key of ["objectGatewayUrl", "nativeProviderUrl"] as const) {
		const value = config[key];
		if (typeof value !== "string") throw new Error("Cloud preview service URL is missing.");
		const url = new URL(value);
		if (
			url.protocol !== "https:" ||
			url.origin !== value ||
			value === production.objectGatewayUrl ||
			value === production.projectUrl
		) {
			throw new Error("Cloud preview services require explicit non-production HTTPS origins.");
		}
	}
	const endpoints = config as unknown as CloudPreviewEndpoints;
	const bindingPath = join(root, "deployment.json");
	const binding = JSON.stringify({
		schema: "qorpera.desktop-preview-binding/v1",
		sha256: createHash("sha256")
			.update(JSON.stringify(keys.map((key) => config[key])))
			.digest("hex"),
	});
	if (readdirSync(root).includes("deployment.json")) {
		const bindingStat = lstatSync(bindingPath);
		if (!bindingStat.isFile() || bindingStat.isSymbolicLink() || bindingStat.size > 1024) {
			throw new Error("Cloud preview deployment binding is invalid.");
		}
		if (readFileSync(bindingPath, "utf8") !== binding) {
			throw new Error("Cloud preview target changed. Use a new preview directory.");
		}
	} else {
		if (readdirSync(root).some((entry) => entry !== "preview.json")) {
			throw new Error("A new cloud preview must start without pre-existing local state.");
		}
		writeFileSync(bindingPath, binding, { flag: "wx", mode: 0o600 });
	}
	const previewHome = join(root, "home");
	const preview: CloudPreview = {
		...endpoints,
		root,
		home: previewHome,
		userData: join(root, "user-data"),
		sessionData: join(root, "session-data"),
		logs: join(root, "logs"),
		crashDumps: join(root, "crashes"),
		agentDir: join(previewHome, ".qorpera", "agent"),
		githubConfigDir: join(root, "github"),
		gitConfigPath: join(previewHome, ".gitconfig"),
	};
	for (const directory of [
		preview.home,
		preview.userData,
		preview.sessionData,
		preview.logs,
		preview.crashDumps,
		join(previewHome, ".qorpera"),
		preview.agentDir,
		preview.githubConfigDir,
	]) {
		privateDirectory(directory);
	}
	return preview;
}
