const bindOf = code => code.startsWith("&") ? code : "&kp " + code;
// https://zmk.dev/docs/keymaps/modifiers - kept in sync with custom.py's MODS.
const MODS = ["LS","RS","LC","RC","LA","RA","LG","RG"];
const MOD_LABELS = {LS:"LShift", RS:"RShift", LC:"LCtrl", RC:"RCtrl",
                    LA:"LAlt", RA:"RAlt", LG:"LGui", RG:"RGui"};
const codeOf = b => (b||"").replace(/^&kp\s+/, "");
// `mods` nests outermost-first, e.g. ["LS","LA","LC"] -> LS(LA(LC(<code>))). Building
// the wrap happens innermost-out (reduceRight), the on-screen chain reads outermost-in
// left to right (modChainText) - same order humans click and read parens in.
const modChain = rec => (rec.mods||[]).reduceRight((acc,m) => `${m}(${acc})`, codeOf(rec.param));
const modBinding = rec => `&kp ${modChain(rec)}`;
const modChainText = mods => mods.map(m => m+"(").join("") + ")".repeat(mods.length);
const CHAIN_RE = /^(LS|RS|LC|RC|LA|RA|LG|RG)\(/;
function parseModChain(text){
  let s = (text||"").trim(), mods = [];
  while (mods.length < 3){
    const m = CHAIN_RE.exec(s);
    if (!m) break;
    mods.push(m[1]); s = s.slice(m[0].length);
  }
  return mods;
}

// Layer entries. `layerBinding()` mirrors custom._emit_layer() far enough to label
// and match a card - the server is still what emits, and the two are kept in sync by
// hand, exactly like MODS. There is no `mo` mode to save: `&mo <n>` is built into ZMK,
// takes one parameter, and the picker's Layers tab builds one in a single click with
// no record at all (see "Saving is optional" in views/layer.md) - so the only two
// kinds worth naming are a layer-tap (declares nothing unless it needs a custom
// tapping term or flavor, which turns it into a generated `lt_<name>` hold-tap node)
// and a conditional layer.
const paramOf = b => (b||"").trim().split(/\s+/).slice(1).join(" ");
const ltCustom = r => !!(r.tapping_term_ms || r.flavor);
function layerBinding(r){
  const mode = r.mode || "lt";
  if (mode === "conditional") return "";
  const n = +r.layer || 0;
  const code = paramOf(r.key || "");
  if (!code) return "";
  return ltCustom(r) ? `&lt_${r.name} ${n} ${code}` : `&lt ${n} ${code}`;
}
// A custom layer-tap is referenced by its generated label, a built-in one by its whole
// text - the same split as usesVd() vs modBinding(), for the same reason.
const usesLayer = (v, r) => {
  const t = (v||"").trim();
  if (!t) return false;
  return ltCustom(r) ? t.split(/\s+/)[0].replace(/^&/, "") === "lt_" + r.name
                     : t === layerBinding(r);
};
const layerTitle = r => (r.mode || "lt") === "conditional"
  ? `hold layers ${(r.if_layers||[]).join(" + ")} \u2192 layer ${r.then_layer ?? "?"}`
  : `tap: ${r.key || "?"}\nhold: layer ${+r.layer || 0}`
    + (ltCustom(r) ? `\nterm: ${r.tapping_term_ms || 200}ms`
                   + `\nflavor: ${r.flavor || "balanced"}` : "");

