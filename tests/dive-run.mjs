/**
 * Can anybody actually swim these?
 *
 * The same standard as the mountain, and for the same reason: a level nobody
 * can be shown to finish does not go in the game. But this one goes further
 * than the climb solver does — it drives the **real `World`**, not just the
 * real `Player`. Currents, leopard seals, the breath clock, the death rules
 * and the finish check are all the ones the game runs, because under the ice
 * those are not scenery around the level, they *are* the level.
 *
 * The controller is deliberately stupid. It swims forward, looks at the next
 * slot on the route and holds the button when that slot is below it. If a
 * bang-bang controller with one lookahead number can get through, a person
 * with eyes can. What is searched is only how far ahead it looks and how
 * sloppy it is allowed to be, because those are the two things a player is
 * unconsciously choosing and the level should work across a range of them.
 */

import { World } from '../src/game/world.js';
import { DIVE_LEVELS, DIVE_DRAFTS } from '../src/game/dive.js';

const STEP = 1 / 120;

const noop = () => {};
const deps = () => ({
  particles: { puff: noop, splash: noop, sparkle: noop, burstIce: noop },
  audio: new Proxy({}, { get: () => noop }),
  assist: false,
  upgrades: {},
  skin: 'normal',
});

/**
 * One attempt.
 *
 * @param {object} def   the level
 * @param {number} look  how far ahead, in pixels, the next slot is aimed at
 * @param {number} band  how close to the target line counts as "on it"
 * @param {number} start seconds of dawdling before setting off
 */
function trySwim(def, { look, band, start, fear }, probe = {}) {
  const world = new World(def, deps());
  const route = def.route;
  // What killed it, for the report: "died at x" is not enough to fix a level.
  let cause = '';
  const die = world.die.bind(world);
  world.die = (c) => {
    cause = c;
    die(c);
  };
  let t = 0;
  let best = 0;

  for (let i = 0; i < 120000; i++) {
    const p = world.player;
    const cx = p.x + p.w / 2;
    const cy = p.y + p.h / 2;

    // The next slot still ahead of us, aimed at from `look` pixels out.
    let target = route[route.length - 1];
    for (const r of route) {
      if (r.x > cx + 8) {
        target = r;
        break;
      }
    }
    let aim = target.y;
    // Dodging a leopard seal.
    //
    // Vertically, because that is the answer the corridor is shaped for: the
    // seal patrols one line and the water is four hundred pixels tall, so you
    // go over it or under it and keep swimming. Waiting for it to turn works
    // too and costs breath, which is why the level does not need to be timed
    // to the frame — but if the simple answer works, the level is fair, and
    // the simple answer is the one searched here.
    for (const h of world.hazards) {
      if (!h.lethal || h.kind !== 'seal') continue;
      if (h.x + h.w < cx - 20 || h.x > cx + fear) continue;
      const clear = p.h * 0.9 + h.h * 0.6;
      const overY = h.y - clear;
      const underY = h.y + h.h + clear;
      // Whichever side leaves more water. Ceiling is at the top of the route's
      // world, seabed at the bottom; both are known from the level itself.
      aim = h.y + h.h / 2 - cy > 0 ? overY : underY;
      break;
    }
    // A rotten fish on the line is swum around, the way a seal is: the leak
    // it gives costs half a lungful, and nobody eats one on purpose.
    for (const r of world.rotten ?? []) {
      if (r.taken) continue;
      const rx = r.x + (r.w ?? 0) / 2;
      const ry = r.y + (r.h ?? 0) / 2;
      if (rx < cx - 30 || rx > cx + 380 || Math.abs(ry - aim) > p.h * 1.2) continue;
      aim = ry > world.worldH / 2 ? ry - p.h * 1.5 : ry + p.h * 1.5;
      break;
    }
    // Under a breathing hole with lungs to fill: go up into it. The old sea
    // let the controller arrive early by sliding along the ice; now it comes
    // in from below, and has to decide to surface the way a player does.
    const holeAbove = world.airHoles.find((h) => cx > h.x + p.w * 0.6 && cx < h.x + h.w - p.w * 0.6);
    const surfacing = Boolean(holeAbove) && p.breath < p.breathMax * 0.97;
    if (surfacing) aim = holeAbove.y + 60;
    /*
     * Eyes.
     *
     * Ice and seabed kill on contact now, and the controller above was written
     * for a sea that forgave a bump: on its way to a breathing hole it simply
     * let go and slid along the ceiling until the hole arrived. A player looks
     * at the water in front of them. So the line it aims for is kept inside
     * the corridor it can actually see — the lowest ice and the highest rock
     * over the next stretch — with a body's clearance from each.
     */
    {
      // With a shark coming, the water that matters is the water between
      // here and it: the side chosen has to still be open where they meet.
      const fin = (world.sharks ?? []).find((sh) => !sh.gone && sh.x + sh.w > cx - 30 && sh.x < cx + 620);
      const ahead = Math.max(70 + look * 0.5, fin ? Math.min(360, (fin.x - cx) * 0.7) : 0);
      let ceil = -Infinity;
      let floor = Infinity;
      for (const b of world.solids ?? def.terrain) {
        if (b.solid === false) continue;
        if (b.x + b.w < cx - p.w * 0.7 || b.x > cx + ahead) continue;
        if (b.y + b.h / 2 < cy) ceil = Math.max(ceil, b.y + b.h);
        else floor = Math.min(floor, b.y);
      }
      // Clearance has to cover the controller's own slop: it lets itself drift
      // `band` past the line and then takes a few pixels to turn round.
      // A shark holds one depth, so it is passed on whichever side has more
      // water — decided once it is announced, like a player reading the mark.
      for (const sh of world.sharks ?? []) {
        if (sh.gone || sh.x + sh.w < cx - 30 || sh.x > cx + 620) continue;
        // Air first: under a hole with empty lungs, only a shark that is nearly
        // here is worth waiting for.
        if (surfacing && sh.x > cx + 240) continue;
        const clear = p.h / 2 + band + 16;
        const over = sh.y - clear;
        const under = sh.y + sh.h + clear;
        // Far off, take the roomier side. Close in, the side you are already
        // on is the only one: crossing its line now is swimming into its mouth.
        const mid = sh.y + sh.h / 2;
        const goOver = sh.x - cx < 300 ? cy < mid : sh.y - ceil > floor - (sh.y + sh.h);
        aim = goOver ? Math.min(aim, over) : Math.max(aim, under);
        break;
      }
      const room = p.h / 2 + band + 18;
      const sheltered = world.airHoles.some(
        (h) => p.x < h.x + h.w + 60 && p.x + p.w > h.x - 60 && p.y < h.y + h.h + 50,
      );
      if (surfacing) {
        // The hole is the one place the ice overhead is not in the way.
      } else if (!sheltered || aim > cy) {
        const lo = ceil + room;
        const hi = floor - room;
        aim = lo <= hi ? Math.min(hi, Math.max(lo, aim)) : (ceil + floor) / 2;
      }
    }
    // Hold the button when the line is below, let go when it is above. The
    // band in between is what stops it chattering at sixty hertz, which no
    // player does and which flatters a level that is really too tight.
    const jumpHeld = cy < aim - band;
    // Stop and breathe.
    //
    // Swimming *through* a hole at cruising speed buys about two seconds of
    // air, which is not a breath, it is a sip — and a controller that only
    // sips drowns four levels from the end with the exit in sight. A player
    // stops. So does this: inside a hole with anything less than full lungs,
    // hold still until they are full. It costs seconds on the clock, which is
    // exactly the trade the chapter is about.
    const head = { x: p.x, y: p.y, w: p.w, h: p.h * 0.45 };
    const inside = (a) =>
      head.x < a.x + a.w &&
      head.x + head.w > a.x &&
      head.y < a.y + a.h &&
      head.y + head.h > a.y;
    /*
     * And the same thing at a vent, with the one difference that is the whole
     * point of a vent: it is not always giving. A hole in the ice rewards
     * stopping immediately; a crack in the seabed rewards stopping and then
     * *staying* through a silence that costs air. A controller that leaves the
     * moment the bubbles stop takes a sip and drowns two slots later, which is
     * exactly what this solver did the first time these levels were composed —
     * it failed them both, and they are fine.
     */
    const thirsty = p.breath < p.breathMax * 0.97;
    /*
     * A vent is not somewhere you pass through, it is somewhere you stand.
     *
     * A hole in the ice is a wide cut: swim up into it, let go, and you are
     * still in it a second later. The column over a vent is a body and a half
     * across, and at cruising speed you are out the far side in a fifth of a
     * second — so "stop pressing" is not enough, because stopping pressing
     * still coasts. That is precisely what this solver did the first time
     * these levels were composed: it drifted into the column with five
     * seconds of air, drifted out of it during the silence, and drowned two
     * slots later with the vent behind it.
     *
     * So while the lungs are down and a vent is the next air on the route, it
     * steers *to* the middle of the column and then keeps steering to stay
     * there, through the silence, until the blow has filled it.
     */
    const vent = thirsty
      ? (world.vents ?? []).find((v) => v.x + v.w > cx - 40 && v.x - cx < fear)
      : null;
    const onVent = Boolean(vent) && inside(vent);
    const gulping = thirsty && (world.airHoles.some(inside) || onVent);
    let steer = 1;
    if (vent) {
      const mid = vent.x + vent.w / 2;
      steer = Math.abs(mid - cx) < 6 ? 0 : (mid > cx ? 1 : -1);
    }
    // Holding at a hole means letting go; holding at a vent means holding on.
    const axis = t < start ? 0 : (vent ? steer : (gulping || surfacing ? 0 : 1));

    world.update(STEP, { axis, jumpHeld, jumpPressed: false });
    if (process.env.DIVE_DEBUG && !probe.ate && (world.rotten ?? []).some((r) => r.taken)) {
      probe.ate = `ate x${Math.round(cx)} cy${Math.round(cy)} aim${Math.round(aim)}`;
    }
    t += STEP;
    best = Math.max(best, cx);
    probe.best = Math.max(probe.best ?? 0, Math.round(best));
    if (probe.trace && i % 8 === 0) {
      probe.log.push(
        `${t.toFixed(2)} x${Math.round(cx)} y${Math.round(cy)} → ${target.tag}@${target.x},${target.y} ` +
          `vy${Math.round(p.vy)} nefes${p.breath.toFixed(1)} ${world.status}`,
      );
    }
    if (world.status === "won") {
      probe.sharks = world.sharkCount ?? 0;
      probe.time = t;
      // How much air was left over, and how close it ever got to none. A dive
      // finished with half a lung is a dive that never asked anything.
      probe.spare = Math.max(probe.spare ?? 0, p.breath / p.breathMax);
      probe.lowest = Math.min(probe.lowest ?? 1, probe.low ?? 1);
      return true;
    }
    probe.low = Math.min(probe.low ?? 1, p.breath / p.breathMax);
    if (world.status === 'dying') {
      // The furthest any attempt got, since that is the one worth reading.
      if (!probe.death || cx > probe.death.x) {
        probe.death = { x: Math.round(cx), y: Math.round(cy), cause, breath: +p.breath.toFixed(1), aim: Math.round(aim), sharks: (world.sharks ?? []).map((q) => `${Math.round(q.x - cx)},${Math.round(q.y)}${q.warn > 0 ? "w" : ""}`).join(" ") };
      }
      return false;
    }
    if (t > 120) return false;
  }
  return false;
}

const LOOKS = [0, 60, 140];
const BANDS = [6, 16, 30];
const STARTS = [0, 0.25];
/** How far ahead a seal starts mattering. A player's version of nerve. */
const FEARS = [420, 280, 600];

function solve(def, probe = {}) {
  for (const fear of FEARS) {
    for (const look of LOOKS) {
      for (const band of BANDS) {
        for (const start of STARTS) {
          const one = {};
          const won = trySwim(def, { look, band, start, fear }, one);
          if (process.env.DIVE_DEBUG === String(def.id)) console.log(look, band, start, fear, won, JSON.stringify(one.death), one.ate);
          for (const k of Object.keys(one)) if (k !== "death") probe[k] = one[k];
          if (one.death && (!probe.death || one.death.x > probe.death.x)) probe.death = one.death;
          if (won) {
            return { look, band, start, fear };
          }
        }
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */

console.log('Dalışlar gerçek dünyayla deneniyor...\n');
console.log('(World sınıfının kendisi çalışıyor: akıntı, leopar, nefes,');
console.log(' ölüm ve bitiş kontrolü oyundaki halleriyle.)\n');

const draft = process.argv.includes('--all');
const suite = draft ? DIVE_DRAFTS : DIVE_LEVELS;
const trace = process.argv.find((a) => a.startsWith('--trace='));

let failed = 0;
let held = 0;
const t0 = Date.now();

for (const def of suite) {
  const probe = {};
  if (trace && trace.slice(8) === String(def.id)) {
    probe.trace = true;
    probe.log = [];
  }
  probe.low = 1;
  const found = solve(def, probe);
  if (process.argv.includes('--measure')) {
    console.log(
      `MEASURE ${def.id} ${(probe.lowest ?? 1).toFixed(4)} ${(probe.spare ?? 0).toFixed(4)} ${found ? 1 : 0}`,
    );
    continue;
  }
  if (probe.trace) console.log(probe.log.slice(-70).join('\n'));
  if (process.env.DIVE_SHARKS) console.log(`${def.id} köpek balığı ${probe.sharks} / ${probe.time?.toFixed(1)} sn`);
  if (found) {
    if (process.argv.includes('--list')) console.log(`GECTI ${def.id} ${def.name}`);
    continue;
  }
  const where = probe.death
    ? `x ${probe.death.x} / ${def.worldW}, y ${probe.death.y}, ${probe.death.cause}, nefes ${probe.death.breath}`
    : `en uzak x ${probe.best ?? 0} / ${def.worldW}`;
  if (def.ship !== false) failed++;
  else held++;
  console.log(`${def.ship === false ? '·' : '✗'} ${def.id}. ${def.name} — ${where}`);
}

console.log(`\n${suite.length} dalış denendi, ${((Date.now() - t0) / 1000).toFixed(1)} sn`);
if (held) console.log(`${held} dalış, henüz yayına girmemiş planlarda.`);
if (failed) {
  console.log(`✗ ${failed} dalış bitirilemedi.`);
  process.exit(1);
}
console.log('✓ Her dalış gerçek fizikle bitirildi — eşyasız, yeteneksiz penguenle.');
