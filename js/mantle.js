var MantleParams = typeof module !== 'undefined' && module.exports ? require('./params.js') : Params;
var Mantle = {
	rand: function (s) {
		var a = s.rng = (s.rng + 0x6d2b79f5) | 0;
		var t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	},
	// tm0 is the world's start temperature: 1 for a map start, TmHot for a hot start.
	Tm: function (t, tm0) {
		var p = MantleParams;
		return p.Tfloor + ((tm0 === undefined ? p.Tm0 : tm0) - p.Tfloor) * Math.exp(-t / p.tauCool);
	},
	hMafNew: function (Tm) {
		return 7000 * (1 + 1.5 * Math.max(0, Tm - 1));
	},
	precess: function (s) {
		var n = MantleParams.nWave, twoPi = Math.PI * 2;
		for (var w = 0; w < n; w++) {
			var a = w * 3, ang = twoPi * s.t / s.wavePeriod[w];
			var c = Math.cos(ang), sn = Math.sin(ang), d = 1 - c;
			var ox = s.waveDir0[a], oy = s.waveDir0[a + 1], oz = s.waveDir0[a + 2];
			var ax = s.waveAxis[a], ay = s.waveAxis[a + 1], az = s.waveAxis[a + 2];
			var along = ax * ox + ay * oy + az * oz;
			s.waveDir[a] = ox * c + (ay * oz - az * oy) * sn + ax * along * d;
			s.waveDir[a + 1] = oy * c + (az * ox - ax * oz) * sn + ay * along * d;
			s.waveDir[a + 2] = oz * c + (ax * oy - ay * ox) * sn + az * along * d;
		}
	},
	rawAt: function (s, x, y, z, out, o, phiOnly) {
		var p = MantleParams, ux = 0, uy = 0, uz = 0;
		for (var w = 0; w < p.nWave; w++) {
			if (phiOnly && w >= p.nPhi) continue;
			var a = w * 3, dx = s.waveDir[a], dy = s.waveDir[a + 1], dz = s.waveDir[a + 2];
			var dot = dx * x + dy * y + dz * z;
			var ampK = s.waveAmp[w] * s.waveFreq[w] * Math.cos(s.waveFreq[w] * dot + s.wavePhase[w]);
			if (w < p.nPhi) {
				ux += ampK * (dx - dot * x);
				uy += ampK * (dy - dot * y);
				uz += ampK * (dz - dot * z);
				continue;
			}
			ux += ampK * p.beta * (y * dz - z * dy);
			uy += ampK * p.beta * (z * dx - x * dz);
			uz += ampK * p.beta * (x * dy - y * dx);
		}
		out[o] = ux; out[o + 1] = uy; out[o + 2] = uz;
	},
	init: function (s) {
		var p = MantleParams, n = p.nWave;
		s.rng = (s.seed ^ 0xC6A4A793) >>> 0;
		s.Tm = Mantle.Tm(s.t, s.Tm0);
		for (var w = 0; w < n; w++) {
			var a = w * 3, y = Mantle.rand(s) * 2 - 1, th = Mantle.rand(s) * Math.PI * 2, r = Math.sqrt(1 - y * y);
			s.waveDir0[a] = r * Math.cos(th); s.waveDir0[a + 1] = y; s.waveDir0[a + 2] = r * Math.sin(th);
			var ay = Mantle.rand(s) * 2 - 1, ath = Mantle.rand(s) * Math.PI * 2, ar = Math.sqrt(1 - ay * ay);
			var ax = ar * Math.cos(ath), az = ar * Math.sin(ath);
			var along = ax * s.waveDir0[a] + ay * s.waveDir0[a + 1] + az * s.waveDir0[a + 2];
			ax -= along * s.waveDir0[a]; ay -= along * s.waveDir0[a + 1]; az -= along * s.waveDir0[a + 2];
			var al = Math.hypot(ax, ay, az) || 1;
			s.waveAxis[a] = ax / al; s.waveAxis[a + 1] = ay / al; s.waveAxis[a + 2] = az / al;
			s.wavePeriod[w] = 200 + Mantle.rand(s) * 300;
			s.waveFreq[w] = 2.1 * Math.pow(1.38, w % p.nPhi);
			s.wavePhase[w] = Mantle.rand(s) * Math.PI * 2;
			s.waveAmp[w] = 1 / s.waveFreq[w];
		}
		s.plumeCount = p.nPlume;
		for (var i = 0; i < p.nPlume; i++) Mantle.spawnPlume(s, i, 0);
		Mantle.precess(s);
		var scratch = s.scratch, sum = 0, g = s.grid;
		for (var c = 0; c < g.V; c++) {
			Mantle.rawAt(s, g.pos[c * 3], g.pos[c * 3 + 1], g.pos[c * 3 + 2], scratch, 0);
			sum += Math.hypot(scratch[0], scratch[1], scratch[2]);
		}
		s.mantleScale = sum > 0 ? g.V / sum : 1;
	},
	spawnPlume: function (s, i, birth) {
		var y = Mantle.rand(s) * 2 - 1, th = Mantle.rand(s) * Math.PI * 2, r = Math.sqrt(1 - y * y);
		s.plumePos[i * 3] = r * Math.cos(th); s.plumePos[i * 3 + 1] = y; s.plumePos[i * 3 + 2] = r * Math.sin(th);
		s.plumeBirth[i] = birth;
		s.plumeLife[i] = 50 + Mantle.rand(s) * 100;
		s.plumeStr[i] = 0.4 + Mantle.rand(s) * 0.8;
	},
	// Wave precession and plume respawn: the cheap, RNG-driven part of the mantle state. Both
	// CPU and GPU paths run this every frame; only the per-cell field fill differs.
	advance: function (s) {
		s.Tm = Mantle.Tm(s.t, s.Tm0);
		Mantle.precess(s);
		for (var i = 0; i < s.plumeCount; i++) {
			while (s.t >= s.plumeBirth[i] + s.plumeLife[i]) Mantle.spawnPlume(s, i, s.plumeBirth[i] + s.plumeLife[i]);
		}
		return MantleParams.U0 * Math.pow(s.Tm, 2.5);
	},
	update: function (s) {
		var p = MantleParams, g = s.grid, speed = Mantle.advance(s), scale = s.mantleScale * speed;
		var invSig = Math.pow(p.radius / p.plumeRad, 2);
		var scratch = s.scratch;
		for (var c = 0; c < g.V; c++) {
			var b = c * 3, x = g.pos[b], y = g.pos[b + 1], z = g.pos[b + 2];
			Mantle.rawAt(s, x, y, z, scratch, 0);
			var ux = scratch[0] * scale, uy = scratch[1] * scale, uz = scratch[2] * scale, heat = 0;
			for (var k = 0; k < s.plumeCount; k++) {
				var pb = k * 3, px = s.plumePos[pb], py = s.plumePos[pb + 1], pz = s.plumePos[pb + 2];
				var dot = Math.max(-1, Math.min(1, px * x + py * y + pz * z));
				var h = s.plumeStr[k] * s.Tm * Math.exp(-(1 - dot) * invSig);
				heat += h;
				var tx = x * dot - px, ty = y * dot - py, tz = z * dot - pz;
				var tm = Math.sqrt(tx * tx + ty * ty + tz * tz);
				if (tm < 1e-12) continue;
				var flow = speed * h / tm;
				ux += flow * tx; uy += flow * ty; uz += flow * tz;
			}
			s.uMantle[b] = ux; s.uMantle[b + 1] = uy; s.uMantle[b + 2] = uz; s.plumeT[c] = heat;
		}
	}
};
if (typeof module !== 'undefined' && module.exports) module.exports = Mantle;
