/**
 * Geohex payments on the SF isometric map.
 * Drop into SoMaCoSF/sf-isometric-demo as geohex-pay.js
 * Each quadrant's manifest lat/lon is assigned the REAL GeoHex cell that
 * contains it (geohex.js, gyst-hex 0x340, layer 3, SF anchor v0 candidate);
 * instruments fence to that cell's UUID. The legacy string form below is a
 * fallback for if the cell layer ever fails to load — it is not a GeoHex cell.
 */
(function () {
  'use strict';

  function stableStringify(obj) {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
    var keys = Object.keys(obj).sort();
    return '{' + keys.map(function (k) {
      return JSON.stringify(k) + ':' + stableStringify(obj[k]);
    }).join(',') + '}';
  }

  function syncHash(str) {
    var h1 = 0x811c9dc5 >>> 0;
    var h2 = 0x811c9dc5 >>> 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      h1 ^= c;
      h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 ^= c + i;
      h2 = Math.imul(h2, 0x01000193) >>> 0;
    }
    var out = '';
    var a = h1, b = h2;
    for (var n = 0; n < 4; n++) {
      a = Math.imul(a ^ (a >>> 16), 0x45d9f3b) >>> 0;
      b = Math.imul(b ^ (b >>> 13), 0x119de1f3) >>> 0;
      out += (a >>> 0).toString(16).padStart(8, '0');
      out += (b >>> 0).toString(16).padStart(8, '0');
      a ^= b; b ^= a;
    }
    return out.slice(0, 32);
  }

  function mint(typeCode, opts) {
    opts = opts || {};
    var material = {
      type: typeCode,
      parent: opts.parent || null,
      counterparty: opts.counterparty || null,
      amountCap: opts.amountCap != null ? String(opts.amountCap) : null,
      geo: opts.geo || null,
      escrowRequired: !!opts.escrowRequired,
      seed: opts.seed || null,
    };
    return 'gyst-pay-' + typeCode.toString(16).padStart(3, '0') + '-' + syncHash(stableStringify(material));
  }

  function classify(input) {
    input = input || {};
    if (input.explicit === true) return { escrowRequired: true, reason: 'explicit flag' };
    if (input.explicit === false) return { escrowRequired: false, reason: 'explicit opt-out' };
    var cls = input.cls || 'unknown';
    if (cls === 'api_micro' || cls === 'transfer_internal') {
      return { escrowRequired: false, reason: 'class ' + cls + ' instant-final' };
    }
    if (cls === 'goods_physical' || cls === 'services' || cls === 'betting') {
      return { escrowRequired: true, reason: 'class ' + cls + ' is escrow-native' };
    }
    return { escrowRequired: true, reason: 'default escrow-native' };
  }

  function locationAllowed(constraint, location) {
    if (!constraint || !constraint.cell) return { allowed: true, reason: 'no geo constraint' };
    if (!location || !location.cell) return { allowed: false, reason: 'no location provided' };
    if (location.cell !== constraint.cell) {
      return {
        allowed: false,
        reason: 'spend cell ' + location.cell + ' ≠ instrument cell ' + constraint.cell,
      };
    }
    return { allowed: true, reason: 'location matches geo constraint' };
  }

  function cellId(qx, qy, lat, lon) {
    if (window.GeoHexCell) {
      var p = (lat != null && lon != null) ? { lat: lat, lon: lon } : GeoHexCell.latLonForQuadrant(qx, qy);
      if (p) {
        var ref = GeoHexCell.cellForLatLon(p.lat, p.lon);
        return GeoHexCell.cellUuid(ref.q, ref.r, ref.layer);
      }
    }
    return 'geohex:sf:iso:' + qx + '_' + qy;
  }

  var QUAD = 512;
  var pins = [];
  var payMode = false;
  var overlay = null;
  var originX = 0;
  var originY = 0;

  function ensureOverlay() {
    var stage = document.getElementById('map-stage');
    if (!stage) return null;
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'geohex-pay-overlay';
      overlay.className = 'geohex-pay-overlay';
      stage.appendChild(overlay);
    }
    return overlay;
  }

  function pinEl(status) {
    var el = document.createElement('div');
    el.className = 'geohex-pin geohex-pin--' + status;
    el.title = status;
    return el;
  }

  function placePin(pin) {
    var layer = ensureOverlay();
    if (!layer) return;
    if (pin.el && pin.el.parentNode) pin.el.parentNode.removeChild(pin.el);
    pin.el = pinEl(pin.status);
    pin.el.style.left = (pin.qx - originX) * QUAD + QUAD / 2 + 'px';
    pin.el.style.top = (pin.qy - originY) * QUAD + QUAD / 2 + 'px';
    layer.appendChild(pin.el);
    pin.el.addEventListener('click', function (e) {
      e.stopPropagation();
      showDetail(pin);
    });
  }

  function mintOnQuadrant(qx, qy, opts) {
    opts = opts || {};
    var cell = cellId(qx, qy, opts.lat, opts.lon);
    var amountCents = opts.amountCents != null ? opts.amountCents : 1500 + ((qx * 13 + qy * 7) % 8500);
    var spendCell = opts.spendCell != null ? opts.spendCell : cell;
    var cls = opts.cls || (opts.escrow ? 'goods_physical' : 'api_micro');

    var wallet = mint(0x400, { seed: 'iso-wallet' });
    var sub = mint(0x401, { parent: wallet, counterparty: cell, seed: 'iso-sub-' + cell });
    var classification = classify({
      cls: cls,
      amount: amountCents / 100,
      explicit: opts.escrow === true ? true : opts.escrow === false ? false : undefined,
    });
    var tx = mint(0x402, {
      parent: sub,
      amountCap: amountCents,
      counterparty: cell,
      geo: cell,
      escrowRequired: classification.escrowRequired,
      seed: 'iso-tx-' + cell + '-' + amountCents,
    });
    var escrowUuid = null;
    if (classification.escrowRequired) {
      escrowUuid = mint(0x403, { parent: tx, seed: 'iso-esc-' + cell });
    }
    var geo = locationAllowed({ cell: cell }, { cell: spendCell });
    var status = 'fenced';
    var settlement = null;
    if (!geo.allowed) status = 'denied';
    else if (escrowUuid) status = 'escrow';
    else {
      status = 'settled';
      settlement = mint(0x409, { parent: tx, seed: 'iso-set-' + cell });
    }

    var tree = {
      wallet: wallet,
      subwallet: sub,
      transaction: tx,
      escrow: escrowUuid,
      settlement: settlement,
      geoCell: cell,
      spendCell: spendCell,
      amountCents: amountCents,
      classification: classification,
      geo: geo,
    };

    pins = pins.filter(function (p) {
      if (p.qx === qx && p.qy === qy) {
        if (p.el && p.el.parentNode) p.el.parentNode.removeChild(p.el);
        return false;
      }
      return true;
    });
    var pin = { qx: qx, qy: qy, status: status, tree: tree, amountCents: amountCents, cell: cell };
    pins.push(pin);
    placePin(pin);
    showDetail(pin);
    renderList();
    return pin;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');
  }

  function showDetail(pin) {
    var el = document.getElementById('pay-detail');
    if (!el) return;
    var t = pin.tree;
    var dec = (window.GeoHexCell && GeoHexCell.decodeCell(pin.cell)) || null;
    el.innerHTML =
      '<div class="pay-status pay-status--' + pin.status + '">' + pin.status + '</div>' +
      '<div class="pay-line"><span>geohex cell</span> <code>' + escapeHtml(pin.cell) + '</code></div>' +
      (dec ? '<div class="pay-line"><span>decode</span> q ' + dec.q + ' · r ' + dec.r + ' · layer ' + dec.layer + ' · type 0x340 (from the UUID alone)</div>' : '') +
      '<div class="pay-line"><span>amount</span> $' + (pin.amountCents / 100).toFixed(2) + '</div>' +
      '<div class="pay-line"><span>wallet</span> <code>' + escapeHtml(t.wallet) + '</code></div>' +
      '<div class="pay-line"><span>tx</span> <code>' + escapeHtml(t.transaction) + '</code></div>' +
      (t.escrow ? '<div class="pay-line"><span>escrow</span> <code>' + escapeHtml(t.escrow) + '</code></div>' : '') +
      (t.settlement ? '<div class="pay-line"><span>settle</span> <code>' + escapeHtml(t.settlement) + '</code></div>' : '') +
      '<div class="pay-line"><span>class</span> ' + escapeHtml(t.classification.reason) + '</div>' +
      '<div class="pay-line"><span>geo</span> ' + escapeHtml(t.geo.reason) + '</div>';
  }

  function renderList() {
    var list = document.getElementById('pay-list');
    if (!list) return;
    list.innerHTML = '';
    pins.slice().reverse().forEach(function (p) {
      var li = document.createElement('li');
      li.className = 'pay-list-item';
      li.innerHTML =
        '<span class="pay-status pay-status--' + p.status + '">' + p.status + '</span> $' +
        (p.amountCents / 100).toFixed(2) + ' · q ' + p.qx + ',' + p.qy;
      li.addEventListener('click', function () { showDetail(p); });
      list.appendChild(li);
    });
  }

  function setPayMode(on) {
    payMode = !!on;
    document.body.classList.toggle('pay-mode', payMode);
    var btn = document.getElementById('pay-mode-toggle');
    if (btn) {
      btn.setAttribute('aria-pressed', payMode ? 'true' : 'false');
      btn.textContent = payMode ? 'Pay mode ON — click a quadrant' : 'Pay mode';
    }
  }

  function runDemoSuite() {
    if (!window.__isoMap || window.__isoMap.originX == null) {
      console.warn('geohex-pay: map not ready');
      return;
    }
    originX = window.__isoMap.originX;
    originY = window.__isoMap.originY;
    var samples = [
      { qx: originX + 18, qy: originY + 6, opts: { amountCents: 4200, cls: 'api_micro' } },
      { qx: originX + 20, qy: originY + 6, opts: { amountCents: 12800, cls: 'goods_physical', escrow: true } },
      { qx: originX + 22, qy: originY + 5, opts: { amountCents: 1900, cls: 'api_micro' } },
      {
        qx: originX + 19,
        qy: originY + 8,
        opts: {
          amountCents: 5500,
          cls: 'goods_physical',
          spendCell: cellId(originX + 22, originY + 5),
        },
      },
    ];
    samples.forEach(function (s) { mintOnQuadrant(s.qx, s.qy, s.opts); });
  }

  function clearPins() {
    pins.forEach(function (p) {
      if (p.el && p.el.parentNode) p.el.parentNode.removeChild(p.el);
    });
    pins = [];
    renderList();
    var el = document.getElementById('pay-detail');
    if (el) el.innerHTML = '<p class="pay-muted">No instrument selected.</p>';
  }

  function onMapReady(info) {
    originX = info.originX;
    originY = info.originY;
    ensureOverlay();
  }

  function onQuadrantActivate(qx, qy, event, tile) {
    if (!payMode && !(event && event.shiftKey)) return false;
    mintOnQuadrant(qx, qy, { lat: tile && tile.lat, lon: tile && tile.lon });
    return true;
  }

  function injectPanel() {
    if (document.getElementById('geohex-pay-panel')) return;
    var panel = document.createElement('aside');
    panel.id = 'geohex-pay-panel';
    panel.className = 'geohex-pay-panel';
    panel.innerHTML =
      '<div class="pay-panel-head">' +
      '  <strong>Geohex payments</strong>' +
      '  <span class="pay-badge">demo · no funds</span>' +
      '</div>' +
      '<p class="pay-muted">Each quadrant carries a lat/lon in the manifest. The GeoHex cell containing it (gyst-hex 0x340, layer 3, SF anchor v0 — CANDIDATE, not ratified) is its spend cell. Disposable payment UUIDs, geo-fenced to that cell UUID.</p>' +
      '<div class="pay-actions">' +
      '  <button type="button" id="pay-mode-toggle" aria-pressed="false">Pay mode</button>' +
      '  <button type="button" id="pay-run-suite" class="secondary">Run suite</button>' +
      '  <button type="button" id="pay-clear" class="secondary">Clear</button>' +
      '</div>' +
      '<p class="pay-muted pay-hint">Pay mode ON or Shift+click a quadrant to mint.</p>' +
      '<h3>Selected</h3>' +
      '<div id="pay-detail"><p class="pay-muted">No instrument selected.</p></div>' +
      '<h3>Pins</h3>' +
      '<ul id="pay-list" class="pay-list"></ul>' +
      '<p class="pay-foot"><a href="https://pay.somacosf.com/">pay.somacosf.com</a> · SoMaCo Protocol</p>';
    document.body.appendChild(panel);
    document.getElementById('pay-mode-toggle').addEventListener('click', function () { setPayMode(!payMode); });
    document.getElementById('pay-run-suite').addEventListener('click', runDemoSuite);
    document.getElementById('pay-clear').addEventListener('click', clearPins);
  }

  window.GeohexPay = {
    onMapReady: onMapReady,
    onQuadrantActivate: onQuadrantActivate,
    mintOnQuadrant: mintOnQuadrant,
    setPayMode: setPayMode,
    runDemoSuite: runDemoSuite,
    cellId: cellId,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectPanel);
  } else {
    injectPanel();
  }
})();
