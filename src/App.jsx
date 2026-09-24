import { useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";
import Chart from "chart.js/auto";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { auth, provider, db } from "./firebase";

/* ---------------- CONSTANTS ---------------- */
// Where the old (pre-login) version kept trades in this browser
const LEGACY_KEY = "tradeLedgerData";
// Remembers that the old trades were already imported, so a second account doesn't import them too
const IMPORTED_KEY = "tradeLedgerImportedBy";

const EMPTY_FORM = { ticker: "", buyDate: "", buyPrice: "", shares: "", sellDate: "", sellPrice: "" };

/* ---------------- HELPERS ---------------- */
function plPercent(t) {
  if (!t.sellPrice) return null;
  return ((t.sellPrice - t.buyPrice) / t.buyPrice) * 100;
}
function plDollar(t) {
  if (!t.sellPrice) return null;
  return (t.sellPrice - t.buyPrice) * t.shares;
}
function fmtMoney(n) {
  const sign = n < 0 ? "-" : "";
  return sign + "$" + Math.abs(n).toFixed(2);
}
function fmtPct(n) {
  const sign = n > 0 ? "+" : "";
  return sign + n.toFixed(2) + "%";
}
function parseLocalDate(str) {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function tfFilter(t, tf) {
  if (!t.sellDate) return false;
  if (tf === "all") return true;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const diffDays = Math.floor((now - parseLocalDate(t.sellDate)) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return false; // sell date in the future
  if (tf === "week") return diffDays <= 7;
  if (tf === "month") return diffDays <= 30;
  if (tf === "year") return diffDays <= 365;
  return true;
}
function openTradingView(ticker) {
  const symbol = ticker.toUpperCase();
  const appUrl = "tradingview://" + symbol;
  const webUrl = "https://www.tradingview.com/symbols/" + symbol + "/";
  let hidden = false;
  const onBlur = () => { hidden = true; };
  window.addEventListener("blur", onBlur);
  window.location.href = appUrl;
  setTimeout(() => {
    window.removeEventListener("blur", onBlur);
    if (!hidden) window.open(webUrl, "_blank");
  }, 900);
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

/* ================================================================
   APP: decides between loading, sign-in screen, and the ledger
   ================================================================ */
export default function App() {
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
  return <Ledger key={user.uid} user={user} />;
}

function Splash({ text }) {
  return (
    <div className="gate">
      <div className="gate-text">{text}</div>
    </div>
  );
}

function SignIn({ onSignIn, error }) {
  return (
    <div className="gate">
      <div className="gate-box">
        <div className="masthead-title">Trade<span>Ledger</span></div>
        <div className="masthead-sub">Personal Position Journal</div>
        <p className="gate-text">
          Sign in to open your ledger. Your trades are saved to your Google account, so they're the same on every device.
        </p>
        <button className="btn" onClick={onSignIn}>Sign in with Google</button>
        {error && <div className="gate-error">{error}</div>}
      </div>
    </div>
  );
}

/* ================================================================
   LEDGER: the actual app, one Firestore document per user
   ================================================================ */
function Ledger({ user }) {
  const userDoc = useMemo(() => doc(db, "users", user.uid), [user.uid]);

  const [trades, setTrades] = useState(null); // null = loading
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState(false);
  const [notice, setNotice] = useState("");

  const [tab, setTab] = useState("ledger");
  const [tf, setTf] = useState("month");

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [heading, setHeading] = useState("New Entry");
  const [exportLabel, setExportLabel] = useState("Export PDF");

  /* ---------- load (and one-time import of old browser data) ---------- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDoc(userDoc);
        if (cancelled) return;
        if (snap.exists()) {
          setTrades(snap.data().trades || []);
          return;
        }
        // First sign-in for this account: bring over trades saved by the old version
        let alreadyImported = null;
        try { alreadyImported = localStorage.getItem(IMPORTED_KEY); } catch { /* ignore */ }
        const initial = alreadyImported ? [] : readLegacyTrades();
        await setDoc(userDoc, { trades: initial });
        if (initial.length) {
          try { localStorage.setItem(IMPORTED_KEY, user.uid); } catch { /* ignore */ }
          setNotice(`Imported ${initial.length} trade${initial.length === 1 ? "" : "s"} from this browser into your account.`);
        }
        if (!cancelled) setTrades(initial);
      } catch (e) {
        console.error(e);
        if (!cancelled) setLoadError("Couldn't load your ledger. Check your connection and reload the page.");
      }
    })();
    return () => { cancelled = true; };
  }, [userDoc, user.uid]);

  /* ---------- save: update screen immediately, then write to Firestore ---------- */
  function commit(next) {
    setTrades(next);
    setDoc(userDoc, { trades: next })
      .then(() => setSaveError(false))
      .catch((e) => {
        console.error(e);
        setSaveError(true);
      });
  }

  /* ---------- modal ---------- */
  function openNew() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setHeading("New Entry");
    setModalOpen(true);
  }
  function closeModal() {
    setModalOpen(false);
    setForm(EMPTY_FORM);
    setEditingId(null);
    setHeading("New Entry");
  }
  function editTrade(id) {
    const t = trades.find((tr) => tr.id === id);
    if (!t) return;
    setEditingId(id);
    setForm({
      ticker: t.ticker,
      buyDate: t.buyDate,
      buyPrice: String(t.buyPrice),
      shares: String(t.shares),
      sellDate: t.sellDate || "",
      sellPrice: t.sellPrice ? String(t.sellPrice) : "",
    });
    setHeading(t.sellPrice === null ? "Close Position / Edit Trade" : "Edit Trade");
    setModalOpen(true);
  }
  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (e) => { if (e.key === "Escape") closeModal(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [modalOpen]);

  function setField(name, value) {
    setForm((f) => ({ ...f, [name]: value }));
  }

  function saveRow() {
    const ticker = form.ticker.trim().toUpperCase();
    const buyDate = form.buyDate;
    const buyPrice = parseFloat(form.buyPrice);
    const shares = parseFloat(form.shares);
    const sellDate = form.sellDate || null;
    const sellPrice = form.sellPrice ? parseFloat(form.sellPrice) : null;

    if (!ticker || !buyDate || isNaN(buyPrice) || isNaN(shares)) {
      setHeading("Please fill in Stock, Buy Date, Buy Price and Shares");
      return;
    }
    if (sellDate && sellDate < buyDate) {
      setHeading("Sell date can't be before the buy date");
      return;
    }

    let next;
    if (editingId !== null) {
      next = trades.map((t) =>
        t.id === editingId ? { ...t, ticker, buyDate, buyPrice, shares, sellDate, sellPrice } : t
      );
    } else {
      const nextId = trades.length ? Math.max(...trades.map((t) => t.id)) + 1 : 1;
      next = [...trades, { id: nextId, ticker, buyDate, buyPrice, shares, sellDate, sellPrice }];
    }
    closeModal();
    commit(next);
  }

  function deleteTrade(id) {
    commit(trades.filter((t) => t.id !== id));
  }

  /* ---------- PDF export ---------- */
  function exportPdf() {
    if (trades.length === 0) {
      setExportLabel("No trades yet");
      setTimeout(() => setExportLabel("Export PDF"), 1500);
      return;
    }

    const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });

    const sorted = trades.slice().sort((a, b) => new Date(a.buyDate) - new Date(b.buyDate));
    const closed = sorted.filter((t) => t.sellPrice !== null);
    const totalPL = closed.reduce((s, t) => s + plDollar(t), 0);
    const wins = closed.filter((t) => plDollar(t) >= 0).length;
    const winRate = closed.length ? (wins / closed.length) * 100 : 0;
    const today = new Date().toISOString().slice(0, 10);

    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(18);
    pdf.setTextColor(20, 24, 31);
    pdf.text("Trade Ledger", 40, 45);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(10);
    pdf.setTextColor(110, 118, 130);
    pdf.text(
      `Exported ${today}  \u2022  ${trades.length} total positions  \u2022  ${closed.length} closed  \u2022  Win rate ${winRate.toFixed(0)}%  \u2022  Total P/L ${fmtMoney(totalPL)}`,
      40,
      62
    );

    const head = [["Stock", "Buy Date", "Buy Price", "Shares", "Traded Value", "Sell Date", "Sell Price", "P/L %", "P/L $", "Status"]];
    const body = sorted.map((t) => {
      const pct = plPercent(t);
      const dollar = plDollar(t);
      return [
        t.ticker,
        t.buyDate,
        fmtMoney(t.buyPrice),
        String(t.shares),
        fmtMoney(t.buyPrice * t.shares),
        t.sellDate || "\u2014",
        t.sellPrice !== null ? fmtMoney(t.sellPrice) : "\u2014",
        pct === null ? "\u2014" : fmtPct(pct),
        dollar === null ? "\u2014" : fmtMoney(dollar),
        pct === null ? "Open" : "Closed",
      ];
    });

    autoTable(pdf, {
      head,
      body,
      startY: 78,
      theme: "plain",
      styles: { font: "helvetica", fontSize: 9, cellPadding: 6, textColor: [30, 34, 42], lineColor: [225, 228, 233], lineWidth: 0.5 },
      headStyles: { fillColor: [18, 22, 29], textColor: [212, 162, 76], fontStyle: "bold", fontSize: 8.5 },
      alternateRowStyles: { fillColor: [248, 249, 250] },
      columnStyles: { 2: { halign: "right" }, 3: { halign: "right" }, 4: { halign: "right" }, 6: { halign: "right" }, 7: { halign: "right" }, 8: { halign: "right" } },
      didParseCell: (data) => {
        if (data.section !== "body") return;
        const raw = body[data.row.index][data.column.index];
        if (data.column.index === 7 || data.column.index === 8) {
          if (raw.startsWith("+")) data.cell.styles.textColor = [16, 124, 84];
          else if (raw.startsWith("-")) data.cell.styles.textColor = [190, 40, 40];
        }
        if (data.column.index === 9) {
          data.cell.styles.textColor = raw === "Open" ? [180, 130, 40] : [130, 138, 150];
        }
      },
    });

    pdf.save(`trade-ledger-${today}.pdf`);
  }

  /* ---------- loading / error states ---------- */
  if (loadError) return <Splash text={loadError} />;
  if (trades === null) return <Splash text="Loading your ledger…" />;

  /* ---------- derived numbers ---------- */
  const closedAll = trades.filter((t) => t.sellPrice !== null);
  const stripTotal = closedAll.reduce((s, t) => s + plDollar(t), 0);
  const stripWins = closedAll.filter((t) => plDollar(t) >= 0).length;
  const stripWinRate = closedAll.length ? (stripWins / closedAll.length) * 100 : 0;
  const stripOpen = trades.filter((t) => t.sellPrice === null).length;

  const ledgerRows = trades.slice().sort((a, b) => new Date(b.buyDate) - new Date(a.buyDate));

  return (
    <div className="app">
      <div className="account-bar">
        <span>{user.email}</span>
        <button className="btn ghost small" onClick={() => signOut(auth)}>Sign out</button>
      </div>

      <div className="masthead">
        <div>
          <div className="masthead-title">Trade<span>Ledger</span></div>
          <div className="masthead-sub">Personal Position Journal</div>
        </div>
        <div className="ticker-strip">
          <div className="ticker-item">
            <div className="ticker-label">Total P/L</div>
            <div className={"ticker-value " + (stripTotal >= 0 ? "pos" : "neg")}>{fmtMoney(stripTotal)}</div>
          </div>
          <div className="ticker-item">
            <div className="ticker-label">Win Rate</div>
            <div className="ticker-value">{stripWinRate.toFixed(0)}%</div>
          </div>
          <div className="ticker-item">
            <div className="ticker-label">Open</div>
            <div className="ticker-value">{stripOpen}</div>
          </div>
        </div>
      </div>

      {notice && (
        <div className="notice">
          <span>{notice}</span>
          <button className="modal-close" onClick={() => setNotice("")}>✕</button>
        </div>
      )}
      {saveError && (
        <div className="notice error">
          <span>Your last change wasn't saved to your account. Check your connection, then make any change to retry.</span>
        </div>
      )}

      <div className="tabs">
        {[["ledger", "Ledger"], ["overview", "Overview"], ["performance", "Performance"]].map(([id, label]) => (
          <div key={id} className={"tab" + (tab === id ? " active" : "")} onClick={() => setTab(id)}>
            {label}
          </div>
        ))}
      </div>

      <div className="panel">
        {/* LEDGER VIEW */}
        {tab === "ledger" && (
          <div className="view active">
            <div className="ledger-toolbar">
              <div className="section-label">Positions</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn ghost" onClick={exportPdf}>{exportLabel}</button>
                <button className="btn" onClick={openNew}>+ New Entry</button>
              </div>
            </div>

            <div className="ledger-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Stock</th>
                    <th>Buy Date</th>
                    <th className="num">Buy Price</th>
                    <th className="num">Shares</th>
                    <th className="num">Traded Value</th>
                    <th>Sell Date</th>
                    <th className="num">Sell Price</th>
                    <th className="num">P/L %</th>
                    <th className="num">P/L $</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {ledgerRows.map((t) => {
                    const pct = plPercent(t);
                    const dollar = plDollar(t);
                    const rowClass = pct === null ? "row-open" : pct >= 0 ? "row-gain" : "row-loss";
                    return (
                      <tr key={t.id} className={rowClass}>
                        <td>
                          <a className="ticker-link" onClick={() => openTradingView(t.ticker)}>{t.ticker}</a>
                        </td>
                        <td>{t.buyDate}</td>
                        <td className="num">{fmtMoney(t.buyPrice)}</td>
                        <td className="num">{t.shares}</td>
                        <td className="num">{fmtMoney(t.buyPrice * t.shares)}</td>
                        <td>{t.sellDate || "—"}</td>
                        <td className="num">{t.sellPrice ? fmtMoney(t.sellPrice) : "—"}</td>
                        <td className={"num " + (pct === null ? "" : pct >= 0 ? "val-pos" : "val-neg")}>
                          {pct === null ? "—" : fmtPct(pct)}
                        </td>
                        <td className={"num " + (dollar === null ? "" : dollar >= 0 ? "val-pos" : "val-neg")}>
                          {dollar === null ? "—" : fmtMoney(dollar)}
                        </td>
                        <td>
                          <span className={"status-pill " + (pct === null ? "status-open" : "status-closed")}>
                            {pct === null ? "Open" : "Closed"}
                          </span>
                        </td>
                        <td>
                          <button className="row-edit" onClick={() => editTrade(t.id)} title={pct === null ? "Close position / edit" : "Edit"}>✎</button>
                          <button className="row-del" onClick={() => deleteTrade(t.id)}>✕</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {trades.length === 0 && (
              <div className="empty-state">No trades logged yet — click "New Entry" to add your first position.</div>
            )}
          </div>
        )}

        {/* OVERVIEW VIEW */}
        {tab === "overview" && <Overview trades={trades} tf={tf} setTf={setTf} />}

        {/* PERFORMANCE VIEW */}
        {tab === "performance" && <Performance trades={trades} />}
      </div>

      {/* ENTRY MODAL */}
      {modalOpen && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
          <div className="modal-box">
            <div className="modal-header">
              <label>{heading}</label>
              <button className="modal-close" onClick={closeModal}>✕</button>
            </div>
            <div className="modal-grid">
              <div className="field">
                <label>Stock (ticker)</label>
                <input type="text" placeholder="AAPL" value={form.ticker} onChange={(e) => setField("ticker", e.target.value)} />
              </div>
              <div className="field">
                <label>Buy Date</label>
                <input type="date" value={form.buyDate} onChange={(e) => setField("buyDate", e.target.value)} />
              </div>
              <div className="field">
                <label>Buy Price</label>
                <input type="number" step="0.01" placeholder="0.00" value={form.buyPrice} onChange={(e) => setField("buyPrice", e.target.value)} />
              </div>
              <div className="field">
                <label>Shares</label>
                <input type="number" step="0.0001" placeholder="0" value={form.shares} onChange={(e) => setField("shares", e.target.value)} />
              </div>
              <div className="field">
                <label>Sell Date</label>
                <input type="date" min={form.buyDate || undefined} value={form.sellDate} onChange={(e) => setField("sellDate", e.target.value)} />
              </div>
              <div className="field">
                <label>Sell Price</label>
                <input type="number" step="0.01" placeholder="0.00" value={form.sellPrice} onChange={(e) => setField("sellPrice", e.target.value)} />
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={closeModal}>Cancel</button>
              <button className="btn" onClick={saveRow}>{editingId !== null ? "Update" : "Save"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ================================================================
   OVERVIEW TAB
   ================================================================ */
function Overview({ trades, tf, setTf }) {
  const closed = trades.filter((t) => tfFilter(t, tf));
  const plDollars = closed.map(plDollar);
  const plPcts = closed.map(plPercent);
  const totalPL = plDollars.reduce((a, b) => a + b, 0);
  const wins = plDollars.filter((v) => v >= 0).length;
  const winRate = closed.length ? (wins / closed.length) * 100 : 0;
  const avgPct = plPcts.length ? plPcts.reduce((a, b) => a + b, 0) / plPcts.length : 0;

  let best = null;
  let worst = null;
  if (closed.length) {
    best = closed.reduce((a, b) => (plPercent(b) > plPercent(a) ? b : a));
    worst = closed.reduce((a, b) => (plPercent(b) < plPercent(a) ? b : a));
  }

  const tfs = [["week", "This Week"], ["month", "This Month"], ["year", "This Year"], ["all", "All Time"]];

  return (
    <div className="view active">
      <div className="timeframe-select">
        {tfs.map(([id, label]) => (
          <div key={id} className={"tf-btn" + (tf === id ? " active" : "")} onClick={() => setTf(id)}>
            {label}
          </div>
        ))}
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Closed Trades</div>
          <div className="stat-value">{closed.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Win Rate</div>
          <div className="stat-value">{winRate.toFixed(0)}%</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total P/L</div>
          <div className={"stat-value " + (totalPL >= 0 ? "pos" : "neg")}>{fmtMoney(totalPL)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Avg P/L %</div>
          <div className={"stat-value " + (avgPct >= 0 ? "pos" : "neg")}>{fmtPct(avgPct)}</div>
        </div>
      </div>

      <div className="best-worst">
        <div className="bw-card best">
          <div className="bw-title">Best Trade</div>
          <div className="bw-ticker">{best ? best.ticker : "—"}</div>
          <div className="bw-pct val-pos">{best ? fmtPct(plPercent(best)) : "No closed trades"}</div>
        </div>
        <div className="bw-card worst">
          <div className="bw-title">Worst Trade</div>
          <div className="bw-ticker">{worst ? worst.ticker : "—"}</div>
          <div className="bw-pct val-neg">{worst ? fmtPct(plPercent(worst)) : "No closed trades"}</div>
        </div>
      </div>
    </div>
  );
}

/* ================================================================
   PERFORMANCE TAB (Chart.js)
   ================================================================ */
function Performance({ trades }) {
  const equityRef = useRef(null);
  const tradeRef = useRef(null);
  const winLossRef = useRef(null);

  useEffect(() => {
    const closed = trades
      .filter((t) => t.sellDate)
      .sort((a, b) => new Date(a.sellDate) - new Date(b.sellDate));
    const labels = closed.map((t) => t.sellDate);
    let running = 0;
    const equity = closed.map((t) => (running += plDollar(t)));
    const tradePL = closed.map((t) => plDollar(t));
    const tickers = closed.map((t) => t.ticker);
    const wins = closed.filter((t) => plDollar(t) >= 0).length;
    const losses = closed.length - wins;

    const gridColor = "#232936";
    const textColor = "#8891A0";
    Chart.defaults.font.family = "'JetBrains Mono', monospace";
    Chart.defaults.font.size = 11;

    const charts = [
      new Chart(equityRef.current, {
        type: "line",
        data: {
          labels,
          datasets: [{
            data: equity, borderColor: "#D4A24C", backgroundColor: "rgba(212,162,76,0.08)",
            fill: true, tension: 0.25, pointRadius: 3, pointBackgroundColor: "#D4A24C",
          }],
        },
        options: {
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { color: gridColor }, ticks: { color: textColor } },
            y: { grid: { color: gridColor }, ticks: { color: textColor, callback: (v) => "$" + v } },
          },
        },
      }),
      new Chart(tradeRef.current, {
        type: "bar",
        data: {
          labels: tickers,
          datasets: [{
            data: tradePL,
            backgroundColor: tradePL.map((v) => (v >= 0 ? "rgba(52,211,153,0.75)" : "rgba(248,113,113,0.75)")),
          }],
        },
        options: {
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false }, ticks: { color: textColor } },
            y: { grid: { color: gridColor }, ticks: { color: textColor, callback: (v) => "$" + v } },
          },
        },
      }),
      new Chart(winLossRef.current, {
        type: "doughnut",
        data: {
          labels: ["Wins", "Losses"],
          datasets: [{ data: [wins, losses], backgroundColor: ["#34D399", "#F87171"], borderColor: "#171C25", borderWidth: 3 }],
        },
        options: { plugins: { legend: { position: "bottom", labels: { color: textColor } } } },
      }),
    ];

    return () => charts.forEach((c) => c.destroy());
  }, [trades]);

  return (
    <div className="view active">
      <div className="chart-box">
        <div className="chart-title">Cumulative P/L ($)</div>
        <canvas ref={equityRef} height="90"></canvas>
      </div>
      <div className="chart-row">
        <div className="chart-box">
          <div className="chart-title">P/L per Trade</div>
          <canvas ref={tradeRef} height="140"></canvas>
        </div>
        <div className="chart-box">
          <div className="chart-title">Win / Loss Split</div>
          <canvas ref={winLossRef} height="140"></canvas>
        </div>
      </div>
    </div>
  );
}
