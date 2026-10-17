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
#          3. requests of 100 strings with X-Forwarded-For: --first (cost 100 units each against the 1000
#             burst) are sent until the first 429, at most 40, and then 3 requests in a row with
#             X-Forwarded-For: --second must all pass.
#          Checks 1 and 2 need Docker; --no-docker runs check 3 alone.
# proxy    The daemon behind Apache (URL such as https://hedtools.org/hed-lsp). Apache removes the client's
#          X-Forwarded-For header, so a spoofed value must have no effect: requests with --first are sent
#          until the first 429, at most 40, and then 3 requests in a row with --second must include a 429.
#          With --hold SECONDS the script then keeps this address at its limit, so that `other` can run
#          from a second address in that time.
# other    Run from a second address while `proxy --hold` runs from the first, with the same URL: 3 requests
#          in a row, whatever X-Forwarded-For says, must all pass, which shows that the limit is per real
#          address.
#
# The result does not depend on how fast the requests go. A bucket refills 100 units a second, so a slow
# connection spends it later, and the number of requests before the first 429 is not fixed (about 10 on
# loopback, about 13 at 170 ms a request); that is why the requests are sent until the first 429, and why
# a check of a limited key looks at 3 requests in a row: the bucket of a limited key may have refilled
# enough for the first of them, and cannot for the next.
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

# flood ADDRESS: requests in a row until the first 429, at most FLOOD_LIMIT, or until one gets no answer;
# sets STATUSES to their statuses. How many it takes depends on how fast they go, so the count is not fixed.
FLOOD_LIMIT=40
flood() {
	local code
	STATUSES=""
	for _ in $(seq 1 "$FLOOD_LIMIT"); do
		code="$(status "$1")"
		STATUSES="$STATUSES$code "
		if [ "$code" = "429" ] || [ "$code" = "000" ]; then break; fi
	done
	STATUSES="${STATUSES% }"
}

# follow ADDRESS: FOLLOW_COUNT requests in a row, right after a flood; sets STATUSES to their statuses.
FOLLOW_COUNT=3
follow() {
	local code
	STATUSES=""
	for _ in $(seq 1 "$FOLLOW_COUNT"); do
		code="$(status "$1")"
		STATUSES="$STATUSES$code "
		if [ "$code" = "000" ]; then break; fi
	done
	STATUSES="${STATUSES% }"
}

# limit_reached: pass when the first of STATUSES is 200 and the last is 429, whatever the count between.
limit_reached() {
	local first last
	first="${STATUSES%% *}"
	last="$(last_word "$STATUSES")"
	if [ "$first" = "200" ] && [ "$last" = "429" ]; then
		ok "the limit is reached"
	elif [ "$first" = "000" ]; then
		bad "the limit is reached (no answer from $URL)"
	elif [ "$last" = "429" ]; then
		bad "the limit is reached (the first request was already refused: wait 10 seconds between runs, so that the bucket has refilled)"
	else
		bad "the limit is reached (no 429 in $FLOOD_LIMIT requests: are the rate limits raised, or does each request take about a second?)"
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

# all_are CODE: every status of STATUSES is CODE, and there are FOLLOW_COUNT of them.
all_are() {
	local words word
	read -r -a words <<<"$STATUSES"
	[ "${#words[@]}" -eq "$FOLLOW_COUNT" ] || return 1
	for word in "${words[@]}"; do
		[ "$word" = "$1" ] || return 1
	done
}

# has_status CODE: CODE is one of STATUSES.
has_status() {
	case " $STATUSES " in
		*" $1 "*) return 0 ;;
		*) return 1 ;;
	esac
}

# Check 3 of direct: the header is honored, one key for each address in it.
check_honored() {
	echo "3. X-Forwarded-For is honored: a limit for each address in it"
	flood "$FIRST"
	echo "     requests of 100 strings with X-Forwarded-For: $FIRST, until the first 429 (at most $FLOOD_LIMIT)"
	echo "       expected: 200 for the first, and a 429 within $FLOOD_LIMIT requests"
	echo "       got:      $STATUSES"
	limit_reached
	follow "$SECOND"
	echo "     $FOLLOW_COUNT requests in a row with X-Forwarded-For: $SECOND"
	echo "       expected: 200 for all, a client of its own"
	echo "       got:      $STATUSES"
	if all_are 200; then
		ok "a different address is not limited"
	else
		bad "a different address is not limited (a 429 means every client shares one key, as when the peer is not trusted)"
	fi
}

# The proxy mode: the header is replaced by Apache, so a spoofed value changes nothing.
check_ignored() {
	echo "X-Forwarded-For has no effect behind Apache: the limit is per real address"
	flood "$FIRST"
	echo "     requests of 100 strings with X-Forwarded-For: $FIRST, until the first 429 (at most $FLOOD_LIMIT)"
	echo "       expected: 200 for the first, and a 429 within $FLOOD_LIMIT requests"
	echo "       got:      $STATUSES"
	limit_reached
	follow "$SECOND"
	echo "     $FOLLOW_COUNT requests in a row with a different X-Forwarded-For: $SECOND"
	echo "       expected: a 429 among them, because the header does not choose the key"
	echo "       got:      $STATUSES"
	if has_status 429; then
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
	echo "A second address is not limited by the first one"
	follow "$FIRST"
	echo "     $FOLLOW_COUNT requests in a row of 100 strings with X-Forwarded-For: $FIRST"
	echo "       expected: 200 for all, because the limit is per real address and this address has sent nothing"
	echo "       got:      $STATUSES"
	if all_are 200; then
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
