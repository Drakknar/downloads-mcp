// MEGA folder links for MegaBasterd. Its resume path cannot open a folder link, but its own folder dialog turns
// every file into a folder-file link (https://mega.nz/#N!<handle>!<file key>###n=<folder id>) plus a relative file
// name ("Folder/Sub/file.ext"), and the resume path downloads those. This lists the folder through MEGA's public
// API and builds the same links (FolderLinkDialog + MegaAPI.getFolderNodes).
const crypto = require("crypto");
const { config, StepError } = require("./config");

const HOST = String.raw`(?:https?:\/\/)?(?:www\.)?mega(?:\.co)?\.nz`;
const NEW = new RegExp(String.raw`^${HOST}\/folder\/([\w-]+)#([\w-]+)(?:\/(folder|file)\/([\w-]+))?\/?$`, "i");
const LEGACY = new RegExp(String.raw`^${HOST}\/#F!([\w-]+)(?:@([\w-]+))?!([\w-]+)(?:!([\w-]+))?$`, "i");

const b64 = (s) => Buffer.from(s, "base64url");
const ub64 = (b) => b.toString("base64url"); // no padding, like MegaBasterd's Bin2UrlBASE64

// { id, key, sub } (a subfolder) or { id, key, file } (one file of the folder); null if not a folder link.
function parse(link) {
  const l = String(link).trim();
  let m = NEW.exec(l);

  if (m) {
    return { id: m[1], key: m[2], [m[3]?.toLowerCase() === "file" ? "file" : "sub"]: m[4] || undefined };
  }

  m = LEGACY.exec(l);
  return m ? { id: m[1], key: m[3], sub: m[2] || m[4] || undefined } : null;
}

function aes(mode, key, data) {
  const d = crypto.createDecipheriv(mode, key, mode === "aes-128-cbc" ? Buffer.alloc(16) : null);
  d.setAutoPadding(false);
  return Buffer.concat([d.update(data), d.final()]);
}

// A file key is 32 bytes; its first and second half XORed give the AES key of its attributes (and data).
const attrKey = (k) => (k.length < 32 ? k.subarray(0, 16) : Buffer.from(k.subarray(0, 16).map((x, i) => x ^ k[i + 16])));

function decAttr(a, key) {
  try {
    const data = b64(a);

    if (!data.length || data.length % 16) {
      return null;
    }

    const s = aes("aes-128-cbc", attrKey(key), data).toString("utf-8").replace(/\0+$/, "");
    return s.startsWith("MEGA{") ? JSON.parse(s.slice(4)) : null;
  } catch {
    return null;
  }
}

// "owner:key" or several of them separated by "/": the one that opens the attributes is the node's key.
function decNode(n, folderKey) {
  for (const seg of String(n.k || "").split("/")) {
    const enc = b64(seg.slice(seg.lastIndexOf(":") + 1));

    if (!enc.length || enc.length % 16) {
      continue;
    }

    const key = aes("aes-128-ecb", folderKey, enc);
    const at = decAttr(n.a, key);

    if (at && typeof at.n === "string") {
      return { h: n.h, p: n.p, t: n.t, s: n.s, key: ub64(key), name: at.n };
    }
  }

  return null;
}

// What MegaBasterd's cleanFilePath leaves in a name on Linux, plus no "/" inside one path segment.
const cleanName = (n, h) => n.replace(/[\x00-\x1F]/g, "").replace(/[/\\]/g, "_").replace(/\.{2,}/g, ".").trim() || h;

const ERRORS = { "-2": "bad link", "-9": "folder not found (deleted or wrong link)", "-11": "access denied", "-16": "folder blocked by MEGA (taken down)", "-17": "over quota", "-18": "MEGA temporarily unavailable" };

async function fetchNodes(id) {
  for (let attempt = 0; ; attempt++) {
    let r;

    try {
      const res = await fetch(`${config.megaApi}/cs?id=${crypto.randomInt(1e9)}&n=${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([{ a: "f", c: 1, r: 1, ca: 1 }]),
        signal: AbortSignal.timeout(60000),
      });
      r = await res.json();
    } catch (e) {
      throw new StepError(`MEGA API unreachable: ${e.message}`);
    }

    const code = typeof r === "number" ? r : Array.isArray(r) && typeof r[0] === "number" ? r[0] : null;

    if (code === -3 && attempt < 4) {
      await new Promise((ok) => setTimeout(ok, 1000 * 2 ** attempt)); // EAGAIN
      continue;
    }

    if (code !== null) {
      throw new StepError(`MEGA: ${ERRORS[code] || `error ${code}`}`);
    }

    if (!Array.isArray(r?.[0]?.f)) {
      throw new StepError("MEGA: unexpected answer to the folder listing");
    }

    return r[0].f;
  }
}

// Lists a folder link as MegaBasterd folder-file downloads: [{ url, filename, filekey, size }], file names relative
// to the download folder and starting with the shared (or chosen sub-) folder's name, as its folder dialog does.
async function list(link) {
  const p = parse(link);

  if (!p) {
    throw new StepError("not a MEGA folder link");
  }

  const folderKey = b64(p.key);

  if (folderKey.length !== 16) {
    throw new StepError("bad folder key in the link (the part after #)");
  }

  const raw = await fetchNodes(p.id);
  const nodes = new Map();
  let undecryptable = 0;

  for (const n of raw) {
    const d = decNode(n, folderKey);
    d ? nodes.set(d.h, d) : undecryptable++;
  }

  if (!nodes.size) {
    throw new StepError(raw.length ? "wrong folder key: no file name could be decrypted" : "the folder is empty");
  }

  let top;

  if (p.file) {
    top = nodes.get(p.file);

    if (!top || top.t !== 0) {
      throw new StepError(`file ${p.file} is not in this folder`);
    }
  } else if (p.sub) {
    top = nodes.get(p.sub);

    if (!top || top.t !== 1) {
      throw new StepError(`subfolder ${p.sub} is not in this folder`);
    }
  } else {
    // The shared folder: the folder whose parent is not part of the share.
    top = [...nodes.values()].find((n) => n.t === 1 && !nodes.has(n.p));
  }

  const children = new Map();

  for (const n of nodes.values()) {
    children.has(n.p) ? children.get(n.p).push(n) : children.set(n.p, [n]);
  }

  const files = [];
  let emptyFolders = 0;
  const walk = (n, prefix) => {
    const rel = prefix ? `${prefix}/${cleanName(n.name, n.h)}` : cleanName(n.name, n.h);

    if (n.t === 0) {
      files.push({ url: `https://mega.nz/#N!${n.h}!${n.key}###n=${p.id}`, filename: rel, filekey: n.key, size: Number(n.s) || 0 });
      return;
    }

    const kids = (children.get(n.h) || []).sort((a, b) => a.name.localeCompare(b.name));
    kids.length || emptyFolders++;

    for (const k of kids) {
      walk(k, rel);
    }
  };

  if (top) {
    walk(top, "");
  } else {
    // No folder node (a share of loose files): files go straight into the download folder.
    for (const n of nodes.values()) {
      n.t === 0 && !nodes.has(n.p) && walk(n, "");
    }
  }

  return { folderId: p.id, name: top?.t === 1 ? top.name : undefined, files, emptyFolders, undecryptable };
}

module.exports = { parse, list };
