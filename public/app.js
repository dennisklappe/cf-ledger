/* cf-ledger frontend. Talks to the Worker API, falls back to demo data
   so the page renders before any snapshot exists. No build step. */

const $ = (s) => document.querySelector(s);

const METRIC_LABEL = {
  "workers.requests": "Requests",
  "workers.cpuMs": "CPU time",
  "kv.reads": "KV reads",
  "kv.writes": "KV writes",
  "kv.deletes": "KV deletes",
  "kv.lists": "KV lists",
  "kv.storageGbMonth": "KV storage",
  "r2.classA": "R2 Class A ops",
  "r2.classB": "R2 Class B ops",
  "r2.storageGbMonth": "R2 storage",
  "d1.rowsRead": "D1 rows read",
  "d1.rowsWritten": "D1 rows written",
  "d1.storageGbMonth": "D1 storage",
};
const UNIT_SUFFIX = { storageGbMonth: " GB-mo", cpuMs: " CPU-ms" };

const money = (n) => {
  const [d, c] = Math.abs(n).toFixed(2).split(".");
  const dollars = Number(d).toLocaleString("en-US");
  return `$${dollars}<span class="cents">.${c}</span>`;
};
const moneyFlat = (n) => `$${n.toFixed(2)}`;

function compact(n, metric) {
  const suffix = Object.entries(UNIT_SUFFIX).find(([k]) => metric.endsWith(k))?.[1] || "";
  if (metric.endsWith("storageGbMonth")) return `${n.toFixed(2)}${suffix}`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B${suffix}`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M${suffix}`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K${suffix}`;
  return `${Math.round(n)}${suffix}`;
}

/* cost-heat along the Cloudflare orange ramp: soft amber -> orange -> red */
function heatColor(t) {
  const stops = [
    [0.0, [247, 187, 122]],
    [0.5, [246, 130, 31]],
    [1.0, [255, 75, 60]],
  ];
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
  }
  const f = (b[0] - a[0]) ? (t - a[0]) / (b[0] - a[0]) : 0;
  const c = a[1].map((v, i) => Math.round(v + (b[1][i] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

const GROUP_TITLE = { shared: "Shared resources", standalone: "Standalone / unattributed" };
const GROUP_HINT = {
  shared: "bound to more than one Worker, cost not split",
  standalone: "bound to no Worker. these are the usual cost leaks",
};

function appTitle(a) {
  if (a.group === "app") return { n: a.app, k: "worker + bound resources" };
  return { n: GROUP_TITLE[a.group], k: GROUP_HINT[a.group] };
}

function renderReport(report, isDemo) {
  $("#total").innerHTML = money(report.totalUsd);
  $("#usage").textContent = moneyFlat(report.usageUsd);
  $("#platform").textContent = moneyFlat(report.platformFeeUsd);
  $("#asof").textContent = report.pricingAsOf || "-";
  $("#month-label").textContent = report.month || "this month";

  const costing = report.listPrice ? "List price, free allowances off" : "Billed, matches your invoice";
  const fresh = report.lastUpdated
    ? `Last snapshot ${new Date(report.lastUpdated).toLocaleString()}`
    : "No snapshot recorded yet";
  $("#freshness").innerHTML = `${costing} . ${fresh}`;

  // banner: demo, gaps, or unpriced
  const banner = $("#banner");
  const notes = [];
  if (isDemo) notes.push("Showing <b>demo data</b>. Click <b>Connect Cloudflare</b> and run a snapshot to see your real numbers.");
  if (report.collectionGaps?.length) notes.push(`Partial data: ${report.collectionGaps.length} collection gap(s). Some figures may be missing.`);
  if (report.unpriced?.length) notes.push(`Unpriced metrics seen: <b>${report.unpriced.join(", ")}</b> (not in the pricing table).`);
  if (notes.length) {
    banner.className = "banner" + (isDemo ? " demo" : "");
    banner.innerHTML = notes.join("<br>");
  } else {
    banner.className = "banner hidden";
  }

  // Hide $0 groups/lines when the toggle is on (sub-half-cent counts as zero).
  const visible = (c) => !state.hideZeros || c >= 0.005;
  const apps = report.apps
    .map((a) => ({ ...a, lines: a.lines.filter((l) => visible(l.costUsd)) }))
    .filter((a) => visible(a.totalUsd));
  const maxCost = Math.max(0.01, ...apps.map((a) => a.totalUsd));
  const body = $("#body");

  if (!apps.length) {
    body.innerHTML = `<div class="empty"><div class="big">Nothing to show.</div>
      No billable usage in this window. Hit Refresh to snapshot, or widen the dates.</div>`;
    return;
  }

  const sectionApps = apps.filter((a) => a.group === "app");
  const sectionOther = apps.filter((a) => a.group !== "app");

  body.innerHTML =
    section("Where your money goes", "ranked by estimated cost", sectionApps, maxCost) +
    (sectionOther.length ? section("Shared & unattributed", "watch these for leaks", sectionOther, maxCost) : "");

  wireRows();
}

function section(title, hint, apps, maxCost) {
  return `<div class="section-head"><h2>${title}</h2><span class="hint">${hint}</span></div>
    <div class="rows">${apps.map((a, i) => appRow(a, maxCost, i)).join("")}</div>`;
}

function appRow(a, maxCost, i) {
  const t = appTitle(a);
  const ratio = a.totalUsd / maxCost;
  const color = heatColor(Math.min(1, ratio));
  const lines = [...a.lines].sort((x, y) => y.costUsd - x.costUsd).map(lineRow).join("");
  return `<div class="app ${a.group}" style="animation-delay:${i * 55}ms">
    <div class="summary">
      <span class="chev">&#9654;</span>
      <div class="name"><span class="n">${esc(t.n)}</span><span class="k">${esc(t.k)}</span></div>
      <div class="heat"><i style="width:${(ratio * 100).toFixed(1)}%;background:${color}"></i></div>
      <div class="cost">${money(a.totalUsd)}</div>
    </div>
    <div class="detail"><div class="lines">${lines || emptyLine()}</div></div>
  </div>`;
}

function lineRow(l) {
  const label = METRIC_LABEL[l.metric] || l.metric;
  return `<div class="line">
    <span class="lname"><b>${esc(l.resourceName)}</b> <span style="color:var(--ink-faint)">${label}</span></span>
    <span class="lunits">${compact(l.units, l.metric)}</span>
    <span class="lcost">${moneyFlat(l.costUsd)}</span>
  </div>`;
}
const emptyLine = () => `<div class="line"><span class="lname">no priced usage</span><span></span><span></span></div>`;

function wireRows() {
  document.querySelectorAll(".app .summary").forEach((s) => {
    s.addEventListener("click", () => s.closest(".app").classList.toggle("open"));
  });
}

let chart;
function renderTrends(trends) {
  if (!window.Chart || !trends?.length) return;
  const ctx = $("#trend");
  const labels = trends.map((t) => t.month);
  const data = trends.map((t) => Number(t.totalUsd.toFixed(2)));
  const grad = ctx.getContext("2d").createLinearGradient(0, 0, 0, 280);
  grad.addColorStop(0, "rgba(246,130,31,0.38)");
  grad.addColorStop(1, "rgba(246,130,31,0.0)");
  chart?.destroy();
  chart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets: [{ data, fill: true, backgroundColor: grad, borderColor: "#f6821f", borderWidth: 2, tension: 0.35, pointBackgroundColor: "#f6821f", pointRadius: 4 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => " $" + c.parsed.y.toFixed(2) } } },
      scales: {
        x: { grid: { color: "#1d1d22" }, ticks: { color: "#9a9aa3", font: { family: "Geist Mono" } } },
        y: { grid: { color: "#1d1d22" }, ticks: { color: "#9a9aa3", font: { family: "Geist Mono" }, callback: (v) => "$" + v } },
      },
    },
  });
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ---- BYO (public) mode: key lives in localStorage, sent as headers ---- */
const BYO_KEY = "cf_ledger_key";
const byo = { on: false, key: null };
function loadByoKey() {
  try { byo.key = JSON.parse(localStorage.getItem(BYO_KEY) || "null"); } catch { byo.key = null; }
}
function saveByoKey(k) { byo.key = k; localStorage.setItem(BYO_KEY, JSON.stringify(k)); }
function clearByoKey() { byo.key = null; localStorage.removeItem(BYO_KEY); }
function authHeaders() {
  return byo.on && byo.key ? { "X-CF-Token": byo.key.token, "X-CF-Account-Id": byo.key.accountId } : {};
}

async function getJSON(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), ...authHeaders() } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

/* ---- view state ---- */
const today = () => new Date().toISOString().slice(0, 10);
const firstOfMonth = () => today().slice(0, 7) + "-01";

const state = { from: firstOfMonth(), to: today(), free: 0, hideZeros: true };

/** The picked window is exactly the live current month (so Billed is valid). */
function isFullCurrentMonth(from, to) {
  return from.endsWith("-01") && from.slice(0, 7) === to.slice(0, 7) && to === today();
}

function syncDateInputs() {
  $("#from").value = state.from;
  $("#to").value = state.to;
  $("#from").max = today();
  $("#to").max = today();
}
function syncCostMode() {
  $("#costmode").querySelectorAll(".seg").forEach((b) =>
    b.classList.toggle("active", String(state.free) === b.dataset.free));
}
function setBilledEnabled(enabled) {
  const g = $("#costmode");
  g.classList.toggle("disabled", !enabled);
  g.querySelectorAll(".seg").forEach((b) => (b.disabled = !enabled));
  if (!enabled && state.free !== 0) { state.free = 0; syncCostMode(); }
}

function costUrl() {
  if (isFullCurrentMonth(state.from, state.to)) {
    return `/api/costs?month=${state.from.slice(0, 7)}&free=${state.free}`;
  }
  return `/api/costs?from=${state.from}&to=${state.to}`;
}

async function load() {
  // ?demo forces the sample dataset (used for the README screenshots and a
  // zero-setup preview), regardless of connection state.
  if (new URLSearchParams(location.search).has("demo")) return demo();
  setBilledEnabled(isFullCurrentMonth(state.from, state.to));

  // Public mode with no key yet: prompt for one instead of showing demo.
  if (byo.on && !byo.key) return showKeyPrompt();

  try {
    const report = await getJSON(costUrl());
    if (!report.apps?.length && !byo.on) {
      const connected = await refreshStatus();
      if (!connected) return demo();
    }
    renderReport(report, false);
    // No stored history in public mode, so no month-over-month chart.
    if (byo.on) {
      $("#trends-section").hidden = true;
    } else {
      $("#trends-section").hidden = false;
      const trendsRes = await getJSON("/api/trends").catch(() => ({ trends: [] }));
      renderTrends(trendsRes.trends);
    }
  } catch {
    if (byo.on) { byo.key ? renderError("That key did not work, or Cloudflare is unreachable.") : showKeyPrompt(); }
    else demo();
  }
}

function showKeyPrompt() {
  $("#trends-section").hidden = true;
  $("#banner").className = "banner hidden";
  $("#total").innerHTML = "$0<span class='cents'>.00</span>";
  $("#freshness").textContent = "Enter a read-only API key to see your costs";
  $("#body").innerHTML = `<div class="empty"><div class="big">Bring your own key.</div>
    Enter a read-only Cloudflare API token. It is stored only in your browser and never saved on this server.
    <div style="margin-top:18px"><button class="refresh" id="key-cta">Enter API key</button></div></div>`;
  $("#key-cta").addEventListener("click", openModal);
}

function renderError(msg) {
  $("#body").innerHTML = `<div class="empty"><div class="big">Could not load.</div>${esc(msg)}</div>`;
}

$("#from").addEventListener("change", (e) => { state.from = e.target.value; load(); });
$("#to").addEventListener("change", (e) => { state.to = e.target.value; load(); });
$("#thismonth").addEventListener("click", () => {
  state.from = firstOfMonth(); state.to = today(); syncDateInputs(); load();
});
$("#costmode").addEventListener("click", (e) => {
  const b = e.target.closest(".seg");
  if (!b || b.disabled) return;
  state.free = Number(b.dataset.free); syncCostMode(); load();
});
$("#hidezeros").addEventListener("change", (e) => { state.hideZeros = e.target.checked; load(); });

/* Backfill the retained window (30 days) so the current month is complete. */
async function takeSnapshot() {
  const btn = $("#refresh");
  const prev = btn.textContent;
  btn.disabled = true; btn.textContent = "Building (30 days)...";
  try {
    await fetch("/api/refresh", { method: "POST" });
  } catch {}
  btn.disabled = false; btn.textContent = prev || "Refresh";
  await load();
}
$("#refresh").addEventListener("click", takeSnapshot);

/* ---- connection state: drives the header (Connect button vs account chip) ---- */
async function refreshStatus() {
  let s = { connected: false, accountId: null, protected: true, mode: "managed" };
  if (new URLSearchParams(location.search).has("demo")) {
    s = { connected: false, accountId: null, protected: true, mode: "managed" };
  } else {
    try { s = await getJSON("/api/status"); } catch {}
  }

  byo.on = s.mode === "byo";
  const connBtn = $("#connect"), chip = $("#conn"), refresh = $("#refresh"), warn = $("#secwarn");

  if (byo.on) {
    // Public mode is intentionally open; the key lives only in the browser.
    warn.classList.add("hidden");
    loadByoKey();
    refresh.hidden = true; // nothing to snapshot server-side
    if (byo.key) {
      connBtn.hidden = true; chip.hidden = false;
      $("#conn-acct").textContent = `key ${mask(byo.key.accountId)}`;
      $("#disconnect").textContent = "forget key";
    } else {
      connBtn.hidden = false; chip.hidden = true;
      connBtn.textContent = "Enter API key";
    }
    return !!byo.key;
  }

  // Managed mode: warn loudly if not behind Cloudflare Access.
  if (s.protected === false) {
    warn.classList.remove("hidden");
    warn.innerHTML = "<b>Not protected.</b> Anyone with this URL can see your cost data. Put it behind Cloudflare Access (Zero Trust) so it requires a login. See the README.";
  } else {
    warn.classList.add("hidden");
  }
  if (s.connected) {
    connBtn.hidden = true; chip.hidden = false; refresh.hidden = false;
    $("#conn-acct").textContent = `account ${s.accountId || ""}`.trim();
  } else {
    connBtn.hidden = false; chip.hidden = true; refresh.hidden = true;
  }
  return s.connected;
}

const mask = (id) => (id && id.length > 4 ? "****" + id.slice(-4) : "****");

const modal = $("#modal");
const openModal = () => {
  $("#f-err").textContent = "";
  // Public mode: make it explicit the key stays in the browser.
  if (byo.on) {
    $("#modal-desc").textContent = "Paste a read-only API token and your account id. They are stored only in your browser (localStorage) and sent with each request, never saved or logged on this server.";
    $("#modal-warn").innerHTML = "Use a <b>read-only</b> token. For full control, self-host (same open-source code).";
    $("#f-connect").textContent = "Save key";
  }
  modal.classList.add("open");
  $("#f-token").focus();
};
const closeModal = () => modal.classList.remove("open");

$("#connect").addEventListener("click", openModal);
$("#f-cancel").addEventListener("click", closeModal);
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

$("#f-connect").addEventListener("click", async () => {
  const btn = $("#f-connect"), err = $("#f-err");
  const token = $("#f-token").value.trim();
  const accountId = $("#f-account").value.trim();
  err.textContent = "";
  if (!token || !accountId) { err.textContent = "Both fields are required."; return; }
  btn.disabled = true; btn.textContent = "Validating...";
  try {
    if (byo.on) {
      // Public mode: verify against Cloudflare, then keep the key in the browser.
      const res = await fetch("/api/verify", {
        method: "POST",
        headers: { "X-CF-Token": token, "X-CF-Account-Id": accountId },
      });
      const out = await res.json();
      if (!res.ok || !out.ok) throw new Error(out.error || "Could not verify that key.");
      saveByoKey({ token, accountId });
      $("#f-token").value = ""; $("#f-account").value = "";
      closeModal();
      await refreshStatus();
      await load();
    } else {
      const res = await fetch("/api/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, accountId }),
      });
      const out = await res.json();
      if (!res.ok || !out.ok) throw new Error(out.error || "Could not connect.");
      $("#f-token").value = ""; $("#f-account").value = "";
      closeModal();
      await refreshStatus();
      await takeSnapshot();
    }
  } catch (e) {
    err.textContent = e.message;
  } finally {
    btn.disabled = false; btn.textContent = byo.on ? "Save key" : "Connect";
  }
});

$("#disconnect").addEventListener("click", async () => {
  if (byo.on) {
    if (!confirm("Forget your API key from this browser?")) return;
    clearByoKey();
    await refreshStatus();
    return load();
  }
  if (!confirm("Disconnect this Cloudflare account from the dashboard?")) return;
  try { await fetch("/api/disconnect", { method: "POST" }); } catch {}
  await refreshStatus();
  load();
});

/* ---- demo data: realistic shape, makes the UI legible before deploy ---- */
function demo() {
  const apps = [
    { app: "image-resizer", group: "app", totalUsd: 41.83, lines: [
      { resourceName: "image-resizer", metric: "workers.requests", units: 138_000_000, costUsd: 38.4 },
      { resourceName: "image-resizer", metric: "workers.cpuMs", units: 92_000_000, costUsd: 1.24 },
      { resourceName: "img-cache", metric: "kv.reads", units: 41_000_000, costUsd: 2.19 },
    ]},
    { app: "api-gateway", group: "app", totalUsd: 12.07, lines: [
      { resourceName: "api-gateway", metric: "workers.requests", units: 54_000_000, costUsd: 9.9 },
      { resourceName: "api-gateway", metric: "workers.cpuMs", units: 61_000_000, costUsd: 0.62 },
      { resourceName: "sessions", metric: "kv.writes", units: 1_300_000, costUsd: 1.55 },
    ]},
    { app: "blog", group: "app", totalUsd: 2.41, lines: [
      { resourceName: "blog", metric: "workers.requests", units: 9_200_000, costUsd: 1.9 },
      { resourceName: "blog-db", metric: "d1.rowsRead", units: 480_000_000, costUsd: 0.51 },
    ]},
    { app: "__shared__", group: "shared", totalUsd: 6.6, lines: [
      { resourceName: "assets", metric: "r2.classA", units: 2_100_000, costUsd: 4.95 },
      { resourceName: "assets", metric: "r2.storageGbMonth", units: 110, costUsd: 1.65 },
    ]},
    { app: "__standalone__", group: "standalone", totalUsd: 18.2, lines: [
      { resourceName: "old-backups", metric: "r2.storageGbMonth", units: 1180, costUsd: 17.55 },
      { resourceName: "legacy-kv", metric: "kv.writes", units: 540_000, costUsd: 0.65 },
    ]},
  ];
  const usageUsd = apps.reduce((s, a) => s + a.totalUsd, 0);
  const month = new Date().toISOString().slice(0, 7);
  renderReport({ month, pricingAsOf: "2026-05-30", platformFeeUsd: 5, usageUsd, totalUsd: usageUsd + 5, apps, unpriced: [], collectionGaps: [], lastUpdated: null, listPrice: false }, true);
  renderTrends([
    { month: monthShift(month, -3), totalUsd: 58.1 }, { month: monthShift(month, -2), totalUsd: 71.4 },
    { month: monthShift(month, -1), totalUsd: 66.9 }, { month, totalUsd: usageUsd + 5 },
  ]);
}
function monthShift(m, d) {
  const [y, mo] = m.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1 + d, 1));
  return dt.toISOString().slice(0, 7);
}

(async () => {
  syncDateInputs();
  syncCostMode();
  await refreshStatus();
  await load();
  if (location.hash === "#connect") openModal();
})();
