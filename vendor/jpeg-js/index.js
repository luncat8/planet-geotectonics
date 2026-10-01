/* jpeg-js 0.4.4 decoder shim - the upstream lib/decoder.js exports the function itself,
 * the package root wraps it as { decode, encode }. The bake only ever decodes. */
module.exports = { decode: require('./decoder.js') };