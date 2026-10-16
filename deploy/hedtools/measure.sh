#!/usr/bin/env bash
# Run the measurement sequences of the hedtools deployment against the hed-lsp container on this host.
#
# Usage: measure.sh [--dry-run] [--rehearsal SECONDS] STEP...
#
# Steps (a group runs its steps in this order, and stops at the first one that fails):
#   s0            semantic search off: s0-c1, s0-c4, s0-c8, s0-overload
#   s0-c1         concurrency 1, 60 s, suggest=65,validate=35
#   s0-c4         concurrency 4, 60 s, suggest=65,validate=35 (the S0 gate)
#   s0-c8         concurrency 8, 60 s, suggest=65,validate=35
#   s0-overload   concurrency 12, 60 s: only OVERLOADED rejections are acceptable, and recovery takes under 5 s
#   s1            semantic search on: s1-mixed, s1-capacity, s1-realistic, s1-soak
#   s1-mixed      concurrency 4, 300 s, suggest=60,validate=30,semantic=10, --semantic-top 50
#   s1-capacity   concurrency 4, 120 s, semantic only, --semantic-top 50, with the reach check
#   s1-realistic  concurrency 4, 120 s, the mixed requests with --semantic-top 10 --semantic-batch 10
#   s1-soak       concurrency 1, 30 minutes, the mixed requests with --semantic-top 50
#
# Options:
#   --dry-run             Print what would run and change nothing; Docker is not called.
#   --rehearsal SECONDS   Run every step for SECONDS instead of its time, to practice the procedure. The
#                         result files say so in their names, and they are not results.
#
# The daemon under test is the container hed-lsp. The image to measure is the one that CI printed in its
# job summary, which you record as HED_LSP_IMAGE_ID=sha256:<id> in the env file. measure.sh refuses to run
# unless that is the image of the running container, so a measurement is always of the image that was
# reviewed. The harness runs in a throwaway container of the same image, with the corpus mounted, against
# the loopback port of the daemon. For each step it writes, in ~/hed-lsp-state/results/:
#   TIME-<step>.json            the report of the load harness
#   TIME-<step>.host.json       memory, restarts, OOM kills, memory left on the host, and the neighbors
#   TIME-<step>.probe.tsv       every sample of the neighbor probe
# and prints the command that judges them: bun scripts/check-load-report.ts, which runs where Bun is
# installed, on the files copied from the host.
#
# Every step runs deploy/hedtools/neighbor-probe.sh beside the load, which stops the harness at the first
# sign of harm to the other services on the host. Run in a quiet window, after telling their owners.
#
# Environment:
#   HED_LSP_STATE_DIR         Directory of the env file and results (default ~/hed-lsp-state).
#   HED_LSP_REPO_DIR          Clone that holds server/eval/hed-examples-pairs.json (default ~/hed-lsp).
#   HED_LSP_DAEMON_URL        Where this script reaches the daemon (default http://127.0.0.1:38530).
#   HED_LSP_HARNESS_URL       Where the harness reaches it, from its own container (default HED_LSP_DAEMON_URL).
#   HED_LSP_HARNESS_NETWORK   Docker network of the harness (default host). Another network, with
#                             HED_LSP_HARNESS_URL and HED_LSP_PROBE_TARGETS, is for a rehearsal on a machine
#                             where the host network is not the machine's own, such as Docker Desktop.
#   HED_LSP_HARNESS_CPUS      CPU limit of the harness container (default 0.2).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${HED_LSP_STATE_DIR:-$HOME/hed-lsp-state}"
ENV_FILE="$STATE_DIR/hed-lsp.env"
RESULTS_DIR="$STATE_DIR/results"
REPO_DIR="${HED_LSP_REPO_DIR:-$HOME/hed-lsp}"
DAEMON_URL="${HED_LSP_DAEMON_URL:-http://127.0.0.1:38530}"
HARNESS_URL="${HED_LSP_HARNESS_URL:-$DAEMON_URL}"
HARNESS_NETWORK="${HED_LSP_HARNESS_NETWORK:-host}"
HARNESS_CPUS="${HED_LSP_HARNESS_CPUS:-0.2}"
CONTAINER="hed-lsp"
LOAD_CONTAINER="hed-lsp-load"
CLIENTS=64
SETTLE_SECONDS=20

DRY_RUN=0
REHEARSAL=""
STEPS=()

die() {
	printf 'measure.sh: %s\n' "$*" >&2
	exit 1
}

usage() {
	sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--dry-run) DRY_RUN=1 ;;
		--rehearsal)
			[ "$#" -ge 2 ] || die "--rehearsal needs a value"
			REHEARSAL="$2"
			shift
			;;
		-h | --help)
			usage
			exit 0
			;;
		-*) die "unknown option: $1 (see --help)" ;;
		s0) STEPS+=(s0-c1 s0-c4 s0-c8 s0-overload) ;;
		s1) STEPS+=(s1-mixed s1-capacity s1-realistic s1-soak) ;;
		s0-c1 | s0-c4 | s0-c8 | s0-overload | s1-mixed | s1-capacity | s1-realistic | s1-soak) STEPS+=("$1") ;;
		*) die "unknown step '$1' (see --help)" ;;
	esac
	shift
done
[ "${#STEPS[@]}" -gt 0 ] || die "name at least one step (see --help)"
if [ -n "$REHEARSAL" ]; then
	REHEARSAL_RE='^[1-9][0-9]*$'
	[[ $REHEARSAL =~ $REHEARSAL_RE ]] || die "--rehearsal must be a whole number of seconds above 0, got '$REHEARSAL'"
fi
NUMBER_RE='^[0-9]+(\.[0-9]+)?$'
[[ $HARNESS_CPUS =~ $NUMBER_RE ]] || die "HED_LSP_HARNESS_CPUS must be a number, got '$HARNESS_CPUS'"

# The image to measure: the pin in the env file. The value is read without being printed with the others.
[ -r "$ENV_FILE" ] || die "env file not found or not readable: $ENV_FILE"
IMAGE="$(sed -n 's/^HED_LSP_IMAGE_ID=//p' "$ENV_FILE" | tail -n 1 | tr -d '[:space:]')"
IMAGE_RE='^sha256:[0-9a-f]{64}$'
[[ $IMAGE =~ $IMAGE_RE ]] ||
	die "set HED_LSP_IMAGE_ID=sha256:<64 hex digits> in $ENV_FILE to the image ID that CI printed for the image under test; it is '${IMAGE:-empty}'"

# step_field STEP FIELD: the settings of a step. The fields are concurrency, seconds, mix, extra, profile,
# and semantic (off or on, the state the daemon must be in).
step_field() {
	local step="$1" field="$2" mixed="suggest=60,validate=30,semantic=10"
	case "$field:$step" in
		concurrency:s0-c1 | concurrency:s1-soak) echo 1 ;;
		concurrency:s0-c4 | concurrency:s1-*) echo 4 ;;
		concurrency:s0-c8) echo 8 ;;
		concurrency:s0-overload) echo 12 ;;
		seconds:s1-mixed) echo 300 ;;
		seconds:s1-soak) echo 1800 ;;
		seconds:s1-capacity | seconds:s1-realistic) echo 120 ;;
		seconds:s0-*) echo 60 ;;
		mix:s0-*) echo "suggest=65,validate=35" ;;
		mix:s1-capacity) echo "semantic=1" ;;
		mix:s1-*) echo "$mixed" ;;
		extra:s1-capacity) echo "--semantic-top 50 --reach-check" ;;
		extra:s1-realistic) echo "--semantic-top 10 --semantic-batch 10" ;;
		extra:s1-mixed | extra:s1-soak) echo "--semantic-top 50" ;;
		extra:s0-*) echo "" ;;
		profile:s0-c1 | profile:s0-c4 | profile:s0-c8) echo s0 ;;
		profile:*) echo "$step" ;;
		semantic:s0-*) echo off ;;
		semantic:s1-*) echo on ;;
	esac
}

# quote WORD...: the words as a shell would need them, left plain when they hold nothing special.
quote() {
	local word plain='^[A-Za-z0-9_@%+=:,./-]+$'
	for word in "$@"; do
		if [[ $word =~ $plain ]]; then printf '%s ' "$word"; else printf '%q ' "$word"; fi
	done
}

# harness_command STEP: the docker command of the load harness; its standard output is the report.
harness_command() {
	local step="$1" seconds extra
	seconds="${REHEARSAL:-$(step_field "$step" seconds)}"
	extra="$(step_field "$step" extra)"
	HARNESS=(docker run --rm --name "$LOAD_CONTAINER" --network "$HARNESS_NETWORK" --cpus "$HARNESS_CPUS" --memory 256m
		-v "$REPO_DIR/server/eval:/corpus:ro" --entrypoint node "$IMAGE" out/daemon/loadTest.js
		--url "$HARNESS_URL" --corpus /corpus/hed-examples-pairs.json
		--concurrency "$(step_field "$step" concurrency)" --duration "$seconds"
		--mix "$(step_field "$step" mix)" --clients "$CLIENTS")
	if [ -n "$extra" ]; then
		# shellcheck disable=SC2206
		HARNESS+=($extra)
	fi
}

PROBE=("$SCRIPT_DIR/neighbor-probe.sh" --abort-container "$LOAD_CONTAINER")

if [ "$DRY_RUN" = 1 ]; then
	echo "Dry run: nothing below is executed, and Docker is not called."
	echo "Image under test: $IMAGE (from HED_LSP_IMAGE_ID in $ENV_FILE)"
	echo "Before each step it checks that the container $CONTAINER runs this image, that its health is ok,"
	echo "and that semantic search is in the state the step needs."
	for step in "${STEPS[@]}"; do
		echo
		echo "# $step: profile $(step_field "$step" profile), semantic search $(step_field "$step" semantic), $(step_field "$step" concurrency) concurrent"
		harness_command "$step"
		printf '+ '
		quote "${PROBE[@]}" --out "$RESULTS_DIR/TIME-$step.neighbors.json" --tsv "$RESULTS_DIR/TIME-$step.probe.tsv"
		printf '\n+ '
		quote "${HARNESS[@]}"
		printf '> %s\n' "$RESULTS_DIR/TIME-$step.json"
		echo "# then: bun scripts/check-load-report.ts --profile $(step_field "$step" profile) TIME-$step.json"
	done
	exit 0
fi

command -v docker >/dev/null 2>&1 || die "docker is not installed or not on the PATH"
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v jq >/dev/null 2>&1 || die "jq is required"
[ -r "$REPO_DIR/server/eval/hed-examples-pairs.json" ] || die "the corpus is missing: $REPO_DIR/server/eval/hed-examples-pairs.json (HED_LSP_REPO_DIR is the clone)"
mkdir -p "$RESULTS_DIR"

# The refusal: the image of the running container must be the one the env file names.
RUNNING="$(docker container inspect --format '{{.Image}}' "$CONTAINER" 2>/dev/null || true)"
[ -n "$RUNNING" ] || die "the container $CONTAINER is not running; deploy it first with deploy.sh"
[ "$RUNNING" = "$IMAGE" ] ||
	die "the container $CONTAINER runs $RUNNING, but HED_LSP_IMAGE_ID in $ENV_FILE is $IMAGE; deploy that image, or correct the env file, and measure again"
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "the image $IMAGE is not on this host"
if docker container inspect "$LOAD_CONTAINER" >/dev/null 2>&1; then
	die "the container $LOAD_CONTAINER exists, so a run may be under way; remove it only if it is not: docker rm -f $LOAD_CONTAINER"
fi

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# to_mib TEXT: a size from `docker stats`, such as 301.2MiB or 1.5GiB, in MiB; empty when unreadable.
to_mib() {
	awk -v s="$1" 'BEGIN {
		if (match(s, /^[0-9.]+/) == 0) exit
		n = substr(s, 1, RLENGTH) + 0; unit = substr(s, RLENGTH + 1)
		f = (unit == "B") ? 1 / 1048576 : (unit == "KiB" || unit == "kB") ? 1 / 1024 : (unit == "MiB" || unit == "MB") ? 1 : (unit == "GiB" || unit == "GB") ? 1024 : 0
		if (f == 0) exit
		printf "%.1f", n * f
	}'
}

# number_or_null TEXT: TEXT when it is a number, otherwise the JSON null.
number_or_null() {
	if [[ ${1:-} =~ $NUMBER_RE ]]; then printf '%s' "$1"; else printf 'null'; fi
}

# sample_loop FILE SECONDS: every SECONDS, the memory of the container and the memory available on the host.
sample_loop() {
	local file="$1" every="$2" usage available
	: >"$file"
	while true; do
		usage="$(to_mib "$(docker stats --no-stream --format '{{.MemUsage}}' "$CONTAINER" 2>/dev/null | cut -d' ' -f1)")"
		available="-"
		if [ -r /proc/meminfo ]; then available="$(awk '/^MemAvailable:/ { printf "%d", $2 / 1024 }' /proc/meminfo)"; fi
		printf '%s\t%s\t%s\n' "$(date +%s)" "${usage:--}" "$available" >>"$file"
		sleep "$every"
	done
}

# health_field PATH: a field of /v1/health, empty when the daemon does not answer.
health_field() {
	curl -fsS --max-time 5 "$DAEMON_URL/v1/health" 2>/dev/null | jq -r "$1" 2>/dev/null || true
}

# recovery_seconds: after an overload, how long until a small request is answered again.
recovery_seconds() {
	local start="$SECONDS" body='{"strings":["Red"]}' code
	while [ $((SECONDS - start)) -lt 30 ]; do
		code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST -H 'Content-Type: application/json' --data-binary "$body" "$DAEMON_URL/v1/validate" 2>/dev/null || true)"
		if [ "$code" = "200" ]; then
			echo $((SECONDS - start))
			return
		fi
		sleep 0.25
	done
	echo 30
}

run_step() {
	local step="$1" semantic_want state base started probe_pid sample_pid code=0 recovery="" every=10
	semantic_want="$(step_field "$step" semantic)"

	if [ "$(health_field .status)" != "ok" ]; then
		die "the daemon does not answer health with status ok at $DAEMON_URL"
	fi
	state="$(health_field .semantic.state)"
	if [ "$semantic_want" = off ] && [ "$state" != "disabled" ]; then
		die "$step needs semantic search off, but the daemon reports '$state'; set HED_LSP_SEMANTIC=0 in the env file and run deploy.sh again"
	fi
	if [ "$semantic_want" = on ] && [ "$state" != "ready" ]; then
		die "$step needs semantic search ready, but the daemon reports '$state'"
	fi
	[ "$(docker container inspect --format '{{.Image}}' "$CONTAINER")" = "$IMAGE" ] || die "the image of $CONTAINER changed"

	started="$(date -u +%Y%m%dT%H%M%SZ)"
	base="$RESULTS_DIR/$started-$step${REHEARSAL:+-rehearsal}"
	harness_command "$step"
	[ -z "$REHEARSAL" ] || every=2
	echo "== $step: ${REHEARSAL:-$(step_field "$step" seconds)} s, $(step_field "$step" concurrency) concurrent, results in $base.*"

	# The probe first, and the load only once the probe has taken its first round.
	"${PROBE[@]}" --out "$base.neighbors.json" --tsv "$base.probe.tsv" &
	probe_pid=$!
	local waited=0
	while [ "$({ wc -l <"$base.probe.tsv"; } 2>/dev/null || echo 0)" -lt 1 ] && kill -0 "$probe_pid" 2>/dev/null && [ "$waited" -lt 30 ]; do
		sleep 1
		waited=$((waited + 1))
	done
	if ! kill -0 "$probe_pid" 2>/dev/null; then
		wait "$probe_pid" || true
		die "the neighbor probe stopped before the load started: $(jq -r '.reason // "no reason"' "$base.neighbors.json" 2>/dev/null)"
	fi
	sample_loop "$base.samples.tsv" "$every" &
	sample_pid=$!

	"${HARNESS[@]}" >"$base.json" || code=$?
	if [ "$step" = "s0-overload" ]; then recovery="$(recovery_seconds)"; fi

	kill -TERM "$probe_pid" "$sample_pid" 2>/dev/null || true
	local probe_status=0
	wait "$probe_pid" || probe_status=$?
	wait "$sample_pid" 2>/dev/null || true
	# The probe writes its summary on SIGTERM, and a breach before that has already aborted it.
	[ -s "$base.neighbors.json" ] || echo '{"aborted":true,"reason":"the probe wrote no summary"}' >"$base.neighbors.json"

	finish_step "$step" "$base" "$recovery" "$code" "$probe_status"
}

# finish_step STEP BASE RECOVERY HARNESS_STATUS PROBE_STATUS: write the host file and say what to do next.
finish_step() {
	local step="$1" base="$2" recovery="$3" harness_status="$4" probe_status="$5"
	local peak at5 end available first oom restarts health
	peak="$(awk -F'\t' '$2 != "-" && $2 + 0 > m { m = $2 + 0 } END { if (NR > 0 && m > 0) printf "%.1f", m }' "$base.samples.tsv")"
	first="$(head -n 1 "$base.samples.tsv" | cut -f1)"
	at5="$(awk -F'\t' -v first="$first" '$2 != "-" && $1 - first >= 300 { printf "%.1f", $2; exit }' "$base.samples.tsv")"
	end="$(awk -F'\t' '$2 != "-" { v = $2 } END { if (v != "") printf "%.1f", v }' "$base.samples.tsv")"
	available="$(awk -F'\t' '$3 != "-" && (m == "" || $3 + 0 < m) { m = $3 + 0 } END { if (m != "") printf "%d", m }' "$base.samples.tsv")"
	oom="$(docker container inspect --format '{{.State.OOMKilled}}' "$CONTAINER" 2>/dev/null || echo true)"
	restarts="$(docker container inspect --format '{{.RestartCount}}' "$CONTAINER" 2>/dev/null || echo -1)"
	health="$(docker container inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null || echo gone)"
	jq -n --arg step "$step" --argjson rehearsal "$([ -n "$REHEARSAL" ] && echo true || echo false)" --arg image "$IMAGE" \
		--arg envSha "$(sha256_of "$ENV_FILE")" --arg commit "$(health_field .commit)" \
		--argjson cpus "$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo null)" \
		--argjson peak "$(number_or_null "$peak")" --argjson at5 "$(number_or_null "$at5")" --argjson end "$(number_or_null "$end")" \
		--argjson oom "$oom" --argjson restarts "$restarts" --arg health "$health" \
		--argjson available "$(number_or_null "$available")" --argjson recovery "$(number_or_null "$recovery")" \
		--argjson harnessStatus "$harness_status" --argjson probeStatus "$probe_status" --slurpfile neighbors "$base.neighbors.json" \
		'{tool: "hed-lsp-measure-host", step: $step, rehearsal: $rehearsal, image: $image, commit: $commit, envSha256: $envSha,
		  hostProcessors: $cpus, harnessExitStatus: $harnessStatus, probeExitStatus: $probeStatus,
		  container: {memoryPeakMiB: $peak, memoryAtMinute5MiB: $at5, memoryAtEndMiB: $end, oomKilled: $oom,
		              restartCount: $restarts, health: $health},
		  hostAvailableMinMiB: $available, recoverySeconds: $recovery, neighbors: $neighbors[0]}' >"$base.host.json"
	rm -f "$base.neighbors.json"

	if [ "$probe_status" != 0 ]; then
		die "$step ABORTED by the neighbor probe: $(jq -r '.neighbors.reason // "no reason"' "$base.host.json"). The load was stopped; the other services come first."
	fi
	if [ "$harness_status" != 0 ] || ! jq -e '.tool == "hed-lsp-daemon-load-test"' "$base.json" >/dev/null 2>&1; then
		die "$step: the harness failed with status $harness_status or wrote no report ($base.json)"
	fi
	echo "   done: $(jq -r '"\(.overall.requests) requests, error rate \(.overall.errorRate), p95 \(.overall.latencyMs.p95) ms"' "$base.json")"
	echo "   judge on a machine with Bun:  bun scripts/check-load-report.ts --profile $(step_field "$step" profile) $(basename "$base").json"
}

for index in "${!STEPS[@]}"; do
	if [ "$index" -gt 0 ]; then
		# Let the queues of the daemon and the load on the host settle between steps.
		if [ -n "$REHEARSAL" ]; then sleep 1; else sleep "$SETTLE_SECONDS"; fi
	fi
	run_step "${STEPS[$index]}"
done
echo "All steps finished. Copy the files in $RESULTS_DIR to a machine with Bun and judge them."
