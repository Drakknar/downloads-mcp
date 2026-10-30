#!/bin/sh
# Starts the image and expects its MCP endpoint to refuse a request without a token.
set -eu
image=$1
name=smoke-$$
docker run -d --name "$name" -e MCP_TOKEN=smoke-test-only  "$image" >/dev/null
trap 'docker logs "$name" 2>&1 | tail -20; docker rm -f "$name" >/dev/null' EXIT
sleep 3
ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$name")
status=$(curl -s -o /dev/null -m 5 -w '%{http_code}' -X POST "http://$ip:8080/mcp")
[ "$status" = 401 ] || { echo "Expected 401, got $status"; exit 1; }
