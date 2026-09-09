import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	companyComputerBootDirectory,
	parseCompanyComputerConfigurationRequest,
} from "@qorpera/contracts";
import { expect, vi } from "vitest";
import { LxdOfficeConfigurationWorker } from "../../src/lxd-office-configuration-worker.ts";
import type { LxdOfficeServiceBootstrap } from "../../src/lxd-office-service-bootstrap.ts";
import { lxdOfficeProviderBindingSha256 } from "../../src/lxd-office-start-control.ts";
import { officePreparationWorkerFixture } from "./office-preparation-worker.ts";

const signal = (): AbortSignal => new AbortController().signal;
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
export async function officeConfigurationWorkerFixture(roots: string[], prepared = true) {
	const f = await officePreparationWorkerFixture(roots);
	if (prepared) await f.worker.reconcile(f.request, signal());
	const key = join(f.root, "fixture-key.pem"),
		cert = join(f.root, "fixture-cert.pem");
	const generated = spawnSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			key,
			"-out",
			cert,
			"-days",
			"1",
			"-subj",
			"/CN=office.invalid",
		],
		{ timeout: 10000, stdio: "pipe" },
	);
	if (generated.status !== 0) throw new Error("local TLS fixture generation failed");
	const secrets = {
		registry: "r".repeat(64),
		native: "n".repeat(43),
		objects: "o".repeat(43),
		tlsCert: await readFile(cert, "utf8"),
		tlsKey: await readFile(key, "utf8"),
	};
	const bootstrap: LxdOfficeServiceBootstrap = {
		schema: "qorpera.lxd-office-service-bootstrap/v1",
		providerBindingSha256: lxdOfficeProviderBindingSha256(f.binding),
		registryUrl: "https://registry.invalid",
		captureObjectGatewayUrl: "https://objects.invalid",
		native: { host: "0.0.0.0", port: 9443 },
		viewer: { host: "0.0.0.0", port: 9444, origins: ["https://client.invalid"] },
		credentials: Object.fromEntries(
			Object.entries(secrets).map(([name, value]) => [
				name,
				{ path: `/protected/configuration/${name}`, bytes: Buffer.byteLength(value), sha256: hash(value) },
			]),
		) as LxdOfficeServiceBootstrap["credentials"],
	};
	const request = { ...f.request, serviceBootstrapPath: "/protected/bootstrap.json" };
	const originalRead = f.readProtected.getMockImplementation()!;
	f.readProtected.mockImplementation(async (path) =>
		path === request.serviceBootstrapPath ? Buffer.from(JSON.stringify(bootstrap)) : originalRead(path),
	);
	const credentialBuffers: Buffer[] = [];
	const readCredential = vi.fn(async (path: string) => {
		const name = Object.entries(bootstrap.credentials).find(
			([, value]) => value.path === path,
		)?.[0] as keyof typeof secrets;
		if (!name) throw new Error("unexpected credential path");
		const bytes = Buffer.from(secrets[name]);
		credentialBuffers.push(bytes);
		return bytes;
	});
	let staged: Buffer | undefined;
	const stage = vi
		.spyOn(f.client, "pushOfficeConfigurationRequest")
		.mockImplementation(async (_project, _name, sha, bytes) => {
			expect(hash(bytes)).toBe(sha);
			staged = Buffer.from(bytes);
		});
	const readStage = vi
		.spyOn(f.client, "readOfficeConfigurationRequest")
		.mockImplementation(async (_project, _name, sha, bytes) => {
			if (!staged || staged.length !== bytes || hash(staged) !== sha)
				throw new Error("configuration staging mismatch");
			return { content: Buffer.from(staged), uid: 0, gid: 0, mode: 0o400 };
		});
	const exec = vi
		.spyOn(f.client, "submitOfficeConfiguration")
		.mockImplementation(async (project, instanceName, command) => {
			if (!staged) throw new Error("configuration request missing");
			const body = parseCompanyComputerConfigurationRequest(JSON.parse(staged.toString()));
			const files = Object.fromEntries(
				Object.entries(COMPANY_COMPUTER_CONFIGURATION_FILES).map(([name, path]) => {
					const content = Buffer.from(body[name as keyof typeof COMPANY_COMPUTER_CONFIGURATION_FILES]);
					f.guest.set(`/etc/qorpera-office/credentials/${path}`, { content, uid: 0, gid: 0, mode: 0o400 });
					f.guest.set(`${companyComputerBootDirectory(command.bootId)}/credentials/${path}`, {
						content: Buffer.from(content),
						uid: 0,
						gid: 0,
						mode: 0o400,
					});
					return [path, { bytes: content.length, sha256: hash(content) }];
				}),
			);
			const preparationBytes = f.guest.get("/run/qorpera-office-preparation/completion.json")!.content;
			const completion = {
				schema: "qorpera.office-configuration-completion/v1",
				command,
				preparation: body.preparation,
				preparationCompletionSha256: hash(preparationBytes),
				adoptionReceiptSha256: JSON.parse(preparationBytes.toString()).adoptionReceiptSha256,
				files,
			};
			f.guest.set("/run/qorpera-office-preparation/configuration-completion.json", {
				content: Buffer.from(`${JSON.stringify(completion)}\n`),
				uid: 0,
				gid: 0,
				mode: 0o600,
			});
			return { project, instanceName, operationId: "00000000-0000-4000-8000-000000000021" };
		});
	const poll = vi.spyOn(f.client, "inspectOfficeConfiguration").mockResolvedValue("succeeded");
	const create = () =>
		new LxdOfficeConfigurationWorker(
			{ policy: f.policy, check: f.check },
			{ call: f.call },
			{ client: f.client, kernelLock: f.kernelLock, readProtected: f.readProtected, readCredential },
		);
	return {
		...f,
		preparation: { names: f.names, exec: f.exec, stage: f.stage },
		request,
		secrets,
		bootstrap,
		readCredential,
		credentialBuffers,
		create,
		worker: create(),
		stage,
		readStage,
		exec,
		poll,
		names: {
			index: `configuration-intent-${f.binding.allocationId}.json`,
			observation: `configuration-observation-${f.binding.allocationId}.json`,
			completion: `configuration-completed-${f.binding.allocationId}.json`,
			journal: `configuration-${f.binding.allocationId}`,
		},
		staged: () => staged,
	};
}
