const DATA = JSON.parse(document.getElementById("data").textContent);
const KINDS = {config:"In this config", variant:"Saved variations", vendor:"Vendor defaults"};
// There is one screen now. `editing` (a key position) and `emode` (a creation
// panel) are the two things that can occupy the editor area above the menu, and
// they are mutually exclusive - opening one closes the other. `ptab` is which of
// the six menu tabs below it is showing, and it is independent of both.
// `reset` is tri-state: null means "not chosen", and the variant bar falls back
// to whether the keymap binds `&studio_unlock` - the keymaps whose keyboards can
// end up ignoring the compiled keymap at the positions Studio wrote. Ticking or
// unticking the box pins it for the session.
const state = {id:null, layer:0, layout:0, base:"", nums:true, hot:null,
               emode:null, drafts:{}, sel:[], assign:{}, msg:null, dts:null,
               editing:null, picker:true, ptab:"keyboard",
               refocus:null, newLayers:{}, reset:null};

// Does any layer bind ZMK Studio's unlock key? `build_yaml_for()` asks the same
// question of the keymap text to decide on the Studio snippet and flag.
function bindsStudioUnlock(km){
  return (km.layers || []).some(l =>
    (l.bindings || []).some(b => /^&?studio_unlock\b/.test(b.trim())));
}
const LIVE = !!DATA.live;
let STORE = DATA.custom || {viledance:[], combo:[], modifier:[], layer:[], macro:[]};

async function api(method, path, body){
  const r = await fetch(path, {method,
    headers: body ? {"Content-Type":"application/json"} : {},
    body: body ? JSON.stringify(body) : undefined});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const say = (text, bad) => { state.msg = text ? {text, bad} : null; };
const msgHtml = () => state.msg
  ? `<div class="msg ${state.msg.bad?"bad":"ok"}">${esc(state.msg.text)}</div>` : "";
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
// `esc()` is enough for a text node, and for an attribute whose value cannot
// contain a quote - which was every attribute here until a macro's `text` step,
// where the user types arbitrary text and `He said "hi"` would end the attribute
// early. Anything of theirs going into an attribute goes through this instead.
const escA = s => esc(s).replace(/"/g, "&quot;");
const byId = id => DATA.keymaps.find(k => k.id === id);

// A scope key names one keymap *file* - `variant:my_board`, `config:corne` -
// and mirrors custom.scope_key() / custom.slug() in the Python half (another
// hand-kept pair, like MODS). It is what a board-wide record's `scopes` map is
// keyed by: a combo is on or off per keymap, not once for everything.
const slugify = n => String(n).trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const scopeOf = km => km ? `${km.kind}:${slugify(km.name)}` : "";
const scopeOn = (r, scope) => !!(scope && (r.scopes || {})[scope]);

