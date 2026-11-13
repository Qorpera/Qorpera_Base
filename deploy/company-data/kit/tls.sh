#!/bin/bash
# The store's own small CA and the server cert it signs, as ~/work/dbhome's db-tls.sh makes them. Runs as root.
#   tls.sh ca DIR                     a new CA in DIR: ca.key (0400, root) and ca.crt; EC P-256, 10 years. DIR must
#                                     not hold one. The CA key stays in DIR, never mounted, never copied.
#   tls.sh server CA_DIR OUT NAME...  OUT/server.key, OUT/server.crt and OUT/ca.crt for every name clients dial (IPv4
#                                     or a lowercase DNS name: the primary's and the standby's, so a take-over needs
#                                     no new cert); 825 days. Run it again to renew: the same CA, so the pin stays.
#   tls.sh door CA_DIR OUT NAME...    OUT/door.key and OUT/door.crt for the gateway's run door (README.md, "The run
#                                     door"): the names the nodes' provider hosts dial; 825 days, the same CA.
# The server's key is root's with group postgres (999 in the pinned image) and mode 0640, which PostgreSQL takes for a
# key owned by root. The run door's key is the gateway's user's (65534), 0400. Prints file names, counts and dates only.
set -euo pipefail
PG_GID=999
NOBODY=65534
die() {
	echo "tls: $*" >&2
	exit 1
}
[ "$(id -u)" = 0 ] || die "run as root"
command -v openssl >/dev/null || die "no openssl"

# An openssl config; the arguments are the server's names as DNS:x or IP:x.
cnf() {
	local n d=0 i=0
	printf '%s\n' '[req]' 'distinguished_name = dn' 'prompt = no' '[dn]' 'CN = company data store' \
		'[ca_ext]' 'basicConstraints = critical, CA:TRUE, pathlen:0' 'keyUsage = critical, keyCertSign, cRLSign' \
		'subjectKeyIdentifier = hash' \
		'[server_ext]' 'basicConstraints = critical, CA:FALSE' 'keyUsage = critical, digitalSignature' \
		'extendedKeyUsage = serverAuth' 'subjectKeyIdentifier = hash' 'authorityKeyIdentifier = keyid:always' \
		'subjectAltName = @alt' '[alt]'
	for n in "$@"; do
		case $n in
		DNS:*) d=$((d + 1)) && echo "DNS.$d = ${n#DNS:}" ;;
		IP:*) i=$((i + 1)) && echo "IP.$i = ${n#IP:}" ;;
		esac
	done
}
ossl() {
	local step=$1 e
	shift
	e=$(mktemp)
	if ! openssl "$@" >/dev/null 2>"$e"; then
		cat "$e" >&2
		rm -f "$e"
		die "$step: openssl failed"
	fi
	rm -f "$e"
}
until_date() { openssl x509 -in "$1" -noout -enddate | cut -d= -f2; }

make_ca() {
	local dir=${1:?ca DIR} c
	[ ! -e "$dir/ca.key" ] && [ ! -e "$dir/ca.crt" ] || die "ca: $dir holds a CA already"
	install -d -m 0700 "$dir"
	c=$(mktemp)
	cnf >"$c"
	(umask 077 && ossl ca req -x509 -new -config "$c" -extensions ca_ext -subj "/CN=company data store CA" \
		-newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -sha256 -days 3650 -keyout "$dir/ca.key" -out "$dir/ca.crt")
	rm -f "$c"
	chmod 0400 "$dir/ca.key"
	chmod 0644 "$dir/ca.crt"
	echo "tls: CA made, valid until $(until_date "$dir/ca.crt")"
}

# make_cert KIND CA_DIR OUT NAME...: KIND server (OUT/server.*, for PostgreSQL) or door (OUT/door.*, for the run door).
make_cert() {
	local kind=$1 ca=${2:?$1 CA_DIR OUT NAME...} out=${3:?$1 CA_DIR OUT NAME...} n c sans=() base
	shift 3
	base=$out/$kind
	[ $# -gt 0 ] || die "$kind: give every name clients dial"
	[ -s "$ca/ca.key" ] && [ -s "$ca/ca.crt" ] || die "$kind: no CA in $ca"
	for n in "$@"; do
		if [[ $n =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
			sans+=("IP:$n")
		elif [ ${#n} -le 253 ] && [[ $n =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$ ]]; then
			sans+=("DNS:$n")
		else
			die "$kind: a name is IPv4 or a lowercase DNS name"
		fi
	done
	if [ "$kind" = server ]; then
		install -d -m 0750 -o 0 -g "$PG_GID" "$out"
	else
		install -d -m 0500 -o "$NOBODY" -g "$NOBODY" "$out"
	fi
	c=$(mktemp)
	cnf "${sans[@]}" >"$c"
	(umask 077 && ossl "$kind key" genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$base.key.new")
	ossl "$kind request" req -new -config "$c" -key "$base.key.new" -subj "/CN=company data store" -out "$base.csr"
	ossl "$kind cert" x509 -req -in "$base.csr" -CA "$ca/ca.crt" -CAkey "$ca/ca.key" \
		-set_serial "0x$(openssl rand -hex 16)" -extfile "$c" -extensions server_ext -days 825 -sha256 -out "$base.crt.new"
	rm -f "$c" "$base.csr"
	openssl verify -CAfile "$ca/ca.crt" "$base.crt.new" >/dev/null 2>&1 || die "$kind: the new cert does not verify"
	if [ "$kind" = server ]; then
		chown "0:$PG_GID" "$base.key.new"
		chmod 0640 "$base.key.new"
		chmod 0644 "$base.crt.new"
		install -m 0644 "$ca/ca.crt" "$out/ca.crt"
	else
		chown "$NOBODY:$NOBODY" "$base.key.new" "$base.crt.new"
		chmod 0400 "$base.key.new"
		chmod 0444 "$base.crt.new"
	fi
	mv "$base.key.new" "$base.key"
	mv "$base.crt.new" "$base.crt"
	echo "tls: $kind cert made for ${#sans[@]} names, valid until $(until_date "$base.crt")"
}

case ${1:-} in
ca) shift && make_ca "$@" ;;
server | door) make_cert "$@" ;;
*)
	sed -n '2,11p' "$0"
	exit 2
	;;
esac
