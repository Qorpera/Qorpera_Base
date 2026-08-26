#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { safeCompanyComputerGuestError } from "./cloud-company-computer-bootstrap-main.ts";
import {
	guestServiceKey,
	guestToken,
	parseCompanyComputerGuestBootstrap,
	parseCompanyComputerServiceBaseUrl,
} from "./cloud-company-computer-guest.ts";
import {
	ExecCompanyComputerScreenLauncher,
	runCloudCompanyComputerScreenAgent,
	SupabaseCompanyComputerScreensControlPlane,
} from "./cloud-company-computer-screens.ts";

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

export function screenSessionCommand(environment: NodeJS.ProcessEnv): readonly string[] {
	const override = environment.QORPERA_SCREEN_SESSION_COMMAND;
	if (override === undefined) return COMPANY_COMPUTER_SCREEN_SESSION_COMMAND;
	let parsed: unknown;
	try {
		parsed = JSON.parse(override);
	} catch (error) {
		throw new Error("Company computer screen session command override is invalid JSON", { cause: error });
	}
	if (!Array.isArray(parsed) || parsed.length < 1 || parsed.some((entry) => typeof entry !== "string")) {
		throw new Error("Company computer screen session command override is invalid");
	}
	return parsed as string[];
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
