const http = require("http");
const crypto = require("crypto");
const { z } = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { config, StepError } = require("./lib/config");
const jd = require("./lib/jdownloader");
const mb = require("./lib/megabasterd");

const INFO = { name: "downloads", version: "0.1.0" };
const MAX_BODY_BYTES = 1024 * 1024;
const CLIENTS = { jdownloader: jd, megabasterd: mb };

// MCP_TOKEN = every tool; MCP_READ_TOKEN (optional) = status only. No MCP_TOKEN = everything refused.
function access(header) {
  const got = crypto.createHash("sha256").update(String(header || "")).digest();
  const is = (token) => token && crypto.timingSafeEqual(crypto.createHash("sha256").update(`Bearer ${token}`).digest(), got);

  if (!config.mcpToken) {
    return null;
  }

  return is(config.mcpToken) ? "full" : is(config.mcpReadToken) ? "read" : null;
}

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

const errText = (e) => (e instanceof StepError || e.code ? e.message : "Unexpected error (see the MCP container log)");

function wrap(fn) {
  return async (args) => {
    try {
      return ok(await fn(args || {}));
    } catch (e) {
      if (!(e instanceof StepError)) {
        console.error(e);
      }

      return { content: [{ type: "text", text: errText(e) }], isError: true };
    }
  };
}

async function status({ client = "all", ...opts }) {
  const names = client === "all" ? Object.keys(CLIENTS) : [client];
  const out = {};

  for (const n of names) {
    try {
      out[n] = await CLIENTS[n].status(opts);
    } catch (e) {
      if (!(e instanceof StepError)) {
        console.error(e);
      }

      out[n] = { client: n, error: errText(e) };
    }
  }

  return out;
}

// No client given: MEGA file and folder links → MegaBasterd, everything else → JDownloader.
async function add({ links, client, ...opts }) {
  const list = [...new Set(links.map((l) => l.trim()).filter(Boolean))];

  if (!list.length) {
    throw new StepError("No links given");
  }

  const groups = client ? { [client]: list } : { megabasterd: list.filter((l) => mb.isMegaLink(l)), jdownloader: list.filter((l) => !mb.isMegaLink(l)) };
  const out = {};

  for (const [n, l] of Object.entries(groups)) {
    if (!l.length) {
      continue;
    }

    if (n === "megabasterd") {
      const ignored = ["package_name", "folder", "password", "archive_password"].filter((k) => opts[k] !== undefined);
      out[n] = await mb.add({ links: l, start: opts.start });

      if (ignored.length) {
        out[n].ignored_options = `${ignored.join(", ")}: not supported by MegaBasterd`;
      }
    } else {
      out[n] = await jd.add({ links: l, ...opts });
    }
  }

  return out;
}

const clientArg = z.enum(["jdownloader", "megabasterd"]);
const idsArg = z.array(z.string()).optional();

function registerTools(server, level) {
  server.registerTool(
    "status",
    {
      title: "Download status",
      description:
        "Downloads in JDownloader and/or MegaBasterd: container state, overall speed, and each item with its id, state (downloading, queued, stopped, finished…), size, progress, speed and ETA. Ids are needed by start/stop/delete: JDownloader L… (file) and P… (package), G…/GP… (link grabber, not downloading yet); MegaBasterd M… (file) and O… (leftover chunk folder).",
      inputSchema: {
        client: z.enum(["all", "jdownloader", "megabasterd"]).optional().describe("Default all"),
        include_finished: z.boolean().optional().describe("Also list finished items (default true)"),
        max_items: z.number().int().min(1).max(1000).optional().describe(`Items listed per client (default ${config.maxItems})`),
      },
      annotations: { readOnlyHint: true },
    },
    wrap((a) => status(a)),
  );

  if (level !== "full") {
    return;
  }

  server.registerTool(
    "add_downloads",
    {
      title: "Add downloads",
      description:
        "Queue links for download. Without client: MEGA links (files and folders) go to MegaBasterd, everything else to JDownloader. Both can take MEGA folder links: MegaBasterd adds every file of the folder (keeping its subfolders) to its default folder; client jdownloader is the choice when a MEGA folder should go to a specific folder or package. JDownloader options: package_name, folder (under /output or /output_hdd), passwords; it checks links first (a folder is expanded into its files), then starts (start: false = leave them in the link grabber). MegaBasterd is restarted briefly to take the links (running downloads resume).",
      inputSchema: {
        links: z.array(z.string().min(1)).min(1).max(200),
        client: clientArg.optional(),
        package_name: z.string().optional().describe("JDownloader only"),
        folder: z.string().optional().describe("JDownloader only: target folder as JDownloader sees it (/output/… = appdata downloads, /output_hdd/… = media-other/jDownloader)"),
        start: z.boolean().optional().describe("Start downloading right away (default true)"),
        password: z.string().optional().describe("JDownloader only: download (link) password"),
        archive_password: z.string().optional().describe("JDownloader only: password for extracting archives"),
      },
    },
    wrap((a) => add(a)),
  );

  server.registerTool(
    "start_downloads",
    {
      title: "Start downloads",
      description:
        "Start or resume downloads. Without ids: everything (JDownloader: starts/unpauses its downloader; MegaBasterd: starts its container if stopped). With ids from status: those items (JDownloader link-grabber G/GP items are moved to the download list; force: true starts them even past the parallel-download limit).",
      inputSchema: { client: clientArg, ids: idsArg, force: z.boolean().optional().describe("JDownloader only") },
    },
    wrap(({ client, ...a }) => CLIENTS[client].start(a)),
  );

  server.registerTool(
    "stop_downloads",
    {
      title: "Stop downloads",
      description:
        "Stop downloads, keeping partial data so start_downloads resumes them. Without ids: everything (JDownloader: stops its downloader; MegaBasterd: stops its container, its only global pause). With ids: only those (JDownloader disables them; MegaBasterd takes them out of its list, restarting it briefly).",
      inputSchema: { client: clientArg, ids: idsArg },
    },
    wrap(({ client, ...a }) => CLIENTS[client].stop(a)),
  );

  server.registerTool(
    "delete_downloads",
    {
      title: "Delete downloads",
      description:
        "Remove items from the download list (ids from status), or all finished ones (remove_finished: true). Files stay on disk unless delete_files: true, which also deletes partial AND completed files of those items: ask the user before using it. MegaBasterd O… ids (leftover chunk folders) are always deleted from disk.",
      inputSchema: {
        client: clientArg,
        ids: idsArg,
        delete_files: z.boolean().optional().describe("Also delete the items' files (default false)"),
        remove_finished: z.boolean().optional().describe("Clear all finished items from the list (files kept)"),
      },
      annotations: { destructiveHint: true },
    },
    wrap(({ client, ...a }) => CLIENTS[client].remove(a)),
  );

  server.registerTool(
    "enable_jdownloader_api",
    {
      title: "Enable JDownloader's local API",
      description:
        "One-time setup: turns on JDownloader's local API (localhost only), which every JDownloader tool needs. Restarts JDownloader. Without apply: true it only reports whether it is on and what it would do.",
      inputSchema: { apply: z.boolean().optional() },
      annotations: { idempotentHint: true },
    },
    wrap((a) => jd.enableApi(a)),
  );
}

function send(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const httpServer = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0].replace(/\/+$/, "") || "/";

  if (url === "/health") {
    return send(res, 200, { ok: true });
  }

  if (url !== "/mcp" && url !== "/") {
    return send(res, 404, { error: "not found" });
  }

  const level = access(req.headers.authorization);

  if (!level) {
    return send(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  }

  const chunks = [];
  let size = 0;

  try {
    for await (const chunk of req) {
      size += chunk.length;

      if (size > MAX_BODY_BYTES) {
        res.setHeader("Connection", "close");
        return send(res, 413, { jsonrpc: "2.0", error: { code: -32600, message: "Request body too large" }, id: null });
      }

      chunks.push(chunk);
    }
  } catch {
    return; // The client went away mid-request.
  }

  let body;

  try {
    body = size ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : undefined;
  } catch {
    return send(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
  }

  // Stateless Streamable HTTP: a fresh server and transport per request.
  const server = new McpServer(INFO);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    registerTools(server, level);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    console.error(e);

    if (!res.headersSent) {
      send(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

if (require.main === module) {
  httpServer.listen(config.port, () => {
    console.log(`${INFO.name} MCP ${INFO.version} on :${config.port}/mcp; JDownloader ${config.jd.container}, MegaBasterd ${config.mb.container} (${config.mb.paths.map((m) => `${m.path}=${m.local}`).join(", ")})`);

    if (!config.mcpToken) {
      console.log("MCP_TOKEN is not set: every /mcp request is refused (401).");
    }

    if (!jd.readApiConfig()?.deprecatedapienabled) {
      console.log("JDownloader's local API is off: call the enable_jdownloader_api tool once.");
    }
  });
}

module.exports = { registerTools, httpServer };
