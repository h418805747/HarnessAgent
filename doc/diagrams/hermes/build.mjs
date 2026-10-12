import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as k from "./kit/iso-kit.mjs";
import { kitScript } from "./scripts/inline-kit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const theme = process.argv.includes("--light") ? "light" : "dark";

const WIDTH = 820;
const HEIGHT = 500;

const BASE = { x: -160, y: -80, w: 320, d: 160, r: 10 };
const BASE_H = 12;
const FOOT_H = 5;

const CONSOLE = { x: -140, y: -56, w: 100, d: 112, r: 6 };
const CONSOLE_H = 16;
const TOP = CONSOLE_H;

const COLS = [-120, -95, -70];
const ROWS = [-38, -16, 6, 28];
const JACK_R = 3.1;

const DESK_X = [62, 102, 142];
const DESK_W = 30;
const DESK_D = 44;

const DIAL_POS = [150, -64];
const DIAL_R = 9;
const DIAL_H = 5;
const DIAL_TOP = DIAL_H;

const GANTRY_Z = 56;
const BEAM_TOP = GANTRY_Z + 6.4;
const CARRIAGE_Z = BEAM_TOP;
const PROBE_TIP_Z = 17;

const PLATFORMS = ["TELEGRAM", "DISCORD", "SLACK"];
const LABELS = ["TG", "DC", "SL"];
const KEYS = ["telegram:42:7", "discord:88:2", "slack:15:9"];
const CACHE = [1, 2, 3];

const P = k.fitProjection(
  [
    ...k.boxCorners(BASE, -BASE_H - FOOT_H, 0),
    [-136, 0, BEAM_TOP + 8],
    [DESK_X[2] + DESK_W / 2, 0, 34],
    [DIAL_POS[0] + DIAL_R, DIAL_POS[1], DIAL_TOP],
  ],
  WIDTH,
  HEIGHT,
  { pad: 36, azimuth: 42 },
);

const at = (point) => k.iso(point, P);
const S = (paths, style) => k.solidSvg(paths, style);
const L = (d, style) => k.lineSvg(d, style);
const D = (points, style) => k.dotsSvg(points, style);
const byDepth = (points) =>
  [...points].sort(
    (a, b) => k.depthOf([a[0], a[1], 0], P) - k.depthOf([b[0], b[1], 0], P),
  );

function base() {
  const out = [
    `<path class="iso-halo" d="${k.haloOf(BASE, -BASE_H - FOOT_H, BASE_H, P)}"/>`,
  ];
  for (const [x, y] of byDepth(k.corners(BASE, 26))) {
    out.push(S(k.cylinder(x, y, 7, -BASE_H - FOOT_H, 1.6, P, 28), { tone: "lo" }));
    out.push(
      S(k.cylinder(x, y, 5.4, -BASE_H - FOOT_H + 1.6, FOOT_H - 1.6, P, 28), {
        tone: "mid",
      }),
    );
  }
  out.push(S(k.slabOf(BASE, -BASE_H, BASE_H, P, 8, 1.6), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(BASE, 5), 0, P), { tone: "lo" }));

  const screws = k.corners(BASE, 11);
  out.push(
    L(screws.map(([x, y]) => k.ring(x, y, 2.2, 0, P, 16)).join(""), { tone: "lo" }),
  );
  out.push(D(screws.map(([x, y]) => at([x, y, 0])), { size: 0.5 }));

  const strip = { x: BASE.x + 12, y: BASE.y + 6, w: BASE.w - 24, d: 7, r: 1 };
  out.push(S(k.slabOf(strip, 0, 0.6, P, 3), { tone: "lo", crease: "none" }));
  const ticks = k.topTicks(
    strip.x + 4,
    strip.x + strip.w - 4,
    4,
    5,
    strip.y + 0.8,
    0.6,
    [2, 3.6],
    P,
  );
  out.push(L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid" }));

  return out.join("");
}

function consoleBody() {
  const out = [];
  out.push(S(k.slabOf(CONSOLE, 0, CONSOLE_H, P, 8, 1.2), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(CONSOLE, 4), TOP, P), { tone: "faint" }));

  for (let c = 0; c < 3; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      const x = COLS[c];
      const y = ROWS[r];
      out.push(L(k.ring(x, y, JACK_R, TOP, P, 18), { tone: "lo" }));
      out.push(D([at([x, y, TOP])], { size: 0.5, tone: "mid" }));
    }

    out.push(
      `<g data-signal="${c}" style="opacity:.12">${L(
        k.ring(COLS[c], ROWS[3], 6.2, TOP, P, 24),
        { tone: "red" },
      )}</g>`,
    );

    const label = { x: COLS[c] - 11, y: 43, w: 22, d: 5.5, r: 1 };
    out.push(S(k.slabOf(label, TOP, 0.8, P, 3, 0.2), { tone: "lo", crease: "none" }));
    out.push(
      k.faceTextSvg(
        k.topMatrix([COLS[c], 46.2], TOP + 0.8, P, "x"),
        LABELS[c],
        { size: 6.0, tone: "hi", anchor: "middle" },
      ),
    );
  }

  return out.join("");
}

function backboard() {
  const out = [];
  const board = { x: -134, y: -56, w: 90, d: 3.5, r: 1.5 };
  out.push(S(k.slabOf(board, TOP, 32, P, 4, 0.4), { tone: "mid" }));
  out.push(
    S(k.slabOf({ x: -134, y: -56.6, w: 90, d: 4.7, r: 1.5 }, TOP + 32, 2, P, 3, 0.3), {
      tone: "hi",
    }),
  );

  for (const z of [TOP + 7, TOP + 15, TOP + 23]) {
    for (const x of [-126, -112, -98, -84, -70]) {
      out.push(L(k.sideRing([x, -52.4, z], 1.8, "y", P, 14), { tone: "lo" }));
      out.push(D([at([x, -52.4, z])], { size: 0.35, tone: "mid" }));
    }
  }

  const drops = [
    { a: [-126, -52.4, TOP + 23], b: [-98, -52.4, TOP + 7], sag: 7 },
    { a: [-98, -52.4, TOP + 15], b: [-70, -52.4, TOP + 23], sag: 6 },
    { a: [-112, -52.4, TOP + 7], b: [-84, -52.4, TOP + 15], sag: 5 },
  ];
  for (const drop of drops) {
    out.push(
      k.wireSvg(at(drop.a), at(drop.b), {
        via: [
          at([
            (drop.a[0] + drop.b[0]) / 2,
            -52.4 + drop.sag,
            Math.min(drop.a[2], drop.b[2]) - 4,
          ]),
        ],
        tone: "lo",
        size: 1.0,
      }),
    );
  }

  return out.join("");
}

function gantry() {
  const out = [];
  for (const x of [-136, -44]) {
    out.push(S(k.cylinder(x, 0, 4.6, TOP, 4, P, 24), { tone: "mid" }));
    out.push(
      S(k.cylinder(x, 0, 3.4, TOP + 4, GANTRY_Z - TOP - 4, P, 24), {
        tone: "mid",
        crease: "none",
      }),
    );
    out.push(L(k.sideArc(x, 0, 3.4, 30, P, 16), { tone: "faint" }));
    out.push(L(k.sideArc(x, 0, 3.4, 44, P, 16), { tone: "faint" }));
    out.push(S(k.cylinder(x, 0, 4.4, GANTRY_Z, 2.4, P, 24), { tone: "mid" }));
  }

  out.push(
    S(k.slabOf({ x: -136, y: -3.6, w: 92, d: 7.2, r: 2 }, GANTRY_Z + 2.4, 4, P, 4, 0.6), {
      tone: "mid",
    }),
  );
  out.push(L(k.lineOnTop([-132, 0], [-48, 0], BEAM_TOP, P), { tone: "faint" }));
  out.push(
    D([at([-134, 0, BEAM_TOP]), at([-46, 0, BEAM_TOP])], { size: 0.45, tone: "lo" }),
  );

  return out.join("");
}

function carriage() {
  const out = [];
  out.push(
    S(k.slabOf({ x: -7, y: -6, w: 14, d: 12, r: 2.5 }, CARRIAGE_Z, 7, P, 4, 0.6), {
      tone: "hi",
    }),
  );
  out.push(
    D([at([-5, 4, CARRIAGE_Z + 7]), at([5, 4, CARRIAGE_Z + 7])], {
      size: 0.45,
      tone: "lo",
    }),
  );
  out.push(S(k.cylinder(0, 0, 4.4, CARRIAGE_Z - 2, 2.4, P, 24), { tone: "mid" }));
  out.push(
    S(
      k.cylinder(0, 0, 1.6, PROBE_TIP_Z + 2, CARRIAGE_Z - PROBE_TIP_Z - 2, P, 16),
      { tone: "hi", crease: "none", lit: true },
    ),
  );
  out.push(S(k.cylinder(0, 0, 2.8, PROBE_TIP_Z, 2.2, P, 20), { tone: "hi", lit: true }));
  out.push(L(k.ring(0, 0, 3.2, PROBE_TIP_Z + 2.2, P, 20), { tone: "red" }));
  return out.join("");
}

function desk(cx, index) {
  const out = [];
  const x0 = cx - DESK_W / 2;
  const y0 = -DESK_D / 2;

  out.push(
    S(k.slabOf({ x: x0, y: y0, w: DESK_W, d: DESK_D, r: 3 }, 0, 5, P, 5, 0.6), {
      tone: "mid",
    }),
  );
  out.push(
    S(k.slabOf({ x: x0 + 2, y: y0, w: DESK_W - 4, d: 4, r: 1.5 }, 5, 30, P, 3, 0.5), {
      tone: "mid",
    }),
  );

  for (const z of [20, 27]) {
    out.push(
      S(k.slabOf({ x: cx - 11, y: y0 + 3, w: 22, d: 2.6, r: 0.8 }, z, 1.2, P, 3, 0.3), {
        tone: "hi",
        crease: "lo",
      }),
    );
  }

  out.push(S(k.cylinder(cx, 6, 7, 5, 3.4, P, 28), { tone: "mid" }));
  out.push(S(k.cylinder(cx, 6, 4.8, 8.4, 4.8, P, 28), { tone: "hi", crease: "lo" }));
  out.push(
    `<g data-active="${index}" style="opacity:.06;stroke-width:2">${S(
      k.cylinder(cx + 10, 6, 1.1, 5, 15, P, 12),
      { tone: "hi" },
    )}${S(
      k.slabOf({ x: cx + 10, y: 4.4, w: 7, d: 2.2, r: 0.5 }, 20, 3.6, P, 3, 0.2),
      { tone: "hi" },
    )}${L(k.ring(cx, 6, 8.2, 5.2, P, 32), { tone: "red" })}${L(
      k.ring(cx, 6, 5.6, 13.6, P, 28),
      { tone: "red" },
    )}${D([at([cx, 6, 13.8])], { size: 1.6, tone: "red" })}</g>`,
  );

  out.push(
    S(k.slabOf({ x: cx - 8, y: 11.5, w: 16, d: 4, r: 1 }, 5, 0.7, P, 3, 0.2), {
      tone: "lo",
      crease: "none",
    }),
  );
  out.push(
    S(k.slabOf({ x: cx - 7, y: 12.5, w: 14, d: 3, r: 0.8 }, 5.7, 0.6, P, 3, 0.2), {
      tone: "lo",
      crease: "none",
    }),
  );

  const plate = { x: cx - 9, y: 16.5, w: 18, d: 5, r: 1 };
  out.push(S(k.slabOf(plate, 5, 0.7, P, 3, 0.2), { tone: "lo", crease: "none" }));
  out.push(
    k.faceTextSvg(
      k.topMatrix([cx, 19], 5.7, P, "x"),
      LABELS[index],
      { size: 5.6, tone: "hi", anchor: "middle" },
    ),
  );

  out.push(
    D([at([x0 + 4, y0 + 4, 5]), at([x0 + DESK_W - 4, y0 + 4, 5])], {
      size: 0.45,
      tone: "lo",
    }),
  );

  return out.join("");
}

function glands() {
  const out = [];
  for (const y of [-30, 0, 30]) {
    out.push(S(k.cylinder(-152, y, 5.2, 0, 6, P, 24), { tone: "mid" }));
    out.push(S(k.cylinder(-152, y, 6.2, 6, 2, P, 24), { tone: "hi" }));
    out.push(D([at([-152, y, 8])], { size: 0.5, tone: "mid" }));
  }
  return out.join("");
}

function cords() {
  const out = [];

  [-30, 0, 30].forEach((y) => {
    out.push(
      k.wireSvg(at([-152, y, 8]), at([-140, y, 10]), {
        via: [at([-146, y, 9])],
        tone: "lo",
        size: 1.1,
      }),
    );
  });

  for (let i = 0; i < 3; i += 1) {
    const from = at([COLS[i], -58, 3]);
    const to = at([DESK_X[i], -24, 6]);
    const via = [
      at([COLS[i] + 4, -72, 4]),
      at([30 + i * 10, -74, 4]),
      at([DESK_X[i] - 12, -40, 5]),
    ];
    out.push(
      `<g data-cord="${i}" style="opacity:.18">${k.wireSvg(from, to, {
        via,
        tone: "red",
        flow: true,
        size: 1.15,
      })}</g>`,
    );
  }

  return out.join("");
}

const needleAt = (index) => {
  const angle = (index / 3) * Math.PI * 2;
  const [x, y] = DIAL_POS;
  return k.lineOnTop(
    [x - Math.sin(angle) * 2.2, y + Math.cos(angle) * 2.2],
    [x + Math.sin(angle) * (DIAL_R - 3), y - Math.cos(angle) * (DIAL_R - 3)],
    DIAL_TOP + 0.2,
    P,
  );
};

function cacheDial() {
  const [x, y] = DIAL_POS;
  const out = [];
  out.push(S(k.cylinder(x, y, DIAL_R, 0, DIAL_H, P, 64, 0.8), { tone: "hi", crease: "lo" }));
  out.push(L(k.knurl(x, y, DIAL_R, DIAL_TOP - 2.4, DIAL_TOP, 60, P, 0.3), { tone: "lo" }));
  out.push(L(k.sideArc(x, y, DIAL_R, DIAL_TOP - 2.4, P, 40), { tone: "faint" }));
  out.push(L(k.ring(x, y, DIAL_R - 2.2, DIAL_TOP, P, 64), { tone: "lo" }));

  const ticks = k.radialTicks(x, y, DIAL_R - 3, 30, 5, DIAL_TOP, [1.2, 2.6], P);
  out.push(L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid" }));

  out.push(L(k.ring(x, y, 1.4, DIAL_TOP, P, 16), { tone: "mid" }));
  out.push(
    `<path data-part="needle" class="iso-line" data-tone="lit" d="${needleAt(0)}" style="stroke-width:1.1"/>`,
  );
  out.push(
    k.faceTextSvg(k.topMatrix([x, y + DIAL_R - 2.0], DIAL_TOP, P, "x"), "CACHE 128", {
      size: 3.6,
      tone: "mid",
      anchor: "middle",
    }),
  );
  return out.join("");
}

function labelPlate() {
  const out = [];
  const plan = { x: -36, y: 60, w: 72, d: 13, r: 2 };
  out.push(S(k.slabOf(plan, 0, 1.2, P, 4, 0.3), { tone: "lo", crease: "none" }));
  out.push(L(k.planOutline(k.insetPlan(plan, 1.6), 1.2, P), { tone: "faint" }));
  out.push(
    k.faceTextSvg(k.topMatrix([0, 66.5], 1.2, P, "x"), "GATEWAY", {
      size: 7.0,
      tone: "hi",
      anchor: "middle",
    }),
  );
  out.push(
    D([at([-32, 63, 1.2]), at([32, 63, 1.2])], { size: 0.45, tone: "lo" }),
  );
  return out.join("");
}

function badge(n, x, y, tx, ty) {
  return (
    L(k.lineOnTop([x, y], [tx, ty], 0.7, P), { tone: "lo" }) +
    S(k.cylinder(x, y, 5.9, 0.7, 1.2, P, 24), { tone: "hi" }) +
    k.faceTextSvg(k.topMatrix([x, y], 1.9, P, "x"), String(n), {
      size: 8.0,
      tone: "hi",
      anchor: "middle",
    })
  );
}

function badgeRaised(n, x, y, z) {
  return (
    S(k.cylinder(x, y, 5.4, z, 1.2, P, 24), { tone: "hi" }) +
    k.faceTextSvg(k.topMatrix([x, y], z + 1.2, P, "x"), String(n), {
      size: 7.6,
      tone: "hi",
      anchor: "middle",
    })
  );
}

const svg = k.figureSvg({
  width: WIDTH,
  height: HEIGHT,
  label:
    "A telephone switchboard for an agent gateway. Three outside lines arrive at cable glands and drop into a 3 by 4 session matrix on the console. An overhead gantry slides a probe to the selected platform, and one of three workbenches lights up: that is the cached agent instance kept warm for the session. A counter at the back shows the 128-slot cache.",
  body: [
    base(),
    cords(),
    backboard(),
    consoleBody(),
    gantry(),
    `<g data-part="carriage" transform="${k.translateAlong(P, [COLS[0], 0, 0])}">${carriage()}</g>`,
    desk(DESK_X[0], 0),
    desk(DESK_X[1], 1),
    desk(DESK_X[2], 2),
    glands(),
    cacheDial(),
    labelPlate(),
    badge(1, -152, -60, -152, -33),
    badge(2, -120, 66, -120, 50),
    badgeRaised(3, -90, 0, BEAM_TOP + 0.6),
    badge(4, 102, 36, 102, 24),
    badge(5, 62, 36, 62, 24),
    badge(6, 150, -44, 150, -55),
    badge(7, 10, -46, 10, -60),
  ],
});

const live = `
const P = ${JSON.stringify(P)};
const COLS = ${JSON.stringify(COLS)};
const KEYS = ${JSON.stringify(KEYS)};
const CACHE = ${JSON.stringify(CACHE)};
const DIAL_POS = ${JSON.stringify(DIAL_POS)};
const DIAL_R = ${DIAL_R}, DIAL_TOP = ${DIAL_TOP};
const stage = document.querySelector(".iso-stage");
const carriage = stage.querySelector('[data-part="carriage"]');
const needle = stage.querySelector('[data-part="needle"]');
const readout = document.querySelector("[data-readout]");
const still = matchMedia("(prefers-reduced-motion: reduce)");
const lits = [...stage.querySelectorAll("[data-active]")];
const signals = [...stage.querySelectorAll("[data-signal]")];
const cords = [...stage.querySelectorAll("[data-cord]")];
const needleAt = ${needleAt.toString().replace("k.lineOnTop", "lineOnTop")};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

let x = COLS[0], targetX = COLS[0];
let active = 0, frame = 0, last = 0, clock = 0, touring = true, visible = false, idle = 0;

function draw() {
  carriage.setAttribute("transform", translateAlong(P, [x, 0, 0]));
  needle.setAttribute("d", needleAt(active));
  lits.forEach((el, i) => { el.style.opacity = i === active ? "1" : ".06"; });
  signals.forEach((el, i) => { el.style.opacity = i === active ? "1" : ".06"; });
  cords.forEach((el, i) => { el.style.opacity = i === active ? "1" : ".18"; });
  const text = KEYS[active] + " · " + (active === 0 ? "cached" : "new") + " · LRU " + CACHE[active] + "/128";
  if (readout.textContent !== text) readout.textContent = text;
  stage.setAttribute("aria-valuenow", String(active));
  stage.setAttribute("aria-valuetext", text);
}

function run() {
  if (!frame && visible) { last = 0; frame = requestAnimationFrame(tick); }
}

function pick(next) {
  touring = false;
  targetX = COLS[clamp(next, 0, 2)];
  clearTimeout(idle);
  idle = setTimeout(() => { touring = !still.matches; clock = 0; run(); }, 3600);
  run();
}

function tick(now) {
  const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
  last = now;
  if (touring) {
    clock += dt;
    targetX = COLS[Math.floor(clock / 2.8) % 3];
  }
  if (still.matches) x = targetX;
  else {
    x += (targetX - x) * (1 - Math.exp(-dt / 0.2));
    if (Math.abs(targetX - x) < 0.01) x = targetX;
  }
  active = COLS.reduce((best, c, i) => (Math.abs(c - x) < Math.abs(COLS[best] - x) ? i : best), 0);
  draw();
  frame = visible ? requestAnimationFrame(tick) : 0;
}

new IntersectionObserver((entries) => {
  visible = entries[entries.length - 1].isIntersecting;
  if (visible) run();
}, { rootMargin: "120px 0px" }).observe(stage);

if (still.matches) { touring = false; x = targetX = COLS[0]; active = 0; }

stage.addEventListener("pointermove", (event) => {
  const box = stage.getBoundingClientRect();
  const share = clamp((event.clientX - box.left) / box.width, 0, 1);
  pick(Math.round(share * 2));
});
stage.addEventListener("pointerleave", () => pick(active));
stage.addEventListener("keydown", (event) => {
  if (event.key === "ArrowRight" || event.key === "ArrowUp") { event.preventDefault(); pick(active + 1); }
  if (event.key === "ArrowLeft" || event.key === "ArrowDown") { event.preventDefault(); pick(active - 1); }
  if (event.key === "Home") { event.preventDefault(); pick(0); }
  if (event.key === "End") { event.preventDefault(); pick(2); }
});

draw();
`;

const body = k.plateHtml({
  fig: "图 1",
  title: "Gateway 电话总机",
  hint: "悬停或按 ← → 切换会话",
  readout: `telegram:42:7 · cached · LRU 1/128`,
  keys: [
    { mark: "raised", label: "1 外线接入：Telegram / Discord / Slack" },
    { mark: "flat", label: "2 会话矩阵：3 平台 × 4 槽 = session_key" },
    { mark: "edge", label: "3 路由器：龙门架探针选中一路" },
    { mark: "dim", label: "4 工作台：按会话缓存的 AIAgent" },
    { mark: "lit", label: "5 激活会话：红色环 / 旗标" },
    { mark: "dotted", label: "6 缓存旋钮：128 槽，1h 淘汰" },
    { mark: "dashed", label: "7 路由线缆：把消息送到工作台" },
  ],
  caption:
    "发生了什么：① 一条消息从外线进来 → ② 路由器用 platform:chat:thread 选中一列 → ③ 对应工作台若已缓存则复用，否则新建。红色即当前路径。",
  body: `<div class="iso-stage" tabindex="0" role="slider" aria-label="Gateway switchboard: arrow keys choose the active session line" aria-valuemin="0" aria-valuemax="2" aria-valuenow="0">${svg}</div>`,
});

writeFileSync(
  join(HERE, theme === "light" ? "hermes-switchboard-light.html" : "hermes-switchboard.html"),
  k.pageHtml({ title: "Hermes gateway switchboard", theme, body, script: kitScript() + live }),
);
console.log("wrote", theme === "light" ? "hermes-switchboard-light.html" : "hermes-switchboard.html");
