const http = require("http");
const { config, StepError } = require("./config");

// Minimal Docker Engine API client: inspect, stop, start and exec of named containers.
function call(method, path, body, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const u = config.dockerHost && new URL(config.dockerHost);
    const target = u ? { host: u.hostname, port: u.port } : { socketPath: config.dockerSocket };
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      { ...target, method, path, headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {} },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", (e) => reject(new StepError(`Docker API unreachable: ${e.message}`)));
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${timeoutMs / 1000} s`)));
    req.end(payload);
  });
}

// Exec output is multiplexed: 8-byte frame headers (stream type + length) before each chunk.
function demux(buf) {
  const parts = [];
  let i = 0;

  while (i + 8 <= buf.length && buf[i] <= 2 && buf[i + 1] === 0) {
    const len = buf.readUInt32BE(i + 4);
    parts.push(buf.subarray(i + 8, i + 8 + len));
    i += 8 + len;
  }

  return (i === 0 ? buf : Buffer.concat(parts)).toString("utf-8");
}

function ok(r, what, expected = (s) => s < 300) {
  if (!expected(r.status)) {
    throw new StepError(`${what} failed (${r.status}): ${r.body.toString().slice(0, 300)}`);
  }

  return r;
}

const json = (r, what) => JSON.parse(ok(r, what).body);
const enc = encodeURIComponent;

async function inspect(name) {
  const r = await call("GET", `/containers/${enc(name)}/json`);

  if (r.status === 404) {
    throw new StepError(`Container ${name} not found`);
  }

  return json(r, "Docker inspect");
}

async function state(name) {
  const s = (await inspect(name)).State || {};
  return { status: s.Status, running: Boolean(s.Running), started: s.StartedAt };
}

// 304 = already in that state.
async function stop(name, seconds = 30) {
  ok(await call("POST", `/containers/${enc(name)}/stop?t=${seconds}`, undefined, (seconds + 60) * 1000), `Stopping ${name}`, (s) => s === 204 || s === 304);
}

async function start(name) {
  ok(await call("POST", `/containers/${enc(name)}/start`, undefined, 60000), `Starting ${name}`, (s) => s === 204 || s === 304);
}

async function exec(name, cmd, { timeoutMs = 60000 } = {}) {
  const created = await call("POST", `/containers/${enc(name)}/exec`, { AttachStdout: true, AttachStderr: true, Cmd: cmd });

  if (created.status === 409) {
    throw new StepError(`Container ${name} is not running`);
  }

  const { Id } = json(ok(created, `Docker exec in ${name}`, (s) => s === 201), "Docker exec");
  const started = await call("POST", `/exec/${Id}/start`, { Detach: false, Tty: false }, timeoutMs);

  if (started.status >= 300) {
    throw new StepError(`Docker exec start failed (${started.status}): ${demux(started.body).slice(0, 300)}`);
  }

  const info = json(await call("GET", `/exec/${Id}/json`), "Docker exec inspect");
  return { exitCode: info.ExitCode, output: demux(started.body) };
}

module.exports = { call, demux, inspect, state, stop, start, exec };
