// Test of downloads-mcp: fake Docker API (with a fake JDownloader API behind docker exec and a fake MegaBasterd
// start-up on a real SQLite DB in MegaBasterd's schema), real MCP client.
// Run with Node 22.13+: node test/fake-docker.test.js.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const assert = require("assert");
const { DatabaseSync } = require("node:sqlite");
const APP = process.env.APP || path.join(__dirname, "..");
const ROOT = path.join(os.tmpdir(), "downloads-mcp-test");
fs.rmSync(ROOT, { recursive: true, force: true });
const mbHome = path.join(ROOT, "mb");
const mbDir = path.join(mbHome, "MegaBasterd");
const dbDir = path.join(mbDir, ".megabasterd8.61");
const dbFile = path.join(dbDir, "megabasterd.db");
const jdCfg = path.join(ROOT, "jd", "cfg");
fs.mkdirSync(dbDir, { recursive: true });
fs.mkdirSync(jdCfg, { recursive: true });
fs.writeFileSync(path.join(jdCfg, "org.jdownloader.api.RemoteAPIConfig.json"), JSON.stringify({ externinterfaceenabled: true, deprecatedapienabled: false }));
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");

// MegaBasterd schema (DBTools.java) + one running download with progress and one leftover chunk folder.
{
  const d = new DatabaseSync(dbFile);
  d.exec("CREATE TABLE downloads(url TEXT, email TEXT, path TEXT, filename TEXT, filekey TEXT, filesize UNSIGNED BIG INT, filepass VARCHAR(64), filenoexpire VARCHAR(64), custom_chunks_dir TEXT, PRIMARY KEY ('url'), UNIQUE(path, filename));");
  d.exec("CREATE TABLE downloads_queue(url TEXT, PRIMARY KEY('url'));");
  d.exec("CREATE TABLE settings(key VARCHAR(255), value TEXT, PRIMARY KEY('key'));");
  d.exec("INSERT INTO settings VALUES ('default_down_dir', '/config/MegaBasterd')");
  d.prepare("INSERT INTO downloads VALUES (?,?,?,?,?,?,?,?,?)").run("https://mega.nz/#!RUN1!KEY1", null, "/config/MegaBasterd", "running.mkv", "fk", 1000, null, null, null);
  d.close();
}
fs.writeFileSync(path.join(mbDir, "running.mkv.mctemp"), Buffer.alloc(300));
fs.mkdirSync(path.join(mbDir, ".MEGABASTERD_CHUNKS_" + sha1("https://mega.nz/#!RUN1!KEY1")));
fs.writeFileSync(path.join(mbDir, ".MEGABASTERD_CHUNKS_" + sha1("https://mega.nz/#!RUN1!KEY1"), "x.chunk1"), Buffer.alloc(100));
const orphanHash = sha1("https://mega.nz/#!OLD!GONE");
fs.mkdirSync(path.join(mbDir, ".MEGABASTERD_CHUNKS_" + orphanHash));
fs.writeFileSync(path.join(mbDir, ".MEGABASTERD_CHUNKS_" + orphanHash, "y.chunk9"), Buffer.alloc(50));
fs.writeFileSync(path.join(mbDir, "keep-me.txt"), "not ours");

// Fake MegaBasterd start-up: what resumeDownloads + provisioning do to the DB.
const mbEvents = [];
function mbStartup() {
  const d = new DatabaseSync(dbFile);
  const rows = new Set(d.prepare("SELECT url FROM downloads").all().map((r) => r.url));
  const queue = d.prepare("SELECT url FROM downloads_queue").all().map((r) => r.url);
  d.exec("DELETE FROM downloads_queue");

  for (const u of queue) {
    if (!rows.has(u)) {
      assert.ok(/^https:\/\/mega\.nz\/#!/.test(u), `legacy link format in queue: ${u}`);
      const name = `${u.split("!")[1]}.bin`;
      d.prepare("INSERT INTO downloads VALUES (?,?,?,?,?,?,?,?,?)").run(u, null, "/config/MegaBasterd", name, "k", 500, null, null, null);
    }
  }

  d.close();
  mbEvents.push("start");
}

// Fake JDownloader
let jdApiOn = false;
let jdState = "IDLE";
const jd = {
  links: [
    { uuid: 101, packageUUID: 11, name: "movie.part1.rar", bytesTotal: 2000, bytesLoaded: 500, running: true, enabled: true, speed: 2048, eta: 75, host: "rapidgator.net", status: "Downloading" },
    { uuid: 102, packageUUID: 11, name: "movie.part2.rar", bytesTotal: 2000, bytesLoaded: 2000, finished: true, enabled: true, status: "Finished" },
  ],
  packages: [{ uuid: 11, name: "Movie", saveTo: "/output/Movie", bytesTotal: 4000, bytesLoaded: 2500, running: true, speed: 2048 }],
  grabLinks: [{ uuid: 201, packageUUID: 21, name: "song.mp3", bytesTotal: 99, availability: "ONLINE", host: "x.com" }],
  grabPackages: [{ uuid: 21, name: "Song", saveTo: "/output" }],
};
const jdCalls = [];
function jdApi(url) {
  const u = new URL(url);
  const route = u.pathname.slice(1);
  const params = u.search ? u.search.slice(1).split("&").map((p) => JSON.parse(decodeURIComponent(p))) : [];
  jdCalls.push({ route, params });
  const data = (d) => JSON.stringify({ data: d });

  switch (route) {
    case "downloadcontroller/getCurrentState": return data(jdState);
    case "downloadcontroller/getSpeedInBps": return data(2048);
    case "downloadcontroller/start": jdState = "RUNNING"; return data(true);
    case "downloadcontroller/stop": jdState = "IDLE"; return data(true);
    case "downloadcontroller/pause": jdState = params[0] ? "PAUSE" : "RUNNING"; return data(true);
    case "linkgrabberv2/isCollecting": return data(false);
    case "downloadsV2/queryLinks": assert.strictEqual(params[0].maxResults, -1); return data(jd.links);
    case "downloadsV2/queryPackages": return data(jd.packages);
    case "linkgrabberv2/queryLinks": return data(jd.grabLinks);
    case "linkgrabberv2/queryPackages": return data(jd.grabPackages);
    case "linkgrabberv2/addLinks": return data({ id: 555 });
    case "downloadsV2/setEnabled": for (const l of jd.links) if (params[1].includes(l.uuid) || params[2].includes(l.packageUUID)) { l.enabled = params[0]; if (!params[0]) l.running = false; } return data(null);
    case "downloadsV2/forceDownload": return data(null);
    case "linkgrabberv2/moveToDownloadlist": return data(null);
    case "linkgrabberv2/removeLinks": jd.grabLinks = jd.grabLinks.filter((l) => !params[0].includes(l.uuid)); return data(null);
    case "downloadsV2/cleanup": if (params[2] === "DELETE_FINISHED") jd.links = jd.links.filter((l) => !l.finished); else jd.links = jd.links.filter((l) => !params[0].includes(l.uuid)); return data(null);
    default: return JSON.stringify({ type: "API_COMMAND_NOT_FOUND", src: "DEVICE" });
  }
}

// Fake MEGA API: folder FOLD1 (key folderKey) = Root/{a.txt, done.txt, Sub/b.bin, Empty/}, encrypted as MEGA does.
const enc = (mode, key, data) => { const c = crypto.createCipheriv(mode, key, mode === "aes-128-cbc" ? Buffer.alloc(16) : null); c.setAutoPadding(false); return Buffer.concat([c.update(data), c.final()]); };
const folderKey = crypto.randomBytes(16);
const megaNodes = [];
const megaKeys = {};
function megaNode(h, p, t, name, size) {
  const key = crypto.randomBytes(t ? 16 : 32);
  const ak = t ? key : Buffer.from(key.subarray(0, 16).map((x, i) => x ^ key[i + 16]));
  let at = Buffer.from(`MEGA${JSON.stringify({ n: name })}`);
  at = Buffer.concat([at, Buffer.alloc((16 - (at.length % 16)) % 16)]);
  megaKeys[h] = key.toString("base64url");
  megaNodes.push({ h, p, t, a: enc("aes-128-cbc", ak, at).toString("base64url"), k: `OWNER:${enc("aes-128-ecb", folderKey, key).toString("base64url")}`, s: t ? undefined : size });
}
megaNode("ROOT", "OUTSIDE", 1, "Root");
megaNode("FA", "ROOT", 0, "a.txt", 10);
megaNode("FD", "ROOT", 0, "done.txt", 7);
megaNode("SUB", "ROOT", 1, "Sub");
megaNode("FB", "SUB", 0, "b.bin", 20);
megaNode("EMPTY", "ROOT", 1, "Empty");
megaNodes.push({ h: "BAD", p: "ROOT", t: 0, a: "AAAAAAAAAAAAAAAAAAAAAA", k: "OWNER:AAAAAAAAAAAAAAAAAAAAAA", s: 1 });
const megaSrv = http.createServer((req, res) => {
  const n = new URL(req.url, "http://x").searchParams.get("n");
  res.end(JSON.stringify(n === "FOLD1" ? [{ f: megaNodes }] : [-9]));
});

// Fake Docker
const frame = (s) => { const b = Buffer.from(s); const h = Buffer.alloc(8); h[0] = 1; h.writeUInt32BE(b.length, 4); return Buffer.concat([h, b]); };
const containers = { jdownloader2: { running: true, started: new Date().toISOString() }, megabasterd: { running: true, started: new Date(Date.now() - 3600e3).toISOString() } };
const execs = {};
let execN = 0;
const dockerSrv = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const m = /^\/containers\/([^/]+)\/(json|stop|start|exec)/.exec(req.url);
    const c = m && containers[decodeURIComponent(m[1])];
    if (m && !c) { res.statusCode = 404; return res.end("no such container"); }
    if (m && m[2] === "json") return res.end(JSON.stringify({ State: { Status: c.running ? "running" : "exited", Running: c.running, StartedAt: c.started } }));
    if (m && m[2] === "stop") { res.statusCode = c.running ? 204 : 304; if (m[1] === "megabasterd" && c.running) mbEvents.push("stop"); c.running = false; return res.end(); }
    if (m && m[2] === "start") { res.statusCode = c.running ? 304 : 204; if (!c.running) { c.running = true; c.started = new Date().toISOString(); if (m[1] === "megabasterd") mbStartup(); if (m[1] === "jdownloader2") jdApiOn = JSON.parse(fs.readFileSync(path.join(jdCfg, "org.jdownloader.api.RemoteAPIConfig.json"))).deprecatedapienabled; } return res.end(); }
    if (m && m[2] === "exec") { if (!c.running) { res.statusCode = 409; return res.end("not running"); } const id = `e${++execN}`; execs[id] = JSON.parse(body); res.statusCode = 201; return res.end(JSON.stringify({ Id: id })); }
    const e = /^\/exec\/(e\d+)\/(start|json)/.exec(req.url);
    if (e && e[2] === "start") { const cmd = execs[e[1]].Cmd; assert.deepStrictEqual(cmd.slice(0, 2), ["sh", "-c"]); if (!jdApiOn) { execs[e[1]].exit = 7; return res.end(frame("curl: (7) Failed to connect to 127.0.0.1 port 3128: Connection refused")); } execs[e[1]].exit = 0; return res.end(frame(jdApi(cmd[4]))); }
    if (e && e[2] === "json") return res.end(JSON.stringify({ ExitCode: execs[e[1]].exit }));
    res.statusCode = 404; res.end("nope " + req.url);
  });
});

(async () => {
  await new Promise((r) => dockerSrv.listen(0, r));
  await new Promise((r) => megaSrv.listen(0, r));
  Object.assign(process.env, {
    MEGA_API_URL: `http://127.0.0.1:${megaSrv.address().port}`,
    DOCKER_HOST_URL: `http://127.0.0.1:${dockerSrv.address().port}`, MCP_TOKEN: "full-tok", MCP_READ_TOKEN: "read-tok",
    JD_CONFIG_MOUNT: path.join(ROOT, "jd"), MB_PATHS: `/config=${mbHome}`, MB_STATE_FILE: path.join(ROOT, "data", "megabasterd.json"),
    OWNER_UID: String(process.getuid ? process.getuid() : 0), OWNER_GID: String(process.getgid ? process.getgid() : 0),
  });
  require(APP + "/lib/config").config.jd.pollMs = 10;
  const { httpServer } = require(APP + "/server.js");
  await new Promise((r) => httpServer.listen(0, r));
  const url = new URL(`http://127.0.0.1:${httpServer.address().port}/mcp`);
  const { Client } = require(APP + "/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js");
  const { StreamableHTTPClientTransport } = require(APP + "/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/streamableHttp.js");
  const connect = async (tok) => { const c = new Client({ name: "t", version: "1" }); await c.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${tok}` } } })); return c; };
  const call = async (c, name, args = {}) => { const r = await c.callTool({ name, arguments: args }); return r.isError ? { ERR: r.content[0].text } : r.structuredContent; };
  const step = (s) => console.log("ok -", s);

  // auth
  assert.strictEqual((await fetch(url, { method: "POST", headers: { Authorization: "Bearer nope", "Content-Type": "application/json" }, body: "{}" })).status, 401);
  const ro = await connect("read-tok");
  assert.deepStrictEqual((await ro.listTools()).tools.map((t) => t.name), ["status"]);
  const rw = await connect("full-tok");
  assert.deepStrictEqual((await rw.listTools()).tools.map((t) => t.name).sort(), ["add_downloads", "delete_downloads", "enable_jdownloader_api", "start_downloads", "status", "stop_downloads"]);
  step("auth levels");

  // JD API off → status says so, enable plan, apply
  let s = await call(ro, "status");
  assert.strictEqual(s.jdownloader.api, "not answering");
  assert.match(s.jdownloader.note, /enable_jdownloader_api/);
  assert.match((await call(rw, "add_downloads", { links: ["https://rapidgator.net/file/abc"] })).ERR, /enable_jdownloader_api/);
  let r = await call(rw, "enable_jdownloader_api");
  assert.ok(r.plan && !r.api_enabled);
  r = await call(rw, "enable_jdownloader_api", { apply: true });
  assert.strictEqual(r.answering, true);
  const cfg = JSON.parse(fs.readFileSync(path.join(jdCfg, "org.jdownloader.api.RemoteAPIConfig.json")));
  assert.strictEqual(cfg.deprecatedapienabled, true);
  assert.strictEqual(cfg.deprecatedapilocalhostonly, true);
  assert.strictEqual(cfg.externinterfaceenabled, true, "other settings kept");
  assert.strictEqual((await call(rw, "enable_jdownloader_api")).api_enabled, true);
  step("enable_jdownloader_api");

  // status
  s = await call(ro, "status");
  const j = s.jdownloader;
  assert.strictEqual(j.downloader, "IDLE");
  assert.strictEqual(j.packages[0].id, "P11");
  assert.strictEqual(j.packages[0].links[0].id, "L101");
  assert.strictEqual(j.packages[0].links[0].done, "25%");
  assert.strictEqual(j.packages[0].links[0].speed, "2.0 KB/s");
  assert.strictEqual(j.packages[0].links[0].eta, "1m 15s");
  assert.strictEqual(j.packages[0].links[1].state, "finished");
  assert.strictEqual(j.linkgrabber[0].links[0].id, "G201");
  assert.deepStrictEqual(j.counts, { downloading: 1, finished: 1 });
  assert.strictEqual((await call(ro, "status", { client: "jdownloader", include_finished: false })).jdownloader.packages[0].links.length, 1);
  const m = s.megabasterd;
  assert.strictEqual(m.downloads.length, 1);
  assert.strictEqual(m.downloads[0].name, "running.mkv");
  assert.strictEqual(m.downloads[0].done, "40%"); // 300 mctemp + 100 chunk of 1000
  assert.strictEqual(m.downloads[0].state, "downloading");
  assert.strictEqual(m.leftover_chunk_folders.length, 1);
  assert.strictEqual(m.leftover_chunk_folders[0].id, `O${orphanHash.slice(0, 10)}`);
  step("status both clients");

  // JD add / start / stop / delete
  r = await call(rw, "add_downloads", { client: "jdownloader", links: ["https://rapidgator.net/file/abc", "https://mega.nz/folder/F1#K1"], package_name: "Pkg", folder: "/output_hdd/Films" });
  assert.strictEqual(r.jdownloader.job_id, 555);
  let last = jdCalls.filter((c) => c.route === "linkgrabberv2/addLinks").pop().params[0];
  assert.deepStrictEqual(last, { links: "https://rapidgator.net/file/abc\nhttps://mega.nz/folder/F1#K1", autostart: true, packageName: "Pkg", destinationFolder: "/output_hdd/Films", overwritePackagizerRules: true });
  assert.ok(!r.megabasterd, "client jdownloader takes the MEGA folder link");
  assert.match((await call(rw, "add_downloads", { links: ["https://x.com/a"], folder: "/etc" })).ERR, /folder must be under/);
  assert.match((await call(rw, "add_downloads", { links: ["https://x.com/a"], folder: "/output/../etc" })).ERR, /folder must be under/);
  r = await call(rw, "start_downloads", { client: "jdownloader" });
  assert.strictEqual(r.downloader, "RUNNING");
  r = await call(rw, "stop_downloads", { client: "jdownloader", ids: ["L101"] });
  assert.deepStrictEqual(r.stopped, ["movie.part1.rar"]);
  assert.strictEqual((await call(ro, "status", { client: "jdownloader" })).jdownloader.packages[0].links[0].state, "stopped");
  r = await call(rw, "start_downloads", { client: "jdownloader", ids: ["l101", "G201"], force: true });
  assert.deepStrictEqual(r.started.sort(), ["movie.part1.rar", "song.mp3"]);
  assert.ok(jdCalls.some((c) => c.route === "downloadsV2/forceDownload" && c.params[0][0] === 101));
  assert.ok(jdCalls.some((c) => c.route === "linkgrabberv2/moveToDownloadlist" && c.params[0][0] === 201));
  assert.match((await call(rw, "stop_downloads", { client: "jdownloader", ids: ["L999"] })).ERR, /L999/);
  assert.match((await call(rw, "stop_downloads", { client: "jdownloader", ids: ["M123"] })).ERR, /not a JDownloader id/);
  r = await call(rw, "delete_downloads", { client: "jdownloader", ids: ["L101"], delete_files: true });
  last = jdCalls.filter((c) => c.route === "downloadsV2/cleanup").pop().params;
  assert.deepStrictEqual(last, [[101], [], "DELETE_ALL", "REMOVE_LINKS_AND_DELETE_FILES", "SELECTED"]);
  r = await call(rw, "delete_downloads", { client: "jdownloader", remove_finished: true });
  assert.strictEqual(r.removed_finished, 1);
  assert.match((await call(rw, "delete_downloads", { client: "jdownloader" })).ERR, /Give ids/);
  r = await call(rw, "stop_downloads", { client: "jdownloader" });
  assert.strictEqual(r.stopped, "all");
  step("JDownloader add/start/stop/delete");

  // JD stopped container → start brings it up
  containers.jdownloader2.running = false;
  r = await call(rw, "start_downloads", { client: "jdownloader" });
  assert.strictEqual(r.started_container, true);
  step("JDownloader container start");

  // MegaBasterd add: new-style link converted, restart, DB row appears
  mbEvents.length = 0;
  r = await call(rw, "add_downloads", { links: ["https://mega.nz/file/NEW1#KEYA", "mega.nz/#!NEW2!KEYB", "https://mega.nz/#!RUN1!KEY1"], folder: "/output/x" });
  const newId = mb("https://mega.nz/#!NEW1!KEYA");
  assert.deepStrictEqual(r.megabasterd.added, [newId, mb("https://mega.nz/#!NEW2!KEYB")]);
  assert.deepStrictEqual(r.megabasterd.already_there, [mb("https://mega.nz/#!RUN1!KEY1")]);
  assert.match(r.megabasterd.ignored_options, /folder/);
  assert.deepStrictEqual(mbEvents, ["stop", "start"]);
  s = (await call(ro, "status", { client: "megabasterd" })).megabasterd;
  assert.deepStrictEqual(s.downloads.map((d) => d.name).sort(), ["NEW1.bin", "NEW2.bin", "running.mkv"]);
  assert.match((await call(rw, "add_downloads", { client: "megabasterd", links: ["https://x.com/a"] })).ERR, /MEGA file and folder links/);
  step("MegaBasterd add (restart, legacy links, dedupe)");

  // add while MegaBasterd is stopped with start:false → stays stopped, shows queued
  containers.megabasterd.running = false;
  mbEvents.length = 0;
  r = await call(rw, "add_downloads", { links: ["https://mega.nz/file/Q1#K"], start: false });
  assert.deepStrictEqual(mbEvents, []);
  assert.match(r.megabasterd.note, /stopped/);
  s = (await call(ro, "status", { client: "megabasterd" })).megabasterd;
  assert.match(s.downloads.find((d) => d.id === mb("https://mega.nz/#!Q1!K")).state, /starts with MegaBasterd/);
  r = await call(rw, "start_downloads", { client: "megabasterd" });
  assert.strictEqual(r.started, "all");
  s = (await call(ro, "status", { client: "megabasterd" })).megabasterd;
  assert.ok(s.downloads.some((d) => d.name === "Q1.bin"));
  step("MegaBasterd queued while stopped, start all");

  // stop one (parked), start it again
  mbEvents.length = 0;
  r = await call(rw, "stop_downloads", { client: "megabasterd", ids: [mb("https://mega.nz/#!RUN1!KEY1")] });
  assert.deepStrictEqual(r.stopped, ["running.mkv"]);
  assert.deepStrictEqual(mbEvents, ["stop", "start"]);
  let d = new DatabaseSync(dbFile, { readOnly: true });
  assert.strictEqual(d.prepare("SELECT count(*) n FROM downloads WHERE url = ?").get("https://mega.nz/#!RUN1!KEY1").n, 0);
  d.close();
  s = (await call(ro, "status", { client: "megabasterd" })).megabasterd;
  const parked = s.downloads.find((x) => x.name === "running.mkv");
  assert.strictEqual(parked.state, "stopped");
  assert.strictEqual(parked.done, "40%");
  assert.ok(!s.leftover_chunk_folders || s.leftover_chunk_folders.length === 1, "a parked item's chunks are not leftovers");
  r = await call(rw, "start_downloads", { client: "megabasterd", ids: [parked.id] });
  assert.deepStrictEqual(r.started, ["running.mkv"]);
  d = new DatabaseSync(dbFile, { readOnly: true });
  const row = d.prepare("SELECT * FROM downloads WHERE url = ?").get("https://mega.nz/#!RUN1!KEY1");
  d.close();
  assert.strictEqual(row.filekey, "fk");
  assert.strictEqual(row.filesize, 1000);
  assert.match((await call(rw, "start_downloads", { client: "megabasterd", ids: ["Mffffffffff"] })).ERR, /Not a MegaBasterd item/);
  step("MegaBasterd stop/start single item (row parked and restored)");

  // stop all = container stop
  r = await call(rw, "stop_downloads", { client: "megabasterd" });
  assert.strictEqual(r.stopped, "all");
  assert.strictEqual(containers.megabasterd.running, false);
  s = (await call(ro, "status", { client: "megabasterd" })).megabasterd;
  assert.strictEqual(s.container, "exited");
  assert.ok(s.downloads.every((x) => /stopped|starts with/.test(x.state)));
  await call(rw, "start_downloads", { client: "megabasterd" });
  step("MegaBasterd stop/start all");

  // finished: MegaBasterd removes the row and renames .mctemp → final
  d = new DatabaseSync(dbFile);
  d.prepare("DELETE FROM downloads WHERE url = ?").run("https://mega.nz/#!NEW1!KEYA");
  d.close();
  fs.writeFileSync(path.join(mbDir, "NEW1.bin"), Buffer.alloc(500));
  s = (await call(ro, "status", { client: "megabasterd" })).megabasterd;
  assert.strictEqual(s.downloads.find((x) => x.id === newId).state, "finished");
  assert.ok(!(await call(ro, "status", { client: "megabasterd", include_finished: false })).megabasterd.downloads.some((x) => x.id === newId));
  // gone: row removed, no file
  d = new DatabaseSync(dbFile);
  d.prepare("DELETE FROM downloads WHERE url = ?").run("https://mega.nz/#!NEW2!KEYB");
  d.close();
  s = (await call(ro, "status", { client: "megabasterd" })).megabasterd;
  assert.strictEqual(s.downloads.find((x) => x.id === mb("https://mega.nz/#!NEW2!KEYB")).state, "gone");
  step("MegaBasterd finished / gone detection");

  // delete: finished from list (no restart, file kept), running one with files, leftover chunk folder
  mbEvents.length = 0;
  r = await call(rw, "delete_downloads", { client: "megabasterd", remove_finished: true });
  assert.deepStrictEqual(r.removed.map((x) => x.id), [newId]);
  assert.deepStrictEqual(mbEvents, [], "finished items: no restart");
  assert.ok(fs.existsSync(path.join(mbDir, "NEW1.bin")), "file kept without delete_files");
  r = await call(rw, "delete_downloads", { client: "megabasterd", ids: [mb("https://mega.nz/#!RUN1!KEY1"), `O${orphanHash.slice(0, 10)}`], delete_files: true });
  assert.deepStrictEqual(mbEvents, ["stop", "start"]);
  assert.deepStrictEqual(r.removed[0].files_deleted, ["running.mkv.mctemp", "chunk folder"]);
  assert.ok(!fs.existsSync(path.join(mbDir, "running.mkv.mctemp")));
  assert.ok(!fs.existsSync(path.join(mbDir, ".MEGABASTERD_CHUNKS_" + orphanHash)));
  assert.ok(fs.existsSync(path.join(mbDir, "keep-me.txt")));
  d = new DatabaseSync(dbFile, { readOnly: true });
  assert.strictEqual(d.prepare("SELECT count(*) n FROM downloads WHERE url = ?").get("https://mega.nz/#!RUN1!KEY1").n, 0);
  d.close();
  s = (await call(ro, "status", { client: "megabasterd" })).megabasterd;
  assert.ok(!s.downloads.some((x) => x.name === "running.mkv"));
  assert.ok(!s.leftover_chunk_folders);
  assert.match((await call(rw, "delete_downloads", { client: "megabasterd", ids: ["nope"] })).ERR, /not a MegaBasterd id/);
  step("MegaBasterd delete (list only, with files, leftover chunks)");

  // MegaBasterd folder links: routed there by default, one row per file in its folder-dialog format
  const fk = folderKey.toString("base64url");
  fs.mkdirSync(path.join(mbDir, "Root"), { recursive: true });
  fs.writeFileSync(path.join(mbDir, "Root", "done.txt"), Buffer.alloc(7)); // already downloaded
  mbEvents.length = 0;
  r = await call(rw, "add_downloads", { links: [`https://mega.nz/folder/FOLD1#${fk}`, `https://mega.nz/folder/GONE#${fk}`, "https://rapidgator.net/file/zzz"] });
  assert.ok(r.jdownloader, "other hosters still go to JD");
  const f = r.megabasterd.folders[0];
  assert.deepStrictEqual([f.name, f.files, f.added, f.already_downloaded, f.empty_folders_skipped, f.unreadable_entries, f.saved_under], ["Root", 3, 2, 1, 1, 1, "/config/MegaBasterd/Root"]);
  assert.strictEqual(f.link, "https://mega.nz/folder/FOLD1#…", "key not echoed");
  assert.deepStrictEqual(r.megabasterd.failed, [{ link: "https://mega.nz/folder/GONE#…", error: "MEGA: folder not found (deleted or wrong link)" }]);
  assert.deepStrictEqual(mbEvents, ["stop", "start"]);
  d = new DatabaseSync(dbFile, { readOnly: true });
  const frows = d.prepare("SELECT * FROM downloads WHERE url LIKE 'https://mega.nz/#N!%' ORDER BY filename").all();
  d.close();
  assert.deepStrictEqual(frows.map((x) => [x.url, x.path, x.filename, x.filekey, x.filesize, x.custom_chunks_dir]), [
    [`https://mega.nz/#N!FB!${megaKeys.FB}###n=FOLD1`, "/config/MegaBasterd", "Root/Sub/b.bin", megaKeys.FB, 20, null],
    [`https://mega.nz/#N!FA!${megaKeys.FA}###n=FOLD1`, "/config/MegaBasterd", "Root/a.txt", megaKeys.FA, 10, null],
  ]);
  s = (await call(ro, "status", { client: "megabasterd" })).megabasterd;
  assert.strictEqual(s.downloads.find((x) => x.name === "Root/a.txt").state, "queued");
  // again: nothing new (same file = same link); subfolder, legacy and file-in-folder links
  r = await call(rw, "add_downloads", { links: [`https://mega.nz/folder/FOLD1#${fk}`] });
  assert.deepStrictEqual([r.megabasterd.folders[0].added, r.megabasterd.folders[0].already_there], [0, 2]);
  r = await call(rw, "add_downloads", { client: "megabasterd", links: [`https://mega.nz/folder/FOLD1#${fk}/folder/SUB`, `https://mega.nz/#F!FOLD1!${fk}`] });
  assert.deepStrictEqual([r.megabasterd.folders[0].name, r.megabasterd.folders[0].files, r.megabasterd.folders[0].already_there], ["Sub", 1, 1]);
  assert.deepStrictEqual([r.megabasterd.folders[1].name, r.megabasterd.folders[1].files], ["Root", 3], "legacy #F! link parsed");
  const d2 = new DatabaseSync(dbFile);
  d2.prepare("DELETE FROM downloads WHERE url LIKE 'https://mega.nz/#N!FB!%'").run();
  d2.close();
  r = await call(rw, "add_downloads", { links: [`https://mega.nz/folder/FOLD1#${fk}/file/FB`] });
  assert.deepStrictEqual([r.megabasterd.folders[0].name, r.megabasterd.folders[0].added, r.megabasterd.folders[0].saved_under], [undefined, 1, "/config/MegaBasterd"]);
  d = new DatabaseSync(dbFile, { readOnly: true });
  assert.strictEqual(d.prepare("SELECT filename FROM downloads WHERE url LIKE 'https://mega.nz/#N!FB!%'").get().filename, "b.bin");
  d.close();
  assert.match((await call(rw, "add_downloads", { links: [`https://mega.nz/folder/FOLD1#${fk}/file/SUB`] })).ERR, /not in this folder/);
  assert.match((await call(rw, "add_downloads", { links: [`https://mega.nz/folder/FOLD1#${crypto.randomBytes(16).toString("base64url")}`] })).ERR, /wrong folder key/);
  step("MegaBasterd MEGA folder links");

  console.log("ALL OK");
  httpServer.close();
  dockerSrv.close();
  megaSrv.close();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

function mb(url) {
  return `M${sha1(url).slice(0, 10)}`;
}
