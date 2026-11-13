#!/bin/bash
# The store's own small CA and the server cert it signs, as ~/work/dbhome's db-tls.sh makes them. Runs as root.
#   tls.sh ca DIR                     a new CA in DIR: ca.key (0400, root) and ca.crt; EC P-256, 10 years. DIR must
#                                     not hold one. The CA key stays in DIR, never mounted, never copied.
#   tls.sh server CA_DIR OUT NAME...  OUT/server.key, OUT/server.crt and OUT/ca.crt for every name clients dial (IPv4
#                                     or a lowercase DNS name: the primary's and the standby's, so a take-over needs
#                                     no new cert); 825 days. Run it again to renew: the same CA, so the pin stays.
# The key is root's with group postgres (999 in the pinned image) and mode 0640, which PostgreSQL takes for a key
# owned by root. Prints file names, counts and dates only.
set -euo pipefail
PG_GID=999
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

make_server() {
	local ca=${1:?server CA_DIR OUT NAME...} out=${2:?server CA_DIR OUT NAME...} n c sans=()
	shift 2
	[ $# -gt 0 ] || die "server: give every name clients dial"
	[ -s "$ca/ca.key" ] && [ -s "$ca/ca.crt" ] || die "server: no CA in $ca"
	for n in "$@"; do
		if [[ $n =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
			sans+=("IP:$n")
		elif [ ${#n} -le 253 ] && [[ $n =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$ ]]; then
			sans+=("DNS:$n")
		else
			die "server: a name is IPv4 or a lowercase DNS name"
		fi
	done
	install -d -m 0750 -o 0 -g "$PG_GID" "$out"
	c=$(mktemp)
	cnf "${sans[@]}" >"$c"
	(umask 077 && ossl "server key" genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$out/server.key.new")
	ossl "server request" req -new -config "$c" -key "$out/server.key.new" -subj "/CN=company data store" -out "$out/server.csr"
	ossl "server cert" x509 -req -in "$out/server.csr" -CA "$ca/ca.crt" -CAkey "$ca/ca.key" \
		-set_serial "0x$(openssl rand -hex 16)" -extfile "$c" -extensions server_ext -days 825 -sha256 -out "$out/server.crt.new"
	rm -f "$c" "$out/server.csr"
	openssl verify -CAfile "$ca/ca.crt" "$out/server.crt.new" >/dev/null 2>&1 || die "server: the new cert does not verify"
	chown "0:$PG_GID" "$out/server.key.new"
	chmod 0640 "$out/server.key.new"
	chmod 0644 "$out/server.crt.new"
	install -m 0644 "$ca/ca.crt" "$out/ca.crt"
	mv "$out/server.key.new" "$out/server.key"
	mv "$out/server.crt.new" "$out/server.crt"
	echo "tls: server cert made for ${#sans[@]} names, valid until $(until_date "$out/server.crt")"
}

case ${1:-} in
ca) shift && make_ca "$@" ;;
server) shift && make_server "$@" ;;
*)
	sed -n '2,9p' "$0"
	exit 2
	;;
esac
