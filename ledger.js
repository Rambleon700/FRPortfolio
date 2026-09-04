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

  const DEFAULT_HOLDINGS = [
    { name: "Apple Inc.", symbol: "AAPL", type: "Share", qty: 28, price: 196 },
    { name: "Unilever PLC", symbol: "ULVR", type: "Share", qty: 95, price: 49.43 },
    { name: "Vanguard FTSE All-World", symbol: "VWRL", type: "ETF", qty: 80, price: 110.5 },
    { name: "iShares Core Global Aggregate", symbol: "AGGG", type: "ETF", qty: 100, price: 50 },
    { name: "UK Treasury 4.25% 2032", symbol: "GB00B3KJDS62", type: "Bond", qty: 55, price: 100 }
  ];

  const DEFAULT_TRANSACTIONS = [
    { id: 1, date: "2025-01-16", name: "Apple Inc.", symbol: "AAPL", type: "Share", action: "Buy", qty: 28, price: 184.20 },
    { id: 2, date: "2025-02-04", name: "Vanguard FTSE All-World", symbol: "VWRL", type: "ETF", action: "Buy", qty: 80, price: 106.75 },
    { id: 3, date: "2025-03-21", name: "UK Treasury 4.25% 2032", symbol: "GB00B3KJDS62", type: "Bond", action: "Buy", qty: 55, price: 98.60 },
    { id: 4, date: "2025-05-09", name: "Unilever PLC", symbol: "ULVR", type: "Share", action: "Buy", qty: 110, price: 47.18 },
    { id: 5, date: "2025-07-14", name: "Unilever PLC", symbol: "ULVR", type: "Share", action: "Sell", qty: 15, price: 50.02 },
    { id: 6, date: "2025-08-11", name: "iShares Core Global Aggregate", symbol: "AGGG", type: "ETF", action: "Buy", qty: 100, price: 49.35 }
  ];

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
     * Simulate refreshed market prices: nudges every holding's unit price
     * by a small random amount (as if freshly quoted) and records when
     * the refresh happened, so any page can show "prices last updated".
     */
    refreshPrices(spread) {
      spread = spread == null ? 0.03 : spread;
      const holdings = this.getHoldings();
      holdings.forEach(h => {
        const change = (Math.random() * 2 - 1) * spread;
        const next = Number(h.price) * (1 + change);
        h.price = Math.max(0.01, Math.round(next * 10000) / 10000);
      });
      this.saveHoldings(holdings);
      this.savePriceMeta({ lastRefreshed: new Date().toISOString() });
      return holdings;
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
