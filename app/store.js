/* ==========================================================================
   DHR Inventory MVP - in-browser data layer
   Plain browser script: attaches window.Store. No modules, no dependencies.
   Persistence: localStorage key 'dhr-mvp-v1'. Every mutation persists
   immediately, then calls all subscribers.
   ========================================================================== */
(function () {
  'use strict';

  var STORAGE_KEY = 'dhr-mvp-v1';

  /* ---------------------------------------------------------------- static */

  var LOCATIONS = [
    { id: 'corp', name: 'Corporate Office', entity: 'Corporate' },
    { id: 'shop1', name: 'Cigar Shop One', entity: 'Corporate' },
    { id: 'shop2', name: 'Cigar Shop Two', entity: 'Corporate' },
    { id: 'davidoff', name: 'Davidoff Hard Rock', entity: 'Davidoff' }
  ];

  var USERS = [
    { id: 'sara', name: 'Sara D.', role: 'admin', entity: '*', locationId: null },
    { id: 'corp-mgr', name: 'Corporate Manager', role: 'manager', entity: 'Corporate', locationId: 'corp' },
    { id: 'shop-clerk', name: 'Shop Clerk', role: 'staff', entity: 'Corporate', locationId: 'shop1' },
    { id: 'dhr-lead', name: 'Davidoff Floor Lead', role: 'manager', entity: 'Davidoff', locationId: 'davidoff' }
  ];

  /* --------------------------------------------------------------- runtime */

  var state = null;          // { currentUserId, products, stock, ledger, offline, queue, internalSeq }
  var subscribers = [];
  var ledgerCounter = 0;

  function round2(n) {
    n = Number(n);
    if (!isFinite(n)) n = 0;
    return Math.round(n * 100) / 100;
  }

  function nextLedgerId() {
    ledgerCounter += 1;
    return 'L-' + Date.now() + '-' + ledgerCounter;
  }

  function pad4(n) {
    var s = String(n);
    while (s.length < 4) s = '0' + s;
    return s;
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) { /* storage full / unavailable: keep running in memory */ }
  }

  function notify() {
    var fns = subscribers.slice();
    for (var i = 0; i < fns.length; i++) {
      try { fns[i](); } catch (e) { /* a broken subscriber never breaks the store */ }
    }
  }

  function commit() {
    save();
    notify();
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.products) || !Array.isArray(parsed.ledger)) return null;
      if (!parsed.stock || typeof parsed.stock !== 'object') parsed.stock = {};
      if (!Array.isArray(parsed.queue)) parsed.queue = [];
      if (typeof parsed.internalSeq !== 'number') parsed.internalSeq = 2;
      if (typeof parsed.offline !== 'boolean') parsed.offline = false;
      if (typeof parsed.currentUserId !== 'string') parsed.currentUserId = 'sara';
      return parsed;
    } catch (e) {
      return null;
    }
  }

  function ensureInit() {
    if (!state) init();
  }

  function getProduct(sku) {
    if (sku === null || sku === undefined) return null;
    var key = String(sku);
    for (var i = 0; i < state.products.length; i++) {
      if (state.products[i].sku === key) return state.products[i];
    }
    // lenient fallback: trimmed, case-insensitive
    var norm = key.trim().toLowerCase();
    for (var j = 0; j < state.products.length; j++) {
      if (state.products[j].sku.toLowerCase() === norm) return state.products[j];
    }
    return null;
  }

  function locById(id) {
    for (var i = 0; i < LOCATIONS.length; i++) {
      if (LOCATIONS[i].id === id) return LOCATIONS[i];
    }
    return null;
  }

  function stockMap(locationId) {
    if (!state.stock[locationId]) state.stock[locationId] = {};
    return state.stock[locationId];
  }

  function getQty(locationId, sku) {
    var m = state.stock[locationId];
    if (!m) return 0;
    var q = Number(m[sku]);
    return isFinite(q) ? q : 0;
  }

  function setQty(locationId, sku, qty) {
    var m = stockMap(locationId);
    qty = round2(qty);
    if (qty > 0) m[sku] = qty;
    else delete m[sku];
  }

  function pushLedger(entry) {
    state.ledger.push(entry);
    return entry;
  }

  function makeEntry(type, fields) {
    var e = {
      id: nextLedgerId(),
      ts: Date.now(),
      type: type,
      sku: null,
      qty: null,
      from: null,
      to: null,
      author: null,
      note: null
    };
    for (var k in fields) {
      if (Object.prototype.hasOwnProperty.call(fields, k)) e[k] = fields[k];
    }
    return e;
  }

  /* -------------------------------------------------- committed operations */

  // Returns the ledger entry, or null if the product does not exist / bad qty.
  // Throws Error('Insufficient stock') is NOT possible here (receive only adds).
  function commitReceive(locationId, sku, qty, author) {
    var p = getProduct(sku);
    qty = Number(qty);
    if (!p || !isFinite(qty) || qty <= 0 || !locById(locationId)) return null;
    setQty(locationId, p.sku, getQty(locationId, p.sku) + qty);
    return pushLedger(makeEntry('receive', {
      sku: p.sku, qty: round2(qty), from: null, to: locationId, author: author || null
    }));
  }

  // Returns the ledger entry, null on missing product / bad args,
  // throws Error('Insufficient stock') when qty exceeds on-hand at fromId.
  function commitTransfer(fromId, toId, sku, qty, author) {
    var p = getProduct(sku);
    qty = Number(qty);
    if (!p || !isFinite(qty) || qty <= 0 || !locById(fromId) || !locById(toId)) return null;
    var onHand = getQty(fromId, p.sku);
    if (qty > onHand) throw new Error('Insufficient stock');
    setQty(fromId, p.sku, onHand - qty);
    setQty(toId, p.sku, getQty(toId, p.sku) + qty);
    return pushLedger(makeEntry('transfer', {
      sku: p.sku, qty: round2(qty), from: fromId, to: toId, author: author || null
    }));
  }

  /* ------------------------------------------------------------------ seed */

  function seed() {
    var now = Date.now();
    function d(days) { return now - Math.round(days * 86400000); }

    function product(sku, barcode, isInternal, name, category, supplier, buyUnit, sellUnit, unitsPerBuy, buyCost, history) {
      var hist = history || [{ ts: d(21), author: 'sara', buyCost: round2(buyCost) }];
      return {
        sku: sku,
        name: name,
        barcode: barcode,
        isInternal: !!isInternal,
        category: category,
        supplier: supplier,
        buyUnit: buyUnit,
        sellUnit: sellUnit,
        unitsPerBuy: unitsPerBuy,
        buyCost: round2(buyCost),
        sellCost: round2(buyCost / unitsPerBuy),
        costHistory: hist,
        createdTs: d(21)
      };
    }

    var DAV = 'Davidoff of Geneva USA';
    var products = [
      // -- Cigars: buyUnit box, sellUnit stick ---------------------------------
      product('7623500010012', '7623500010012', false, 'Davidoff Signature 2000', 'Cigars', DAV, 'box', 'stick', 25, 412.50, [
        { ts: d(20), author: 'sara', buyCost: 388.75 },
        { ts: d(10), author: 'sara', buyCost: 399.50 },
        { ts: d(3), author: 'sara', buyCost: 412.50 }
      ]),
      product('7623500010029', '7623500010029', false, 'Davidoff Winston Churchill The Statesman', 'Cigars', DAV, 'box', 'stick', 20, 486.00),
      product('7623500010036', '7623500010036', false, 'Davidoff Aniversario No. 3', 'Cigars', DAV, 'box', 'stick', 25, 637.50),
      product('7623500010043', '7623500010043', false, 'Davidoff Grand Cru No. 2', 'Cigars', DAV, 'box', 'stick', 25, 475.00),
      product('7623500010050', '7623500010050', false, 'Davidoff Nicaragua Toro', 'Cigars', DAV, 'box', 'stick', 20, 398.00),
      product('7623500010067', '7623500010067', false, 'Davidoff Millennium Piramides', 'Cigars', DAV, 'box', 'stick', 25, 612.50),
      product('7623500010074', '7623500010074', false, 'Winston Churchill Late Hour Churchill', 'Cigars', DAV, 'box', 'stick', 20, 432.00),
      product('840412100017', '840412100017', false, 'Avo Classic No. 2', 'Cigars', DAV, 'box', 'stick', 25, 262.50),
      product('840412100024', '840412100024', false, 'Avo Syncro Nicaragua Toro', 'Cigars', DAV, 'box', 'stick', 20, 238.00),
      product('840412100031', '840412100031', false, 'Avo XO Intermezzo', 'Cigars', DAV, 'box', 'stick', 25, 287.50),
      product('7443642200018', '7443642200018', false, 'Camacho Corojo Robusto', 'Cigars', 'Camacho (Oettinger Davidoff)', 'box', 'stick', 20, 196.00, [
        { ts: d(19), author: 'sara', buyCost: 188.00 },
        { ts: d(17), author: 'sara', buyCost: 196.00 }
      ]),
      product('7443642200025', '7443642200025', false, 'Camacho Triple Maduro Gordo', 'Cigars', 'Camacho (Oettinger Davidoff)', 'box', 'stick', 20, 258.00),
      product('7443642200032', '7443642200032', false, 'Camacho Connecticut Toro', 'Cigars', 'Camacho (Oettinger Davidoff)', 'box', 'stick', 20, 184.00),
      product('7623500020011', '7623500020011', false, 'Zino Platinum Crown Rocket', 'Cigars', DAV, 'box', 'stick', 20, 340.00),
      product('7623500020028', '7623500020028', false, 'Zino Nicaragua Half Corona', 'Cigars', DAV, 'box', 'stick', 25, 187.50),
      // -- Internal (no barcode) ----------------------------------------------
      product('DHR-0001', null, true, 'House Blend Toro (loose)', 'Cigars', 'House', 'bundle', 'stick', 20, 120.00),
      product('DHR-0002', null, true, 'Vintage Single (humidor cellar)', 'Cigars', 'Humidor Cellar', 'stick', 'stick', 1, 45.00),
      // -- Accessories: unit/unit ---------------------------------------------
      product('7623500030010', '7623500030010', false, 'Davidoff Double Blade Cutter', 'Accessories', DAV, 'unit', 'unit', 1, 95.00),
      product('812066020015', '812066020015', false, 'Xikar Xi2 Cutter', 'Accessories', 'Quality Importers', 'unit', 'unit', 1, 54.99),
      product('812066020022', '812066020022', false, 'Colibri Falcon Single-Jet Lighter', 'Accessories', 'Colibri Group', 'unit', 'unit', 1, 32.50),
      product('3597390110015', '3597390110015', false, 'S.T. Dupont Slim 7 Lighter', 'Accessories', 'S.T. Dupont', 'unit', 'unit', 1, 120.00),
      product('7623500030027', '7623500030027', false, 'Davidoff Porcelain Ashtray', 'Accessories', DAV, 'unit', 'unit', 1, 85.00),
      product('852113005011', '852113005011', false, 'Boveda 69% Humidification Pack 60g', 'Humidification', 'Boveda Inc.', 'unit', 'unit', 1, 5.75, [
        { ts: d(19), author: 'sara', buyCost: 5.25 },
        { ts: d(11), author: 'sara', buyCost: 5.75 }
      ]),
      product('852113005028', '852113005028', false, 'Spanish Cedar Sheets (10 pack)', 'Humidification', 'Quality Importers', 'unit', 'unit', 1, 9.50)
    ];

    var stock = {
      corp: {
        '7623500010012': 150, '7623500010029': 80, '7623500010036': 75, '7623500010043': 100,
        '7623500010050': 120, '7623500010067': 50, '7623500010074': 60,
        '840412100017': 125, '840412100024': 80, '840412100031': 75,
        '7443642200018': 100, '7443642200025': 60, '7443642200032': 80,
        '7623500020011': 40, '7623500020028': 100,
        '7623500030010': 12, '812066020015': 24, '812066020022': 30, '3597390110015': 8,
        '7623500030027': 10, '852113005011': 200, '852113005028': 40
      },
      shop1: {
        '7623500010012': 40, '7623500010029': 20, '7623500010050': 30,
        '840412100017': 45, '7443642200018': 30, '7623500020028': 25,
        '812066020015': 6, '812066020022': 8, '852113005011': 40, '852113005028': 10
      },
      shop2: {
        '7623500010012': 35, '7623500010036': 15, '840412100024': 25, '840412100031': 20,
        '7443642200032': 25, '7443642200025': 15,
        '812066020022': 6, '7623500030027': 3, '852113005011': 35
      },
      davidoff: {
        '7623500010012': 60, '7623500010029': 40, '7623500010036': 30, '7623500010043': 35,
        '7623500010067': 25, '7623500010074': 30, '7623500020011': 20,
        'DHR-0001': 55, 'DHR-0002': 12,
        '7623500030010': 6, '3597390110015': 4, '7623500030027': 5, '852113005011': 60
      }
    };

    // ~31 ledger entries over the past 3 weeks, oldest first.
    function seedEntry(days, type, fields) {
      var e = makeEntry(type, fields);
      e.ts = d(days);
      return e;
    }

    var ledger = [
      seedEntry(20, 'receive', { sku: '7623500010012', qty: 100, to: 'corp', author: 'corp-mgr' }),
      seedEntry(20, 'receive', { sku: '840412100017', qty: 125, to: 'corp', author: 'corp-mgr' }),
      seedEntry(19, 'receive', { sku: '7443642200018', qty: 100, to: 'corp', author: 'corp-mgr' }),
      seedEntry(19, 'receive', { sku: '852113005011', qty: 250, to: 'corp', author: 'corp-mgr' }),
      seedEntry(18, 'receive', { sku: '7623500010012', qty: 50, to: 'davidoff', author: 'dhr-lead' }),
      seedEntry(18, 'receive', { sku: 'DHR-0001', qty: 60, to: 'davidoff', author: 'dhr-lead' }),
      seedEntry(17, 'cost-change', { sku: '7443642200018', author: 'sara', note: '188 -> 196' }),
      seedEntry(16, 'transfer', { sku: '7623500010012', qty: 40, from: 'corp', to: 'shop1', author: 'corp-mgr' }),
      seedEntry(16, 'transfer', { sku: '840412100017', qty: 45, from: 'corp', to: 'shop1', author: 'corp-mgr' }),
      seedEntry(15, 'transfer', { sku: '840412100024', qty: 25, from: 'corp', to: 'shop2', author: 'corp-mgr' }),
      seedEntry(14, 'receive', { sku: '7623500010050', qty: 120, to: 'corp', author: 'corp-mgr' }),
      seedEntry(14, 'receive', { sku: '7623500020028', qty: 100, to: 'corp', author: 'corp-mgr' }),
      seedEntry(13, 'transfer', { sku: '7443642200018', qty: 30, from: 'corp', to: 'shop1', author: 'corp-mgr' }),
      seedEntry(13, 'transfer', { sku: '7443642200032', qty: 25, from: 'corp', to: 'shop2', author: 'corp-mgr' }),
      seedEntry(12, 'receive', { sku: '7623500010029', qty: 40, to: 'davidoff', author: 'dhr-lead' }),
      seedEntry(12, 'receive', { sku: '852113005011', qty: 60, to: 'davidoff', author: 'dhr-lead' }),
      seedEntry(11, 'cost-change', { sku: '852113005011', author: 'sara', note: '5.25 -> 5.75' }),
      seedEntry(10, 'receive', { sku: '7623500010043', qty: 100, to: 'corp', author: 'corp-mgr' }),
      seedEntry(10, 'cost-change', { sku: '7623500010012', author: 'sara', note: '388.75 -> 399.5' }),
      seedEntry(9, 'transfer', { sku: '852113005011', qty: 40, from: 'corp', to: 'shop1', author: 'corp-mgr' }),
      seedEntry(9, 'transfer', { sku: '852113005011', qty: 35, from: 'corp', to: 'shop2', author: 'corp-mgr' }),
      seedEntry(8, 'receive', { sku: '7623500010036', qty: 30, to: 'davidoff', author: 'dhr-lead' }),
      seedEntry(8, 'receive', { sku: 'DHR-0002', qty: 12, to: 'davidoff', author: 'dhr-lead' }),
      seedEntry(7, 'transfer', { sku: '7623500020011', qty: 20, from: 'corp', to: 'davidoff', author: 'corp-mgr' }),
      seedEntry(6, 'receive', { sku: '7623500010067', qty: 50, to: 'corp', author: 'corp-mgr' }),
      seedEntry(5, 'transfer', { sku: '7623500020028', qty: 25, from: 'corp', to: 'shop1', author: 'corp-mgr' }),
      seedEntry(5, 'transfer', { sku: '840412100031', qty: 20, from: 'corp', to: 'shop2', author: 'corp-mgr' }),
      seedEntry(4, 'count-adjust', { sku: '852113005011', qty: -2, to: 'shop1', author: 'shop-clerk', note: 'count: expected 42, counted 40' }),
      seedEntry(3, 'cost-change', { sku: '7623500010012', author: 'sara', note: '399.5 -> 412.5' }),
      seedEntry(2, 'receive', { sku: '7623500010074', qty: 30, to: 'davidoff', author: 'dhr-lead' }),
      seedEntry(2, 'receive', { sku: '7623500010074', qty: 60, to: 'corp', author: 'corp-mgr' })
    ];

    return {
      currentUserId: 'sara',
      products: products,
      stock: stock,
      ledger: ledger,
      offline: false,
      queue: [],
      internalSeq: 2
    };
  }

  /* ------------------------------------------------------------- public API */

  var Store = {};

  Store.init = function () {
    if (state) return;
    var loaded = load();
    if (loaded) {
      state = loaded;
      ledgerCounter = state.ledger.length;
    } else {
      state = seed();
      ledgerCounter = state.ledger.length;
      save();
    }
  };

  Store.reset = function () {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* noop */ }
    state = seed();
    ledgerCounter = state.ledger.length;
    commit();
  };

  Store.locations = function () {
    return LOCATIONS.slice();
  };

  Store.users = function () {
    return USERS.slice();
  };

  Store.setUser = function (id) {
    ensureInit();
    for (var i = 0; i < USERS.length; i++) {
      if (USERS[i].id === id) {
        state.currentUserId = id;
        commit();
        return USERS[i];
      }
    }
    return null;
  };

  Store.getUser = function () {
    ensureInit();
    for (var i = 0; i < USERS.length; i++) {
      if (USERS[i].id === state.currentUserId) return USERS[i];
    }
    return USERS[0];
  };

  Store.canSeeCosts = function (locationId) {
    ensureInit();
    var user = Store.getUser();
    if (user.entity === '*') return true;
    var loc = locById(locationId);
    if (!loc) return false;
    return loc.entity === user.entity;
  };

  Store.visibleLocations = function () {
    ensureInit();
    var user = Store.getUser();
    if (user.entity === '*') return LOCATIONS.slice();
    var out = [];
    for (var i = 0; i < LOCATIONS.length; i++) {
      if (LOCATIONS[i].entity === user.entity) out.push(LOCATIONS[i]);
    }
    return out;
  };

  Store.products = function () {
    ensureInit();
    return state.products.slice();
  };

  Store.findByBarcode = function (code) {
    ensureInit();
    if (code === null || code === undefined) return null;
    var norm = String(code).trim().toLowerCase();
    if (!norm) return null;
    for (var i = 0; i < state.products.length; i++) {
      var p = state.products[i];
      if ((p.barcode && p.barcode.trim().toLowerCase() === norm) ||
          p.sku.trim().toLowerCase() === norm) {
        return p;
      }
    }
    return null;
  };

  Store.search = function (q) {
    ensureInit();
    var norm = (q === null || q === undefined) ? '' : String(q).trim().toLowerCase();
    if (!norm) return state.products.slice();
    var out = [];
    for (var i = 0; i < state.products.length; i++) {
      var p = state.products[i];
      var hay = [p.name, p.sku, p.barcode || '', p.category, p.supplier].join('\n').toLowerCase();
      if (hay.indexOf(norm) !== -1) out.push(p);
    }
    return out;
  };

  Store.addProduct = function (data, author) {
    ensureInit();
    data = data || {};
    var barcode = data.barcode ? String(data.barcode).trim() : '';
    var unitsPerBuy = Math.max(1, Math.floor(Number(data.unitsPerBuy)) || 1);
    var buyCost = round2(data.buyCost);
    var sku, isInternal;
    if (barcode) {
      sku = barcode;
      isInternal = false;
    } else {
      state.internalSeq += 1;
      sku = 'DHR-' + pad4(state.internalSeq);
      barcode = null;
      isInternal = true;
    }
    var now = Date.now();
    var product = {
      sku: sku,
      name: data.name ? String(data.name) : 'Untitled product',
      barcode: barcode || null,
      isInternal: isInternal,
      category: data.category ? String(data.category) : '',
      supplier: data.supplier ? String(data.supplier) : '',
      buyUnit: data.buyUnit ? String(data.buyUnit) : 'unit',
      sellUnit: data.sellUnit ? String(data.sellUnit) : 'unit',
      unitsPerBuy: unitsPerBuy,
      buyCost: buyCost,
      sellCost: round2(buyCost / unitsPerBuy),
      costHistory: [{ ts: now, author: author || null, buyCost: buyCost }],
      createdTs: now
    };
    state.products.push(product);
    pushLedger(makeEntry('new-product', {
      sku: product.sku, author: author || null, note: product.name
    }));
    commit();
    return product;
  };

  Store.updateCost = function (sku, newBuyCost, author) {
    ensureInit();
    var p = getProduct(sku);
    if (!p) return null;
    var oldCost = p.buyCost;
    var newCost = round2(newBuyCost);
    p.buyCost = newCost;
    p.sellCost = round2(newCost / p.unitsPerBuy);
    p.costHistory.push({ ts: Date.now(), author: author || null, buyCost: newCost });
    pushLedger(makeEntry('cost-change', {
      sku: p.sku, author: author || null, note: oldCost + ' -> ' + newCost
    }));
    commit();
    return p;
  };

  Store.stock = function (locationId) {
    ensureInit();
    var m = state.stock[locationId] || {};
    var out = [];
    for (var sku in m) {
      if (Object.prototype.hasOwnProperty.call(m, sku) && m[sku] > 0) {
        out.push({ sku: sku, qty: m[sku] });
      }
    }
    return out;
  };

  Store.qty = function (locationId, sku) {
    ensureInit();
    var p = getProduct(sku);
    return getQty(locationId, p ? p.sku : String(sku));
  };

  Store.receive = function (locationId, sku, qty, author) {
    ensureInit();
    if (state.offline) {
      var queued = {
        type: 'receive',
        locationId: locationId,
        sku: sku,
        qty: qty,
        author: author || null,
        ts: Date.now()
      };
      state.queue.push(queued);
      commit();
      return { queued: true, ts: queued.ts };
    }
    var entry = commitReceive(locationId, sku, qty, author);
    if (entry) commit();
    return entry;
  };

  Store.transfer = function (fromId, toId, sku, qty, author) {
    ensureInit();
    if (state.offline) {
      // Offline: skip the stock check until replay.
      var queued = {
        type: 'transfer',
        fromId: fromId,
        toId: toId,
        sku: sku,
        qty: qty,
        author: author || null,
        ts: Date.now()
      };
      state.queue.push(queued);
      commit();
      return { queued: true, ts: queued.ts };
    }
    var entry = commitTransfer(fromId, toId, sku, qty, author); // may throw Insufficient stock
    if (entry) commit();
    return entry;
  };

  Store.ledger = function (filters) {
    ensureInit();
    filters = filters || {};
    var out = state.ledger.slice();
    if (filters.locationId) {
      out = out.filter(function (e) {
        return e.from === filters.locationId || e.to === filters.locationId;
      });
    }
    if (filters.sku) {
      var skuNorm = String(filters.sku).trim().toLowerCase();
      out = out.filter(function (e) {
        return e.sku !== null && e.sku !== undefined && String(e.sku).toLowerCase() === skuNorm;
      });
    }
    // newest first; stable for equal timestamps (later insertion wins)
    out = out.map(function (e, i) { return { e: e, i: i }; })
      .sort(function (a, b) { return (b.e.ts - a.e.ts) || (b.i - a.i); })
      .map(function (w) { return w.e; });
    var limit = Number(filters.limit);
    if (isFinite(limit) && limit > 0) out = out.slice(0, Math.floor(limit));
    return out;
  };

  Store.countSheet = function (locationId) {
    ensureInit();
    var m = state.stock[locationId] || {};
    var out = [];
    for (var sku in m) {
      if (Object.prototype.hasOwnProperty.call(m, sku) && m[sku] > 0) {
        var p = getProduct(sku);
        out.push({ sku: sku, name: p ? p.name : sku, expected: m[sku] });
      }
    }
    out.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    return out;
  };

  Store.applyCount = function (locationId, counts, author) {
    ensureInit();
    var adjustments = [];
    if (!locById(locationId) || !Array.isArray(counts)) return { adjustments: adjustments };
    for (var i = 0; i < counts.length; i++) {
      var row = counts[i] || {};
      var p = getProduct(row.sku);
      if (!p) continue;
      var counted = Number(row.counted);
      if (!isFinite(counted) || counted < 0) counted = 0;
      counted = round2(counted);
      var expected = getQty(locationId, p.sku);
      var delta = round2(counted - expected);
      if (delta !== 0) {
        setQty(locationId, p.sku, counted);
        pushLedger(makeEntry('count-adjust', {
          sku: p.sku, qty: delta, to: locationId, author: author || null,
          note: 'count: expected ' + expected + ', counted ' + counted
        }));
        adjustments.push({ sku: p.sku, delta: delta });
      }
    }
    if (adjustments.length > 0) commit();
    return { adjustments: adjustments };
  };

  Store.valuation = function (locationId) {
    ensureInit();
    var locIds;
    if (locationId === null || locationId === undefined) {
      locIds = LOCATIONS.map(function (l) { return l.id; });
    } else {
      locIds = [locationId];
    }
    var bySku = {};
    for (var i = 0; i < locIds.length; i++) {
      var m = state.stock[locIds[i]] || {};
      for (var sku in m) {
        if (Object.prototype.hasOwnProperty.call(m, sku) && m[sku] > 0) {
          bySku[sku] = (bySku[sku] || 0) + m[sku];
        }
      }
    }
    var lines = [];
    var total = 0;
    for (var s in bySku) {
      if (!Object.prototype.hasOwnProperty.call(bySku, s)) continue;
      var p = getProduct(s);
      var sellCost = p ? p.sellCost : 0;
      var value = round2(bySku[s] * sellCost);
      total += value;
      lines.push({
        sku: s,
        name: p ? p.name : s,
        qty: bySku[s],
        sellCost: sellCost,
        value: value
      });
    }
    lines.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    return { lines: lines, total: round2(total) };
  };

  /* CSV helpers */

  function csvField(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function csvRows(rows) {
    return rows.map(function (r) { return r.map(csvField).join(','); }).join('\n');
  }

  Store.exportCSV = function (kind) {
    ensureInit();
    var rows, i;
    if (kind === 'catalog') {
      rows = [['sku', 'name', 'barcode', 'isInternal', 'category', 'supplier', 'buyUnit', 'sellUnit', 'unitsPerBuy', 'buyCost', 'sellCost']];
      for (i = 0; i < state.products.length; i++) {
        var p = state.products[i];
        rows.push([p.sku, p.name, p.barcode, p.isInternal, p.category, p.supplier, p.buyUnit, p.sellUnit, p.unitsPerBuy, p.buyCost.toFixed(2), p.sellCost.toFixed(2)]);
      }
      return csvRows(rows);
    }
    if (kind === 'ledger') {
      rows = [['id', 'ts', 'type', 'sku', 'qty', 'from', 'to', 'author', 'note']];
      var entries = Store.ledger();
      for (i = 0; i < entries.length; i++) {
        var e = entries[i];
        rows.push([e.id, new Date(e.ts).toISOString(), e.type, e.sku, e.qty, e.from, e.to, e.author, e.note]);
      }
      return csvRows(rows);
    }
    if (kind === 'stock') {
      rows = [['location', 'sku', 'name', 'qty', 'sellCost', 'value']];
      for (i = 0; i < LOCATIONS.length; i++) {
        var loc = LOCATIONS[i];
        var lines = Store.stock(loc.id);
        for (var j = 0; j < lines.length; j++) {
          var prod = getProduct(lines[j].sku);
          var sellCost = prod ? prod.sellCost : 0;
          rows.push([loc.name, lines[j].sku, prod ? prod.name : lines[j].sku, lines[j].qty, sellCost.toFixed(2), round2(lines[j].qty * sellCost).toFixed(2)]);
        }
      }
      return csvRows(rows);
    }
    if (kind === 'valuation') {
      rows = [['sku', 'name', 'qty', 'sellCost', 'value']];
      var val = Store.valuation(null);
      for (i = 0; i < val.lines.length; i++) {
        var line = val.lines[i];
        rows.push([line.sku, line.name, line.qty, line.sellCost.toFixed(2), line.value.toFixed(2)]);
      }
      rows.push(['TOTAL', '', '', '', val.total.toFixed(2)]);
      return csvRows(rows);
    }
    return '';
  };

  /* Offline mode + queue */

  Store.setOffline = function (flag) {
    ensureInit();
    flag = !!flag;
    if (flag) {
      state.offline = true;
      commit();
      return { applied: 0, failed: 0 };
    }
    state.offline = false;
    var pending = state.queue.slice();
    state.queue = [];
    var applied = 0;
    var failed = 0;
    var failures = [];
    for (var i = 0; i < pending.length; i++) {
      var item = pending[i];
      try {
        var entry = null;
        if (item.type === 'receive') {
          entry = commitReceive(item.locationId, item.sku, item.qty, item.author);
        } else if (item.type === 'transfer') {
          entry = commitTransfer(item.fromId, item.toId, item.sku, item.qty, item.author);
        }
        if (entry) applied += 1;
        else { failed += 1; failures.push({ item: item, error: 'Invalid item' }); }
      } catch (e) {
        failed += 1;
        failures.push({ item: item, error: e && e.message ? e.message : String(e) });
      }
    }
    commit();
    return { applied: applied, failed: failed, failures: failures };
  };

  Store.isOffline = function () {
    ensureInit();
    return !!state.offline;
  };

  Store.pendingQueue = function () {
    ensureInit();
    return state.queue.slice();
  };

  Store.subscribe = function (fn) {
    if (typeof fn !== 'function') return function () {};
    subscribers.push(fn);
    return function unsubscribe() {
      var idx = subscribers.indexOf(fn);
      if (idx !== -1) subscribers.splice(idx, 1);
    };
  };

  window.Store = Store;
})();
