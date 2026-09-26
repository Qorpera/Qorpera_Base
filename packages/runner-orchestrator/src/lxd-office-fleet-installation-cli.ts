#!/usr/bin/env node
import { installOfficeFleetService } from "./lxd-office-fleet-installation.ts";

const [configPath, binarySource, binarySha256, caPath, ...extra] = process.argv.slice(2);
if (!configPath || !binarySource || !binarySha256 || !caPath || extra.length) {
	process.stderr.write("Usage: qorpera-office-fleet-install CONFIG BINARY SHA256 REGISTRY_CA\n");
	process.exitCode = 2;
} else {
	void installOfficeFleetService(configPath, binarySource, binarySha256, caPath)
		.then((result) => {
			process.stdout.write(`${JSON.stringify(result)}\n`);
		})
		.catch(() => {
			process.stderr.write("OFFICE_FLEET_INSTALL_UNCONFIRMED\n");
			process.exitCode = 1;
		});
}
