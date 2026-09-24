import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { auth, provider, db } from "./firebase";

/* ================================================================
   CONSTANTS
   ================================================================ */
// Where the old (pre-login) version kept trades in this browser
const LEGACY_KEY = "tradeLedgerData";
// Remembers that the old trades were already imported, so a second account doesn't import them too
const IMPORTED_KEY = "tradeLedgerImportedBy";
const THEME_KEY = "tradeLedgerTheme";

// Letters, digits and . - : / ^ =  (AAPL, BRK.B, BTC-USD, NASDAQ:AAPL), max 15 chars, at least one letter
const TICKER_RE = /^(?=.*[A-Z])[A-Z0-9.\-:/^=]{1,15}$/;
const PERIODS = [["week", "This Week"], ["month", "This Month"], ["year", "This Year"], ["all", "All Time"]];
const TABS = [["ledger", "Ledger"], ["overview", "Overview"], ["performance", "Performance"]];
const STATUS_LABEL = { open: "Open", partial: "Partial", closed: "Closed" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = 86400000;
const EPS = 1e-9;

/* ================================================================
   SMALL HELPERS
   ================================================================ */
const pad = (n) => String(n).padStart(2, "0");
function isoFromDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayISO() { return isoFromDate(new Date()); }
function newId() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
function toNum(v) { const n = typeof v === "number" ? v : parseFloat(v); return Number.isFinite(n) ? n : 0; }
function round8(n) { return Math.round(n * 1e8) / 1e8; }

// Accepts "12.5" and "12,5" (European keyboards). Anything else -> NaN.
function parseDec(s) {
  if (typeof s === "number") return s;
  const t = String(s ?? "").trim().replace(/\s/g, "").replace(",", ".");
  return /^-?(\d+\.?\d*|\.\d+)$/.test(t) ? parseFloat(t) : NaN;
}
function parseLocalDate(str) { const [y, m, d] = str.split("-").map(Number); return new Date(y, m - 1, d); }
function isValidISO(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || "")) return false;
  const d = parseLocalDate(s);
  return !isNaN(d) && isoFromDate(d) === s;
}
function daysBetween(a, b) { return Math.round((parseLocalDate(b) - parseLocalDate(a)) / DAY); }
function inPeriod(dateStr, period) {
  if (!dateStr) return false;
  if (period === "all") return true;
  const days = daysBetween(dateStr, todayISO());
  if (days < 0) return false;
  if (period === "week") return days <= 7;
  if (period === "month") return days <= 30;
  return days <= 365;
}

/* ---------- number / date formatting ---------- */
const NF0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const NF1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const NF2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NF_SMALL = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 8 });
const NF_QTY = new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 });
const NF_COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
// Same order as the browser's own date inputs, so the table and the form match
const DF = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "2-digit", day: "2-digit" });
const DF_SHORT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "2-digit" });

// Prices under $1 keep their decimals (penny stocks, crypto): 0.000001 stays 0.000001
function fmtAbs(a) { return a >= 1 || a === 0 ? NF2.format(a) : NF_SMALL.format(a); }
function fmtMoney(n, signed = false) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) < EPS) n = 0;
  const sign = n < 0 ? "-" : signed && n > 0 ? "+" : "";
  return sign + "$" + fmtAbs(Math.abs(n));
}
function fmtPct(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) < 0.005) return "0.00%";
  return (n > 0 ? "+" : "-") + NF2.format(Math.abs(n)) + "%";
}
function fmtQty(n) { return NF_QTY.format(n); }
function fmtCompactMoney(v) { return (v < 0 ? "-" : "") + "$" + NF_COMPACT.format(Math.abs(v)); }
function fmtDate(iso) { return iso ? DF.format(parseLocalDate(iso)) : "—"; }
// "pos" / "neg" / "zero": zero and missing values stay neutral grey
function signClass(n, eps = EPS) {
  if (n == null || !Number.isFinite(n) || Math.abs(n) < eps) return "zero";
  return n > 0 ? "pos" : "neg";
}
function withAlpha(hex, a) {
  const h = hex.replace("#", "").trim();
  if (h.length !== 6) return hex;
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/* ---------- TradingView ---------- */
function tvWebUrl(symbol) { return "https://www.tradingview.com/symbols/" + encodeURIComponent(symbol.replace(":", "-")) + "/"; }
function openTradingView(ticker) {
  const symbol = ticker.toUpperCase();
  let hidden = false;
  const onBlur = () => { hidden = true; };
  window.addEventListener("blur", onBlur);
  window.location.href = "tradingview://" + symbol;
  setTimeout(() => {
    window.removeEventListener("blur", onBlur);
    if (!hidden) window.open(tvWebUrl(symbol), "_blank", "noopener");
  }, 900);
}

/* ================================================================
   DATA MODEL
   A trade has one entry and any number of exits (partial sells).
   Long:  entry = buy,  exits = sells.
   Short: entry = sell, exits = buys to cover.
   ================================================================ */
function normalizeTrade(t, i) {
  if (t && Array.isArray(t.exits) && t.entryDate) {
    return {
      id: String(t.id ?? newId()),
      ticker: String(t.ticker || "").toUpperCase(),
      side: t.side === "short" ? "short" : "long",
      entryDate: t.entryDate,
      entryPrice: toNum(t.entryPrice),
      qty: toNum(t.qty),
      entryFees: toNum(t.entryFees),
      exits: t.exits
        .filter((e) => e && e.date && toNum(e.price) > 0 && toNum(e.shares) > 0)
        .map((e) => ({ id: String(e.id ?? newId()), date: e.date, price: toNum(e.price), shares: toNum(e.shares), fees: toNum(e.fees) })),
      notes: String(t.notes || ""),
      tags: Array.isArray(t.tags) ? t.tags.map(String).filter(Boolean) : [],
      setup: String(t.setup || ""),
      mistakes: String(t.mistakes || ""),
    };
  }
  // Old format: { id, ticker, buyDate, buyPrice, shares, sellDate, sellPrice }
  const qty = toNum(t.shares);
  const exits = [];
  // A sell price counts as a full exit. If the old app saved it without a date, use the buy date.
  if (t.sellPrice) exits.push({ id: newId(), date: t.sellDate || t.buyDate, price: toNum(t.sellPrice), shares: qty, fees: 0 });
  return {
    id: String(t.id ?? i ?? newId()),
    ticker: String(t.ticker || "").toUpperCase(),
    side: "long",
    entryDate: t.buyDate,
    entryPrice: toNum(t.buyPrice),
    qty,
    entryFees: 0,
    exits,
    notes: "", tags: [], setup: "", mistakes: "",
  };
}

function tradeStats(t, livePrice) {
  const dir = t.side === "short" ? -1 : 1;
  const exitedQty = t.exits.reduce((s, e) => s + e.shares, 0);
  const remaining = Math.max(0, round8(t.qty - exitedQty));
  const feePerShare = t.qty > 0 ? t.entryFees / t.qty : 0;
  const events = t.exits.map((e) => ({
    date: e.date,
    pl: dir * (e.price - t.entryPrice) * e.shares - e.fees - feePerShare * e.shares,
    tradeId: t.id,
    ticker: t.ticker,
  }));
  const realizedSum = events.reduce((s, e) => s + e.pl, 0);
  const exitedCost = t.entryPrice * exitedQty;
  const status = exitedQty <= EPS ? "open" : remaining <= EPS ? "closed" : "partial";
  const exitDates = t.exits.map((e) => e.date).sort();
  const lastExit = exitDates.length ? exitDates[exitDates.length - 1] : null;
  const closeDate = status === "closed" ? lastExit : null;
  const unrealized = livePrice > 0 && remaining > EPS ? dir * (livePrice - t.entryPrice) * remaining - feePerShare * remaining : null;
  return {
    dir,
    exitedQty,
    remaining,
    events,
    realized: exitedQty > EPS ? realizedSum : null,
    realizedPct: exitedQty > EPS && exitedCost > 0 ? (realizedSum / exitedCost) * 100 : null,
    status,
    lastExit,
    closeDate,
    avgExit: exitedQty > EPS ? t.exits.reduce((s, e) => s + e.price * e.shares, 0) / exitedQty : null,
    livePrice: livePrice > 0 ? livePrice : null,
    unrealized,
    unrealizedPct: unrealized != null && t.entryPrice > 0 ? (unrealized / (t.entryPrice * remaining)) * 100 : null,
    value: t.entryPrice * t.qty,
    fees: t.entryFees + t.exits.reduce((s, e) => s + e.fees, 0),
    holdDays: closeDate ? daysBetween(t.entryDate, closeDate) : null,
  };
}

function computeAnalytics(trades, stats, period) {
  const events = [];
  const closed = [];
  for (const t of trades) {
    const s = stats.get(t.id);
    for (const e of s.events) if (inPeriod(e.date, period)) events.push(e);
    if (s.status === "closed" && inPeriod(s.closeDate, period)) closed.push({ t, s });
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const totalPL = events.reduce((x, e) => x + e.pl, 0);
  const wins = closed.filter((c) => c.s.realized > EPS);
  const losses = closed.filter((c) => c.s.realized < -EPS);
  const grossWin = wins.reduce((x, c) => x + c.s.realized, 0);
  const grossLoss = losses.reduce((x, c) => x + c.s.realized, 0);
  const closedSum = closed.reduce((x, c) => x + c.s.realized, 0);

  let cum = 0, peak = 0, maxDD = 0;
  for (const e of events) { cum += e.pl; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); }

  const best = wins.length ? wins.reduce((a, b) => (b.s.realized > a.s.realized ? b : a)) : null;
  const worst = losses.length ? losses.reduce((a, b) => (b.s.realized < a.s.realized ? b : a)) : null;

  // Per ticker: realized P/L in the period, plus closed trades and wins
  const tick = new Map();
  const row = (k) => { if (!tick.has(k)) tick.set(k, { ticker: k, pl: 0, closed: 0, wins: 0 }); return tick.get(k); };
  events.forEach((e) => { row(e.ticker).pl += e.pl; });
  closed.forEach((c) => { const r = row(c.t.ticker); r.closed++; if (c.s.realized > EPS) r.wins++; });

  // Per trade: realized P/L in the period (includes partial exits)
  const perTrade = new Map();
  events.forEach((e) => {
    const p = perTrade.get(e.tradeId) || { ticker: e.ticker, pl: 0, date: e.date };
    p.pl += e.pl; p.date = e.date > p.date ? e.date : p.date;
    perTrade.set(e.tradeId, p);
  });

  return {
    events,
    closed,
    totalPL,
    wins,
    losses,
    flat: closed.length - wins.length - losses.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : null,
    avgPct: closed.length ? closed.reduce((x, c) => x + c.s.realizedPct, 0) / closed.length : null,
    avgWin: wins.length ? grossWin / wins.length : null,
    avgLoss: losses.length ? grossLoss / losses.length : null,
    profitFactor: losses.length ? grossWin / Math.abs(grossLoss) : wins.length ? Infinity : null,
    expectancy: closed.length ? closedSum / closed.length : null,
    maxDD,
    avgHold: closed.length ? closed.reduce((x, c) => x + c.s.holdDays, 0) / closed.length : null,
    best,
    worst,
    byTicker: [...tick.values()].sort((a, b) => b.pl - a.pl),
    perTrade: [...perTrade.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
  };
}

function readLegacyTrades() {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
// Firestore rejects `undefined`; a JSON round-trip strips it
const clean = (v) => JSON.parse(JSON.stringify(v));

/* ================================================================
   CSV EXPORT / IMPORT
   Export: one row per transaction (entry + each exit), grouped by Trade ID.
   Import: our own export (grouped by Trade ID) or a broker statement
   (buys/sells matched first-in-first-out into trades).
   ================================================================ */
function csvCell(v) {
  let s = String(v ?? "");
  if (typeof v === "string" && /^[=+\-@]/.test(s)) s = "'" + s; // stop spreadsheets running it as a formula
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function tradesToCSV(trades) {
  const rows = [["Trade ID", "Ticker", "Side", "Action", "Date", "Price", "Shares", "Fees", "Setup", "Tags", "Notes", "Mistakes"]];
  const sorted = [...trades].sort((a, b) => (a.entryDate < b.entryDate ? -1 : 1));
  for (const t of sorted) {
    const open = t.side === "short" ? "SELL" : "BUY";
    const close = t.side === "short" ? "BUY" : "SELL";
    rows.push([t.id, t.ticker, t.side, open, t.entryDate, t.entryPrice, t.qty, t.entryFees, t.setup, t.tags.join(", "), t.notes, t.mistakes]);
    [...t.exits].sort((a, b) => (a.date < b.date ? -1 : 1))
      .forEach((e) => rows.push([t.id, t.ticker, t.side, close, e.date, e.price, e.shares, e.fees, "", "", "", ""]));
  }
  return "\uFEFF" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}
function downloadFile(content, name, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function parseCSVRows(text) {
  text = text.replace(/^\uFEFF/, "");
  const firstLine = text.split(/\r?\n/).find((l) => l.trim()) || "";
  const delim = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}
function parseLooseNumber(s) {
  if (s == null) return NaN;
  let t = String(s).trim();
  if (!t) return NaN;
  const neg = /^\(.*\)$/.test(t) || /^-/.test(t) || /-$/.test(t);
  t = t.replace(/[^0-9.,]/g, "");
  if (!t) return NaN;
  const lc = t.lastIndexOf(","), ld = t.lastIndexOf(".");
  if (lc > -1 && ld > -1) t = lc > ld ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  else if (lc > -1) { const parts = t.split(","); t = parts.length === 2 && parts[1].length !== 3 ? parts.join(".") : parts.join(""); }
  const n = parseFloat(t);
  return Number.isFinite(n) ? (neg ? -n : n) : NaN;
}
function parseLooseDate(s) {
  if (!s) return null;
  s = s.trim();
  const mk = (y, m, d) => {
    y = String(y).length === 2 ? "20" + y : String(y);
    const iso = `${y}-${pad(+m)}-${pad(+d)}`;
    return isValidISO(iso) ? iso : null;
  };
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return mk(m[1], m[2], m[3]);
  m = s.match(/^(\d{4})(\d{2})(\d{2})(\b|T|\s|$)/);
  if (m) return mk(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})/); // DD.MM.YYYY
  if (m) return mk(m[3], m[2], m[1]);
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/); // MM/DD/YYYY, or DD/MM/YYYY when the first part is > 12
  if (m) return +m[1] > 12 ? mk(m[3], m[2], m[1]) : mk(m[3], m[1], m[2]);
  const d = new Date(s);
  return isNaN(d) ? null : isoFromDate(d);
}
function classifyAction(s) {
  const t = String(s || "").toLowerCase().trim();
  if (!t) return null;
  if (/sell|sld|short|verkauf|vente|venta|^s$/.test(t)) return "sell";
  if (/buy|bot|cover|kauf|achat|compra|purchase|^b$/.test(t)) return "buy";
  return null;
}
const COLS = {
  tradeId: ["tradeid", "positionid"],
  ticker: ["ticker", "symbol", "instrument", "stock", "security", "underlying", "asset"],
  side: ["side", "position", "positiontype", "longshort"],
  date: ["date", "tradedate", "executiondate", "transactiondate", "datetime", "time", "executiontime", "filldate", "opendate"],
  price: ["price", "executionprice", "tradeprice", "fillprice", "avgprice", "averageprice", "pricepershare", "priceshare", "unitprice"],
  shares: ["shares", "quantity", "qty", "units", "filledqty", "filledquantity", "size"],
  fees: ["fees", "fee", "commission", "commissions", "costs", "charges", "totalfees"],
  setup: ["setup", "strategy"],
  tags: ["tags", "tag"],
  notes: ["notes", "note", "comment", "comments"],
  mistakes: ["mistakes", "lessons"],
};
const ACTION_COLS = ["action", "buysell", "transactiontype", "type", "direction", "side", "ordertype"];
const normHeader = (h) => String(h || "").toLowerCase().replace(/[^a-z0-9]/g, "");
function findCol(headers, aliases) {
  for (const a of aliases) { const i = headers.indexOf(a); if (i > -1) return i; }
  for (const a of aliases) { if (a.length < 4) continue; const i = headers.findIndex((h) => h.startsWith(a)); if (i > -1) return i; }
  return null;
}
function parseTradesCSV(text) {
  const rows = parseCSVRows(text);
  let hIdx = -1, map = null, headers = null;
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const h = rows[i].map(normHeader);
    const m = {};
    for (const k of Object.keys(COLS)) m[k] = findCol(h, COLS[k]);
    if (m.ticker != null && m.price != null && m.date != null) { hIdx = i; map = m; headers = h; break; }
  }
  if (hIdx < 0) return { trades: [], txCount: 0, skipped: rows.length, error: "Couldn't find ticker, date and price columns in this file." };
  const data = rows.slice(hIdx + 1);

  // Pick the buy/sell column by its contents (a "Type" column might just say "Market")
  const candidates = ACTION_COLS.map((a) => headers.indexOf(a)).filter((i) => i > -1);
  const sample = data.slice(0, 50);
  const actionIdx = candidates.find((i) => sample.filter((r) => classifyAction(r[i])).length >= Math.max(1, sample.length / 2));
  if (map.side != null && !sample.some((r) => /long|short/i.test(r[map.side] || ""))) map.side = null;

  const unq = (s) => String(s || "").replace(/^'(?=[=+\-@])/, "").trim();
  const txs = [];
  let skipped = 0;
  data.forEach((r, idx) => {
    const get = (i) => (i != null ? String(r[i] ?? "").trim() : "");
    const ticker = get(map.ticker).toUpperCase().split(/\s+/)[0] || "";
    const date = parseLooseDate(get(map.date));
    const price = Math.abs(parseLooseNumber(get(map.price)));
    let shares = parseLooseNumber(get(map.shares));
    const fees = Math.abs(parseLooseNumber(get(map.fees)) || 0);
    const rawAction = actionIdx != null ? get(actionIdx) : "";
    let action = classifyAction(rawAction);
    if (!action && !rawAction && Number.isFinite(shares) && shares !== 0) action = shares < 0 ? "sell" : "buy";
    shares = Math.abs(shares);
    if (!ticker || !TICKER_RE.test(ticker) || !date || !(price > 0) || !(shares > 0) || !action) { skipped++; return; }
    txs.push({
      idx, tradeId: get(map.tradeId), ticker, action, date, price, shares, fees,
      side: /short/i.test(get(map.side)) ? "short" : /long/i.test(get(map.side)) ? "long" : null,
      setup: unq(get(map.setup)), notes: unq(get(map.notes)), mistakes: unq(get(map.mistakes)),
      tags: unq(get(map.tags)).split(",").map((x) => x.trim()).filter(Boolean),
    });
  });

  const trades = [];
  if (txs.some((t) => t.tradeId)) {
    // Our own export: rows grouped by Trade ID
    const groups = new Map();
    txs.forEach((t) => { const k = t.tradeId || "row" + t.idx; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); });
    for (const g of groups.values()) {
      const first = g[0];
      const side = first.side || (first.action === "sell" ? "short" : "long");
      const openAct = side === "short" ? "sell" : "buy";
      const entries = g.filter((x) => x.action === openAct);
      if (!entries.length) { skipped += g.length; continue; }
      const qty = entries.reduce((s, x) => s + x.shares, 0);
      trades.push({
        id: newId(), ticker: first.ticker, side,
        entryDate: entries.map((x) => x.date).sort()[0],
        entryPrice: entries.reduce((s, x) => s + x.price * x.shares, 0) / qty,
        qty, entryFees: entries.reduce((s, x) => s + x.fees, 0),
        exits: g.filter((x) => x.action !== openAct).map((x) => ({ id: newId(), date: x.date, price: x.price, shares: x.shares, fees: x.fees })),
        setup: first.setup, tags: first.tags, notes: first.notes, mistakes: first.mistakes,
      });
    }
  } else {
    // Broker statement: match buys and sells first-in-first-out
    const sorted = [...txs].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.idx - b.idx));
    const lotsByTicker = new Map();
    for (const tx of sorted) {
      if (!lotsByTicker.has(tx.ticker)) lotsByTicker.set(tx.ticker, []);
      const lots = lotsByTicker.get(tx.ticker);
      let left = tx.shares;
      const closes = tx.action === "sell" ? "long" : "short";
      while (left > EPS && lots.length && lots[0].trade.side === closes) {
        const lot = lots[0];
        const take = Math.min(left, lot.remaining);
        lot.trade.exits.push({ id: newId(), date: tx.date, price: tx.price, shares: round8(take), fees: tx.fees * (take / tx.shares) });
        lot.remaining = round8(lot.remaining - take);
        left = round8(left - take);
        if (lot.remaining <= EPS) lots.shift();
      }
      if (left > EPS) {
        const t = {
          id: newId(), ticker: tx.ticker, side: tx.action === "buy" ? "long" : "short",
          entryDate: tx.date, entryPrice: tx.price, qty: left, entryFees: tx.fees * (left / tx.shares), exits: [],
          setup: tx.setup, tags: tx.tags, notes: tx.notes, mistakes: tx.mistakes,
        };
        trades.push(t);
        lots.push({ trade: t, remaining: left });
      }
    }
  }
  return { trades: trades.map((t) => normalizeTrade(t)), txCount: txs.length, skipped };
}

/* ================================================================
   LIVE PRICES (Finnhub, free API key)
   ================================================================ */
async function fetchQuotes(tickers, key) {
  const out = {};
  let failed = 0;
  await Promise.all(tickers.map(async (sym) => {
    try {
      const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(key)}`);
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      if (j && j.c > 0) out[sym] = j.c; else failed++;
    } catch {
      failed++;
    }
  }));
  return { out, failed };
}

/* ================================================================
   THEME
   ================================================================ */
function useTheme() {
  const [pref, setPref] = useState(() => { try { return localStorage.getItem(THEME_KEY) || "dark"; } catch { return "dark"; } });
  const [systemDark, setSystemDark] = useState(() => (window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)").matches : true));
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = (e) => setSystemDark(e.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  const effective = pref === "system" ? (systemDark ? "dark" : "light") : pref;
  useEffect(() => {
    document.documentElement.dataset.theme = effective;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", effective === "dark" ? "#0A0D12" : "#F6F7F9");
  }, [effective]);
  function choose(p) { setPref(p); try { localStorage.setItem(THEME_KEY, p); } catch { /* ignore */ } }
  return { pref, effective, choose };
}

/* ================================================================
   APP: loading, sign-in screen, or the ledger
   ================================================================ */
export default function App() {
  const theme = useTheme();
  const [user, setUser] = useState(undefined); // undefined = still checking
  const [authError, setAuthError] = useState("");

  useEffect(() => onAuthStateChanged(auth, (u) => setUser(u)), []);

  async function handleSignIn() {
    setAuthError("");
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") return;
      console.error(e);
      setAuthError("Sign-in failed (" + e.code + "). Try again.");
    }
  }

  if (user === undefined) return <Splash text="Loading…" />;
  if (!user) return <SignIn onSignIn={handleSignIn} error={authError} />;
  return <Ledger key={user.uid} user={user} theme={theme} />;
}

function Splash({ text }) {
  return (
    <div className="gate">
      <div className="gate-text" role="status">{text}</div>
    </div>
  );
}

function SignIn({ onSignIn, error }) {
  return (
    <main className="gate">
      <div className="gate-box">
        <h1 className="masthead-title">Trade<span>Ledger</span></h1>
        <div className="masthead-sub">Personal Position Journal</div>
        <p className="gate-text">
          Sign in to open your ledger. Your trades are saved to your Google account, so they're the same on every device.
        </p>
        <button className="btn" onClick={onSignIn}>Sign in with Google</button>
        {error && <div className="gate-error" role="alert">{error}</div>}
      </div>
    </main>
  );
}

/* ================================================================
   LEDGER: the app itself, one Firestore document per user
   ================================================================ */
function Ledger({ user, theme }) {
  const userDoc = useMemo(() => doc(db, "users", user.uid), [user.uid]);

  const [trades, setTrades] = useState(null); // null = loading
  const tradesRef = useRef(null);
  const [settings, setSettings] = useState({});
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState(false);
  const [notice, setNotice] = useState(null); // { kind: "info" | "error", text }

  const [tab, setTab] = useState("ledger");
  const [period, setPeriod] = useState("month");
  const [modal, setModal] = useState(null); // { type: "trade", trade } | { type: "settings" } | { type: "import", data }
  const [toast, setToast] = useState(null); // { text, undo }
  const toastTimer = useRef(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const fileRef = useRef(null);

  // live prices
  const [prices, setPrices] = useState({});
  const [priceStatus, setPriceStatus] = useState("");
  const [priceNonce, setPriceNonce] = useState(0);

  // filters & sorting
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [resultFilter, setResultFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sort, setSort] = useState({ key: "entryDate", dir: "desc" });
  const [expanded, setExpanded] = useState(() => new Set());

  /* ---------- load (and one-time import of old browser data) ---------- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDoc(userDoc);
        if (cancelled) return;
        if (snap.exists()) {
          const data = snap.data();
          const list = (data.trades || []).map(normalizeTrade).filter((t) => t.entryDate);
          tradesRef.current = list;
          setTrades(list);
          setSettings(data.settings || {});
          return;
        }
        // First sign-in for this account: bring over trades saved by the old version
        let alreadyImported = null;
        try { alreadyImported = localStorage.getItem(IMPORTED_KEY); } catch { /* ignore */ }
        const initial = (alreadyImported ? [] : readLegacyTrades()).map(normalizeTrade).filter((t) => t.entryDate);
        await setDoc(userDoc, { trades: clean(initial) }, { merge: true });
        if (initial.length) {
          try { localStorage.setItem(IMPORTED_KEY, user.uid); } catch { /* ignore */ }
          setNotice({ kind: "info", text: `Imported ${initial.length} trade${initial.length === 1 ? "" : "s"} from this browser into your account.` });
        }
        if (!cancelled) { tradesRef.current = initial; setTrades(initial); }
      } catch (e) {
        console.error(e);
        if (!cancelled) setLoadError("Couldn't load your ledger. Check your connection and reload the page.");
      }
    })();
    return () => { cancelled = true; };
  }, [userDoc, user.uid]);

  /* ---------- save: update screen immediately, then write to Firestore ---------- */
  function commit(next) {
    tradesRef.current = next;
    setTrades(next);
    setDoc(userDoc, { trades: clean(next) }, { merge: true })
      .then(() => setSaveError(false))
      .catch((e) => { console.error(e); setSaveError(true); });
  }
  function saveSettings(next) {
    setSettings(next);
    setDoc(userDoc, { settings: clean(next) }, { merge: true }).catch((e) => { console.error(e); setSaveError(true); });
  }

  /* ---------- derived data ---------- */
  const stats = useMemo(() => {
    const m = new Map();
    (trades || []).forEach((t) => m.set(t.id, tradeStats(t, prices[t.ticker])));
    return m;
  }, [trades, prices]);

  const openTickers = useMemo(() => {
    const set = new Set();
    (trades || []).forEach((t) => { if (stats.get(t.id).remaining > EPS) set.add(t.ticker); });
    return [...set].sort();
  }, [trades, stats]);
  const openTickerKey = openTickers.join(",");

  /* ---------- live prices ---------- */
  const finnhubKey = settings.finnhubKey || "";
  useEffect(() => {
    if (!finnhubKey || !openTickers.length) { setPriceStatus(""); return; }
    let cancelled = false;
    async function run() {
      setPriceStatus("Updating live prices…");
      const { out, failed } = await fetchQuotes(openTickers, finnhubKey);
      if (cancelled) return;
      setPrices(out);
      const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      if (!Object.keys(out).length) setPriceStatus("Live prices unavailable. Check your Finnhub key in Settings.");
      else setPriceStatus(`Live prices updated ${time}` + (failed ? ` (${failed} ticker${failed === 1 ? "" : "s"} not found)` : ""));
    }
    run();
    const id = setInterval(() => { if (document.visibilityState === "visible") run(); }, 120000);
    return () => { cancelled = true; clearInterval(id); };
  }, [finnhubKey, openTickerKey, priceNonce]);

  /* ---------- actions ---------- */
  function showToast(text, undo) {
    clearTimeout(toastTimer.current);
    setToast({ text, undo });
    toastTimer.current = setTimeout(() => setToast(null), 7000);
  }
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  function saveTrade(data, existingId) {
    const cur = tradesRef.current;
    if (existingId) {
      commit(cur.map((t) => (t.id === existingId ? normalizeTrade({ ...data, id: existingId }) : t)));
    } else {
      commit([...cur, normalizeTrade({ ...data, id: newId() })]);
    }
    setModal(null);
  }
  function deleteTrade(id) {
    const cur = tradesRef.current;
    const removed = cur.find((t) => t.id === id);
    if (!removed) return;
    commit(cur.filter((t) => t.id !== id));
    showToast(`Deleted ${removed.ticker}`, () => {
      commit([...tradesRef.current, removed]);
      setToast(null);
    });
  }
  function toggleExpanded(id) {
    setExpanded((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  function exportCsv() {
    if (!trades.length) { setNotice({ kind: "info", text: "No trades to export yet." }); return; }
    downloadFile(tradesToCSV(trades), `trade-ledger-${todayISO()}.csv`, "text/csv;charset=utf-8");
  }
  async function onImportFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const res = parseTradesCSV(await file.text());
      if (!res.trades.length) {
        setNotice({ kind: "error", text: res.error || `No trades found in ${file.name}. It needs columns for ticker, date, buy/sell, price and shares.` });
        return;
      }
      setModal({ type: "import", data: { ...res, name: file.name } });
    } catch (err) {
      console.error(err);
      setNotice({ kind: "error", text: `Couldn't read ${file.name}.` });
    }
  }

  async function exportPdf() {
    if (!trades.length) { setNotice({ kind: "info", text: "No trades to export yet." }); return; }
    setPdfBusy(true);
    try {
      const [{ jsPDF }, atMod] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
      const autoTable = atMod.default;
      const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
      const sorted = [...trades].sort((a, b) => (a.entryDate < b.entryDate ? 1 : a.entryDate > b.entryDate ? -1 : 0)); // newest first, like the app
      const all = computeAnalytics(trades, stats, "all");
      const today = todayISO();

      pdf.setFont("helvetica", "bold"); pdf.setFontSize(18); pdf.setTextColor(20, 24, 31);
      pdf.text("Trade Ledger", 40, 45);
      pdf.setFont("helvetica", "normal"); pdf.setFontSize(10); pdf.setTextColor(110, 118, 130);
      pdf.text(
        `Exported ${fmtDate(today)}  \u2022  ${trades.length} positions  \u2022  ${all.closed.length} closed  \u2022  Win rate ${all.winRate == null ? "\u2014" : NF0.format(all.winRate) + "%"}  \u2022  Realized P/L ${fmtMoney(all.totalPL, true)}`,
        40, 62
      );

      const head = [["Stock", "Side", "Entry Date", "Entry Price", "Shares", "Value", "Exit Date", "Avg Exit", "Fees", "P/L %", "P/L $", "Status"]];
      const numeric = new Set([3, 4, 5, 7, 8, 9, 10]);
      const vals = [];
      const body = sorted.map((t) => {
        const s = stats.get(t.id);
        vals.push({ pct: s.realizedPct, usd: s.realized, status: s.status });
        return [
          t.ticker, t.side === "short" ? "Short" : "Long", fmtDate(t.entryDate), fmtMoney(t.entryPrice), fmtQty(t.qty), fmtMoney(s.value),
          s.lastExit ? fmtDate(s.lastExit) : "\u2014", s.avgExit != null ? fmtMoney(s.avgExit) : "\u2014", s.fees ? fmtMoney(s.fees) : "\u2014",
          fmtPct(s.realizedPct), fmtMoney(s.realized, true), STATUS_LABEL[s.status],
        ];
      });
      autoTable(pdf, {
        head, body, startY: 78, theme: "plain",
        styles: { font: "helvetica", fontSize: 8.5, cellPadding: 5, textColor: [30, 34, 42], lineColor: [225, 228, 233], lineWidth: 0.5 },
        headStyles: { fillColor: [18, 22, 29], textColor: [212, 162, 76], fontStyle: "bold", fontSize: 8 },
        alternateRowStyles: { fillColor: [248, 249, 250] },
        didParseCell: (d) => {
          if (numeric.has(d.column.index)) d.cell.styles.halign = "right"; // headers too
          if (d.section !== "body") return;
          const v = vals[d.row.index];
          const n = d.column.index === 9 ? v.pct : d.column.index === 10 ? v.usd : null;
          if (n != null && Math.abs(n) > EPS) d.cell.styles.textColor = n > 0 ? [16, 124, 84] : [190, 40, 40];
          if (d.column.index === 11) d.cell.styles.textColor = v.status === "closed" ? [130, 138, 150] : [180, 130, 40];
        },
      });
      pdf.save(`trade-ledger-${today}.pdf`);
    } catch (e) {
      console.error(e);
      setNotice({ kind: "error", text: "Couldn't create the PDF. Check your connection and try again." });
    } finally {
      setPdfBusy(false);
    }
  }

  /* ---------- loading / error states ---------- */
  if (loadError) return <Splash text={loadError} />;
  if (trades === null) return <LoadingSkeleton />;

  /* ---------- header numbers (same source as Overview → All Time) ---------- */
  const allTime = computeAnalytics(trades, stats, "all");
  const openCount = trades.filter((t) => stats.get(t.id).status !== "closed").length;
  const unrealTotal = trades.reduce((s, t) => s + (stats.get(t.id).unrealized || 0), 0);
  const hasUnreal = trades.some((t) => stats.get(t.id).unrealized != null);
  const allEvents = trades.flatMap((t) => stats.get(t.id).events);

  return (
    <div className="app">
      <div className="account-bar">
        <span className="account-email">{user.email}</span>
        <button className="btn ghost small" onClick={() => setModal({ type: "settings" })}>Settings</button>
        <button className="btn ghost small" onClick={() => signOut(auth)}>Sign out</button>
      </div>

      <header className="masthead">
        <div>
          <h1 className="masthead-title">Trade<span>Ledger</span></h1>
          <div className="masthead-sub">Personal Position Journal</div>
        </div>
        <div className="ticker-strip">
          <div className="ticker-item">
            <div className="ticker-label">Realized P/L</div>
            <div className={"ticker-value " + signClass(allTime.totalPL)}>{fmtMoney(allTime.totalPL, true)}</div>
          </div>
          {hasUnreal && (
            <div className="ticker-item">
              <div className="ticker-label">Unrealized</div>
              <div className={"ticker-value " + signClass(unrealTotal)}>{fmtMoney(unrealTotal, true)}</div>
            </div>
          )}
          <div className="ticker-item">
            <div className="ticker-label">Win Rate</div>
            <div className="ticker-value">{allTime.winRate == null ? "—" : NF0.format(allTime.winRate) + "%"}</div>
          </div>
          <div className="ticker-item">
            <div className="ticker-label">Open</div>
            <div className="ticker-value">{openCount}</div>
          </div>
        </div>
      </header>

      {notice && (
        <div className={"notice" + (notice.kind === "error" ? " error" : "")} role={notice.kind === "error" ? "alert" : "status"}>
          <span>{notice.text}</span>
          <button className="icon-btn" aria-label="Dismiss message" onClick={() => setNotice(null)}>✕</button>
        </div>
      )}
      {saveError && (
        <div className="notice error" role="alert">
          <span>Your last change wasn't saved to your account. Check your connection, then make any change to retry.</span>
        </div>
      )}

      <div className="tabs" role="tablist" aria-label="Sections">
        {TABS.map(([id, label]) => (
          <button key={id} id={"tab-" + id} role="tab" aria-selected={tab === id} aria-controls="main-panel"
            className={"tab" + (tab === id ? " active" : "")} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      <main className="panel" role="tabpanel" id="main-panel" aria-labelledby={"tab-" + tab}>
        {tab === "ledger" && (
          <LedgerView
            trades={trades} stats={stats}
            filters={{ query, setQuery, statusFilter, setStatusFilter, resultFilter, setResultFilter, dateFrom, setDateFrom, dateTo, setDateTo }}
            sort={sort} setSort={setSort}
            expanded={expanded} toggleExpanded={toggleExpanded}
            onNew={() => setModal({ type: "trade", trade: null })}
            onEdit={(t) => setModal({ type: "trade", trade: t })}
            onDelete={deleteTrade}
            onImport={() => fileRef.current && fileRef.current.click()}
            onExportCsv={exportCsv}
            onExportPdf={exportPdf} pdfBusy={pdfBusy}
            liveBar={finnhubKey && openTickers.length ? { status: priceStatus, refresh: () => setPriceNonce((n) => n + 1) } : null}
          />
        )}
        {tab === "overview" && <Overview trades={trades} stats={stats} period={period} setPeriod={setPeriod} />}
        {tab === "performance" && <Performance trades={trades} stats={stats} period={period} setPeriod={setPeriod} allEvents={allEvents} themeName={theme.effective} />}
      </main>

      <input ref={fileRef} type="file" accept=".csv,text/csv" className="visually-hidden" tabIndex={-1} aria-hidden="true" onChange={onImportFile} />

      {modal && modal.type === "trade" && (
        <TradeModal trade={modal.trade} onSave={(data) => saveTrade(data, modal.trade && modal.trade.id)} onClose={() => setModal(null)} />
      )}
      {modal && modal.type === "settings" && (
        <SettingsModal
          theme={theme}
          finnhubKey={finnhubKey}
          onSaveKey={(k) => { saveSettings({ ...settings, finnhubKey: k }); if (!k) setPrices({}); }}
          onClose={() => setModal(null)}
        />
      )}
      {modal && modal.type === "import" && (
        <ImportModal
          data={modal.data}
          onConfirm={() => {
            commit([...tradesRef.current, ...modal.data.trades]);
            setNotice({ kind: "info", text: `Imported ${modal.data.trades.length} trade${modal.data.trades.length === 1 ? "" : "s"} from ${modal.data.name}.` });
            setModal(null);
          }}
          onClose={() => setModal(null)}
        />
      )}

      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          {toast.undo && <button className="toast-btn" onClick={toast.undo}>Undo</button>}
          <button className="icon-btn" aria-label="Dismiss" onClick={() => setToast(null)}>✕</button>
        </div>
      )}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="app" aria-busy="true">
      <div className="masthead">
        <div>
          <div className="skeleton" style={{ width: 220, height: 34 }} />
          <div className="skeleton" style={{ width: 170, height: 12, marginTop: 10 }} />
        </div>
        <div className="skeleton" style={{ width: 240, height: 34 }} />
      </div>
      <div className="tabs">
        {[90, 100, 120].map((w) => <div key={w} className="skeleton" style={{ width: w, height: 38 }} />)}
      </div>
      <div className="panel">
        <span className="visually-hidden" role="status">Loading your ledger…</span>
        {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton skeleton-row" />)}
      </div>
    </div>
  );
}

/* ================================================================
   LEDGER TAB
   ================================================================ */
const COLUMNS = [
  { key: null, label: "", cls: "col-expand", sr: "Details" },
  { key: "ticker", label: "Stock" },
  { key: "entryDate", label: "Entry" },
  { key: null, label: "Entry Price", num: true },
  { key: null, label: "Shares", num: true },
  { key: "value", label: "Value", num: true },
  { key: "exitDate", label: "Exit" },
  { key: null, label: "Exit Price", num: true },
  { key: "plPct", label: "P/L %", num: true },
  { key: "pl", label: "P/L $", num: true },
  { key: "status", label: "Status" },
  { key: null, label: "", cls: "col-actions", sr: "Actions" },
];
const SORTERS = {
  ticker: (t) => t.ticker,
  entryDate: (t) => t.entryDate,
  value: (t, s) => s.value,
  exitDate: (t, s) => s.lastExit || "",
  pl: (t, s) => s.realized ?? s.unrealized ?? -Infinity,
  plPct: (t, s) => s.realizedPct ?? s.unrealizedPct ?? -Infinity,
  status: (t, s) => ({ open: 0, partial: 1, closed: 2 })[s.status],
};
const SORT_OPTIONS = [
  ["entryDate:desc", "Newest first"], ["entryDate:asc", "Oldest first"],
  ["pl:desc", "Biggest winners"], ["pl:asc", "Biggest losers"],
  ["plPct:desc", "Best P/L %"], ["value:desc", "Largest value"], ["ticker:asc", "Ticker A–Z"],
];

function rowClassFor(s) {
  if (s.status === "open") return "row-open";
  return s.realized > EPS ? "row-gain" : s.realized < -EPS ? "row-loss" : "row-flat";
}

function LedgerView({ trades, stats, filters, sort, setSort, expanded, toggleExpanded, onNew, onEdit, onDelete, onImport, onExportCsv, onExportPdf, pdfBusy, liveBar }) {
  const { query, setQuery, statusFilter, setStatusFilter, resultFilter, setResultFilter, dateFrom, setDateFrom, dateTo, setDateTo } = filters;
  const q = query.trim().toLowerCase();
  const filtersActive = !!(q || statusFilter !== "all" || resultFilter !== "all" || dateFrom || dateTo);

  const rows = trades.filter((t) => {
    const s = stats.get(t.id);
    if (statusFilter !== "all" && s.status !== statusFilter) return false;
    const pl = s.realized ?? s.unrealized;
    if (resultFilter === "winners" && !(pl > EPS)) return false;
    if (resultFilter === "losers" && !(pl < -EPS)) return false;
    if (dateFrom && t.entryDate < dateFrom) return false;
    if (dateTo && t.entryDate > dateTo) return false;
    if (q && !(t.ticker.toLowerCase().includes(q) || t.tags.some((g) => g.toLowerCase().includes(q)) ||
      t.setup.toLowerCase().includes(q) || t.notes.toLowerCase().includes(q) || t.mistakes.toLowerCase().includes(q))) return false;
    return true;
  });
  const getter = SORTERS[sort.key];
  rows.sort((a, b) => {
    const va = getter(a, stats.get(a.id)), vb = getter(b, stats.get(b.id));
    const c = va < vb ? -1 : va > vb ? 1 : 0;
    if (c) return sort.dir === "asc" ? c : -c;
    return a.entryDate < b.entryDate ? 1 : a.entryDate > b.entryDate ? -1 : 0;
  });

  function toggleSort(key) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "ticker" ? "asc" : "desc" }));
  }
  function clearFilters() { setQuery(""); setStatusFilter("all"); setResultFilter("all"); setDateFrom(""); setDateTo(""); }

  return (
    <div>
      <div className="ledger-toolbar">
        <h2 className="section-label">Positions</h2>
        <div className="toolbar-actions">
          <button className="btn ghost" onClick={onImport}>Import CSV</button>
          <button className="btn ghost" onClick={onExportCsv}>Export CSV</button>
          <button className="btn ghost" onClick={onExportPdf} disabled={pdfBusy}>{pdfBusy ? "Preparing…" : "Export PDF"}</button>
          <button className="btn" onClick={onNew}>+ New Entry</button>
        </div>
      </div>

      {trades.length > 0 && (
        <div className="filters">
          <input type="search" className="filter-search" placeholder="Search ticker, tag, setup, notes" aria-label="Search trades" value={query} onChange={(e) => setQuery(e.target.value)} />
          <select aria-label="Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">All statuses</option><option value="open">Open</option><option value="partial">Partial</option><option value="closed">Closed</option>
          </select>
          <select aria-label="Result" value={resultFilter} onChange={(e) => setResultFilter(e.target.value)}>
            <option value="all">All results</option><option value="winners">Winners</option><option value="losers">Losers</option>
          </select>
          <label className="date-filter"><span>From</span><input type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} /></label>
          <label className="date-filter"><span>To</span><input type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} /></label>
          <select className="mobile-only" aria-label="Sort" value={`${sort.key}:${sort.dir}`} onChange={(e) => { const [key, dir] = e.target.value.split(":"); setSort({ key, dir }); }}>
            {SORT_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            {!SORT_OPTIONS.some(([v]) => v === `${sort.key}:${sort.dir}`) && <option value={`${sort.key}:${sort.dir}`}>Custom sort</option>}
          </select>
          {filtersActive && <button className="btn ghost small" onClick={clearFilters}>Clear filters</button>}
        </div>
      )}

      {liveBar && (
        <div className="live-bar">
          <span className="live-dot" aria-hidden="true" />
          <span>{liveBar.status || "Loading live prices…"}</span>
          <button className="link-btn" onClick={liveBar.refresh}>Refresh</button>
        </div>
      )}

      {trades.length > 0 && filtersActive && (
        <div className="result-count" role="status">Showing {rows.length} of {trades.length} trades</div>
      )}

      {rows.length > 0 && (
        <>
          <div className="ledger-scroll desktop-only">
            <table className="ledger-table">
              <thead>
                <tr>
                  {COLUMNS.map((c, i) => {
                    const active = c.key && sort.key === c.key;
                    return (
                      <th key={i} className={(c.num ? "num " : "") + (c.cls || "")} scope="col"
                        aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
                        {c.key ? (
                          <button className="th-sort" onClick={() => toggleSort(c.key)}>
                            {c.label}<span className="sort-ind" aria-hidden="true">{active ? (sort.dir === "asc" ? "▲" : "▼") : ""}</span>
                          </button>
                        ) : c.sr ? <span className="visually-hidden">{c.sr}</span> : c.label}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => {
                  const s = stats.get(t.id);
                  const open = expanded.has(t.id);
                  return (
                    <Fragment key={t.id}>
                    <tr className={rowClassFor(s)}>
                      <td className="col-expand">
                        <button className="icon-btn" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} details for ${t.ticker}`} onClick={() => toggleExpanded(t.id)}>
                          <span className={"chev" + (open ? " open" : "")} aria-hidden="true">›</span>
                        </button>
                      </td>
                      <td>
                        <div className="ticker-cell">
                          <TickerLink ticker={t.ticker} />
                          {t.side === "short" && <span className="side-badge">Short</span>}
                        </div>
                        {t.tags.length > 0 && <div className="tag-row">{t.tags.map((g) => <span key={g} className="tag">{g}</span>)}</div>}
                      </td>
                      <td className="date">{fmtDate(t.entryDate)}</td>
                      <td className="num">{fmtMoney(t.entryPrice)}</td>
                      <td className="num">
                        {fmtQty(t.qty)}
                        {s.status === "partial" && <div className="sub">{fmtQty(s.remaining)} left</div>}
                      </td>
                      <td className="num">{fmtMoney(s.value)}</td>
                      <td className="date">{s.lastExit ? fmtDate(s.lastExit) : "—"}</td>
                      <td className="num">
                        {s.avgExit != null ? fmtMoney(s.avgExit) : s.livePrice ? <span className="live" title="Live price">{fmtMoney(s.livePrice)}</span> : "—"}
                      </td>
                      <td className="num"><PLValue s={s} kind="pct" /></td>
                      <td className="num"><PLValue s={s} kind="usd" /></td>
                      <td><StatusPill status={s.status} /></td>
                      <td className="col-actions">
                        <button className="icon-btn" aria-label={`Edit ${t.ticker}`} title="Edit" onClick={() => onEdit(t)}>✎</button>
                        <button className="icon-btn danger" aria-label={`Delete ${t.ticker}`} title="Delete" onClick={() => onDelete(t.id)}>✕</button>
                      </td>
                    </tr>
                    {open && (
                      <tr className="detail-row">
                        <td colSpan={COLUMNS.length}><TradeDetails t={t} s={s} /></td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="card-list mobile-only">
            {rows.map((t) => {
              const s = stats.get(t.id);
              const open = expanded.has(t.id);
              return (
                <article key={t.id} className={"trade-card " + rowClassFor(s)}>
                  <div className="card-head">
                    <div className="ticker-cell">
                      <TickerLink ticker={t.ticker} />
                      {t.side === "short" && <span className="side-badge">Short</span>}
                    </div>
                    <StatusPill status={s.status} />
                  </div>
                  <div className="card-grid">
                    <div><span className="k">Entry</span><span className="v">{fmtDate(t.entryDate)} @ {fmtMoney(t.entryPrice)}</span></div>
                    <div><span className="k">Exit</span><span className="v">{s.lastExit ? `${fmtDate(s.lastExit)} @ ${fmtMoney(s.avgExit)}` : s.livePrice ? `Live ${fmtMoney(s.livePrice)}` : "—"}</span></div>
                    <div><span className="k">Shares</span><span className="v">{fmtQty(t.qty)}{s.status === "partial" ? ` (${fmtQty(s.remaining)} left)` : ""}</span></div>
                    <div><span className="k">P/L</span><span className="v">{s.realized == null && s.unrealized == null ? <span className="zero">—</span> : <><PLValue s={s} kind="usd" /> <PLValue s={s} kind="pct" /></>}</span></div>
                  </div>
                  {t.tags.length > 0 && <div className="tag-row">{t.tags.map((g) => <span key={g} className="tag">{g}</span>)}</div>}
                  {open && <TradeDetails t={t} s={s} />}
                  <div className="card-actions">
                    <button className="btn ghost small" aria-expanded={open} onClick={() => toggleExpanded(t.id)}>{open ? "Hide details" : "Details"}</button>
                    <button className="icon-btn" aria-label={`Edit ${t.ticker}`} onClick={() => onEdit(t)}>✎</button>
                    <button className="icon-btn danger" aria-label={`Delete ${t.ticker}`} onClick={() => onDelete(t.id)}>✕</button>
                  </div>
                </article>
              );
            })}
          </div>
        </>
      )}

      {trades.length === 0 && (
        <div className="empty-state">No trades logged yet. Click "New Entry" to add your first position, or import a CSV.</div>
      )}
      {trades.length > 0 && rows.length === 0 && (
        <div className="empty-state">
          No trades match your filters. <button className="link-btn" onClick={clearFilters}>Clear filters</button>
        </div>
      )}
    </div>
  );
}

function TickerLink({ ticker }) {
  return (
    <a className="ticker-link" href={tvWebUrl(ticker)} target="_blank" rel="noopener noreferrer"
      onClick={(e) => { e.preventDefault(); openTradingView(ticker); }}>
      {ticker}
    </a>
  );
}
function StatusPill({ status }) {
  return <span className={"status-pill status-" + status}>{STATUS_LABEL[status]}</span>;
}
// Realized P/L when there are exits; otherwise unrealized (live price) in italics
function PLValue({ s, kind }) {
  const pct = kind === "pct";
  if (s.realized != null) {
    const v = pct ? s.realizedPct : s.realized;
    return <span className={signClass(v, pct ? 0.005 : EPS)}>{pct ? fmtPct(v) : fmtMoney(v, true)}</span>;
  }
  if (s.unrealized != null) {
    const v = pct ? s.unrealizedPct : s.unrealized;
    return <span className={"unreal " + signClass(v, pct ? 0.005 : EPS)} title="Unrealized, based on the live price">{pct ? fmtPct(v) : fmtMoney(v, true)}</span>;
  }
  return <span className="zero">—</span>;
}

function TradeDetails({ t, s }) {
  const exits = [...t.exits].sort((a, b) => (a.date < b.date ? -1 : 1));
  const feePerShare = t.qty > 0 ? t.entryFees / t.qty : 0;
  return (
    <div className="details">
      <div className="details-block">
        <div className="details-label">Exits</div>
        {exits.length === 0 ? (
          <div className="details-text zero">No exits yet.</div>
        ) : (
          <table className="mini-table">
            <thead><tr><th scope="col">Date</th><th scope="col" className="num">Price</th><th scope="col" className="num">Shares</th><th scope="col" className="num">Fees</th><th scope="col" className="num">P/L</th></tr></thead>
            <tbody>
              {exits.map((e) => {
                const pl = s.dir * (e.price - t.entryPrice) * e.shares - e.fees - feePerShare * e.shares;
                return (
                  <tr key={e.id}>
                    <td className="date">{fmtDate(e.date)}</td>
                    <td className="num">{fmtMoney(e.price)}</td>
                    <td className="num">{fmtQty(e.shares)}</td>
                    <td className="num">{e.fees ? fmtMoney(e.fees) : "—"}</td>
                    <td className={"num " + signClass(pl)}>{fmtMoney(pl, true)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {s.status === "partial" && s.unrealized != null && (
          <div className="details-text">Remaining {fmtQty(s.remaining)} shares: <span className={signClass(s.unrealized)}>{fmtMoney(s.unrealized, true)}</span> unrealized</div>
        )}
      </div>
      <div className="details-block">
        <div className="details-label">Info</div>
        <div className="details-text">Direction: {t.side === "short" ? "Short" : "Long"}</div>
        <div className="details-text">Total fees: {s.fees ? fmtMoney(s.fees) : "—"}</div>
        {s.holdDays != null && <div className="details-text">Held: {s.holdDays} day{s.holdDays === 1 ? "" : "s"}</div>}
        {t.setup && <div className="details-text">Setup: {t.setup}</div>}
      </div>
      {(t.notes || t.mistakes) && (
        <div className="details-block wide">
          {t.notes && (<><div className="details-label">Notes</div><div className="details-text pre">{t.notes}</div></>)}
          {t.mistakes && (<><div className="details-label">Mistakes / lessons</div><div className="details-text pre">{t.mistakes}</div></>)}
        </div>
      )}
    </div>
  );
}

/* ================================================================
   MODALS
   ================================================================ */
function Modal({ titleId, onClose, children, wide }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") closeRef.current(); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, []);
  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={"modal-box" + (wide ? " wide" : "")} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        {children}
      </div>
    </div>
  );
}

function tradeToForm(t) {
  if (!t) return { ticker: "", side: "long", entryDate: todayISO(), entryPrice: "", qty: "", entryFees: "", exits: [], notes: "", tags: "", setup: "", mistakes: "" };
  return {
    ticker: t.ticker, side: t.side, entryDate: t.entryDate,
    entryPrice: String(t.entryPrice), qty: String(t.qty), entryFees: t.entryFees ? String(t.entryFees) : "",
    exits: t.exits.map((e) => ({ key: e.id, date: e.date, price: String(e.price), shares: String(e.shares), fees: e.fees ? String(e.fees) : "" })),
    notes: t.notes, tags: t.tags.join(", "), setup: t.setup, mistakes: t.mistakes,
  };
}

function validateForm(f) {
  const errors = {};
  const today = todayISO();
  const ticker = f.ticker.trim().toUpperCase();
  if (!ticker) errors.ticker = "Enter a ticker";
  else if (!TICKER_RE.test(ticker)) errors.ticker = "Use a ticker like AAPL, BRK.B or BTC-USD";
  if (!isValidISO(f.entryDate)) errors.entryDate = "Pick the entry date";
  else if (f.entryDate > today) errors.entryDate = "Can't be in the future";
  const entryPrice = parseDec(f.entryPrice);
  if (!(entryPrice > 0)) errors.entryPrice = "Enter a price above 0";
  const qty = parseDec(f.qty);
  if (!(qty > 0)) errors.qty = "Enter shares above 0";
  const entryFees = String(f.entryFees).trim() === "" ? 0 : parseDec(f.entryFees);
  if (!(entryFees >= 0)) errors.entryFees = "Fees can't be negative";

  const exits = [];
  let exitShares = 0;
  f.exits.forEach((e, i) => {
    const blank = !e.date && !String(e.price).trim() && !String(e.shares).trim() && !String(e.fees).trim();
    if (blank) return;
    const p = `exit${i}-`;
    if (!isValidISO(e.date)) errors[p + "date"] = "Pick a date";
    else if (e.date > today) errors[p + "date"] = "Can't be in the future";
    else if (isValidISO(f.entryDate) && e.date < f.entryDate) errors[p + "date"] = "Before the entry date";
    const price = parseDec(e.price);
    if (!(price > 0)) errors[p + "price"] = "Above 0";
    const shares = parseDec(e.shares);
    if (!(shares > 0)) errors[p + "shares"] = "Above 0";
    const fees = String(e.fees).trim() === "" ? 0 : parseDec(e.fees);
    if (!(fees >= 0)) errors[p + "fees"] = "Not negative";
    if (shares > 0) exitShares += shares;
    exits.push({ id: e.key || newId(), date: e.date, price, shares, fees });
  });
  if (qty > 0 && exitShares > qty * (1 + 1e-9)) {
    errors.exits = `Exits add up to ${fmtQty(round8(exitShares))} shares, but the position only has ${fmtQty(qty)}.`;
  }
  const tags = [...new Set(f.tags.split(",").map((s) => s.trim()).filter(Boolean))].slice(0, 12);
  return {
    errors,
    trade: { ticker, side: f.side, entryDate: f.entryDate, entryPrice, qty, entryFees, exits, notes: f.notes.trim(), tags, setup: f.setup.trim(), mistakes: f.mistakes.trim() },
  };
}

function TradeModal({ trade, onSave, onClose }) {
  const [form, setForm] = useState(() => tradeToForm(trade));
  const [errors, setErrors] = useState({});
  const [tried, setTried] = useState(false);
  const formRef = useRef(null);
  const today = todayISO();

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setExit = (i, k, v) => setForm((f) => ({ ...f, exits: f.exits.map((e, j) => (j === i ? { ...e, [k]: v } : e)) }));
  function addExit() {
    setForm((f) => {
      const q = parseDec(f.qty);
      const used = f.exits.reduce((s, e) => s + (parseDec(e.shares) || 0), 0);
      const rem = q > 0 ? round8(Math.max(0, q - used)) : 0;
      return { ...f, exits: [...f.exits, { key: newId(), date: today, price: "", shares: rem ? String(rem) : "", fees: "" }] };
    });
  }
  const removeExit = (i) => setForm((f) => ({ ...f, exits: f.exits.filter((_, j) => j !== i) }));

  // After the first save attempt, re-check as the user types
  useEffect(() => { if (tried) setErrors(validateForm(form).errors); }, [form, tried]);

  function submit(e) {
    e.preventDefault();
    setTried(true);
    const { errors: errs, trade: t } = validateForm(form);
    setErrors(errs);
    if (Object.keys(errs).length) {
      setTimeout(() => { const el = formRef.current && formRef.current.querySelector('[aria-invalid="true"]'); if (el) el.focus(); }, 0);
      return;
    }
    onSave(t);
  }

  const errCount = Object.keys(errors).length;
  const isShort = form.side === "short";
  const inputProps = (id, key, err) => ({
    id, value: form[key], onChange: (e) => set(key, e.target.value),
    "aria-invalid": !!err, "aria-describedby": err ? id + "-err" : undefined,
  });

  return (
    <Modal titleId="trade-modal-title" onClose={onClose} wide>
      <form ref={formRef} onSubmit={submit} noValidate>
        <div className="modal-header">
          <h2 id="trade-modal-title">{trade ? "Edit Trade" : "New Entry"}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button>
        </div>

        {errCount > 0 && (
          <div className="form-alert" role="alert">
            {errCount === 1 ? "Please fix the highlighted field." : `Please fix the ${errCount} highlighted fields.`}
          </div>
        )}

        <div className="modal-section-label">Position</div>
        <div className="seg" role="group" aria-label="Direction">
          <button type="button" className={"seg-btn" + (!isShort ? " active" : "")} aria-pressed={!isShort} onClick={() => set("side", "long")}>Long (buy first)</button>
          <button type="button" className={"seg-btn" + (isShort ? " active" : "")} aria-pressed={isShort} onClick={() => set("side", "short")}>Short (sell first)</button>
        </div>
        <div className="modal-grid">
          <Field id="f-ticker" label="Stock (ticker)" error={errors.ticker}>
            <input {...inputProps("f-ticker", "ticker", errors.ticker)} type="text" placeholder="AAPL" autoFocus autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={15} />
          </Field>
          <Field id="f-entryDate" label={isShort ? "Short date" : "Buy date"} error={errors.entryDate}>
            <input {...inputProps("f-entryDate", "entryDate", errors.entryDate)} type="date" max={today} />
          </Field>
          <Field id="f-entryPrice" label={isShort ? "Short price" : "Buy price"} error={errors.entryPrice}>
            <input {...inputProps("f-entryPrice", "entryPrice", errors.entryPrice)} type="text" inputMode="decimal" placeholder="0.00" autoComplete="off" />
          </Field>
          <Field id="f-qty" label="Shares" error={errors.qty}>
            <input {...inputProps("f-qty", "qty", errors.qty)} type="text" inputMode="decimal" placeholder="0" autoComplete="off" />
          </Field>
          <Field id="f-entryFees" label="Fees / commission (optional)" error={errors.entryFees}>
            <input {...inputProps("f-entryFees", "entryFees", errors.entryFees)} type="text" inputMode="decimal" placeholder="0.00" autoComplete="off" />
          </Field>
        </div>

        <div className="modal-section-label">{isShort ? "Exits (buy to cover)" : "Exits (sells)"}</div>
        {errors.exits && <div className="field-error block" role="alert">{errors.exits}</div>}
        {form.exits.length === 0 && <div className="hint">No exits yet, so the position is open. Add an exit when you sell part or all of it.</div>}
        {form.exits.map((e, i) => {
          const p = `exit${i}-`;
          const ex = (k, label, props) => (
            <Field id={`f-${p}${k}`} label={label} error={errors[p + k]}>
              <input id={`f-${p}${k}`} value={e[k]} onChange={(ev) => setExit(i, k, ev.target.value)}
                aria-invalid={!!errors[p + k]} aria-describedby={errors[p + k] ? `f-${p}${k}-err` : undefined} {...props} />
            </Field>
          );
          return (
            <div className="exit-row" key={e.key}>
              {ex("date", "Date", { type: "date", min: form.entryDate || undefined, max: today })}
              {ex("price", "Price", { type: "text", inputMode: "decimal", placeholder: "0.00", autoComplete: "off" })}
              {ex("shares", "Shares", { type: "text", inputMode: "decimal", placeholder: "0", autoComplete: "off" })}
              {ex("fees", "Fees", { type: "text", inputMode: "decimal", placeholder: "0.00", autoComplete: "off" })}
              <button type="button" className="icon-btn danger exit-remove" aria-label={`Remove exit ${i + 1}`} onClick={() => removeExit(i)}>✕</button>
            </div>
          );
        })}
        <button type="button" className="btn ghost small" onClick={addExit}>+ Add exit</button>

        <div className="modal-section-label">Journal</div>
        <div className="modal-grid">
          <Field id="f-setup" label="Setup / strategy">
            <input {...inputProps("f-setup", "setup")} type="text" placeholder="Breakout, earnings, pullback…" maxLength={80} />
          </Field>
          <Field id="f-tags" label="Tags (comma separated)">
            <input {...inputProps("f-tags", "tags")} type="text" placeholder="swing, tech" maxLength={200} />
          </Field>
          <Field id="f-notes" label="Notes: why I entered" className="span-2">
            <textarea {...inputProps("f-notes", "notes")} rows={3} maxLength={4000} />
          </Field>
          <Field id="f-mistakes" label="Mistakes / lessons" className="span-2">
            <textarea {...inputProps("f-mistakes", "mistakes")} rows={2} maxLength={4000} />
          </Field>
        </div>

        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn">{trade ? "Update" : "Save"}</button>
        </div>
      </form>
    </Modal>
  );
}

function Field({ id, label, error, children, className }) {
  return (
    <div className={"field" + (error ? " has-error" : "") + (className ? " " + className : "")}>
      <label htmlFor={id}>{label}</label>
      {children}
      {error && <div className="field-error" id={id + "-err"}>{error}</div>}
    </div>
  );
}

function SettingsModal({ theme, finnhubKey, onSaveKey, onClose }) {
  const [key, setKey] = useState(finnhubKey);
  return (
    <Modal titleId="settings-title" onClose={onClose}>
      <div className="modal-header">
        <h2 id="settings-title">Settings</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      <div className="modal-section-label">Theme</div>
      <div className="seg" role="group" aria-label="Theme">
        {[["dark", "Dark"], ["light", "Light"], ["system", "Match device"]].map(([id, label]) => (
          <button key={id} type="button" className={"seg-btn" + (theme.pref === id ? " active" : "")} aria-pressed={theme.pref === id} onClick={() => theme.choose(id)}>{label}</button>
        ))}
      </div>
      <div className="modal-section-label">Live prices</div>
      <p className="hint">
        Open positions can show live prices and unrealized P/L. Create a free API key at{" "}
        <a href="https://finnhub.io/register" target="_blank" rel="noopener noreferrer">finnhub.io</a>, then paste it here.
        It's saved to your account, and only you can read it.
      </p>
      <form onSubmit={(e) => { e.preventDefault(); onSaveKey(key.trim()); onClose(); }}>
        <div className="field">
          <label htmlFor="fh-key">Finnhub API key</label>
          <input id="fh-key" type="text" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false} placeholder="Paste your key" />
        </div>
        <div className="modal-actions">
          {finnhubKey && <button type="button" className="btn ghost" onClick={() => { onSaveKey(""); onClose(); }}>Remove key</button>}
          <button type="submit" className="btn">Save</button>
        </div>
      </form>
    </Modal>
  );
}

function ImportModal({ data, onConfirm, onClose }) {
  const preview = data.trades.slice(0, 8);
  return (
    <Modal titleId="import-title" onClose={onClose} wide>
      <div className="modal-header">
        <h2 id="import-title">Import trades</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      <p className="hint">
        Found <strong>{data.trades.length}</strong> trade{data.trades.length === 1 ? "" : "s"} ({data.txCount} transactions) in {data.name}.
        {data.skipped ? ` ${data.skipped === 1 ? "1 row was" : data.skipped + " rows were"} skipped (only buys and sells with a ticker, date, price and shares are imported).` : ""}
        {" "}They'll be added to your existing trades.
      </p>
      <div className="table-scroll">
        <table className="mini-table">
          <thead><tr><th scope="col">Stock</th><th scope="col">Side</th><th scope="col">Entry</th><th scope="col" className="num">Price</th><th scope="col" className="num">Shares</th><th scope="col">Status</th></tr></thead>
          <tbody>
            {preview.map((t) => {
              const s = tradeStats(t);
              return (
                <tr key={t.id}>
                  <td>{t.ticker}</td><td>{t.side === "short" ? "Short" : "Long"}</td><td className="date">{fmtDate(t.entryDate)}</td>
                  <td className="num">{fmtMoney(t.entryPrice)}</td><td className="num">{fmtQty(t.qty)}</td><td><StatusPill status={s.status} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {data.trades.length > preview.length && <div className="hint">…and {data.trades.length - preview.length} more.</div>}
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn" onClick={onConfirm}>Import {data.trades.length} trade{data.trades.length === 1 ? "" : "s"}</button>
      </div>
    </Modal>
  );
}

/* ================================================================
   OVERVIEW TAB
   ================================================================ */
function PeriodPicker({ period, setPeriod }) {
  return (
    <div className="timeframe-select" role="group" aria-label="Time period">
      {PERIODS.map(([id, label]) => (
        <button key={id} type="button" className={"tf-btn" + (period === id ? " active" : "")} aria-pressed={period === id} onClick={() => setPeriod(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}
function StatCard({ label, value, cls = "", sub, small }) {
  return (
    <div className={"stat-card" + (small ? " small" : "")}>
      <div className="stat-label">{label}</div>
      <div className={"stat-value " + cls}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function Overview({ trades, stats, period, setPeriod }) {
  const a = useMemo(() => computeAnalytics(trades, stats, period), [trades, stats, period]);
  const pf = a.profitFactor;
  return (
    <div>
      <PeriodPicker period={period} setPeriod={setPeriod} />

      <div className="stat-grid">
        <StatCard label="Closed Trades" value={a.closed.length} sub={a.closed.length ? `${a.wins.length} won · ${a.losses.length} lost` : null} />
        <StatCard label="Win Rate" value={a.winRate == null ? "—" : NF0.format(a.winRate) + "%"} />
        <StatCard label="Realized P/L" value={fmtMoney(a.totalPL, true)} cls={signClass(a.totalPL)} sub="Includes partial exits" />
        <StatCard label="Avg P/L %" value={fmtPct(a.avgPct)} cls={signClass(a.avgPct, 0.005)} />
      </div>

      <h2 className="section-label spaced">Analytics</h2>
      <div className="stat-grid six">
        <StatCard small label="Avg Win" value={fmtMoney(a.avgWin, true)} cls={signClass(a.avgWin)} />
        <StatCard small label="Avg Loss" value={fmtMoney(a.avgLoss, true)} cls={signClass(a.avgLoss)} />
        <StatCard small label="Profit Factor" value={pf == null ? "—" : pf === Infinity ? "∞" : NF2.format(pf)} cls={pf == null ? "zero" : pf >= 1 ? "pos" : "neg"} />
        <StatCard small label="Expectancy / Trade" value={fmtMoney(a.expectancy, true)} cls={signClass(a.expectancy)} />
        <StatCard small label="Max Drawdown" value={a.maxDD > EPS ? fmtMoney(-a.maxDD) : "$0.00"} cls={a.maxDD > EPS ? "neg" : "zero"} />
        <StatCard small label="Avg Holding Time" value={a.avgHold == null ? "—" : `${NF1.format(a.avgHold)} day${a.avgHold === 1 ? "" : "s"}`} />
      </div>

      <div className="best-worst">
        <div className={"bw-card" + (a.best ? " best" : "")}>
          <div className="bw-title">Best Trade</div>
          <div className="bw-ticker">{a.best ? a.best.t.ticker : "—"}</div>
          <div className={"bw-pct " + (a.best ? "pos" : "zero")}>
            {a.best ? `${fmtMoney(a.best.s.realized, true)}  (${fmtPct(a.best.s.realizedPct)})` : "No winning trades"}
          </div>
        </div>
        <div className={"bw-card" + (a.worst ? " worst" : "")}>
          <div className="bw-title">Worst Trade</div>
          <div className="bw-ticker">{a.worst ? a.worst.t.ticker : "—"}</div>
          <div className={"bw-pct " + (a.worst ? "neg" : "zero")}>
            {a.worst ? `${fmtMoney(a.worst.s.realized, true)}  (${fmtPct(a.worst.s.realizedPct)})` : "No losing trades"}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ================================================================
   PERFORMANCE TAB (Chart.js is loaded only when this tab opens)
   ================================================================ */
function Performance({ trades, stats, period, setPeriod, allEvents, themeName }) {
  const a = useMemo(() => computeAnalytics(trades, stats, period), [trades, stats, period]);
  const eqRef = useRef(null);
  const barRef = useRef(null);
  const pieRef = useRef(null);
  const hasData = a.events.length > 0;

  useEffect(() => {
    if (!hasData) return;
    let cancelled = false;
    const charts = [];
    import("chart.js/auto").then((mod) => {
      if (cancelled) return;
      const Chart = mod.default;
      const css = getComputedStyle(document.documentElement);
      const v = (n) => css.getPropertyValue(n).trim();
      const grid = v("--border"), text = v("--text-dim"), gold = v("--gold"), green = v("--green"), red = v("--red"), surface = v("--surface-alt"), faint = v("--text-faint");
      Chart.defaults.font.family = "'JetBrains Mono', monospace";
      Chart.defaults.font.size = 11;
      Chart.defaults.color = text;

      // Cumulative P/L on a real time axis: one point per date, starting from $0 the day before
      const byDate = new Map();
      a.events.forEach((e) => byDate.set(e.date, (byDate.get(e.date) || 0) + e.pl));
      const dates = [...byDate.keys()].sort();
      let run = 0;
      const pts = [{ x: parseLocalDate(dates[0]).getTime() - DAY, y: 0 }]
        .concat(dates.map((d) => ({ x: parseLocalDate(d).getTime(), y: (run += byDate.get(d)) })));
      if (eqRef.current) {
        charts.push(new Chart(eqRef.current, {
          type: "line",
          data: { datasets: [{ data: pts, borderColor: gold, backgroundColor: withAlpha(gold, 0.1), fill: true, tension: 0.2, pointRadius: 3, pointBackgroundColor: gold }] },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: { callbacks: { title: (items) => DF.format(new Date(items[0].parsed.x)), label: (item) => "Cumulative " + fmtMoney(item.parsed.y, true) } },
            },
            scales: {
              x: { type: "linear", grid: { color: grid }, ticks: { color: text, maxTicksLimit: 6, callback: (val) => DF_SHORT.format(new Date(val)) } },
              y: { grid: { color: grid }, ticks: { color: text, callback: (val) => fmtCompactMoney(val) } },
            },
          },
        }));
      }

      if (barRef.current) {
        const pt = a.perTrade;
        charts.push(new Chart(barRef.current, {
          type: "bar",
          data: { labels: pt.map((p) => p.ticker), datasets: [{ data: pt.map((p) => p.pl), backgroundColor: pt.map((p) => withAlpha(p.pl >= 0 ? green : red, 0.75)) }] },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: { callbacks: { title: (items) => `${pt[items[0].dataIndex].ticker} · ${fmtDate(pt[items[0].dataIndex].date)}`, label: (item) => fmtMoney(item.parsed.y, true) } },
            },
            scales: {
              x: { grid: { display: false }, ticks: { color: text } },
              y: { grid: { color: grid }, ticks: { color: text, callback: (val) => fmtCompactMoney(val) } },
            },
          },
        }));
      }

      if (pieRef.current) {
        const labels = ["Wins", "Losses"], data = [a.wins.length, a.losses.length], colors = [green, red];
        if (a.flat) { labels.push("Breakeven"); data.push(a.flat); colors.push(faint); }
        charts.push(new Chart(pieRef.current, {
          type: "doughnut",
          data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: surface, borderWidth: 3 }] },
          options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom", labels: { color: text } } } },
        }));
      }
    }).catch((e) => console.error("Couldn't load charts", e));
    return () => { cancelled = true; charts.forEach((c) => c.destroy()); };
  }, [a, themeName, hasData]);

  return (
    <div>
      <PeriodPicker period={period} setPeriod={setPeriod} />
      {!hasData ? (
        <div className="empty-state">No realized P/L in this period yet.</div>
      ) : (
        <>
          <div className="chart-box">
            <h2 className="chart-title">Cumulative P/L</h2>
            <div className="chart-canvas tall"><canvas ref={eqRef} role="img" aria-label="Cumulative realized profit and loss over time" /></div>
          </div>
          <div className="chart-row">
            <div className="chart-box">
              <h2 className="chart-title">P/L per Trade</h2>
              <div className="chart-canvas"><canvas ref={barRef} role="img" aria-label="Realized profit and loss per trade" /></div>
            </div>
            <div className="chart-box">
              <h2 className="chart-title">Win / Loss Split</h2>
              {a.closed.length ? (
                <div className="chart-canvas"><canvas ref={pieRef} role="img" aria-label={`${a.wins.length} wins, ${a.losses.length} losses`} /></div>
              ) : (
                <div className="chart-empty">No fully closed trades in this period.</div>
              )}
            </div>
          </div>
          <div className="chart-box">
            <h2 className="chart-title">By Ticker</h2>
            <div className="table-scroll">
              <table className="mini-table">
                <thead><tr><th scope="col">Ticker</th><th scope="col" className="num">Closed</th><th scope="col" className="num">Win Rate</th><th scope="col" className="num">Realized P/L</th></tr></thead>
                <tbody>
                  {a.byTicker.map((r) => (
                    <tr key={r.ticker}>
                      <td><TickerLink ticker={r.ticker} /></td>
                      <td className="num">{r.closed}</td>
                      <td className="num">{r.closed ? NF0.format((r.wins / r.closed) * 100) + "%" : "—"}</td>
                      <td className={"num " + signClass(r.pl)}>{fmtMoney(r.pl, true)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
      <div className="chart-box">
        <h2 className="chart-title">Monthly P/L (all time)</h2>
        <Heatmap events={allEvents} />
      </div>
    </div>
  );
}

function Heatmap({ events }) {
  const map = new Map();
  events.forEach((e) => { const k = e.date.slice(0, 7); map.set(k, (map.get(k) || 0) + e.pl); });
  if (!map.size) return <div className="chart-empty">No realized P/L yet.</div>;
  const years = [...new Set([...map.keys()].map((k) => k.slice(0, 4)))].sort().reverse();
  const maxAbs = Math.max(...[...map.values()].map(Math.abs)) || 1;
  return (
    <div className="table-scroll">
      <table className="heatmap">
        <thead><tr><th scope="col">Year</th>{MONTHS.map((m) => <th scope="col" key={m}>{m}</th>)}<th scope="col" className="num">Total</th></tr></thead>
        <tbody>
          {years.map((y) => {
            const vals = MONTHS.map((_, i) => map.get(`${y}-${pad(i + 1)}`));
            const total = vals.reduce((s, v) => s + (v || 0), 0);
            return (
              <tr key={y}>
                <th scope="row">{y}</th>
                {vals.map((v, i) =>
                  v == null ? (
                    <td key={i} className="hm-empty" />
                  ) : (
                    <td key={i} className={"hm-cell " + signClass(v)} style={{ "--hm-a": (0.14 + 0.56 * (Math.abs(v) / maxAbs)).toFixed(2) }} title={`${MONTHS[i]} ${y}: ${fmtMoney(v, true)}`}>
                      {fmtCompactMoney(v)}
                    </td>
                  )
                )}
                <td className={"num " + signClass(total)}>{fmtMoney(total, true)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
