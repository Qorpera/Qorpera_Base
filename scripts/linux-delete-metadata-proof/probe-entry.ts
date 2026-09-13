// Linux-only kernel probe: exact production helpers, no physical/SQL attestation.
import { readFile, readlink } from 'node:fs/promises';
import { officeInstallLockFd } from '/Users/jonas/work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-installation-host.ts';
import { assertLxdOfficeHostNamespace, readLxdOfficeProtectedFile } from '/Users/jonas/work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-physical-host.ts';
import { runLxdOfficeDeleteMetadataCommand } from '/Users/jonas/work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-delete-metadata-command.ts';
async function main() {
 if (process.platform !== 'linux') throw new Error('ISOLATED_LINUX_REQUIRED');
 const [mode, ...args] = process.argv.slice(2);
 if (mode === 'boundary') {
  const status = await readFile('/proc/self/status', 'utf8');
  const kernelFields = Object.fromEntries(status.split('\n').filter(x => /^(Uid|Gid|Groups|CapInh|CapPrm|CapEff|CapAmb|NoNewPrivs):/.test(x)).map(x => [x.split(':')[0], x.slice(x.indexOf(':')+1).trim()]));
  let pid1Namespace: unknown;
  try { pid1Namespace = await readlink('/proc/1/ns/mnt'); } catch (e) { pid1Namespace = {error: (e as NodeJS.ErrnoException).code}; }
  const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const namespace = await assertLxdOfficeHostNamespace(boot);
  const receipt = await readLxdOfficeProtectedFile(args[0]!, 4096);
  const installationFd = await officeInstallLockFd(args[1]!, 0);
  const adoptionFd = await officeInstallLockFd(args[2]!, process.getuid!());
  console.log(JSON.stringify({kernelFields, pid1Namespace, namespace, receipt: receipt.toString(), installationFd, adoptionFd}));
 } else if (mode === 'metadata-rejection') {
  await runLxdOfficeDeleteMetadataCommand('/nonexistent-fixture-config', '12345678-1234-4234-8234-000000000010', '12345678-1234-4234-8234-000000000041');
 } else throw new Error('UNKNOWN_PROBE_MODE');
}
main().catch(e => { console.error(JSON.stringify({error: e.message})); process.exitCode = 1; });
