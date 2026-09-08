/* gpu/mantle.wgsl.js — K0 cell field: harmonic poloidal/toroidal octaves plus Gaussian plumes.
   Wave precession and plume respawn stay on the CPU (8 lanes and an RNG); this is the only
   per-cell part of Mantle.update, a line-by-line port of Mantle.rawAt plus the plume loop.
   Field constants are A_<NAME> (layout), element strides N_<NAME>; helpers are ld<letter>/
   st<letter> for u32, ldF<letter>/stF<letter> for f32, ldI<letter>/stI<letter> for i32. */
var MantleWgsl = function () {
	return `@compute @workgroup_size(256)
fn kMantle(@builtin(global_invocation_id) gid: vec3<u32>) {
	let c = gid.x;
	if (c >= CELL_N) { return; }
	let scale = ldFM(A_GMANTLESCALE) * ldFM(A_GSPEED);
	let px = ldFS(A_POS + c * 4u);
	let py = ldFS(A_POS + c * 4u + 1u);
	let pz = ldFS(A_POS + c * 4u + 2u);
	var ux = 0.0; var uy = 0.0; var uz = 0.0;
	for (var w = 0u; w < N_WAVE; w++) {
		let dx = ldFM(A_WAVEDIR + w * 4u);
		let dy = ldFM(A_WAVEDIR + w * 4u + 1u);
		let dz = ldFM(A_WAVEDIR + w * 4u + 2u);
		let dt = dx * px + dy * py + dz * pz;
		let ampK = ldFM(A_WAVEAMP + w) * ldFM(A_WAVEFREQ + w)
			* cos(ldFM(A_WAVEFREQ + w) * dt + ldFM(A_WAVEPHASE + w));
		if (w < u32(N_PHI)) {
			ux = ux + ampK * (dx - dt * px);
			uy = uy + ampK * (dy - dt * py);
			uz = uz + ampK * (dz - dt * pz);
		} else {
			ux = ux + ampK * BETA * (py * dz - pz * dy);
			uy = uy + ampK * BETA * (pz * dx - px * dz);
			uz = uz + ampK * BETA * (px * dy - py * dx);
		}
	}
	ux = ux * scale; uy = uy * scale; uz = uz * scale;
	var heat = 0.0;
	let invSig = ldFM(A_GINVSIG);
	let speed = ldFM(A_GSPEED);
	for (var k = 0u; k < u32(ldFM(A_GPLUMECOUNT)); k++) {
		let qx = ldFM(A_PLUME + k * 4u);
		let qy = ldFM(A_PLUME + k * 4u + 1u);
		let qz = ldFM(A_PLUME + k * 4u + 2u);
		let pd = clamp(qx * px + qy * py + qz * pz, -1.0, 1.0);
		let h = ldFM(A_PLUME + k * 4u + 3u) * ldFM(A_GTM) * exp(-(1.0 - pd) * invSig);
		heat = heat + h;
		let tx = px * pd - qx; let ty = py * pd - qy; let tz = pz * pd - qz;
		let tm = sqrt(tx * tx + ty * ty + tz * tz);
		if (tm < 1e-12) { continue; }
		let flow = speed * h / tm;
		ux = ux + flow * tx; uy = uy + flow * ty; uz = uz + flow * tz;
	}
	stFX(A_U + c * 4u, ux);
	stFX(A_U + c * 4u + 1u, uy);
	stFX(A_U + c * 4u + 2u, uz);
	stFX(A_PLUMET + c, heat);
}
`;
};
MantleWgsl.entry = ['kMantle'];
if (typeof module !== 'undefined' && module.exports) module.exports = MantleWgsl;
