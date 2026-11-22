import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, type FileHandle, link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { parseOfficeFleetServiceConfig } from "./lxd-office-fleet-service.ts";
import { officeSha } from "./lxd-office-image-provenance.ts";
import { officeSystemdPath } from "./lxd-office-installation.ts";
import { parseLxdOfficeLifecycleServiceConfig } from "./lxd-office-lifecycle-service.ts";
import { LxdOfficePhysicalGate } from "./lxd-office-physical-gate.ts";
import { readLxdOfficeProtectedFile, readLxdOfficeProtectedPackageArtifactFile } from "./lxd-office-physical-host.ts";
import {
	type LxdOfficePhysicalPolicy,
	officePhysicalPath,
	parseLxdOfficePhysicalPolicy,
} from "./lxd-office-physical-policy.ts";

export function renderOfficeFleetUnits(
	policyValue: LxdOfficePhysicalPolicy,
	configPath: string,
	binaryPath: string,
	registryCaPath: string,
) {
	const policy = parseLxdOfficePhysicalPolicy(policyValue);
	for (const path of [configPath, binaryPath, registryCaPath]) officePhysicalPath(path);
	if (policy.host.socketGid === 0 || policy.workbench.uid === 0 || policy.workbench.gid === 0)
		throw new Error("OFFICE_FLEET_SERVICE_IDENTITY_INVALID");
	const instance = `${policy.guest.companyComputerId}-g${policy.guest.computerGeneration}`;
	const render = (stage: boolean) => `[Unit]
Description=Qorpera office fleet ${stage ? "stage" : "provider"} ${instance}
Wants=network-online.target
Requires=qorpera-node-host-namespace.service
After=network-online.target qorpera-node-host-namespace.service
RequiresMountsFor=${officeSystemdPath(policy.journal.mountPoint, "dependency")} ${officeSystemdPath(policy.workbench.mountPoint, "dependency")}
ConditionPathExists=${officeSystemdPath(configPath, "dependency")}
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
Type=${stage ? "oneshot" : "exec"}
User=${policy.workbench.uid}
Group=${policy.workbench.gid}
# qorpera-agent-plug: the computer's agent card is plugged into the node's agent exit right before its create.
SupplementaryGroups=${policy.host.socketGid} qorpera-agent-plug
Environment=${officeSystemdPath(registryCaPath, "dependency").replace(/^"/, '"NODE_EXTRA_CA_CERTS=')}
# An existing lock inode is mandatory. The final Node process owns the flock.
ExecStart=/usr/bin/bash --noprofile --norc -c 'exec 3<"$$1" || exit 1; exec /usr/bin/flock --exclusive --nonblock --no-fork /proc/self/fd/3 /usr/bin/node --jitless --disable-proto=throw --disallow-code-generation-from-strings "$$2" ${stage ? "--stage" : "--config"} "$$3"' qorpera-office-fleet ${officeSystemdPath(`${policy.journal.path}/adoption.lock`)} ${officeSystemdPath(binaryPath)} ${officeSystemdPath(configPath)}
${stage ? "" : "Restart=on-failure\nRestartSec=5s\n"}KillMode=mixed
KillSignal=SIGTERM
SendSIGKILL=yes
TimeoutStopSec=70s
UMask=0077
LimitCORE=0
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
MemoryDenyWriteExecute=yes
RestrictNamespaces=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
LockPersonality=yes
SystemCallArchitectures=native
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
MemoryMax=1G
MemorySwapMax=0
TasksMax=128
CPUQuota=200%
# The physical gate requires the host mount namespace. Do not add PrivateTmp.

[Install]
WantedBy=multi-user.target
`;
	return {
		provider: { name: `qorpera-office-fleet-${instance}.service`, text: render(false) },
		stage: { name: `qorpera-office-fleet-stage-${instance}.service`, text: render(true) },
	};
}

export async function writeOfficeFleetArtifactImmutable(
	targetPath: string,
	bytes: Buffer,
	readExisting: (path: string, maxBytes: number) => Promise<Buffer> = readLxdOfficeProtectedPackageArtifactFile,
): Promise<void> {
	// WHY: Stage in a unique temp file and publish with link() so a mid-write crash never bricks retries with a partial file and existing differing targets are never replaced.
	const tmpPath = `${targetPath}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
	let file: FileHandle | undefined;
	try {
		file = await open(tmpPath, "wx", 0o444);
		await file.writeFile(bytes);
		await file.sync();
		await file.close();
		file = undefined;
		await chmod(tmpPath, 0o444);
		try {
			await link(tmpPath, targetPath);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
			const present = await readExisting(targetPath, 2 * 1024 ** 2);
			if (!present.equals(bytes)) throw new Error("OFFICE_FLEET_INSTALL_CONFLICT");
			return;
		}
		const parent = await open(dirname(targetPath), "r");
		try {
			await parent.sync();
		} finally {
			await parent.close();
		}
	} finally {
		if (file) await file.close().catch(() => {});
		await unlink(tmpPath).catch(() => {});
	}
}

/** Root operator installation only. Protected host-specific configuration,
 * images, mounts, users and local journal/lock are prepared first. Publish a
 * content-addressed binary and two per-office units, without starting either.
 * Existing differing files are refused, never replaced. */
export async function installOfficeFleetService(
	configPath: string,
	binarySource: string,
	binarySha256: string,
	registryCaPath: string,
) {
	if (process.platform !== "linux" || process.getuid?.() !== 0 || process.geteuid?.() !== 0)
		throw new Error("OFFICE_FLEET_ROOT_LINUX_REQUIRED");
	officeSha(binarySha256);
	const config = parseOfficeFleetServiceConfig(
		JSON.parse((await readLxdOfficeProtectedFile(configPath, 16384)).toString("utf8")),
	);
	const serviceBytes = await readLxdOfficeProtectedFile(config.servicePath, 16384);
	if (createHash("sha256").update(serviceBytes).digest("hex") !== config.serviceConfigSha256)
		throw new Error("OFFICE_FLEET_SERVICE_CHANGED");
	const service = parseLxdOfficeLifecycleServiceConfig(JSON.parse(serviceBytes.toString("utf8")));
	const gate = await LxdOfficePhysicalGate.open(
		service.policyPath,
		service.provenancePath,
		new AbortController().signal,
	);
	await readLxdOfficeProtectedFile(registryCaPath, 65536);
	const binary = await readLxdOfficeProtectedPackageArtifactFile(binarySource, 2 * 1024 ** 2);
	if (createHash("sha256").update(binary).digest("hex") !== binarySha256)
		throw new Error("OFFICE_FLEET_BINARY_CHANGED");
	const binaryPath = `/opt/qorpera/office-fleet/${binarySha256}/qorpera-office-fleet.cjs`;
	const units = renderOfficeFleetUnits(gate.policy, configPath, binaryPath, registryCaPath);
	for (const target of [
		{ path: binaryPath, bytes: binary },
		...Object.values(units).map((unit) => ({
			path: `/etc/systemd/system/${unit.name}`,
			bytes: Buffer.from(unit.text),
		})),
	]) {
		// Every parent is an ordinary root-owned directory. mkdir is component
		// by component so a pre-existing symlink cannot redirect a privileged write.
		let directory = "";
		for (const part of dirname(target.path).split("/").filter(Boolean)) {
			directory += `/${part}`;
			await mkdir(directory, { mode: 0o755 }).catch((error: unknown) => {
				if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
			});
			const info = await lstat(directory);
			if (
				!info.isDirectory() ||
				info.uid !== 0 ||
				(info.mode & 0o6022) !== 0 ||
				(await realpath(directory)) !== directory
			)
				throw new Error("OFFICE_FLEET_INSTALL_PATH_UNPROTECTED");
		}
		await writeOfficeFleetArtifactImmutable(target.path, target.bytes);
	}
	execFileSync("/usr/bin/systemctl", ["daemon-reload"], { stdio: "pipe", timeout: 30_000 });
	return {
		schema: "qorpera.office-fleet-installation/v1",
		binaryPath,
		units: Object.values(units).map((unit) => unit.name),
	};
}
