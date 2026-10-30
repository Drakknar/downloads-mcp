// MegaBasterd has no remote API. What it does have: on start-up it resumes every row of its SQLite `downloads`
// table and every URL in `downloads_queue` (a URL without a row is fetched fresh into the default folder).
// So changes are made with the container stopped: stop → edit the DB → start. Running downloads resume from their
// .mctemp file and chunk folder. "Stopping" one item = parking its row in this server's state file.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const docker = require("./docker");
const fmt = require("./format");
const megafolder = require("./megafolder");
const { config, StepError } = require("./config");

const NAME = () => config.mb.container;
const COLS = ["url", "email", "path", "filename", "filekey", "filesize", "filepass", "filenoexpire", "custom_chunks_dir"];
const CHUNKS = ".MEGABASTERD_CHUNKS_";
const ACTIVE_MS = 90 * 1000; // files touched this recently = downloading
const CHECKING_MS = 3 * 60 * 1000; // queued without a row this long after start = MegaBasterd is still checking the link

let sqlite;
const db = (file, readOnly) => new (sqlite ||= require("node:sqlite")).DatabaseSync(file, { readOnly });

let chain = Promise.resolve();
const locked = (fn) => (chain = chain.then(fn, fn));

const sha1 = (s) => crypto.createHash("sha1").update(s, "utf-8").digest("hex");
const idOf = (url) => `M${sha1(url).slice(0, 10)}`;

// ---- paths ------------------------------------------------------------------------------------------------

function toLocal(p) {
  const n = path.posix.normalize(String(p || ""));

  for (const m of config.mb.paths) {
    if (n === m.path || n.startsWith(`${m.path}/`)) {
      return path.join(m.local, n.slice(m.path.length));
    }
  }

  return null; // not mounted here
}

function toContainer(local) {
  for (const m of config.mb.paths) {
    const rel = path.relative(m.local, local);

    if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
      return path.posix.join(m.path, rel.split(path.sep).join("/"));
    }
  }

  return null;
}

// MegaBasterd's home: <jar folder>/.megabasterd<version>/megabasterd.db (portable) or ~/.megabasterd<version>.
// After an upgrade the newest version's folder is the live one.
function findDb() {
  const home = config.mb.paths[0]?.local;
  const found = [];

  for (const base of [path.join(home, "MegaBasterd"), home]) {
    let names = [];

    try {
      names = fs.readdirSync(base);
    } catch {
      continue;
    }

    for (const n of names) {
      const f = path.join(base, n, "megabasterd.db");

      if (/^\.megabasterd\d/.test(n) && fs.existsSync(f)) {
        const t = Math.max(...["", "-wal"].map((x) => (fs.existsSync(f + x) ? fs.statSync(f + x).mtimeMs : 0)));
        found.push({ file: f, home: base, t });
      }
    }
  }

  if (!found.length) {
    throw new StepError(`MegaBasterd's database not found under ${home} (MB_PATHS mounts MegaBasterd's /config there)`);
  }

  return found.sort((a, b) => b.t - a.t)[0];
}

function stat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

// Bytes on disk for a download: the .mctemp file plus chunks not merged into it yet.
function progress(row) {
  const dir = toLocal(row.custom_chunks_dir || row.path);
  const file = toLocal(`${row.path}/${row.filename}`);
  // The .mctemp sits in the custom chunks folder when one is set, else next to the final file.
  const tempFile = dir && path.join(dir, `${row.filename}.mctemp`);
  const temp = tempFile && stat(tempFile);
  const chunkDir = dir && path.join(dir, CHUNKS + sha1(row.url));
  let bytes = temp ? temp.size : 0;
  let touched = temp ? temp.mtimeMs : 0;

  try {
    for (const c of fs.readdirSync(chunkDir)) {
      const s = stat(path.join(chunkDir, c));

      if (s) {
        bytes += s.size;
        touched = Math.max(touched, s.mtimeMs);
      }
    }
  } catch {}

  const final = file && !temp ? stat(file) : null;
  return { bytes: final ? final.size : bytes, touched, final: Boolean(final), file, tempFile, temp: Boolean(temp), chunkDir };
}

// ---- state file (items this server knows about, parked rows) -----------------------------------------------

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(config.mb.stateFile, "utf-8"));
  } catch {
    return { items: {} };
  }
}

function saveState(s) {
  const cut = Date.now() - config.mb.keepDays * 86400000;

  for (const [url, it] of Object.entries(s.items)) {
    if (it.left && it.left < cut) {
      delete s.items[url];
    }
  }

  fs.mkdirSync(path.dirname(config.mb.stateFile), { recursive: true });
  const tmp = `${config.mb.stateFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 1));
  fs.renameSync(tmp, config.mb.stateFile);
}

function readDb() {
  const { file } = findDb();
  const d = db(file, true);

  try {
    return {
      rows: d.prepare(`SELECT ${COLS.join(",")} FROM downloads ORDER BY rowid`).all(),
      queue: d.prepare("SELECT url FROM downloads_queue ORDER BY rowid").all().map((r) => r.url),
      defaultDir: d.prepare("SELECT value FROM settings WHERE key = 'default_down_dir'").get()?.value,
    };
  } finally {
    d.close();
  }
}

// While MegaBasterd runs, a queued link has neither a queue entry (read at start-up) nor a row (written once
// checked) for a moment. Counted from the later of queueing and MegaBasterd's start; once a row was seen, a missing
// row means the item left (finished, failed or removed).
function checking(it, st) {
  if (it.seen) {
    return false;
  }

  const since = Math.max(it.queuedAt || it.added || 0, st.running ? Date.parse(st.started) || 0 : Date.now());
  return Date.now() - since <= CHECKING_MS;
}

// Records what the DB shows (names, sizes) and when an item left it, so finished items can still be reported.
function reconcile(s, snap, st) {
  const rows = new Map(snap.rows.map((r) => [r.url, r]));
  const queued = new Set(snap.queue);
  const now = Date.now();

  for (const r of snap.rows) {
    const it = (s.items[r.url] ||= { added: now, via: "MegaBasterd window" });
    Object.assign(it, { name: r.filename, path: r.path, size: r.filesize, custom_chunks_dir: r.custom_chunks_dir || undefined, seen: true });
    delete it.left;
  }

  for (const [url, it] of Object.entries(s.items)) {
    if (!rows.has(url) && !queued.has(url) && !it.parked && !it.left && !checking(it, st)) {
      it.left = now;
    }
  }

  return { rows, queued };
}

function itemView(url, it, row, inQueue, running) {
  const base = { id: idOf(url), name: it?.name || row?.filename };

  if (it?.parked) {
    const p = it.name ? progress(it.parked.row || { url, path: it.path, filename: it.name, custom_chunks_dir: it.custom_chunks_dir }) : null;
    return fmt.clean({ ...base, state: "stopped", size: fmt.size(it.size), done: p && fmt.percent(p.bytes, it.size) });
  }

  if (row) {
    const p = progress(row);
    const state = !running ? "stopped (MegaBasterd is stopped)" : p.final ? "finishing (verifying)" : Date.now() - p.touched < ACTIVE_MS ? "downloading" : p.bytes ? "waiting" : "queued";
    return fmt.clean({ ...base, state, size: fmt.size(row.filesize), done: fmt.percent(p.bytes, row.filesize), folder: row.path });
  }

  if (inQueue || (it && !it.left)) {
    return fmt.clean({ ...base, state: running ? "queued (MegaBasterd is checking the link)" : "queued (starts with MegaBasterd)", link: url.replace(/!([^!]+)$/, "!…") });
  }

  // Left the DB: finished if the final file is there with its full size.
  const file = it?.name && toLocal(`${it.path}/${it.name}`);
  const f = file && !stat(`${file}.mctemp`) ? stat(file) : null;

  if (f && (!it.size || f.size === it.size)) {
    return fmt.clean({ ...base, state: "finished", size: fmt.size(f.size), file: `${it.path}/${it.name}`, finished: new Date(f.mtimeMs).toISOString() });
  }

  return fmt.clean({ ...base, state: "gone", size: fmt.size(it?.size), note: "Left MegaBasterd's list without a complete file: failed (bad/expired link, quota) or removed in its window. Check the MegaBasterd window." });
}

// Chunk folders whose download is not in MegaBasterd any more (aborted downloads leave them behind).
function orphans(snap, s) {
  const known = new Set([...snap.rows.map((r) => r.url), ...Object.entries(s.items).filter(([, it]) => it.parked).map(([u]) => u)].map(sha1));
  const dirs = new Set([findDb().home, toLocal(snap.defaultDir), ...snap.rows.map((r) => toLocal(r.custom_chunks_dir || r.path))].filter(Boolean));
  const out = [];

  for (const d of dirs) {
    let names = [];

    try {
      names = fs.readdirSync(d);
    } catch {
      continue;
    }

    for (const n of names.filter((x) => x.startsWith(CHUNKS))) {
      const hash = n.slice(CHUNKS.length);

      if (known.has(hash)) {
        continue;
      }

      let bytes = 0;
      let touched = 0;

      for (const c of fs.readdirSync(path.join(d, n))) {
        const st = stat(path.join(d, n, c));
        bytes += st ? st.size : 0;
        touched = Math.max(touched, st ? st.mtimeMs : 0);
      }

      out.push({ id: `O${hash.slice(0, 10)}`, dir: path.join(d, n), folder: toContainer(path.join(d, n)), bytes, touched });
    }
  }

  return out;
}

// ---- status -----------------------------------------------------------------------------------------------

async function status({ include_finished = true, max_items = config.maxItems } = {}) {
  const st = await docker.state(NAME());
  const s = loadState();
  const snap = readDb();
  const { rows, queued } = reconcile(s, snap, st);
  saveState(s);

  const urls = [...new Set([...snap.rows.map((r) => r.url), ...snap.queue, ...Object.keys(s.items)])];
  const items = urls.map((u) => itemView(u, s.items[u], rows.get(u), queued.has(u), st.running));
  const counts = {};

  for (const i of items) {
    const k = i.state.split(" ")[0];
    counts[k] = (counts[k] || 0) + 1;
  }

  const shown = items.filter((i) => include_finished || !["finished", "gone"].includes(i.state));
  const orph = orphans(snap, s);
  return fmt.clean({
    client: "megabasterd",
    container: st.status,
    default_folder: snap.defaultDir,
    counts,
    downloads: shown.slice(0, max_items),
    more_items_not_shown: shown.length > max_items ? shown.length - max_items : undefined,
    leftover_chunk_folders: orph.length
      ? orph.map((o) => fmt.clean({ id: o.id, folder: o.folder, size: fmt.size(o.bytes), last_written: new Date(o.touched || 0).toISOString().slice(0, 10) }))
      : undefined,
    leftover_note: orph.length ? "Partial data of downloads that are no longer in MegaBasterd; delete_downloads with these O ids frees the space." : undefined,
    note: "MegaBasterd has no remote control: adding, stopping or deleting single items restarts its container (a few seconds; running downloads resume where they were). MEGA transfer quota errors are only visible in its window.",
  });
}

// ---- links ------------------------------------------------------------------------------------------------

// MegaBasterd's resume path only understands legacy file links (https://mega.nz/#!ID!KEY).
function normalizeLink(link) {
  const l = String(link).trim();
  let m = /^(?:https?:\/\/)?(?:www\.)?mega(?:\.co)?\.nz\/file\/([\w-]+)#([\w-]+)\/?$/i.exec(l);

  if (m) {
    return `https://mega.nz/#!${m[1]}!${m[2]}`;
  }

  m = /^(?:https?:\/\/)?(?:www\.)?mega(?:\.co)?\.nz\/#!([\w-]+)!([\w-]+)$/i.exec(l);

  if (m) {
    return `https://mega.nz/#!${m[1]}!${m[2]}`;
  }

  return null;
}

// ---- changes (container stopped) ----------------------------------------------------------------------------

function chownDb(file) {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      fs.chownSync(f, config.ownerUid, config.ownerGid);
    } catch {}
  }
}

// Stops MegaBasterd, runs fn(db, state, snapshot) in one transaction, starts it again if it was running (or when
// startAfter). Links added in the last minutes that MegaBasterd had not registered yet are put back in its queue
// (it only saves its queue when closed from its window, not on a container stop).
async function withStopped(fn, { startAfter = false } = {}) {
  const st = await docker.state(NAME());
  const s = loadState();
  // Before the stop: which links MegaBasterd is still checking (in its memory only).
  reconcile(s, readDb(), st);

  if (st.running) {
    await docker.stop(NAME(), 30);
  }

  const { file } = findDb();
  let result;

  try {
    const d = db(file, false);

    try {
      d.exec("BEGIN IMMEDIATE");
      const snap = {
        rows: d.prepare(`SELECT ${COLS.join(",")} FROM downloads`).all(),
        queue: d.prepare("SELECT url FROM downloads_queue").all().map((r) => r.url),
      };
      const rowUrls = new Set(snap.rows.map((r) => r.url));
      const requeue = d.prepare("INSERT OR IGNORE INTO downloads_queue (url) VALUES (?)");

      for (const [url, it] of Object.entries(s.items)) {
        if (!it.parked && !it.left && !rowUrls.has(url)) {
          requeue.run(url);
          snap.queue.includes(url) || snap.queue.push(url);
        }
      }

      result = fn(d, s, snap);
      d.exec("COMMIT");
    } catch (e) {
      try {
        d.exec("ROLLBACK");
      } catch {}

      throw e;
    } finally {
      d.close();
      chownDb(file);
    }

    saveState(s);
  } finally {
    if (st.running || startAfter) {
      await docker.start(NAME());
    }
  }

  return { result, restarted: st.running, started: !st.running && startAfter };
}

const restartNote = (r) =>
  r.restarted ? "MegaBasterd was restarted to apply this; downloads that were running resume where they were." : r.started ? "MegaBasterd was started." : "MegaBasterd is stopped: changes apply when it starts.";

const isMegaLink = (link) => Boolean(normalizeLink(link) || megafolder.parse(link));

const hideKey = (link) => String(link).replace(/#.*$/, "#…");

// Folder files become rows exactly as MegaBasterd's folder dialog creates them (path = download folder, filename =
// relative path); at start-up it provisions each row like a resumed download.
function addFolderFiles(d, s, snap, folders) {
  const setting = (k) => d.prepare("SELECT value FROM settings WHERE key = ?").get(k)?.value;
  const base = setting("default_down_dir");

  if (!folders.length) {
    return [];
  }

  if (!base) {
    throw new StepError("MegaBasterd has no default download folder set (its Settings), needed for folder links");
  }

  const chunksDir = setting("use_custom_chunks_dir") === "yes" ? setting("custom_chunks_dir") || null : null;
  const have = new Set([...snap.rows.map((x) => x.url), ...snap.queue]);
  const row = d.prepare(`INSERT OR IGNORE INTO downloads (${COLS.join(",")}) VALUES (${COLS.map(() => "?").join(",")})`);

  return folders.map((f) => {
    const out = { link: hideKey(f.link), name: f.name, files: f.files.length, size: fmt.size(f.files.reduce((n, x) => n + x.size, 0)), added: 0 };
    let already = 0;
    let onDisk = 0;

    for (const x of f.files) {
      if (have.has(x.url) || s.items[x.url]?.parked) {
        already++;
        continue;
      }

      const local = toLocal(`${base}/${x.filename}`);
      const done = local && !stat(`${local}.mctemp`) ? stat(local) : null;

      if (done && done.size === x.size) {
        onDisk++;
        continue;
      }

      // Not inserted = same path and name as another row (UNIQUE(path, filename)).
      if (!row.run(x.url, null, base, x.filename, x.filekey, x.size, null, null, chunksDir).changes) {
        already++;
        continue;
      }

      s.items[x.url] = { added: Date.now(), queuedAt: Date.now(), via: "MCP", seen: true, name: x.filename, path: base, size: x.size, custom_chunks_dir: chunksDir || undefined };
      out.added++;
    }

    return fmt.clean({
      ...out,
      already_there: already || undefined,
      already_downloaded: onDisk || undefined,
      empty_folders_skipped: f.emptyFolders || undefined,
      unreadable_entries: f.undecryptable || undefined,
      saved_under: `${base}/${f.name || ""}`.replace(/\/$/, ""),
    });
  });
}

async function add({ links, start = true }) {
  const good = [];
  const folderLinks = [];
  const refused = [];

  for (const l of links) {
    const n = normalizeLink(l);
    n ? good.push(n) : megafolder.parse(l) ? folderLinks.push(l) : refused.push(l);
  }

  if (!good.length && !folderLinks.length) {
    throw new StepError(`No MEGA link to add (refused: ${refused.join(", ")}). MegaBasterd takes MEGA file and folder links; use client jdownloader for other sites.`);
  }

  // Folders are listed before MegaBasterd is stopped, so the stop stays short.
  const folders = [];
  const failed = [];

  for (const link of folderLinks) {
    try {
      const f = await megafolder.list(link);

      if (f.files.length > config.mb.maxFolderFiles) {
        throw new StepError(`${f.files.length} files, more than the ${config.mb.maxFolderFiles} allowed in one go (MB_MAX_FOLDER_FILES); add its subfolders separately or use client jdownloader`);
      }

      folders.push({ link, ...f });
    } catch (e) {
      if (!(e instanceof StepError)) {
        throw e;
      }

      failed.push({ link: hideKey(link), error: e.message });
    }
  }

  if (!good.length && !folders.length) {
    throw new StepError(`Nothing added: ${failed.map((f) => `${f.link}: ${f.error}`).join("; ")}`);
  }

  return locked(async () => {
    const r = await withStopped(
      (d, s, snap) => {
        const have = new Set([...snap.rows.map((x) => x.url), ...snap.queue]);
        const ins = d.prepare("INSERT OR IGNORE INTO downloads_queue (url) VALUES (?)");
        const added = [];
        const already = [];

        for (const url of good) {
          if (have.has(url) || s.items[url]?.parked) {
            already.push(idOf(url));
            continue;
          }

          ins.run(url);
          s.items[url] = { added: Date.now(), queuedAt: Date.now(), via: "MCP", seen: false };
          added.push(idOf(url));
        }

        return { added, already, folders: addFolderFiles(d, s, snap, folders) };
      },
      { startAfter: start },
    );
    return fmt.clean({
      client: "megabasterd",
      added: r.result.added.length ? r.result.added : undefined,
      already_there: r.result.already.length ? r.result.already : undefined,
      folders: r.result.folders.length ? r.result.folders : undefined,
      folders_note: r.result.folders.length ? "Each file of a folder is its own MegaBasterd item (M id in status), saved with the folder's structure." : undefined,
      failed: failed.length ? failed : undefined,
      refused: refused.length ? refused : undefined,
      refused_note: refused.length ? "Only MEGA file and folder links; use client jdownloader for other sites." : undefined,
      folder: "MegaBasterd's default download folder (its own setting)",
      note: restartNote(r),
    });
  });
}

function resolveIds(ids, s, snap) {
  const urls = [...new Set([...snap.rows.map((r) => r.url), ...snap.queue, ...Object.keys(s.items)])];
  const byId = new Map(urls.map((u) => [idOf(u), u]));
  const out = [];
  const bad = [];

  for (const raw of ids) {
    const u = byId.get(raw);
    u ? out.push(u) : bad.push(raw);
  }

  if (bad.length) {
    throw new StepError(`Not a MegaBasterd item: ${bad.join(", ")}. Call status for current ids (M… for downloads, O… for leftover chunk folders).`);
  }

  return out;
}

function mbIds(ids) {
  const m = [];
  const o = [];

  for (const raw of ids) {
    const id = String(raw).trim();
    /^O[0-9a-f]{10}$/i.test(id) ? o.push(id) : /^M[0-9a-f]{10}$/i.test(id) ? m.push(`M${id.slice(1).toLowerCase()}`) : (() => {
      throw new StepError(`"${raw}" is not a MegaBasterd id (M… or O… from status)`);
    })();
  }

  return { m, o };
}

// What the read-only snapshot says about these ids, so no-op calls don't restart MegaBasterd.
async function current() {
  const st = await docker.state(NAME());
  const s = loadState();
  const snap = readDb();
  reconcile(s, snap, st);
  return { s, snap };
}

async function start({ ids }) {
  return locked(async () => {
    const st = await docker.state(NAME());

    if (!ids?.length) {
      if (st.running) {
        return { client: "megabasterd", note: "MegaBasterd is already running; it downloads everything in its list (single stopped items: start_downloads with their ids)." };
      }

      await docker.start(NAME());
      return { client: "megabasterd", started: "all", note: "MegaBasterd started; it resumes every download in its list." };
    }

    const { m, o } = mbIds(ids);

    if (o.length) {
      throw new StepError("O… ids are leftover chunk folders, not downloads: they can only be deleted.");
    }

    const { s, snap } = await current();
    const urls = resolveIds(m, s, snap);
    const parked = urls.filter((u) => s.items[u]?.parked);

    if (!parked.length) {
      if (!st.running) {
        await docker.start(NAME());
      }

      return { client: "megabasterd", note: `None of these was stopped: ${st.running ? "they are already in MegaBasterd's list" : "MegaBasterd was started and resumes its list"}.` };
    }

    const r = await withStopped(
      (d, state) => {
        const row = d.prepare(`INSERT OR IGNORE INTO downloads (${COLS.join(",")}) VALUES (${COLS.map(() => "?").join(",")})`);
        const q = d.prepare("INSERT OR IGNORE INTO downloads_queue (url) VALUES (?)");
        const names = [];

        for (const u of parked) {
          const p = state.items[u].parked;
          p.row ? row.run(...COLS.map((c) => p.row[c] ?? null)) : q.run(u);
          state.items[u].queuedAt = Date.now();
          state.items[u].seen = Boolean(p.row);
          delete state.items[u].parked;
          delete state.items[u].left;
          names.push(state.items[u].name || idOf(u));
        }

        return names;
      },
      { startAfter: true },
    );
    return { client: "megabasterd", started: r.result, note: restartNote(r) };
  });
}

async function stop({ ids }) {
  return locked(async () => {
    const st = await docker.state(NAME());

    if (!ids?.length) {
      if (!st.running) {
        return { client: "megabasterd", note: "MegaBasterd is already stopped." };
      }

      await docker.stop(NAME(), 30);
      return { client: "megabasterd", stopped: "all", note: "MegaBasterd's container is stopped (its only global pause). Partial downloads are kept; start_downloads resumes them." };
    }

    const { m, o } = mbIds(ids);

    if (o.length) {
      throw new StepError("O… ids are leftover chunk folders, not downloads: nothing to stop.");
    }

    const { s, snap } = await current();
    const urls = resolveIds(m, s, snap);
    const inDb = new Set([...snap.rows.map((r) => r.url), ...snap.queue]);
    const todo = urls.filter((u) => inDb.has(u) || (s.items[u] && !s.items[u].left && !s.items[u].parked));

    if (!todo.length) {
      return { client: "megabasterd", note: "None of these is in MegaBasterd's list (already stopped, finished or gone)." };
    }

    const r = await withStopped((d, state, now) => {
      const rows = new Map(now.rows.map((x) => [x.url, x]));
      const delRow = d.prepare("DELETE FROM downloads WHERE url = ?");
      const delQ = d.prepare("DELETE FROM downloads_queue WHERE url = ?");
      const names = [];

      for (const u of todo) {
        const row = rows.get(u);
        const it = (state.items[u] ||= { added: Date.now(), via: "MegaBasterd window" });
        it.parked = row ? { row, at: Date.now() } : { at: Date.now() };

        if (row) {
          Object.assign(it, { name: row.filename, path: row.path, size: row.filesize });
        }

        delRow.run(u);
        delQ.run(u);
        names.push(it.name || idOf(u));
      }

      return names;
    });
    return { client: "megabasterd", stopped: r.result, note: `${restartNote(r)} Stopped items keep their partial data; start_downloads with the same ids resumes them.` };
  });
}

// Removes a path only if it is one of this download's own files (never anything else in the folder).
function rmOwn(p, kind) {
  if (!p) {
    return false;
  }

  const base = path.basename(p);

  if ((kind === "chunks" && !base.startsWith(CHUNKS)) || (kind === "temp" && !base.endsWith(".mctemp"))) {
    return false;
  }

  if (!stat(p)) {
    return false;
  }

  fs.rmSync(p, { recursive: kind === "chunks", force: true });
  return true;
}

async function remove({ ids, delete_files = false, remove_finished = false }) {
  return locked(async () => {
    const { m, o } = mbIds(ids || []);
    const { s, snap } = await current();

    if (remove_finished) {
      for (const [u, it] of Object.entries(s.items)) {
        if (it.left && itemView(u, it, null, false, true).state === "finished") {
          m.push(idOf(u));
        }
      }
    }

    if (!m.length && !o.length) {
      if (remove_finished) {
        return { client: "megabasterd", removed: [], note: "No finished items to clear." };
      }

      throw new StepError("Give ids to delete, or remove_finished: true");
    }

    const urls = resolveIds([...new Set(m)], s, snap);
    const result = { client: "megabasterd", removed: [] };

    if (o.length) {
      const all = orphans(snap, s);
      result.removed_chunk_folders = o.map((id) => {
        const hit = all.find((x) => x.id.toLowerCase() === id.toLowerCase());

        if (!hit) {
          throw new StepError(`${id} is not a leftover chunk folder (any more). Call status.`);
        }

        rmOwn(hit.dir, "chunks");
        return hit.folder;
      });
    }

    const inDb = new Set([...snap.rows.map((r) => r.url), ...snap.queue]);
    const dbUrls = urls.filter((u) => inDb.has(u) || (s.items[u] && !s.items[u].left && !s.items[u].parked));
    const forget = (state, u, row) => {
      const it = state.items[u] || {};
      const info = row || (it.parked && it.parked.row) || (it.name ? { url: u, path: it.path, filename: it.name, custom_chunks_dir: it.custom_chunks_dir } : null);
      const files = [];

      if (delete_files && info) {
        const p = progress({ url: u, ...info });
        rmOwn(p.tempFile, "temp") && files.push(`${info.filename}.mctemp`);
        rmOwn(p.chunkDir, "chunks") && files.push("chunk folder");

        // A finished item's own file, only when it left MegaBasterd with its full, known size.
        const fullSize = info.filesize || it.size;
        if (it.left && p.final && fullSize && p.bytes === fullSize) {
          fs.rmSync(p.file, { force: true });
          files.push(info.filename);
        }
      }

      delete state.items[u];
      result.removed.push(fmt.clean({ id: idOf(u), name: info?.filename || it.name, files_deleted: files.length ? files : undefined }));
    };

    if (dbUrls.length) {
      const r = await withStopped((d, state, now) => {
        const rows = new Map(now.rows.map((x) => [x.url, x]));
        const delRow = d.prepare("DELETE FROM downloads WHERE url = ?");
        const delQ = d.prepare("DELETE FROM downloads_queue WHERE url = ?");

        for (const u of urls) {
          delRow.run(u);
          delQ.run(u);
          forget(state, u, rows.get(u));
        }
      });
      result.note = restartNote(r);
    } else if (urls.length) {
      for (const u of urls) {
        forget(s, u, null);
      }

      saveState(s);
    }

    if (!delete_files && urls.length) {
      result.files_kept = "Partial/finished files were left on disk (delete_files: true removes them).";
    }

    return result;
  });
}

module.exports = { status, add, start, stop, remove, normalizeLink, isMegaLink, idOf, sha1, toLocal };
