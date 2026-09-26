#!/usr/bin/env node
/**
 * Issue #92 — набор кабинета (tools/verify_cabinet.mjs) не зависит от дня недели.
 *
 *   node tests/cabinet-weekday-matrix.mjs
 *
 * Дефект гейта: набор краснел в Сб/Вс/Пн/Вт и ложно зеленел в Ср/Чт/Пт.
 * Причин было две, обе в секции 11 набора:
 *  1. новая серия бралась как vm.series[length-1], а список сортирован по
 *     (weekday, time) — «последней» она была только при weekdayOf(today+9) > 4;
 *  2. дата заявки plus(9) в понедельник попадала на среду, где серия клиента
 *     «Ср 09:00» из секции 7 занимает слот все 8 недель → created: 0.
 * Прогон «на сегодня» не видит дефект в «удачный» день, а исправление только
 * причины 1 оставляло красным понедельник. Поэтому набор гоняется на 7
 * закреплённых датах подряд — все ISO-дни недели — с инъекцией часов
 * tools/fake-clock.mjs (RRSI-004: «пинить today»).
 *
 * Анти-плацебо (матрица не должна зеленеть, не проверив ничего):
 *  a. без FAKE_NOW шов обязан упасть (fail closed), а не тихо идти на реальной дате;
 *  b. в дочернем процессе todayStr()/weekdayOf() приложения обязаны вернуть
 *     закреплённую дату — иначе «матрица» 7 раз гоняла бы один и тот же день;
 *  c. даты матрицы обязаны покрывать все 7 дней недели;
 *  d. число проверок набора одинаково во все дни (ни одна не пропущена молча).
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLOCK = pathToFileURL(join(ROOT, 'tools/fake-clock.mjs')).href;
const TZ_SERVICE = pathToFileURL(join(ROOT, 'js/services/timezoneService.js')).href;
const SUITE = 'tools/verify_cabinet.mjs';
// Пн 2026-09-28 … Вс 2026-10-04: все ISO-дни недели + переход сентябрь → октябрь.
// 10:00Z — одна и та же календарная дата для поясов UTC−10…UTC+13
// (plus() в наборе считает в локальном поясе процесса).
const DAYS = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];
const WEEKDAY_RU = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const at = day => `${day}T10:00:00Z`;
const dayLabel = day => `${day} (${WEEKDAY_RU[new Date(at(day)).getUTCDay()]})`;

let failed = 0;
const check = (name, cond, extra = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` → ${extra}`}`);
};
const oneLine = s => s.replace(/\s+/g, ' ').trim().slice(0, 400);

/** node --import fake-clock <args>; fakeNow === null — запуск без FAKE_NOW */
function runWithClock(args, fakeNow) {
  const env = { ...process.env };
  if (fakeNow === null) delete env.FAKE_NOW;
  else env.FAKE_NOW = fakeNow;
  const r = spawnSync(process.execPath, ['--import', CLOCK, ...args], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 120000
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

console.log('a. Шов часов: fail closed');
{
  const bare = runWithClock(['-e', 'console.log("RAN ON REAL CLOCK")'], null);
  check('без FAKE_NOW шов падает, а не идёт на реальной дате',
    bare.code !== 0 && /fake-clock: FAKE_NOW/.test(bare.out) && !/RAN ON REAL CLOCK/.test(bare.out),
    `exit=${bare.code} ${oneLine(bare.out)}`);
}

console.log('\nb/c. Шов часов доходит до кода приложения; даты покрывают неделю');
const weekdays = new Set();
{
  const probe = `import { todayStr, weekdayOf } from ${JSON.stringify(TZ_SERVICE)};
const t = todayStr();
console.log('CLOCK ' + JSON.stringify({ today: t, weekday: weekdayOf(t), iso: new Date().toISOString(),
  fixed: new Date(0).toISOString(), isDate: new Date() instanceof Date }));`;
  for (const day of DAYS) {
    const r = runWithClock(['--input-type=module', '-e', probe], at(day));
    const line = r.out.split('\n').find(l => l.startsWith('CLOCK ')) || '';
    let got = null;
    try { got = JSON.parse(line.slice('CLOCK '.length)); } catch { got = null; }
    if (got) weekdays.add(got.weekday);
    check(`${dayLabel(day)}: todayStr() приложения = закреплённая дата`,
      r.code === 0 && got?.today === day && String(got?.iso).startsWith(day)
        && got?.fixed === '1970-01-01T00:00:00.000Z' && got?.isDate === true,
      `exit=${r.code} ${oneLine(r.out)}`);
  }
  check('даты матрицы покрывают все 7 дней недели (ISO 1…7)',
    [1, 2, 3, 4, 5, 6, 7].every(d => weekdays.has(d)), JSON.stringify([...weekdays].sort()));
}

console.log(`\nd. ${SUITE} на каждом дне недели`);
{
  const totals = [];
  for (const day of DAYS) {
    const r = runWithClock([SUITE], at(day));
    const m = /Итого: (\d+) PASS \/ (\d+) FAIL/.exec(r.out);
    const fails = r.out.split('\n')
      .filter(l => /^\s*❌/.test(l) && !/Итого/.test(l))
      .map(l => l.replace(/^\s*❌\s*/, '').trim());
    if (m) totals.push(Number(m[1]));
    check(`${dayLabel(day)}: набор кабинета зелёный`,
      r.code === 0 && !!m && m[2] === '0' && fails.length === 0,
      `exit=${r.code} ${m ? m[0] : 'нет строки «Итого»'}${fails.length ? ' · ' + fails.join(' | ') : ''}`);
  }
  check('число проверок набора одинаково во все дни (ни одна не пропущена молча)',
    totals.length === DAYS.length && new Set(totals).size === 1 && totals[0] > 0,
    JSON.stringify(totals));
}

console.log(`\nИтог: ${failed ? `${failed} провал(ов)` : 'все проверки пройдены'}`);
process.exit(failed ? 1 : 0);
