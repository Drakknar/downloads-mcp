// All settings come from the container's environment.
const path = require("path");
const env = process.env;

const dir = (value) => {
  const v = String(value).trim();
  return v ? path.posix.normalize(v).replace(/\/+$/, "") : "";
};
const list = (value) => String(value).split(",").map(dir).filter(Boolean);

// "container=local,container2=local2": how a downloader's own paths map to this container's mounts.
function pathMap(value) {
  return String(value)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const eq = x.indexOf("=");
      return eq < 0 ? { path: dir(x), local: x } : { path: dir(x.slice(0, eq)), local: x.slice(eq + 1).trim().replace(/[\\/]+$/, "") };
    })
    .filter((m) => m.path.startsWith("/") && m.local);
}

const config = {
  port: Number(env.PORT || 8080),
  mcpToken: env.MCP_TOKEN || "",
  mcpReadToken: env.MCP_READ_TOKEN || "", // optional: status only

  jd: {
    container: env.JD_CONTAINER || "jdownloader2",
    // JDownloader's /config, mounted here (for enable_jdownloader_api).
    configDir: env.JD_CONFIG_MOUNT || "/jd",
    // JD's local HTTP API ("Deprecated API"), reached with docker exec inside the JD container, so it stays localhost-only.
    apiPort: Number(env.JD_API_PORT || 3128),
    // add_downloads folder must be under one of these (paths as JDownloader sees them).
    folders: list(env.JD_FOLDERS || "/output,/output_hdd"),
  },

  mb: {
    container: env.MB_CONTAINER || "megabasterd",
    // MegaBasterd's paths → where this container mounts them. The first entry holds MegaBasterd's home (DB).
    paths: pathMap(env.MB_PATHS || "/config=/mb,/output=/mb-output"),
    stateFile: env.MB_STATE_FILE || "/data/megabasterd.json",
    // Items that left MegaBasterd's queue (finished/gone) are kept in the state file this long.
    keepDays: Number(env.MB_KEEP_DAYS ?? 14),
    // A MEGA folder becomes one row per file; bigger folders are refused (MegaBasterd provisions them all at start-up).
    maxFolderFiles: Number(env.MB_MAX_FOLDER_FILES || 5000),
  },

  // MEGA's public API, used to list folder links for MegaBasterd.
  megaApi: (env.MEGA_API_URL || "https://g.api.mega.co.nz").replace(/\/+$/, ""),

  ownerUid: Number(env.OWNER_UID || 99),
  ownerGid: Number(env.OWNER_GID || 100),
  dockerSocket: env.DOCKER_SOCKET || "/var/run/docker.sock",
  dockerHost: env.DOCKER_HOST_URL || "", // tests: http://127.0.0.1:port instead of the socket
  maxItems: Number(env.MAX_ITEMS || 100),
};

class StepError extends Error {}

module.exports = { config, StepError };
