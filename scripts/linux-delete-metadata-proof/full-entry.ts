import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { officePhysicalFixture } from '/Users/jonas/work/Qorpera_Base-web-runtime/packages/runner-orchestrator/test/fixtures/office-physical-policy.ts';
import { officeDeleteDispositionFixture, officeDeleteDispositionEnvelopeFor, officeDeleteDispositionId as id } from '/Users/jonas/work/Qorpera_Base-web-runtime/packages/runner-orchestrator/test/helpers/office-delete-disposition-fixture.ts';
import { lxdOfficePhysicalPolicySha256 } from '/Users/jonas/work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-physical-policy.ts';
import { officeDigest } from '/Users/jonas/work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-image-provenance.ts';
import { lxdOfficeGuestPlan } from '/Users/jonas/work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-guest.ts';
import { LxdOfficeOperationJournal } from '/Users/jonas/work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-operations.ts';
import { LxdOfficeResetJournal } from '/Users/jonas/work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-reset-journal.ts';
import { runLxdOfficeDeleteMetadataCommand } from '/Users/jonas/work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-delete-metadata-command.ts';
const hash = (b:Buffer) => createHash('sha256').update(b).digest('hex');
async function main() {
 if(process.platform!=='linux') throw new Error('ISOLATED_LINUX_REQUIRED');
 const [mode, root, mountFile] = process.argv.slice(2);
 if(mode === 'prepare') {
  const {policy} = officePhysicalFixture('x86_64');
  const mount=JSON.parse(await readFile(mountFile!,'utf8'));
  policy.journal={...mount,path:root!};
  const {plan,document}=officeDeleteDispositionFixture();
  const binding={schema:'qorpera.lxd-office-guest/v2' as const,...policy.guest, allocationId:plan.predecessor.startup.allocationId,providerPolicySha256:lxdOfficePhysicalPolicySha256(policy)};
  plan.predecessor.providerId=binding.providerId;
  plan.predecessor.providerPolicySha256=binding.providerPolicySha256;
  plan.predecessor.startup.scope={companyId:binding.companyId,environmentId:binding.environmentId,companyComputerId:binding.companyComputerId,logicalComputerId:binding.logicalComputerId};
  plan.predecessor.startup.imageSha256=binding.imageFingerprint;
  plan.predecessor.startup.bootstrapSha256=binding.bootstrapSha256;
  plan.providerBindingSha256=officeDigest(binding);
  document.planSha256=officeDigest(plan);
  const guest=lxdOfficeGuestPlan(binding);let n=100;let unknown=false;
  const client={submitInstanceOperation:async(project:string)=>({project,instanceName:guest.request.name,operationId:id(n++)}),inspectInstanceOperation:async()=>{if(unknown)throw new Error('synthetic evicted result');return 'succeeded' as const}};
  const journal=await LxdOfficeOperationJournal.open(root!,plan.intentId,binding,client);
  for(const [command,action] of [[id(90),'create'],[id(91),'start'],[plan.commands.stopCommandId,'stop']] as const) await journal.reconcile(command,action,new AbortController().signal);
  unknown=true;
  const result=await journal.reconcile(plan.commands.deleteCommandId,'delete',new AbortController().signal);
  if(result.state!=='unknown')throw new Error('fixture UNKNOWN expected');
  const dir=join(root!,binding.allocationId);
  document.operationId=result.operationId!;
  const history=await journal.history();
  document.journal={authoritySha256:hash(await readFile(join(dir,'authority.json'))),acceptedHeadSha256:history.journalHeadSha256,eventCount:history.events.length};
  const phases=await LxdOfficeResetJournal.open(root!,plan);
  for(const [phase,digest] of [['fenced',officeDigest(plan)],['stopped',document.stopAcknowledgementSha256],['custodied',document.custodyEvidenceSha256],['powered_off',document.poweredOffPhaseSha256]] as const)await phases.advance(phase,digest);
  const saved:Record<string,string>={};
  for(const name of await readdir(dir))saved[join(dir,name)]=hash(await readFile(join(dir,name)));
  for(const name of await readdir(root!))if(name.endsWith('.json'))saved[join(root!,name)]=hash(await readFile(join(root!,name)));
  const config={schema:'qorpera.lxd-office-provider-service/v1',policyPath:'/etc/qorpera-fixture/policy.json',provenancePath:'/etc/qorpera-fixture/provenance.json',planPath:'/etc/qorpera-fixture/plan.json',registryUrl:'https://example.invalid',registryCredential:{path:'/etc/qorpera-fixture/unused.credential',bytes:64,sha256:'a'.repeat(64)},inventoryLimits:{maxEntries:100,maxDepth:4,maxFileBytes:1024,maxTotalBytes:4096,maxManifestBytes:65536},pollIntervalMs:2000};
  console.log(JSON.stringify({policy,config,envelope:officeDeleteDispositionEnvelopeFor(plan,document),saved,allocationId:binding.allocationId,auditId:document.auditId}));
 } else if(mode === 'metadata') {
  const packet=JSON.parse(await readFile(mountFile!,'utf8'));
  console.log(JSON.stringify(await runLxdOfficeDeleteMetadataCommand('/etc/qorpera-fixture/service.json',packet.allocationId,packet.auditId)));
 } else if(mode==='verify') {
  const packet=JSON.parse(await readFile(mountFile!,'utf8'));
  for(const [path,digest] of Object.entries(packet.saved))if(hash(await readFile(path))!==digest)throw new Error('HISTORICAL_BYTES_CHANGED');
  const history=await LxdOfficeOperationJournal.readHistory(root!,packet.allocationId);
  const tail=history.events.at(-1);
  if(history.events.length!==12 || tail?.kind!=='administrative_disposition' || tail.state!=='unknown')throw new Error('WRONG_FINAL_HISTORY');
  console.log(JSON.stringify({historicalFilesPreserved:Object.keys(packet.saved).length,events:history.events.length,tail}));
 } else throw new Error('UNKNOWN_MODE');
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
