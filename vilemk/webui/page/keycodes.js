// ------------------------------------------- the full-keyboard key picker
// Rows of [label, keycode, width-in-units]; a null code is a spacer. A label
// with a "|" shows the shifted legend above the plain one. Codes starting with
// "&" are whole bindings, anything else becomes "&kp CODE".
const _sp = w => ["", null, w];
const _row = (s, w) => s.split(" ").map(c => [c, c, w||1]);
const PICKER = [
  [["Esc","ESC",1], _sp(1), ..._row("F1 F2 F3 F4"), _sp(.5),
   ..._row("F5 F6 F7 F8"), _sp(.5), ..._row("F9 F10 F11 F12"), _sp(.5),
   ["Print Screen","PSCRN",1], ["Scroll Lock","SLCK",1], ["Pause","PAUSE_BREAK",1]],

  [["~|`","GRAVE",1], ["!|1","N1",1], ["@|2","N2",1], ["#|3","N3",1],
   ["$|4","N4",1], ["%|5","N5",1], ["^|6","N6",1], ["&|7","N7",1],
   ["*|8","N8",1], ["(|9","N9",1], [")|0","N0",1], ["_|-","MINUS",1],
   ["+|=","EQUAL",1], ["Bksp","BSPC",2], _sp(.5),
   ["Insert","INS",1], ["Home","HOME",1], ["Page Up","PG_UP",1], _sp(.5),
   ["Num Lock","KP_NUM",1], ["/","KP_DIVIDE",1], ["*","KP_MULTIPLY",1],
   ["-","KP_MINUS",1]],

  [["Tab","TAB",1.5], ..._row("Q W E R T Y U I O P"),
   ["{|[","LBKT",1], ["}|]","RBKT",1], [["|","\\"],"BSLH",1.5], _sp(.5),
   ["Del","DEL",1], ["End","END",1], ["Page Down","PG_DN",1], _sp(.5),
   ["7","KP_N7",1], ["8","KP_N8",1], ["9","KP_N9",1], ["+","KP_PLUS",1]],

  [["Caps Lock","CAPS",1.75], ..._row("A S D F G H J K L"),
   [":|;","SEMI",1], ["\"|'","SQT",1], ["Enter","RET",2.25], _sp(4),
   ["4","KP_N4",1], ["5","KP_N5",1], ["6","KP_N6",1], [",","KP_COMMA",1]],

  [["LShift","LSHFT",2.25], ..._row("Z X C V B N M"),
   ["<|,","COMMA",1], [">|.","DOT",1], ["?|/","FSLH",1], ["RShift","RSHFT",2.75],
   _sp(1.5), ["Up","UP",1], _sp(1.5),
   ["1","KP_N1",1], ["2","KP_N2",1], ["3","KP_N3",1], ["=","KP_EQUAL",1]],

  [["LCtrl","LCTRL",1.25], ["LGui","LGUI",1.25], ["LAlt","LALT",1.25],
   ["Space","SPACE",6.25], ["RAlt","RALT",1.25], ["RGui","RGUI",1.25],
   ["Menu","K_APP",1.25], ["RCtrl","RCTRL",1.25], _sp(.5),
   ["Left","LEFT",1], ["Down","DOWN",1], ["Right","RIGHT",1], _sp(.5),
   ["0","KP_N0",2], [".","KP_DOT",1], ["Num Enter","KP_ENTER",1]]
];
// Extra row: the two bindings that are not keycodes, then the shifted symbols
// that ZMK names in their own right. There is no "any" key in ZMK.
const PICKER_EXTRA = [
  ["Empty","&none",1.5], ["▽","&trans",1.5], _sp(.5),
  ["~","TILDE",1], ["!","EXCL",1], ["@","AT",1], ["#","HASH",1], ["$","DLLR",1],
  ["%","PRCNT",1], ["^","CARET",1], ["&","AMPS",1], ["*","STAR",1],
  ["(","LPAR",1], [")","RPAR",1], ["_","UNDER",1], ["+","PLUS",1],
  ["{","LBRC",1], ["}","RBRC",1], ["<","LT",1], [">","GT",1], [":","COLON",1],
  [["|"],"PIPE",1], ["?","QMARK",1], ["\"","DQT",1]
];

// ----------------------------------- the keys no keyboard has a keycap for
// Media, mouse, radio, lights, firmware: what ZMK can send that the ANSI grid
// above has no key for. Same row shape as PICKER ([label, code, width]) and the
// same `bindOf()` rule, so a click here is an ordinary whole-binding pick - but
// most of these are not `&kp` at all, they are behaviors of their own (`&bt`,
// `&mkp`, `&rgb_ug`), which is exactly why they cannot sit on that grid.
//
// `note` is the honest answer to "is this standard?". The consumer codes are:
// any board can send them and the host decides what they mean. Everything with
// hardware or a Kconfig behind it is not, and a binding whose behavior the build
// left out does not fail quietly - the firmware does not build at all. So each
// group says what a board needs before its keys mean anything.
const SYSTEM = [
  {name: "Media and consumer",
   note: `Standard HID consumer codes - <code>&amp;kp</code> like any letter, so every
          board can send them and the <b>host</b> decides what each one does.`,
   rows: [
     [["Vol +","C_VOL_UP",1.5], ["Vol -","C_VOL_DN",1.5], ["Mute","C_MUTE",1.5],
      ["Play/Pause","C_PP",2], ["Stop","C_STOP",1.5], ["Prev","C_PREV",1.5],
      ["Next","C_NEXT",1.5], ["Rewind","C_RW",1.75], ["Fast fwd","C_FF",1.75],
      ["Eject","C_EJECT",1.5]],
     [["Bright +","C_BRI_UP",1.75], ["Bright -","C_BRI_DN",1.75],
      ["Power","C_PWR",1.5], ["Sleep","C_SLEEP",1.5], ["Lock","C_AL_LOCK",1.5],
      ["Calc","C_AL_CALC",1.5], ["Files","C_AL_FILES",1.5],
      ["Browser","C_AL_WWW",1.75], ["Mail","C_AL_MAIL",1.5],
      ["Music","C_AL_MUSIC",1.5], ["Search","C_AC_SEARCH",1.75]]]},

  {name: "Mouse",
   note: `Needs a build with <code>CONFIG_ZMK_POINTING=y</code>: boards with a
          trackball or trackpad set it themselves, anywhere else it goes in the
          board's <code>.conf</code>. Movement and scroll send a fixed step per
          press - the speed is the board's input processors, not the keymap.`,
   rows: [
     [["Left click","&mkp LCLK",2], ["Right click","&mkp RCLK",2],
      ["Middle click","&mkp MCLK",2.25], ["Back","&mkp MB4",1.5],
      ["Forward","&mkp MB5",1.75]],
     [["Move up","&mmv MOVE_UP",2], ["Move down","&mmv MOVE_DOWN",2],
      ["Move left","&mmv MOVE_LEFT",2], ["Move right","&mmv MOVE_RIGHT",2]],
     [["Scroll up","&msc SCRL_UP",2], ["Scroll down","&msc SCRL_DOWN",2],
      ["Scroll left","&msc SCRL_LEFT",2], ["Scroll right","&msc SCRL_RIGHT",2]]]},

  {name: "Bluetooth and output",
   note: `Wireless boards only. <code>&amp;bt</code> drives the five BLE profiles -
          <b>BT 0-4</b> switches to one, <b>Disc</b> forgets one host, <b>BT clear</b>
          wipes the profile you are on. <code>&amp;out</code> picks which way the keys
          leave the board when USB is plugged in as well.`,
   rows: [
     [["BT 0","&bt BT_SEL 0",1.25], ["BT 1","&bt BT_SEL 1",1.25],
      ["BT 2","&bt BT_SEL 2",1.25], ["BT 3","&bt BT_SEL 3",1.25],
      ["BT 4","&bt BT_SEL 4",1.25], _sp(.5),
      ["BT next","&bt BT_NXT",1.75], ["BT prev","&bt BT_PRV",1.75],
      ["BT clear","&bt BT_CLR",1.75], ["Clear all","&bt BT_CLR_ALL",2]],
     [["Disc 0","&bt BT_DISC 0",1.5], ["Disc 1","&bt BT_DISC 1",1.5],
      ["Disc 2","&bt BT_DISC 2",1.5], ["Disc 3","&bt BT_DISC 3",1.5],
      ["Disc 4","&bt BT_DISC 4",1.5], _sp(.5),
      ["USB","&out OUT_USB",1.5], ["BLE","&out OUT_BLE",1.5],
      ["USB/BLE","&out OUT_TOG",1.75]]]},

  {name: "Lighting",
   note: `Underglow needs the LEDs and <code>CONFIG_ZMK_RGB_UNDERGLOW=y</code>,
          backlight needs per-key LEDs and <code>CONFIG_ZMK_BACKLIGHT=y</code>. On a
          board without them the behavior does not exist and the build fails, so
          leave the row alone rather than binding it hopefully.`,
   rows: [
     [["RGB on","&rgb_ug RGB_ON",1.75], ["RGB off","&rgb_ug RGB_OFF",1.75],
      ["RGB toggle","&rgb_ug RGB_TOG",2], _sp(.5),
      ["Hue +","&rgb_ug RGB_HUI",1.5], ["Hue -","&rgb_ug RGB_HUD",1.5],
      ["Sat +","&rgb_ug RGB_SAI",1.5], ["Sat -","&rgb_ug RGB_SAD",1.5],
      ["RGB +","&rgb_ug RGB_BRI",1.5], ["RGB -","&rgb_ug RGB_BRD",1.5],
      ["Speed +","&rgb_ug RGB_SPI",1.75], ["Speed -","&rgb_ug RGB_SPD",1.75],
      ["Effect","&rgb_ug RGB_EFF",1.75], ["Effect back","&rgb_ug RGB_EFR",2.25]],
     [["BL on","&bl BL_ON",1.5], ["BL off","&bl BL_OFF",1.5],
      ["BL toggle","&bl BL_TOG",1.75], ["BL +","&bl BL_INC",1.25],
      ["BL -","&bl BL_DEC",1.25], ["BL cycle","&bl BL_CYCLE",1.75]]]},

  {name: "Power and firmware",
   note: `<b>Reset</b> and <b>Bootloader</b> are on every board (bootloader is how you
          flash without touching the button). <b>Ext pwr</b> switches the board's own
          3.3V rail - the LEDs and the display hang off it. <b>Soft off</b> needs a
          wake-up source wired up, and <b>Studio unlock</b> only means something on a
          ZMK Studio build.`,
   rows: [
     [["Ext pwr on","&ext_power EP_ON",2], ["Ext pwr off","&ext_power EP_OFF",2],
      ["Ext pwr tog","&ext_power EP_TOG",2], _sp(.5),
      ["Soft off","&soft_off",1.75], ["Reset","&sys_reset",1.5],
      ["Bootloader","&bootloader",2], ["Studio unlock","&studio_unlock",2.5]]]},

  {name: "Typing extras",
   note: `Plain ZMK behaviors, no hardware behind them: <b>Caps word</b> shifts until
          the next space, <b>Key repeat</b> sends whatever the last key sent,
          <b>Grave/Esc</b> is escape alone and <code>~</code> with GUI or shift held.`,
   rows: [
     [["Caps word","&caps_word",2], ["Key repeat","&key_repeat",2],
      ["Grave/Esc","&gresc",2]]]},

  {name: "Sticky and locked keys",
   note: `Two ways to hold a modifier without holding it. <code>&amp;sk</code> is a
          one-shot: tap it and the <b>next</b> key comes with that modifier applied,
          nothing to chord. <code>&amp;kt</code> is a latch: it presses the key and
          leaves it pressed until the same key is pressed again. Both take any keycode
          - these eight are the ones worth a button; anything else is
          <code>&amp;sk</code>/<code>&amp;kt</code> plus a keycode, typed into the
          field. A sticky <b>layer</b> is on the <b>Layers</b> tab, with the rest of
          the layer switching.`,
   rows: [
     [["Sticky LShift","&sk LSHFT",2], ["Sticky RShift","&sk RSHFT",2],
      ["Sticky LCtrl","&sk LCTRL",2], ["Sticky RCtrl","&sk RCTRL",2],
      ["Sticky LAlt","&sk LALT",2], ["Sticky RAlt","&sk RALT",2],
      ["Sticky LGui","&sk LGUI",2], ["Sticky RGui","&sk RGUI",2]],
     [["Lock LShift","&kt LSHFT",2], ["Lock RShift","&kt RSHFT",2],
      ["Lock LCtrl","&kt LCTRL",2], ["Lock RCtrl","&kt RCTRL",2],
      ["Lock LAlt","&kt LALT",2], ["Lock RAlt","&kt RALT",2],
      ["Lock LGui","&kt LGUI",2], ["Lock RGui","&kt RGUI",2]]]}
];

// Tile legends for the half of SYSTEM that is not a `&kp`: `label()` reads
// BIND_LABELS for those and KEY_LABELS for the consumer codes, so a board tile
// says "BT 0" and "Left click" instead of the raw binding. Same derive-don't-
// retype rule as `_learnLabels()`.
function _learnSystem(rows){
  for (const ent of rows){
    const [lbl, code] = ent;
    if (!code) continue;
    if (code.startsWith("&")){
      if (!(normBind(code) in BIND_LABELS)) BIND_LABELS[normBind(code)] = lbl;
    } else if (!(code in KEY_LABELS)) KEY_LABELS[code] = lbl;
  }
}
SYSTEM.forEach(g => g.rows.forEach(_learnSystem));
// LCLK/RCLK/MCLK are MB1/MB2/MB3 under another name (pointing.h names both), and
// a hand-written keymap may spell either - the tile answers to both.
[["MB1","LCLK"], ["MB2","RCLK"], ["MB3","MCLK"]].forEach(([a, b]) =>
    BIND_LABELS[`&mkp ${a}`] = BIND_LABELS[`&mkp ${b}`]);

PICKER.forEach(_learnLabels); _learnLabels(PICKER_EXTRA);

