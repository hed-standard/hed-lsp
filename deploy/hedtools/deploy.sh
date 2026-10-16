#!/usr/bin/env bash
# Deploy the hed-lsp daemon container on the hedtools host, or replace the one that runs.
#
# Usage: deploy.sh [--dry-run] [--cpus N] [--memory SIZE] [--no-read-only] IMAGE
#
# IMAGE is an image ID or a digest, never a tag, because a tag can move under a running service:
#   sha256:<64 hex digits>                  an image ID, as `docker image inspect --format '{{.Id}}'` prints it
#   <repository>@sha256:<64 hex digits>     a digest from a registry; it is pulled when it is not here yet
#
# Options:
#   --dry-run        Print the commands that would run and change nothing. Docker is not called, but the
#                    arguments and the env file are checked exactly as a real run checks them.
#   --cpus N         CPU limit (default 0.5). After a vCPU increase, use half of the processors.
#   --memory SIZE    Memory limit, such as 1g (default 1g, or 3g when the env file turns semantic search on).
#                    The swap limit is set equal, so the container never uses swap.
#   --no-read-only   Leave out --read-only. For the case where the read-only root file system fails on
#                    the host; every other restriction stays.
#   -h, --help       Show this text.
#
# Environment:
#   HED_LSP_STATE_DIR  Directory of the env file and the results (default ~/hed-lsp-state). The daemon
#                      reads its settings from hed-lsp.env there; deploy/hedtools/hed-lsp.env.example is
#                      the template. The file is checked without printing a value.
#
# What it does, in order: checks the arguments and the env file; makes the Docker network hed-lsp
# (subnet 172.30.56.0/24, gateway 172.30.56.1) and the volume hed-lsp-cache when they are missing; tags
# the image of the running container as hed-lsp-daemon:previous when it differs from the new one; stops and
# removes the container hed-lsp; starts it from IMAGE; and waits for its Docker health check to pass.
# The daemon trusts the gateway of the network as its proxy, which is the address that Apache's requests
# arrive from. The port is published on the loopback address only.
#
# Rolling back is running this script again with the previous image ID.

set -euo pipefail

NAME="hed-lsp"
NETWORK="hed-lsp"
SUBNET="172.30.56.0/24"
GATEWAY="172.30.56.1"
VOLUME="hed-lsp-cache"
PORT="38530"
PREVIOUS_TAG="hed-lsp-daemon:previous"
DEFAULT_CPUS="0.5"
HEALTH_WAIT_SECONDS=180

STATE_DIR="${HED_LSP_STATE_DIR:-$HOME/hed-lsp-state}"
ENV_FILE="$STATE_DIR/hed-lsp.env"

DRY_RUN=0
READ_ONLY=1
CPUS="$DEFAULT_CPUS"
MEMORY=""
IMAGE=""

die() {
	printf 'deploy.sh: %s\n' "$*" >&2
	exit 1
}

usage() {
	sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--dry-run) DRY_RUN=1 ;;
		--no-read-only) READ_ONLY=0 ;;
		--cpus | --memory)
			[ "$#" -ge 2 ] || die "$1 needs a value"
			if [ "$1" = "--cpus" ]; then CPUS="$2"; else MEMORY="$2"; fi
			shift
			;;
		-h | --help)
			usage
			exit 0
			;;
		-*) die "unknown option: $1 (see --help)" ;;
		*)
			[ -z "$IMAGE" ] || die "one image only, got a second argument: $1"
			IMAGE="$1"
			;;
	esac
	shift
done

[ -n "$IMAGE" ] || die "an image ID or digest is required (see --help)"

# The image: an ID or a digest. A tag is refused, because it can be moved to another image.
ID_RE='^sha256:[0-9a-f]{64}$'
DIGEST_RE='^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$'
if ! [[ $IMAGE =~ $ID_RE ]] && ! [[ $IMAGE =~ $DIGEST_RE ]]; then
	die "refusing '$IMAGE': give an image ID (sha256:<64 hex digits>) or a digest (<repository>@sha256:<64 hex digits>); a tag or a short ID is not accepted"
fi

CPUS_RE='^[0-9]+(\.[0-9]+)?$'
[[ $CPUS =~ $CPUS_RE ]] || die "--cpus must be a number such as 0.5, got '$CPUS'"
awk -v cpus="$CPUS" 'BEGIN { exit !(cpus > 0) }' || die "--cpus must be above 0, got '$CPUS'"

# The env file: HED_LSP_NAME=value lines, comments, and blank lines. Nothing in it is printed, because a
# value could be sensitive; an error names a line number or a variable, never a value.
[ -f "$ENV_FILE" ] || die "env file not found: $ENV_FILE (copy deploy/hedtools/hed-lsp.env.example there)"
[ -r "$ENV_FILE" ] || die "env file is not readable: $ENV_FILE"
if LC_ALL=C grep -q $'\r' "$ENV_FILE"; then
	die "env file has carriage returns (Windows line endings): $ENV_FILE"
fi
BAD_LINES="$({ grep -n -v -E '^(HED_LSP_[A-Z0-9_]+=.*|[[:space:]]*#.*|[[:space:]]*)$' "$ENV_FILE" || true; } | cut -d: -f1 | tr '\n' ' ')"
[ -z "$BAD_LINES" ] || die "env file lines that are not HED_LSP_NAME=value, a comment, or blank: line(s) ${BAD_LINES% }"
FORBIDDEN="$({ grep -o -E '^HED_LSP_(HOST|PORT|TRUSTED_PROXIES)=' "$ENV_FILE" || true; } | tr -d '=' | sort -u | tr '\n' ' ')"
[ -z "$FORBIDDEN" ] || die "env file sets ${FORBIDDEN% }, which this script and the image fix (port $PORT, trusted proxy $GATEWAY); remove the line"

SEMANTIC_VALUE="$(sed -n 's/^HED_LSP_SEMANTIC=//p' "$ENV_FILE" | tail -n 1 | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
case "$SEMANTIC_VALUE" in
	1 | true) SEMANTIC=1 ;;
	*) SEMANTIC=0 ;;
esac
if [ -z "$MEMORY" ]; then
	if [ "$SEMANTIC" = 1 ]; then MEMORY="3g"; else MEMORY="1g"; fi
fi
MEMORY_RE='^[1-9][0-9]*[mg]$'
[[ $MEMORY =~ $MEMORY_RE ]] || die "--memory must be a whole number of m or g, such as 1g or 512m, got '$MEMORY'"
SETTINGS="$(grep -c -E '^HED_LSP_[A-Z0-9_]+=' "$ENV_FILE" || true)"
if [ "$SEMANTIC" = 1 ]; then SEMANTIC_WORD="on"; else SEMANTIC_WORD="off"; fi
if [ "$READ_ONLY" = 1 ]; then ROOT_FS=""; else ROOT_FS=", writable root file system"; fi

# The run command, in the groups it is printed in.
RUN_IDENTITY=(docker run -d --name "$NAME" --restart unless-stopped --network "$NETWORK")
RUN_PORT=(-p "127.0.0.1:$PORT:$PORT" --stop-timeout 15)
RUN_LIMITS=(--cpus "$CPUS" --cpu-shares 512 --memory "$MEMORY" --memory-swap "$MEMORY" --pids-limit 256)
RUN_SECURITY=()
if [ "$READ_ONLY" = 1 ]; then RUN_SECURITY+=(--read-only); fi
RUN_SECURITY+=(--tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges)
RUN_STORAGE=(-v "$VOLUME:/home/node/.cache")
RUN_LOGS=(--log-opt max-size=20m --log-opt max-file=5)
RUN_ENV=(--env-file "$ENV_FILE" -e "HED_LSP_TRUSTED_PROXIES=$GATEWAY")
RUN_IMAGE=("$IMAGE")
RUN_COMMAND=(
	"${RUN_IDENTITY[@]}" "${RUN_PORT[@]}" "${RUN_LIMITS[@]}" "${RUN_SECURITY[@]}"
	"${RUN_STORAGE[@]}" "${RUN_LOGS[@]}" "${RUN_ENV[@]}" "${RUN_IMAGE[@]}"
)

# quote WORD...: the words as a shell would need them, each followed by a space.
quote() {
	local word
	for word in "$@"; do printf '%q ' "$word"; done
}

# show WORD...: one command on one line.
show() {
	printf '+ '
	quote "$@"
	printf '\n'
}

if [ "$DRY_RUN" = 1 ]; then
	echo "Dry run: nothing below is executed, and Docker is not called."
	echo "Image:    $IMAGE"
	echo "Env file: $ENV_FILE ($SETTINGS settings; semantic search $SEMANTIC_WORD)"
	echo "Limits:   $CPUS CPUs, $MEMORY memory and swap$ROOT_FS"
	echo
	echo "# 1. The network and the volume, each only when it is missing. An existing network must have"
	echo "#    the same subnet and gateway, or the script stops."
	show docker network create --subnet "$SUBNET" --gateway "$GATEWAY" "$NETWORK"
	show docker volume create "$VOLUME"
	echo "# 2. When the container exists: keep its image as the rollback target, drain it, and remove it."
	echo "#    The tag is made only when the running image differs from the new one."
	echo "+ docker tag <image ID of the running container> $PREVIOUS_TAG"
	show docker stop "$NAME"
	show docker rm "$NAME"
	echo "# 3. Start the new container."
	printf '+ '
	quote "${RUN_IDENTITY[@]}"
	printf '\\\n  '
	quote "${RUN_PORT[@]}"
	printf '\\\n  '
	quote "${RUN_LIMITS[@]}"
	printf '\\\n  '
	quote "${RUN_SECURITY[@]}"
	printf '\\\n  '
	quote "${RUN_STORAGE[@]}"
	printf '\\\n  '
	quote "${RUN_LOGS[@]}"
	printf '\\\n  '
	quote "${RUN_ENV[@]}"
	printf '\\\n  '
	quote "${RUN_IMAGE[@]}"
	printf '\n'
	echo "# 4. Wait up to ${HEALTH_WAIT_SECONDS} s for its Docker health check to pass."
	echo "+ docker container inspect --format '{{.State.Health.Status}}' $NAME"
	exit 0
fi

command -v docker >/dev/null 2>&1 || die "docker is not installed or not on the PATH"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
	case "$IMAGE" in
		*@*)
			echo "Pulling $IMAGE"
			docker pull "$IMAGE" >/dev/null || die "could not pull $IMAGE"
			;;
		*) die "the image $IMAGE is not on this host; load it first with docker load" ;;
	esac
fi
NEW_ID="$(docker image inspect --format '{{.Id}}' "$IMAGE")"
REVISION="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE")"
echo "Image:    $NEW_ID (built from commit ${REVISION:-unknown})"
echo "Env file: $ENV_FILE ($SETTINGS settings; semantic search $SEMANTIC_WORD)"
echo "Limits:   $CPUS CPUs, $MEMORY memory and swap$ROOT_FS"

# The network is made once and checked every time, because the daemon trusts its gateway address.
if docker network inspect "$NETWORK" >/dev/null 2>&1; then
	HAVE="$(docker network inspect --format '{{range .IPAM.Config}}{{.Subnet}} {{.Gateway}};{{end}}' "$NETWORK")"
	[ "$HAVE" = "$SUBNET $GATEWAY;" ] ||
		die "the network $NETWORK exists with the addressing '$HAVE', not '$SUBNET $GATEWAY;'; the daemon trusts $GATEWAY, so stop the containers on it and remove the network"
else
	echo "Creating the network $NETWORK"
	docker network create --subnet "$SUBNET" --gateway "$GATEWAY" "$NETWORK" >/dev/null
fi
if ! docker volume inspect "$VOLUME" >/dev/null 2>&1; then
	echo "Creating the volume $VOLUME"
	docker volume create "$VOLUME" >/dev/null
fi

if docker container inspect "$NAME" >/dev/null 2>&1; then
	OLD_ID="$(docker container inspect --format '{{.Image}}' "$NAME")"
	if [ "$OLD_ID" != "$NEW_ID" ]; then
		docker tag "$OLD_ID" "$PREVIOUS_TAG"
		echo "Tagged the running image $OLD_ID as $PREVIOUS_TAG"
	fi
	echo "Stopping $NAME (it drains for up to 8 s)"
	docker stop "$NAME" >/dev/null
	docker rm "$NAME" >/dev/null
fi

echo "Starting $NAME"
if ! CONTAINER_ID="$("${RUN_COMMAND[@]}")"; then
	# A container that was created and could not start, such as one whose port is taken, would stay behind.
	docker rm -f "$NAME" >/dev/null 2>&1 || true
	die "docker run failed and no container is running; roll back with: $0 <previous image ID> (the last image is tagged $PREVIOUS_TAG)"
fi
echo "Started ${CONTAINER_ID:0:12}"

DEADLINE=$((SECONDS + HEALTH_WAIT_SECONDS))
HEALTH=""
while [ "$SECONDS" -lt "$DEADLINE" ]; do
	if [ "$(docker container inspect --format '{{.State.Running}}' "$NAME")" != "true" ]; then
		die "the container stopped; see: docker logs $NAME"
	fi
	HEALTH="$(docker container inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$NAME")"
	case "$HEALTH" in
		healthy) break ;;
		unhealthy) die "the container is unhealthy; see: docker logs $NAME" ;;
	esac
	sleep 2
done
[ "$HEALTH" = "healthy" ] || die "the container is not healthy after ${HEALTH_WAIT_SECONDS} s (status '$HEALTH'); see: docker logs $NAME"

echo "$NAME is healthy."
if command -v curl >/dev/null 2>&1; then
	curl -fsS --max-time 5 "http://127.0.0.1:$PORT/v1/health" || true
	echo
fi
