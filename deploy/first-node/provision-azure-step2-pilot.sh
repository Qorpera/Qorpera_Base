#!/usr/bin/env bash
set -euo pipefail

SUBSCRIPTION_ID="f6e33940-7e65-4151-bd77-1e09c0de83a7"
TENANT_ID="6388d625-9491-4a13-98ca-fc750ec2fe7d"
EXPECTED_USER="Jonas.mk@qorpera.com"
LOCATION="swedencentral"
ZONE="1"
RESOURCE_GROUP="rg-qorpera-step2-pilot"
VM_NAME="qorpera-step2-compat-01"
VM_SIZE="Standard_D4s_v6"
IMAGE_URN="Canonical:ubuntu-26_04-lts:server:26.04.202608210"
VNET_NAME="qorpera-step2-pilot-vnet"
SUBNET_NAME="host"
NSG_NAME="qorpera-step2-pilot-nsg"
NIC_NAME="qorpera-step2-compat-01-nic"
OS_DISK_NAME="qorpera-step2-compat-01-os"
DATA_DISK_NAME="qorpera-step2-compat-01_DataDisk_0"
INVENTORY_PREFIX="qorpera-step2-azure-pilot"

usage() {
	echo "Usage: $0 /path/to/operator_ed25519.pub" >&2
}

if [[ $# -ne 1 ]]; then
	usage
	exit 64
fi

public_key_path=$1
if [[ ! -f ${public_key_path} ]]; then
	echo "The pilot public key does not exist: ${public_key_path}" >&2
	exit 1
fi
if [[ $(wc -l <"${public_key_path}") -ne 1 ]] ||
	! grep -Eq '^ssh-ed25519 [A-Za-z0-9+/=]+( .*)?$' "${public_key_path}"; then
	echo "The supplied file is not one Ed25519 public key." >&2
	exit 1
fi

current_subscription=$(az account show --query id -o tsv)
current_tenant=$(az account show --query tenantId -o tsv)
current_user=$(az account show --query user.name -o tsv)
current_state=$(az account show --query state -o tsv)
if [[ ${current_subscription} != "${SUBSCRIPTION_ID}" ]] ||
	[[ ${current_tenant} != "${TENANT_ID}" ]] ||
	[[ ${current_user} != "${EXPECTED_USER}" ]] ||
	[[ ${current_state} != Enabled ]]; then
	echo "Refusing to provision from an unexpected Azure authority." >&2
	exit 1
fi

if [[ $(az group exists --name "${RESOURCE_GROUP}") != false ]]; then
	echo "Refusing to reuse an existing pilot resource group." >&2
	exit 1
fi
if [[ $(az resource list --query "[?resourceGroup=='${RESOURCE_GROUP}'] | length(@)" -o tsv) != 0 ]]; then
	echo "Pilot-named resources already exist outside the expected empty boundary." >&2
	exit 1
fi

started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
expires_at=$(date -u -d '+24 hours' +%Y-%m-%dT%H:%M:%SZ)
guard_time=$(date -u -d '+6 hours' +%H%M)
tag_expiry=$(date -u -d '+24 hours' +%Y%m%dT%H%M%SZ)
tags=(
	"qorpera-purpose=step2-synthetic-pilot"
	"qorpera-owner=runtime-step2"
	"qorpera-expiry=${tag_expiry}"
)

vm_created=false
guard_ready=false
pilot_ready=false
deallocate_unprotected_vm() {
	local status=$?
	trap - EXIT
	if [[ ${vm_created} == true && ${pilot_ready} != true ]]; then
		if [[ ${guard_ready} == true ]]; then
			echo "Pilot provisioning did not complete; deallocating the guarded VM." >&2
		else
			echo "The deallocation guard was not verified; deallocating the pilot VM." >&2
		fi
		az vm deallocate \
			--subscription "${SUBSCRIPTION_ID}" \
			--resource-group "${RESOURCE_GROUP}" \
			--name "${VM_NAME}" || true
	fi
	exit "${status}"
}
trap deallocate_unprotected_vm EXIT

az account set --subscription "${SUBSCRIPTION_ID}"
if [[ $(az provider show --namespace Microsoft.DevTestLab --query registrationState -o tsv) != Registered ]]; then
	az provider register --namespace Microsoft.DevTestLab --wait
fi
az group create \
	--subscription "${SUBSCRIPTION_ID}" \
	--name "${RESOURCE_GROUP}" \
	--location "${LOCATION}" \
	--tags "${tags[@]}" \
	--output none

az network vnet create \
	--subscription "${SUBSCRIPTION_ID}" \
	--resource-group "${RESOURCE_GROUP}" \
	--name "${VNET_NAME}" \
	--location "${LOCATION}" \
	--address-prefixes 10.42.0.0/24 \
	--subnet-name "${SUBNET_NAME}" \
	--subnet-prefixes 10.42.0.0/27 \
	--tags "${tags[@]}" \
	--output none

az network nsg create \
	--subscription "${SUBSCRIPTION_ID}" \
	--resource-group "${RESOURCE_GROUP}" \
	--name "${NSG_NAME}" \
	--location "${LOCATION}" \
	--tags "${tags[@]}" \
	--output none

az network nsg rule create \
	--subscription "${SUBSCRIPTION_ID}" \
	--resource-group "${RESOURCE_GROUP}" \
	--nsg-name "${NSG_NAME}" \
	--name deny-internet-inbound \
	--priority 100 \
	--direction Inbound \
	--access Deny \
	--protocol '*' \
	--source-address-prefixes Internet \
	--source-port-ranges '*' \
	--destination-address-prefixes '*' \
	--destination-port-ranges '*' \
	--output none

az network nic create \
	--subscription "${SUBSCRIPTION_ID}" \
	--resource-group "${RESOURCE_GROUP}" \
	--name "${NIC_NAME}" \
	--location "${LOCATION}" \
	--vnet-name "${VNET_NAME}" \
	--subnet "${SUBNET_NAME}" \
	--network-security-group "${NSG_NAME}" \
	--accelerated-networking true \
	--ip-forwarding false \
	--tags "${tags[@]}" \
	--output none

public_ip_id=$(az network nic show \
	--subscription "${SUBSCRIPTION_ID}" \
	--resource-group "${RESOURCE_GROUP}" \
	--name "${NIC_NAME}" \
	--query 'ipConfigurations[0].publicIPAddress.id' \
	--output tsv)
if [[ -n ${public_ip_id} ]]; then
	echo "The pilot NIC unexpectedly has a public IP address." >&2
	exit 1
fi

az vm create \
	--subscription "${SUBSCRIPTION_ID}" \
	--resource-group "${RESOURCE_GROUP}" \
	--name "${VM_NAME}" \
	--computer-name "${VM_NAME}" \
	--location "${LOCATION}" \
	--zone "${ZONE}" \
	--size "${VM_SIZE}" \
	--priority Regular \
	--image "${IMAGE_URN}" \
	--security-type TrustedLaunch \
	--enable-secure-boot true \
	--enable-vtpm true \
	--admin-username qorpera-admin \
	--authentication-type ssh \
	--ssh-key-values "${public_key_path}" \
	--nics "${NIC_NAME}" \
	--os-disk-name "${OS_DISK_NAME}" \
	--os-disk-size-gb 64 \
	--storage-sku StandardSSD_LRS \
	--tags "${tags[@]}" \
	--output none
vm_created=true

az vm auto-shutdown \
	--subscription "${SUBSCRIPTION_ID}" \
	--resource-group "${RESOURCE_GROUP}" \
	--name "${VM_NAME}" \
	--time "${guard_time}" \
	--output none

schedule_id=$(az resource list \
	--subscription "${SUBSCRIPTION_ID}" \
	--resource-group "${RESOURCE_GROUP}" \
	--resource-type Microsoft.DevTestLab/schedules \
	--query "[?contains(name, '${VM_NAME}')].id | [0]" \
	--output tsv)
if [[ -z ${schedule_id} ]]; then
	echo "Azure did not expose the VM deallocation schedule." >&2
	exit 1
fi
schedule_status=$(az resource show \
	--subscription "${SUBSCRIPTION_ID}" \
	--ids "${schedule_id}" \
	--query properties.status \
	--output tsv)
if [[ ${schedule_status} != Enabled ]]; then
	echo "The VM deallocation schedule is not enabled." >&2
	exit 1
fi
guard_ready=true

az disk create \
	--subscription "${SUBSCRIPTION_ID}" \
	--resource-group "${RESOURCE_GROUP}" \
	--name "${DATA_DISK_NAME}" \
	--location "${LOCATION}" \
	--zone "${ZONE}" \
	--size-gb 256 \
	--sku StandardSSD_LRS \
	--hyper-v-generation V2 \
	--tags "${tags[@]}" \
	--output none

az vm disk attach \
	--subscription "${SUBSCRIPTION_ID}" \
	--resource-group "${RESOURCE_GROUP}" \
	--vm-name "${VM_NAME}" \
	--name "${DATA_DISK_NAME}" \
	--lun 0 \
	--caching None \
	--output none

az vm update \
	--subscription "${SUBSCRIPTION_ID}" \
	--resource-group "${RESOURCE_GROUP}" \
	--name "${VM_NAME}" \
	--set storageProfile.osDisk.deleteOption=Delete \
		networkProfile.networkInterfaces[0].deleteOption=Delete \
		storageProfile.dataDisks[0].deleteOption=Detach \
	--output none

az resource list \
	--subscription "${SUBSCRIPTION_ID}" \
	--resource-group "${RESOURCE_GROUP}" \
	--output json >"${INVENTORY_PREFIX}-resources.json"
az vm show \
	--subscription "${SUBSCRIPTION_ID}" \
	--resource-group "${RESOURCE_GROUP}" \
	--name "${VM_NAME}" \
	--show-details \
	--output json >"${INVENTORY_PREFIX}-vm.json"
az network nic show \
	--subscription "${SUBSCRIPTION_ID}" \
	--resource-group "${RESOURCE_GROUP}" \
	--name "${NIC_NAME}" \
	--output json >"${INVENTORY_PREFIX}-nic.json"
az resource show \
	--subscription "${SUBSCRIPTION_ID}" \
	--ids "${schedule_id}" \
	--output json >"${INVENTORY_PREFIX}-guard.json"

cat >"${INVENTORY_PREFIX}-ledger.txt" <<EOF
schema=qorpera.azure-step2-pilot-ledger/v1
subscription_id=${SUBSCRIPTION_ID}
tenant_id=${TENANT_ID}
operator=${EXPECTED_USER}
resource_group=${RESOURCE_GROUP}
vm_name=${VM_NAME}
location=${LOCATION}
zone=${ZONE}
size=${VM_SIZE}
image=${IMAGE_URN}
started_at=${started_at}
authorized_expiry=${expires_at}
deallocation_guard_utc=${guard_time}
deallocation_guard_status=${schedule_status}
public_ip=none
data=synthetic-only
EOF

pilot_ready=true
trap - EXIT
echo "AZURE_STEP2_PILOT_PROVISIONED"
echo "resource_group=${RESOURCE_GROUP}"
echo "vm_name=${VM_NAME}"
echo "deallocation_guard_utc=${guard_time}"
echo "inventory_prefix=${INVENTORY_PREFIX}"
