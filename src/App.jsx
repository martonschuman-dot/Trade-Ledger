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
