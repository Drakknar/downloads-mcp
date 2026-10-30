# downloads MCP

MCP server (Streamable HTTP, stateless, `POST /mcp`) for the `jdownloader2` (jlesage/jdownloader-2) and `megabasterd` (mietzen/megabasterd) containers. Meant to be used through an MCP gateway such as LiteLLM.

Image: `ghcr.io/drakknar/downloads-mcp` (Node ≥ 22.13 for `node:sqlite`), port 8080. Mounts: `/data`, JDownloader's `/config` at `/jd`, MegaBasterd's `/config` and `/output` at `/mb` and `/mb-output` (the same host paths the downloaders use, so SQLite locking works), `/var/run/docker.sock`.

## Tools

| Tool | Token | What it does |
|---|---|---|
| `status` | read | per client: container state, items with id, state, size, progress, speed, ETA; JD downloader state + link grabber; MegaBasterd finished/gone items and leftover chunk folders |
| `add_downloads` | full | links → MEGA links (files and folders) to MegaBasterd, everything else to JD, unless `client` is given (both take MEGA folders). JD: `package_name`, `folder` (under `/output` or `/output_hdd`), passwords, `start` |
| `start_downloads` | full | no ids: everything (starts the container if needed); ids: those items (`force` for JD) |
| `stop_downloads` | full | no ids: JD downloader stop / MegaBasterd container stop; ids: those items, progress kept |
| `delete_downloads` | full | ids or `remove_finished`; `delete_files` also deletes their files |
| `enable_jdownloader_api` | full | one-time: turns on JD's local API (see below), restarts JD; plan only without `apply: true` |

Ids: JD `L<uuid>` link, `P<uuid>` package, `G…`/`GP…` link grabber; MegaBasterd `M<sha1(url)[0:10]>`, `O…` leftover chunk folder.

## How each client is driven

**JDownloader**: its local HTTP API ("Deprecated API", `cfg/org.jdownloader.api.RemoteAPIConfig.json`: `deprecatedapienabled`, localhost only, port 3128), called with `docker exec jdownloader2 curl|wget http://127.0.0.1:3128/<route>?<JSON param>&…`. Nothing is published on the network. No MyJDownloader account needed.

**MegaBasterd** has no API. At start-up it resumes every row of `downloads` and every URL in `downloads_queue` (SQLite, `/config/MegaBasterd/.megabasterd<version>/megabasterd.db`, portable mode). So add / stop-one / start-one / delete = stop container → edit DB → start (running downloads resume from `.mctemp` + `.MEGABASTERD_CHUNKS_<sha1(url)>`). Its resume path only parses legacy links, so `mega.nz/file/ID#KEY` is stored as `https://mega.nz/#!ID!KEY`. Folder links (`mega.nz/folder/ID#KEY[/folder/SUB|/file/H]`, legacy `#F!ID[@SUB]!KEY`) are listed through MEGA's public API (`MEGA_API_URL`, default `https://g.api.mega.co.nz`; node keys AES-ECB with the folder key, names AES-CBC) and written as one `downloads` row per file, exactly as its folder dialog does: url `https://mega.nz/#N!<handle>!<file key>###n=<folder id>`, path = default folder, filename = `Folder/Sub/file` (empty folders skipped; files already on disk with the same size skipped; more than `MB_MAX_FOLDER_FILES` = 5000 files refused). New links go to its default folder (setting `default_down_dir`). A stopped single item = its row parked in `/data/megabasterd.json`, which also remembers names/sizes so finished items (row gone, full file on disk) and failed ones ("gone") can be reported. Errors such as MEGA quota show only in its window.

## Tests

`node test/fake-docker.test.js` (Node 22.13+): fake Docker API with a fake JD API behind exec and a fake MegaBasterd start-up on a real SQLite DB in MegaBasterd's schema, fake MEGA API with an encrypted folder; real MCP client. The folder decryption was also checked against a real public MEGA folder.
