#!/usr/bin/env bash
# Smoke test for a running hed-lsp daemon, such as the container image. It uses only curl and node.
#
# Usage: scripts/daemon-smoke.sh [--offline]
#
# Environment:
#   HED_LSP_DAEMON_URL        Base URL of the daemon (default http://127.0.0.1:38530).
#   HED_LSP_DAEMON_CONTAINER  Name of the container the daemon runs in. The check that dataDir()
#                             resolves to /app/server/data then runs there, through `docker exec`.
#                             Leave it unset when this script runs inside the container itself,
#                             from /app/server, where the check runs directly.
#   HED_LSP_EXPECTED_COMMIT   When set, the commit in /v1/health must equal it.
#   HED_LSP_SMOKE_WAIT_SECONDS  How long to wait for the daemon to answer (default 120).
#
# The checks: health answers 200 with a status of ok or degraded; /v1/schemas lists the default
# allowlist; validate tells a valid string from an invalid one; suggest returns tags; a body over
# the limit gets 413; an unknown field gets 400; and dataDir() is where the image puts the data.
#
# --offline expects a daemon with no network, such as one run with `docker run --network none`, where
# the container publishes no port: copy this script into the container and run it there with
# `docker exec`. The daemon must then be degraded: the default schema 8.5.0, which the validator does
# not bundle, is served by the bundled 8.4.0; 8.5.0 with the libraries, which has no bundled form, is
# refused as SCHEMA_UNAVAILABLE; and 8.4.0, with or without the libraries, loads from the bundled files.
#
# The slim image has no curl, so without curl the requests go through node. Exit status 0 means
# every check passed.

set -uo pipefail

URL="${HED_LSP_DAEMON_URL:-http://127.0.0.1:38530}"
URL="${URL%/}"
CONTAINER="${HED_LSP_DAEMON_CONTAINER:-}"
WAIT_SECONDS="${HED_LSP_SMOKE_WAIT_SECONDS:-120}"
EXPECTED_DATA_DIR="/app/server/data"
OFFLINE=0

# The allowlist the daemon ships with, and the default schema.
DEFAULT_SCHEMA="8.5.0"
LIBRARIES="sc:score_2.1.0,la:lang_1.1.0"
ALLOWLIST=("8.5.0" "8.5.0,${LIBRARIES}" "8.4.0" "8.4.0,${LIBRARIES}" "8.3.0")

for arg in "$@"; do
	case "$arg" in
		--offline) OFFLINE=1 ;;
		-h | --help)
			sed -n '2,/^set -uo/p' "$0" | sed '$d; s/^# \{0,1\}//'
			exit 0
			;;
		*)
			echo "unknown option: $arg" >&2
			exit 2
			;;
	esac
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BODY="$TMP/body"
STATUS=""
CHECKS=0
FAILURES=0

pass() {
	CHECKS=$((CHECKS + 1))
	printf 'ok   %s\n' "$1"
}

fail() {
	CHECKS=$((CHECKS + 1))
	FAILURES=$((FAILURES + 1))
	printf 'FAIL %s\n' "$1" >&2
	if [ -s "$BODY" ]; then
		printf '     status %s, body: %s\n' "$STATUS" "$(head -c 400 "$BODY")" >&2
	fi
}

# request METHOD PATH [BODY_FILE]: sets STATUS to the HTTP status (000 when there is no answer) and
# leaves the answer in $BODY. Uses curl when there is one, and node otherwise.
request() {
	local method="$1" path="$2" file="${3:-}"
	: >"$BODY"
	if command -v curl >/dev/null 2>&1; then
		local args=(-sS -o "$BODY" -w '%{http_code}' --max-time 30 -X "$method" -H 'Expect:')
		if [ -n "$file" ]; then
			args+=(-H 'Content-Type: application/json' --data-binary "@$file")
		fi
		STATUS="$(curl "${args[@]}" "$URL$path" 2>/dev/null)" || STATUS="000"
	else
		STATUS="$(
			node -e '
				const http = require("node:http");
				const fs = require("node:fs");
				const [method, url, file, out] = process.argv.slice(1);
				const body = file ? fs.readFileSync(file) : undefined;
				const headers = body ? { "Content-Type": "application/json", "Content-Length": body.length } : {};
				const req = http.request(url, { method, headers, timeout: 30000 }, (res) => {
					const chunks = [];
					res.on("data", (chunk) => chunks.push(chunk));
					res.on("end", () => {
						fs.writeFileSync(out, Buffer.concat(chunks));
						process.stdout.write(String(res.statusCode));
					});
				});
				req.on("timeout", () => req.destroy(new Error("timed out")));
				req.on("error", () => process.exit(1));
				if (body) req.write(body);
				req.end();
			' "$method" "$URL$path" "$file" "$BODY" 2>/dev/null
		)" || STATUS="000"
	fi
}

# check_json DESCRIPTION EXPRESSION: passes when the JavaScript EXPRESSION, in which `j` is the last
# answer parsed as JSON, is true.
check_json() {
	if node -e '
		const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
		process.exit(eval(process.argv[2]) ? 0 : 1);
	' "$BODY" "$2" 2>/dev/null; then
		pass "$1"
	else
		fail "$1"
	fi
}

# check_answer DESCRIPTION STATUS EXPRESSION: the last answer has this HTTP status and passes EXPRESSION.
check_answer() {
	if [ "$STATUS" = "$2" ]; then
		check_json "$1" "$3"
	else
		fail "$1 (expected status $2)"
	fi
}

# write_json FILE JSON: put the text in a file for use as a request body.
write_json() {
	printf '%s' "$2" >"$1"
}

# Wait for the daemon to leave the starting state, and for the schema loads to settle.
wait_for_ready() {
	local deadline=$((SECONDS + WAIT_SECONDS))
	while [ "$SECONDS" -lt "$deadline" ]; do
		request GET /v1/health
		[ "$STATUS" = "200" ] && break
		sleep 1
	done
	if [ "$STATUS" != "200" ]; then
		fail "the daemon answered /v1/health with 200 within ${WAIT_SECONDS} s"
		return 1
	fi
	while [ "$SECONDS" -lt "$deadline" ]; do
		request GET /v1/schemas
		node -e '
			const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
			process.exit(j.schemas.some((s) => s.status === "loading") ? 1 : 0);
		' "$BODY" 2>/dev/null && break
		sleep 1
	done
	return 0
}

# The directory the engine reads its embeddings from, asked of the daemon's own code.
DATA_DIR_PROGRAM='
	const dir = require("./out/engine/dataPath.js").dataDir();
	console.log(dir);
	process.exit(require("node:fs").existsSync(dir + "/tag-embeddings.compact.json") ? 0 : 1);
'

check_data_dir() {
	local found code
	if [ -n "$CONTAINER" ]; then
		found="$(docker exec "$CONTAINER" node -e "$DATA_DIR_PROGRAM" 2>&1)"
	else
		found="$(node -e "$DATA_DIR_PROGRAM" 2>&1)"
	fi
	code=$?
	: >"$BODY"
	if [ "$code" -eq 0 ] && [ "$found" = "$EXPECTED_DATA_DIR" ]; then
		pass "dataDir() resolves to $EXPECTED_DATA_DIR and the embeddings are there"
	else
		fail "dataDir() resolves to $EXPECTED_DATA_DIR with the embeddings there (got: ${found:-nothing})"
	fi
}

allowlist_json() {
	local first=1 spec
	printf '['
	for spec in "${ALLOWLIST[@]}"; do
		[ "$first" = 1 ] || printf ','
		first=0
		printf '"%s"' "$spec"
	done
	printf ']'
}

echo "daemon: $URL$([ "$OFFLINE" = 1 ] && echo ' (offline)')"

wait_for_ready || {
	echo "$FAILURES of $CHECKS checks failed" >&2
	exit 1
}

# Health.
request GET /v1/health
if [ "$OFFLINE" = 1 ]; then
	check_answer "health is 200 and degraded, as it is without a network" 200 \
		'j.apiVersion === "1.0" && j.status === "degraded" && j.schemas.default === "'"$DEFAULT_SCHEMA"'" && j.schemas.degraded.includes("'"$DEFAULT_SCHEMA"'")'
else
	check_answer "health is 200 with a status of ok or degraded" 200 \
		'j.apiVersion === "1.0" && (j.status === "ok" || j.status === "degraded") && j.schemas.default === "'"$DEFAULT_SCHEMA"'"'
fi
if [ -n "${HED_LSP_EXPECTED_COMMIT:-}" ]; then
	check_json "health reports the commit ${HED_LSP_EXPECTED_COMMIT}" 'j.commit === "'"${HED_LSP_EXPECTED_COMMIT}"'"'
fi

# Schemas: the allowlist, and in offline mode what each spec came to.
request GET /v1/schemas
check_answer "/v1/schemas lists the allowlist" 200 \
	'JSON.stringify(j.schemas.map((s) => s.spec).sort()) === JSON.stringify('"$(allowlist_json)"'.sort()) && j.default === "'"$DEFAULT_SCHEMA"'"'
if [ "$OFFLINE" = 1 ]; then
	check_json "8.5.0 is served by the bundled 8.4.0, 8.5.0 with the libraries has failed, and the bundled sets are loaded" \
		'(() => {
			const by = Object.fromEntries(j.schemas.map((s) => [s.spec, s]));
			const bundled = ["8.4.0", "8.4.0,'"$LIBRARIES"'", "8.3.0"];
			return by["8.5.0"].status === "loaded" && by["8.5.0"].used === "8.4.0"
				&& by["8.5.0,'"$LIBRARIES"'"].status === "failed"
				&& bundled.every((spec) => by[spec].status === "loaded" && by[spec].used === spec);
		})()'
fi

# Validate: one valid and one invalid string, against a schema that ships with the validator.
write_json "$TMP/validate.json" '{"strings":["Sensory-event, Visual-presentation","Sensory-event, Not-a-real-tag-xyz"],"schema":"8.4.0"}'
request POST /v1/validate "$TMP/validate.json"
check_answer "validate tells a valid string from an invalid one" 200 \
	'j.results.length === 2 && j.results[0].valid === true && j.results[1].valid === false && j.results[1].issues[0].code === "TAG_INVALID" && j.schema.used === "8.4.0"'

# Suggest.
write_json "$TMP/suggest.json" '{"queries":["button press"],"top":5}'
request POST /v1/suggest "$TMP/suggest.json"
check_answer "suggest returns tags for a query" 200 \
	'j.results.length === 1 && j.results[0].suggestions.length > 0 && j.results[0].suggestions.length <= 5 && j.results[0].suggestions.every((s) => typeof s.tag === "string")'

# Offline: the default spec runs on the bundled schema, and the library specs are refused.
if [ "$OFFLINE" = 1 ]; then
	write_json "$TMP/default.json" '{"strings":["Sensory-event, Visual-presentation"]}'
	request POST /v1/validate "$TMP/default.json"
	check_answer "the default schema validates on the fallback: requested 8.5.0, used 8.4.0" 200 \
		'j.schema.requested === "8.5.0" && j.schema.used === "8.4.0" && j.results[0].valid === true'
	write_json "$TMP/library.json" "{\"strings\":[\"Sensory-event\"],\"schema\":\"8.5.0,${LIBRARIES}\"}"
	request POST /v1/validate "$TMP/library.json"
	check_answer "8.5.0 with the libraries is refused as SCHEMA_UNAVAILABLE" 503 'j.error.code === "SCHEMA_UNAVAILABLE"'
	write_json "$TMP/bundled-library.json" "{\"strings\":[\"Sensory-event, sc:Modulator\"],\"schema\":\"8.4.0,${LIBRARIES}\"}"
	request POST /v1/validate "$TMP/bundled-library.json"
	check_answer "8.4.0 with the libraries validates a library tag from the bundled files" 200 \
		'j.schema.used === "8.4.0,'"$LIBRARIES"'" && j.results[0].valid === true'
fi

# A body over the limit (524288 bytes by default) gets 413.
node -e '
	const body = "{\"strings\":[\"" + "a".repeat(600000) + "\"]}";
	require("node:fs").writeFileSync(process.argv[1], body);
' "$TMP/large.json"
request POST /v1/validate "$TMP/large.json"
check_answer "a body of 600000 bytes gets 413" 413 'j.error.code === "PAYLOAD_TOO_LARGE"'

# A field the API does not know gets 400.
write_json "$TMP/unknown.json" '{"strings":["Sensory-event"],"queryFormat":"x"}'
request POST /v1/validate "$TMP/unknown.json"
check_answer "an unknown field gets 400 UNKNOWN_FIELD" 400 'j.error.code === "UNKNOWN_FIELD"'

check_data_dir

if [ "$FAILURES" -gt 0 ]; then
	echo "$FAILURES of $CHECKS checks failed" >&2
	exit 1
fi
echo "all $CHECKS checks passed"
