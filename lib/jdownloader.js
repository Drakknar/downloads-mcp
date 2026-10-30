const fs = require("fs");
const path = require("path");
const docker = require("./docker");
const fmt = require("./format");
const { config, StepError } = require("./config");

const NAME = () => config.jd.container;
const API_CFG = "org.jdownloader.api.RemoteAPIConfig.json";
const NOT_READY = "JDownloader's local API does not answer: it is off (call enable_jdownloader_api) or JDownloader is still starting (wait ~30 s).";

let chain = Promise.resolve();
// One change at a time (a start and a delete racing on the same links would be confusing).
const locked = (fn) => (chain = chain.then(fn, fn));

// Calls JD's local API from inside its container: GET /<route>?<param1 JSON>&<param2 JSON>…
async function api(route, ...params) {
  const q = params.map((p) => encodeURIComponent(JSON.stringify(p))).join("&");
  const url = `http://127.0.0.1:${config.jd.apiPort}/${route}${q ? `?${q}` : ""}`;
  const script = 'if command -v curl >/dev/null 2>&1; then exec curl -sS -m 30 "$1"; else exec wget -qO- -T 30 "$1"; fi';
  const r = await docker.exec(NAME(), ["sh", "-c", script, "sh", url], { timeoutMs: 45000 });
  const text = r.output.trim();

  if (r.exitCode !== 0) {
    throw new StepError(r.exitCode === 7 || /refused|failed to connect|can.t connect/i.test(text) ? NOT_READY : `JDownloader API ${route} failed (${r.exitCode}): ${text.slice(0, 300)}`);
  }

  let body;

  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new StepError(`JDownloader API ${route}: unexpected answer: ${text.slice(0, 300)}`);
  }

  // Errors: {"type":"BAD_PARAMETERS","data":…}; results: {"data":…}.
  if (body && typeof body === "object" && !Array.isArray(body)) {
    if (typeof body.type === "string" && !("rid" in body)) {
      throw new StepError(`JDownloader API ${route}: ${body.type}${body.data ? ` ${JSON.stringify(body.data).slice(0, 200)}` : ""}`);
    }

    if ("data" in body) {
      return body.data;
    }
  }

  return body;
}

function apiConfigFile() {
  return path.join(config.jd.configDir, "cfg", API_CFG);
}

function readApiConfig() {
  try {
    return JSON.parse(fs.readFileSync(apiConfigFile(), "utf-8"));
  } catch {
    return null;
  }
}

async function ready() {
  try {
    await api("downloadcontroller/getCurrentState");
    return true;
  } catch (e) {
    if (e.message === NOT_READY) {
      return false;
    }

    throw e;
  }
}

async function waitReady(seconds = 120) {
  const until = Date.now() + seconds * 1000;

  while (Date.now() < until) {
    if (await ready()) {
      return true;
    }

    await new Promise((r) => setTimeout(r, config.jd.pollMs ?? 3000));
  }

  return false;
}

// Starts the container when needed and waits for the API.
async function ensureUp() {
  const st = await docker.state(NAME());

  if (!st.running) {
    await docker.start(NAME());

    if (!(await waitReady())) {
      throw new StepError(`Started ${NAME()}, but ${NOT_READY}`);
    }

    return true;
  }

  return false;
}

// ---- listing ------------------------------------------------------------------------------------------------

const LINK_Q = { bytesLoaded: true, bytesTotal: true, enabled: true, eta: true, finished: true, host: true, running: true, skipped: true, speed: true, status: true, maxResults: -1, startAt: 0 };
const PKG_Q = { bytesLoaded: true, bytesTotal: true, childCount: true, enabled: true, eta: true, finished: true, running: true, saveTo: true, speed: true, status: true, maxResults: -1, startAt: 0 };
const GRAB_LINK_Q = { availability: true, bytesTotal: true, enabled: true, host: true, maxResults: -1, startAt: 0 };
const GRAB_PKG_Q = { bytesTotal: true, childCount: true, saveTo: true, maxResults: -1, startAt: 0 };

function linkState(l) {
  if (l.finished) {
    return "finished";
  }

  if (l.running) {
    return "downloading";
  }

  if (l.enabled === false) {
    return "stopped";
  }

  if (l.skipped) {
    return "skipped";
  }

  return "queued";
}

async function snapshot() {
  const [links, packages, grabLinks, grabPackages] = await Promise.all([
    api("downloadsV2/queryLinks", LINK_Q),
    api("downloadsV2/queryPackages", PKG_Q),
    api("linkgrabberv2/queryLinks", GRAB_LINK_Q),
    api("linkgrabberv2/queryPackages", GRAB_PKG_Q),
  ]);
  return { links: links || [], packages: packages || [], grabLinks: grabLinks || [], grabPackages: grabPackages || [] };
}

async function status({ include_finished = true, max_items = config.maxItems } = {}) {
  const st = await docker.state(NAME());
  const base = { client: "jdownloader", container: st.status };

  if (!st.running) {
    return { ...base, note: "JDownloader is not running: start_downloads (client jdownloader) starts it." };
  }

  if (!(await ready())) {
    return { ...base, api: "not answering", note: NOT_READY, api_enabled_in_config: Boolean(readApiConfig()?.deprecatedapienabled) };
  }

  const [stateName, bps, collecting, s] = await Promise.all([
    api("downloadcontroller/getCurrentState"),
    api("downloadcontroller/getSpeedInBps"),
    api("linkgrabberv2/isCollecting"),
    snapshot(),
  ]);
  const counts = {};
  let shown = 0;
  let hidden = 0;
  const byPkg = new Map();

  for (const l of s.links) {
    const state = linkState(l);
    counts[state] = (counts[state] || 0) + 1;

    if (state === "finished" && !include_finished) {
      continue;
    }

    if (shown >= max_items) {
      hidden++;
      continue;
    }

    shown++;
    const item = fmt.clean({
      id: `L${l.uuid}`,
      name: l.name,
      state,
      status: l.status && l.status !== "Finished" ? l.status : undefined,
      size: fmt.size(l.bytesTotal),
      done: state === "finished" ? undefined : fmt.percent(l.bytesLoaded, l.bytesTotal),
      speed: l.running ? fmt.speed(l.speed) : undefined,
      eta: l.running ? fmt.duration(l.eta) : undefined,
      host: l.host,
    });
    (byPkg.get(l.packageUUID) || byPkg.set(l.packageUUID, []).get(l.packageUUID)).push(item);
  }

  const packages = s.packages
    .filter((p) => byPkg.has(p.uuid))
    .map((p) =>
      fmt.clean({
        id: `P${p.uuid}`,
        name: p.name,
        folder: p.saveTo,
        size: fmt.size(p.bytesTotal),
        done: p.finished ? "100%" : fmt.percent(p.bytesLoaded, p.bytesTotal),
        speed: p.running ? fmt.speed(p.speed) : undefined,
        links: byPkg.get(p.uuid),
      }),
    );

  const grabByPkg = new Map();

  for (const l of s.grabLinks) {
    if (shown >= max_items) {
      hidden++;
      continue;
    }

    shown++;
    const item = fmt.clean({ id: `G${l.uuid}`, name: l.name, size: fmt.size(l.bytesTotal), online: l.availability, host: l.host });
    (grabByPkg.get(l.packageUUID) || grabByPkg.set(l.packageUUID, []).get(l.packageUUID)).push(item);
  }

  const linkgrabber = s.grabPackages
    .filter((p) => grabByPkg.has(p.uuid))
    .map((p) => fmt.clean({ id: `GP${p.uuid}`, name: p.name, folder: p.saveTo, size: fmt.size(p.bytesTotal), links: grabByPkg.get(p.uuid) }));

  return fmt.clean({
    ...base,
    downloader: stateName, // RUNNING, IDLE, PAUSE, STOPPING…
    speed: fmt.speed(bps),
    counts,
    packages,
    linkgrabber: linkgrabber.length ? linkgrabber : undefined,
    linkgrabber_note: linkgrabber.length ? "Links in the link grabber are not downloading yet: start_downloads with their G/GP ids moves them to the download list." : undefined,
    checking_links: collecting || undefined,
    more_items_not_shown: hidden || undefined,
  });
}

// ---- ids --------------------------------------------------------------------------------------------------

// L<uuid> download link, P<uuid> download package, G<uuid> link-grabber link, GP<uuid> link-grabber package.
function parseIds(ids) {
  const out = { L: [], P: [], G: [], GP: [] };

  for (const raw of ids) {
    const m = /^(GP|L|P|G)(\d+)$/.exec(String(raw).trim().toUpperCase());

    if (!m) {
      throw new StepError(`"${raw}" is not a JDownloader id (L…, P…, G… or GP… from status)`);
    }

    out[m[1]].push(Number(m[2]));
  }

  return out;
}

// Refuses ids that are not (any more) in JDownloader, so a stale id can't silently do nothing.
async function checkIds(ids) {
  const s = await snapshot();
  const known = {
    L: new Map(s.links.map((l) => [l.uuid, l.name])),
    P: new Map(s.packages.map((p) => [p.uuid, p.name])),
    G: new Map(s.grabLinks.map((l) => [l.uuid, l.name])),
    GP: new Map(s.grabPackages.map((p) => [p.uuid, p.name])),
  };
  const missing = [];
  const names = [];

  for (const [k, list] of Object.entries(ids)) {
    for (const id of list) {
      known[k].has(id) ? names.push(known[k].get(id)) : missing.push(`${k}${id}`);
    }
  }

  if (missing.length) {
    throw new StepError(`Not in JDownloader (any more): ${missing.join(", ")}. Call status for current ids.`);
  }

  return names;
}

// ---- actions ----------------------------------------------------------------------------------------------

function checkFolder(folder) {
  const f = path.posix.normalize(folder).replace(/\/+$/, "");

  if (!f.startsWith("/") || folder.includes("..") || !config.jd.folders.some((r) => f === r || f.startsWith(`${r}/`))) {
    throw new StepError(`folder must be under ${config.jd.folders.join(" or ")} (paths as JDownloader sees them)`);
  }

  return f;
}

async function add({ links, package_name, folder, start = true, password, archive_password }) {
  const dest = folder ? checkFolder(folder) : undefined;
  return locked(async () => {
    const started = await ensureUp();
    const job = await api(
      "linkgrabberv2/addLinks",
      fmt.clean({
        links: links.join("\n"),
        autostart: start,
        packageName: package_name,
        destinationFolder: dest,
        downloadPassword: password,
        extractPassword: archive_password,
        overwritePackagizerRules: Boolean(package_name || dest) || undefined,
      }),
    );
    return fmt.clean({
      client: "jdownloader",
      added: links.length,
      job_id: job?.id,
      started_container: started || undefined,
      autostart: start,
      next: start
        ? "JDownloader checks the links first (a few seconds, longer for folders), then moves them to the download list and starts. Call status to follow."
        : "The links wait in the link grabber (G/GP ids in status); start_downloads with those ids moves them to the download list.",
    });
  });
}

async function start({ ids, force }) {
  return locked(async () => {
    const startedContainer = await ensureUp();

    if (!ids?.length) {
      if ((await api("downloadcontroller/getCurrentState")) === "PAUSE") {
        await api("downloadcontroller/pause", false);
      }

      await api("downloadcontroller/start");
      return fmt.clean({ client: "jdownloader", started: "all", started_container: startedContainer || undefined, downloader: await api("downloadcontroller/getCurrentState") });
    }

    const p = parseIds(ids);
    const names = await checkIds(p);

    if (p.G.length || p.GP.length) {
      await api("linkgrabberv2/moveToDownloadlist", p.G, p.GP);
    }

    if (p.L.length || p.P.length) {
      await api("downloadsV2/setEnabled", true, p.L, p.P);

      if (force) {
        await api("downloadsV2/forceDownload", p.L, p.P);
      }
    }

    if (!force || p.G.length || p.GP.length) {
      await api("downloadcontroller/start");
    }

    return fmt.clean({
      client: "jdownloader",
      started: names,
      forced: force || undefined,
      note: p.G.length || p.GP.length ? "Link-grabber items get new L/P ids in the download list (see status)." : undefined,
    });
  });
}

async function stop({ ids }) {
  return locked(async () => {
    if (!(await docker.state(NAME())).running) {
      return { client: "jdownloader", note: "JDownloader is not running: nothing is downloading." };
    }

    if (!ids?.length) {
      await api("downloadcontroller/stop");
      return { client: "jdownloader", stopped: "all", note: "Partial downloads are kept; start_downloads resumes them." };
    }

    const p = parseIds(ids);

    if (p.G.length || p.GP.length) {
      throw new StepError("G/GP items are in the link grabber and not downloading: nothing to stop (delete_downloads drops them).");
    }

    const names = await checkIds(p);
    await api("downloadsV2/setEnabled", false, p.L, p.P);
    return { client: "jdownloader", stopped: names, note: "Disabled in JDownloader; progress is kept, start_downloads with the same ids resumes." };
  });
}

async function remove({ ids, delete_files = false, remove_finished = false }) {
  return locked(async () => {
    if (!(await docker.state(NAME())).running) {
      throw new StepError("JDownloader is not running: start it first (start_downloads, client jdownloader).");
    }

    const result = { client: "jdownloader" };

    if (remove_finished) {
      const s = await snapshot();
      result.removed_finished = s.links.filter((l) => l.finished).length;
      await api("downloadsV2/cleanup", [], [], "DELETE_FINISHED", "REMOVE_LINKS_ONLY", "ALL");
    }

    if (ids?.length) {
      const p = parseIds(ids);
      result.removed = await checkIds(p);

      if (p.L.length || p.P.length) {
        await api("downloadsV2/cleanup", p.L, p.P, "DELETE_ALL", delete_files ? "REMOVE_LINKS_AND_DELETE_FILES" : "REMOVE_LINKS_ONLY", "SELECTED");
      }

      if (p.G.length || p.GP.length) {
        await api("linkgrabberv2/removeLinks", p.G, p.GP);
      }

      result.files_deleted = delete_files;
    }

    if (!remove_finished && !ids?.length) {
      throw new StepError("Give ids to delete, or remove_finished: true");
    }

    return result;
  });
}

// Turns on JD's local API (localhost only: this server reaches it with docker exec). JD rewrites its config on exit,
// so it is stopped first, the file changed, then started.
async function enableApi({ apply }) {
  const cfg = readApiConfig();
  const file = apiConfigFile();

  if (cfg?.deprecatedapienabled) {
    return { client: "jdownloader", api_enabled: true, answering: (await docker.state(NAME())).running ? await ready() : "JDownloader is stopped" };
  }

  if (!cfg && !fs.existsSync(path.dirname(file))) {
    throw new StepError(`JDownloader's config is not mounted at ${config.jd.configDir} (looked for ${file})`);
  }

  if (!apply) {
    return {
      client: "jdownloader",
      api_enabled: false,
      plan: `stop ${NAME()} (running downloads pause and resume after), set deprecatedapienabled = true (localhost only, port ${config.jd.apiPort}) in cfg/${API_CFG}, start ${NAME()}`,
      next: "Confirm with the user, then call again with apply: true",
    };
  }

  return locked(async () => {
    await docker.stop(NAME(), 60);
    const now = readApiConfig() || {};
    now.deprecatedapienabled = true;
    now.deprecatedapilocalhostonly = true;
    now.deprecatedapiport = config.jd.apiPort;
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(now));
    fs.renameSync(tmp, file);

    try {
      fs.chownSync(file, config.ownerUid, config.ownerGid);
    } catch {}

    await docker.start(NAME());
    const up = await waitReady();
    return { client: "jdownloader", api_enabled: true, answering: up, note: up ? "Ready." : NOT_READY };
  });
}

module.exports = { api, status, add, start, stop, remove, enableApi, parseIds, readApiConfig };
