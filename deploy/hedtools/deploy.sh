#!/usr/bin/env bash
# Deploy the hed-lsp daemon container on the hedtools host, or replace the one that runs.
#
# Usage: deploy.sh [--dry-run] [--cpus N] [--memory SIZE] [--no-read-only] IMAGE
#        deploy.sh [--dry-run] [--cpus N] [--memory SIZE] [--no-read-only] --rollback
#
# IMAGE is an image ID or a digest, never a tag, because a tag can move under a running service:
#   sha256:<64 hex digits>                  an image ID, as `docker image inspect --format '{{.Id}}'` prints it
#   <repository>@sha256:<64 hex digits>     a digest from a registry; it is pulled when it is not here yet
#
# Options:
#   --dry-run        Print every step, including the settings check and the rollback path, and change
#                    nothing. Docker is not called and no file is written, but the arguments and the env file
#                    are checked exactly as a real run checks them.
#   --rollback       Start the image whose ID is recorded in STATE_DIR/previous-image-id, in place of IMAGE.
#                    It stops with a message when there is no record. The record is written by a deploy that
#                    replaces a healthy container which runs another image.
#   --cpus N         CPU limit (default 0.5). After a vCPU increase, use half of the processors.
#   --memory SIZE    Memory limit, such as 1g (default 1g, or 3g when the env file turns semantic search on).
#                    The swap limit is set equal, so the container never uses swap.
#   --no-read-only   Leave out --read-only. For the case where the read-only root file system fails on
#                    the host; every other restriction stays.
#   -h, --help       Show this text.
#
# Environment:
#   HED_LSP_STATE_DIR  Directory of the env file, the rollback record, and the results (default
#                      ~/hed-lsp-state). The daemon reads its settings from hed-lsp.env there;
#                      deploy/hedtools/hed-lsp.env.example is the template. The file is checked without
#                      printing a value.
#
# What it does, in order:
#   1. Checks the arguments and the env file, then runs the settings through the parser of the new image
#      (a throwaway container that loads the daemon's own configuration code with the same env file and
#      overrides). A bad value stops the script here, before anything is stopped. The message names the
#      variable and the rule, never the value.
#   2. Makes the Docker network hed-lsp (subnet 172.30.56.0/24, gateway 172.30.56.1) and the volume
#      hed-lsp-cache when they are missing.
#   3. When the container hed-lsp runs, is healthy, and runs another image: writes that image's ID to
#      STATE_DIR/previous-image-id and tags it hed-lsp-daemon:previous. A container that is unhealthy or
#      missing leaves the record as it is, so a second bad image never overwrites the last good one.
#   4. Stops and removes the container hed-lsp, and starts it from the new image.
#   5. Polls its state until the Docker health check passes. It fails at once when the container restarts,
#      stops, or is unhealthy, and at the timeout. Every failure prints the state of the container and the
#      rollback command, and leaves the container in place for `docker logs hed-lsp`.
# The daemon trusts the gateway of the network as its proxy, which is the address that Apache's requests
# arrive from. The port is published on the loopback address only.
#
# Rolling back is `deploy.sh --rollback`, which goes through the same steps with the recorded image.

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
RECORD_FILE="$STATE_DIR/previous-image-id"
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/${BASH_SOURCE[0]##*/}"

# The settings check: the image's own parser, in the working directory of the image. A ConfigError names the
# variable and the rule and then, in the daemon's wording, `, got "<the value>"`; the message is cut there,
# so a value of the env file is never printed. The JavaScript holds no single quote, because the dry run
# prints it between single quotes.
PARSER_JS='try { require("./out/daemon/config.js").loadConfig(); } catch (error) { const text = String(error && error.message); const at = text.indexOf(", got \""); console.error(at < 0 ? text : text.slice(0, at)); process.exit(1); }'

DRY_RUN=0
READ_ONLY=1
ROLLBACK=0
CPUS="$DEFAULT_CPUS"
MEMORY=""
IMAGE=""
# The options that a rollback repeats. Only --no-read-only: it is a host fallback, and a rollback needs it too. The limits
# are not carried, so a rollback takes them from the settings file and never restores the limit that just failed.
CARRY=()

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
		--rollback) ROLLBACK=1 ;;
		--no-read-only)
			READ_ONLY=0
			CARRY+=(--no-read-only)
			;;
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

# The image: an ID or a digest. A tag is refused, because it can be moved to another image.
ID_RE='^sha256:[0-9a-f]{64}$'
DIGEST_RE='^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$'
if [ "$ROLLBACK" = 1 ]; then
	# The image of a rollback is the recorded one, so no image is named; a tag is refused here as well.
	[ -z "$IMAGE" ] || die "--rollback starts the image recorded in $RECORD_FILE and takes no image, got '$IMAGE' (a tag is never accepted)"
	[ -f "$RECORD_FILE" ] ||
		die "nothing to roll back to: $RECORD_FILE does not exist; it is written when a deploy replaces a healthy container that runs another image. Deploy an image ID that is known to work instead"
	IMAGE="$(tr -d '[:space:]' <"$RECORD_FILE")"
	[[ $IMAGE =~ $ID_RE ]] || die "the record $RECORD_FILE does not hold an image ID (sha256:<64 hex digits>); remove it or correct it"
else
	[ -n "$IMAGE" ] || die "an image ID or digest is required (see --help)"
	if ! [[ $IMAGE =~ $ID_RE ]] && ! [[ $IMAGE =~ $DIGEST_RE ]]; then
		die "refusing '$IMAGE': give an image ID (sha256:<64 hex digits>) or a digest (<repository>@sha256:<64 hex digits>); a tag or a short ID is not accepted"
	fi
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

# The settings check, in the groups it is printed in: the same env file and the same override as the run.
PARSE_PREFIX=(docker run --rm --network none --env-file "$ENV_FILE" -e "HED_LSP_TRUSTED_PROXIES=$GATEWAY" --entrypoint node "$IMAGE" -e)
PARSE_COMMAND=("${PARSE_PREFIX[@]}" "$PARSER_JS")

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

# rollback_command: the command that goes back to the last good image, with the options of this run.
rollback_command() {
	# The empty-array form keeps this working in bash 3.2 (macOS) under set -u.
	quote "$SCRIPT_PATH" --rollback ${CARRY[@]+"${CARRY[@]}"}
}

if [ "$DRY_RUN" = 1 ]; then
	if [ -s "$RECORD_FILE" ]; then
		RECORD_STATE="records the image $(tr -d '[:space:]' <"$RECORD_FILE")"
	else
		RECORD_STATE="does not exist yet"
	fi
	echo "Dry run: nothing below is executed, no file is written, and Docker is not called."
	if [ "$ROLLBACK" = 1 ]; then echo "Rollback: the image is the one recorded in $RECORD_FILE"; fi
	echo "Image:    $IMAGE"
	echo "Env file: $ENV_FILE ($SETTINGS settings; semantic search $SEMANTIC_WORD)"
	echo "Limits:   $CPUS CPUs, $MEMORY memory and swap$ROOT_FS"
	echo "Record:   $RECORD_FILE $RECORD_STATE"
	echo
	echo "# 1. Check the settings with the parser of the new image, before anything is stopped. The image"
	echo "#    must be on this host (a digest is pulled first). A non-zero exit stops the script; the message"
	echo "#    names the variable and the rule, never the value."
	printf '+ '
	quote "${PARSE_PREFIX[@]}"
	printf "'%s'\n" "$PARSER_JS"
	echo "# 2. The network and the volume, each only when it is missing. An existing network must have"
	echo "#    the same subnet and gateway, or the script stops."
	show docker network create --subnet "$SUBNET" --gateway "$GATEWAY" "$NETWORK"
	show docker volume create "$VOLUME"
	echo "# 3. When the container exists, is healthy, and runs another image than the new one: record that"
	echo "#    image as the rollback target. An unhealthy or missing container leaves the record as it is."
	RECORD_WRITE="printf '%s\\n' <image ID of the running container> > $RECORD_FILE"
	echo "+ $RECORD_WRITE"
	echo "+ docker tag <image ID of the running container> $PREVIOUS_TAG"
	echo "# 4. When the container exists: turn its restarts off, stop it, and remove it."
	show docker update --restart no "$NAME"
	show docker stop "$NAME"
	show docker rm "$NAME"
	echo "# 5. Start the new container."
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
	echo "# 6. Poll for up to ${HEALTH_WAIT_SECONDS} s until the Docker health check passes. Every 2 s read the state;"
	echo "#    fail at once when the container is restarting, has a restart count above 0, has stopped, or is"
	echo "#    unhealthy, and at the timeout."
	echo "+ docker container inspect --format '{{.State.Running}} {{.State.Restarting}} {{.RestartCount}} {{.State.Health.Status}}' $NAME"
	echo "# On every failure: print the state of the container and the rollback command, exit non-zero, and"
	echo "# remove nothing. The failed container stays for 'docker logs $NAME'."
	echo "# Rollback command:"
	printf '+ '
	rollback_command
	printf '\n'
	echo "#    It starts the image recorded in $RECORD_FILE through the same steps, and refuses when there is no record."
	exit 0
fi

command -v docker >/dev/null 2>&1 || die "docker is not installed or not on the PATH"

# print_state: the state of the container, without its environment.
print_state() {
	if ! docker container inspect --format 'Container {{.Name}}: status {{.State.Status}}, running {{.State.Running}}, restarting {{.State.Restarting}}, restart count {{.RestartCount}}, exit code {{.State.ExitCode}}, out of memory {{.State.OOMKilled}}, health {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$NAME" >&2 2>/dev/null; then
		echo "There is no container named $NAME." >&2
	fi
}

# fail_deploy REASON: say what is wrong, print the state of the container and the rollback command, and exit.
# Nothing is removed: the container stays, so that docker logs can say why.
fail_deploy() {
	printf 'deploy.sh: %s\n' "$*" >&2
	print_state
	if [ -s "$RECORD_FILE" ]; then
		printf 'Roll back to the last good image with: %s\n' "$(rollback_command)" >&2
	else
		printf 'Roll back with: %s (it will refuse, because no previous image is recorded in %s; deploy an image ID that is known to work instead)\n' "$(rollback_command)" "$RECORD_FILE" >&2
	fi
	printf 'The container is left in place; see: docker logs %s\n' "$NAME" >&2
	exit 1
}

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
	case "$IMAGE" in
		*@*)
			echo "Pulling $IMAGE"
			docker pull "$IMAGE" >/dev/null || die "could not pull $IMAGE"
			;;
		*) die "the image $IMAGE is not on this host; load it first with docker load (the tarballs are in $STATE_DIR/images)" ;;
	esac
fi
NEW_ID="$(docker image inspect --format '{{.Id}}' "$IMAGE")"
REVISION="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE")"
echo "Image:    $NEW_ID (built from commit ${REVISION:-unknown})"
echo "Env file: $ENV_FILE ($SETTINGS settings; semantic search $SEMANTIC_WORD)"
echo "Limits:   $CPUS CPUs, $MEMORY memory and swap$ROOT_FS"

# The settings are checked by the image that will run them, before anything is stopped: a bad value would
# otherwise be a crash loop under the restart policy, with the old container already gone.
echo "Checking the settings with the parser of the image (nothing is stopped yet)"
if ! PARSER_OUTPUT="$("${PARSE_COMMAND[@]}" 2>&1)"; then
	die "the image refuses the settings in $ENV_FILE, and nothing was stopped: $(printf '%s\n' "$PARSER_OUTPUT" | head -n 5 | tr '\n' ' ')"
fi

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
	OLD_STATE="$(docker container inspect --format '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$NAME")"
	if [ "$OLD_ID" = "$NEW_ID" ]; then
		echo "The running container already has this image; the rollback record is left as it is"
	elif [ "$OLD_STATE" = "true healthy" ]; then
		# The last good image: a healthy container, replaced by another image. Written whole, then moved.
		printf '%s\n' "$OLD_ID" >"$RECORD_FILE.tmp"
		mv "$RECORD_FILE.tmp" "$RECORD_FILE"
		docker tag "$OLD_ID" "$PREVIOUS_TAG"
		echo "Recorded the running image $OLD_ID in $RECORD_FILE and tagged it $PREVIOUS_TAG"
	else
		echo "The running container is not healthy (${OLD_STATE#* }), so the rollback record and the tag are left as they are"
	fi
	echo "Stopping $NAME (it drains for up to 8 s)"
	# A container in a restart loop cannot be stopped between two restarts: Docker answers "is not running" or "did not
	# receive an exit event". So its restart policy goes first, the restart under way is waited out, and then it is
	# stopped (a healthy one drains). If Docker still refuses, it is removed by force, which replacing it needs.
	docker update --restart no "$NAME" >/dev/null
	DEADLINE=$((SECONDS + 30))
	while [ "$(docker container inspect --format '{{.State.Restarting}}' "$NAME")" = "true" ] && [ "$SECONDS" -lt "$DEADLINE" ]; do
		sleep 0.5
	done
	if docker stop "$NAME" >/dev/null 2>&1; then
		docker rm "$NAME" >/dev/null
	else
		echo "docker stop did not stop $NAME, so it is removed by force"
		docker rm --force "$NAME" >/dev/null
	fi
fi

echo "Starting $NAME"
if ! CONTAINER_ID="$("${RUN_COMMAND[@]}")"; then
	fail_deploy "docker run failed"
fi
echo "Started ${CONTAINER_ID:0:12}"

# Poll the state, not only the health: a container that crashes under the restart policy reports running
# while it restarts, so the restart flag and the restart count are what show the loop.
DEADLINE=$((SECONDS + HEALTH_WAIT_SECONDS))
HEALTH=""
while [ "$SECONDS" -lt "$DEADLINE" ]; do
	if ! STATE="$(docker container inspect --format '{{.State.Running}} {{.State.Restarting}} {{.RestartCount}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$NAME" 2>/dev/null)"; then
		fail_deploy "the container $NAME is gone"
	fi
	read -r RUNNING RESTARTING RESTARTS HEALTH <<<"$STATE"
	if [ "$RESTARTING" = "true" ] || [ "$RESTARTS" != "0" ]; then
		fail_deploy "the container is restarting (restart count $RESTARTS), which is a crash loop"
	fi
	if [ "$RUNNING" != "true" ]; then
		fail_deploy "the container stopped"
	fi
	case "$HEALTH" in
		healthy) break ;;
		unhealthy) fail_deploy "the container is unhealthy" ;;
	esac
	sleep 2
done
[ "$HEALTH" = "healthy" ] || fail_deploy "the container is not healthy after ${HEALTH_WAIT_SECONDS} s (status '$HEALTH')"

echo "$NAME is healthy."
if command -v curl >/dev/null 2>&1; then
	curl -fsS --max-time 5 "http://127.0.0.1:$PORT/v1/health" || true
	echo
fi
