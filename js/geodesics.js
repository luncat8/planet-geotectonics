/* geodesics.js - icosahedral dual-hex grid generation (pure mesh math, no WebGL) */
var PLANET_R = 6.371e6;

/* Grid(level, seed, opts)
   opts carries the ocean-geometry parameters needed to build the static
   per-cell bathymetry field (uCellC). Defaults reproduce the legacy flat slab
   so an omitted opts is always safe. */
function Grid(level, seed, opts) {
  this.level = level;
  this.seed = seed === undefined ? 12345 : seed;
  var o = opts || {};
  this.opt = {
    /* Fallback only: a bare `new Grid(level)` with no options gets the legacy
       flat slab, so the module keeps its pre-refactor standalone behaviour.
       The app never relies on this -- engine.js always passes params.bathyMode
       through, whose schema default in params.js is 1 (procedural). */
    radius:     o.radius     === undefined ? PLANET_R : o.radius,
    bathyMode:  o.bathyMode  === undefined ? 0     : o.bathyMode,
    hTotal:     o.hTotal     === undefined ? 1000  : o.hTotal,
    hTop:       o.hTop       === undefined ? 60    : o.hTop,
    depthMax:   o.depthMax   === undefined ? 4000  : o.depthMax,
    shelfWidth: o.shelfWidth === undefined ? 250e3 : o.shelfWidth,
    bathyRough: o.bathyRough === undefined ? 0.35  : o.bathyRough,
    dShelf:     o.dShelf     === undefined ? 200   : o.dShelf,
  };
}

Grid.mulberry32 = function (a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

Grid.norm = function (v) {
  var l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
Grid.cross = function (a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
Grid.dot = function (a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
Grid.sub = function (a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }

Grid.prototype.build = function () {
  var level = this.level, seed = this.seed;
  /* Physical radius (m). Drives cell area / edge length / spacing, so a
     different radius rescales every per-cell distance used by the dynamics.
     Defaults to PLANET_R (Earth) so existing behaviour is unchanged. */
  var R = this.opt.radius;
  var t = (1 + Math.sqrt(5)) / 2;
  var pos = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map(Grid.norm);

  var faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];

  for (var s = 0; s < level; s++) {
    var cache = new Map();
    var mid = function (a, b) {
      var key = a < b ? a * 1e7 + b : b * 1e7 + a;
      var hit = cache.get(key);
      if (hit !== undefined) return hit;
      var p2 = Grid.norm([
        pos[a][0] + pos[b][0],
        pos[a][1] + pos[b][1],
        pos[a][2] + pos[b][2],
      ]);
      var idx = pos.length;
      pos.push(p2);
      cache.set(key, idx);
      return idx;
    };
    var nf = [];
    for (var fi = 0; fi < faces.length; fi++) {
      var f = faces[fi];
      var ab = mid(f[0], f[1]), bc = mid(f[1], f[2]), ca = mid(f[2], f[0]);
      nf.push([f[0], ab, ca], [f[1], bc, ab], [f[2], ca, bc], [ab, bc, ca]);
    }
    faces = nf;
  }

  var V = pos.length;

  var nextMap = new Array(V);
  for (var i = 0; i < V; i++) nextMap[i] = new Map();
  for (var fi2 = 0; fi2 < faces.length; fi2++) {
    var f2 = faces[fi2];
    nextMap[f2[0]].set(f2[1], f2[2]);
    nextMap[f2[1]].set(f2[2], f2[0]);
    nextMap[f2[2]].set(f2[0], f2[1]);
  }

  var rings = new Array(V);
  for (var i2 = 0; i2 < V; i2++) {
    var m = nextMap[i2];
    var start = m.keys().next().value;
    var ring = [start];
    var cur = start;
    for (var g = 0; g < 8; g++) {
      var nx = m.get(cur);
      if (nx === start) break;
      ring.push(nx);
      cur = nx;
    }
    rings[i2] = ring;
  }

  var rnd = Grid.mulberry32(seed);
  var OCT = 9;
  var dirs = [], freqs = [], phs = [], amps = [];
  for (var o = 0; o < OCT; o++) {
    var z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    dirs.push([r * Math.cos(a), z, r * Math.sin(a)]);
    var fr = 1.3 * Math.pow(1.75, o);
    freqs.push(fr);
    phs.push(rnd() * 6.2831853);
    amps.push(1 / Math.pow(fr, 0.85));
  }
  var height = new Float32Array(V);
  for (var i3 = 0; i3 < V; i3++) {
    var h = 0;
    for (var o2 = 0; o2 < OCT; o2++) {
      h += amps[o2] * Math.sin(freqs[o2] * Grid.dot(dirs[o2], pos[i3]) + phs[o2]);
    }
    height[i3] = h;
  }
  var sorted = Float32Array.from(height).sort();
  var thr = sorted[Math.floor(sorted.length * 0.7)];
  var span = (sorted[sorted.length - 1] - sorted[0]) * 0.045 + 1e-6;
  var land = new Float32Array(V);
  var landCount = 0;
  for (var i4 = 0; i4 < V; i4++) {
    var x = (height[i4] - thr) / span;
    var sm = Math.min(1, Math.max(0, x));
    land[i4] = sm * sm * (3 - 2 * sm);
    if (land[i4] > 0.5) landCount++;
  }

  var W = 256;
  var H = Math.ceil(V / W);
  var cellA = new Float32Array(W * H * 4);
  var cellB = new Float32Array(W * H * 4);
  var nbrA = new Float32Array(W * H * 6 * 4);
  var nbrB = new Float32Array(W * H * 6 * 4);

  var AXIS = [0, 1, 0];
  var e1s = new Array(V), e2s = new Array(V);
  for (var i5 = 0; i5 < V; i5++) {
    var n = pos[i5];
    var e1 = Grid.cross(n, AXIS);
    if (Math.hypot(e1[0], e1[1], e1[2]) < 1e-7) e1 = [1, 0, 0];
    e1 = Grid.norm(e1);
    var e2 = Grid.cross(e1, n);
    e1s[i5] = e1;
    e2s[i5] = e2;
  }

  var neighbourIdx = rings;

  for (var i6 = 0; i6 < V; i6++) {
    var nn = pos[i6];
    var e1n = e1s[i6], e2n = e2s[i6];
    var ringn = neighbourIdx[i6];
    var mm = ringn.length;

    var duals = [];
    for (var k = 0; k < mm; k++) {
      var a0 = pos[ringn[k]], b0 = pos[ringn[(k + 1) % mm]];
      duals.push(Grid.norm([nn[0] + a0[0] + b0[0], nn[1] + a0[1] + b0[1], nn[2] + a0[2] + b0[2]]));
    }
    var area = 0;
    for (var k2 = 0; k2 < mm; k2++) {
      var p = Grid.sub(duals[k2], nn), q = Grid.sub(duals[(k2 + 1) % mm], nn);
      var c = Grid.cross(p, q);
      area += 0.5 * Math.hypot(c[0], c[1], c[2]);
    }
    area *= R * R;

    cellA[i6 * 4 + 0] = nn[0];
    cellA[i6 * 4 + 1] = nn[1];
    cellA[i6 * 4 + 2] = nn[2];
    cellA[i6 * 4 + 3] = area;
    cellB[i6 * 4 + 0] = e1n[0];
    cellB[i6 * 4 + 1] = e1n[1];
    cellB[i6 * 4 + 2] = e1n[2];
    cellB[i6 * 4 + 3] = land[i6];

    for (var k3 = 0; k3 < 6; k3++) {
      var base = (i6 + k3 * W * H) * 4;
      if (k3 >= mm) {
        nbrA[base + 3] = 0;
        continue;
      }
      var j = ringn[k3];
      var d0 = duals[(k3 - 1 + mm) % mm], d1 = duals[k3];
      var ev = Grid.sub(d1, d0);
      var len = Math.hypot(ev[0], ev[1], ev[2]) * R;
      var dist = Math.acos(Math.max(-1, Math.min(1, Grid.dot(nn, pos[j])))) * R;

      var pj = pos[j];
      var dp = Grid.dot(pj, nn);
      var tv = [pj[0] - nn[0] * dp, pj[1] - nn[1] * dp, pj[2] - nn[2] * dp];
      tv = Grid.norm(tv);
      var nx = Grid.dot(tv, e1n), ny = Grid.dot(tv, e2n);

      var ej = e1s[j];
      var dpe = Grid.dot(ej, nn);
      var te = [ej[0] - nn[0] * dpe, ej[1] - nn[1] * dpe, ej[2] - nn[2] * dpe];
      te = Grid.norm(te);
      var rotA = Grid.dot(te, e1n), rotB = Grid.dot(te, e2n);

      nbrA[base + 0] = j;
      nbrA[base + 1] = len;
      nbrA[base + 2] = Math.max(dist, 1.0);
      nbrA[base + 3] = 1;
      nbrB[base + 0] = nx;
      nbrB[base + 1] = ny;
      nbrB[base + 2] = rotA;
      nbrB[base + 3] = rotB;
    }
  }

  var indices = new Uint32Array(faces.length * 3);
  for (var f3 = 0; f3 < faces.length; f3++) {
    indices[f3 * 3 + 0] = faces[f3][0];
    indices[f3 * 3 + 1] = faces[f3][1];
    indices[f3 * 3 + 2] = faces[f3][2];
  }

  var lookupW = 1024, lookupH = 512;
  var lookup = new Float32Array(lookupW * lookupH);
  var guess = 0;
  for (var y = 0; y < lookupH; y++) {
    var lat = ((y + 0.5) / lookupH - 0.5) * Math.PI;
    var rowGuess = guess;
    for (var x2 = 0; x2 < lookupW; x2++) {
      var lon = ((x2 + 0.5) / lookupW - 0.5) * Math.PI * 2;
      var d3 = [
        Math.cos(lat) * Math.cos(lon),
        Math.sin(lat),
        Math.cos(lat) * Math.sin(lon),
      ];
      var cur2 = rowGuess;
      var best = Grid.dot(pos[cur2], d3);
      for (var it = 0; it < 256; it++) {
        var moved = false;
        var ringc = neighbourIdx[cur2];
        for (var kk = 0; kk < ringc.length; kk++) {
          var cand = ringc[kk];
          var ss = Grid.dot(pos[cand], d3);
          if (ss > best) { best = ss; cur2 = cand; moved = true; }
        }
        if (!moved) break;
      }
      lookup[y * lookupW + x2] = cur2;
      rowGuess = cur2;
      if (x2 === 0) guess = cur2;
    }
  }

  /* ===================================================================
     STATIC PER-CELL OCEAN GEOMETRY  ->  uCellC = (D, hRef, bedElev, coastDist)

     D         total ocean depth at this cell (m)
     hRef      reference/undisturbed top-layer thickness (m). The dynamic
               PGF uses eta = hTop - hRef so that resting bathymetry produces
               NO pressure gradient; see the sigma-coordinate note in PLAN.md.
     bedElev   solid-surface elevation (m): >0 on land, -D in the ocean.
     coastDist distance to the nearest land cell (m).
     =================================================================== */
  var opt = this.opt;

  /* --- distance to coast: multi-source label-correcting shortest path over
         the dual-hex adjacency. O(V) in practice, exact great-circle cost. */
  var coastDist = new Float32Array(V);
  var INF = 1e20;
  var queue = new Int32Array(V * 8), qHead = 0, qTail = 0;
  var inQ = new Uint8Array(V);
  for (var ci = 0; ci < V; ci++) {
    if (land[ci] > 0.5) { coastDist[ci] = 0; queue[qTail++] = ci; inQ[ci] = 1; }
    else coastDist[ci] = INF;
  }
  /* An all-ocean world has no sources: leave every distance saturated so the
     profile degenerates to a uniform abyssal plain instead of dividing by 0. */
  if (qTail === 0) { for (var cj = 0; cj < V; cj++) coastDist[cj] = opt.shelfWidth * 4 + 1; }
  while (qHead < qTail) {
    var cu = queue[qHead++]; inQ[cu] = 0;
    if (qHead > V * 4) { /* compact the ring buffer */
      var rem = qTail - qHead;
      queue.copyWithin(0, qHead, qTail); qHead = 0; qTail = rem;
    }
    var ringU = rings[cu], du = coastDist[cu];
    for (var ri = 0; ri < ringU.length; ri++) {
      var cv = ringU[ri];
      var dotUV = Math.min(1, Math.max(-1, Grid.dot(pos[cu], pos[cv])));
      var w = R * Math.acos(dotUV);
      if (du + w < coastDist[cv] - 1e-3) {
        coastDist[cv] = du + w;
        if (!inQ[cv]) {
          if (qTail >= queue.length) { queue.copyWithin(0, qHead, qTail); qTail -= qHead; qHead = 0; }
          queue[qTail++] = cv; inQ[cv] = 1;
        }
      }
    }
  }

  /* --- rank-normalise the fbm terrain so roughness is resolution- and
         seed-independent (`sorted` is already the ascending height array). */
  function heightRank(h) {
    var lo = 0, hi = sorted.length - 1;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (sorted[mid] < h) lo = mid + 1; else hi = mid; }
    return sorted.length > 1 ? lo / (sorted.length - 1) : 0.5;
  }

  var cellC = new Float32Array(W * H * 4);
  var minDepth = Math.max(5, opt.dShelf * 0.15);

  /* The shelf must be RESOLVABLE. Mean cell spacing at level 5 is ~220 km, so
     a nominal 250 km shelf would be crossed in a single cell and the shallow
     water would vanish entirely (measured: min depth 3370 m, i.e. no shelf at
     all). Three corrections:
       - measure distance from the coastLINE, not from the land cell CENTRE,
         by crediting half a cell spacing;
       - model a near-flat SHELF plateau (~dShelf) ending at a steep SLOPE
         down to the abyss, which is both the real shape of a margin and far
         more robust than one long smooth ramp;
       - floor the plateau at ~0.9 spacings so the first wet ring always lands
         on the shelf instead of being swallowed by the slope. */
  var spacing = Math.sqrt(4 * Math.PI * R * R / V);
  var shelfW = Math.max(opt.shelfWidth, 0.9 * spacing);   // flat shelf
  var slopeW = Math.max(opt.shelfWidth, 1.5 * spacing);   // shelf-break slope
  for (var i9 = 0; i9 < V; i9++) {
    var D, hRef, bed;
    var rank = heightRank(height[i9]);          // 0..1, 0.7+ is land
    if (opt.bathyMode === 0) {
      /* Legacy flat slab -- bit-for-bit the pre-refactor ocean. */
      D = opt.hTotal;
      hRef = opt.hTop;
      bed = -opt.hTotal;
    } else {
      /* shelf -> slope -> abyss ramp driven by distance from land */
      var edgeDist = Math.max(0, coastDist[i9] - 0.5 * spacing);
      /* flat shelf out to shelfW, then slope over slopeW to the abyss */
      var t = Math.min(1, Math.max(0, (edgeDist - shelfW) / slopeW));
      t = t * t * (3 - 2 * t);                                    // smoothstep
      D = opt.dShelf + (opt.depthMax - opt.dShelf) * t;
      /* Ridges/trenches: reuse the terrain fbm, centred so the mean depth is
         preserved, and scaled by t so coastlines stay shallow. */
      D *= 1 + opt.bathyRough * (2 * rank - 1) * 0.45 * t;
      D = Math.min(opt.depthMax * 1.25, Math.max(minDepth, D));
      /* Top layer cannot claim more than ~40% of a shallow column. */
      hRef = Math.min(opt.hTop, 0.4 * D);
      bed = -D;
    }
    if (land[i9] > 0.5) {
      /* Land: report a real elevation for shading/relief instead of the old
         binary uRelief*land step. Depth is kept finite so any clamp that
         touches a dry cell still sees a sane range. */
      bed = (rank - 0.7) / 0.3 * 2500;
      D = Math.max(minDepth, opt.bathyMode === 0 ? opt.hTotal : opt.dShelf);
      hRef = Math.min(opt.hTop, 0.4 * D);
    }
    cellC[i9 * 4 + 0] = D;
    cellC[i9 * 4 + 1] = hRef;
    cellC[i9 * 4 + 2] = bed;
    cellC[i9 * 4 + 3] = coastDist[i9] === INF ? 0 : coastDist[i9];
  }

  /* Exact static invariant the runtime probe re-checks: total ocean volume. */
  var oceanVol = 0, oceanArea = 0;
  for (var i10 = 0; i10 < V; i10++) {
    if (land[i10] > 0.5) continue;
    oceanVol += cellC[i10 * 4] * cellA[i10 * 4 + 3];
    oceanArea += cellA[i10 * 4 + 3];
  }

  return {
    level: level, V: V, W: W, H: H, cellA: cellA, cellB: cellB, cellC: cellC,
    nbrA: nbrA, nbrB: nbrB, indices: indices,
    lookup: lookup, lookupW: lookupW, lookupH: lookupH,
    landFraction: landCount / V,
    oceanVolume: oceanVol, oceanArea: oceanArea,
  };
};
