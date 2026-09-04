/* Ledger shared data layer.
   Loaded by index.html, transactions.html, reports.html and settings.html
   so all four pages read and write the same portfolio data in
   localStorage, and stay in sync with each other. */
(function (global) {
  "use strict";

  const KEYS = {
    holdings: "ledger-holdings",
    transactions: "ledger-transactions",
    settings: "ledger-settings",
    priceMeta: "ledger-price-meta"
  };

  const DEFAULT_HOLDINGS = [];

  const DEFAULT_TRANSACTIONS = [];

  const DEFAULT_SETTINGS = {
    portfolioName: "My portfolio",
    currency: "GBP",
    costBasis: "average",
    decimals: true,
    closedPositions: false,
    reportPeriod: "ytd"
  };

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return clone(fallback);
      const parsed = JSON.parse(raw);
      return parsed == null ? clone(fallback) : parsed;
    } catch (e) {
      return clone(fallback);
    }
  }

  function write(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
    // Notify listeners in THIS tab (the native "storage" event only fires
    // in other tabs), so every open Ledger page can react immediately.
    global.dispatchEvent(new CustomEvent("ledger:change", { detail: { key: key } }));
  }

  function normSymbol(symbol) {
    return String(symbol || "").trim().toUpperCase();
  }

  const Ledger = {
    KEYS: KEYS,

    getHoldings() { return read(KEYS.holdings, DEFAULT_HOLDINGS); },
    saveHoldings(holdings) { write(KEYS.holdings, holdings); },

    getTransactions() { return read(KEYS.transactions, DEFAULT_TRANSACTIONS); },
    saveTransactions(transactions) { write(KEYS.transactions, transactions); },

    getSettings() { return Object.assign({}, DEFAULT_SETTINGS, read(KEYS.settings, {})); },
    saveSettings(settings) { write(KEYS.settings, settings); },

    getPriceMeta() { return read(KEYS.priceMeta, { lastRefreshed: null }); },
    savePriceMeta(meta) { write(KEYS.priceMeta, meta); },

    /**
     * Add a holding from the Portfolio page (index.html). Merges into an
     * existing position when the symbol already exists, otherwise creates
     * a new one — and logs a matching Buy transaction so the Transactions
     * and Reports pages immediately reflect it.
     */
    addHolding(entry) {
      const symbol = normSymbol(entry.symbol);
      const qty = Number(entry.qty);
      const price = Number(entry.price);
      const holdings = this.getHoldings();
      const existing = holdings.find(h => normSymbol(h.symbol) === symbol);
      if (existing) {
        existing.qty = Number(existing.qty) + qty;
        existing.price = price;
        existing.name = entry.name || existing.name;
        existing.type = entry.type || existing.type;
      } else {
        holdings.push({ name: entry.name, symbol: symbol, type: entry.type, qty: qty, price: price });
      }
      this.saveHoldings(holdings);

      const transactions = this.getTransactions();
      transactions.push({
        id: Date.now(),
        date: entry.date || new Date().toISOString().slice(0, 10),
        name: entry.name,
        symbol: symbol,
        type: entry.type,
        action: "Buy",
        qty: qty,
        price: price
      });
      this.saveTransactions(transactions);

      return holdings;
    },

    /**
     * Record a Buy/Sell from the Transactions page and keep the Portfolio
     * holdings (index.html) in sync: a Buy adds to (or creates) a
     * position, a Sell reduces it and removes it once fully sold.
     */
    recordTransaction(entry) {
      const symbol = normSymbol(entry.symbol);
      const qty = Number(entry.qty);
      const price = Number(entry.price);
      const transactions = this.getTransactions();
      const tx = {
        id: Date.now(),
        date: entry.date,
        name: entry.name,
        symbol: symbol,
        type: entry.type,
        action: entry.action,
        qty: qty,
        price: price
      };
      transactions.push(tx);
      this.saveTransactions(transactions);

      const holdings = this.getHoldings();
      const existing = holdings.find(h => normSymbol(h.symbol) === symbol);
      if (tx.action === "Buy") {
        if (existing) {
          existing.qty = Number(existing.qty) + qty;
          existing.price = price;
          existing.name = entry.name || existing.name;
          existing.type = entry.type || existing.type;
        } else {
          holdings.push({ name: entry.name, symbol: symbol, type: entry.type, qty: qty, price: price });
        }
      } else if (tx.action === "Sell" && existing) {
        existing.qty = Math.max(0, Number(existing.qty) - qty);
        if (existing.qty === 0) holdings.splice(holdings.indexOf(existing), 1);
      }
      this.saveHoldings(holdings);

      return tx;
    },

    removeTransaction(id) {
      const transactions = this.getTransactions().filter(t => String(t.id) !== String(id));
      this.saveTransactions(transactions);
      return transactions;
    },

    /**
     * Remove a holding from the Portfolio page (matched by symbol). The
     * transaction history is left untouched — it's a record of what
     * happened, not a live mirror of current holdings.
     */
    removeHolding(symbol) {
      const target = normSymbol(symbol);
      const holdings = this.getHoldings().filter(h => normSymbol(h.symbol) !== target);
      this.saveHoldings(holdings);
      return holdings;
    },

    /**
     * Attempt a real quote from Yahoo Finance's unofficial chart endpoint.
     * NOTE: Yahoo has no official public API and does not send CORS
     * headers permitting arbitrary browser pages to call it — so this
     * will very likely be blocked by the browser. It's still attempted
     * (in case it works in your setup), but refreshPrices() always falls
     * back to a simulated update per-holding when it fails, rather than
     * leaving stale data or crashing.
     */
    async fetchYahooPrice(symbol) {
      const url = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(symbol);
      const res = await fetch(url, { mode: "cors" });
      if (!res.ok) throw new Error("Yahoo returned HTTP " + res.status);
      const data = await res.json();
      const result = data && data.chart && data.chart.result && data.chart.result[0];
      const price = result && result.meta && result.meta.regularMarketPrice;
      if (typeof price !== "number") throw new Error("No price in Yahoo response");
      return price;
    },

    /**
     * Refresh every holding's unit price. Tries a live Yahoo Finance quote
     * for each symbol first; where that fails (CORS block, unknown/ISIN
     * symbol, network error, etc.) it falls back to a simulated update
     * for that holding only. Returns a summary so the UI can tell you
     * plainly how many were live vs. simulated, rather than presenting
     * simulated numbers as if they were real quotes.
     */
    async refreshPrices(spread) {
      spread = spread == null ? 0.03 : spread;
      const holdings = this.getHoldings();
      if (!holdings.length) return { holdings, liveCount: 0, simulatedCount: 0, failedSymbols: [] };
      let liveCount = 0, simulatedCount = 0;
      const failedSymbols = [];
      for (const h of holdings) {
        try {
          const price = await this.fetchYahooPrice(h.symbol);
          h.price = Math.round(price * 10000) / 10000;
          liveCount++;
        } catch (err) {
          // Log-space (geometric) random walk — see comment history:
          // this stays neutral over many refreshes instead of drifting.
          const change = (Math.random() * 2 - 1) * spread;
          const next = Number(h.price) * Math.exp(change);
          h.price = Math.max(0.01, Math.round(next * 10000) / 10000);
          simulatedCount++;
          failedSymbols.push(h.symbol);
        }
      }
      this.saveHoldings(holdings);
      this.savePriceMeta({
        lastRefreshed: new Date().toISOString(),
        liveCount: liveCount,
        simulatedCount: simulatedCount
      });
      return { holdings, liveCount, simulatedCount, failedSymbols };
    },

    /** True once at least `minIntervalMs` has passed since the last refresh. */
    dueForAutoRefresh(minIntervalMs) {
      const meta = this.getPriceMeta();
      if (!meta.lastRefreshed) return true;
      return Date.now() - new Date(meta.lastRefreshed).getTime() >= minIntervalMs;
    },

    clearAll() {
      Object.keys(KEYS).forEach(k => localStorage.removeItem(KEYS[k]));
      global.dispatchEvent(new CustomEvent("ledger:change", { detail: { key: "all" } }));
    },

    /** Run `handler` whenever Ledger data changes — in this tab or another. */
    onChange(handler) {
      global.addEventListener("ledger:change", handler);
      global.addEventListener("storage", e => {
        if (Object.values(KEYS).indexOf(e.key) !== -1) handler(e);
      });
    }
  };

  global.Ledger = Ledger;
})(window);
