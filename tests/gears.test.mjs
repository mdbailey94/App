// Checked against rows of the coach's Gears sheet (short course yards).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanSpeed, fatigueFactor, formatTime, gearPace, gearSet, imGears, latestGoals, parseTime, referenceRace, restFor,
  riegel, setTrend, speedTargets, strokeGears, gearOf,
} from '../src/gears.js';

const close = (a, b, tol = 0.06) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
const t = parseTime;

test('parseTime and formatTime', () => {
  assert.equal(t('1:52.3'), 112.3);
  assert.equal(t('52.3'), 52.3);
  assert.equal(t('18:00.0'), 1080);
  assert.equal(t('2:00'), 120);
  assert.equal(t('1:75'), null);
  assert.equal(t('abc'), null);
  assert.equal(t(''), null);
  assert.equal(formatTime(112.34), '1:52.3');
  assert.equal(formatTime(59.96), '1:00.0');
  assert.equal(formatTime(59.94), '59.9');
  assert.equal(formatTime(600), '10:00.0');
  assert.equal(formatTime(22.49, { dp: 2 }), '22.49');
  assert.equal(formatTime(NaN), '–');
});

test('Mile Chart row: an 18:00 mile at F 1.035 predicts the 500, 1000 and 200 and the gears', () => {
  const mile = 1080;
  close(riegel(mile, 1650, 500, 1.035), t('5:13.9'), 0.1);
  close(riegel(mile, 1650, 1000, 1.035), t('10:43.2'), 0.1);
  close(riegel(riegel(mile, 1650, 500, 1.035), 500, 200, 1.035 + 0.049), t('1:56.3'), 0.1);
  close(gearPace(mile, 1650, 14400, 1.035), t('1:11.4'));
  close(gearPace(mile, 1650, 3600, 1.035), t('1:08.2'));
  close(gearPace(mile, 1650, 900, 1.035), t('1:05.1'));
  close(gearPace(mile, 1650, 300, 1.035), t('1:02.7'));
});

test('200 Chart row: a 2:00 200 free at F 1.05 gives G2 1:15.4 … G6 1:00.0 per 100', () => {
  const g = strokeGears({ 'free-200': 120 }, 'free', { factor: 1.05 });
  assert.equal(g.reference.event.key, 'free-200');
  assert.equal(g.reference.estimated, false);
  const by = Object.fromEntries(g.gears.map((x) => [x.key, x.pace]));
  close(by.G2, t('1:15.4')); close(by.G3, t('1:10.5')); close(by.G4, t('1:06.0')); close(by.G5, t('1:02.7')); close(by.G6, 60.0);
});

test('200 Back row: a 2:00 at F 1.045, per 100, and the breast chart per 50', () => {
  const back = Object.fromEntries(strokeGears({ 'back-200': 120 }, 'back', { factor: 1.045 }).gears.map((x) => [x.key, x.pace]));
  close(back.G2, t('1:13.7')); close(back['G2.5'], t('1:11.6')); close(back.G3, t('1:09.5')); close(back['G3.5'], t('1:07.4'));
  close(back.G4, t('1:05.4')); close(back.G5, t('1:02.4')); close(back.G6, 60.0);
  const breast = Object.fromEntries(strokeGears({ 'breast-200': t('2:05') }, 'breast', { factor: 1.05, per: 50 }).gears.map((x) => [x.key, x.pace]));
  close(breast.G2, 39.2); close(breast.G3, 36.7); close(breast.G5, 32.6); close(breast.G6, 31.2);
});

test('rest per 100 (G3 to Mile row for a 1:00 G3): 3 s at G2 up to 50 s at G5; none set for G6', () => {
  assert.equal(restFor(gearOf('G2'), 64.1), 3);
  assert.equal(restFor(gearOf('G3'), 60), 7);
  assert.equal(restFor(gearOf('G4'), 56.2), 19);
  assert.equal(restFor(gearOf('G5'), 53.3), 50);
  assert.equal(restFor(gearOf('G6'), 50), null);
});

test('fatigue factor from two races (Factor Calculator): 5:12 and 18:00 → 1.040, Middle', () => {
  const f = fatigueFactor({ 'free-500': 312, 'free-1650': 1080 });
  assert.equal(f.factor, 1.04);
  assert.equal(f.type, 'Middle');
  assert.equal(f.from, '500 free and 1650 free');
  assert.deepEqual(fatigueFactor({ 'free-200': 120 }), { factor: 1.045, type: 'Middle', from: null });
  assert.equal(fatigueFactor({}, 1.03).type, 'Distance');
  assert.equal(fatigueFactor({}, 1.07).type, 'Sprinter');
  assert.equal(fatigueFactor({}, 2).factor, 1.045); // nonsense override ignored
});

test('reference race: the longest they have; a 200 estimated from a 100 when that is all', () => {
  assert.equal(referenceRace({ 'free-200': 120, 'free-500': 320 }, 'free').event.key, 'free-500');
  const est = referenceRace({ 'fly-100': 60 }, 'fly', 1.05);
  assert.equal(est.event.key, 'fly-200');
  assert.equal(est.estimated, true);
  close(est.seconds, 60 * 2 ** 1.099, 0.2);
  assert.equal(referenceRace({ 'fly-50': 26 }, 'fly'), null);
  assert.equal(strokeGears({}, 'free'), null);
});

test('IM Zones row: a 4:00 400 IM at F 1.04 (girls): IM pace, 200 IM, stroke 50s and switches', () => {
  const im = imGears({ 'im-400': 240 }, { factor: 1.04, sex: 'girls' });
  close(im.im200, t('1:51.63'), 0.05);
  const g2 = im.gears.find((g) => g.key === 'G2');
  const g3 = im.gears.find((g) => g.key === 'G3');
  close(g2.pace, t('1:10.2')); close(g3.pace, t('1:06.6'));
  close(im.gears.find((g) => g.key === 'G4').pace, t('1:03.1'));
  close(im.gears.find((g) => g.key === 'G5').pace, t('1:00.5'));
  // Stroke 50s of a 200 IM at G2 (the sheet shows them per 75: fly 48.9, back 52.7, breast 59.6, free 49.5).
  close(g2.strokes.fly * 1.5, 48.9, 0.1); close(g2.strokes.back * 1.5, 52.7, 0.1);
  close(g2.strokes.breast * 1.5, 59.6, 0.1); close(g2.strokes.free * 1.5, 49.5, 0.1);
  // Switches: fly–back 100 = fly 50 + back 50; the 50 is half of that.
  close(g2.switches.flyBack.hundred, g2.strokes.fly + g2.strokes.back, 0.11);
  close(g2.switches.flyBack.fifty, (g2.strokes.fly + g2.strokes.back) / 2, 0.11);
  close(g3.switches.breastFree.hundred, g3.strokes.breast + g3.strokes.free, 0.11);
  // Splits per 25 / 50 / 100 (the 100 is the stroke's share of a 400 IM), each with rest.
  close(g3.splits(100).fly.time, g3.strokes.fly * 2, 0.11);
  close(g3.splits(25).breast.time, g3.strokes.breast / 2, 0.06);
  assert.equal(g3.splits(50).back.time, g3.strokes.back);
  assert.ok(g3.splits(100).breast.rest > g3.splits(25).breast.rest);
  assert.ok(g3.switches.flyBack.rest100 > g3.switches.flyBack.rest50);
  // From a 200 IM alone, or a 200 back with the standards ratio.
  assert.equal(imGears({ 'im-200': 111.63 }, {}).reference.estimated, true);
  close(imGears({ 'im-200': 111.63 }, {}).reference.seconds, 240, 0.1);
  close(imGears({ 'back-200': 120 }, { sex: 'boys', age: '15-16' }).reference.seconds, 120 * 2.182, 0.1);
  assert.equal(imGears({ 'free-200': 120 }, {}), null);
});

test('Speed Table row: a 22.49 50 free (men) is a clean speed of 2.06 yd/s and sets every benchmark', () => {
  close(cleanSpeed(22.49, 'boys'), 2.06, 0.005);
  const s = speedTargets(22.49, 'boys');
  close(s.flagToFlag15, 7.28); close(s.flagsToWall, 2.18); close(s.flagsToFeet, 2.63);
  close(s.dive15.fromStart, 6.36); close(s.dive15.fromFeet, 5.73); close(s.push15, 6.69);
  close(s.toFarFlags20, 8.11); close(s.dive25.fromStart, 10.29); close(s.dive25.fromFeet, 9.66); close(s.push25, 10.62);
  close(s.fifty, 22.49, 0.02); close(s.hundred, 49.12, 0.05);
  close(s.zones.S2, 11.06); close(s.zones.S3, 12.07); close(s.zones.S4, 12.95);
  // A slower row: 2.00 yd/s.
  const slow = speedTargets(23.13, 'boys');
  close(slow.cleanSpeed, 2.0, 0.005); close(slow.push25, 10.94); close(slow.hundred, 50.48, 0.05);
  // Women: a longer block time and slower dive for the same clean speed.
  assert.ok(speedTargets(22.49, 'girls').cleanSpeed > 2.06);
  assert.equal(speedTargets(0), null);
  // Rest that goes with each zone: near full recovery, 1:4, 15 s, 20 s.
  assert.deepEqual(s.zoneRest, { S1: 64, S2: 44, S3: 15, S4: 20 });
});

test('other strokes have their own start and turn models', () => {
  const back = speedTargets(24.5, 'boys', 'back');
  const fly = speedTargets(24.5, 'boys', 'fly');
  const breast = speedTargets(28.5, 'boys', 'breast');
  assert.equal(back.labels.start, 'from the signal');
  assert.equal(fly.labels.feet, 'from feet leaving the block');
  // Each model reproduces the 50 it was given and predicts a plausible 100.
  for (const [s, t] of [[back, 24.5], [fly, 24.5], [breast, 28.5]]) { close(s.fifty, t, 0.02); assert.ok(s.hundred > 2.15 * t && s.hundred < 2.25 * t); }
  // Breaststroke's pullout is fast against its stroke speed: the 15 m push is a smaller share of 15 m at clean speed.
  assert.ok(breast.push15 * breast.cleanSpeed / 16.4 < fly.push15 * fly.cleanSpeed / 16.4);
  // The freestyle model is the default, and unchanged.
  close(speedTargets(22.49, 'boys', 'free').push25, 10.62);
});

test('gearSet: goal or best times, the factor from their best races, speed only with a 50', () => {
  const goals = {
    sex: 'boys', age: '15-16', factor: null,
    times: { 'free-50': { best: 23.5, goal: 22.49 }, 'free-200': { best: 125, goal: 120 }, 'free-500': { best: 330 }, 'free-1650': { best: 1140 }, 'im-200': { goal: 112 } },
  };
  const g = gearSet(goals);
  assert.equal(g.use, 'goal');
  assert.equal(g.factor.from, '500 free and 1650 free');
  assert.equal(g.strokes.free.reference.event.key, 'free-200'); // no 500 goal, so the goal gears come from the 200
  assert.equal(g.strokes.back, null);
  assert.equal(g.im.reference.estimated, true);
  close(g.speed.free.fifty, 22.49, 0.02);
  const best = gearSet(goals, { use: 'best', per: 50 });
  assert.equal(best.strokes.free.reference.event.key, 'free-1650');
  assert.equal(best.strokes.free.per, 50);
  assert.equal(best.im, null);
  assert.equal(gearSet(null), null);
  assert.equal(gearSet({ times: {} }).hasAny, false);
});

test('latestGoals and setTrend: the newest goals win; sets by stroke and distance with a rolling average and gear targets', () => {
  const entries = [
    { date: '2026-10-01', goals: { times: { 'free-200': { goal: 125 } } } },
    { date: '2026-10-05', goals: { times: { 'free-200': { goal: 120 } } }, sets: [{ stroke: 'free', dist: 100, gear: 'G3', reps: 10, avg: 72.0 }] },
    { date: '2026-10-07', sets: [{ stroke: 'free', dist: 100, gear: 'G3', reps: 8, avg: 71.0 }, { stroke: 'free', dist: 50, gear: 'G5', reps: 6, avg: 31.5 }] },
    { date: '2026-10-09', sets: [{ stroke: 'free', dist: 100, gear: 'G3', reps: 10, avg: 70.0 }] },
  ];
  assert.equal(latestGoals(entries).times['free-200'].goal, 120);
  const g = gearSet(latestGoals(entries), { per: 100 });
  const tr = setTrend(entries, { stroke: 'free', dist: 100 }, g.strokes.free);
  assert.deepEqual(tr.points.map((p) => p.avg), [72, 71, 70]);
  assert.deepEqual(tr.points.map((p) => p.rolling), [72, 71.5, 71]);
  close(tr.targets.G3, gearPace(120, 200, 3600, 1.045), 0.1);
  assert.equal(setTrend(entries, { stroke: 'free', dist: 50 }).points.length, 1);
  assert.deepEqual(setTrend(entries, { stroke: 'back', dist: 100 }).points, []);
});
