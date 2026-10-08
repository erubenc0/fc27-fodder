/* FC27 Fodder Tracker: renders data/snapshots.json into a board, a paper trader and one chart per rating. */
(function () {
  "use strict";

  const RATINGS = [81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91];
  const DAY = 86400;
  const TAX = 0.05;
  const RULES = {
    windowDays: 7,      // fair price = median of readings in this many previous days
    minReadings: 6,     // readings needed before fair price counts
    buyBelow: 0.90,     // buy at or under 90% of fair
    budget: 50000,      // coins per position
    takeProfit: 0.06,   // sell once profit after tax reaches 6%
    maxHoldDays: 7,
    stopLoss: 0.80,     // sell if price falls to 80% of cost
  };
  const SIGNAL_RICH = 1.15;

  const state = { platform: "console", view: "line", db: null, events: [], charts: [] };
  const fmt = new Intl.NumberFormat("en-US");
  const etParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const etShort = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  const etDay = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });

  try {
    const saved = localStorage.getItem("fc27-platform");
    if (saved === "pc" || saved === "console") state.platform = saved;
    const view = localStorage.getItem("fc27-view");
    if (view === "line" || view === "candles") state.view = view;
  } catch (e) { /* storage unavailable */ }

  // ---------- helpers ----------
  const trim = (x, d) => x.toFixed(d).replace(/\.?0+$/, "");
  const coins = (n) => (n == null ? "–" : n >= 1e6 ? trim(n / 1e6, 2) + "M" : n >= 10000 ? trim(n / 1000, 2) + "k" : fmt.format(Math.round(n)));
  const pct = (x) => (x == null || !isFinite(x) ? "–" : (x >= 0 ? "+" : "−") + Math.abs(x * 100).toFixed(1) + "%");
  const cls = (x) => (x == null ? "dim" : x > 0.0005 ? "pos" : x < -0.0005 ? "neg" : "dim");
  const median = (a) => {
    const s = a.slice().sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function parseIso(iso) {
    // Data uses "YYYY-MM-DDTHH:MMZ".
    const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(iso);
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000;
  }

  // The trading day a reading belongs to: the 5pm Eastern close it leads up to.
  function closeDay(sec, kind) {
    const p = Object.fromEntries(etParts.formatToParts(new Date(sec * 1000)).map((x) => [x.type, x.value]));
    let d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
    const mins = +p.hour * 60 + +p.minute;
    if (kind !== "close" && mins >= 17 * 60) d = new Date(d.getTime() + DAY * 1000);
    return d.toISOString().slice(0, 10);
  }

  function seriesFor(platform, rating) {
    const out = [];
    for (const s of state.db.snapshots) {
      const v = s[platform] && s[platform][String(rating)];
      if (v && v[0]) out.push({ t: parseIso(s.t), iso: s.t, v: v[0], name: v[1], kind: s.kind || "intraday" });
    }
    return out;
  }

  function withFair(pts) {
    for (let i = 0; i < pts.length; i++) {
      const from = pts[i].t - RULES.windowDays * DAY;
      const prev = [];
      for (let j = i - 1; j >= 0 && pts[j].t >= from; j--) prev.push(pts[j].v);
      pts[i].fair = prev.length >= RULES.minReadings ? median(prev) : null;
    }
    return pts;
  }

  // ---------- paper trader ----------
  function simulate(rating, pts) {
    const trades = [];
    let open = null;
    for (const p of pts) {
      if (open) {
        const net = p.v * (1 - TAX);
        let why = null;
        if (net >= open.cost * (1 + RULES.takeProfit)) why = "Profit target";
        else if (p.v <= open.cost * RULES.stopLoss) why = "Stop loss";
        else if (p.t - open.t >= RULES.maxHoldDays * DAY) why = "Held 7 days";
        if (why) {
          Object.assign(open, { sellT: p.t, sell: p.v, why, profit: Math.round((net - open.cost) * open.qty) });
          trades.push(open);
          open = null;
          continue;
        }
      } else if (p.fair && p.v <= p.fair * RULES.buyBelow) {
        const qty = Math.floor(RULES.budget / p.v);
        if (qty > 0) open = { rating, t: p.t, cost: p.v, qty };
      }
    }
    if (open) {
      const last = pts[pts.length - 1];
      open.mark = last.v;
      open.unrealised = Math.round((last.v * (1 - TAX) - open.cost) * open.qty);
      trades.push(open);
    }
    return trades;
  }

  // ---------- rendering ----------
  function render() {
    state.charts.forEach((c) => c.remove());
    state.charts = [];
    const platform = state.platform;
    const all = RATINGS.map((r) => ({ r, pts: withFair(seriesFor(platform, r)) }));
    all.forEach((x) => (x.trades = simulate(x.r, x.pts)));

    renderUpdated();
    renderBoard(all);
    renderSim(all);
    renderCharts(all);
  }

  function renderUpdated() {
    const snaps = state.db.snapshots.filter((s) => s[state.platform]);
    const last = snaps[snaps.length - 1];
    const close = [...snaps].reverse().find((s) => s.kind === "close");
    const parts = [];
    if (last) parts.push("Latest reading " + etShort.format(new Date(parseIso(last.t) * 1000)) + " Eastern");
    if (close) parts.push("last 5pm close " + etShort.format(new Date(parseIso(close.t) * 1000)).replace(/,.*/, ""));
    else parts.push("first 5pm close comes today");
    parts.push(state.platform === "console" ? "Console (PlayStation and Xbox)" : "PC");
    document.getElementById("updated").textContent = parts.join(" · ");
  }

  function renderBoard(all) {
    const body = document.querySelector("#board tbody");
    body.innerHTML = all.map(({ r, pts }) => {
      if (!pts.length) return `<tr><td>${r}</td><td colspan="5" class="dim">No readings yet</td></tr>`;
      const last = pts[pts.length - 1];
      // Previous close: the last 5pm close before the latest reading, else the reading about a day earlier.
      let ref = null;
      for (let i = pts.length - 2; i >= 0; i--) if (pts[i].kind === "close") { ref = pts[i]; break; }
      if (!ref) ref = [...pts].reverse().find((p) => p.t <= last.t - DAY + 3600) || null;
      const chg = ref ? last.v / ref.v - 1 : null;
      const fairNow = medianOfWindow(pts, last.t);
      const vsFair = fairNow ? last.v / fairNow - 1 : null;
      let sig = '<span class="pill normal">Normal</span>';
      if (fairNow == null) sig = '<span class="dim">Building history</span>';
      else if (last.v <= fairNow * RULES.buyBelow) sig = '<span class="pill cheap">Cheap</span>';
      else if (last.v >= fairNow * SIGNAL_RICH) sig = '<span class="pill rich">Expensive</span>';
      return `<tr>
        <td><a href="#r${r}">${r}</a></td>
        <td>${coins(last.v)}</td>
        <td>${esc(last.name || "")}</td>
        <td class="${cls(chg)}">${pct(chg)}</td>
        <td class="${cls(vsFair)}">${pct(vsFair)}</td>
        <td>${sig}</td></tr>`;
    }).join("");
  }

  // Fair price "now" includes the latest reading's own window (the previous 7 days up to it).
  function medianOfWindow(pts, t) {
    const vals = pts.filter((p) => p.t > t - RULES.windowDays * DAY && p.t <= t).map((p) => p.v);
    return vals.length >= RULES.minReadings ? median(vals) : null;
  }

  function renderSim(all) {
    const trades = all.flatMap((x) => x.trades);
    const closed = trades.filter((t) => t.sellT);
    const openT = trades.filter((t) => !t.sellT);
    const realised = closed.reduce((a, t) => a + t.profit, 0);
    const unreal = openT.reduce((a, t) => a + t.unrealised, 0);
    const wins = closed.filter((t) => t.profit > 0).length;
    const span = state.db.snapshots.filter((s) => s[state.platform]);
    const days = span.length ? (parseIso(span[span.length - 1].t) - parseIso(span[0].t)) / DAY : 0;
    const tiles = [
      ["Profit after tax (closed)", coins(realised), cls(realised)],
      ["Open positions", openT.length + (openT.length ? " · " + (unreal >= 0 ? "+" : "−") + coins(Math.abs(unreal)) : ""), cls(unreal)],
      ["Trades closed", closed.length + (closed.length ? " · " + Math.round((wins / closed.length) * 100) + "% won" : ""), ""],
      ["History", days.toFixed(1) + " days", ""],
    ];
    document.getElementById("sim-tiles").innerHTML = tiles.map(([k, v, c]) =>
      `<div class="tile"><div class="k">${k}</div><div class="v ${c}">${v}</div></div>`).join("");

    const body = document.querySelector("#trades tbody");
    const rows = trades.sort((a, b) => b.t - a.t);
    if (!rows.length) {
      const need = days < RULES.windowDays
        ? `The trader needs about ${RULES.windowDays} days of ${state.platform === "console" ? "console" : "PC"} history to judge a fair price, so it hasn't traded yet.`
        : "No rating has dipped 10% below its fair price yet, so the trader is waiting.";
      body.innerHTML = "";
      document.getElementById("trades-empty").textContent = need;
      document.getElementById("trades-wrap").hidden = true;
      return;
    }
    document.getElementById("trades-empty").textContent = "";
    document.getElementById("trades-wrap").hidden = false;
    const when = (t) => etShort.format(new Date(t * 1000));
    body.innerHTML = rows.map((t) => `<tr>
      <td><a href="#r${t.rating}">${t.rating}</a></td>
      <td>${when(t.t)}</td><td>${t.qty}</td><td>${coins(t.cost)}</td>
      <td>${t.sellT ? when(t.sellT) : '<span class="dim">Holding</span>'}</td>
      <td>${t.sellT ? coins(t.sell) : coins(t.mark)}</td>
      <td class="${cls(t.sellT ? t.profit : t.unrealised)}">${t.sellT ? (t.profit >= 0 ? "+" : "−") + coins(Math.abs(t.profit)) : "(" + (t.unrealised >= 0 ? "+" : "−") + coins(Math.abs(t.unrealised)) + ")"}</td>
      <td>${t.why || '<span class="dim">Open</span>'}</td></tr>`).join("");
  }

  function renderCharts(all) {
    const wrap = document.getElementById("charts");
    wrap.innerHTML = "";
    const colors = {
      text: css("--text-2"), grid: css("--grid"), line: css("--accent"), fair: css("--fair"),
      up: css("--up"), down: css("--down"), event: css("--event"), border: css("--border"),
    };
    const platformName = state.platform === "console" ? "Console" : "PC";

    for (const { r, pts, trades } of all) {
      const card = document.createElement("article");
      card.className = "card";
      card.id = "r" + r;
      const last = pts[pts.length - 1];
      card.innerHTML = `
        <div class="card-head"><h3>${r}-rated fodder · ${platformName}</h3><span class="price">${last ? coins(last.v) : "–"}</span></div>
        <div class="card-meta">${last ? `<span>Cheapest: ${esc(last.name || "–")}</span>` : ""}<span>${pts.length} readings</span></div>
        <div class="legend"><span><i class="key" style="border-color:${colors.line}"></i>Price</span><span><i class="key fair" style="border-color:${colors.fair}"></i>7-day fair</span><span><span style="color:${colors.up}">▲</span> sim buy <span style="color:${colors.down}">▼</span> sim sell</span></div>`;
      const box = document.createElement("div");
      wrap.appendChild(card);
      if (pts.length < 2) {
        box.className = "empty";
        box.textContent = "Not enough readings yet. The chart fills in as daily prices arrive.";
        card.appendChild(box);
        continue;
      }
      box.className = "chart";
      box.setAttribute("role", "img");
      box.setAttribute("aria-label", `${r}-rated ${platformName} fodder price chart`);
      card.appendChild(box);
      state.charts.push(drawChart(box, r, pts, trades, colors));
    }
  }

  function drawChart(box, rating, pts, trades, colors) {
    const candles = state.view === "candles";
    const chart = LightweightCharts.createChart(box, {
      autoSize: true,
      layout: { background: { type: "solid", color: "transparent" }, textColor: colors.text, fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderColor: colors.border },
      timeScale: {
        borderColor: colors.border, timeVisible: !candles, secondsVisible: false,
        tickMarkFormatter: (time) => tickLabel(time),
      },
      localization: { timeFormatter: (time) => tickLabel(time, true), priceFormatter: (p) => fmt.format(Math.round(p)) },
      crosshair: { mode: 0 },
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: false },
    });

    let main;
    const keyOf = candles ? (p) => closeDay(p.t, p.kind) : (p) => p.t;
    if (candles) {
      main = chart.addCandlestickSeries({
        upColor: colors.up, downColor: colors.down, borderVisible: false,
        wickUpColor: colors.up, wickDownColor: colors.down,
      });
      const days = new Map();
      for (const p of pts) {
        const k = closeDay(p.t, p.kind);
        const d = days.get(k);
        if (!d) days.set(k, { time: k, open: p.v, high: p.v, low: p.v, close: p.v });
        else { d.high = Math.max(d.high, p.v); d.low = Math.min(d.low, p.v); d.close = p.v; }
      }
      main.setData([...days.values()]);
    } else {
      main = chart.addLineSeries({ color: colors.line, lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
      main.setData(pts.map((p) => ({ time: p.t, value: p.v })));
    }

    const fair = chart.addLineSeries({
      color: colors.fair, lineWidth: 2, lineStyle: 2, priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    if (candles) {
      const byDay = new Map();
      for (const p of pts) if (p.fair) byDay.set(closeDay(p.t, p.kind), p.fair);
      fair.setData([...byDay].map(([time, value]) => ({ time, value })));
    } else {
      fair.setData(pts.filter((p) => p.fair).map((p) => ({ time: p.t, value: p.fair })));
    }

    const markers = [];
    for (const t of trades) {
      markers.push({ time: keyOf({ t: t.t }), position: "belowBar", color: colors.up, shape: "arrowUp", text: "Buy " + coins(t.cost) });
      if (t.sellT) markers.push({ time: keyOf({ t: t.sellT }), position: "aboveBar", color: colors.down, shape: "arrowDown", text: "Sell " + coins(t.sell) });
    }
    const first = pts[0].t, lastT = pts[pts.length - 1].t;
    for (const e of state.events) {
      if (e.ratings && !e.ratings.includes(rating)) continue;
      const et = parseIso(e.t);
      if (et < first || et > lastT) continue;
      // Snap to the nearest reading so the marker sits on a bar.
      const near = pts.reduce((a, p) => (Math.abs(p.t - et) < Math.abs(a.t - et) ? p : a), pts[0]);
      markers.push({ time: keyOf(near), position: "aboveBar", color: colors.event, shape: "circle", text: e.short || "" });
    }
    const order = (m) => (typeof m.time === "string" ? Date.parse(m.time) / 1000 : m.time);
    markers.sort((a, b) => order(a) - order(b));
    main.setMarkers(markers);
    chart.timeScale().fitContent();
    return chart;
  }

  function tickLabel(time, long) {
    if (typeof time === "string") return etDay.format(new Date(time + "T00:00:00Z"));
    if (typeof time === "object") return etDay.format(new Date(Date.UTC(time.year, time.month - 1, time.day)));
    const d = new Date(time * 1000);
    return long ? etShort.format(d) + " ET" : etShort.format(d).replace(/^(\w+ \d+), /, "$1 ");
  }

  // ---------- controls ----------
  function bind(attr, key, storeKey) {
    document.querySelectorAll(`[data-${attr}]`).forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset[attr] === state[key]));
      b.addEventListener("click", () => {
        state[key] = b.dataset[attr];
        document.querySelectorAll(`[data-${attr}]`).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        try { localStorage.setItem(storeKey, state[key]); } catch (e) { /* ignore */ }
        if (state.db) render();
      });
    });
  }
  bind("platform", "platform", "fc27-platform");
  bind("view", "view", "fc27-view");
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => state.db && render());

  const bust = "?v=" + Math.floor(Date.now() / 600000);
  Promise.all([
    fetch("data/snapshots.json" + bust).then((r) => r.json()),
    fetch("data/events.json" + bust).then((r) => (r.ok ? r.json() : [])).catch(() => []),
  ]).then(([db, events]) => {
    state.db = db;
    state.events = events;
    render();
  }).catch((err) => {
    document.getElementById("updated").textContent = "Couldn't load prices: " + err.message;
  });
})();
