#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { safeCompanyComputerGuestError } from "./cloud-company-computer-bootstrap-main.ts";
import {
	companyComputerObjectTransport,
	guestServiceKey,
	guestToken,
	parseCompanyComputerGuestBootstrap,
	parseCompanyComputerServiceBaseUrl,
} from "./cloud-company-computer-guest.ts";
import {
	ExecCompanyComputerScreenKeyframeCapturer,
	ExecCompanyComputerScreenLauncher,
	runCloudCompanyComputerScreenAgent,
	SupabaseCompanyComputerScreenService,
	SupabaseCompanyComputerScreensControlPlane,
} from "./cloud-company-computer-screens.ts";
import { CloudContentAddressedStore } from "./cloud-object-store.ts";

/** Standing screen service for the Company Computer guest. Inputs arrive
 * through systemd LoadCredential=; desktop sessions and the viewer listener
 * run as the unprivileged work account so every screen shares the same
 * working world (screens are parallel work surfaces, never boundaries). */

/** The image ships this wrapper; it must bind the VNC socket to loopback
 * only. Deployments may override the template through the environment for
 * a different session stack without a new agent build. */
export const COMPANY_COMPUTER_SCREEN_SESSION_COMMAND = [
	"/usr/local/bin/qorpera-screen-session",
	"{ordinal}",
	"{display}",
	"{vnc_port}",
] as const;

export const COMPANY_COMPUTER_SCREEN_CAPTURE_COMMAND = ["/usr/bin/scrot", "--overwrite", "{output}"] as const;

function commandOverride(encoded: string | undefined, fallback: readonly string[], label: string): readonly string[] {
	if (encoded === undefined) return fallback;
	let parsed: unknown;
	try {
		parsed = JSON.parse(encoded);
	} catch (error) {
		throw new Error(`${label} override is invalid JSON`, { cause: error });
	}
	if (!Array.isArray(parsed) || parsed.length < 1 || parsed.some((entry) => typeof entry !== "string")) {
		throw new Error(`${label} override is invalid`);
	}
	return parsed as string[];
}

export function screenSessionCommand(environment: NodeJS.ProcessEnv): readonly string[] {
	return commandOverride(
		environment.QORPERA_SCREEN_SESSION_COMMAND,
		COMPANY_COMPUTER_SCREEN_SESSION_COMMAND,
		"Company computer screen session command",
	);
}

export function screenCaptureCommand(environment: NodeJS.ProcessEnv): readonly string[] {
	return commandOverride(
		environment.QORPERA_SCREEN_CAPTURE_COMMAND,
		COMPANY_COMPUTER_SCREEN_CAPTURE_COMMAND,
		"Company computer screen capture command",
	);
}

export async function runCloudCompanyComputerScreenServiceMain(
	environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const credentialsDirectory = environment.CREDENTIALS_DIRECTORY;
	if (!credentialsDirectory) {
		throw new Error("Company computer screen service requires its systemd credentials directory");
	}
	const bootstrap = parseCompanyComputerGuestBootstrap(
		JSON.parse(await readFile(join(credentialsDirectory, "company-computer.json"), "utf-8")),
	);
	const baseUrl = parseCompanyComputerServiceBaseUrl(
		JSON.parse(await readFile(join(credentialsDirectory, "runner-config.json"), "utf-8")),
	);
	const serviceKey = guestServiceKey(
		await readFile(join(credentialsDirectory, "qorpera-supabase-service-key"), "utf-8"),
	);
	const viewerToken = guestToken(
		await readFile(join(credentialsDirectory, "qorpera-screen-viewer"), "utf-8"),
		"Company computer screen viewer token",
	);
	const transport = companyComputerObjectTransport({
		storagePrimary: environment.QORPERA_OBJECT_STORAGE_PRIMARY ?? "",
		supabaseUrl: baseUrl,
		supabaseServiceKey: serviceKey,
		...(environment.QORPERA_OBJECT_GATEWAY_URL ? { objectGatewayUrl: environment.QORPERA_OBJECT_GATEWAY_URL } : {}),
		...(environment.QORPERA_OBJECT_GATEWAY_TOKEN_PATH
			? {
					objectGatewayToken: (await readFile(environment.QORPERA_OBJECT_GATEWAY_TOKEN_PATH, "utf-8")).trim(),
				}
			: {}),
	});
	const screenService = new SupabaseCompanyComputerScreenService(baseUrl, serviceKey);
	const controller = new AbortController();
	const stop = (): void => controller.abort();
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	await runCloudCompanyComputerScreenAgent({
		config: bootstrap.screens,
		companyComputerId: bootstrap.companyComputerId,
		viewerToken,
		controlPlane: new SupabaseCompanyComputerScreensControlPlane(baseUrl, serviceKey),
		launcher: new ExecCompanyComputerScreenLauncher(screenSessionCommand(environment)),
		signal: controller.signal,
		occupancy: screenService,
		keyframes: {
			capturer: new ExecCompanyComputerScreenKeyframeCapturer(screenCaptureCommand(environment)),
			store: new CloudContentAddressedStore(transport),
			recorder: screenService,
			profileId: bootstrap.profileId,
		},
		onError: (error) => console.error(safeCompanyComputerGuestError(error)),
	});
}

const executablePath = process.argv[1];
if (executablePath && realpathSync(resolve(executablePath)) === realpathSync(fileURLToPath(import.meta.url))) {
	runCloudCompanyComputerScreenServiceMain().catch((error: unknown) => {
		console.error(safeCompanyComputerGuestError(error));
		process.exitCode = 1;
	});
}
