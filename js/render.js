function Renderer(canvas, state) {
	this.canvas = canvas;
	this.context = canvas.getContext('2d');
	this.state = state;
	canvas.width = state.grid.lookupW; canvas.height = state.grid.lookupH;
	this.image = this.context.createImageData(canvas.width, canvas.height);
	this.palette = new Uint8Array(state.plateCap * 3);
	this.colors = new Uint8Array(state.grid.V * 3);
	for (var p = 0; p < state.plateCap; p++) {
		var a = p * 2.3999632297;
		this.palette[p * 3] = 135 + 90 * Math.cos(a);
		this.palette[p * 3 + 1] = 145 + 80 * Math.cos(a + 2.1);
		this.palette[p * 3 + 2] = 155 + 80 * Math.cos(a + 4.2);
	}
}
Renderer.prototype.draw = function (layer) {
	var s = this.state, g = s.grid, data = this.image.data, colors = this.colors;
	for (var c = 0; c < g.V; c++) {
		var b = c * 3, owner = s.owner[c];
		colors[b] = 20; colors[b + 1] = 26; colors[b + 2] = 39;
		if (owner < 0) continue;
		if (layer === 'owner') { colors[b] = 78; colors[b + 1] = 197; colors[b + 2] = 167; continue; }
		if (layer === 'type') {
			var kind = 0;
			for (var k = 0; k < g.ringN[c]; k++) {
				var e = c * 6 + k, t = s.edgeType[e];
				if (t === 1 && s.polarity[e] === 2) { kind = 4; break; }
				if (t === 1 && kind < 3) kind = 3;
				else if (t === 2 && kind < 2) kind = 2;
				else if (t === 3 && kind < 1) kind = 1;
			}
			if (kind === 4) { colors[b] = 186; colors[b + 1] = 92; colors[b + 2] = 214; continue; }
			if (kind === 3) { colors[b] = 214; colors[b + 1] = 72; colors[b + 2] = 64; continue; }
			if (kind === 2) { colors[b] = 232; colors[b + 1] = 196; colors[b + 2] = 74; continue; }
			if (kind === 1) { colors[b] = 214; colors[b + 1] = 214; colors[b + 2] = 220; continue; }
			var p = s.plate[owner] * 3;
			colors[b] = this.palette[p] * 0.45; colors[b + 1] = this.palette[p + 1] * 0.45; colors[b + 2] = this.palette[p + 2] * 0.45;
			continue;
		}
		if (layer === 'plate') {
			var p = s.plate[owner] * 3;
			colors[b] = this.palette[p]; colors[b + 1] = this.palette[p + 1]; colors[b + 2] = this.palette[p + 2];
			continue;
		}
		var z = s.z[c];
		if (z < 0) {
			var shallow = Math.max(0, 1 + z / 6500);
			colors[b] = 15 + 23 * shallow; colors[b + 1] = 40 + 95 * shallow; colors[b + 2] = 69 + 100 * shallow;
			continue;
		}
		var high = Math.min(1, z / 6500);
		colors[b] = 100 + 145 * high; colors[b + 1] = 156 + 79 * high; colors[b + 2] = 112 + 113 * high;
	}
	for (var y = 0; y < g.lookupH; y++) {
		for (var x = 0; x < g.lookupW; x++) {
			var c = g.lookup[(g.lookupH - 1 - y) * g.lookupW + x], b = c * 3, pixel = (y * g.lookupW + x) * 4;
			data[pixel] = colors[b]; data[pixel + 1] = colors[b + 1]; data[pixel + 2] = colors[b + 2]; data[pixel + 3] = 255;
		}
	}
	this.context.putImageData(this.image, 0, 0);
};
if (typeof module !== 'undefined' && module.exports) module.exports = Renderer;
