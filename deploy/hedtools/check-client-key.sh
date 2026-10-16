#!/usr/bin/env bash
# Check which address the hed-lsp daemon rate-limits by, with the behavioral spoof test of the plan.
#
# Usage:
#   check-client-key.sh direct [--url URL] [--no-docker] [--container NAME] [--network NAME]
#   check-client-key.sh proxy --url URL [--hold SECONDS]
#   check-client-key.sh other --url URL
#   options for all: [--first ADDRESS] [--second ADDRESS]
#
# The daemon limits each client by an address. A request from a trusted proxy is limited by the rightmost
# entry of its X-Forwarded-For header; any other request is limited by its own connection address. The
# gateway of the Docker network is the trusted proxy, so it must be the address that connections to the
# published port come from. Re-run direct after any Docker or kernel upgrade.
#
# direct   The daemon on the host (default http://127.0.0.1:38530). Three checks:
#          1. the gateway of the Docker network is the address the daemon trusts;
#          2. a connection held open from this host shows that gateway as its remote address in
#             /proc/net/tcp of the container;
#          3. 12 requests of 100 strings with X-Forwarded-For: --first (cost 100 units each against the
#             1000 burst) end in 429, and a 13th with X-Forwarded-For: --second passes at once.
#          Checks 1 and 2 need Docker; --no-docker runs check 3 alone.
# proxy    The daemon behind Apache (URL such as https://hedtools.org/hed-lsp). Apache removes the client's
#          X-Forwarded-For header, so a spoofed value must have no effect: 12 requests with --first end in
#          429, and a 13th with --second is limited too. With --hold SECONDS the script then keeps this
#          address at its limit, so that `other` can run from a second address in that time.
# other    Run from a second address while `proxy --hold` runs from the first, with the same URL: one
#          request, whatever X-Forwarded-For says, must pass, which shows that the limit is per real address.
#
# The addresses default to 203.0.113.1 and 203.0.113.2, from a block that is set aside for documentation
# and never routed. Wait 10 seconds between runs, so that the bucket of --first has refilled.
#
# Each check prints what it expects and what it got. The exit status is 0 when every check passes, 1 when
# one does not, and 2 for bad arguments.

set -euo pipefail

GATEWAY="172.30.56.1"
FIRST="203.0.113.1"
SECOND="203.0.113.2"
CONTAINER="hed-lsp"
NETWORK="hed-lsp"
CONTAINER_PORT="38530"
MODE=""
URL=""
USE_DOCKER=1
HOLD=0

die() {
	printf 'check-client-key.sh: %s\n' "$*" >&2
	exit 2
}

usage() {
	sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'
}

[ "$#" -ge 1 ] || {
	usage >&2
	exit 2
}
case "$1" in
	-h | --help)
		usage
		exit 0
		;;
	direct | proxy | other) MODE="$1" ;;
	*) die "the first argument is direct, proxy, or other, not '$1' (see --help)" ;;
esac
shift

while [ "$#" -gt 0 ]; do
	case "$1" in
		--no-docker) USE_DOCKER=0 ;;
		--url | --container | --network | --first | --second | --hold)
			[ "$#" -ge 2 ] || die "$1 needs a value"
			case "$1" in
				--url) URL="$2" ;;
				--container) CONTAINER="$2" ;;
				--network) NETWORK="$2" ;;
				--first) FIRST="$2" ;;
				--second) SECOND="$2" ;;
				--hold) HOLD="$2" ;;
			esac
			shift
			;;
		-h | --help)
			usage
			exit 0
			;;
		*) die "unknown argument: $1 (see --help)" ;;
	esac
	shift
done

HOLD_RE='^[0-9]+$'
[[ $HOLD =~ $HOLD_RE ]] || die "--hold must be a whole number of seconds, got '$HOLD'"
if [ "$MODE" = "direct" ] && [ -z "$URL" ]; then URL="http://127.0.0.1:$CONTAINER_PORT"; fi
[ -n "$URL" ] || die "$MODE needs --url"
URL="${URL%/}"
command -v curl >/dev/null 2>&1 || die "curl is required"

# 100 strings: the cost of a request is its number of strings, so one request costs 100 units.
STRINGS='"Red"'
for _ in $(seq 1 99); do STRINGS="$STRINGS,\"Red\""; done
BODY="{\"strings\":[$STRINGS]}"

FAILURES=0
ok() { printf 'ok    %s\n' "$1"; }
bad() {
	printf 'FAIL  %s\n' "$1"
	FAILURES=$((FAILURES + 1))
}

# status ADDRESS: the HTTP status of one request that claims to come through ADDRESS, 000 for no answer.
status() {
	curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -X POST -H 'Content-Type: application/json' \
		-H "X-Forwarded-For: $1" --data-binary "$BODY" "$URL/v1/validate" 2>/dev/null || true
}

# flood ADDRESS: 12 requests in a row; sets STATUSES to their statuses.
flood() {
	STATUSES=""
	for _ in $(seq 1 12); do
		STATUSES="$STATUSES$(status "$1") "
	done
	STATUSES="${STATUSES% }"
}

# limit_reached: pass when the first of STATUSES is 200 and the last is 429.
limit_reached() {
	if [ "${STATUSES%% *}" = "200" ] && [ "$(last_word "$STATUSES")" = "429" ]; then
		ok "the limit is reached"
	elif [ "${STATUSES%% *}" = "000" ]; then
		bad "the limit is reached (no answer from $URL)"
	else
		bad "the limit is reached (wait 10 seconds between runs, so that the bucket has refilled)"
	fi
}

# last_word WORDS: the last of the space-separated words.
last_word() {
	local words
	read -r -a words <<<"$1"
	printf '%s' "${words[${#words[@]}-1]}"
}

# decode_ip HEX: the IPv4 address of the 8 hex digits of /proc/net/tcp, which are in host byte order.
decode_ip() {
	local h="$1"
	printf '%d.%d.%d.%d' "0x${h:6:2}" "0x${h:4:2}" "0x${h:2:2}" "0x${h:0:2}"
}

check_gateway() {
	local have
	have="$(docker network inspect --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' "$NETWORK" 2>/dev/null || true)"
	echo "1. The gateway of the network $NETWORK is the address the daemon trusts"
	echo "     expected: $GATEWAY"
	echo "     got:      ${have:-no such network}"
	if [ "$have" = "$GATEWAY" ]; then ok "gateway"; else bad "gateway"; fi
}

check_peer() {
	local host port tcp peers hex address addresses=""
	echo "2. A connection from this host reaches the container from the gateway"
	echo "     expected: $GATEWAY among the remote addresses of the connections to port $CONTAINER_PORT"
	local url_re='^http://([^:/]+):([0-9]+)$'
	if ! [[ $URL =~ $url_re ]]; then
		echo "     got:      the URL $URL is not http://HOST:PORT, which this check needs"
		bad "peer address"
		return
	fi
	host="${BASH_REMATCH[1]}"
	port="${BASH_REMATCH[2]}"
	# An unfinished POST holds a connection open for the daemon's body timeout, long enough to look.
	if ! exec 3<>"/dev/tcp/$host/$port"; then
		echo "     got:      no connection to $host:$port"
		bad "peer address"
		return
	fi
	printf 'POST /v1/validate HTTP/1.1\r\nHost: %s\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{' "$host" >&3
	sleep 1
	tcp="$(docker exec "$CONTAINER" cat /proc/net/tcp 2>/dev/null || true)"
	exec 3>&-
	peers="$(printf '%s\n' "$tcp" | awk -v want="$(printf '%04X' "$CONTAINER_PORT")" \
		'NR > 1 { split($2, local, ":"); split($3, remote, ":"); if ($4 == "01" && local[2] == want) print remote[1] }')"
	for hex in $peers; do
		address="$(decode_ip "$hex")"
		addresses="$addresses $address"
	done
	echo "     got:      ${addresses:- no established connection}"
	case " $addresses " in
		*" $GATEWAY "*) ok "peer address" ;;
		*) bad "peer address" ;;
	esac
}

# Check 3 of direct: the header is honored, one key for each address in it.
check_honored() {
	local n
	echo "3. X-Forwarded-For is honored: a limit for each address in it"
	flood "$FIRST"
	echo "     12 requests of 100 strings with X-Forwarded-For: $FIRST"
	echo "       expected: the 1st is 200 and the 12th is 429"
	echo "       got:      $STATUSES"
	limit_reached
	n="$(status "$SECOND")"
	echo "     a 13th request with X-Forwarded-For: $SECOND"
	echo "       expected: 200, a client of its own"
	echo "       got:      $n"
	if [ "$n" = "200" ]; then
		ok "a different address is not limited"
	else
		bad "a different address is not limited (a 429 means every client shares one key, as when the peer is not trusted)"
	fi
}

# The proxy mode: the header is replaced by Apache, so a spoofed value changes nothing.
check_ignored() {
	local n
	echo "X-Forwarded-For has no effect behind Apache: the limit is per real address"
	flood "$FIRST"
	echo "     12 requests of 100 strings with X-Forwarded-For: $FIRST"
	echo "       expected: the 1st is 200 and the 12th is 429"
	echo "       got:      $STATUSES"
	limit_reached
	n="$(status "$SECOND")"
	echo "     a 13th request with a different X-Forwarded-For: $SECOND"
	echo "       expected: 429, because the header does not choose the key"
	echo "       got:      $n"
	if [ "$n" = "429" ]; then
		ok "a spoofed address does not escape the limit"
	else
		bad "a spoofed address does not escape the limit"
	fi
	if [ "$HOLD" -gt 0 ]; then
		echo "Holding this address at its limit for $HOLD s; run 'check-client-key.sh other --url $URL' from a second address now"
		local end=$((SECONDS + HOLD))
		while [ "$SECONDS" -lt "$end" ]; do
			status "$FIRST" >/dev/null
			sleep 0.5
		done
	fi
}

check_other() {
	local n
	echo "A second address is not limited by the first one"
	n="$(status "$FIRST")"
	echo "     one request of 100 strings with X-Forwarded-For: $FIRST"
	echo "       expected: 200, because the limit is per real address and this address has sent nothing"
	echo "       got:      $n"
	if [ "$n" = "200" ]; then
		ok "the limit is per real address"
	else
		bad "the limit is per real address (a 429 here means the two addresses share a key; was 'proxy --hold' running from the other address?)"
	fi
}

echo "check-client-key: $MODE, $URL"
case "$MODE" in
	direct)
		if [ "$USE_DOCKER" = 1 ]; then
			command -v docker >/dev/null 2>&1 || die "docker is not installed; use --no-docker for the behavioral check alone"
			check_gateway
			check_peer
		else
			echo "(checks 1 and 2 skipped: --no-docker)"
		fi
		check_honored
		;;
	proxy) check_ignored ;;
	other) check_other ;;
esac

if [ "$FAILURES" -gt 0 ]; then
	echo "$FAILURES checks failed"
	exit 1
fi
echo "all checks passed"
