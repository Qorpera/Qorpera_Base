# Step 2: Azure compatibility and recovery pilot

Status, 2026-08-29: **Phase A and the separately approved revised Phase B both
passed and were fully deleted**. The runs preserved the Trusted Launch,
Secure Boot, vTPM, signed-guest, private-network and retained-disk boundaries;
Phase B additionally proved an independent recovery authority and a distinct
replacement target. No matching Azure pilot resource remains. No production
Company File, identity, provider credential or paid model API was used, and no
private key was read into evidence or exposed. This is synthetic Step 2
acceptance, not production activation. Step 3 remains paused.

## What the pilot must prove

Qorpera is pure cloud. One logical Company Computer is shared by that company's
agents; it is not one VM per agent. The live Company File is the authoritative
company state, independent of the computer and any provider-specific disk.
Changing compute providers must not introduce desktop-owned work, a second
Company File, or branches/checkouts of the company.

Azure is a candidate for scalable infrastructure, not a substitute for Qorpera's
authority, job, receipt and path-permission machinery. The current runner uses
LXD/KVM, signed Linux guests and separately retained identity/recovery volumes.
These exact boundaries must survive the move before claiming compatibility.

## Phase A: one synthetic compatibility host

Approved starting size: Standard_D4s_v6 in Sweden Central, 4 vCPUs and 16 GiB.
Use Linux pay-as-you-go, not Spot, Windows, a reservation or a savings-plan
commitment. The original D4s_v5 proposal has zero family quota in this new
subscription. Dsv6 has 10 unused family vCPUs and Sweden Central has 10 unused
regional vCPUs; the portal offers D4s_v6 in zone 1 without a quota restriction.
No quota increase was requested. Actual allocation is not guaranteed by the
picker; record the deployed image version and capacity outcome before claiming
acceptance.

The draft uses Canonical's free Ubuntu Server 26.04 LTS - x64 Gen 2 image, not a
third-party marketplace image or Ubuntu Pro. It has Secure Boot and vTPM enabled,
64-GiB E6 and 256-GiB E15 Standard SSD LRS disks, and public inbound ports set to
None. The data disk is separate and is not marked for deletion with the VM.
Its contents must remain synthetic. The pilot names are rg-qorpera-step2-pilot,
qorpera-step2-compat-01 and qorpera-step2-compat-01_DataDisk_0. Authentication/key
setup uses a pilot-only public key and no public inbound SSH. The immutable
image pin is Canonical:ubuntu-26_04-lts:server:26.04.202608210, verified active,
x64 Gen 2 and TrustedLaunchSupported through the subscription API. No existing
Company File or identity is attached.

Microsoft lists nested virtualization for Dsv6. That is not evidence that our
specific kernel, LXD version, signed guest and network boundary pass. Keep
Trusted Launch and guest protections enabled for the first test; do not silently
downgrade security to obtain a boot. A compatibility failure is a decision gate.

The physical-node bootstrap is not portable: it assumes the physical hostname,
root LVM layout and a 1400-GiB dedicated LXD device. Never run it unchanged on
Azure or weaken its destructive-target checks. Deploy only a bare host for the
first, non-destructive KVM gate through Azure Run Command. Before installing
LXD, a separate pilot provisioner must use an explicitly identified empty data
disk and fail before formatting an unknown disk. Do not format an existing
Company File or identity volume.

Use a dedicated resource group and restricted operator access. Do not expose
LXD, NFS, the native tool sockets, or the recovery listener to the public
internet. Keep credentials out of source, shell arguments, cloud-init logs,
model context and the Company File. The first host receives synthetic fixtures,
not production provider capsules or company data.

Acceptance must record:

1. Exact Azure resource, region/zone, SKU, OS image, kernel and LXD versions.
2. Nested KVM and signed guest boot with the existing mount, network, executable
   and authority checks. No fallback to an ungoverned driver.
3. Tool-result fencing, private model output, revoked authority and the existing
   public-send path, with adversarial synthetic fixtures.
4. Reboot/replacement behavior for separately retained volumes. Losing a VM
   must not silently initialize an established identity or rerun uncertain work.
5. Private connectivity and failure behavior, without changing production NAS
   mounts or enabling paused production orchestration.

## Phase A result

Phase A passed on 2026-08-29. Subscription
`f6e33940-7e65-4151-bd77-1e09c0de83a7`, tenant
`6388d625-9491-4a13-98ca-fc750ec2fe7d`, and the approved operator account were
reverified before provisioning. The zone 1 host was exact
`Standard_D4s_v6`, image
`Canonical:ubuntu-26_04-lts:server:26.04.202608210`, Trusted Launch with Secure
Boot and vTPM, 64-GiB E6 OS disk, and separately retained 256-GiB E15 data disk.
Its NIC had only `10.42.0.4`, no public IP or inbound mapping, and the attached
NSG denied `Internet` on every inbound port. The enabled and succeeded
`ComputeVmShutdownTask` targeted only this VM at 10:17 UTC.

The non-destructive KVM verifier SHA-256
`b3d74815815bf1d8b3540ecb0f7354e54d00d147d5f0e60e43971c26df0f5b94`
verified Ubuntu 26.04, kernel `7.0.0-1012-azure`, Microsoft outer
virtualization, Secure Boot, vTPM, KVM API version 12, and a successful KVM
VM-create ioctl. Immediately before formatting, the bootstrap repeated that
the exact LUN 0 link resolved to `/dev/nvme0n2`, 274,877,906,944 bytes,
unmounted, without child devices, filesystem, or signatures.

The signed v52 archive reached Azure through the temporary approved transfer
path and matched 2,398,885,127 bytes and SHA-256/LXD fingerprint
`f3f763287ee3fe7ba3e31926be8341b2e1567e35283e129f673edb4d5a75d67a`.
All ten companion files also matched their source SHA-256 values. Azure Storage
SFTP's application-layer firewall initially rejected the VM despite the exact
NAT address being allowlisted. A same-region `Microsoft.Storage` service
endpoint and exact host-subnet virtual-network rule restored the deny-by-default
path without adding public inbound access. The upload and download users were
deleted at 06:38 UTC, SFTP was disabled, and the VM and source transfer keys
were removed before host bootstrap. The final evidence reports zero transfer
credential files and zero storage local users.

The final Azure-only bootstrap SHA-256 is
`d936d0937f661b6a6679982b44625d4c6776bcfecc12a201eb1fb6f306575310`.
It installed and held exact packages
`nodejs=22.22.1+dfsg+~cs22.19.15-1ubuntu1` and
`zfsutils-linux=2.4.1-1ubuntu5`, Node `v22.22.1`, and LXD
`6.9-ab8fad2` revision `40424`. It created only ZFS pool
`qorpera-azure-step2`, LXD pool `qorpera-vm`, private bridge `qorpera0`, project
`qorpera-runners`, and the job/login/management profiles. Remote LXD remained
disabled and the pool reported healthy.

The final signed-guest verifier SHA-256 is
`83d37af68a0251ca72f341dc95967f9df9c90b2b1da768e8fb07e9a9e65bf404`.
Two fail-closed pilot findings were corrected before final acceptance: snap hold
state is now read from `snap list` and host ZFS health uses the pinned Ubuntu
tool; the retained-marker proof now flushes the guest filesystem, performs a
bounded graceful guest shutdown, and syncs the host pool instead of forcing an
immediate power-off. Focused source tests cover both fixes.

The final initial run began at 07:03:51 UTC and passed signed provenance, the
exact 2-vCPU/4-GiB Secure Boot KVM guest contract, production cgroup limits,
private-result fencing and revocation, the native isolation probe, and the
synthetic public-mouth lost-response/replay probe. The outer host was restarted,
and the post-reboot run beginning at 07:05:53 UTC passed the same contract and
probes. The initial outer boot ID
`613ba481-e9e9-4df6-8578-bb117be2e4cc` differs from the post-reboot ID
`5486557e-a8f6-4be3-b9b2-1b37d5cd5c7b`; the verifier also required the guest
boot ID to change. The retained marker remained SHA-256
`a03b890cbc51ad43574f3872ae366063f67c01a8ff12568ad297c96252135ae8`.
The recognized synthetic guest was deleted, leaving zero instances.

The VM was deallocated at 07:11 UTC. Deletion of exact resource group
`rg-qorpera-step2-pilot` was requested at 07:13:45 UTC after evidence capture.
At 07:18:18 UTC Azure reported that group absent, with zero matching resource
groups and zero matching subscription resources. Phase B's resource group was
also absent. This is a same-host Phase A compatibility/replay result, not the
independent replacement-authority proof required for Phase B.

## Phase B: independent recovery result

The revised Phase B scope was explicitly approved and passed on 2026-08-29.
Resource group `rg-qorpera-step2-phase-b` contained a zone 1 Trusted Launch
`Standard_D4s_v6` replacement target and an independent zone 1 Trusted Launch
`Standard_D2s_v6` recovery authority. Both used the pinned Ubuntu image, Secure
Boot, vTPM and exact E6 OS disks. The target used its separately retained E15
data disk; the recovery authority used its separately retained E4 journal disk.
The target had no public IP, neither NSG admitted public inbound traffic, and
both hosts passed the non-destructive KVM gate without weakening Trusted Launch.

The target booted the exact signed v52 full-VM image. The independent recovery
host kept the production unit disabled and inactive; a controlled start with
missing credentials failed closed. Its loopback-only synthetic proof service
then started before two distinct replica mounts. Two separate signed guests
represented the old and replacement generations. The live proof verified two
encrypted/read-verified replicas, explicit replica selection, owner approval,
exact target pins, old-recipient and old-generation denial, lost completion
acknowledgement, authority restart, byte-identical receipt replay, capsule
authentication, fresh admission only after the receipt, and exactly one durable
completion receipt. It emitted no private key material.

The refreshed 24-hour retail subtotal was EUR 9.923249315068492, below the EUR
11 provisioning stop and EUR 14 authorization ceiling. The observed resource
lifecycle before cleanup was 1.155 hours; the conservative two-hour allocation
upper bound was EUR 1.830504109589041 before tax. Azure deletion was requested
at `2026-08-29T09:28:46Z` and verified complete at
`2026-08-29T09:33:19Z`: the resource group is absent, matching resources are
zero, the transfer-storage name is available, and source transfer temporaries
are absent.

The sealed evidence is
`/Users/jonas/.codex/worktrees/27d4/Qorpera_Base-step2/.artifacts/runtime-step-separation-20260828/step2/verification/azure-phase-b/provisioned-20260829T081608Z`.
Its `SHA256SUMS` file has SHA-256
`eed312ad8f666cd8c111ef34c52c5a493ce0a349634ba708342ba44600822476`.
This proves the synthetic replacement-node boundary; it does not authorize a
production recovery, SQL/runtime cutover, NAS mutation or release.

## Initial price evidence, not a purchase approval

Public EUR consumption prices were read from Microsoft's Retail Prices API on
2026-08-29. These are estimates, not subscription-specific invoices or a spending
cap. No trial credit or discount is assumed.

| Proposed Phase A resource | Published rate | 730-hour estimate |
| --- | --- | --- |
| Linux Standard_D4s_v6 | EUR 0.1880/hour | EUR 137.24 |
| E6 LRS Standard SSD OS disk, 64 GiB | EUR 4.2174/month | EUR 4.22 |
| E15 LRS Standard SSD data disk, 256 GiB | EUR 16.8695/month | EUR 16.87 |
| Standard regional IPv4 address, if used | EUR 0.0044/hour | EUR 3.21 |

The listed allocation subtotal is approximately EUR 161.54/month, or EUR 5.31
for 24 hours using a 730-hour prorating estimate. Disk transactions, egress,
managed boot-diagnostic storage, snapshots/backups, taxes and the separate
Phase B recovery host are excluded. The portal shows USD 183.87/month for VM,
disks and IP, but also says that one or more costs did not load. Neither that
preview nor the public EUR subtotal is an all-in quote or a billing cap.

Approved authorization: one synthetic Phase A pilot for at most 24 hours, with
an operating budget of EUR 15 before tax, followed by removal of only the
explicitly inventoried synthetic pilot resources, disks and IP after preserving
non-secret acceptance evidence. The user approved this exact boundary on
2026-08-29. Do not imply that an Azure budget is a hard spending cap. Set a
verified deallocation guard
before running the pilot and keep a cost/time ledger; request approval before
extending it or adding a recovery host. Stopping a VM is not deletion of its
billable disks or IP. Do not configure automatic scale-in or deletion of real
identity/journal volumes as cost control.

Retail meter IDs: D4s_v6 2d07e217-c924-5111-b3ea-b6f72762fca9; E6
6400883f-db80-5ef7-b901-0687e0d26b8d; E15
40664069-c433-525e-a9c1-357e515bc074; regional IPv4
9c150bf9-2bad-430e-a53c-c213804f49ef. Recheck rates at purchase.

## Observed Phase A time and cost ledger

Azure activity evidence records resource-group creation at 04:18:43 UTC and
verified absence at 07:18:18 UTC, a total lifecycle under three hours. Compute
ran from initial VM creation at 04:21:36 until deallocation at 05:19:51, then
from the approved restart at 06:19:59 until final deallocation at 07:11:20:
approximately 1.827 D4s_v6 hours, or EUR 0.344 at the published rate. Prorated
E6/E15 allocation for the resource-group lifetime is under EUR 0.087.

The NAT/IP/storage transfer resources existed for about 67 minutes. SFTP was
enabled from storage creation at 06:12 UTC until 06:38 UTC, under one hour, and
2.4 GiB crossed the NAT path. At the published NAT rates, gateway time, IP time,
and data processing are under EUR 0.15. Conservatively allowing EUR 1 for the
SFTP hour, temporary Hot LRS storage, and transactions keeps the non-invoice
retail estimate below EUR 1.60 before tax. Azure billing can round or post
meters later; the subscription invoice remains authoritative. The pilot stayed
well inside both the 24-hour/EUR 15 Phase A authorization and the three-hour/EUR
2 transfer authorization.

## Scaling direction after acceptance

Use replaceable hosts with external company state and explicitly retained
identity/recovery volumes. VM Scale Sets Flexible is a candidate for fleet
management, not an automatic migration decision. Qorpera must still drain work,
fence old generations, quarantine uncertain effects and protect stateful
instances from scale-in. Neither fleet density nor launch capacity is proven by
this single-host pilot. Do not integrate Step 3 as part of the infrastructure work.

Sources: [Dsv6 capabilities](https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/general-purpose/dsv6-series),
[provider registration](https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/resource-providers-and-types),
[VM quotas](https://learn.microsoft.com/en-us/azure/virtual-machines/quotas),
[Trusted Launch](https://learn.microsoft.com/en-us/azure/virtual-machines/trusted-launch),
[managed disks](https://learn.microsoft.com/en-us/azure/virtual-machines/managed-disks-overview),
[Flexible orchestration](https://learn.microsoft.com/en-us/azure/virtual-machine-scale-sets/virtual-machine-scale-sets-orchestration-modes),
[Key Vault authentication](https://learn.microsoft.com/en-us/azure/key-vault/general/authentication),
[Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices).
