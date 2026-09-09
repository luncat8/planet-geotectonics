/* wgsl-mantle.js - K0 mantle flow per cell. Wave dirs/phases, plume positions and the
   speed/scale scalars are CPU-computed each frame and uploaded in the frame buffer. */
var MantleWGSL = [
{
	name: 'mantle', groups: ['gridF', 'cellF', 'frameIn'],
	code: `
fn rawAt(v: vec3<f32>) -> vec3<f32> {
	var u = vec3<f32>(0.0);
	for (var w = 0u; w < P_NWAVE; w = w + 1u) {
		let a = w * 3u;
		let d = vec3<f32>(FIN[F_WAVEDIR + a], FIN[F_WAVEDIR + a + 1u], FIN[F_WAVEDIR + a + 2u]);
		let dotd = dot(d, v);
		let ampK = FIN[F_WAVEAMP + w] * FIN[F_WAVEFREQ + w] * cosx(FIN[F_WAVEFREQ + w] * dotd + FIN[F_WAVEPHASE + w]);
		if (w < P_NPHI) {
			u = u + ampK * (d - dotd * v);
		} else {
			u = u + ampK * P_BETA * cross(v, d);
		}
	}
	return u;
}

@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= V) { return; }
	let v = cellPos(c);
	var u = rawAt(v) * fScale();
	var heat = 0.0;
	let nPlume = plumeCount();
	for (var k = 0u; k < nPlume; k = k + 1u) {
		let pb = F_PLUME + k * 4u;
		let pp = vec3<f32>(FIN[pb], FIN[pb + 1u], FIN[pb + 2u]);
		let dotc = clamp(dot(pp, v), -1.0, 1.0);
		// 1 - pp*v through the chord: the direct subtraction cancels hard near the
		// plume axis and invSig (~160) amplifies the noise into plumeT.
		let cv = pp - v;
		let oneMdot = 0.5 * dot(cv, cv);
		let h = FIN[pb + 3u] * fTM() * exp(-oneMdot * fInvSig());
		heat = heat + h;
		let t = v * dotc - pp;
		let tm = length(t);
		if (tm > 1e-12) {
			u = u + t * (fSpeed() * h / tm);
		}
	}
	CELLF[c * 8u + 2u] = vec4<f32>(u, heat);
}
`
}
];
if (typeof module !== 'undefined' && module.exports) module.exports = MantleWGSL;
