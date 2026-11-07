/**
 * Unified input layer.
 *
 * Keyboard, on-screen touch pads and gamepads all feed the same small state
 * object, so gameplay code never has to know where a press came from.
 */

const KEY_MAP = {
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  ArrowUp: 'jump',
  KeyW: 'jump',
  Space: 'jump',
  KeyR: 'restart',
  Escape: 'pause',
  KeyP: 'pause',
  Enter: 'confirm',
};

/**
 * What the player is holding right now: a touchscreen, a keyboard or a pad.
 *
 * The first sign of level one used to read "Yürü: ← →  •  Zıpla: BOŞLUK" on a
 * phone, which has neither arrows nor a space bar, and in Turkish on a phone
 * set to English. The hints are now chosen by language *and* by this, which is
 * whatever was pressed last — so a laptop with a touchscreen shows key hints
 * the moment a key is used, and a pad shows pad hints.
 */
let lastKind =
  typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches ? 'touch' : 'keys';

export function inputKind() {
  return lastKind;
}

function noteKind(kind) {
  if (kind === lastKind) return;
  lastKind = kind;
  if (typeof document !== 'undefined') document.documentElement.dataset.input = kind;
}

if (typeof document !== 'undefined') document.documentElement.dataset.input = lastKind;

/**
 * A short tap of the phone's own haptics, where there is one to ask.
 *
 * The Android shell exposes `PenguNative.haptic`, which goes through the
 * view's own haptic feedback and therefore needs no vibrate permission. In a
 * browser there is no such bridge and this does nothing at all: the browser's
 * vibrate call is left alone on purpose, because the packaged app does not
 * hold that permission and the web version should not feel different.
 */
let hapticsOn = true;
export function setHaptics(on) {
  hapticsOn = Boolean(on);
}
export function haptic(kind = 'tap') {
  if (!hapticsOn) return;
  try {
    window.PenguNative?.haptic?.(kind);
  } catch {
    /* a bridge that is gone is a bridge that is not there */
  }
}

export class Input {
  constructor() {
    this.state = { left: false, right: false, jump: false };
    /** Actions consumed once per press (restart / pause / confirm). */
    this.pressed = new Set();
    this._sources = { key: new Set(), touch: new Set(), pad: new Set() };
    this._listeners = new Map();
    this._enabled = true;
    this._bindKeyboard();
  }

  on(action, fn) {
    if (!this._listeners.has(action)) this._listeners.set(action, new Set());
    this._listeners.get(action).add(fn);
    return () => this._listeners.get(action).delete(fn);
  }

  _emit(action) {
    const set = this._listeners.get(action);
    if (set) for (const fn of set) fn();
  }

  _bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      const action = KEY_MAP[e.code];
      if (!action) return;
      // Space/arrows would otherwise scroll the page.
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      if (e.repeat) return;
      noteKind('keys');
      this._sources.key.add(action);
      this._sync();
      this._emit(action);
    });

    window.addEventListener('keyup', (e) => {
      const action = KEY_MAP[e.code];
      if (!action) return;
      this._sources.key.delete(action);
      this._sync();
    });

    // Releasing everything on blur avoids a stuck "held" key after alt-tab.
    window.addEventListener('blur', () => this.releaseAll());
    // And on a phone, where the window is often never told it lost focus. A
    // call arrives while the thumb is on the jump pad, the pad never sees a
    // pointerup, and the penguin comes back from the call still holding it.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.releaseAll();
    });
  }

  /**
   * Wire an element as a virtual button. Pointer events cover mouse, pen and
   * touch with one code path; `touch-action: none` in CSS stops scrolling.
   */
  bindButton(el, action) {
    if (!el) return;
    const press = (e) => {
      e.preventDefault();
      el.setPointerCapture?.(e.pointerId);
      el.classList.add('is-pressed');
      noteKind('touch');
      haptic(action === 'jump' ? 'jump' : 'tap');
      this._sources.touch.add(action);
      this._sync();
      this._emit(action);
    };
    const release = (e) => {
      e.preventDefault();
      el.classList.remove('is-pressed');
      this._sources.touch.delete(action);
      this._sync();
    };
    el.addEventListener('pointerdown', press);
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('pointerleave', release);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /**
   * Left and right as one pad you can slide across.
   *
   * Two separate buttons each captured the finger that pressed them, so
   * rolling the thumb from ← to → kept walking left until the thumb was lifted
   * and put down again — the single most common complaint about on-screen
   * arrows. Here the pair is one surface: wherever the finger is, left of the
   * middle is left and right of it is right, and it follows the finger as it
   * moves. Each button still lights up on its own.
   */
  bindDpad(zone, leftEl, rightEl) {
    if (!zone || !leftEl || !rightEl) return;
    const fingers = new Map();
    const sideOf = (x) => {
      const l = leftEl.getBoundingClientRect();
      const r = rightEl.getBoundingClientRect();
      const mid = (l.right + r.left) / 2;
      return x < mid ? 'left' : 'right';
    };
    const apply = () => {
      const held = new Set(fingers.values());
      for (const [a, el] of [['left', leftEl], ['right', rightEl]]) {
        const on = held.has(a);
        const was = this._sources.touch.has(a);
        el.classList.toggle('is-pressed', on);
        if (on && !was) {
          this._sources.touch.add(a);
          this._emit(a);
          haptic('tick');
        } else if (!on && was) this._sources.touch.delete(a);
      }
      this._sync();
    };
    zone.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      noteKind('touch');
      zone.setPointerCapture?.(e.pointerId);
      fingers.set(e.pointerId, sideOf(e.clientX));
      apply();
    });
    zone.addEventListener('pointermove', (e) => {
      if (!fingers.has(e.pointerId)) return;
      const side = sideOf(e.clientX);
      if (side === fingers.get(e.pointerId)) return;
      fingers.set(e.pointerId, side);
      apply();
    });
    const lift = (e) => {
      if (!fingers.delete(e.pointerId)) return;
      apply();
    };
    zone.addEventListener('pointerup', lift);
    zone.addEventListener('pointercancel', lift);
    zone.addEventListener('lostpointercapture', lift);
    zone.addEventListener('contextmenu', (e) => e.preventDefault());
    this._dpadFingers = fingers;
  }

  /**
   * One controller, read fresh every frame.
   *
   * The mapping used to be narrower than the manual claimed: only the bottom
   * two face buttons jumped, so X and Y did nothing on a pad where the manual
   * said all four worked, and Start did nothing at all even though pausing is
   * an action this class already knows how to emit. Both were the kind of gap
   * nobody reports — a player with an unusual pad simply decides the game does
   * not support controllers.
   *
   * All four face buttons jump now, because which one is "the bottom one"
   * depends on the pad and on the browser's remapping, and being wrong about
   * it costs a jump. Start pauses, through the same `pause` action the Escape
   * key emits, so there is one path rather than two.
   */
  pollGamepad() {
    const pads = navigator.getGamepads?.() ?? [];
    const pad = [...pads].find(Boolean);
    const next = new Set();
    if (pad) {
      const on = (i) => Boolean(pad.buttons[i]?.pressed);
      const ax = pad.axes[0] ?? 0;
      if (ax < -0.35 || on(14)) next.add('left');
      if (ax > 0.35 || on(15)) next.add('right');
      if (on(0) || on(1) || on(2) || on(3)) next.add('jump');
      // Start, and Select beside it: a pad in a living room is not always the
      // one the layout was written for.
      if (on(9) || on(8)) next.add('pause');
    }
    const had = this._sources.pad;
    if (next.size && !had.size) noteKind('pad');
    for (const a of next) if (!had.has(a)) this._emit(a);
    // `pause` stays in the set on purpose. It is a moment rather than a state,
    // and the only thing that stops a held Start from toggling on every single
    // frame is that it was in the set last frame too. `_sync` reads left,
    // right and jump and nothing else, so it costs nothing to leave it here.
    this._sources.pad = next;
    this._sync();
  }

  _sync() {
    const held = (a) =>
      this._enabled &&
      (this._sources.key.has(a) || this._sources.touch.has(a) || this._sources.pad.has(a));
    this.state.left = held('left');
    this.state.right = held('right');
    this.state.jump = held('jump');
  }

  releaseAll() {
    this._sources.key.clear();
    this._sources.touch.clear();
    this._sources.pad.clear();
    this._dpadFingers?.clear();
    document.querySelectorAll('.is-pressed').forEach((el) => el.classList.remove('is-pressed'));
    this._sync();
  }

  /** Movement axis in [-1, 1]. */
  get axis() {
    return (this.state.right ? 1 : 0) - (this.state.left ? 1 : 0);
  }
}
