/* ============================================================
   Davidoff Hard Rock · Inventory MVP · app.js
   Built by Arqentia. Vanilla JS front end over window.Store
   (store.js). No modules, no build step. anime.js (vendored)
   drives all motion, guarded by prefers-reduced-motion.
   ============================================================ */

(function () {
  'use strict';

  /* ----------------------------------------------------------
     UI state (everything not owned by the Store)
     ---------------------------------------------------------- */

  var ROUTES = [
    { id: 'dashboard', label: 'DASHBOARD' },
    { id: 'receive',   label: 'RECEIVE · SCAN' },
    { id: 'transfer',  label: 'TRANSFER' },
    { id: 'catalog',   label: 'CATALOG' },
    { id: 'counts',    label: 'COUNTS' },
    { id: 'ledger',    label: 'LEDGER' },
    { id: 'exports',   label: 'EXPORTS' },
    { id: 'labels',    label: 'LABELS' }
  ];

  var ui = {
    route: 'dashboard',
    storeReady: false,
    cameraFailed: false,
    receive: {
      loc: null,
      session: [],        // [{sku, qty}]
      lastScan: null,     // sku flashed on last scan
      formOpen: false,
      form: null,         // {name, category, supplier, barcode, buyUnit, sellUnit, unitsPerBuy, buyCost}
      unknownCode: null,
      assigned: null      // internal SKU just assigned
    },
    transfer: { from: null, to: null, q: '', sku: null, qty: 1 },
    catalog: {
      q: '', drawer: null, costEdit: '',
      cat: 'all', sup: 'all',
      sort: { key: '', dir: 1 },
      selected: {}, menu: null,
      formOpen: false, form: null
    },
    counts: { loc: null, values: {}, report: null },
    ledger: { loc: 'all', type: 'all' }
  };

  var focusMemo = null;
  var camera = { stream: null, timer: null };

  /* ----------------------------------------------------------
     Theme (light / dark)
     An explicit data-theme stamp on <html> always wins; without
     one, the OS preference decides. localStorage 'dhr-theme'
     remembers the last explicit in-app choice.
     ---------------------------------------------------------- */

  var THEME_KEY = 'dhr-theme';

  function currentTheme() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t === 'dark' || t === 'light') return t;
    try {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    } catch (e) { /* default light */ }
    return 'light';
  }

  function applyStoredTheme() {
    var saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* storage unavailable */ }
    if (saved === 'dark' || saved === 'light') {
      document.documentElement.setAttribute('data-theme', saved);
    }
    // else: leave unstamped, system / artifact viewer decides
  }

  function toggleTheme() {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* non-fatal */ }
    render();
  }

  function watchSystemTheme() {
    // only the toggle button label depends on the effective theme,
    // so re-render when the OS preference flips while unstamped
    try {
      var mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
      if (!mq) return;
      var onFlip = function () { if (ui.storeReady) render(); };
      if (mq.addEventListener) mq.addEventListener('change', onFlip);
      else if (mq.addListener) mq.addListener(onFlip);
    } catch (e) { /* cosmetic only */ }
    // an external stamp (e.g. the artifact viewer toggle) changes the
    // effective theme without going through toggleTheme: watch for it
    try {
      var mo = new MutationObserver(function () { if (ui.storeReady) render(); });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) { /* cosmetic only */ }
  }

  /* ----------------------------------------------------------
     Animation helpers (anime.js, vendored; every use is guarded
     and skipped when missing or when reduced motion is set)
     ---------------------------------------------------------- */

  var renderedRoute = null;                              // last route actually painted
  var fx = { scan: false, menu: false, drawer: false };  // one-shot animation flags

  function animeRef() {
    return window.anime || null;
  }

  function motionOK() {
    var az = animeRef();
    if (!az) return false;
    try {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    } catch (e) { /* treat as motion allowed */ }
    return true;
  }

  function animateScreenEnter() {
    if (!motionOK()) return;
    var az = animeRef();
    var view = $('#view');
    if (!view) return;
    var nodes = view.querySelectorAll('.screen-head, .tile, .panel, .table-wrap, .toolbar, .bulk-bar, .label');
    var els = [];
    for (var i = 0; i < nodes.length && els.length < 15; i++) els.push(nodes[i]);
    if (!els.length) return;
    az({
      targets: els,
      opacity: [0, 1],
      translateY: [12, 0],
      duration: 360,
      delay: az.stagger(28),
      easing: 'easeOutCubic'
    });
  }

  function animateNavInd() {
    if (!motionOK()) return;
    var el = document.querySelector('#nav .nav-ind');
    if (!el) return;
    animeRef()({
      targets: el,
      scaleY: [0.3, 1],
      opacity: [0, 1],
      duration: 260,
      easing: 'easeOutCubic'
    });
  }

  function animateDashTiles() {
    if (!motionOK()) return;
    var az = animeRef();
    var nodes = document.querySelectorAll('#view .tile-num[data-count]');
    Array.prototype.forEach.call(nodes, function (node) {
      var end = parseFloat(node.getAttribute('data-count'));
      if (isNaN(end)) return;
      var isMoney = node.getAttribute('data-money') === '1';
      var obj = { v: 0 };
      az({
        targets: obj,
        v: end,
        duration: 750,
        easing: 'easeOutCubic',
        update: function () {
          node.textContent = isMoney ? money(obj.v) : intFmt(Math.round(obj.v));
        },
        complete: function () {
          node.textContent = isMoney ? money(end) : intFmt(end);
        }
      });
    });
  }

  function animateScanLine() {
    if (!motionOK()) return;
    var el = document.querySelector('.session-line.just');
    if (!el) return;
    animeRef()({
      targets: el,
      translateX: [-14, 0],
      opacity: [0.4, 1],
      duration: 300,
      easing: 'easeOutCubic'
    });
  }

  function animateRowMenu() {
    if (!motionOK()) return;
    var el = document.querySelector('.row-menu-sheet');
    if (!el) return;
    animeRef()({
      targets: el,
      scale: [0.92, 1],
      opacity: [0, 1],
      duration: 150,
      easing: 'easeOutQuad'
    });
  }

  function animateKickerBars() {
    if (!motionOK()) return;
    var az = animeRef();
    var bars = document.querySelectorAll('#view .kicker-bar');
    if (!bars.length) return;
    az({
      targets: bars,
      scaleX: [0, 1],
      duration: 300,
      delay: az.stagger(80),
      easing: 'easeOutCubic'
    });
  }

  function animateDrawer() {
    if (!motionOK()) return;
    var el = document.querySelector('.drawer');
    if (!el) return;
    animeRef()({
      targets: el,
      translateX: ['100%', '0%'],
      duration: 320,
      easing: 'easeOutCubic'
    });
  }

  function runFx() {
    var changed = renderedRoute !== ui.route;
    renderedRoute = ui.route;
    if (changed) {
      animateScreenEnter();
      animateNavInd();
      animateKickerBars();
      if (ui.route === 'dashboard') animateDashTiles();
    }
    if (fx.scan) { fx.scan = false; animateScanLine(); }
    if (fx.menu) { fx.menu = false; animateRowMenu(); }
    if (fx.drawer) { fx.drawer = false; animateDrawer(); }
  }

  /* interaction-driven animations (hover, press), all delegated */

  function hoverEdge(ev, sel) {
    var el = ev.target && ev.target.closest ? ev.target.closest(sel) : null;
    if (!el) return null;
    // ignore moves between children of the same element
    if (ev.relatedTarget && el.contains(ev.relatedTarget)) return null;
    return el;
  }

  function onHoverIn(ev) {
    if (!motionOK()) return;
    var az = animeRef();
    var link = hoverEdge(ev, '#nav a');
    if (link) {
      var u = link.querySelector('.nav-u');
      if (u) {
        az.remove(u);
        az({ targets: u, scaleX: [0, 1], duration: 220, easing: 'easeOutCubic' });
      }
      return;
    }
    var tileEl = hoverEdge(ev, '.tile');
    if (tileEl) {
      tileEl.classList.add('is-hover');
      az.remove(tileEl);
      az({ targets: tileEl, translateY: -2, duration: 200, easing: 'easeOutCubic' });
    }
  }

  function onHoverOut(ev) {
    if (!motionOK()) return;
    var az = animeRef();
    var link = hoverEdge(ev, '#nav a');
    if (link) {
      var u = link.querySelector('.nav-u');
      if (u) {
        az.remove(u);
        az({ targets: u, scaleX: 0, duration: 180, easing: 'easeOutCubic' });
      }
      return;
    }
    var tileEl = hoverEdge(ev, '.tile');
    if (tileEl) {
      az.remove(tileEl);
      az({
        targets: tileEl, translateY: 0, duration: 200, easing: 'easeOutCubic',
        complete: function () { tileEl.classList.remove('is-hover'); }
      });
    }
  }

  function onPressDown(ev) {
    if (!motionOK()) return;
    var btn = ev.target && ev.target.closest ? ev.target.closest('.btn') : null;
    if (!btn) return;
    var az = animeRef();
    az.remove(btn);
    az({ targets: btn, scale: 0.985, duration: 120, easing: 'easeOutQuad' });
  }

  function onPressUp(ev) {
    if (!motionOK()) return;
    var btn = ev.target && ev.target.closest ? ev.target.closest('.btn') : null;
    if (!btn) return;
    var az = animeRef();
    az.remove(btn);
    az({ targets: btn, scale: 1, duration: 150, easing: 'easeOutQuad' });
  }

  /* ----------------------------------------------------------
     Small utilities
     ---------------------------------------------------------- */

  function $(sel) { return document.querySelector(sel); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function num(v, fallback) {
    var n = parseFloat(v);
    return isNaN(n) ? (fallback || 0) : n;
  }

  function money(n) {
    if (n == null || isNaN(n)) return '· · ·';
    return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function MASKED() {
    return '<span class="masked" title="Costs are restricted for your role">· · ·</span>';
  }

  function intFmt(n) {
    return Number(n || 0).toLocaleString('en-US');
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtTs(ts) {
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '· · ·';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function timeAgo(ts) {
    var s = Math.floor((Date.now() - ts) / 1000);
    if (isNaN(s)) return '';
    if (s < 50) return 'just now';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    var d = Math.floor(h / 24);
    if (d < 7) return d + 'd ago';
    return fmtTs(ts).slice(0, 10);
  }

  function author() {
    try {
      var u = Store.getUser();
      return u ? u.name : 'Demo user';
    } catch (e) { return 'Demo user'; }
  }

  function toast(msg, kind, kicker) {
    var host = $('#toasts');
    if (!host) return;
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.innerHTML = (kicker ? '<div class="kicker">' + esc(kicker) + '</div>' : '') + esc(msg);
    host.appendChild(el);
    if (motionOK()) {
      el.classList.add('anim'); // disables the CSS keyframe fallback
      animeRef()({
        targets: el,
        translateY: [14, 0],
        opacity: [0, 1],
        duration: 320,
        easing: 'easeOutCubic'
      });
    }
    setTimeout(function () {
      el.classList.add('leaving');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
    }, 3600);
    while (host.children.length > 4) host.removeChild(host.firstChild);
  }

  function countOf(x) {
    if (Array.isArray(x)) return x.length;
    if (typeof x === 'number') return x;
    return 0;
  }

  function downloadText(filename, text) {
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 800);
  }

  /* ----------------------------------------------------------
     Code 39 barcode as inline SVG (self-contained implementation)
     Narrow/wide patterns, 9 elements per char, bars at even index.
     ---------------------------------------------------------- */

  var C39 = {
    '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn',
    '4': 'nnnwwnnnw', '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw',
    '8': 'wnnwnnwnn', '9': 'nnwwnnwnn',
    'A': 'wnnnnwnnw', 'B': 'nnwnnwnnw', 'C': 'wnwnnwnnn', 'D': 'nnnnwwnnw',
    'E': 'wnnnwwnnn', 'F': 'nnwnwwnnn', 'G': 'nnnnnwwnw', 'H': 'wnnnnwwnn',
    'I': 'nnwnnwwnn', 'J': 'nnnnwwwnn', 'K': 'wnnnnnnww', 'L': 'nnwnnnnww',
    'M': 'wnwnnnnwn', 'N': 'nnnnwnnww', 'O': 'wnnnwnnwn', 'P': 'nnwnwnnwn',
    'Q': 'nnnnnnwww', 'R': 'wnnnnnwwn', 'S': 'nnwnnnwwn', 'T': 'nnnnwnwwn',
    'U': 'wwnnnnnnw', 'V': 'nwwnnnnnw', 'W': 'wwwnnnnnn', 'X': 'nwnnwnnnw',
    'Y': 'wwnnwnnnn', 'Z': 'nwwnwnnnn',
    '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn', '*': 'nwnnwnwnn'
  };

  function code39Svg(text, height) {
    height = height || 44;
    var clean = String(text || '').toUpperCase().replace(/[^0-9A-Z\-\. ]/g, '');
    var full = '*' + clean + '*';
    var narrow = 2, wide = 5, gap = narrow;
    var x = 0;
    var rects = [];
    for (var c = 0; c < full.length; c++) {
      var pat = C39[full.charAt(c)];
      if (!pat) continue;
      for (var i = 0; i < 9; i++) {
        var w = pat.charAt(i) === 'w' ? wide : narrow;
        if (i % 2 === 0) {
          rects.push('<rect x="' + x + '" y="0" width="' + w + '" height="' + height + '"></rect>');
        }
        x += w;
      }
      x += gap;
    }
    x -= gap;
    if (x <= 0) return '';
    return '<svg class="c39" viewBox="0 0 ' + x + ' ' + height + '" preserveAspectRatio="none" ' +
      'xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Code 39 barcode ' + esc(clean) + '">' +
      rects.join('') + '</svg>';
  }

  /* ----------------------------------------------------------
     Store helpers (all defensive)
     ---------------------------------------------------------- */

  function locName(id) {
    var l = Store.locations().filter(function (x) { return x.id === id; })[0];
    return l ? l.name : (id || '');
  }

  function productBySku(sku) {
    return Store.products().filter(function (p) { return p.sku === sku; })[0] || null;
  }

  function staffMasked() {
    var u = Store.getUser();
    return !u || u.role === 'staff';
  }

  function visibleLocs() {
    try {
      var v = Store.visibleLocations();
      return (v && v.length) ? v : Store.locations();
    } catch (e) { return Store.locations(); }
  }

  function unitsAt(locId) {
    var total = 0;
    (Store.stock(locId) || []).forEach(function (s) { total += (s.qty || 0); });
    return total;
  }

  function describeEntry(e) {
    var p = productBySku(e.sku);
    var name = p ? p.name : (e.sku || 'product');
    switch (e.type) {
      case 'receive':
        return intFmt(e.qty) + ' x ' + name + ' received at ' + locName(e.to || e.from);
      case 'transfer':
        return intFmt(e.qty) + ' x ' + name + ' moved, ' + locName(e.from) + ' to ' + locName(e.to);
      case 'cost-change':
        return 'Cost updated on ' + name + (e.note ? ' · ' + e.note : '');
      case 'new-product':
        return name + ' added to the catalog';
      case 'count-adjust':
        var sign = (e.qty > 0 ? '+' : '') + intFmt(e.qty);
        return 'Count adjustment on ' + name + ' at ' + locName(e.to || e.from) + ' · ' + sign;
      default:
        return (e.note || e.type || 'movement') + ' · ' + name;
    }
  }

  function entryVisible(e, visIds) {
    var involved = [e.from, e.to].filter(Boolean);
    if (!involved.length) return true; // catalog-level events
    return involved.some(function (id) { return visIds.indexOf(id) >= 0; });
  }

  /* ----------------------------------------------------------
     Boot
     ---------------------------------------------------------- */

  document.addEventListener('DOMContentLoaded', boot);

  function boot() {
    applyStoredTheme();
    watchSystemTheme();
    if (!window.Store || typeof Store.init !== 'function') {
      showStorePanel(null);
      return;
    }
    try {
      Store.init();
      ui.storeReady = true;
    } catch (e) {
      showStorePanel(e);
      return;
    }

    // defaults that depend on seeded data
    try {
      var locs = visibleLocs();
      if (locs.length) {
        ui.receive.loc = locs[0].id;
        ui.counts.loc = locs[0].id;
        ui.transfer.from = locs[0].id;
        ui.transfer.to = locs.length > 1 ? locs[1].id : locs[0].id;
      }
    } catch (e) { /* keep nulls, screens guard */ }

    if (typeof Store.subscribe === 'function') {
      Store.subscribe(function () { render(); });
    }

    window.addEventListener('hashchange', onHash);
    bindDelegates();
    onHash();
  }

  function showStorePanel(err) {
    var view = $('#view');
    if (!view) return;
    view.innerHTML =
      '<section class="panel boot-panel">' +
      '  <div class="kicker">STORE NOT LOADED</div>' +
      '  <h2>The data layer is missing.</h2>' +
      '  <p class="muted">This screen expected <span class="mono">store.js</span> to define ' +
      '<span class="mono">window.Store</span> before <span class="mono">app.js</span> runs. ' +
      'Place store.js next to index.html and reload.</p>' +
      (err ? '<div class="mono-block">' + esc(err.message || err) + '</div>' : '') +
      '</section>';
  }

  function onHash() {
    var h = (location.hash || '').replace(/^#\/?/, '');
    var known = ROUTES.some(function (r) { return r.id === h; });
    if (!known) {
      h = 'dashboard';
      if (location.hash !== '#/dashboard') {
        try { location.replace('#/dashboard'); } catch (e) { location.hash = '#/dashboard'; }
      }
    }
    ui.route = h;
    render();
  }

  function go(route) { location.hash = '#/' + route; }

  /* ----------------------------------------------------------
     Central render
     ---------------------------------------------------------- */

  function render() {
    if (!ui.storeReady) return;
    captureFocus();
    document.body.className = 'route-' + ui.route;
    try {
      renderTopbar();
      renderNav();
      var view = $('#view');
      var fn = VIEWS[ui.route] || VIEWS.dashboard;
      view.innerHTML = fn();
    } catch (e) {
      var v = $('#view');
      if (v) {
        v.innerHTML =
          '<section class="panel boot-panel">' +
          '  <div class="kicker">RENDER FAULT</div>' +
          '  <h2>Something did not render.</h2>' +
          '  <p class="muted">The demo hit an unexpected state. Try Reset Demo in the top bar.</p>' +
          '  <div class="mono-block">' + esc(e && e.message ? e.message : e) + '</div>' +
          '</section>';
      }
    }
    restoreFocus();
    runFx();
  }

  function captureFocus() {
    var el = document.activeElement;
    if (el && el.id && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) {
      focusMemo = { id: el.id, s: null, e: null };
      try {
        if (el.tagName === 'INPUT' && /^(text|search|number)$/.test(el.type)) {
          focusMemo.s = el.selectionStart;
          focusMemo.e = el.selectionEnd;
        }
      } catch (e) { /* number inputs may refuse selection */ }
    } else {
      focusMemo = null;
    }
  }

  function restoreFocus() {
    if (focusMemo) {
      var el = document.getElementById(focusMemo.id);
      if (el) {
        el.focus();
        if (focusMemo.s != null) {
          try { el.setSelectionRange(focusMemo.s, focusMemo.e); } catch (e) { /* ok */ }
        }
        return;
      }
    }
    if (ui.route === 'receive' && !ui.receive.formOpen) {
      var scan = $('#scan-input');
      if (scan) scan.focus();
    }
  }

  /* ----------------------------------------------------------
     Top bar + nav
     ---------------------------------------------------------- */

  function renderTopbar() {
    var host = $('#topbar-controls');
    if (!host) return;
    var user = Store.getUser() || {};
    var users = Store.users() || [];
    var offline = false;
    try { offline = !!Store.isOffline(); } catch (e) { /* default live */ }
    var qn = 0;
    try { qn = countOf(Store.pendingQueue()); } catch (e) { /* none */ }

    host.innerHTML =
      '<div class="ctl-group">' +
      '  <span class="ctl-label">CONNECTION</span>' +
      '  <label class="switch" title="Toggle the connection to simulate working offline">' +
      '    <input type="checkbox" id="offline-toggle" data-change="toggle-offline"' + (offline ? ' checked' : '') + '>' +
      '    <span class="track"></span><span class="knob"></span>' +
      '  </label>' +
      '  <span class="conn-state ' + (offline ? 'off' : 'live') + '">' + (offline ? 'OFFLINE' : 'LIVE') + '</span>' +
      (offline && qn > 0 ? '<span class="queue-badge">' + qn + ' QUEUED</span>' : '') +
      '</div>' +
      '<div class="user-pill" title="Switch the active user">' +
      '  <span class="user-dot"></span>' +
      '  <select id="user-select" data-change="set-user" aria-label="Active user">' +
      users.map(function (u) {
        return '<option value="' + esc(u.id) + '"' + (u.id === user.id ? ' selected' : '') + '>' +
          esc(u.name) + '</option>';
      }).join('') +
      '  </select>' +
      '  <span class="user-role">' + esc(user.role || '') + '</span>' +
      '</div>' +
      '<button class="btn sm" type="button" id="theme-toggle" data-action="toggle-theme" ' +
      'title="Switch between the light and dark theme">' +
      (currentTheme() === 'dark' ? 'Light' : 'Dark') + '</button>' +
      '<button class="btn quiet sm danger" type="button" data-action="reset-demo">Reset demo</button>';
  }

  function renderNav() {
    var host = $('#nav');
    if (!host) return;
    host.innerHTML = ROUTES.map(function (r, i) {
      var sep = (r.id === 'ledger') ? '<div class="nav-sep"></div>' : '';
      return sep + '<a href="#/' + r.id + '"' + (ui.route === r.id ? ' class="active"' : '') + '>' +
        (ui.route === r.id ? '<span class="nav-ind"></span>' : '') + esc(r.label) +
        '<span class="nav-u"></span></a>';
    }).join('');
  }

  /* ----------------------------------------------------------
     Views
     ---------------------------------------------------------- */

  var VIEWS = {
    dashboard: viewDashboard,
    receive: viewReceive,
    transfer: viewTransfer,
    catalog: viewCatalog,
    counts: viewCounts,
    ledger: viewLedger,
    exports: viewExports,
    labels: viewLabels
  };

  function screenHead(kicker, titleHtml, sub) {
    return '<div class="screen-head">' +
      '<div class="kicker">' + esc(kicker) + '<span class="kicker-bar"></span></div>' +
      '<h2 class="screen-title">' + titleHtml + '</h2>' +
      (sub ? '<p class="screen-sub">' + esc(sub) + '</p>' : '') +
      '</div>';
  }

  /* ---------- 1 · dashboard ---------- */

  function viewDashboard() {
    var products = Store.products() || [];
    var vis = visibleLocs();
    var visIds = vis.map(function (l) { return l.id; });

    var totalUnits = 0;
    vis.forEach(function (l) { totalUnits += unitsAt(l.id); });

    var valueTotal = 0;
    var anyCosts = false;
    vis.forEach(function (l) {
      if (Store.canSeeCosts(l.id)) {
        anyCosts = true;
        var v = Store.valuation(l.id);
        valueTotal += (v && v.total) ? v.total : 0;
      }
    });

    var dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    var allLedger = Store.ledger({ limit: 500 }) || [];
    var todays = allLedger.filter(function (e) { return e.ts >= dayStart.getTime(); }).length;

    var feed = allLedger
      .filter(function (e) { return entryVisible(e, visIds); })
      .slice(0, 10);

    var tiles =
      '<div class="tile-row">' +
      tile('TOTAL SKUS', intFmt(products.length), 'in the master list', products.length, false) +
      tile('UNITS ON HAND', intFmt(totalUnits), 'across ' + vis.length + ' visible location' + (vis.length === 1 ? '' : 's'), totalUnits, false) +
      tile('INVENTORY VALUE', anyCosts ? money(valueTotal) : MASKED(), anyCosts ? 'at current unit cost' : 'restricted for this role', anyCosts ? valueTotal : null, true, 'tile-value') +
      tile('MOVEMENTS TODAY', intFmt(todays), 'ledger entries since midnight', todays, false) +
      '</div>';

    var cards = vis.map(function (l) {
      var canSee = Store.canSeeCosts(l.id);
      var val = null;
      var top3 = '';
      if (canSee) {
        var v = Store.valuation(l.id);
        val = v ? v.total : 0;
        var vlines = ((v && v.lines) || []).slice()
          .sort(function (a, b) { return b.value - a.value; })
          .slice(0, 3);
        if (vlines.length) {
          top3 = '<div class="loc-top3">' + vlines.map(function (x) {
            return esc(x.name) + ' ' + money(x.value);
          }).join(' · ') + '</div>';
        }
      }
      return '<div class="panel loc-card">' +
        '<div class="loc-name">' + esc(l.name) +
        '<span class="entity-tag ' + (String(l.entity).toLowerCase() === 'davidoff' ? 'davidoff' : '') + '">' + esc(l.entity) + '</span></div>' +
        '<div class="loc-metrics">' +
        '  <div class="loc-metric"><div class="kicker">UNITS</div><div class="mono">' + intFmt(unitsAt(l.id)) + '</div></div>' +
        '  <div class="loc-metric"><div class="kicker">VALUE</div>' +
        (canSee
          ? '<div class="mono">' + money(val) + '</div>'
          : '<div class="mono masked" title="Costs are restricted for your role">· · ·</div><div class="lock-note">LOCKED FOR THIS ROLE</div>') +
        '  </div>' +
        '</div>' +
        top3 +
        '</div>';
    }).join('');

    var allLocs = Store.locations() || [];
    var low = [];
    products.forEach(function (p) {
      var t = 0;
      allLocs.forEach(function (l) { t += Store.qty(l.id, p.sku) || 0; });
      if (t >= 1 && t <= 19) low.push({ name: p.name, qty: t });
    });
    low.sort(function (a, b) { return a.qty - b.qty; });
    low = low.slice(0, 5);
    var lowHtml =
      '<div class="panel low-panel">' +
      '<div class="kicker">LOW STOCK</div>' +
      (low.length
        ? low.map(function (x) {
            return '<button type="button" class="low-item" data-action="low-goto" data-name="' + esc(x.name) + '">' +
              '<span class="low-name">' + esc(x.name) + '</span>' +
              '<span class="mono low-qty">' + intFmt(x.qty) + '</span></button>';
          }).join('')
        : '<div class="empty-note" style="padding:12px 0"><span class="kicker">CLEAR</span>Nothing is running low right now.</div>') +
      '</div>';

    var feedHtml = feed.length
      ? feed.map(function (e) {
          return '<div class="feed-item">' +
            '<span class="feed-type t-' + esc(e.type) + '">' + esc(e.type) + '</span>' +
            '<span class="feed-text">' + esc(describeEntry(e)) +
            ' <span class="feed-meta">· ' + esc(e.author || '') + ' · ' + timeAgo(e.ts) + '</span></span>' +
            '</div>';
        }).join('')
      : '<div class="empty-note"><span class="kicker">QUIET</span>No movements recorded yet. Receive something to start the ledger.</div>';

    return screenHead('DASHBOARD · ' + (Store.getUser() ? Store.getUser().name.toUpperCase() : ''),
        'Today, at a glance<span class="gold-dot">.</span>') +
      tiles +
      '<div class="dash-grid">' +
      '  <div><div class="kicker" style="margin-bottom:10px">LOCATIONS</div><div class="loc-cards">' + cards + '</div>' + lowHtml + '</div>' +
      '  <div class="panel feed">' +
      '    <div class="feed-head kicker">RECENT ACTIVITY</div>' + feedHtml +
      '  </div>' +
      '</div>' +
      '<div class="dash-brandline">' +
      '  <div class="brand-loc">DAVIDOFF HARD ROCK · HOLLYWOOD, FL</div>' +
      '  <div class="brand-tag">inventory that keeps itself</div>' +
      '</div>';
  }

  function tile(kicker, valueHtml, note, countVal, isMoney, extraClass) {
    var countAttr = (countVal !== null && countVal !== undefined && isFinite(countVal))
      ? ' data-count="' + countVal + '"' + (isMoney ? ' data-money="1"' : '')
      : '';
    return '<div class="panel tile' + (extraClass ? ' ' + extraClass : '') + '">' +
      '<div class="kicker">' + esc(kicker) + '</div>' +
      '<div class="tile-num"' + countAttr + '>' + valueHtml + '</div>' +
      (note ? '<div class="tile-note">' + esc(note) + '</div>' : '') +
      '</div>';
  }

  /* ---------- 2 · receive (scan intake) ---------- */

  function simScanSet() {
    var withCodes = (Store.products() || []).filter(function (p) { return p.barcode; }).slice(0, 4);
    var unknown = '4999899998996';
    var guard = 0;
    while (Store.findByBarcode(unknown) && guard < 20) {
      unknown = '49998' + String(Math.floor(Math.random() * 90000000) + 10000000);
      guard++;
    }
    return { known: withCodes, unknown: unknown };
  }

  function viewReceive() {
    var locs = visibleLocs();
    var r = ui.receive;
    if (!r.loc && locs.length) r.loc = locs[0].id;
    var sims = simScanSet();

    var locSel =
      '<div class="field" style="max-width:340px">' +
      '  <label>RECEIVING AT</label>' +
      '  <select id="receive-loc" data-change="receive-loc">' +
      locs.map(function (l) {
        return '<option value="' + esc(l.id) + '"' + (l.id === r.loc ? ' selected' : '') + '>' +
          esc(l.name) + ' · ' + esc(l.entity) + '</option>';
      }).join('') +
      '  </select>' +
      '</div>';

    var scanBlock =
      '<div class="scan-row">' +
      '  <input id="scan-input" type="text" autocomplete="off" spellcheck="false" ' +
      '    placeholder="Scan a barcode, or type a code and press Enter" data-key="scan">' +
      ('BarcodeDetector' in window && !ui.cameraFailed
        ? '<button class="btn" type="button" data-action="camera-open" title="Scan with this device camera">Camera scan</button>'
        : '') +
      '  <button class="btn quiet" type="button" data-action="open-form-nobarcode">No barcode?</button>' +
      '</div>';

    var simBlock =
      '<div class="sim-row">' +
      '  <div class="kicker">SIMULATE SCANNER</div>' +
      '  <div class="sim-btns">' +
      sims.known.map(function (p) {
        return '<button class="sim-btn" type="button" data-action="sim-scan" data-code="' + esc(p.barcode) + '">' +
          esc(p.barcode) + '<span class="sim-name">' + esc(p.name) + '</span></button>';
      }).join('') +
      '    <button class="sim-btn unknown" type="button" data-action="sim-scan" data-code="' + esc(sims.unknown) + '">' +
      esc(sims.unknown) + '<span class="sim-name">unknown code</span></button>' +
      '  </div>' +
      '</div>';

    var unknownPanel = '';
    if (r.formOpen) {
      var f = r.form || {};
      unknownPanel =
        '<div class="unknown-panel">' +
        (r.unknownCode
          ? '<div class="kicker">UNKNOWN CODE · ' + esc(r.unknownCode) + '</div>' +
            '<p class="muted" style="margin-top:4px">This code is not in the master list yet. Add it once, and every location knows it.</p>'
          : '<div class="kicker">NEW PRODUCT · NO BARCODE</div>' +
            '<p class="muted" style="margin-top:4px">Leave the barcode empty and the system assigns an internal SKU you can print.</p>') +
        '<form data-form="new-product">' +
        '  <div class="form-grid">' +
        field('name', 'Product name', f.name, 'text', 'wide') +
        field('category', 'Category', f.category) +
        field('supplier', 'Supplier', f.supplier) +
        field('buyUnit', 'Buy unit', f.buyUnit || 'box') +
        field('sellUnit', 'Sell unit', f.sellUnit || 'stick') +
        field('unitsPerBuy', 'Units per buy', f.unitsPerBuy != null ? f.unitsPerBuy : 25, 'number') +
        field('buyCost', 'Buy cost (USD)', f.buyCost, 'number') +
        field('barcode', 'Barcode (empty = internal SKU)', f.barcode, 'text', 'wide') +
        '  </div>' +
        '  <div class="form-actions">' +
        '    <button class="btn primary" type="submit">Save and receive 1</button>' +
        '    <button class="btn quiet" type="button" data-action="cancel-form">Cancel</button>' +
        '  </div>' +
        '</form>' +
        '</div>';
    }

    var assigned = '';
    if (r.assigned) {
      assigned =
        '<div class="assigned-callout">' +
        '  <div><div class="kicker blue">INTERNAL SKU ASSIGNED</div>' +
        '  <span class="mono">' + esc(r.assigned) + '</span> <span class="muted">is ready to print and scan like any barcode.</span></div>' +
        '  <button class="btn" type="button" data-action="goto-labels">Print label</button>' +
        '</div>';
    }

    var session = r.session;
    var sessionHtml = session.length
      ? session.map(function (line) {
          var p = productBySku(line.sku) || { name: line.sku, sku: line.sku };
          return '<div class="session-line' + (line.sku === r.lastScan ? ' just' : '') + '">' +
            '<div class="p-name">' + esc(p.name) + '<span class="p-sku">' + esc(p.sku) + '</span></div>' +
            '<button class="btn-step" type="button" data-action="step-line" data-sku="' + esc(line.sku) + '" data-delta="-1">-</button>' +
            '<span class="session-qty">' + intFmt(line.qty) + '</span>' +
            '<button class="btn-step" type="button" data-action="step-line" data-sku="' + esc(line.sku) + '" data-delta="1">+</button>' +
            '<button class="btn-step" type="button" title="Remove line" data-action="remove-line" data-sku="' + esc(line.sku) + '">x</button>' +
            '</div>';
        }).join('')
      : '<div class="empty-note"><span class="kicker">EMPTY</span>Scan a code, or use the simulator below. Each hit lands here instantly.</div>';

    var totalQty = session.reduce(function (a, l) { return a + l.qty; }, 0);

    return screenHead('RECEIVE · SCAN INTAKE', 'Scan it <i>in</i>.',
        'A delivery arrives, gets scanned item by item, and the list is already right.') +
      '<div class="receive-grid">' +
      '  <div class="panel scan-panel">' +
      locSel + scanBlock + unknownPanel + assigned + simBlock +
      '  </div>' +
      '  <div class="panel session-panel">' +
      '    <div class="kicker">JUST RECEIVED · THIS SESSION</div>' +
      '    <div class="session-list">' + sessionHtml + '</div>' +
      (session.length
        ? '<hr class="hairline"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px">' +
          '<span class="muted">' + intFmt(totalQty) + ' unit' + (totalQty === 1 ? '' : 's') + ' · ' + session.length + ' line' + (session.length === 1 ? '' : 's') + '</span>' +
          '<button class="btn primary" type="button" data-action="post-receipt">Post receipt</button></div>'
        : '') +
      '  </div>' +
      '</div>';
  }

  function field(name, label, value, type, wide) {
    var step = (name === 'buyCost') ? ' step="0.01" min="0"' : (type === 'number' ? ' step="1" min="1"' : '');
    return '<div class="field' + (wide ? ' wide' : '') + '">' +
      '<label for="np-' + name + '">' + esc(label) + '</label>' +
      '<input id="np-' + name + '" name="' + name + '" type="' + (type || 'text') + '"' + step +
      ' value="' + esc(value == null ? '' : value) + '" data-input="np-field" data-field="' + name + '">' +
      '</div>';
  }

  /* ---------- 3 · transfer ---------- */

  function viewTransfer() {
    var locs = visibleLocs();
    var t = ui.transfer;
    if (!t.from && locs.length) t.from = locs[0].id;
    if (!t.to && locs.length) t.to = (locs[1] || locs[0]).id;

    var opts = function (sel) {
      return locs.map(function (l) {
        return '<option value="' + esc(l.id) + '"' + (l.id === sel ? ' selected' : '') + '>' +
          esc(l.name) + '</option>';
      }).join('');
    };

    var sameLoc = t.from && t.from === t.to;

    var results = '';
    if (t.q && !t.sku) {
      var found = (Store.search(t.q) || []).slice(0, 6);
      results = found.length
        ? '<div class="picker-results">' + found.map(function (p) {
            return '<button type="button" class="picker-item" data-action="pick-product" data-sku="' + esc(p.sku) + '">' +
              '<span>' + esc(p.name) + '</span><span class="mono">' + esc(p.sku) + '</span></button>';
          }).join('') + '</div>'
        : '<div class="empty-note"><span class="kicker">NO MATCH</span>Nothing in the catalog matches that.</div>';
    }

    var picked = t.sku ? productBySku(t.sku) : null;
    var stockView = '';
    if (picked) {
      var fromQty = Store.qty(t.from, picked.sku);
      var toQty = Store.qty(t.to, picked.sku);
      stockView =
        '<div class="stock-compare">' +
        '  <div class="stock-cell"><div class="kicker">AT ' + esc(locName(t.from).toUpperCase()) + '</div><div class="mono">' + intFmt(fromQty) + '</div></div>' +
        '  <div class="stock-cell"><div class="kicker">AT ' + esc(locName(t.to).toUpperCase()) + '</div><div class="mono">' + intFmt(toQty) + '</div></div>' +
        '</div>';
    }

    var recent = (Store.ledger({ limit: 60 }) || [])
      .filter(function (e) { return e.type === 'transfer'; })
      .slice(0, 8);
    var recentHtml = recent.length
      ? recent.map(function (e) {
          return '<div class="feed-item"><span class="feed-type t-transfer">transfer</span>' +
            '<span class="feed-text">' + esc(describeEntry(e)) +
            ' <span class="feed-meta">· ' + esc(e.author || '') + ' · ' + timeAgo(e.ts) + '</span></span></div>';
        }).join('')
      : '<div class="empty-note"><span class="kicker">NONE YET</span>Transfers you execute will appear here.</div>';

    return screenHead('TRANSFER · BETWEEN LOCATIONS', 'Move stock, keep the <i>ledger</i>.',
        'Corporate distributes to the shops. Every move writes both sides at once.') +
      '<div class="transfer-grid">' +
      '  <div class="panel scan-panel">' +
      '    <div class="route-row">' +
      '      <div class="field"><label>FROM</label><select id="tr-from" data-change="tr-from">' + opts(t.from) + '</select></div>' +
      '      <span class="route-arrow">-&gt;</span>' +
      '      <div class="field"><label>TO</label><select id="tr-to" data-change="tr-to">' + opts(t.to) + '</select></div>' +
      '    </div>' +
      (sameLoc ? '<p class="muted" style="margin-top:8px;color:var(--dv-gold-dark)">Pick two different locations to move stock.</p>' : '') +
      '    <div class="field" style="margin-top:14px"><label>PRODUCT · SCAN OR SEARCH</label>' +
      '      <input id="tr-q" type="text" autocomplete="off" spellcheck="false" placeholder="Name, SKU or barcode" ' +
      '        value="' + esc(t.q) + '" data-input="tr-q" data-key="tr-scan">' +
      '    </div>' +
      results +
      (picked
        ? '<div class="assigned-callout" style="margin-top:14px"><div><div class="kicker blue">SELECTED</div>' +
          esc(picked.name) + ' <span class="mono" style="font-size:11px;color:var(--dv-grey-75)">' + esc(picked.sku) + '</span></div>' +
          '<button class="btn quiet sm" type="button" data-action="clear-pick">Change</button></div>' +
          stockView +
          '<div class="route-row" style="margin-top:14px;align-items:end">' +
          '  <div class="field" style="max-width:120px"><label>QTY</label>' +
          '    <input id="tr-qty" type="number" min="1" step="1" value="' + esc(t.qty) + '" data-input="tr-qty"></div>' +
          '  <button class="btn primary" type="button" data-action="do-transfer"' + (sameLoc ? ' disabled' : '') + '>Execute transfer</button>' +
          '</div>'
        : '') +
      '  </div>' +
      '  <div class="panel feed">' +
      '    <div class="feed-head kicker">RECENT TRANSFERS</div>' + recentHtml +
      '  </div>' +
      '</div>';
  }

  /* ---------- 4 · catalog ---------- */

  function catalogFiltered() {
    var c = ui.catalog;
    var items = c.q ? (Store.search(c.q) || []) : (Store.products() || []);
    if (c.cat !== 'all') items = items.filter(function (p) { return (p.category || '') === c.cat; });
    if (c.sup !== 'all') items = items.filter(function (p) { return (p.supplier || '') === c.sup; });
    return items;
  }

  function catInitials(name) {
    var parts = String(name || '').trim().split(/\s+/);
    var a = parts[0] ? parts[0].charAt(0) : '';
    var b = parts[1] ? parts[1].charAt(0) : (parts[0] ? parts[0].charAt(1) : '');
    return (a + b).toUpperCase();
  }

  function monogram(p) {
    return '<span class="monogram">' + esc(catInitials(p.name)) + '</span>';
  }

  function stockChip(oh) {
    var cls, label;
    if (oh <= 0) { cls = 'out'; label = 'OUT'; }
    else if (oh < 20) { cls = 'low'; label = 'LOW'; }
    else { cls = 'in'; label = 'IN STOCK'; }
    return '<span class="stock-chip ' + cls + '"><span class="s-dot"></span>' + label + '</span>';
  }

  function csvFieldLocal(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function exportSelectedCsv() {
    var sel = ui.catalog.selected;
    var prods = (Store.products() || []).filter(function (p) { return !!sel[p.sku]; });
    if (!prods.length) { toast('Nothing is selected.', 'warn', 'EMPTY'); return; }
    var rows = [['sku', 'name', 'barcode', 'isInternal', 'category', 'supplier', 'buyUnit', 'sellUnit', 'unitsPerBuy', 'buyCost', 'sellCost']];
    prods.forEach(function (p) {
      rows.push([p.sku, p.name, p.barcode, p.isInternal, p.category, p.supplier,
        p.buyUnit, p.sellUnit, p.unitsPerBuy, (p.buyCost || 0).toFixed(2), (p.sellCost || 0).toFixed(2)]);
    });
    var csv = rows.map(function (r) { return r.map(csvFieldLocal).join(','); }).join('\n');
    var d = new Date();
    var stamp = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
    downloadText('davidoff-catalog-selected-' + stamp + '.csv', csv);
    toast(prods.length + ' product' + (prods.length === 1 ? '' : 's') + ' exported to CSV.', 'ok', 'EXPORT');
  }

  function viewCatalog() {
    var c = ui.catalog;
    var all = Store.products() || [];
    var masked = staffMasked();
    var locs = Store.locations() || [];

    var cats = {}, sups = {};
    all.forEach(function (p) {
      if (p.category) cats[p.category] = (cats[p.category] || 0) + 1;
      if (p.supplier) sups[p.supplier] = (sups[p.supplier] || 0) + 1;
    });
    var catNames = Object.keys(cats).sort();
    var supNames = Object.keys(sups).sort();

    var onHand = function (sku) {
      var total = 0;
      locs.forEach(function (l) { total += Store.qty(l.id, sku) || 0; });
      return total;
    };

    var items = catalogFiltered();
    var rowsData = items.map(function (p) { return { p: p, oh: onHand(p.sku) }; });

    var s = c.sort;
    if (s.key) {
      rowsData.sort(function (a, b) {
        var r;
        if (s.key === 'name') {
          var an = a.p.name.toLowerCase(), bn = b.p.name.toLowerCase();
          r = an < bn ? -1 : an > bn ? 1 : 0;
        } else if (s.key === 'buyCost') {
          r = (a.p.buyCost || 0) - (b.p.buyCost || 0);
        } else if (s.key === 'sellCost') {
          r = (a.p.sellCost || 0) - (b.p.sellCost || 0);
        } else {
          r = a.oh - b.oh;
        }
        return r * s.dir;
      });
    }

    var selCount = 0;
    for (var k in c.selected) {
      if (Object.prototype.hasOwnProperty.call(c.selected, k) && c.selected[k]) selCount++;
    }
    var allVisSelected = rowsData.length > 0 && rowsData.every(function (r) { return !!c.selected[r.p.sku]; });

    function sortTh(label, key, numeric) {
      var arrow = s.key === key
        ? '<span class="sort-arrow">' + (s.dir === 1 ? '&#9650;' : '&#9660;') + '</span>'
        : '';
      return '<th class="sortable' + (numeric ? ' num' : '') + '" data-action="sort-col" data-key="' + key + '">' +
        label + arrow + '</th>';
    }

    var rows = rowsData.map(function (r) {
      var p = r.p;
      var openMenu = c.menu === p.sku;
      var sub = esc((p.buyUnit || 'box') + ' of ' + (p.unitsPerBuy || 1) + ' -> ' + (p.sellUnit || 'unit')) +
        (p.supplier ? ' · ' + esc(p.supplier) : '');
      return '<tr class="rowlink" data-action="open-drawer" data-sku="' + esc(p.sku) + '">' +
        '<td class="sel-td" data-action="toggle-select"><input type="checkbox" class="row-check" tabindex="-1"' +
        (c.selected[p.sku] ? ' checked' : '') + ' aria-label="Select ' + esc(p.name) + '"></td>' +
        '<td class="tile-td">' + monogram(p) + '</td>' +
        '<td class="prod-td"><div class="prod-name">' + esc(p.name) + '</div>' +
        '<div class="prod-sub">' + sub + '</div></td>' +
        '<td class="muted">' + esc(p.category || '') + '</td>' +
        '<td class="mono sku-td" title="' + esc(p.sku) + '">' + esc(p.sku) +
        (p.isInternal ? '<span class="chip">INTERNAL</span>' : '') + '</td>' +
        '<td class="mono num">' + (masked ? MASKED() : money(p.buyCost)) + '</td>' +
        '<td class="mono num">' + (masked ? MASKED() : money(p.sellCost)) + '</td>' +
        '<td class="mono num">' + intFmt(r.oh) + '</td>' +
        '<td class="chip-td">' + stockChip(r.oh) + '</td>' +
        '<td class="menu-td"><div class="row-menu">' +
        '<button type="button" class="row-menu-btn" data-action="row-menu" aria-label="Row actions" aria-haspopup="true">&middot;&middot;&middot;</button>' +
        (openMenu
          ? '<div class="row-menu-sheet">' +
            (!masked ? '<button type="button" data-action="menu-cost">Update cost</button>' : '') +
            (p.isInternal ? '<button type="button" data-action="menu-label">Print label</button>' : '') +
            '<button type="button" data-action="menu-history">View history</button>' +
            '</div>'
          : '') +
        '</div></td>' +
        '</tr>';
    }).join('');

    var thead = '<thead><tr>' +
      '<th class="sel-td" data-action="toggle-select-all"><input type="checkbox" class="row-check" tabindex="-1"' +
      (allVisSelected ? ' checked' : '') + ' aria-label="Select all visible"></th>' +
      '<th></th>' +
      sortTh('Product', 'name') +
      '<th>Category</th>' +
      '<th>SKU</th>' +
      sortTh('Box cost', 'buyCost', true) +
      sortTh('Unit cost', 'sellCost', true) +
      sortTh('On hand', 'onHand', true) +
      '<th>Stock</th>' +
      '<th></th>' +
      '</tr></thead>';

    var table = rowsData.length
      ? '<div class="table-wrap catalog-wrap"><table class="grid catalog-grid">' +
        thead + '<tbody>' + rows + '</tbody></table></div>'
      : '<div class="panel"><div class="empty-note"><span class="kicker">NO RESULTS</span>' +
        (c.q || c.cat !== 'all' || c.sup !== 'all'
          ? 'Nothing matches these filters.'
          : 'The catalog is empty. Receive a product to create it.') + '</div></div>';

    var catOpts = '<option value="all"' + (c.cat === 'all' ? ' selected' : '') + '>All products (' + all.length + ')</option>' +
      catNames.map(function (n) {
        return '<option value="' + esc(n) + '"' + (c.cat === n ? ' selected' : '') + '>' +
          esc(n) + ' (' + cats[n] + ')</option>';
      }).join('');
    var supOpts = '<option value="all"' + (c.sup === 'all' ? ' selected' : '') + '>All suppliers (' + all.length + ')</option>' +
      supNames.map(function (n) {
        return '<option value="' + esc(n) + '"' + (c.sup === n ? ' selected' : '') + '>' +
          esc(n) + ' (' + sups[n] + ')</option>';
      }).join('');

    var toolbar =
      '<div class="toolbar catalog-toolbar">' +
      '  <select id="cat-filter" data-change="cat-filter" aria-label="Filter by category">' + catOpts + '</select>' +
      '  <select id="sup-filter" data-change="sup-filter" aria-label="Filter by supplier">' + supOpts + '</select>' +
      '  <span class="kicker">' + intFmt(rowsData.length) + ' SHOWN' + (masked ? ' · COSTS RESTRICTED' : '') + '</span>' +
      '  <span class="spacer"></span>' +
      '  <span class="search-wrap">' +
      '    <input id="catalog-q" type="search" placeholder="Search name, SKU, supplier or category" value="' + esc(c.q) + '" data-input="catalog-q">' +
      '    <span class="key-hint">/</span>' +
      '  </span>' +
      '  <button class="btn primary" type="button" data-action="catalog-new">+ New product</button>' +
      '</div>';

    var formPanel = '';
    if (c.formOpen) {
      var f = c.form || {};
      formPanel =
        '<div class="panel catalog-form-panel">' +
        '<div class="kicker">NEW PRODUCT · CATALOG</div>' +
        '<p class="muted" style="margin-top:4px">Leave the barcode empty and the system assigns an internal SKU you can print.</p>' +
        '<form data-form="new-product" data-ctx="catalog">' +
        '  <div class="form-grid">' +
        field('name', 'Product name', f.name, 'text', 'wide') +
        field('category', 'Category', f.category) +
        field('supplier', 'Supplier', f.supplier) +
        field('buyUnit', 'Buy unit', f.buyUnit || 'box') +
        field('sellUnit', 'Sell unit', f.sellUnit || 'stick') +
        field('unitsPerBuy', 'Units per buy', f.unitsPerBuy != null ? f.unitsPerBuy : 25, 'number') +
        field('buyCost', 'Buy cost (USD)', f.buyCost, 'number') +
        field('barcode', 'Barcode (empty = internal SKU)', f.barcode, 'text', 'wide') +
        '  </div>' +
        '  <div class="form-actions">' +
        '    <button class="btn primary" type="submit">Save to catalog</button>' +
        '    <button class="btn quiet" type="button" data-action="catalog-form-cancel">Cancel</button>' +
        '  </div>' +
        '</form>' +
        '</div>';
    }

    var bulk = selCount > 0
      ? '<div class="bulk-bar">' +
        '<span class="kicker blue">' + intFmt(selCount) + ' SELECTED</span>' +
        '<button class="btn sm" type="button" data-action="export-selected">Export selected CSV</button>' +
        '<button class="btn quiet sm" type="button" data-action="clear-selected">Clear</button>' +
        '</div>'
      : '';

    return screenHead('CATALOG · MASTER LIST',
        'One master <i>list</i>. <span class="title-count">' + intFmt(all.length) + '</span>',
        'Every product, every cost, every location, in one place. Click a row for the full history.') +
      toolbar + formPanel + bulk + table + drawerHtml();
  }

  function drawerHtml() {
    var sku = ui.catalog.drawer;
    if (!sku) return '';
    var p = productBySku(sku);
    if (!p) return '';
    var masked = staffMasked();
    var locs = Store.locations() || [];

    var hist = (p.costHistory || []).slice();
    var histHtml = hist.length
      ? '<div class="timeline">' + hist.slice().reverse().map(function (h, idx, arr) {
          var pos = hist.length - 1 - idx;           // index in chronological array
          var prev = pos > 0 ? hist[pos - 1] : null;
          var line = masked ? '· · ·'
            : (prev ? money(prev.buyCost) + ' -> ' + money(h.buyCost) : 'Initial · ' + money(h.buyCost));
          return '<div class="tl-item"><span class="mono">' + line + '</span>' +
            '<div class="tl-meta">' + fmtTs(h.ts) + ' · ' + esc(h.author || '') + '</div></div>';
        }).join('') + '</div>'
      : '<p class="muted">No cost history recorded.</p>';

    var stockHtml = locs.map(function (l) {
      return '<div class="kv"><span class="k">' + esc(l.name) + '</span>' +
        '<span class="v">' + intFmt(Store.qty(l.id, p.sku) || 0) + '</span></div>';
    }).join('');

    return '<div class="drawer-backdrop" data-action="close-drawer"></div>' +
      '<aside class="drawer">' +
      '  <button class="close-x" type="button" data-action="close-drawer">x</button>' +
      '  <div class="kicker">PRODUCT' + (p.isInternal ? ' · INTERNAL SKU' : '') + '</div>' +
      '  <h3>' + esc(p.name) + '</h3>' +
      '  <div class="kv" style="margin-top:10px"><span class="k">SKU</span><span class="v">' + esc(p.sku) + '</span></div>' +
      '  <div class="kv"><span class="k">Barcode</span><span class="v">' + (p.barcode ? esc(p.barcode) : 'none · internal') + '</span></div>' +
      '  <div class="kv"><span class="k">Category</span><span class="v">' + esc(p.category || '') + '</span></div>' +
      '  <div class="kv"><span class="k">Supplier</span><span class="v">' + esc(p.supplier || '') + '</span></div>' +
      '  <div class="kv"><span class="k">Units</span><span class="v">' + esc((p.buyUnit || 'box') + ' of ' + (p.unitsPerBuy || 1) + ' -> ' + (p.sellUnit || 'unit')) + '</span></div>' +
      '  <div class="kv"><span class="k">Buy cost</span><span class="v">' + (masked ? '· · ·' : money(p.buyCost)) + '</span></div>' +
      '  <div class="kv"><span class="k">Unit cost</span><span class="v">' + (masked ? '· · ·' : money(p.sellCost)) + '</span></div>' +
      '  <section><div class="kicker">STOCK BY LOCATION</div>' + stockHtml + '</section>' +
      '  <section><div class="kicker">COST HISTORY</div>' + histHtml + '</section>' +
      (!masked
        ? '<section><div class="kicker">UPDATE COST</div>' +
          '<form class="inline-form" data-form="update-cost" data-sku="' + esc(p.sku) + '">' +
          '  <input id="cost-edit" type="number" step="0.01" min="0" placeholder="New buy cost" ' +
          '    value="' + esc(ui.catalog.costEdit) + '" data-input="cost-edit" required>' +
          '  <button class="btn sm" type="submit">Save cost</button>' +
          '</form>' +
          '<p class="dim" style="font-size:11px;margin-top:8px">Every change keeps the old value in the history above.</p>' +
          '</section>'
        : '') +
      (p.isInternal
        ? '<section><button class="btn" type="button" data-action="goto-labels">Print label</button></section>'
        : '') +
      '</aside>';
  }

  /* ---------- 5 · counts ---------- */

  function viewCounts() {
    var locs = visibleLocs();
    var c = ui.counts;
    if (!c.loc && locs.length) c.loc = locs[0].id;

    var locSel =
      '<div class="toolbar">' +
      '  <div class="field" style="min-width:280px"><label>COUNTING AT</label>' +
      '  <select id="counts-loc" data-change="counts-loc">' +
      locs.map(function (l) {
        return '<option value="' + esc(l.id) + '"' + (l.id === c.loc ? ' selected' : '') + '>' +
          esc(l.name) + ' · ' + esc(l.entity) + '</option>';
      }).join('') +
      '  </select></div>' +
      '</div>';

    var body = '';

    if (c.report) {
      var rep = c.report;
      var offCount = rep.lines.filter(function (l) { return l.delta !== 0; }).length;
      var adjEntries = (Store.ledger({ locationId: rep.loc, limit: 40 }) || [])
        .filter(function (e) { return e.type === 'count-adjust'; })
        .slice(0, rep.lines.length);

      body =
        '<div class="report-banner">' +
        '  <div><div class="kicker blue">COUNT APPLIED · ' + esc(locName(rep.loc).toUpperCase()) + '</div>' +
        '  <span class="muted">' + rep.lines.length + ' lines counted · ' +
        (offCount === 0 ? 'everything matched.' : offCount + ' variance' + (offCount === 1 ? '' : 's') + ' adjusted and written to the ledger.') +
        '</span></div>' +
        '  <span class="spacer" style="flex:1"></span>' +
        '  <button class="btn quiet sm" type="button" data-action="counts-again">New count</button>' +
        '</div>' +
        '<div class="table-wrap"><table class="grid">' +
        '<thead><tr><th>SKU</th><th>Product</th><th class="num">Expected</th><th class="num">Counted</th><th class="num">Variance</th></tr></thead><tbody>' +
        rep.lines.map(function (l) {
          var cls = l.delta === 0 ? 'variance-zero' : 'variance-pos';
          var d = (l.delta > 0 ? '+' : '') + intFmt(l.delta);
          return '<tr><td class="mono">' + esc(l.sku) + '</td><td>' + esc(l.name) + '</td>' +
            '<td class="mono num">' + intFmt(l.expected) + '</td>' +
            '<td class="mono num">' + intFmt(l.counted) + '</td>' +
            '<td class="mono num ' + cls + '">' + (l.delta === 0 ? 'match' : d) + '</td></tr>';
        }).join('') +
        '</tbody></table></div>' +
        (adjEntries.length
          ? '<div class="panel feed" style="margin-top:14px"><div class="feed-head kicker">LEDGER ENTRIES WRITTEN</div>' +
            adjEntries.map(function (e) {
              return '<div class="feed-item"><span class="feed-type t-count-adjust">count-adjust</span>' +
                '<span class="feed-text">' + esc(describeEntry(e)) +
                ' <span class="feed-meta">· ' + esc(e.author || '') + ' · ' + timeAgo(e.ts) + '</span></span></div>';
            }).join('') + '</div>'
          : '');
    } else {
      var sheet = c.loc ? (Store.countSheet(c.loc) || []) : [];
      body = sheet.length
        ? '<div class="table-wrap"><table class="grid">' +
          '<thead><tr><th>SKU</th><th>Product</th><th class="num">Expected</th><th class="num">Counted</th></tr></thead><tbody>' +
          sheet.map(function (row) {
            var v = c.values[row.sku] != null ? c.values[row.sku] : row.expected;
            return '<tr><td class="mono">' + esc(row.sku) + '</td><td>' + esc(row.name) + '</td>' +
              '<td class="mono num muted">' + intFmt(row.expected) + '</td>' +
              '<td class="num"><input class="count-input" id="count-' + esc(row.sku) + '" type="number" min="0" step="1" ' +
              'value="' + esc(v) + '" data-input="count-row" data-sku="' + esc(row.sku) + '"></td></tr>';
          }).join('') +
          '</tbody></table></div>' +
          '<div class="toolbar" style="margin-top:14px"><span class="spacer"></span>' +
          '<button class="btn primary" type="button" data-action="apply-count">Submit count</button></div>'
        : '<div class="panel"><div class="empty-note"><span class="kicker">NOTHING TO COUNT</span>' +
          'This location holds no stock yet. Receive or transfer something first.</div></div>';
    }

    return screenHead('COUNTS · PHYSICAL VS SYSTEM', 'Count, then <i>reconcile</i>.',
        'The sheet is prefilled with what the system expects. Type what you actually see.') +
      locSel + body;
  }

  /* ---------- 6 · ledger ---------- */

  function viewLedger() {
    var f = ui.ledger;
    var locs = Store.locations() || [];
    var args = { limit: 250 };
    if (f.loc !== 'all') args.locationId = f.loc;
    var entries = (Store.ledger(args) || []).filter(function (e) {
      return f.type === 'all' || e.type === f.type;
    });

    var types = ['receive', 'transfer', 'cost-change', 'new-product', 'count-adjust'];

    var rows = entries.map(function (e) {
      return '<tr>' +
        '<td class="mono muted" style="white-space:nowrap">' + fmtTs(e.ts) + '</td>' +
        '<td><span class="feed-type t-' + esc(e.type) + '">' + esc(e.type) + '</span></td>' +
        '<td>' + esc(describeEntry(e)) + '</td>' +
        '<td class="mono num">' + (e.qty != null ? intFmt(e.qty) : '') + '</td>' +
        '<td class="muted">' + esc(e.author || '') + '</td>' +
        '</tr>';
    }).join('');

    return screenHead('LEDGER · FULL HISTORY', 'Every movement, written <i>down</i>.',
        'Receipts, transfers, cost changes and count adjustments, newest first. This is what accounting reads.') +
      '<div class="toolbar">' +
      '  <div class="field"><label>LOCATION</label><select id="ledger-loc" data-change="ledger-loc">' +
      '    <option value="all"' + (f.loc === 'all' ? ' selected' : '') + '>All locations</option>' +
      locs.map(function (l) {
        return '<option value="' + esc(l.id) + '"' + (f.loc === l.id ? ' selected' : '') + '>' + esc(l.name) + '</option>';
      }).join('') +
      '  </select></div>' +
      '  <div class="field"><label>TYPE</label><select id="ledger-type" data-change="ledger-type">' +
      '    <option value="all"' + (f.type === 'all' ? ' selected' : '') + '>All types</option>' +
      types.map(function (t) {
        return '<option value="' + t + '"' + (f.type === t ? ' selected' : '') + '>' + t + '</option>';
      }).join('') +
      '  </select></div>' +
      '  <span class="spacer"></span>' +
      '  <span class="kicker">' + intFmt(entries.length) + ' ENTRIES</span>' +
      '</div>' +
      (entries.length
        ? '<div class="table-wrap"><table class="grid">' +
          '<thead><tr><th>Timestamp</th><th>Type</th><th>Movement</th><th class="num">Qty</th><th>Author</th></tr></thead>' +
          '<tbody>' + rows + '</tbody></table></div>'
        : '<div class="panel"><div class="empty-note"><span class="kicker">EMPTY</span>No entries match these filters.</div></div>');
  }

  /* ---------- 7 · exports ---------- */

  function viewExports() {
    var kinds = [
      { id: 'catalog', title: 'Catalog', sub: 'Every SKU with units, costs and suppliers.' },
      { id: 'ledger', title: 'Ledger', sub: 'The full movement history, for accounting.' },
      { id: 'stock', title: 'Stock by location', sub: 'On-hand quantities across the four locations.' },
      { id: 'valuation', title: 'Valuation', sub: 'Stock priced at current unit cost.' }
    ];

    var cards = kinds.map(function (k) {
      var preview = '';
      try {
        var csv = Store.exportCSV(k.id) || '';
        preview = csv.split(/\r?\n/).slice(0, 3).join('\n');
      } catch (e) {
        preview = 'export unavailable';
      }
      return '<div class="panel export-card">' +
        '<div class="kicker">CSV · ' + k.id.toUpperCase() + '</div>' +
        '<h4>' + esc(k.title) + '</h4>' +
        '<p class="muted" style="font-size:12.5px">' + esc(k.sub) + '</p>' +
        '<div class="csv-preview">' + esc(preview || 'empty') + '</div>' +
        '<button class="btn" type="button" data-action="export-dl" data-kind="' + k.id + '">Download CSV</button>' +
        '</div>';
    }).join('');

    return screenHead('EXPORTS · YOUR DATA IS YOURS', 'Your data, <i>exportable</i>.',
        'Catalog, ledger, stock and valuation, in full, any time. Nothing is locked in.') +
      '<div class="export-grid">' + cards + '</div>';
  }

  /* ---------- 8 · labels ---------- */

  function viewLabels() {
    var internals = (Store.products() || []).filter(function (p) { return p.isInternal; });

    var grid = internals.length
      ? '<div class="label-grid">' +
        internals.map(function (p) {
          return '<div class="label">' +
            '<div class="l-brand">DAVIDOFF HARD ROCK · INTERNAL</div>' +
            '<div class="l-name">' + esc(p.name) + '</div>' +
            code39Svg(p.sku, 44) +
            '<div class="l-sku">' + esc(p.sku) + '</div>' +
            '</div>';
        }).join('') + '</div>'
      : '<div class="panel"><div class="empty-note"><span class="kicker">NO INTERNAL SKUS YET</span>' +
        'Add a product without a barcode on the Receive screen and its label appears here.</div></div>';

    return screenHead('LABELS · CODE 39 · SCANNABLE', 'Labels that <i>scan</i>.',
        'Loose product without a supplier barcode gets an internal SKU. Print it once, scan it forever.') +
      '<div class="toolbar labels-toolbar">' +
      '  <span class="kicker">' + intFmt(internals.length) + ' INTERNAL SKUS</span>' +
      '  <span class="spacer"></span>' +
      (internals.length ? '<button class="btn primary" type="button" data-action="print-labels">Print label sheet</button>' : '') +
      '</div>' +
      grid;
  }

  /* ----------------------------------------------------------
     Event delegation
     ---------------------------------------------------------- */

  function bindDelegates() {
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    document.addEventListener('input', onInput);
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('submit', onSubmit);
    document.addEventListener('mouseover', onHoverIn);
    document.addEventListener('mouseout', onHoverOut);
    document.addEventListener('mousedown', onPressDown);
    document.addEventListener('mouseup', onPressUp);
  }

  function onClick(ev) {
    var el = ev.target.closest ? ev.target.closest('[data-action]') : null;
    if (!el) {
      // any outside click closes the row action menu
      if (ui.catalog.menu) {
        ui.catalog.menu = null;
        render();
        return;
      }
      // keep the scan input hot on the receive screen
      if (ui.route === 'receive' && !ui.receive.formOpen &&
          !/^(INPUT|SELECT|TEXTAREA|BUTTON|A)$/.test(ev.target.tagName)) {
        var scan = $('#scan-input');
        if (scan) scan.focus();
      }
      return;
    }
    var action = el.getAttribute('data-action');

    // clicking anything that is not the menu itself closes an open row menu
    if (ui.catalog.menu && action !== 'row-menu' && String(action).indexOf('menu-') !== 0) {
      ui.catalog.menu = null;
    }

    try {
      switch (action) {
        case 'reset-demo':
          if (window.confirm('Reset the demo? All movements, products and queued events go back to the seeded state.')) {
            Store.reset();
            ui.receive.session = [];
            ui.receive.formOpen = false;
            ui.receive.assigned = null;
            ui.receive.unknownCode = null;
            ui.transfer.sku = null;
            ui.transfer.q = '';
            ui.catalog.drawer = null;
            ui.catalog.selected = {};
            ui.catalog.menu = null;
            ui.catalog.formOpen = false;
            ui.catalog.form = null;
            ui.catalog.cat = 'all';
            ui.catalog.sup = 'all';
            ui.catalog.sort = { key: '', dir: 1 };
            ui.counts.values = {};
            ui.counts.report = null;
            toast('Demo reset to seeded data.', 'ok', 'RESET');
            render();
          }
          break;

        case 'sim-scan':
          handleScan(el.getAttribute('data-code') || '');
          break;

        case 'open-form-nobarcode':
          ui.receive.formOpen = true;
          ui.receive.unknownCode = null;
          ui.receive.assigned = null;
          ui.receive.form = { name: '', category: '', supplier: '', barcode: '', buyUnit: 'jar', sellUnit: 'stick', unitsPerBuy: 1, buyCost: '' };
          render();
          var nameEl = $('#np-name');
          if (nameEl) nameEl.focus();
          break;

        case 'cancel-form':
          ui.receive.formOpen = false;
          ui.receive.unknownCode = null;
          render();
          break;

        case 'step-line': stepLine(el.getAttribute('data-sku'), parseInt(el.getAttribute('data-delta'), 10)); break;
        case 'remove-line': removeLine(el.getAttribute('data-sku')); break;
        case 'post-receipt': postReceipt(); break;

        case 'camera-open': startCamera(); break;
        case 'camera-close': stopCamera(); break;

        case 'goto-labels':
          ui.receive.assigned = null;
          ui.catalog.drawer = null;
          go('labels');
          break;

        case 'pick-product':
          ui.transfer.sku = el.getAttribute('data-sku');
          ui.transfer.qty = 1;
          render();
          break;

        case 'clear-pick':
          ui.transfer.sku = null;
          ui.transfer.q = '';
          render();
          var trq = $('#tr-q');
          if (trq) trq.focus();
          break;

        case 'do-transfer': doTransfer(); break;

        case 'open-drawer':
          ui.catalog.drawer = el.getAttribute('data-sku');
          ui.catalog.costEdit = '';
          fx.drawer = true;
          render();
          break;

        case 'close-drawer':
          ui.catalog.drawer = null;
          render();
          break;

        case 'toggle-select':
          var selTr = el.closest('tr');
          var selSku = selTr ? selTr.getAttribute('data-sku') : null;
          if (selSku) {
            if (ui.catalog.selected[selSku]) delete ui.catalog.selected[selSku];
            else ui.catalog.selected[selSku] = true;
            render();
          }
          break;

        case 'toggle-select-all':
          var visItems = catalogFiltered();
          var allSel = visItems.length > 0 && visItems.every(function (p) { return !!ui.catalog.selected[p.sku]; });
          visItems.forEach(function (p) {
            if (allSel) delete ui.catalog.selected[p.sku];
            else ui.catalog.selected[p.sku] = true;
          });
          render();
          break;

        case 'sort-col':
          var skey = el.getAttribute('data-key');
          if (ui.catalog.sort.key === skey) ui.catalog.sort.dir = -ui.catalog.sort.dir;
          else ui.catalog.sort = { key: skey, dir: 1 };
          render();
          break;

        case 'row-menu':
          var menuTr = el.closest('tr');
          var menuSku = menuTr ? menuTr.getAttribute('data-sku') : null;
          ui.catalog.menu = (ui.catalog.menu === menuSku) ? null : menuSku;
          if (ui.catalog.menu) fx.menu = true;
          render();
          break;

        case 'menu-cost':
          var costTr = el.closest('tr');
          ui.catalog.menu = null;
          ui.catalog.drawer = costTr ? costTr.getAttribute('data-sku') : null;
          ui.catalog.costEdit = '';
          fx.drawer = true;
          render();
          var costEl = $('#cost-edit');
          if (costEl) costEl.focus();
          break;

        case 'menu-history':
          var histTr = el.closest('tr');
          ui.catalog.menu = null;
          ui.catalog.drawer = histTr ? histTr.getAttribute('data-sku') : null;
          fx.drawer = true;
          render();
          break;

        case 'menu-label':
          ui.catalog.menu = null;
          go('labels');
          break;

        case 'catalog-new':
          ui.catalog.formOpen = true;
          ui.catalog.form = { name: '', category: '', supplier: '', barcode: '', buyUnit: 'box', sellUnit: 'stick', unitsPerBuy: 25, buyCost: '' };
          render();
          var cNameEl = $('#np-name');
          if (cNameEl) cNameEl.focus();
          break;

        case 'catalog-form-cancel':
          ui.catalog.formOpen = false;
          ui.catalog.form = null;
          render();
          break;

        case 'export-selected':
          exportSelectedCsv();
          break;

        case 'clear-selected':
          ui.catalog.selected = {};
          render();
          break;

        case 'low-goto':
          ui.catalog.q = el.getAttribute('data-name') || '';
          ui.catalog.cat = 'all';
          ui.catalog.sup = 'all';
          if (ui.route === 'catalog') render(); else go('catalog');
          break;

        case 'apply-count': applyCount(); break;

        case 'counts-again':
          ui.counts.report = null;
          ui.counts.values = {};
          render();
          break;

        case 'export-dl': doExport(el.getAttribute('data-kind')); break;

        case 'print-labels': window.print(); break;

        case 'toggle-theme': toggleTheme(); break;
      }
    } catch (e) {
      toast(e && e.message ? e.message : 'That did not work.', 'err', 'ERROR');
    }
  }

  function onChange(ev) {
    var el = ev.target;
    var kind = el.getAttribute && el.getAttribute('data-change');
    if (!kind) return;
    try {
      switch (kind) {
        case 'set-user':
          Store.setUser(el.value);
          var u = Store.getUser();
          toast('Now working as ' + (u ? u.name + ' · ' + u.role : el.value) + '.', '', 'USER SWITCHED');
          render();
          break;

        case 'toggle-offline':
          if (el.checked) {
            Store.setOffline(true);
            toast('Connection is off. Receipts and transfers will queue and replay when you reconnect.', 'warn', 'OFFLINE');
          } else {
            var res = Store.setOffline(false);
            var applied = res ? countOf(res.applied) : 0;
            var failed = res ? countOf(res.failed) : 0;
            var msg = 'Back online.';
            if (applied) msg += ' ' + applied + ' queued event' + (applied === 1 ? '' : 's') + ' applied.';
            if (failed) msg += ' ' + failed + ' failed and need review.';
            if (!applied && !failed) msg += ' Nothing was waiting.';
            toast(msg, failed ? 'warn' : 'ok', 'LIVE');
          }
          render();
          break;

        case 'receive-loc': ui.receive.loc = el.value; render(); break;
        case 'counts-loc':
          ui.counts.loc = el.value;
          ui.counts.values = {};
          ui.counts.report = null;
          render();
          break;
        case 'tr-from': ui.transfer.from = el.value; render(); break;
        case 'tr-to': ui.transfer.to = el.value; render(); break;
        case 'ledger-loc': ui.ledger.loc = el.value; render(); break;
        case 'ledger-type': ui.ledger.type = el.value; render(); break;
        case 'cat-filter': ui.catalog.cat = el.value; render(); break;
        case 'sup-filter': ui.catalog.sup = el.value; render(); break;
      }
    } catch (e) {
      toast(e && e.message ? e.message : 'That did not work.', 'err', 'ERROR');
    }
  }

  function onInput(ev) {
    var el = ev.target;
    var kind = el.getAttribute && el.getAttribute('data-input');
    if (!kind) return;
    switch (kind) {
      case 'catalog-q':
        ui.catalog.q = el.value;
        render();
        break;
      case 'tr-q':
        ui.transfer.q = el.value;
        ui.transfer.sku = null;
        render();
        break;
      case 'tr-qty':
        ui.transfer.qty = Math.max(1, Math.floor(num(el.value, 1)));
        break;
      case 'count-row':
        ui.counts.values[el.getAttribute('data-sku')] = el.value;
        break;
      case 'np-field':
        var npForm = (ui.route === 'catalog') ? ui.catalog.form : ui.receive.form;
        if (npForm) npForm[el.getAttribute('data-field')] = el.value;
        break;
      case 'cost-edit':
        ui.catalog.costEdit = el.value;
        break;
    }
  }

  function onKeydown(ev) {
    var tag = ev.target && ev.target.tagName;
    var inField = /^(INPUT|SELECT|TEXTAREA)$/.test(tag || '');

    if (ev.key === 'Escape') {
      if (ui.catalog.menu) { ui.catalog.menu = null; render(); return; }
      if (ui.catalog.drawer) { ui.catalog.drawer = null; render(); return; }
      if (ev.target && ev.target.id === 'catalog-q') { ev.target.blur(); return; }
      return;
    }

    if (ev.key === '/' && !inField && ui.route === 'catalog') {
      ev.preventDefault();
      var cq = $('#catalog-q');
      if (cq) { cq.focus(); if (cq.select) cq.select(); }
      return;
    }

    if (ev.key !== 'Enter') return;
    var el = ev.target;
    var key = el.getAttribute && el.getAttribute('data-key');
    if (key === 'scan') {
      ev.preventDefault();
      var code = el.value;
      el.value = '';
      handleScan(code);
    } else if (key === 'tr-scan') {
      ev.preventDefault();
      // scanning into the transfer field: exact barcode or SKU selects instantly
      var hit = null;
      try { hit = Store.findByBarcode(el.value.trim()); } catch (e) { /* ignore */ }
      if (!hit) hit = productBySku(el.value.trim());
      if (hit) {
        ui.transfer.sku = hit.sku;
        ui.transfer.qty = 1;
        render();
      }
    }
  }

  function onSubmit(ev) {
    var form = ev.target;
    var kind = form.getAttribute && form.getAttribute('data-form');
    if (!kind) return;
    ev.preventDefault();
    try {
      if (kind === 'new-product') submitNewProduct(form);
      if (kind === 'update-cost') submitCostUpdate(form);
    } catch (e) {
      toast(e && e.message ? e.message : 'That did not work.', 'err', 'ERROR');
    }
  }

  /* ----------------------------------------------------------
     Actions
     ---------------------------------------------------------- */

  function handleScan(raw) {
    var code = String(raw || '').trim();
    if (!code) return;
    var p = null;
    try { p = Store.findByBarcode(code); } catch (e) { p = null; }
    if (!p) p = productBySku(code) || productBySku(code.toUpperCase());

    if (p) {
      addLine(p.sku);
      ui.receive.formOpen = false;
      ui.receive.unknownCode = null;
      if (ui.route !== 'receive') { go('receive'); return; }
      render();
    } else {
      ui.receive.unknownCode = code;
      ui.receive.assigned = null;
      ui.receive.formOpen = true;
      ui.receive.form = { name: '', category: '', supplier: '', barcode: code, buyUnit: 'box', sellUnit: 'stick', unitsPerBuy: 25, buyCost: '' };
      if (ui.route !== 'receive') { go('receive'); return; }
      render();
      var nameEl = $('#np-name');
      if (nameEl) nameEl.focus();
    }
  }

  function addLine(sku) {
    var line = ui.receive.session.filter(function (l) { return l.sku === sku; })[0];
    if (line) {
      line.qty += 1;
    } else {
      ui.receive.session.unshift({ sku: sku, qty: 1 });
    }
    ui.receive.lastScan = sku;
    fx.scan = true;
  }

  function stepLine(sku, delta) {
    var line = ui.receive.session.filter(function (l) { return l.sku === sku; })[0];
    if (!line) return;
    line.qty = Math.max(1, line.qty + (delta || 0));
    ui.receive.lastScan = null;
    render();
  }

  function removeLine(sku) {
    ui.receive.session = ui.receive.session.filter(function (l) { return l.sku !== sku; });
    ui.receive.lastScan = null;
    render();
  }

  function postReceipt() {
    var r = ui.receive;
    if (!r.loc || !r.session.length) return;
    var applied = 0, queued = 0, units = 0;
    r.session.forEach(function (line) {
      var res = Store.receive(r.loc, line.sku, line.qty, author());
      units += line.qty;
      if (res && res.queued) queued += 1; else applied += 1;
    });
    var at = locName(r.loc);
    r.session = [];
    r.lastScan = null;
    r.assigned = null;
    if (queued && !applied) {
      toast(units + ' units queued for ' + at + '. They will post when the connection returns.', 'warn', 'QUEUED OFFLINE');
    } else if (queued) {
      toast(units + ' units posted or queued for ' + at + '.', 'warn', 'PARTIALLY QUEUED');
    } else {
      toast(units + ' units received at ' + at + ' and written to the ledger.', 'ok', 'RECEIPT POSTED');
    }
    render();
  }

  function submitNewProduct(form) {
    var fd = new FormData(form);
    var name = String(fd.get('name') || '').trim();
    if (!name) { toast('Give the product a name first.', 'warn', 'MISSING NAME'); return; }
    var payload = {
      name: name,
      category: String(fd.get('category') || '').trim(),
      supplier: String(fd.get('supplier') || '').trim(),
      barcode: String(fd.get('barcode') || '').trim(),
      buyUnit: String(fd.get('buyUnit') || 'box').trim(),
      sellUnit: String(fd.get('sellUnit') || 'stick').trim(),
      unitsPerBuy: Math.max(1, Math.floor(num(fd.get('unitsPerBuy'), 1))),
      buyCost: num(fd.get('buyCost'), 0)
    };
    var product = Store.addProduct(payload, author());

    if (form.getAttribute('data-ctx') === 'catalog') {
      // catalog path: add to the master list only, no stock received
      ui.catalog.formOpen = false;
      ui.catalog.form = null;
      if (product && product.isInternal) {
        toast('Internal SKU ' + product.sku + ' assigned to ' + product.name + '. Its label is ready to print.', 'ok', 'NEW PRODUCT');
      } else {
        toast(product.name + ' added to the catalog.', 'ok', 'NEW PRODUCT');
      }
      render();
      return;
    }

    ui.receive.formOpen = false;
    ui.receive.unknownCode = null;
    if (product && product.isInternal) {
      ui.receive.assigned = product.sku;
      toast('Internal SKU ' + product.sku + ' assigned to ' + product.name + '.', 'ok', 'NEW PRODUCT');
    } else {
      ui.receive.assigned = null;
      toast(product.name + ' added to the catalog.', 'ok', 'NEW PRODUCT');
    }
    addLine(product.sku);
    render();
  }

  function doTransfer() {
    var t = ui.transfer;
    if (!t.sku || !t.from || !t.to || t.from === t.to) return;
    var p = productBySku(t.sku);
    var qty = Math.max(1, Math.floor(num(t.qty, 1)));
    try {
      var res = Store.transfer(t.from, t.to, t.sku, qty, author());
      if (res && res.queued) {
        toast(qty + ' x ' + (p ? p.name : t.sku) + ' queued, ' + locName(t.from) + ' to ' + locName(t.to) + '.', 'warn', 'QUEUED OFFLINE');
      } else {
        toast(qty + ' x ' + (p ? p.name : t.sku) + ' moved, ' + locName(t.from) + ' to ' + locName(t.to) + '.', 'ok', 'TRANSFER DONE');
      }
      render();
    } catch (e) {
      if (e && /insufficient/i.test(e.message || '')) {
        var have = Store.qty(t.from, t.sku) || 0;
        toast('Not enough stock at ' + locName(t.from) + '. It holds ' + intFmt(have) +
          ', you asked for ' + intFmt(qty) + '.', 'err', 'INSUFFICIENT STOCK');
      } else {
        toast(e && e.message ? e.message : 'Transfer failed.', 'err', 'ERROR');
      }
    }
  }

  function submitCostUpdate(form) {
    var sku = form.getAttribute('data-sku');
    var val = num(ui.catalog.costEdit, NaN);
    var input = $('#cost-edit');
    if (input) val = num(input.value, NaN);
    if (isNaN(val) || val < 0) { toast('Enter a valid cost first.', 'warn', 'INVALID COST'); return; }
    var p = Store.updateCost(sku, val, author());
    ui.catalog.costEdit = '';
    toast('Cost on ' + (p ? p.name : sku) + ' updated to ' + money(val) + '. The old value stays in the history.', 'ok', 'COST UPDATED');
    render();
  }

  function applyCount() {
    var c = ui.counts;
    if (!c.loc) return;
    var sheet = Store.countSheet(c.loc) || [];
    if (!sheet.length) return;
    var lines = sheet.map(function (row) {
      var counted = Math.max(0, Math.floor(num(c.values[row.sku] != null ? c.values[row.sku] : row.expected, row.expected)));
      return { sku: row.sku, name: row.name, expected: row.expected, counted: counted, delta: counted - row.expected };
    });
    var result = Store.applyCount(c.loc, lines.map(function (l) { return { sku: l.sku, counted: l.counted }; }), author());
    var nAdj = result ? countOf(result.adjustments) : lines.filter(function (l) { return l.delta !== 0; }).length;
    c.report = { loc: c.loc, lines: lines };
    c.values = {};
    if (nAdj === 0) {
      toast('Count matched the system exactly. Nothing to adjust.', 'ok', 'COUNT CLEAN');
    } else {
      toast(nAdj + ' adjustment' + (nAdj === 1 ? '' : 's') + ' written to the ledger at ' + locName(c.loc) + '.', 'warn', 'COUNT APPLIED');
    }
    render();
  }

  function doExport(kind) {
    var csv = '';
    try { csv = Store.exportCSV(kind) || ''; } catch (e) { csv = ''; }
    if (!csv) { toast('Nothing to export yet.', 'warn', 'EMPTY'); return; }
    var d = new Date();
    var stamp = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
    downloadText('davidoff-' + kind + '-' + stamp + '.csv', csv);
    toast('CSV downloaded: ' + kind + '.', 'ok', 'EXPORT');
  }

  /* ----------------------------------------------------------
     Camera scan (BarcodeDetector, optional, fails silently)
     ---------------------------------------------------------- */

  function startCamera() {
    if (!('BarcodeDetector' in window) || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      cameraFail();
      return;
    }
    var overlay = $('#camera-overlay');
    var video = $('#camera-video');
    if (!overlay || !video) { cameraFail(); return; }

    var detector;
    try {
      detector = new window.BarcodeDetector({
        formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_39', 'code_128']
      });
    } catch (e) {
      try { detector = new window.BarcodeDetector(); } catch (e2) { cameraFail(); return; }
    }

    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(function (stream) {
        camera.stream = stream;
        video.srcObject = stream;
        overlay.hidden = false;
        return video.play();
      })
      .then(function () {
        camera.timer = setInterval(function () {
          if (!camera.stream) return;
          detector.detect(video).then(function (codes) {
            if (codes && codes.length && codes[0].rawValue) {
              var value = codes[0].rawValue;
              stopCamera();
              handleScan(value);
            }
          }).catch(function () { cameraFail(); });
        }, 350);
      })
      .catch(function () { cameraFail(); });
  }

  function stopCamera() {
    if (camera.timer) { clearInterval(camera.timer); camera.timer = null; }
    if (camera.stream) {
      try {
        camera.stream.getTracks().forEach(function (t) { t.stop(); });
      } catch (e) { /* ignore */ }
      camera.stream = null;
    }
    var overlay = $('#camera-overlay');
    var video = $('#camera-video');
    if (video) video.srcObject = null;
    if (overlay) overlay.hidden = true;
  }

  function cameraFail() {
    stopCamera();
    if (!ui.cameraFailed) {
      ui.cameraFailed = true;
      toast('Camera scanning is not available here. Use the scan field or the simulator.', 'warn', 'CAMERA');
      render();
    }
  }

})();
