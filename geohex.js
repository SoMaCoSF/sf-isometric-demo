/**
 * geohex.js — REAL GeoHex cells for the SF isometric map.
 *
 * What this is: every quadrant in map/manifest.json carries a lat/lon from
 * the map's own source data (an EXTERNAL position source, per the GeoHex
 * GPS Anchor Law — position never comes from the UUID). This module assigns
 * each quadrant the GeoHex cell (gyst-hex/1.0.0, type 0x340, ns 0x3e7) that
 * CONTAINS that lat/lon, and can decode the cell back from the UUID alone:
 * (q, r, layer, domain) at K0, no lookup.
 *
 * Anchor: SF_ANCHOR_V0_CANDIDATE — origin 37.785, -122.4; orientation 0°;
 * layer-0 cell size 1000 m, halved per layer; WGS84-G1762. Status:
 * CANDIDATE_NOT_RATIFIED. Positions and polygons are DERIVED from the
 * anchor + axial math (pointy-top layout, parity with the estate anchor
 * module ucsf_pm/src/lib/geohex/anchor.ts), cached never canonical.
 * Assignment layer: 3 (125 m centre-to-vertex; quadrant pitch measured
 * from the manifest is ~100 m N-S x ~200 m E-W).
 *
 * Bounds, stated plainly: the anchor is a candidate, so these are real
 * GeoHex cells under a candidate anchor — derivation-grade, not ratified
 * minting. If the founder ratifies a corrected anchor, every assignment
 * is re-derived from the manifest lat/lons; nothing here is stored as
 * canonical.
 *
 * The UUID encoder is a bit-exact port of the estate codec
 * (cad-ingest/hexuuid.py, itself a port of gyst-hex uuidv8): FNV-1a +
 * xmur3 tail, (q,r) int16 packing. Verified byte-for-byte against the
 * Python reference in the build harness.
 */
(function () {
  'use strict';

  var ANCHOR = Object.freeze({
    id: 'sf-anchor', version: 0,
    originLat: 37.785, originLon: -122.4,
    orientationDeg: 0, baseCellSizeM: 1000,
    datum: 'WGS84', epoch: 'WGS84-G1762',
    status: 'CANDIDATE_NOT_RATIFIED',
  });
  var LAYER = 3;
  var DOMAIN = 0xE;
  var PROVENANCE = 0x05;
  var CELL_TYPE = 0x340;
  var WORLD_NS = 0x3E7;
  var SQRT3 = Math.sqrt(3);
  var M_PER_DEG_LAT = 111320;

  /* --- gyst-hex codec (bit-exact port of hexuuid.py) ---------------------- */

  function fnv1a32(text) {
    var h = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function xmur3(seedText) {
    var h = (1779033703 ^ seedText.length) >>> 0;
    for (var i = 0; i < seedText.length; i++) {
      h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353) >>> 0;
      h = ((h << 13) | (h >>> 19)) >>> 0;
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507) >>> 0;
      h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
      h = (h ^ (h >>> 16)) >>> 0;
      return h;
    };
  }

  function random42FromSeed(seedText) {
    var next = xmur3(String(seedText));
    var a = next(), b = next();
    return ((BigInt(a) << 21n) | (BigInt(b) >> 11n)) & 0x3ffffffffffn;
  }

  function cellUuid(q, r, layer) {
    layer = (layer == null ? LAYER : layer) & 0xF;
    var q16 = q & 0xFFFF, r16 = r & 0xFFFF;
    var packed = (BigInt(q16) << 16n) | BigInt(r16);
    var ts = packed & 0xffffffn;
    var randHi = (packed >> 24n) & 0xffn;
    var tail = random42FromSeed('hexcell:' + q + ':' + r);
    var lowRand = (randHi << 34n) | (tail & 0x3ffffffffn);
    var fractal = BigInt(((layer & 0xF) << 8) | ((DOMAIN & 0xF) << 4));
    var high = (BigInt(CELL_TYPE) << 52n) | (BigInt(WORLD_NS) << 40n) |
               (ts << 16n) | (8n << 12n) | fractal;
    var sig = 0x8000n; // round(0.5 * 0xFFFF), as the reference codec
    var low = (2n << 62n) | (BigInt(PROVENANCE) << 58n) | (sig << 42n) | lowRand;
    var h = high.toString(16).padStart(16, '0');
    var l = low.toString(16).padStart(16, '0');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) +
           '-' + l.slice(0, 4) + '-' + l.slice(4);
  }

  function decodeCell(uuid) {
    var hx = String(uuid).replace(/-/g, '').toLowerCase();
    if (hx.length !== 32 || /[^0-9a-f]/.test(hx)) return null;
    var high = BigInt('0x' + hx.slice(0, 16));
    var low = BigInt('0x' + hx.slice(16, 32));
    var type = Number((high >> 52n) & 0xfffn);
    if (type !== CELL_TYPE) return null;
    var ts = Number((high >> 16n) & 0xffffffn);
    var fractal = Number(high & 0xfffn);
    var randHi = Number((low & 0x3ffffffffffn) >> 34n) & 0xFF;
    var packed = (ts | (randHi << 24)) >>> 0;
    function s16(v) { v &= 0xFFFF; return v & 0x8000 ? v - 0x10000 : v; }
    return {
      q: s16(packed >> 16), r: s16(packed & 0xFFFF),
      layer: (fractal >> 8) & 0xF, domain: (fractal >> 4) & 0xF,
      ns: Number((high >> 40n) & 0xfffn), type: type,
    };
  }

  /* --- anchor geometry (parity with anchor.ts, pointy-top) --------------- */

  function layerCellSizeM(layer) { return ANCHOR.baseCellSizeM / Math.pow(2, layer); }

  function latLonToMeters(lat, lon) {
    var cosLat = Math.cos(ANCHOR.originLat * Math.PI / 180);
    return {
      x: (lon - ANCHOR.originLon) * M_PER_DEG_LAT * cosLat,
      y: (lat - ANCHOR.originLat) * M_PER_DEG_LAT,
    };
  }

  function metersToLatLon(x, y) {
    var cosLat = Math.cos(ANCHOR.originLat * Math.PI / 180);
    return {
      lat: Math.round((ANCHOR.originLat + y / M_PER_DEG_LAT) * 1e7) / 1e7,
      lon: Math.round((ANCHOR.originLon + x / (M_PER_DEG_LAT * cosLat)) * 1e7) / 1e7,
    };
  }

  function axialRound(qf, rf) {
    var x = qf, z = rf, y = -x - z;
    var rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
    var dx = Math.abs(rx - x), dy = Math.abs(ry - y), dz = Math.abs(rz - z);
    if (dx > dy && dx > dz) rx = -ry - rz;
    else if (dy > dz) ry = -rx - rz;
    else rz = -rx - ry;
    return { q: rx, r: rz };
  }

  function cellForLatLon(lat, lon, layer) {
    layer = layer == null ? LAYER : layer;
    var size = layerCellSizeM(layer);
    var m = latLonToMeters(lat, lon);
    var qf = (SQRT3 / 3 * m.x - 1 / 3 * m.y) / size;
    var rf = (2 / 3 * m.y) / size;
    var cell = axialRound(qf, rf);
    return { q: cell.q, r: cell.r, layer: layer };
  }

  function cellCenterMeters(q, r, layer) {
    var size = layerCellSizeM(layer == null ? LAYER : layer);
    return { x: size * SQRT3 * (q + r / 2), y: size * 1.5 * r };
  }

  function centroidLatLon(q, r, layer) {
    var c = cellCenterMeters(q, r, layer);
    return metersToLatLon(c.x, c.y);
  }

  function polygonLatLon(q, r, layer) {
    layer = layer == null ? LAYER : layer;
    var size = layerCellSizeM(layer);
    var c = cellCenterMeters(q, r, layer);
    var pts = [];
    for (var i = 0; i < 6; i++) {
      var a = (60 * i - 30) * Math.PI / 180;
      pts.push(metersToLatLon(c.x + size * Math.cos(a), c.y + size * Math.sin(a)));
    }
    return pts;
  }

  function describe(lat, lon) {
    var ref = cellForLatLon(lat, lon);
    var uuid = cellUuid(ref.q, ref.r, ref.layer);
    var centroid = centroidLatLon(ref.q, ref.r, ref.layer);
    return {
      ref: ref, uuid: uuid, centroid: centroid,
      polygon: polygonLatLon(ref.q, ref.r, ref.layer),
      anchorStatus: ANCHOR.status,
      cellSizeM: layerCellSizeM(ref.layer),
      point: { lat: lat, lon: lon },
    };
  }

  /* --- manifest grid binding (stage projection + suite lookups) ---------- */

  var grid = null; // {byKey, latA, latB, lonC, lonD, bounds}
  function bindManifest(manifest) {
    var byKey = new Map();
    manifest.quadrants.forEach(function (q) { byKey.set(q.qx + '_' + q.qy, q); });
    var b = manifest.bounds;
    var nw = byKey.get(b.qx_min + '_' + b.qy_min);
    var se = byKey.get(b.qx_max + '_' + b.qy_max);
    grid = {
      byKey: byKey, bounds: b,
      latAtQxMin: nw.lat, dLatPerQx: (se.lat - nw.lat) / (b.qx_max - b.qx_min),
      lonAtQyMin: nw.lon, dLonPerQy: (se.lon - nw.lon) / (b.qy_max - b.qy_min),
    };
    return grid;
  }

  function latLonForQuadrant(qx, qy) {
    if (!grid) return null;
    var q = grid.byKey.get(qx + '_' + qy);
    if (q) return { lat: q.lat, lon: q.lon };
    return {
      lat: grid.latAtQxMin + (qx - grid.bounds.qx_min) * grid.dLatPerQx,
      lon: grid.lonAtQyMin + (qy - grid.bounds.qy_min) * grid.dLonPerQy,
    };
  }

  function stagePoint(lat, lon, originX, originY, quadPx) {
    if (!grid) return null;
    var fqx = grid.bounds.qx_min + (lat - grid.latAtQxMin) / grid.dLatPerQx;
    var fqy = grid.bounds.qy_min + (lon - grid.lonAtQyMin) / grid.dLonPerQy;
    return { x: (fqx - originX) * quadPx, y: (fqy - originY) * quadPx };
  }

  function assignmentSummary() {
    if (!grid) return null;
    var cells = new Map();
    grid.byKey.forEach(function (q) {
      var ref = cellForLatLon(q.lat, q.lon);
      var key = ref.q + ',' + ref.r;
      cells.set(key, (cells.get(key) || 0) + 1);
    });
    var shared = 0, maxShare = 0;
    cells.forEach(function (n) { if (n > 1) shared++; if (n > maxShare) maxShare = n; });
    return { quadrants: grid.byKey.size, distinctCells: cells.size, sharedCells: shared, maxQuadrantsPerCell: maxShare };
  }

  /* --- overlay + lightbox card (browser only) ----------------------------- */

  var svg = null;
  function ensureSvg(stage, originX, originY, quadPx) {
    if (svg || !stage || !grid) return svg;
    var w = (grid.bounds.qx_max - grid.bounds.qx_min + 1) * quadPx;
    var h = (grid.bounds.qy_max - grid.bounds.qy_min + 1) * quadPx;
    var ns = 'http://www.w3.org/2000/svg';
    svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'geohex-svg');
    svg.setAttribute('width', w); svg.setAttribute('height', h);
    svg.style.width = w + 'px'; svg.style.height = h + 'px';
    var poly = document.createElementNS(ns, 'polygon');
    poly.setAttribute('class', 'geohex-cell-poly');
    svg.appendChild(poly);
    stage.appendChild(svg);
    svg._poly = poly; svg._originX = originX; svg._originY = originY; svg._quad = quadPx;
    return svg;
  }

  function drawCell(desc) {
    var stage = document.getElementById('map-stage');
    var im = window.__isoMap;
    if (!stage || !im) return;
    var s = ensureSvg(stage, im.originX, im.originY, im.QUAD);
    if (!s) return;
    var pts = desc.polygon.map(function (p) {
      var sp = stagePoint(p.lat, p.lon, s._originX, s._originY, s._quad);
      return sp.x.toFixed(1) + ',' + sp.y.toFixed(1);
    }).join(' ');
    s._poly.setAttribute('points', pts);
  }

  function fmt(n, d) { return Number(n).toFixed(d == null ? 5 : d); }

  function showForTile(t) {
    var card = document.getElementById('lightbox-geohex');
    if (!t || t.lat == null || t.lon == null) { if (card) card.innerHTML = ''; return null; }
    var d = describe(t.lat, t.lon);
    drawCell(d);
    if (card) {
      card.innerHTML =
        '<div class="gh-title">GEOHEX CELL — this quadrant lies in it</div>' +
        '<div class="gh-uuid"><code>' + d.uuid + '</code></div>' +
        '<div class="gh-line">decodes alone (K0): q ' + d.ref.q + ' · r ' + d.ref.r +
        ' · layer ' + d.ref.layer + ' · domain 0xE · type 0x340</div>' +
        '<div class="gh-line">cell centroid ' + fmt(d.centroid.lat) + ', ' + fmt(d.centroid.lon) +
        ' · quadrant point ' + fmt(d.point.lat) + ', ' + fmt(d.point.lon) + '</div>' +
        '<div class="gh-line gh-bound">anchor SF_ANCHOR_V0_CANDIDATE (37.785, −122.4) — ' +
        'CANDIDATE, NOT RATIFIED · cell ' + d.cellSizeM + ' m · position from the manifest, never from the UUID</div>';
    }
    return d;
  }

  var api = {
    ANCHOR: ANCHOR, LAYER: LAYER, DOMAIN: DOMAIN,
    cellUuid: cellUuid, decodeCell: decodeCell,
    cellForLatLon: cellForLatLon, centroidLatLon: centroidLatLon,
    polygonLatLon: polygonLatLon, describe: describe,
    bindManifest: bindManifest, latLonForQuadrant: latLonForQuadrant,
    assignmentSummary: assignmentSummary, showForTile: showForTile, drawCell: drawCell,
    _cellCenterMeters: cellCenterMeters, _latLonToMeters: latLonToMeters,
    _fnv1a32: fnv1a32,
  };

  if (typeof window !== 'undefined') window.GeoHexCell = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
