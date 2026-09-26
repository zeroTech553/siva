// Unit tests for the Zero OS window manager (components/computer/os/window-manager.ts).
//
// The window manager is a pure reducer — (state, action) => state — with no
// React, no DOM and no timers, which is exactly why it can be tested like this.
// These assertions are the "real OS" contract: single-instance apps, focus and
// z-order, minimize/restore, maximize with geometry restore, drag/resize clamps
// that keep the title bar reachable, and cascade/tile arrangement.
//
// Geometry is in PERCENT of the desktop area, so the same numbers hold on a
// 292px hero CRT and a 720px console CRT.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CASCADE_STEP,
  DEFAULT_RECT,
  MIN_RECT,
  cascadeRect,
  clampRect,
  findWindow,
  initialWmState,
  reduceWindows,
  tileRects,
  visibleWindows,
  windowsByZ,
} from '../components/computer/os/window-manager.ts';

/** Open `count` distinct apps and return the resulting state. */
function withWindows(count) {
  let state = initialWmState();
  for (let index = 0; index < count; index += 1) {
    state = reduceWindows(state, { type: 'open', appId: `app${index}`, title: `App ${index}` });
  }
  return state;
}

test('a fresh desktop has no windows and no focus', () => {
  const state = initialWmState();
  assert.deepEqual(state.windows, []);
  assert.equal(state.activeId, null);
});

test('opening a window creates it, focuses it and puts it on top', () => {
  const state = reduceWindows(initialWmState(), {
    type: 'open',
    appId: 'terminal',
    title: 'Terminal',
    icon: '/sprites/terminal.png',
  });

  assert.equal(state.windows.length, 1);
  const window = state.windows[0];
  assert.equal(window.appId, 'terminal');
  assert.equal(window.title, 'Terminal');
  assert.equal(window.icon, '/sprites/terminal.png');
  assert.equal(state.activeId, window.id);
  assert.equal(window.z, state.zTop, 'the newest window is on top');
  assert.equal(window.minimized, false);
  assert.equal(window.maximized, false);
});

test('apps are single-instance: opening one twice reuses and focuses the window', () => {
  let state = reduceWindows(initialWmState(), { type: 'open', appId: 'files', title: 'Files' });
  const firstId = state.windows[0].id;
  const zAfterFirst = state.zTop;

  state = reduceWindows(state, { type: 'open', appId: 'agent', title: 'Agent' });
  state = reduceWindows(state, { type: 'open', appId: 'files', title: 'Files' });

  assert.equal(state.windows.length, 2, 'no second Files window');
  assert.equal(state.activeId, firstId, 'the existing window took focus');
  assert.equal(findWindow(state, firstId).z, state.zTop);
  assert.ok(state.zTop > zAfterFirst);
});

test('singleton: false allows two windows for the same app', () => {
  let state = reduceWindows(initialWmState(), {
    type: 'open',
    appId: 'terminal',
    title: 'Terminal 1',
    singleton: false,
  });
  state = reduceWindows(state, {
    type: 'open',
    appId: 'terminal',
    title: 'Terminal 2',
    singleton: false,
  });
  assert.equal(state.windows.length, 2);
  assert.deepEqual(
    state.windows.map((window) => window.title),
    ['Terminal 1', 'Terminal 2'],
  );
});

test('a window with an explicit rect keeps it; without one it cascades', () => {
  const placed = reduceWindows(initialWmState(), {
    type: 'open',
    appId: 'setup',
    title: 'Control Panel',
    rect: { x: 20, y: 15, w: 60, h: 50 },
  });
  assert.deepEqual(
    { x: placed.windows[0].x, y: placed.windows[0].y, w: placed.windows[0].w, h: placed.windows[0].h },
    { x: 20, y: 15, w: 60, h: 50 },
  );

  let state = initialWmState();
  const positions = [];
  for (let index = 0; index < 3; index += 1) {
    state = reduceWindows(state, { type: 'open', appId: `app${index}`, title: `App ${index}` });
    positions.push({ x: state.windows[index].x, y: state.windows[index].y });
  }
  assert.deepEqual(positions[1], {
    x: positions[0].x + CASCADE_STEP,
    y: positions[0].y + CASCADE_STEP,
  });
  assert.deepEqual(positions[2], {
    x: positions[0].x + CASCADE_STEP * 2,
    y: positions[0].y + CASCADE_STEP * 2,
  });
});

test('focusing a window raises it above the others and restores it if minimized', () => {
  const state = withWindows(3);
  const [first, second, third] = state.windows;
  assert.equal(state.activeId, third.id, 'the last opened window has focus');

  const focused = reduceWindows(state, { type: 'focus', id: first.id });
  assert.equal(focused.activeId, first.id);
  assert.equal(findWindow(focused, first.id).z, focused.zTop);
  assert.ok(findWindow(focused, second.id).z < focused.zTop);

  const minimized = reduceWindows(focused, { type: 'minimize', id: first.id });
  assert.equal(findWindow(minimized, first.id).minimized, true);
  const refocused = reduceWindows(minimized, { type: 'focus', id: first.id });
  assert.equal(findWindow(refocused, first.id).minimized, false, 'focusing un-minimizes');
  assert.equal(refocused.activeId, first.id);
});

test('focusing the topmost, already-active window is a no-op (same state object)', () => {
  const state = withWindows(2);
  const active = findWindow(state, state.activeId);
  assert.equal(reduceWindows(state, { type: 'focus', id: active.id }), state);
});

test('minimizing the focused window hands focus to the next one by z order', () => {
  const state = withWindows(3);
  const [first, second, third] = state.windows;

  const afterThird = reduceWindows(state, { type: 'minimize', id: third.id });
  assert.equal(afterThird.activeId, second.id, 'second was next in z order');

  const afterSecond = reduceWindows(afterThird, { type: 'minimize', id: second.id });
  assert.equal(afterSecond.activeId, first.id);

  const afterFirst = reduceWindows(afterSecond, { type: 'minimize', id: first.id });
  assert.equal(afterFirst.activeId, null, 'nothing left: the desktop has focus');
  assert.deepEqual(visibleWindows(afterFirst), []);
});

test('closing a window removes it and re-focuses what is underneath', () => {
  const state = withWindows(2);
  const [first, second] = state.windows;

  const closed = reduceWindows(state, { type: 'close', id: second.id });
  assert.equal(closed.windows.length, 1);
  assert.equal(closed.activeId, first.id);

  const closedUnknown = reduceWindows(closed, { type: 'close', id: 'w999' });
  assert.equal(closedUnknown, closed, 'closing a window that is not there changes nothing');
});

test('maximize fills the desktop and restore brings the old geometry back', () => {
  const state = reduceWindows(initialWmState(), {
    type: 'open',
    appId: 'agent',
    title: 'Agent',
    rect: { x: 12, y: 9, w: 55, h: 60 },
  });
  const id = state.windows[0].id;

  const maximized = reduceWindows(state, { type: 'toggleMaximize', id });
  const big = findWindow(maximized, id);
  assert.equal(big.maximized, true);
  assert.deepEqual({ x: big.x, y: big.y, w: big.w, h: big.h }, { x: 0, y: 0, w: 100, h: 100 });

  const restored = reduceWindows(maximized, { type: 'toggleMaximize', id });
  const small = findWindow(restored, id);
  assert.equal(small.maximized, false);
  assert.deepEqual({ x: small.x, y: small.y, w: small.w, h: small.h }, { x: 12, y: 9, w: 55, h: 60 });
});

test('dragging and resizing cannot throw the title bar off the desktop', () => {
  const state = reduceWindows(initialWmState(), { type: 'open', appId: 'files', title: 'Files' });
  const id = state.windows[0].id;

  const flung = reduceWindows(state, { type: 'move', id, x: 500, y: 500 });
  const window = findWindow(flung, id);
  assert.ok(window.x <= 100 - MIN_RECT.w, 'at least MIN_RECT of it stays on screen horizontally');
  assert.ok(window.y <= 100 - MIN_RECT.h, 'the title bar stays reachable vertically');

  const dragged = reduceWindows(state, { type: 'move', id, x: -500, y: -500 });
  const back = findWindow(dragged, id);
  assert.equal(back.y, 0, 'cannot be dragged above the desktop');
  assert.equal(back.x, MIN_RECT.w - window.w, 'cannot be dragged past its own width');

  const shrunk = reduceWindows(state, { type: 'resize', id, w: 1, h: 1 });
  assert.equal(findWindow(shrunk, id).w, MIN_RECT.w);
  assert.equal(findWindow(shrunk, id).h, MIN_RECT.h);

  const grown = reduceWindows(state, { type: 'resize', id, w: 400, h: 400 });
  assert.equal(findWindow(grown, id).w, 100);
  assert.equal(findWindow(grown, id).h, 100);
});

test('a maximized window ignores move and resize', () => {
  let state = reduceWindows(initialWmState(), { type: 'open', appId: 'files', title: 'Files' });
  const id = state.windows[0].id;
  state = reduceWindows(state, { type: 'toggleMaximize', id });
  const moved = reduceWindows(state, { type: 'move', id, x: 30, y: 30 });
  assert.deepEqual({ x: findWindow(moved, id).x, y: findWindow(moved, id).y }, { x: 0, y: 0 });
  const resized = reduceWindows(state, { type: 'resize', id, w: 40, h: 40 });
  assert.equal(findWindow(resized, id).w, 100);
});

test('rename changes only the title', () => {
  const state = withWindows(1);
  const id = state.windows[0].id;
  const renamed = reduceWindows(state, { type: 'rename', id, title: 'Terminal — zsh' });
  assert.equal(findWindow(renamed, id).title, 'Terminal — zsh');
  assert.equal(renamed.activeId, state.activeId);
});

test('cascade steps every visible window down and to the right', () => {
  const state = reduceWindows(withWindows(3), { type: 'cascade' });
  const [first, second, third] = visibleWindows(state);
  assert.equal(second.x - first.x, CASCADE_STEP);
  assert.equal(second.y - first.y, CASCADE_STEP);
  assert.equal(third.x - second.x, CASCADE_STEP);
  assert.equal(third.y - second.y, CASCADE_STEP);
});

test('cascade and tile skip minimized windows', () => {
  let state = withWindows(3);
  state = reduceWindows(state, { type: 'minimize', id: state.windows[1].id });
  const untouched = findWindow(state, state.windows[1].id);

  const cascaded = reduceWindows(state, { type: 'cascade' });
  assert.deepEqual(
    { x: findWindow(cascaded, untouched.id).x, y: findWindow(cascaded, untouched.id).y },
    { x: untouched.x, y: untouched.y },
    'the minimized window did not move',
  );
  assert.equal(findWindow(cascaded, untouched.id).minimized, true);
});

test('tile lays windows out side by side without overlap', () => {
  const two = reduceWindows(withWindows(2), { type: 'tile' });
  const [left, right] = visibleWindows(two);
  assert.equal(left.x, 0);
  assert.equal(right.x, 50);
  assert.equal(left.w, 50);
  assert.equal(right.w, 50);
  assert.ok(left.x + left.w <= right.x + 0.001, 'columns do not overlap');

  const four = reduceWindows(withWindows(4), { type: 'tile' });
  const cells = visibleWindows(four).map((window) => ({ x: window.x, y: window.y }));
  assert.deepEqual(cells, [
    { x: 0, y: 0 },
    { x: 50, y: 0 },
    { x: 0, y: 50 },
    { x: 50, y: 50 },
  ]);
});

test('tileRects() covers the desktop and respects the minimum size', () => {
  assert.deepEqual(tileRects(1), [{ x: 0, y: 0, w: 100, h: 100 }]);
  for (const count of [2, 3, 4]) {
    const rects = tileRects(count);
    assert.equal(rects.length, count);
    for (const rect of rects) {
      assert.ok(rect.w >= MIN_RECT.w, `${count} windows: wide enough to grab`);
      assert.ok(rect.h >= MIN_RECT.h, `${count} windows: tall enough to read`);
      assert.ok(rect.x >= 0 && rect.y >= 0);
    }
  }
  assert.deepEqual(tileRects(0), tileRects(1), 'an empty desktop tiles as one full cell');
});

test('minimizeAll parks everything, restoreAll brings it all back on top', () => {
  const state = withWindows(3);
  const hidden = reduceWindows(state, { type: 'minimizeAll' });
  assert.deepEqual(visibleWindows(hidden), []);
  assert.equal(hidden.activeId, null);

  const shown = reduceWindows(hidden, { type: 'restoreAll' });
  assert.equal(visibleWindows(shown).length, 3);
  assert.deepEqual(
    shown.windows.map((window) => window.minimized),
    [false, false, false],
  );
  assert.ok(shown.zTop > state.zTop, 'restoring raises the whole stack');
});

test('cycle walks the z order like Alt+Tab and wraps around', () => {
  const state = withWindows(3);
  const bottomToTop = windowsByZ(state).map((window) => window.id); // [w1, w2, w3]
  const [bottom, middle, top] = bottomToTop;
  assert.equal(state.activeId, top, 'the last opened window has focus');

  // Alt+Tab goes to the window underneath the current one, then keeps walking
  // down the stack and wraps back to the top.
  const first = reduceWindows(state, { type: 'cycle' });
  assert.equal(first.activeId, middle);
  const second = reduceWindows(first, { type: 'cycle' });
  assert.equal(second.activeId, bottom);
  const third = reduceWindows(second, { type: 'cycle' });
  assert.equal(third.activeId, top, 'wrapped around');
});

test('cycle restores a minimized window it lands on', () => {
  let state = withWindows(2);
  const bottom = windowsByZ(state)[0].id;
  state = reduceWindows(state, { type: 'minimize', id: bottom });
  assert.equal(findWindow(state, bottom).minimized, true);

  const cycled = reduceWindows(state, { type: 'cycle' });
  assert.equal(cycled.activeId, bottom);
  assert.equal(findWindow(cycled, bottom).minimized, false);
});

test('cycle on an empty or single-window desktop is harmless', () => {
  assert.equal(reduceWindows(initialWmState(), { type: 'cycle' }).activeId, null);
  const one = withWindows(1);
  assert.equal(reduceWindows(one, { type: 'cycle' }).activeId, one.activeId);
});

test('focusDesktop clears the focus so the keyboard stops typing into a window', () => {
  const state = withWindows(1);
  const desktop = reduceWindows(state, { type: 'focusDesktop' });
  assert.equal(desktop.activeId, null);
  assert.equal(reduceWindows(desktop, { type: 'focusDesktop' }), desktop, 'already there: no-op');
});

test('clampRect keeps at least MIN_RECT of a window on screen', () => {
  assert.deepEqual(clampRect({ x: -1000, y: -1000, w: 10, h: 10 }), {
    x: MIN_RECT.w - MIN_RECT.w,
    y: 0,
    w: MIN_RECT.w,
    h: MIN_RECT.h,
  });
  const clamped = clampRect({ x: 90, y: 95, w: DEFAULT_RECT.w, h: DEFAULT_RECT.h });
  assert.equal(clamped.x, 100 - MIN_RECT.w);
  assert.equal(clamped.y, 100 - MIN_RECT.h);
});

test('the reducer never mutates the state it was given', () => {
  const state = withWindows(2);
  const snapshot = JSON.stringify(state);
  Object.freeze(state);
  Object.freeze(state.windows);
  for (const window of state.windows) Object.freeze(window);

  for (const action of [
    { type: 'open', appId: 'app0', title: 'App 0' },
    { type: 'close', id: state.windows[0].id },
    { type: 'focus', id: state.windows[1].id },
    { type: 'minimize', id: state.windows[1].id },
    { type: 'toggleMaximize', id: state.windows[1].id },
    { type: 'move', id: state.windows[1].id, x: 40, y: 40 },
    { type: 'resize', id: state.windows[1].id, w: 50, h: 50 },
    { type: 'rename', id: state.windows[1].id, title: 'Renamed' },
    { type: 'cascade' },
    { type: 'tile' },
    { type: 'minimizeAll' },
    { type: 'restoreAll' },
    { type: 'cycle' },
    { type: 'focusDesktop' },
  ]) {
    assert.doesNotThrow(() => reduceWindows(state, action), `${action.type} did not mutate`);
  }
  assert.equal(JSON.stringify(state), snapshot);
});
