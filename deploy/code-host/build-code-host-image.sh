#!/bin/bash
# Build the code host image on an LXD node (run as root).
#
#   build-code-host-image.sh <build-project> <build-network> <storage-pool> <folder-program> > code-host-image-build.json
#
# One image for every company's code host (5e): the VM the coding executor makes for a company on its node
# (packages/runner-orchestrator/src/code-host.ts), with no NIC, no /dev/lxd and no profiles, where the company's
# code area is worked on through its folder. Ubuntu 26.04 minimal with the pinned git as its only git (the pin
# coding machines use, ../coding-machine/coding-image.json; built without its network parts, since a code host has
# no network), fuse3, and the folder program (<folder-program>, built by scripts/build-folder-program.mjs: it must
# be the build ../folder-service/folder-program-linux-x64.json records). 5f's grow-root unit grows the root to the
# VM's disk at boot. apt's self-updates are masked and cloud-init is gone; the compilers the build needs go again
# at its end. README.md says what each installed file is for.
#
# The builder runs as build-coding-image.sh's does: in the node's declared image build space, as a build machine
# (no profiles, its own root disk, the isolation NIC, never autostarting, the builder marker), deleted on every exit
# path. It needs 4 CPUs and 4 GiB of the space, so build when the space is empty. Code host projects use the default
# project's store (features.images=false), so the image goes there, exported and imported when the build space has
# its own store. QORPERA_BUILDER_NIC=plain and QORPERA_BUILD_PROXY are build-coding-image.sh's, for a test machine
# (test/prove-code-host-image.sh).
set -euo pipefail
PROJECT=${1:?the build space project, for example qorpera-build}
NETWORK=${2:?the build space network, for example qorpera0}
POOL=${3:?the storage pool for the builder root, for example qorpera-vm}
FOLDER=${4:?the folder program, built by scripts/build-folder-program.mjs}
(( $# == 4 )) || { echo "usage: $0 <build-project> <build-network> <storage-pool> <folder-program>" >&2; exit 1; }
[[ $(id -u) -eq 0 ]] || { echo "run as root" >&2; exit 1; }
# Only the build record goes to stdout (> code-host-image-build.json); the builder's own output goes to stderr.
exec 3>&1 1>&2
HERE=$(cd "$(dirname "$0")" && pwd)
BASE=ubuntu-minimal:26.04
PINS=$HERE/../coding-machine/coding-image.json
RECORD=$HERE/../folder-service/folder-program-linux-x64.json
pin() { jq -er "$1" "$PINS"; }
[[ $(pin .schema) == qorpera.coding-image-pins/v1 ]] || { echo "unexpected $PINS" >&2; exit 1; }
[[ $(pin .git.version) =~ ^[0-9]+(\.[0-9]+)+$ ]] || { echo "invalid git version" >&2; exit 1; }
[[ $(pin .git.url) =~ ^https://[A-Za-z0-9./_~%+-]+$ ]] || { echo "invalid git url" >&2; exit 1; }
[[ $(pin .git.sha256) =~ ^[0-9a-f]{64}$ ]] || { echo "invalid git sha-256" >&2; exit 1; }
GIT_VERSION=$(pin .git.version)
[[ $(jq -er .schema "$RECORD") == qorpera.folder-program-artifact/v1 ]] || { echo "unexpected $RECORD" >&2; exit 1; }
FOLDER_SHA256=$(jq -er '.sha256 | select(test("^[0-9a-f]{64}$"))' "$RECORD")
FOLDER_BYTES=$(jq -er '.bytes | select(type == "number" and . > 0)' "$RECORD")
case ${QORPERA_BUILDER_NIC:-filtered} in
	filtered) NIC=(-d eth0,security.mac_filtering=true -d eth0,security.ipv4_filtering=true
		-d eth0,security.ipv6_filtering=true -d eth0,security.port_isolation=true) ;;
	plain) NIC=() ;;
	*) echo "QORPERA_BUILDER_NIC is filtered (the default) or plain" >&2; exit 1 ;;
esac
PROXY=${QORPERA_BUILD_PROXY:-}
[[ -z $PROXY || $PROXY =~ ^http://[0-9.]+:[0-9]+$ ]] || { echo "QORPERA_BUILD_PROXY is http://<IPv4 address>:<port>" >&2; exit 1; }
# What the image gets from the deploy directory: source, destination, mode. The bootstrap digest covers each of them.
FILES=(
	"../coding-machine/qorpera-grow-root.service /etc/systemd/system/qorpera-grow-root.service 0644"
	"../coding-machine/qorpera-grow-root /usr/local/libexec/qorpera-coding/qorpera-grow-root 0755"
)
for entry in "${FILES[@]}"; do
	read -r source _ _ <<<"$entry"
	[[ -f $HERE/$source ]] || { echo "missing $source" >&2; exit 1; }
done

STAMP=$(date -u +%Y%m%d%H%M%S)
BUILDER="qorpera-code-host-build-$STAMP-$$"
ALIAS="qorpera-code-host-$STAMP"
lx() { lxc --project "$PROJECT" "$@"; }
# A project without its own images uses the default project's store.
store() { if [[ $(lxc project get "$1" features.images) == true ]]; then echo "$1"; else echo default; fi; }
[[ $PROJECT != default ]] || { echo "the builder must run in the node's build space, not in $PROJECT" >&2; exit 1; }
[[ $PROJECT != qorpera-codehost-* ]] || { echo "$PROJECT is named like a code host's project" >&2; exit 1; }
IN_SPACE=$(lx list -f csv -c n)
[[ -z $IN_SPACE ]] || { echo "the build space $PROJECT is in use: build when it is empty" >&2; exit 1; }
WORK=$(mktemp -d)
cleanup() {
	lx delete --force "$BUILDER" >/dev/null 2>&1 || true
	rm -rf -- "$WORK"
}
trap cleanup EXIT
# The image gets this copy, the one checked here.
install -m 0400 -- "$FOLDER" "$WORK/qorpera-folder"
[[ $(stat -c %s "$WORK/qorpera-folder") == "$FOLDER_BYTES" ]] || { echo "$FOLDER is not the recorded folder program's size" >&2; exit 1; }
[[ $(sha256sum "$WORK/qorpera-folder" | cut -d' ' -f1) == "$FOLDER_SHA256" ]] ||
	{ echo "$FOLDER is not the folder program $RECORD records" >&2; exit 1; }

# Made whole in one request (stdin closed: lxc init reads configuration from a stdin that is not a terminal). Its
# root is 10 GiB, the smallest code host disk: a VM's root can never be smaller than its image.
lx init "$BASE" "$BUILDER" --vm --no-profiles --storage "$POOL" -d root,size=10GiB -n "$NETWORK" "${NIC[@]}" \
	-c limits.cpu=4 -c limits.memory=4GiB -c boot.mode=uefi-secureboot -c boot.autostart=false \
	-c user.qorpera.image_builder=true -c user.qorpera.purpose=code-host-image </dev/null
lx start "$BUILDER" || {
	# QEMU's own reason is only in the instance's log, which the cleanup deletes with the builder.
	lx info --show-log "$BUILDER" | tail -n 40 || true
	free -m || true
	exit 1
}
for _ in $(seq 1 90); do lx exec "$BUILDER" -- true >/dev/null 2>&1 && break; sleep 2; done
lx exec "$BUILDER" -- cloud-init status --wait >/dev/null
lx exec "$BUILDER" -- env GIT_VERSION="$GIT_VERSION" GIT_URL="$(pin .git.url)" GIT_SHA256="$(pin .git.sha256)" \
	PROXY="$PROXY" bash -euo pipefail -c '
	export DEBIAN_FRONTEND=noninteractive
	refuse() { echo "check failed: $*" >&2; exit 1; }
	installed() { [[ $(dpkg-query -W -f="\${db:Status-Status}" "$1" 2>/dev/null) == installed ]]; }
	packages() { dpkg-query -W -f="\${db:Status-Status} \${binary:Package}\n" | sed -n "s/^installed //p" | sort; }
	# A test machine'"'"'s proxy, given only in apt'"'"'s options and this environment, so the image keeps neither. It takes one
	# request per connection.
	APT=()
	if [[ -n $PROXY ]]; then
		export http_proxy=$PROXY https_proxy=$PROXY
		APT=(-o "Acquire::http::Proxy=$PROXY" -o "Acquire::https::Proxy=$PROXY" -o Acquire::http::Pipeline-Depth=0)
	fi
	apt-get "${APT[@]}" update
	# What the image keeps: FUSE for the folder program, growpart for the grow-root unit.
	apt-get "${APT[@]}" install -y --no-install-recommends fuse3 cloud-guest-utils
	# The pinned git, built below, is the only git; nothing reaches a code host over SSH; snapd refreshes itself. No
	# autoremove: a metapackage that goes with them would take everything it pulled in.
	for package in snapd openssh-server git git-man; do if installed "$package"; then apt-get purge -y "$package"; fi; done
	packages >/root/kept
	# The build'"'"'s own packages, all gone again below. With git'"'"'s Rust parts, as on coding machines (git'"'"'s default,
	# which NO_RUST turns off); their crate has no dependencies to fetch.
	apt-get "${APT[@]}" install -y --no-install-recommends ca-certificates curl xz-utils gcc libc6-dev make zlib1g-dev \
		rustc cargo
	curl -fsSLo /tmp/git.tar.xz "$GIT_URL"
	echo "$GIT_SHA256  /tmp/git.tar.xz" | sha256sum -c -
	tar -xJf /tmp/git.tar.xz -C /tmp
	# /etc/gitconfig is the system configuration, as with Ubuntu'"'"'s git. A code host has no network, so no transport
	# but local files and bundles (no curl, expat or OpenSSL), and no Perl, Python, Tcl/Tk or translations.
	GITMAKE=(prefix=/usr/local sysconfdir=/etc NO_TCLTK=YesPlease NO_PERL=YesPlease NO_PYTHON=YesPlease
		NO_GETTEXT=YesPlease NO_CURL=YesPlease NO_EXPAT=YesPlease NO_OPENSSL=YesPlease)
	make -C "/tmp/git-$GIT_VERSION" -j"$(nproc)" "${GITMAKE[@]}" all >/tmp/git-build.log 2>&1 ||
		{ tail -n 60 /tmp/git-build.log; exit 1; }
	make -C "/tmp/git-$GIT_VERSION" "${GITMAKE[@]}" install >/tmp/git-build.log 2>&1 ||
		{ tail -n 60 /tmp/git-build.log; exit 1; }
	rm -rf /tmp/git.tar.xz "/tmp/git-$GIT_VERSION" /tmp/git-build.log /root/.cargo
	# Exactly the packages the build added go, and nothing the image had before.
	packages >/root/built
	MISSING=$(comm -23 /root/kept /root/built)
	[[ -z $MISSING ]] || refuse "the build removed packages: $MISSING"
	ADDED=$(comm -13 /root/kept /root/built)
	[[ -z $ADDED ]] || apt-get purge -y $ADDED
	packages | cmp -s - /root/kept || refuse "the packages differ from before the build: $(packages | diff /root/kept - || true)"
	rm -f /root/kept /root/built
	# /company is where the company folder is mounted (the jobs'"'"' companyRoot), /var/lib/qorpera-code-host the jobs'"'"'
	# scratchRoot (code-host-jobs.ts).
	install -d -o root -g root -m 0755 /opt/qorpera-folder /usr/local/libexec/qorpera-coding /company
	install -d -o root -g root -m 0700 /var/lib/qorpera-code-host
'
lx file push "$WORK/qorpera-folder" "$BUILDER/opt/qorpera-folder/qorpera-folder" --uid 0 --gid 0 --mode 0555
for entry in "${FILES[@]}"; do
	read -r source destination mode <<<"$entry"
	lx file push "$HERE/$source" "$BUILDER$destination" --uid 0 --gid 0 --mode "$mode"
done
lx exec "$BUILDER" -- env GIT_VERSION="$GIT_VERSION" FOLDER_SHA256="$FOLDER_SHA256" bash -euo pipefail -c '
	export DEBIAN_FRONTEND=noninteractive
	refuse() { echo "check failed: $*" >&2; exit 1; }
	installed() { [[ $(dpkg-query -W -f="\${db:Status-Status}" "$1" 2>/dev/null) == installed ]]; }
	# A version line; sed reads to the end, so the tool never writes into a closed pipe.
	first() { "$@" 2>&1 | sed -n 1p; }
	systemctl daemon-reload
	systemctl enable qorpera-grow-root.service
	# No self-update: the image stays what was reviewed. A code host has no NIC, so nothing waits for a network.
	MASKED=(apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service unattended-upgrades.service
		systemd-networkd-wait-online.service)
	systemctl mask "${MASKED[@]}"
	# No cloud-init: it would wait for /dev/lxd at every boot. The hostname and the root size are the image'"'"'s, and
	# there is no network to configure.
	for package in cloud-init cloud-init-base; do if installed "$package"; then apt-get purge -y "$package"; fi; done
	rm -rf /etc/cloud /var/lib/cloud /var/log/cloud-init.log /var/log/cloud-init-output.log
	# The cloud image'"'"'s own account: jobs run as root through LXD exec.
	if getent passwd ubuntu >/dev/null; then userdel -r ubuntu; fi
	rm -f /etc/sudoers.d/90-cloud-init-users
	rm -f /etc/netplan/*.yaml
	if command -v netplan >/dev/null; then netplan generate; fi
	echo qorpera-code-host >/etc/hostname
	printf "%s\n" "127.0.0.1 localhost" "127.0.1.1 qorpera-code-host" "::1 localhost ip6-localhost ip6-loopback" \
		"ff02::1 ip6-allnodes" "ff02::2 ip6-allrouters" >/etc/hosts
	# Checks the reviewed image must pass.
	[[ $(command -v git) == /usr/local/bin/git && $(git --version) == "git version $GIT_VERSION" ]] || refuse "git is not $GIT_VERSION"
	if installed git; then refuse "a second git is installed"; fi
	LIBRARIES=$(ldd /usr/local/bin/git /usr/local/libexec/git-core/* 2>&1 || true)
	[[ $LIBRARIES != *"not found"* ]] || refuse "git misses libraries: $LIBRARIES"
	# What 5e'"'"'s jobs do with git: a bundle in, a locked worktree, a ref transaction, gc and fsck. Any failure in the
	# subshell ends the build.
	(
		export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null HOME=/nonexistent
		export GIT_AUTHOR_NAME=q GIT_AUTHOR_EMAIL=q@q GIT_COMMITTER_NAME=q GIT_COMMITTER_EMAIL=q@q
		T=$(mktemp -d)
		git init -q -b main "$T/a"
		git -C "$T/a" commit -q --allow-empty -m one
		git -C "$T/a" bundle create -q "$T/a.bundle" main
		git init -q --bare "$T/b.git"
		git -C "$T/b.git" fetch -q "$T/a.bundle" "refs/heads/*:refs/heads/*"
		git -C "$T/b.git" worktree add -q --lock --detach "$T/w" main
		ONE=$(git -C "$T/b.git" rev-parse main)
		git -C "$T/w" commit -q --allow-empty -m two
		TWO=$(git -C "$T/w" rev-parse HEAD)
		printf "start\nupdate refs/heads/main %s %s\nprepare\ncommit\n" "$TWO" "$ONE" | git -C "$T/b.git" update-ref --stdin
		[[ $(git -C "$T/b.git" rev-parse main) == "$TWO" ]]
		git -C "$T/b.git" gc -q
		git -C "$T/b.git" fsck --strict --no-progress
		rm -rf "$T"
	)
	[[ $(sha256sum /opt/qorpera-folder/qorpera-folder | cut -d" " -f1) == "$FOLDER_SHA256" ]] || refuse "the folder program differs"
	[[ $(stat -c "%a %u %g" /opt/qorpera-folder/qorpera-folder) == "555 0 0" ]] || refuse "the folder program is not root'"'"'s 0555"
	VERSION=$(/opt/qorpera-folder/qorpera-folder version)
	PATTERN="^qorpera-folder [^ ]+ [(]protocol [0-9]+[)]$"
	[[ $VERSION =~ $PATTERN ]] || refuse "the folder program does not run: $VERSION"
	echo "$VERSION"
	LIBRARIES=$(ldd /opt/qorpera-folder/qorpera-folder 2>&1 || true)
	[[ $LIBRARIES != *"not found"* ]] || refuse "the folder program misses libraries: $LIBRARIES"
	first fusermount3 --version
	for tool in findmnt lsblk growpart resize2fs; do command -v "$tool" >/dev/null || refuse "no $tool for the grow-root unit"; done
	# What 5e'"'"'s jobs run by path, and the tools their scripts use.
	for tool in /usr/bin/mkdir /usr/bin/rm /usr/bin/find /usr/bin/cat /bin/sh /bin/false; do
		[[ -x $tool ]] || refuse "$tool is not executable"
	done
	for tool in mkfifo cmp head mv; do command -v "$tool" >/dev/null || refuse "no $tool"; done
	for tool in gcc cc cargo rustc; do ! command -v "$tool" >/dev/null || refuse "the build'"'"'s $tool stayed"; done
	for unit in "${MASKED[@]}"; do
		[[ $(readlink "/etc/systemd/system/$unit") == /dev/null ]] || refuse "$unit is not masked"
	done
	[[ -z $(compgen -G "/etc/netplan/*.yaml" || true) ]] || refuse "the image configures a network"
	systemd-analyze verify /etc/systemd/system/qorpera-grow-root.service
	[[ $(systemctl is-enabled qorpera-grow-root.service) == enabled ]] || refuse "qorpera-grow-root.service is not enabled"
	# The executor reaches the code host only through LXD exec (test/prove-code-host-image.sh shows it without cloud-init).
	echo "lxd-agent.service: $(systemctl is-enabled lxd-agent.service 2>&1 || true)"
	for package in openssh-server snapd cloud-init; do if installed "$package"; then refuse "$package is installed"; fi; done
	if getent passwd ubuntu >/dev/null; then refuse "the ubuntu account is there"; fi
	# Nothing of this build stays: logs, keys, caches, the machine id (systemd makes one at the first boot).
	apt-get clean
	rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* /root/.cache
	rm -f /etc/ssh/ssh_host_*
	printf "uninitialized\n" >/etc/machine-id
	[[ -L /var/lib/dbus/machine-id ]] || rm -f /var/lib/dbus/machine-id
	rm -f /var/lib/systemd/credential.secret /var/lib/systemd/random-seed
	journalctl --rotate --vacuum-time=1s >/dev/null 2>&1 || true
	fstrim -v / || true
	sync
'
lx stop "$BUILDER"
# The cloud image's metadata templates (/etc/hostname, /etc/hosts, cloud-init's seed) would be written into every
# VM made from this image when LXD creates it, naming each after its instance. The image keeps none.
{ lx config metadata show "$BUILDER" | awk '/^templates:/ {skip = 1; next} /^[^ ]/ {skip = 0} !skip'; echo "templates: {}"; } |
	lx config metadata edit "$BUILDER"
lx config template list "$BUILDER" --format csv | while read -r template; do
	lx config template delete "$BUILDER" "$template" </dev/null
done
TEMPLATES=$(lx config metadata show "$BUILDER" | awk '/^templates:/ {print; skip = 1; next} /^[^ ]/ {skip = 0} skip')
[[ $TEMPLATES == "templates: {}" && -z $(lx config template list "$BUILDER" --format csv) ]] ||
	{ echo "the builder keeps metadata templates: $TEMPLATES" >&2; exit 1; }
lx publish "$BUILDER" --alias "$ALIAS" --compression zstd \
	description="Qorpera code host $STAMP (Ubuntu 26.04 minimal, git $GIT_VERSION, folder program ${FOLDER_SHA256:0:12})"
FINGERPRINT=$(lx image info "$ALIAS" | awk '/^Fingerprint:/ {print $2}')
[[ $FINGERPRINT =~ ^[0-9a-f]{64}$ ]] || { echo "no image fingerprint" >&2; exit 1; }
echo "published $FINGERPRINT (delete it by hand if this build fails from here)" >&2
# Code hosts are made from the default project's store. Export and import keep the fingerprint (copying between
# projects would need LXD to listen on the network).
if [[ $(store "$PROJECT") != default ]]; then
	mkdir "$WORK/export"
	lx image export "$FINGERPRINT" "$WORK/export/image" >/dev/null
	# One file (a published image) or two (metadata and image.root).
	shopt -s nullglob
	PARTS=("$WORK/export"/*)
	if [[ -f $WORK/export/image.root ]]; then
		(( ${#PARTS[@]} == 2 )) || { echo "unexpected export: ${PARTS[*]}" >&2; exit 1; }
		for part in "${PARTS[@]}"; do [[ $part == "$WORK/export/image.root" ]] || META=$part; done
		PARTS=("$META" "$WORK/export/image.root")
	else
		(( ${#PARTS[@]} == 1 )) || { echo "unexpected export: ${PARTS[*]}" >&2; exit 1; }
	fi
	lxc --project default image import "${PARTS[@]}" --alias "$ALIAS" >/dev/null
	rm -rf -- "$WORK/export"
	lx image delete "$FINGERPRINT" || echo "the build space still holds $FINGERPRINT: delete it by hand" >&2
fi
[[ $(lxc --project default image info "$FINGERPRINT" | awk '/^Fingerprint:/ {print $2}') == "$FINGERPRINT" ]] ||
	{ echo "the image is not in the default project's store" >&2; exit 1; }
# The bootstrap digest pins exactly what was installed: this script, the git pin, the folder program's record (the
# program is checked against it) and every file pushed.
SOURCES=()
for entry in "${FILES[@]}"; do read -r source _ _ <<<"$entry"; SOURCES+=("$HERE/$source"); done
BOOTSTRAP=$(cat "$0" "$PINS" "$RECORD" "${SOURCES[@]}" | sha256sum | cut -d' ' -f1)
jq -n --arg imageFingerprint "$FINGERPRINT" --arg bootstrapSha256 "$BOOTSTRAP" --arg alias "$ALIAS" \
	--arg git "$GIT_VERSION" --arg folderProgramSha256 "$FOLDER_SHA256" \
	'{schema: "qorpera.code-host-image-build/v1", alias: $alias, imageFingerprint: $imageFingerprint,
	  bootstrapSha256: $bootstrapSha256, git: $git, folderProgramSha256: $folderProgramSha256,
	  rootDiskBytes: 10737418240}' >&3
