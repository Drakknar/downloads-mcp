// Compact, model-friendly values: "19.2 GB", "45.3%", "12.1 MB/s", "1h 5m".
function size(bytes) {
  if (bytes == null || bytes < 0 || !Number.isFinite(bytes)) {
    return undefined;
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;

  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }

  return `${i ? v.toFixed(1) : v} ${units[i]}`;
}

const speed = (bps) => (bps > 0 ? `${size(bps)}/s` : undefined);

function percent(done, total) {
  return total > 0 && done >= 0 ? `${Math.min(100, Math.floor((done / total) * 1000) / 10)}%` : undefined;
}

function duration(seconds) {
  if (!(seconds > 0) || !Number.isFinite(seconds)) {
    return undefined;
  }

  const s = Math.round(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

// Drops undefined fields so results stay short.
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));

module.exports = { size, speed, percent, duration, clean };
