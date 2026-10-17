#!/usr/bin/env bash
# The do-no-harm probe of a load run: watch the neighbors of the hed-lsp container on the hedtools host
# and stop the run at the first sign of harm.
#
# Usage: neighbor-probe.sh [--interval SECONDS] [--duration SECONDS] [--abort-container NAME]
#                          [--out FILE] [--tsv FILE] [--target NAME=KIND=URL]...
#
# Every --interval seconds (default 2) it asks each target for one answer and reads the memory and swap
# counters of the host. Every fifth round it also reads the state of the Docker containers. The targets
# default to the services that share the host: osa and hedit on their loopback ports, hedtools on its
# loopback port, and hedtools through Apache. KIND is `loopback` or `apache`; giving --target replaces
# the defaults, and HED_LSP_PROBE_TARGETS (space-separated NAME=KIND=URL) replaces them for a rehearsal.
# The summary says whether the targets are the defaults (targetsAreDefault), so that a run that watched
# other targets than the neighbors is never taken for one that watched them.
#
# --abort-container NAME may name only a container whose name starts with hed-lsp-, such as hed-lsp-load,
# so that the probe can never be told to kill the daemon hed-lsp or a container of another service. Any
# other name is refused at the start with exit status 2.
#
# It aborts at once, kills the container named by --abort-container (the load generator), prints the
# reason, and exits 1, on any of:
#   - a target that does not answer 200;
#   - a probe that takes over 1 second;
#   - host memory available (MemAvailable) under 1.0 GiB;
#   - sustained swap-in: pages read back from swap averaging 50 per second or more over the last 5 rounds;
#   - a container that was running at the start and has stopped, been restarted, or been killed for lack
#     of memory (an OOM kill), or that reports unhealthy.
# It prints "killed NAME" only when docker kill worked. When it did not, for instance because the container
# is already gone, it prints "could not kill NAME" and the reason from Docker, and still exits 1.
# On the way out, by --duration, SIGINT, or SIGTERM, it writes a JSON summary to --out (default standard
# output): per target the count, the p95 and the maximum in milliseconds, and the counters of the host.
# The summary is judged by scripts/check-load-report.ts: loopback targets p95 of at most 150 ms, Apache
# targets at most 300 ms, and every container healthy. Docker health counts only when it was checked:
# dockerChecked is true when Docker answered and at least one container was running at the start, and
# dockerContainers names the containers that were watched; dockerHealthy is null when it was not checked.
#
# Memory, swap, and pressure come from /proc, so on a host without it those checks are skipped and the
# summary holds null for them. --tsv FILE keeps every sample: time, target, status, milliseconds.

set -euo pipefail

INTERVAL=2
DURATION=0
ABORT_CONTAINER=""
# The only containers the probe may kill: the load generators of this deployment, never hed-lsp itself.
ABORT_CONTAINER_RE='^hed-lsp-[A-Za-z0-9][A-Za-z0-9_.-]*$'
OUT=""
TSV=""
TARGETS=()
TARGETS_ARE_DEFAULT=true

PROBE_TIMEOUT_SECONDS=3
SLOW_MS=1000
MIN_AVAILABLE_MIB=1024
SWAP_IN_PAGES_PER_SECOND=50
SWAP_WINDOW=5
DOCKER_EVERY=5

die() {
	printf 'neighbor-probe.sh: %s\n' "$*" >&2
	exit 2
}

usage() {
	sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		-h | --help)
			usage
			exit 0
			;;
		--interval | --duration | --abort-container | --out | --tsv | --target)
			[ "$#" -ge 2 ] || die "$1 needs a value"
			case "$1" in
				--interval) INTERVAL="$2" ;;
				--duration) DURATION="$2" ;;
				--abort-container)
					[[ $2 =~ $ABORT_CONTAINER_RE ]] ||
						die "--abort-container may name only a container whose name starts with hed-lsp-, such as hed-lsp-load; refusing '$2'"
					ABORT_CONTAINER="$2"
					;;
				--out) OUT="$2" ;;
				--tsv) TSV="$2" ;;
				--target)
					TARGETS+=("$2")
					TARGETS_ARE_DEFAULT=false
					;;
			esac
			shift
			;;
		*) die "unknown argument: $1 (see --help)" ;;
	esac
	shift
done

NUMBER_RE='^[0-9]+(\.[0-9]+)?$'
[[ $INTERVAL =~ $NUMBER_RE ]] || die "--interval must be a number of seconds, got '$INTERVAL'"
awk -v n="$INTERVAL" 'BEGIN { exit !(n > 0) }' || die "--interval must be above 0"
[[ $DURATION =~ $NUMBER_RE ]] || die "--duration must be a number of seconds (0 for no limit), got '$DURATION'"
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v jq >/dev/null 2>&1 || die "jq is required"

if [ "${#TARGETS[@]}" -eq 0 ]; then
	if [ -n "${HED_LSP_PROBE_TARGETS:-}" ]; then
		read -r -a TARGETS <<<"$HED_LSP_PROBE_TARGETS"
		TARGETS_ARE_DEFAULT=false
	else
		TARGETS=(
			"osa=loopback=http://127.0.0.1:38528/health"
			"hedit=loopback=http://127.0.0.1:38427/health"
			"hedtools=loopback=http://127.0.0.1:33000/hed/"
			"hedtools-apache=apache=https://hedtools.org/hed/"
		)
	fi
fi
NAMES=()
KINDS=()
URLS=()
TARGET_RE='^([A-Za-z0-9_.-]+)=(loopback|apache)=(https?://.+)$'
for target in "${TARGETS[@]}"; do
	[[ $target =~ $TARGET_RE ]] || die "a target is NAME=KIND=URL with KIND loopback or apache, got '$target'"
	NAMES+=("${BASH_REMATCH[1]}")
	KINDS+=("${BASH_REMATCH[2]}")
	URLS+=("${BASH_REMATCH[3]}")
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
for name in "${NAMES[@]}"; do : >"$WORK/$name.ms"; done
if [ -n "$TSV" ]; then : >"$TSV"; fi

ABORTED=false
REASON=""
ROUNDS=0
DOCKER_HEALTHY=true
DOCKER_CHECKED=false
MIN_AVAILABLE=""
MAX_SWAP_RATE=""
MAX_PRESSURE=""
SWAP_HISTORY=()
HAVE_PROC=false
if [ -r /proc/meminfo ] && [ -r /proc/vmstat ]; then HAVE_PROC=true; fi
HAVE_DOCKER=false
if command -v docker >/dev/null 2>&1 && docker ps >/dev/null 2>&1; then HAVE_DOCKER=true; fi

# The containers running at the start, and their restart counts. The load generator is not one of them: it
# is meant to stop.
INITIAL_NAMES=()
INITIAL_RESTARTS=()
if [ "$HAVE_DOCKER" = true ]; then
	while read -r name; do
		if [ -z "$name" ] || [ "$name" = "$ABORT_CONTAINER" ]; then continue; fi
		INITIAL_NAMES+=("$name")
		INITIAL_RESTARTS+=("$(docker inspect --format '{{.RestartCount}}' "$name")")
	done < <(docker ps --format '{{.Names}}')
fi

# p95 of the milliseconds in FILE, by the nearest-rank method, and the maximum.
percentiles() {
	sort -n "$1" | awk '{ v[NR] = $1 } END {
		if (NR == 0) { print "null null"; exit }
		rank = int(0.95 * NR); if (rank < 0.95 * NR) rank++
		if (rank < 1) rank = 1
		printf "%.1f %.1f\n", v[rank], v[NR]
	}'
}

write_summary() {
	local targets="{}" i name kind n non200 p95 max stats containers healthy
	containers="$(jq -n '$ARGS.positional' --args ${INITIAL_NAMES[@]+"${INITIAL_NAMES[@]}"})"
	# Health that was never checked is not health: it is null, not true.
	if [ "$DOCKER_HEALTHY" = false ]; then healthy=false; elif [ "$DOCKER_CHECKED" = true ]; then healthy=true; else healthy=null; fi
	for i in "${!NAMES[@]}"; do
		name="${NAMES[$i]}"
		kind="${KINDS[$i]}"
		n="$(wc -l <"$WORK/$name.ms" | tr -d ' ')"
		non200="$(cat "$WORK/$name.bad" 2>/dev/null || echo 0)"
		stats="$(percentiles "$WORK/$name.ms")"
		p95="${stats% *}"
		max="${stats#* }"
		targets="$(jq -n --argjson all "$targets" --arg name "$name" --arg kind "$kind" --argjson n "$n" \
			--argjson non200 "$non200" --argjson p95 "$p95" --argjson max "$max" \
			'$all + {($name): {kind: $kind, n: $n, p95Ms: $p95, maxMs: $max, non200: $non200}}')"
	done
	jq -n --argjson aborted "$ABORTED" --arg reason "$REASON" --argjson samples "$ROUNDS" \
		--argjson targets "$targets" --argjson healthy "$healthy" --argjson dockerChecked "$DOCKER_CHECKED" \
		--argjson containers "$containers" --argjson defaults "$TARGETS_ARE_DEFAULT" \
		--argjson available "${MIN_AVAILABLE:-null}" --argjson swap "${MAX_SWAP_RATE:-null}" \
		--argjson pressure "${MAX_PRESSURE:-null}" \
		'{tool: "hed-lsp-neighbor-probe", aborted: $aborted, reason: (if $reason == "" then null else $reason end),
		  samples: $samples, targetsAreDefault: $defaults, targets: $targets, dockerChecked: $dockerChecked,
		  dockerContainers: $containers, dockerHealthy: $healthy, hostAvailableMinMiB: $available,
		  swapInPagesPerSecMax: $swap, cpuPressureSomeAvg10Max: $pressure}' >"${OUT:-/dev/stdout}"
}

finish() {
	# A signal that arrives while the summary is written must not cut it short.
	trap '' TERM INT
	write_summary
	exit "$1"
}

abort() {
	local kill_error
	ABORTED=true
	REASON="$1"
	printf 'neighbor-probe.sh: ABORT: %s\n' "$REASON" >&2
	if [ -n "$ABORT_CONTAINER" ]; then
		# Say "killed" only when docker kill worked. A container that is gone, or a Docker that does not answer,
		# leaves the load running or already ended, and the person who reads this must know which.
		if kill_error="$(docker kill "$ABORT_CONTAINER" 2>&1 >/dev/null)"; then
			printf 'neighbor-probe.sh: killed %s\n' "$ABORT_CONTAINER" >&2
		else
			printf 'neighbor-probe.sh: could not kill %s: %s\n' "$ABORT_CONTAINER" "${kill_error:-docker gave no reason}" >&2
		fi
	fi
	finish 1
}

trap 'finish 0' TERM INT

# probe INDEX: one request to the target; aborts on a status other than 200 or a slow answer.
probe() {
	local name="${NAMES[$1]}" url="${URLS[$1]}" result code seconds ms
	result="$(curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time "$PROBE_TIMEOUT_SECONDS" "$url" 2>/dev/null || true)"
	code="${result%% *}"
	seconds="${result#* }"
	[ -n "$code" ] || code=000
	[[ $seconds =~ $NUMBER_RE ]] || seconds="$PROBE_TIMEOUT_SECONDS"
	ms="$(awk -v t="$seconds" 'BEGIN { printf "%.1f", t * 1000 }')"
	echo "$ms" >>"$WORK/$name.ms"
	if [ -n "$TSV" ]; then printf '%s\t%s\t%s\t%s\n' "$(date +%s)" "$name" "$code" "$ms" >>"$TSV"; fi
	if [ "$code" != "200" ]; then
		echo "$(($(cat "$WORK/$name.bad" 2>/dev/null || echo 0) + 1))" >"$WORK/$name.bad"
		abort "$name answered $code, not 200 ($url)"
	fi
	if awk -v ms="$ms" -v limit="$SLOW_MS" 'BEGIN { exit !(ms > limit) }'; then
		abort "$name took $ms ms, over $SLOW_MS ms ($url)"
	fi
}

check_host() {
	local available_kb available_mib pages rate first last pressure
	available_kb="$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo)"
	if [ -n "$available_kb" ]; then
		available_mib=$((available_kb / 1024))
		if [ -z "$MIN_AVAILABLE" ] || [ "$available_mib" -lt "$MIN_AVAILABLE" ]; then MIN_AVAILABLE="$available_mib"; fi
		if [ "$available_mib" -lt "$MIN_AVAILABLE_MIB" ]; then
			abort "host memory available is $available_mib MiB, under $MIN_AVAILABLE_MIB MiB"
		fi
	fi
	pages="$(awk '/^pswpin / { print $2 }' /proc/vmstat)"
	if [ -n "$pages" ]; then
		SWAP_HISTORY+=("$pages")
		if [ "${#SWAP_HISTORY[@]}" -gt "$SWAP_WINDOW" ]; then
			SWAP_HISTORY=("${SWAP_HISTORY[@]:1}")
		fi
		if [ "${#SWAP_HISTORY[@]}" -eq "$SWAP_WINDOW" ]; then
			first="${SWAP_HISTORY[0]}"
			last="${SWAP_HISTORY[$((SWAP_WINDOW - 1))]}"
			rate="$(awk -v a="$first" -v b="$last" -v rounds="$((SWAP_WINDOW - 1))" -v interval="$INTERVAL" \
				'BEGIN { printf "%.1f", (b - a) / (rounds * interval) }')"
			if [ -z "$MAX_SWAP_RATE" ] || awk -v r="$rate" -v m="$MAX_SWAP_RATE" 'BEGIN { exit !(r > m) }'; then MAX_SWAP_RATE="$rate"; fi
			if awk -v r="$rate" -v limit="$SWAP_IN_PAGES_PER_SECOND" 'BEGIN { exit !(r >= limit) }'; then
				abort "swap-in averages $rate pages per second over the last $SWAP_WINDOW rounds, at or over $SWAP_IN_PAGES_PER_SECOND"
			fi
		fi
	fi
	if [ -r /proc/pressure/cpu ]; then
		pressure="$(sed -n 's/^some .*avg10=\([0-9.]*\).*/\1/p' /proc/pressure/cpu)"
		if [ -n "$pressure" ] && { [ -z "$MAX_PRESSURE" ] || awk -v p="$pressure" -v m="$MAX_PRESSURE" 'BEGIN { exit !(p > m) }'; }; then
			MAX_PRESSURE="$pressure"
		fi
	fi
}

check_docker() {
	local i name restarts line status
	for i in "${!INITIAL_NAMES[@]}"; do
		name="${INITIAL_NAMES[$i]}"
		line="$(docker inspect --format '{{.State.Running}} {{.State.OOMKilled}} {{.RestartCount}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name" 2>/dev/null || echo 'false false 0 gone')"
		read -r running oom restarts status <<<"$line"
		if [ "$oom" = "true" ]; then
			DOCKER_HEALTHY=false
			abort "$name was killed for lack of memory (OOM)"
		fi
		if [ "$running" != "true" ]; then
			DOCKER_HEALTHY=false
			abort "$name is no longer running"
		fi
		if [ "$restarts" != "${INITIAL_RESTARTS[$i]}" ]; then
			DOCKER_HEALTHY=false
			abort "$name restarted (restart count ${INITIAL_RESTARTS[$i]} to $restarts)"
		fi
		if [ "$status" = "unhealthy" ]; then
			DOCKER_HEALTHY=false
			abort "$name reports unhealthy"
		fi
	done
	if [ "${#INITIAL_NAMES[@]}" -gt 0 ]; then DOCKER_CHECKED=true; fi
}

START=$SECONDS
while true; do
	ROUNDS=$((ROUNDS + 1))
	for i in "${!NAMES[@]}"; do probe "$i"; done
	if [ "$HAVE_PROC" = true ]; then check_host; fi
	if [ "$HAVE_DOCKER" = true ] && [ $((ROUNDS % DOCKER_EVERY)) -eq 1 ]; then check_docker; fi
	if [ "$DURATION" != "0" ] && awk -v e="$((SECONDS - START))" -v d="$DURATION" 'BEGIN { exit !(e >= d) }'; then
		break
	fi
	sleep "$INTERVAL" &
	wait $! || true
done
finish 0
