# Runtime Step 2 Phase B replacement-node proposal

Status, 2026-08-29: **the exact revised scope below was approved, executed,
passed and fully deleted**. This historical proposal does not authorize another
Azure run, production mutation, NAS mutation, source-control action or release.
Step 3 remains paused.

The immutable planning record
`STEP-2-PHASE-B-AND-PRODUCTION-ROLLOUT.md`, SHA-256
`a40e1dda24c3516ab10d6e464d68e41fe23939673131b0ba81e138dab5c1f4e0`,
priced only the independent recovery authority at EUR 6 because it assumed the
approved Phase A D4s_v6 host would remain available as the replacement target.
Phase A's mandatory cleanup deleted that host and both disks. The EUR 6 plan is
therefore no longer sufficient to execute the full proof. Preserve it as
architecture evidence; use this replacement proposal for the next approval
gate.

## Exact proposed Azure scope

Create only resource group `rg-qorpera-step2-phase-b` in Sweden Central for at
most 24 hours:

| Role | Exact proposed resources |
| --- | --- |
| Replacement target | Zone 1 Trusted Launch `Standard_D4s_v6`; Secure Boot and vTPM; pinned `Canonical:ubuntu-26_04-lts:server:26.04.202608210`; 64-GiB E6 OS disk; separately retained 256-GiB E15 data disk; private NIC only; NSG denies `Internet` on every inbound port; signed v52 image `f3f763287ee3fe7ba3e31926be8341b2e1567e35283e129f673edb4d5a75d67a`. |
| Recovery authority | Separate zone 1 Trusted Launch `Standard_D2s_v6`; Secure Boot and vTPM; the same pinned Ubuntu image; 64-GiB E6 OS disk; separately retained 32-GiB E4 journal disk mounted at `/var/lib/qorpera-recovery`; Standard static regional IPv4 for explicit egress; NSG denies every inbound port; service remains loopback-only. |
| Network | One VNet with distinct target and recovery subnets. One Standard NAT Gateway and one Standard static IPv4 attach only to the target subnet; the target VM receives no public IP. No public SSH or inbound management rule is permitted. Use Azure Run Command for both hosts. |
| Transfer | Temporary Hot LRS/HNS storage with SFTP enabled for at most three hours, shared-key access disabled, key-only least-privilege upload/download users, default-deny firewall, published regional host keys, and an exact target-subnet service endpoint/rule if Azure's application-layer SFTP firewall requires it. Delete both users and keys and disable SFTP immediately after byte/hash verification. |
| Guard and cleanup | Configure and verify an enabled, succeeded VM shutdown schedule for each VM before any test. After evidence, delete the exact resource group, including both retained data disks, both VM OS disks, both public IPs, NAT, storage, NICs, NSGs, and VNet. |

Before provisioning, recheck zone-1 capacity, Dsv6 quota, Trusted Launch,
Secure Boot, vTPM, the exact Ubuntu version, retail prices, and the initial
absence of `rg-qorpera-step2-phase-b`. Any mismatch is a stop gate, not
permission to substitute a SKU, region, zone, security type, image, disk, or
network boundary.

## Exact time and spend proposal

Public EUR retail rates queried on 2026-08-29 give the following conservative
24-hour allocation estimate:

| Resource | Rate basis | 24-hour estimate |
| --- | ---: | ---: |
| D4s_v6 replacement VM | EUR 0.1880/hour | EUR 4.512 |
| Replacement E6 OS disk | EUR 4.2174/month prorated over 730 hours | EUR 0.139 |
| Replacement E15 data disk | EUR 16.8695/month prorated over 730 hours | EUR 0.555 |
| D2s_v6 recovery VM | EUR 0.0940/hour | EUR 2.256 |
| Recovery E6 OS disk | EUR 4.2174/month prorated over 730 hours | EUR 0.139 |
| Recovery E4 journal disk | EUR 2.1087/month prorated over 730 hours | EUR 0.069 |
| Recovery Standard IPv4 | EUR 0.0044/hour | EUR 0.106 |
| Target NAT Gateway | EUR 0.0395/hour | EUR 0.948 |
| NAT Standard IPv4 | EUR 0.0044/hour | EUR 0.106 |
| NAT processing for one 2.4-GiB image transfer | EUR 0.0395/GiB | EUR 0.095 |
| SFTP, Hot LRS storage, and transactions | At most three SFTP hours plus 2.4 GiB temporary storage | EUR 1.000 allowance |

The conservative published subtotal is EUR 9.925 before tax. Request an exact
authorization ceiling of **EUR 14 before tax for at most 24 hours**, including
the transfer allowance and followed by exact cleanup. This is not an Azure hard
budget. Do not provision if the refreshed subtotal exceeds EUR 11 or if a
subscription-specific estimate cannot remain inside the EUR 14 ceiling.

## Proof sequence

1. Re-run the non-destructive KVM and empty-disk gates on both hosts. Never
   weaken Trusted Launch.
2. Install the recovery authority disabled, format only its exact empty E4
   journal, and verify root-owned systemd credentials, loopback-only listeners,
   independently registered public keys, and no NAS startup dependency.
3. Build the replacement target from the final Phase A bootstrap and signed
   image bytes. Keep new admission disabled.
4. Register synthetic authority and two encrypted-key replicas for the isolated
   source fixture. Record the exact current owner/member approval, generation,
   capability hash, journal receipt, and target image/manifest pins.
5. Fence and make the source fixture unavailable. With NAS also unavailable at
   recovery-service startup, prove explicit replica choice, replacement-only
   key installation, old-node and old-generation denial, fresh admission, lost
   acknowledgement replay, and exactly one durable completion receipt.
6. Reconnect the verified NAS replica only after recovery startup, verify it
   cannot override the journal decision, then leave all synthetic work stopped.
7. Capture non-secret evidence, remove the recognized synthetic instances,
   deallocate both VMs, and delete the exact resource group.

Passing this proposal would prove independent recovery authority and a distinct
replacement target. It would not authorize production SQL, production runtime
cutover, NAS writes/deletes, commits, pushes, or a release.

## Execution result

The approved run retained every security, image, disk, network, time and cost
boundary above. The refreshed conservative 24-hour subtotal was EUR
9.923249315068492. Both hosts passed their KVM gates, the target passed signed
v52 guest acceptance, and the independent recovery authority completed the
two-replica, explicit-source, lost-acknowledgement, restart/replay and old-node
fencing proof with exactly one durable completion receipt. No private key was
emitted into evidence.

The resource lifecycle before cleanup was 1.155 hours; the conservative
two-hour allocation upper bound was EUR 1.830504109589041 before tax. Deletion
of `rg-qorpera-step2-phase-b` was verified at `2026-08-29T09:33:19Z`, with zero
matching resources and no source transfer temporaries. The sealed evidence is
`/Users/jonas/.codex/worktrees/27d4/Qorpera_Base-step2/.artifacts/runtime-step-separation-20260828/step2/verification/azure-phase-b/provisioned-20260829T081608Z`;
its `SHA256SUMS` file has SHA-256
`eed312ad8f666cd8c111ef34c52c5a493ce0a349634ba708342ba44600822476`.
