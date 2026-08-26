#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { safeCompanyComputerGuestError } from "./cloud-company-computer-bootstrap-main.ts";
import {
	type CompanyComputerGuestBootstrap,
	companyComputerObjectTransport,
	guestServiceKey,
	parseCompanyComputerGuestBootstrap,
	parseCompanyComputerServiceBaseUrl,
	SupabaseCompanyComputerSyncHeadResolver,
} from "./cloud-company-computer-guest.ts";
import { runCloudCompanyComputerSyncAgent } from "./cloud-company-computer-sync.ts";
import { CloudContentAddressedStore } from "./cloud-object-store.ts";

/** Standing sync service for the Company Computer guest. Every input arrives
 * through systemd LoadCredential= (the bootstrap file, the runner service
 * config for the control-plane URL, and the Supabase service credential), so
 * the service runs as the unprivileged work account. Storage selection is
 * explicit deployment configuration and fails closed. */

interface SyncServiceComposition {
	bootstrap: CompanyComputerGuestBootstrap;
	baseUrl: string;
	serviceKey: string;
}

async function readComposition(environment: NodeJS.ProcessEnv): Promise<SyncServiceComposition> {
	const credentialsDirectory = environment.CREDENTIALS_DIRECTORY;
	if (!credentialsDirectory) {
		throw new Error("Company computer sync service requires its systemd credentials directory");
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
	return { bootstrap, baseUrl, serviceKey };
}

export async function runCloudCompanyComputerSyncServiceMain(
	environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const { bootstrap, baseUrl, serviceKey } = await readComposition(environment);
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
	const controller = new AbortController();
	const stop = (): void => controller.abort();
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	await runCloudCompanyComputerSyncAgent({
		config: bootstrap.sync,
		profileId: bootstrap.profileId,
		environmentId: bootstrap.environmentId,
		head: new SupabaseCompanyComputerSyncHeadResolver(baseUrl, serviceKey, bootstrap.companyComputerId),
		objects: new CloudContentAddressedStore(transport),
		signal: controller.signal,
		onResult: (result) => {
			if (result.status === "applied") {
				console.log(
					`company sync applied ${result.snapshotId}: ${result.appliedPaths.length} applied, ${result.skippedPaths.length} skipped`,
				);
			}
		},
		onError: (error) => console.error(safeCompanyComputerGuestError(error)),
	});
}

const executablePath = process.argv[1];
if (executablePath && realpathSync(resolve(executablePath)) === realpathSync(fileURLToPath(import.meta.url))) {
	runCloudCompanyComputerSyncServiceMain().catch((error: unknown) => {
		console.error(safeCompanyComputerGuestError(error));
		process.exitCode = 1;
	});
}
