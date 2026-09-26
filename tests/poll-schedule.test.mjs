// Unit tests for the pure polling maths in lib/shared/poll-schedule.ts.
//
// These are the numbers behind every "ask the server again" loop in the browser
// (pairing, laptop presence, agent job streaming). On Vercel's free tier each
// round is a serverless invocation, so the sequence itself is the contract:
// start fast, back off when nothing changes, speed back up on a change, back
// off harder on errors, and never exceed maxMs.
//
// The file has no imports and no DOM, so `node --test` can run it directly
// (Node strips the TypeScript types).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_POLL_SCHEDULE,
  JOB_POLL_SCHEDULE,
  PRESENCE_POLL_SCHEDULE,
  createPollPlan,
} from '../lib/shared/poll-schedule.ts';

test('a plan starts at baseMs', () => {
  const plan = createPollPlan();
  assert.equal(plan.delay(), DEFAULT_POLL_SCHEDULE.baseMs);
  assert.equal(plan.idle, 0);
});

test('unchanged rounds hold the delay until idleRounds, then back off', () => {
  const plan = createPollPlan({ baseMs: 1000, maxMs: 60_000, backoff: 2, stepIn: 1, idleRounds: 2 });

  assert.equal(plan.next('same'), 1000, 'round 1: still inside idleRounds');
  assert.equal(plan.next('same'), 1000, 'round 2: still inside idleRounds');
  assert.equal(plan.next('same'), 2000, 'round 3: backs off');
  assert.equal(plan.next('same'), 4000, 'round 4: backs off again');
  assert.equal(plan.idle, 4);
});

test('the delay never exceeds maxMs, however idle the tab gets', () => {
  const plan = createPollPlan({ baseMs: 1000, maxMs: 5000, backoff: 3, idleRounds: 0 });
  for (let round = 0; round < 40; round += 1) {
    assert.ok(plan.next('same') <= 5000, `round ${round} stayed inside maxMs`);
  }
  assert.equal(plan.delay(), 5000);
});

test('a change speeds the loop back up toward baseMs', () => {
  const plan = createPollPlan({ baseMs: 1000, maxMs: 60_000, backoff: 2, stepIn: 0.5, idleRounds: 0 });
  plan.next('same'); // 2000
  plan.next('same'); // 4000
  assert.equal(plan.delay(), 4000);

  assert.equal(plan.next('changed'), 2000, 'halved');
  assert.equal(plan.next('changed'), 1000, 'halved again');
  assert.equal(plan.next('changed'), 1000, 'floored at baseMs');
  assert.equal(plan.idle, 0, 'the idle counter resets with the change');
});

test('an error backs off twice as hard as an idle round', () => {
  const idlePlan = createPollPlan({ baseMs: 1000, maxMs: 60_000, backoff: 2, idleRounds: 0 });
  const errorPlan = createPollPlan({ baseMs: 1000, maxMs: 60_000, backoff: 2, idleRounds: 0 });

  assert.equal(idlePlan.next('same'), 2000);
  assert.equal(errorPlan.next('error'), 4000, 'backoff squared');
});

test('reset() drops straight back to baseMs (tab refocused, user acted)', () => {
  const plan = createPollPlan({ baseMs: 1200, maxMs: 8000, backoff: 2, idleRounds: 0 });
  plan.next('same');
  plan.next('same');
  assert.ok(plan.delay() > 1200);

  assert.equal(plan.reset(), 1200);
  assert.equal(plan.idle, 0);
});

test('the shipped schedules are inside the free-tier budget', () => {
  // Pairing: a human is watching the code, so it must be responsive but must
  // also settle down if they walk away and leave the tab open.
  assert.equal(DEFAULT_POLL_SCHEDULE.baseMs, 1500);
  assert.equal(DEFAULT_POLL_SCHEDULE.maxMs, 15_000);
  assert.ok(DEFAULT_POLL_SCHEDULE.stepIn < 1, 'a change must re-accelerate');

  // Presence: nothing is expected to change, so it parks at ~2 rounds/minute.
  assert.equal(PRESENCE_POLL_SCHEDULE.baseMs, 2500);
  assert.ok(PRESENCE_POLL_SCHEDULE.maxMs >= 30_000);

  // Job streaming: fast enough to feel live, capped so a long "thinking" phase
  // cannot turn into 3 requests a second forever.
  assert.ok(JOB_POLL_SCHEDULE.baseMs >= 300, 'not faster than ~3 rounds/second');
  assert.ok(JOB_POLL_SCHEDULE.baseMs <= 500, 'still feels live');
  assert.ok(JOB_POLL_SCHEDULE.maxMs <= 5000);
  assert.ok(JOB_POLL_SCHEDULE.stepIn < 1, 'new events must re-accelerate');
});

test('an idle but VISIBLE tab has a bounded steady-state cost', () => {
  // startPolitePolling parks the loop entirely while the tab is hidden, so the
  // only case that costs anything is a visible tab where nothing is changing.
  // At steady state the plan sits on maxMs, so the ceiling is 60000/maxMs
  // requests a minute — and for a job stream the loop stops as soon as the job
  // finishes, so that ceiling is never reached in practice.
  const ceilings = [
    [DEFAULT_POLL_SCHEDULE, 4], // pairing: at most one round every 15s
    [PRESENCE_POLL_SCHEDULE, 2], // presence: at most one round every 30s
    [JOB_POLL_SCHEDULE, 15], // job stream: only while a job is actually running
  ];
  for (const [schedule, perMinute] of ceilings) {
    const plan = createPollPlan(schedule);
    for (let round = 0; round < 60; round += 1) plan.next('same');
    assert.equal(plan.delay(), schedule.maxMs, 'settled on maxMs');
    assert.ok(60_000 / plan.delay() <= perMinute, `${schedule.maxMs}ms stays inside ${perMinute}/minute`);
  }
});
