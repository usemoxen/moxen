/* @ds-bundle: {"format":4,"namespace":"Moxen","components":[{"name":"Mark"},{"name":"Wordmark"},{"name":"StateGlyph"},{"name":"Delta"},{"name":"Avatar"},{"name":"AvatarStack"},{"name":"Button"},{"name":"Kbd"},{"name":"TextField"},{"name":"Composer"},{"name":"Segmented"},{"name":"Toggle"},{"name":"Checkbox"},{"name":"Pane"},{"name":"Tabs"},{"name":"Dialog"},{"name":"Menu"},{"name":"CommandBar"},{"name":"Chip"},{"name":"Notice"},{"name":"Toast"},{"name":"Furrow"},{"name":"Meter"},{"name":"ListRow"},{"name":"Trail"},{"name":"PropList"},{"name":"MessageGroup"},{"name":"SystemLine"},{"name":"CallDock"},{"name":"SafetyNumber"},{"name":"TrackHeader"},{"name":"Region"},{"name":"Counter"},{"name":"FieldRow"},{"name":"Kanban"},{"name":"EditionHeader"},{"name":"Citation"},{"name":"Steps"},{"name":"Command"},{"name":"TaskList"},{"name":"ModelPicker"},{"name":"Pause"},{"name":"Icon"},{"name":"NavRail"},{"name":"ConversationRow"},{"name":"VoiceNote"},{"name":"ChatComposer"},{"name":"CallStage"}]} */
(function () {
  "use strict";
  var React = window.React;
  var h = React.createElement;
  var useState = React.useState, useEffect = React.useEffect, useRef = React.useRef;

  function cx() { return Array.prototype.filter.call(arguments, Boolean).join(" "); }
  function f(n) { return +n.toFixed(3); }

  /* ---------- marks: one field (4 x 3 nodes), one plough per product ---------- */
  var MARKS = {
    moxen:    { pts: [[0,2],[0,0],[1,0],[1,2],[2,2],[2,0],[3,0],[3,2]] },
    agent:    { pts: [[0,2],[0,0],[1,0],[1,2],[2,2],[2,0],[3,0]], head: true },
    chat:     { pts: [[0,0],[1,0],[1,1],[2,1],[2,0],[3,0],[3,2],[0,2]], closed: true },
    music:    { pts: [[0,0],[3,0],[3,1],[0,1],[0,2],[3,2]] },
    board:    { pts: [[0,2],[0,0],[3,0],[3,2],[1,2],[1,1],[2,1]] },
    dispatch: { pts: [[0,0],[1,0],[1,1],[0,1],[0,2],[3,2],[3,1],[2,1],[2,0],[3,0]] }
  };
  var TURN = 0.5;

  function dir(a, b) { return [Math.sign(b[0] - a[0]), Math.sign(b[1] - a[1])]; }
  function corner(prev, cur, next) {
    var i = dir(prev, cur), o = dir(cur, next);
    if (i[0] === o[0] && i[1] === o[1]) return { a: cur, b: cur, arc: "" };
    var a = [cur[0] - i[0] * TURN, cur[1] - i[1] * TURN], b = [cur[0] + o[0] * TURN, cur[1] + o[1] * TURN];
    var sweep = (i[0] * o[1] - i[1] * o[0]) > 0 ? 1 : 0;
    return { a: a, b: b, arc: " A" + TURN + " " + TURN + " 0 0 " + sweep + " " + f(b[0]) + " " + f(b[1]) };
  }
  function markPath(name) {
    var m = MARKS[name] || MARKS.moxen, p = m.pts, n = p.length, d, k, c;
    if (m.closed) {
      var c0 = corner(p[n - 1], p[0], p[1]);
      d = "M" + f(c0.b[0]) + " " + f(c0.b[1]);
      for (k = 1; k <= n; k++) { c = corner(p[k - 1], p[k % n], p[(k + 1) % n]); d += " L" + f(c.a[0]) + " " + f(c.a[1]) + c.arc; }
      return d + " Z";
    }
    d = "M" + p[0][0] + " " + p[0][1];
    for (k = 1; k < n - 1; k++) { c = corner(p[k - 1], p[k], p[k + 1]); d += " L" + f(c.a[0]) + " " + f(c.a[1]) + c.arc; }
    return d + " L" + p[n - 1][0] + " " + p[n - 1][1];
  }

  /* one shared clock for the Live glyph, the only state that moves */
  var SPIN = ["◐", "◓", "◑", "◒"];
  var spinSubs = [], spinTimer = null, spinFrame = 0;
  function reduced() { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); }
  function useSpin(on) {
    var st = useState(spinFrame), set = st[1];
    useEffect(function () {
      if (!on || reduced()) return;
      spinSubs.push(set);
      if (!spinTimer) spinTimer = setInterval(function () { spinFrame = (spinFrame + 1) % 4; spinSubs.forEach(function (s) { s(spinFrame); }); }, 300);
      return function () {
        spinSubs = spinSubs.filter(function (s) { return s !== set; });
        if (!spinSubs.length) { clearInterval(spinTimer); spinTimer = null; }
      };
    }, [on]);
    return SPIN[st[0]];
  }

  function Mark(props) {
    var product = props.product || "moxen", size = props.size || 24, m = MARKS[product] || MARKS.moxen;
    var sw = props.stroke || (size <= 16 ? 0.36 : size <= 28 ? 0.3 : 0.24);
    var pad = 0.42, w = 3 + 2 * pad, hh = 2 + 2 * pad;
    var kids = [h("path", { key: "p", className: "mx-mark-stroke", d: markPath(product), strokeWidth: sw })];
    if (m.head) {
      var e = m.pts[m.pts.length - 1], hs = Math.max(sw * 1.9, 0.42);
      kids.push(h("rect", { key: "h", className: cx("mx-mark-head", props.live && "is-live"), x: f(e[0] - hs / 2), y: f(e[1] - hs / 2), width: f(hs), height: f(hs) }));
    }
    return h("svg", {
      className: cx("mx-mark", props.className), viewBox: [-pad, -pad, w, hh].join(" "),
      width: f(size * w / hh), height: size, role: props.title ? "img" : undefined,
      "aria-label": props.title, "aria-hidden": props.title ? undefined : true
    }, kids);
  }

  /* Wordmark: the m is set as a letter. Height = x-height, stroke = the face's stem,
     gap = an n's right side bearing plus the word's tracking. Measured once from the loaded face. */
  var wordMetrics = null;
  function measureWord(el) {
    var cs = getComputedStyle(el), size = 400, font = cs.fontWeight + " " + size + "px " + cs.fontFamily;
    var cv = document.createElement("canvas"), ctx = cv.getContext("2d");
    ctx.font = font;
    var xh = ctx.measureText("x").actualBoundingBoxAscent, n = ctx.measureText("n"), rsb = n.width - n.actualBoundingBoxRight;
    cv.width = size; cv.height = size; ctx.font = font; ctx.fillStyle = "#000";
    ctx.fillText("l", size * 0.3, size * 0.8);
    var row = Math.round(size * 0.8 - xh / 2), data = ctx.getImageData(0, row, size, 1).data, run = 0, best = 0;
    for (var i = 3; i < data.length; i += 4) { if (data[i] > 127) { run++; if (run > best) best = run; } else run = 0; }
    var track = parseFloat(cs.letterSpacing) / parseFloat(cs.fontSize) || 0;
    if (!xh) return null;
    return { xh: xh / size, stem: (best || xh * 0.2) / size, gap: Math.max(0.045, rsb / size + track + 0.03) };
  }
  function Wordmark(props) {
    var ref = useRef(null), st = useState(wordMetrics), m = st[0], set = st[1];
    useEffect(function () {
      if (wordMetrics) return;
      var go = function () { var r = ref.current && measureWord(ref.current); if (r) { wordMetrics = r; set(r); } };
      if (document.fonts && document.fonts.load) document.fonts.load('700 100px "Atkinson Hyperlegible Next"').then(function () { return document.fonts.ready; }).then(go, go);
      else go();
    }, []);
    var g = m || { xh: 0.5, stem: 0.105, gap: 0.05 };
    var sw = 2 * g.stem / (g.xh - g.stem);
    return h("span", { ref: ref, className: cx("mx-wordmark", props.className), style: { fontSize: (props.size || 48) + "px" }, role: "img", "aria-label": "moxen" },
      h("svg", { "aria-hidden": true, viewBox: [f(-sw / 2), f(-sw / 2), f(3 + sw), f(2 + sw)].join(" "), style: { position: "static", display: "inline-block", verticalAlign: "baseline", height: f(g.xh) + "em", width: f(g.xh * (3 + sw) / (2 + sw)) + "em", marginRight: f(g.gap) + "em" } },
        h("path", { d: markPath("moxen"), strokeWidth: f(sw) })),
      h("span", { "aria-hidden": true }, "oxen"));
  }

  var STATES = {
    queued: { glyph: "○", word: "Up next" },
    live:   { glyph: "◐", word: "Live" },
    held:   { glyph: "●", word: "Your turn" },
    broken: { glyph: "✕", word: "Stuck" },
    done:   { glyph: "✓", word: "Done" }
  };
  function StateGlyph(props) {
    var s = props.state || "queued", def = STATES[s] || STATES.queued, spun = useSpin(s === "live");
    var glyph = s === "live" ? spun : def.glyph;
    return h("span", { className: cx("mx-state", "is-" + s, props.className), title: props.label ? undefined : def.word },
      h("span", { className: "mx-state-glyph", "aria-hidden": !!props.label }, glyph),
      props.label ? h("span", { className: "mx-state-label" }, props.label === true ? def.word : props.label) : h("span", { className: "mx-sr" }, def.word));
  }

  function Delta(props) {
    return h("span", { className: cx("mx-delta", props.className) },
      props.added != null ? h("span", { className: "mx-delta-add" }, "+" + props.added) : null,
      props.removed != null ? h("span", { className: "mx-delta-del" }, "−" + props.removed) : null);
  }

  /* ---------- identity: a circle is a person, a square is a machine ---------- */
  function Avatar(props) {
    var kind = props.kind || "person", size = props.size || "md";
    var face = kind === "agent" ? h(Mark, { product: "agent", size: size === "sm" ? 9 : size === "lg" ? 18 : 12, stroke: 0.42 }) : (props.initials || "?");
    var av = h("span", { className: cx("mx-av", "is-" + kind, "is-" + size, kind === "person" && props.color && "is-c" + props.color, props.live && "is-live", props.empty && "is-empty"), title: props.name, "aria-label": props.name ? undefined : undefined }, props.empty ? "" : face);
    if (!props.name || props.hideName) return av;
    return h("span", { className: cx("mx-who", props.className) }, av, h("span", { className: "mx-who-name" }, props.name), props.meta ? h("span", { className: "mx-who-meta" }, props.meta) : null);
  }
  function AvatarStack(props) {
    var list = (props.people || []).slice(0, 2);
    return h("span", { className: cx("mx-avstack", props.className) }, list.map(function (p, i) { return h(Avatar, Object.assign({ key: i, size: "sm" }, p, { name: undefined })); }));
  }

  /* ---------- actions ---------- */
  function Button(props) {
    var variant = props.variant || "secondary", rest = Object.assign({}, props);
    ["variant", "size", "icon", "className", "children"].forEach(function (k) { delete rest[k]; });
    return h("button", Object.assign({ type: "button" }, rest, { className: cx("mx-btn", "is-" + variant, "is-" + (props.size || "md"), !props.children && "is-icon", props.className) }),
      props.icon ? h("span", { className: "mx-btn-icon", "aria-hidden": true }, props.icon) : null,
      props.children);
  }
  function Kbd(props) { return h("kbd", { className: cx("mx-kbd", props.className) }, props.children); }

  /* ---------- inputs ---------- */
  var uid = 0;
  function useId(p) { var r = useRef(null); if (!r.current) r.current = p || "mx-" + (++uid); return r.current; }
  function TextField(props) {
    var id = useId(props.id);
    return h("label", { className: cx("mx-field", props.error && "is-error", props.className), htmlFor: id },
      props.label ? h("span", { className: "mx-field-label" }, props.label) : null,
      h("input", { id: id, className: cx("mx-input", props.mono && "is-mono"), placeholder: props.placeholder, defaultValue: props.value, type: props.type || "text", "aria-invalid": !!props.error }),
      props.error ? h("span", { className: "mx-field-error" }, props.error) : props.hint ? h("span", { className: "mx-field-hint" }, props.hint) : null);
  }

  function Composer(props) {
    var st = useState(""), text = st[0], set = st[1];
    var to = props.to || [];
    var box = h("div", { className: cx("mx-composer", props.className) },
      props.controls ? h("div", { className: "mx-composer-controls" }, props.controls) : h("div", { className: "mx-composer-to" },
        props.product && props.product !== "agent" ? h(Mark, { product: props.product, size: 12 }) : null,
        to.length && to[0].kind === "agent" ? h(Avatar, { kind: "agent", size: "sm" }) : null,
        "to ", h("b", null, to.map(function (t) { return t.name; }).join(", ") || "nobody yet"),
        props.scope ? h("span", null, " · " + props.scope) : null),
      h("textarea", { className: "mx-composer-input", rows: props.rows || 1, placeholder: props.placeholder || "Write a message", value: text, onChange: function (e) { set(e.target.value); }, "aria-label": props.placeholder || "Message" }),
      h("div", { className: "mx-composer-bar" },
        h("button", { type: "button", className: "mx-composer-attach", "aria-label": "Attach" }, "+"),
        h("span", { className: "mx-composer-meta" }, props.meta || ""),
        props.onStop ? h("button", { type: "button", className: "mx-composer-stop", "aria-label": "Stop", title: "Stop  esc", onClick: props.onStop }, h("i")) : null,
        h("button", { type: "button", className: "mx-composer-send", "aria-label": "Send", disabled: !text && !props.alwaysSend, onClick: function () { if (props.onSend) props.onSend(text); set(""); } }, "↑")));
    if (!props.below) return box;
    return h("div", { className: "mx-composer-wrap" }, box, h("div", { className: "mx-composer-below" }, props.below));
  }

  function Segmented(props) {
    var opts = props.options || [], st = useState(props.value != null ? props.value : (opts[0] && (opts[0].value || opts[0])));
    var val = st[0], set = st[1];
    return h("div", { className: cx("mx-seg", props.className), role: "radiogroup", "aria-label": props.label },
      opts.map(function (o) {
        var v = o.value || o, on = v === val;
        return h("button", { key: v, type: "button", role: "radio", "aria-checked": on, className: cx("mx-seg-item", on && "is-on"), onClick: function () { set(v); if (props.onChange) props.onChange(v); } },
          o.label || o, o.count != null ? h("span", { className: "mx-seg-count" }, o.count) : null);
      }));
  }

  function Toggle(props) {
    var st = useState(!!props.checked), on = st[0], set = st[1];
    return h("label", { className: cx("mx-toggle", props.className) },
      h("button", { type: "button", role: "switch", "aria-checked": on, className: cx("mx-toggle-track", on && "is-on"), onClick: function () { set(!on); } }, h("span", { className: "mx-toggle-thumb" })),
      props.label ? h("span", { className: "mx-toggle-label" }, props.label, props.hint ? h("small", null, props.hint) : null) : null);
  }

  function Checkbox(props) {
    var st = useState(!!props.checked), on = st[0], set = st[1];
    return h("label", { className: cx("mx-check", props.className) },
      h("button", { type: "button", role: "checkbox", "aria-checked": on, className: cx("mx-check-box", on && "is-on"), onClick: function () { set(!on); } }, on ? "✓" : ""),
      h("span", null, props.label));
  }

  /* ---------- containers ---------- */
  function Pane(props) {
    return h("section", { className: cx("mx-pane", props.focus && "is-focus", props.className), style: props.style },
      props.title ? h("span", { className: "mx-legend" }, props.title, props.meta ? h("span", { className: "mx-legend-meta" }, " · " + props.meta) : null) : null,
      props.children);
  }

  function Tabs(props) {
    var tabs = props.tabs || [], st = useState(props.value || (tabs[0] && tabs[0].id)), val = st[0], set = st[1];
    return h("div", { className: cx("mx-tabs", props.className), role: "tablist" },
      tabs.map(function (t) {
        var on = t.id === val;
        return h("button", { key: t.id, type: "button", role: "tab", "aria-selected": on, className: cx("mx-tab", on && "is-on"), onClick: function () { set(t.id); if (props.onChange) props.onChange(t.id); } },
          t.label, t.count != null ? h("span", { className: "mx-tab-count" }, t.count) : null);
      }));
  }

  function Dialog(props) {
    return h("div", { className: cx("mx-dialog", props.className), role: "dialog", "aria-label": props.title },
      h("span", { className: "mx-legend" }, props.title),
      h("div", { className: "mx-dialog-body" }, props.children),
      props.actions ? h("div", { className: "mx-dialog-actions" }, props.actions) : null);
  }

  function Menu(props) {
    return h("div", { className: cx("mx-menu", props.className), role: "menu" },
      (props.items || []).map(function (it, i) {
        if (it.divider) return h("div", { key: i, className: "mx-menu-div", role: "separator" });
        return h("button", { key: i, type: "button", role: "menuitem", className: cx("mx-menu-item", it.danger && "is-danger", it.active && "is-on") },
          h("span", null, it.label), it.kbd ? h(Kbd, null, it.kbd) : null);
      }));
  }

  function CommandBar(props) {
    var res = props.results || [];
    return h("div", { className: cx("mx-cmd", props.className), role: "combobox", "aria-expanded": true },
      h("div", { className: "mx-cmd-q" }, h("span", { className: "mx-cmd-caret" }, "›"), props.query ? h("span", null, props.query) : h("span", { className: "mx-cmd-ph" }, "Jump to anything in Moxen")),
      h("div", { className: "mx-cmd-list", role: "listbox" },
        res.map(function (r, i) {
          return h("div", { key: i, role: "option", "aria-selected": i === (props.active || 0), className: cx("mx-cmd-row", i === (props.active || 0) && "is-on") },
            h(Mark, { product: r.product, size: 14 }), h("span", { className: "mx-cmd-t" }, r.title), h("span", { className: "mx-cmd-k" }, i === (props.active || 0) ? "⏎" : r.kind || ""));
        })),
      h("div", { className: "mx-cmd-foot" }, h("span", null, h(Kbd, null, "↑↓"), " move"), h("span", null, h(Kbd, null, "⏎"), " open"), h("span", null, h(Kbd, null, "esc"), " close")));
  }

  /* ---------- feedback ---------- */
  function Chip(props) {
    return h("span", { className: cx("mx-chip", props.state && "is-" + props.state, props.className) },
      props.color ? h("i", { className: "mx-chip-dot", style: { background: "var(--label-" + props.color + ")" } }) : null,
      props.state ? h(StateGlyph, { state: props.state }) : null,
      h("span", null, props.children));
  }

  function Notice(props) {
    var s = props.state || "held";
    return h("div", { className: cx("mx-notice", "is-" + s, props.className), role: s === "broken" ? "alert" : "status" },
      h(StateGlyph, { state: s }),
      h("div", { className: "mx-notice-body" }, props.title ? h("b", null, props.title) : null, props.children ? h("span", null, props.children) : null),
      props.actions ? h("div", { className: "mx-notice-actions" }, props.actions) : null);
  }

  function Toast(props) {
    return h("div", { className: cx("mx-toast", props.className), role: "status" },
      props.state ? h(StateGlyph, { state: props.state }) : null,
      h("span", { className: "mx-toast-text" }, props.children),
      props.action ? h("button", { type: "button", className: "mx-toast-action" }, props.action) : null);
  }

  /* Furrow: progress as the mark's line. Each finished step is one half-turn of the plough.
     Drawn at its own pixel size so the stroke and the dots stay even at any width. */
  function Furrow(props) {
    var steps = Math.max(1, props.steps || 6), done = Math.min(props.done || 0, steps), live = props.live && done < steps;
    var seg = 34, pad = 6, H = 28, mid = 14, ry = 8, W = steps * seg + pad * 2, d = "M" + pad + " " + mid;
    for (var i = 0; i < done; i++) d += " A" + (seg / 2) + " " + ry + " 0 0 " + (i % 2 ? 0 : 1) + " " + (pad + seg * (i + 1)) + " " + mid;
    var hx = pad + done * seg, rest = hx + (live ? 10 : 6);
    return h("div", { className: cx("mx-furrow", props.className) },
      h("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, role: "img", "aria-label": done + " of " + steps + (live ? ", step " + (done + 1) + " running" : "") },
        done > 0 ? h("path", { className: "mx-furrow-done", d: d }) : null,
        rest < W - pad ? h("path", { className: "mx-furrow-todo", d: "M" + rest + " " + mid + " H" + (W - pad) }) : null,
        live ? h("rect", { className: "mx-furrow-head", x: hx - 4, y: mid - 4, width: 8, height: 8, rx: 2 })
             : done > 0 ? h("circle", { className: "mx-furrow-node", cx: hx, cy: mid, r: 3 }) : null),
      props.label || props.meta ? h("div", { className: "mx-furrow-cap" }, h("span", null, props.label || (done + " of " + steps)), h("span", { className: live ? "is-live" : "" }, props.meta || "")) : null);
  }

  function Meter(props) {
    var kind = props.kind || "bar", max = props.max || 1, v = Math.max(0, Math.min(props.value || 0, max));
    if (kind === "vu") {
      var n = props.segments || 12, lit = Math.round(v / max * n), cells = [];
      for (var i = 0; i < n; i++) cells.push(h("i", { key: i, className: cx(i < lit && "on", i < lit && i >= n * 0.75 && "hot", i < lit && i === n - 1 && "clip") }));
      return h("span", { className: cx("mx-vu", props.className), role: "meter", "aria-valuenow": v, "aria-valuemax": max, "aria-label": props.label || "level" }, cells);
    }
    var parts = props.parts || [{ value: v }];
    return h("div", { className: cx("mx-meter", props.className) },
      props.label ? h("div", { className: "mx-meter-top" }, h("span", null, props.label), h("span", null, props.valueLabel || "")) : null,
      h("div", { className: "mx-meter-track", role: "meter", "aria-valuenow": v, "aria-valuemax": max },
        parts.map(function (p, i) { return h("i", { key: i, className: "mx-meter-part is-" + Math.min(i, 2), style: { width: (p.value / max * 100) + "%", background: p.color || undefined }, title: p.label || undefined }); }),
        props.mark != null ? h("b", { className: "mx-meter-mark", style: { left: (props.mark / max * 100) + "%" } }) : null),
      props.note ? h("div", { className: "mx-meter-note" }, props.note) : null);
  }

  /* ---------- lists ---------- */
  function ListRow(props) {
    return h("div", { className: cx("mx-row", props.selected && "is-sel", props.depth && "is-sub", props.className), role: "option", "aria-selected": !!props.selected },
      props.leading != null ? h("span", { className: "mx-row-lead" }, props.leading) : props.state ? h("span", { className: "mx-row-lead" }, h(StateGlyph, { state: props.state })) : null,
      h("span", { className: "mx-row-main" }, h("span", { className: "mx-row-title" }, props.title), props.subtitle ? h("span", { className: "mx-row-sub" }, props.subtitle) : null),
      h("span", { className: "mx-row-meta" }, props.meta, props.count ? h("span", { className: "mx-count" }, props.count) : null));
  }

  /* Trail: what happened, in order, as a timeline. One glyph per entry on a single rule. */
  function Trail(props) {
    return h("ol", { className: cx("mx-trail", props.className) },
      (props.items || []).map(function (it, i) {
        var kind = it.kind || "step";
        var glyph = kind === "held" ? h(StateGlyph, { state: "held" }) : kind === "broken" ? h(StateGlyph, { state: "broken" }) : h("i");
        return h("li", { key: i, className: "is-" + kind },
          h("span", { className: "mx-trail-g", "aria-hidden": true }, glyph),
          h("span", { className: "mx-trail-o" }, it.who ? h("b", null, it.who + ": ") : null, it.text),
          h("span", { className: "mx-trail-x" }, it.meta || ""));
      }));
  }

  function PropList(props) {
    return h("dl", { className: cx("mx-props", props.className) },
      (props.items || []).map(function (it, i) { return [h("dt", { key: "k" + i }, it[0]), h("dd", { key: "v" + i }, it[1])]; }));
  }

  /* ---------- chat ---------- */
  function MessageGroup(props) {
    var who = props.who || {}, mine = !!props.mine, msgs = props.messages || [], reacts = props.reactions || [];
    return h("div", { className: cx("mx-mg", mine && "is-mine", props.className) },
      !mine ? h(Avatar, { kind: who.kind || "person", initials: who.initials, color: who.color, size: "sm" }) : null,
      h("div", { className: "mx-mg-col" },
        !mine && who.name ? h("span", { className: "mx-mg-name", style: who.color ? { color: "var(--label-" + who.color + ")" } : undefined }, who.name, props.time ? h("span", null, props.time) : null) : null,
        props.reply ? h("span", { className: "mx-mg-reply" }, props.reply) : null,
        msgs.map(function (m, i) {
          var last = i === msgs.length - 1;
          var bubble = h("span", { key: i, className: cx("mx-bubble", i > 0 && "joins-above", i < msgs.length - 1 && "joins-below") }, m);
          if (!last || !reacts.length) return bubble;
          return h("span", { key: i, className: "mx-bubble-wrap" }, bubble,
            h("span", { className: "mx-tapback" }, reacts.map(function (r, j) { return h("button", { key: j, type: "button", className: cx("mx-react", r.mine && "is-mine") }, r.emoji + (r.count > 1 ? " " + r.count : "")); })));
        }),
        props.receipt ? h("span", { className: "mx-mg-receipt" }, props.receipt) : null));
  }

  function SystemLine(props) {
    return h("div", { className: cx("mx-sysline", props.className), role: "note" },
      props.sealed ? h(Mark, { product: "chat", size: 12 }) : null, h("span", null, props.children));
  }

  function CallDock(props) {
    var st = useState(!!props.muted), muted = st[0], set = st[1];
    return h("div", { className: cx("mx-dock", props.className) },
      h("div", { className: "mx-dock-top" }, h("b", null, h(StateGlyph, { state: "live" }), " ", props.name), h("span", null, props.time + " · " + props.count + " in")),
      h("div", { className: "mx-dock-ctrls" },
        h("button", { type: "button", className: cx(muted && "is-off"), onClick: function () { set(!muted); }, "aria-pressed": muted }, muted ? "Muted" : "Mic"),
        h("button", { type: "button" }, "Cam"), h("button", { type: "button" }, "Share"),
        h("button", { type: "button", className: "is-leave" }, "Leave")));
  }

  function SafetyNumber(props) {
    var s = props.state || "held", groups = (props.digits || "").split(/\s+/);
    return h("div", { className: cx("mx-safety", "is-" + s, props.className) },
      h("div", { className: "mx-safety-head" }, h(StateGlyph, { state: s }), h("b", null, s === "done" ? props.name + " is verified" : props.name + " has a new device")),
      s !== "done" ? h("span", { className: "mx-safety-hint" }, "Compare these numbers with " + props.name + " in person or on a call before trusting it.") : null,
      h("div", { className: "mx-safety-digits" }, groups.map(function (g, i) { return h("span", { key: i }, g); })),
      s !== "done" ? h("div", { className: "mx-safety-actions" }, h(Button, { variant: "primary", size: "sm" }, "They match"), h(Button, { variant: "quiet", size: "sm" }, "Not now")) : null);
  }

  /* ---------- music ---------- */
  function TrackHeader(props) {
    var a = props.author || { kind: "person", initials: "?" };
    return h("div", { className: cx("mx-track", props.selected && "is-sel", props.className), style: { "--tc": "var(--label-" + (props.color || 8) + ")" } },
      h("span", { className: "mx-track-clr" }),
      h("div", { className: "mx-track-main" },
        h("span", { className: "mx-track-name" }, props.name),
        h("span", { className: "mx-track-inst" }, h(Avatar, { kind: a.kind, initials: a.initials, size: "xs" }), props.instrument)),
      h("div", { className: "mx-track-side" },
        h("div", { className: "mx-msr" },
          h("button", { type: "button", className: cx(props.mute && "is-m"), "aria-pressed": !!props.mute }, "M"),
          h("button", { type: "button", className: cx(props.solo && "is-s"), "aria-pressed": !!props.solo }, "S"),
          h("button", { type: "button", className: cx(props.rec && "is-r"), "aria-pressed": !!props.rec }, "R")),
        h(Meter, { kind: "vu", value: props.level || 0, segments: 8, label: props.name + " level" })));
  }

  var NOTE_SEED = 7;
  function seeded(seed) { var s = seed; return function () { s = (s * 9301 + 49297) % 233280; return s / 233280; }; }
  function Region(props) {
    var rnd = seeded(props.seed || NOTE_SEED), count = props.notes || 12, rows = props.rows || 5, notes = [];
    for (var i = 0; i < count; i++) {
      notes.push(h("i", { key: i, style: { left: f(i / count * 100 + rnd() * 2) + "%", top: f(8 + Math.floor(rnd() * rows) * (76 / rows)) + "%", width: f(Math.max(2, (props.noteLength || 6) * (0.6 + rnd() * 0.6))) + "%" } }));
    }
    var a = props.author;
    return h("div", { className: cx("mx-region", props.draft && "is-draft", props.className), style: Object.assign({ "--tc": "var(--label-" + (props.color || 8) + ")" }, props.style) },
      h("div", { className: "mx-region-head" }, props.draft && a ? h(Avatar, { kind: a.kind, initials: a.initials, size: "xs" }) : null, props.draft ? "draft · " + props.name : props.name),
      h("div", { className: "mx-region-notes" }, notes),
      props.draft && props.actions ? h("div", { className: "mx-region-actions" },
        h("span", { className: "mx-region-by" }, props.byline || ""), h("button", { type: "button", className: "is-keep" }, "Keep"), h("button", { type: "button" }, "Toss"), h("button", { type: "button" }, "Again")) : null);
  }

  function Counter(props) {
    return h("div", { className: cx("mx-counter", props.className) },
      [["bar · beat · div · tick", props.position || "1 . 1 . 1 . 001"], ["bpm", props.bpm || "120.00"], ["time", props.signature || "4/4"], ["key", props.musicalKey || "C maj"]].map(function (c, i) {
        return h("div", { key: i }, h("b", null, c[1]), h("small", null, c[0]));
      }));
  }

  /* ---------- board: the field ---------- */
  var STAGES = ["Open", "Picked up", "In review", "Checked", "Done"];
  var STAGE_X = [8, 29, 50, 71, 92];
  function FieldRow(props) {
    if (props.header) {
      return h("div", { className: cx("mx-frow", "is-head", props.className) }, h("span", null, "issue"),
        h("div", { className: "mx-frow-stages" }, (props.stages || STAGES).map(function (s, i) { return h("span", { key: i, style: { left: STAGE_X[i] + "%" } }, s); })),
        h("span", { className: "mx-frow-age" }, "age"));
    }
    var at = props.stage || 0, s = props.state || "queued", o = props.owner, parts = [];
    if (at > 0) parts.push(h("span", { key: "d", className: "mx-frow-done", style: { left: STAGE_X[0] + "%", width: (STAGE_X[at] - STAGE_X[0]) + "%" } }));
    if (at < 4) parts.push(h("span", { key: "t", className: "mx-frow-todo", style: { left: STAGE_X[at] + "%", width: (STAGE_X[4] - STAGE_X[at]) + "%" } }));
    for (var i = 0; i < 5; i++) if (i !== at) parts.push(h("span", { key: "n" + i, className: cx("mx-frow-node", i > at && "is-future"), style: { left: STAGE_X[i] + "%" } }));
    parts.push(h("span", { key: "c", className: cx("mx-frow-cur", "is-" + s), style: { left: STAGE_X[at] + "%" } }, s === "live" ? h("i", null) : h(StateGlyph, { state: s })));
    return h("div", { className: cx("mx-frow", props.selected && "is-sel", props.className) },
      h("div", { className: "mx-frow-issue" }, h("span", { className: "mx-frow-id" }, props.id), h("span", { className: "mx-frow-title" }, props.title),
        o ? h(Avatar, { kind: o.kind, initials: o.initials, size: "sm", live: s === "live" && o.kind === "agent" }) : h(Avatar, { empty: true, size: "sm" })),
      h("div", { className: "mx-frow-track", role: "img", "aria-label": (STATES[s] || STATES.queued).word + ", " + STAGES[at] }, parts),
      h("span", { className: "mx-frow-age" }, props.age || ""));
  }


  /* Kanban: Board's Columns view. Columns are panes with their name in the border; cards drag
     between them (or Alt+Left/Right from the keyboard). The card's state glyph rides in its corner. */
  function cloneCols(cols) { return (cols || []).map(function (c) { return Object.assign({}, c, { cards: (c.cards || []).slice() }); }); }
  function Kanban(props) {
    var st = useState(function () { return cloneCols(props.columns); }), cols = st[0], set = st[1];
    var ov = useState(null), over = ov[0], setOver = ov[1];
    var dragId = useRef(null);
    function move(cardId, toId) {
      var from = null;
      set(function (prev) {
        var card = null;
        var next = prev.map(function (c) {
          var i = -1;
          c.cards.forEach(function (k, j) { if (k.id === cardId) i = j; });
          if (i < 0) return c;
          card = c.cards[i]; from = c.id;
          return Object.assign({}, c, { cards: c.cards.filter(function (k) { return k.id !== cardId; }) });
        });
        if (!card || from === toId) return prev;
        return next.map(function (c) { return c.id === toId ? Object.assign({}, c, { cards: c.cards.concat([card]) }) : c; });
      });
      if (props.onMove) props.onMove(cardId, toId);
    }
    function neighbour(colIndex, step) { var c = cols[colIndex + step]; return c ? c.id : null; }
    return h("div", { className: cx("mx-kanban", props.className), role: "list", "aria-label": props.label || "Board columns" },
      cols.map(function (col, ci) {
        var n = col.cards.length, overLimit = col.limit != null && n > col.limit;
        return h("section", {
          key: col.id, className: cx("mx-kcol", over === col.id && "is-over"),
          onDragOver: function (e) { e.preventDefault(); if (over !== col.id) setOver(col.id); },
          onDragLeave: function (e) { if (!e.currentTarget.contains(e.relatedTarget)) setOver(null); },
          onDrop: function (e) { e.preventDefault(); setOver(null); if (dragId.current) move(dragId.current, col.id); dragId.current = null; }
        },
          h("span", { className: "mx-legend" }, col.title,
            h("span", { className: cx("mx-kcol-count", overLimit && "is-over-limit") }, " · " + n + (col.limit != null ? " / " + col.limit : ""))),
          h("div", { className: "mx-kcol-cards", role: "list" },
            n === 0 ? h("div", { className: "mx-kcol-empty" }, props.emptyText || "Nothing here yet") : null,
            col.cards.map(function (k) {
              var s = k.state || "queued", o = k.owner;
              return h("div", {
                key: k.id, role: "listitem", tabIndex: 0, draggable: true,
                className: cx("mx-kcard", "is-" + s, k.selected && "is-sel"),
                "aria-label": k.id + ", " + (typeof k.title === "string" ? k.title : "") + ", " + (STATES[s] || STATES.queued).word,
                onDragStart: function (e) { dragId.current = k.id; try { e.dataTransfer.setData("text/plain", k.id); e.dataTransfer.effectAllowed = "move"; } catch (err) {} },
                onDragEnd: function () { dragId.current = null; setOver(null); },
                onKeyDown: function (e) {
                  if (!e.altKey) return;
                  var to = e.key === "ArrowRight" ? neighbour(ci, 1) : e.key === "ArrowLeft" ? neighbour(ci, -1) : null;
                  if (to) { e.preventDefault(); move(k.id, to); }
                }
              },
                h("div", { className: "mx-kcard-top" }, h("span", { className: "mx-kcard-id" }, k.id), h(StateGlyph, { state: s })),
                h("div", { className: "mx-kcard-title" }, k.title),
                k.labels && k.labels.length ? h("div", { className: "mx-kcard-labels" }, k.labels.map(function (l, i) { return h(Chip, { key: i, color: l.color }, l.text); })) : null,
                h("div", { className: "mx-kcard-foot" },
                  o ? h(Avatar, { kind: o.kind, initials: o.initials, size: "sm", live: s === "live" && o.kind === "agent" }) : h(Avatar, { empty: true, size: "sm" }),
                  h("span", { className: "mx-kcard-who" }, o ? o.name || "" : "unassigned"),
                  h("span", { className: "mx-kcard-meta" }, k.meta || "")));
            })));
      }));
  }

  /* ---------- dispatch ---------- */
  function EditionHeader(props) {
    return h("header", { className: cx("mx-edition", props.className) },
      h("div", { className: "mx-edition-line" }, h("span", null, h(Mark, { product: "dispatch", size: 12 }), " Edition " + props.number), h("span", null, props.date + (props.minutes ? " · " + props.minutes + " min" : ""))),
      h("h2", { className: "mx-edition-title" }, props.title),
      props.dek ? h("p", { className: "mx-edition-dek" }, props.dek) : null,
      props.sources ? h("div", { className: "mx-edition-src" }, props.stories + " stories · " + props.sources + " sources") : null);
  }
  function Citation(props) {
    return h("div", { className: cx("mx-cite", props.className) },
      h("span", { className: "mx-cite-n" }, props.n), h("span", { className: "mx-cite-src" }, props.source), h("span", { className: "mx-cite-date" }, props.date));
  }

  /* ---------- Agent ---------- */

  /* Steps: what an agent did, one line per step, thoughts included. Click a step for its output. */
  var STEP_ICON = {
    read: h("svg", { viewBox: "0 0 24 24", width: 14, height: 14, fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" }), h("path", { d: "M14 2v4a2 2 0 0 0 2 2h4" }), h("path", { d: "M16 13H8" }), h("path", { d: "M16 17H8" })),
    edit: h("svg", { viewBox: "0 0 24 24", width: 14, height: 14, fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" })),
    command: "$", thought: "✻", other: "·"
  };
  function Steps(props) {
    var items = props.items || [];
    var st = useState(function () { var o = {}; (props.open || []).forEach(function (k) { o[k] = true; }); return o; }), open = st[0], setOpen = st[1];
    var fold = useState(!!props.collapsed), folded = fold[0], setFolded = fold[1];
    var rows = items.map(function (it, i) {
      var key = it.id != null ? it.id : i, kind = it.kind || "other", on = !!open[key], can = it.body != null;
      var icon = it.state === "live" ? h(StateGlyph, { state: "live" }) : it.state === "broken" ? h(StateGlyph, { state: "broken" }) : STEP_ICON[kind] || STEP_ICON.other;
      return h(React.Fragment, { key: key },
        h("button", { type: "button", className: cx("mx-step", "is-" + kind, on && "is-open", it.state && "is-" + it.state), "aria-expanded": can ? on : undefined, disabled: !can,
          onClick: function () { var n = Object.assign({}, open); n[key] = !on; setOpen(n); } },
          h("span", { className: "mx-step-icon" }, icon),
          h("span", { className: "mx-step-verb" }, it.verb),
          h("span", { className: "mx-step-target" }, it.target),
          h("span", { className: "mx-step-meta" }, it.meta || "")),
        on && can ? h("div", { className: "mx-step-body" }, it.body) : null);
    });
    return h("div", { className: cx("mx-steps", props.className) },
      props.summary ? h("button", { type: "button", className: "mx-steps-sum", "aria-expanded": !folded, onClick: function () { setFolded(!folded); } },
        h("span", { className: "mx-steps-chev", "aria-hidden": true }, folded ? "›" : "⌄"), props.summary) : null,
      folded ? null : h("div", { className: "mx-steps-list" }, rows));
  }

  /* Command: a shell command with Moxen's syntax colours. Pass parts as [text, kind] with kind c (command), s (string), f (flag) or nothing. */
  function Command(props) {
    return h("span", { className: cx("mx-command", props.className) }, (props.parts || []).map(function (p, i) {
      return h("span", { key: i, className: p[1] ? "is-" + p[1] : undefined }, p[0]);
    }));
  }

  /* TaskList: an agent's plan. A segment strip for progress, then the list. */
  function TaskList(props) {
    var tasks = props.tasks || [], done = tasks.filter(function (t) { return t.state === "done"; }).length;
    return h("section", { className: cx("mx-tasks", props.className), "aria-label": props.title || "Tasks" },
      h("div", { className: "mx-tasks-head" },
        h("b", null, props.title || "Tasks"),
        h("span", { className: "mx-tasks-count" }, done + " of " + tasks.length),
        h("span", { className: "mx-tasks-strip", "aria-hidden": true }, tasks.map(function (t, i) { return h("i", { key: i, className: "is-" + (t.state || "queued") }); }))),
      h("ul", { className: "mx-tasks-list" }, tasks.map(function (t, i) {
        return h("li", { key: i, className: "is-" + (t.state || "queued") }, h(StateGlyph, { state: t.state || "queued" }), h("span", null, t.text), h("span", { className: "mx-tasks-meta" }, t.meta || ""));
      })));
  }

  /* ModelPicker: model and effort as one pill, opening one small popover. */
  function ModelPicker(props) {
    var groups = props.groups || [], efforts = props.efforts || ["Low", "Medium", "High", "Extra", "Max"];
    var o = useState(!!props.open), isOpen = o[0], setOpen = o[1];
    var m = useState(props.value), model = m[0], setModel = m[1];
    var e = useState(props.effort || "Medium"), effort = e[0], setEffort = e[1];
    var q = useState(""), query = q[0], setQuery = q[1];
    var current = null;
    groups.forEach(function (g) { (g.models || []).forEach(function (x) { if (x.id === model) current = { name: x.name, color: g.color }; }); });
    current = current || { name: "Choose a model", color: "var(--ink-2)" };
    var needle = query.trim().toLowerCase();
    return h("div", { className: cx("mx-mpick", props.className) },
      isOpen ? h("div", { className: "mx-mpick-pop", role: "dialog", "aria-label": "Model and effort" },
        h("label", { className: "mx-mpick-search" }, h("span", { className: "mx-sr" }, "Search models"),
          h("input", { type: "text", placeholder: "Search models", value: query, onChange: function (ev) { setQuery(ev.target.value); } })),
        groups.map(function (g) {
          var ms = (g.models || []).filter(function (x) { return !needle || x.name.toLowerCase().indexOf(needle) >= 0; });
          if (!ms.length) return null;
          return h("div", { key: g.name, className: "mx-mpick-group" },
            h("div", { className: "mx-mpick-head" }, h("i", { style: { background: g.color } }), g.name),
            ms.map(function (x) {
              return h("button", { key: x.id, type: "button", className: cx("mx-mpick-row", x.id === model && "is-on"), onClick: function () { setModel(x.id); if (props.onChange) props.onChange(x.id); } },
                h("span", { className: "mx-mpick-name" }, x.name), h("span", { className: "mx-mpick-meta" }, x.meta || ""), h("span", { className: "mx-mpick-check" }, x.id === model ? "✓" : ""));
            }));
        }),
        h("div", { className: "mx-mpick-effort" }, h("span", null, "Effort"),
          h(Segmented, { options: efforts, value: effort, label: "Effort", onChange: function (v) { setEffort(v); if (props.onEffort) props.onEffort(v); } }))) : null,
      h("button", { type: "button", className: cx("mx-mpick-pill", isOpen && "is-open"), "aria-expanded": isOpen, title: "Model and effort  ⌘M", onClick: function () { setOpen(!isOpen); } },
        h("i", { style: { background: current.color } }),
        h("span", { className: "mx-mpick-model", style: { color: current.color } }, current.name),
        h("span", { className: "mx-mpick-eff" }, effort),
        h("span", { className: "mx-mpick-chev", "aria-hidden": true }, "⌄")));
  }

  /* Pause: a thread that stopped on a limit, how long it waited, and when it went on. */
  function Pause(props) {
    return h("div", { className: cx("mx-pause", props.className) },
      h("div", { className: "mx-pause-stop", role: "status" },
        h(StateGlyph, { state: "broken" }), h("b", null, props.title || "Usage limit reached"),
        h("span", { className: "mx-pause-detail" }, props.detail || ""), h("span", { className: "mx-pause-time" }, props.at || "")),
      props.paused ? h("div", { className: "mx-pause-gap" }, h("i"), h("span", null, props.paused)) : null,
      props.resumed ? h("div", { className: "mx-pause-go" }, h("span", { className: "mx-pause-icon", "aria-hidden": true }, "↻"), h("b", null, props.resumed), h("span", { className: "mx-pause-time" }, props.resumedAt || "")) : null);
  }

  /* ---------- Chat ---------- */

  /* Lucide paths at 1.5px, the desktop icon set. Internal: components take icons by name. */
  var ICON = {
    chat: ["M7.9 20A9 9 0 1 0 4 16.1L2 22Z"],
    phone: ["M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384"],
    people: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "M22 21v-2a4 4 0 0 0-3-3.87", "M16 3.13a4 4 0 0 1 0 7.75", "circle:9,7,4"],
    settings: ["M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z", "circle:12,12,3"],
    mic: ["M12 19v3", "M19 10v2a7 7 0 0 1-14 0v-2", "rect:9,2,6,13,3"],
    video: ["m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5", "rect:2,6,14,12,2"],
    share: ["m9 10 3-3 3 3", "M12 13V7", "M12 17v4", "M8 21h8", "rect:2,3,20,14,2"],
    add: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "M19 8v6", "M22 11h-6", "circle:9,7,4"],
    leave: ["M10.1 13.9a14 14 0 0 0 3.732 2.668 1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2 18 18 0 0 1-12.728-5.272", "M22 2 2 22", "M4.76 13.582A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 .244.473"],
    plus: ["M5 12h14", "M12 5v14"],
    smile: ["M8 14s1.5 2 4 2 4-2 4-2", "M9 9h.01", "M15 9h.01", "circle:12,12,10"],
    up: ["m5 12 7-7 7 7", "M12 19V5"]
  };
  function Icon(props) {
    var parts = ICON[props.name] || [], s = props.size || 18;
    return h("svg", { width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: props.stroke || 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
      parts.map(function (d, i) {
        if (d.indexOf("circle:") === 0) { var c = d.slice(7).split(","); return h("circle", { key: i, cx: c[0], cy: c[1], r: c[2] }); }
        if (d.indexOf("rect:") === 0) { var r = d.slice(5).split(","); return h("rect", { key: i, x: r[0], y: r[1], width: r[2], height: r[3], rx: r[4] }); }
        return h("path", { key: i, d: d });
      }));
  }

  /* NavRail: the window's left edge in Chat. Where you are, then you. */
  function NavRail(props) {
    var st = useState(props.value || (props.items && props.items[0] && props.items[0].id)), val = st[0], set = st[1];
    return h("nav", { className: cx("mx-rail", props.className), "aria-label": props.label || "Sections" },
      (props.items || []).map(function (it) {
        var on = it.id === val;
        return h("button", { key: it.id, type: "button", className: cx("mx-rail-item", on && "is-on"), "aria-current": on ? "page" : undefined, title: it.label, onClick: function () { set(it.id); if (props.onChange) props.onChange(it.id); } },
          h(Icon, { name: it.icon, size: 20, stroke: 1.7 }), h("span", null, it.label), it.count ? h("b", { className: "mx-rail-count" }, it.count) : null);
      }),
      h("span", { className: "mx-rail-gap" }),
      props.footer || null);
  }

  /* ConversationRow: a conversation in the list. Two lines of preview, unread as a count in the row. */
  function ConversationRow(props) {
    var people = props.people || [];
    var face = people.length > 1
      ? h("span", { className: "mx-crow-pair" }, h(Avatar, { initials: people[0].initials, color: people[0].color }), h(Avatar, { initials: people[1].initials, color: people[1].color }))
      : h(Avatar, { initials: people[0] && people[0].initials, color: people[0] && people[0].color, size: "lg" });
    return h("button", { type: "button", className: cx("mx-crow", props.selected && "is-sel", props.unread && "is-unread", props.className), "aria-current": props.selected ? "true" : undefined },
      face,
      h("span", { className: "mx-crow-main" },
        h("span", { className: "mx-crow-top" }, h("b", null, props.name), props.state ? h(StateGlyph, { state: props.state }) : null, h("span", { className: "mx-crow-time" }, props.time || "")),
        h("span", { className: "mx-crow-bot" },
          h("span", { className: cx("mx-crow-pv", props.call && "is-live") }, props.preview || ""),
          props.call ? h("span", { className: "mx-crow-join" }, h(Icon, { name: "video", size: 12, stroke: 2.2 }), "Join") : null,
          props.unread ? h("span", { className: "mx-crow-count" }, props.unread) : null)));
  }

  /* VoiceNote: a recorded message in a bubble. Play, the waveform, the time, and its transcript. */
  var WAVE = [6, 10, 16, 22, 14, 9, 18, 26, 20, 12, 8, 14, 24, 28, 18, 10, 6, 12, 20, 16, 9, 14, 22, 12, 7, 10, 18, 24, 15, 8, 5, 9];
  function VoiceNote(props) {
    var p = useState(!!props.playing), on = p[0], set = p[1];
    var played = on ? (props.played != null ? props.played : 0.45) : 0, bars = props.bars || WAVE, cut = Math.round(bars.length * played);
    return h("span", { className: cx("mx-voice", props.mine && "is-mine", props.className) },
      h("span", { className: "mx-voice-row" },
        h("button", { type: "button", className: "mx-voice-play", "aria-label": on ? "Pause voice note" : "Play voice note", onClick: function () { set(!on); } },
          on ? h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "currentColor" }, h("rect", { x: 5, y: 4, width: 5, height: 16, rx: 1.5 }), h("rect", { x: 14, y: 4, width: 5, height: 16, rx: 1.5 }))
             : h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "currentColor" }, h("path", { d: "M6 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L7.5 3.64A1 1 0 0 0 6 4.5z" }))),
        h("span", { className: "mx-voice-wave", "aria-hidden": true }, bars.map(function (b, i) { return h("i", { key: i, className: i < cut ? "is-played" : undefined, style: { height: b + "px" } }); })),
        h("span", { className: "mx-voice-time" }, props.duration || "")),
      props.transcript ? h("span", { className: "mx-voice-text" }, props.transcript) : null);
  }

  /* ChatComposer: the message field. Attach, the pill, emoji, and a mic that turns into send once there is text. */
  function ChatComposer(props) {
    var st = useState(""), text = st[0], set = st[1];
    return h("div", { className: cx("mx-ccomp", props.className) },
      h("button", { type: "button", className: "mx-ccomp-add", "aria-label": "Attach a photo or file" }, h(Icon, { name: "plus", size: 18, stroke: 2 })),
      h("label", { className: "mx-ccomp-field" },
        h("span", { className: "mx-sr" }, "Message"),
        h("input", { type: "text", placeholder: props.placeholder || "Message", value: text, onChange: function (e) { set(e.target.value); }, onKeyDown: function (e) { if (e.key === "Enter" && text) { if (props.onSend) props.onSend(text); set(""); } } }),
        h("button", { type: "button", className: "mx-ccomp-icon", "aria-label": "Emoji" }, h(Icon, { name: "smile" })),
        text ? h("button", { type: "button", className: "mx-ccomp-send", "aria-label": "Send", onClick: function () { if (props.onSend) props.onSend(text); set(""); } }, h(Icon, { name: "up", size: 15, stroke: 2.4 }))
             : h("button", { type: "button", className: "mx-ccomp-icon", "aria-label": "Record a voice note", title: "Hold to record" }, h(Icon, { name: "mic" }))));
  }

  /* CallStage: screens on top, people underneath, and the controls hidden until you point at the call. */
  function CallStage(props) {
    var m = useState(!!props.muted), muted = m[0], setMuted = m[1];
    var c = useState(props.camera !== false), cam = c[0], setCam = c[1];
    var people = props.people || [];
    return h("section", { className: cx("mx-stage", props.className), "aria-label": "Call" },
      props.screen ? h("div", { className: "mx-stage-screen" }, props.screen, props.screenLabel ? h("span", { className: "mx-stage-tag" }, h(Icon, { name: "share", size: 13, stroke: 2 }), props.screenLabel) : null) : null,
      h("div", { className: "mx-stage-people" }, people.map(function (p, i) {
        return h("div", { key: i, className: cx("mx-stage-tile", p.speaking && "is-speaking") },
          p.video || h(Avatar, { initials: p.initials, color: p.color, size: "lg" }),
          h("span", { className: "mx-stage-tag" }, p.name, p.muted ? h("span", { className: "mx-stage-muted", "aria-label": "muted" }, "✕") : null));
      })),
      h("div", { className: "mx-callbar", role: "toolbar", "aria-label": "Call controls" },
        h("button", { type: "button", className: cx(muted && "is-off"), "aria-pressed": muted, "aria-label": muted ? "Unmute" : "Mute", onClick: function () { setMuted(!muted); } }, h(Icon, { name: "mic", size: 20, stroke: 1.8 })),
        h("button", { type: "button", className: cx(!cam && "is-off"), "aria-pressed": !cam, "aria-label": cam ? "Turn camera off" : "Turn camera on", onClick: function () { setCam(!cam); } }, h(Icon, { name: "video", size: 20, stroke: 1.8 })),
        h("button", { type: "button", "aria-label": "Share your screen" }, h(Icon, { name: "share", size: 20, stroke: 1.8 })),
        h("button", { type: "button", "aria-label": "Add people" }, h(Icon, { name: "add", size: 20, stroke: 1.8 })),
        h("button", { type: "button", className: "is-leave", "aria-label": "Leave call", onClick: props.onLeave }, h(Icon, { name: "leave", size: 22, stroke: 1.9 }))));
  }

  var api = {
    Mark: Mark, Wordmark: Wordmark, StateGlyph: StateGlyph, Delta: Delta,
    Avatar: Avatar, AvatarStack: AvatarStack, Button: Button, Kbd: Kbd,
    TextField: TextField, Composer: Composer, Segmented: Segmented, Toggle: Toggle, Checkbox: Checkbox,
    Pane: Pane, Tabs: Tabs, Dialog: Dialog, Menu: Menu, CommandBar: CommandBar,
    Chip: Chip, Notice: Notice, Toast: Toast, Furrow: Furrow, Meter: Meter,
    ListRow: ListRow, Trail: Trail, PropList: PropList,
    Steps: Steps, Command: Command, TaskList: TaskList, ModelPicker: ModelPicker, Pause: Pause,
    Icon: Icon, NavRail: NavRail, ConversationRow: ConversationRow, VoiceNote: VoiceNote, ChatComposer: ChatComposer, CallStage: CallStage,
    MessageGroup: MessageGroup, SystemLine: SystemLine, CallDock: CallDock, SafetyNumber: SafetyNumber,
    TrackHeader: TrackHeader, Region: Region, Counter: Counter, FieldRow: FieldRow, Kanban: Kanban,
    EditionHeader: EditionHeader, Citation: Citation,
    marks: MARKS, markPath: markPath, states: STATES, stages: STAGES
  };
  window.Moxen = Object.assign(window.Moxen || {}, api);
})();
