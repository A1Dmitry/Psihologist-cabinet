/**
 * Инъекция часов процесса для дата-чувствительных наборов (issue #92, RRSI-004).
 *
 *   FAKE_NOW=2026-09-28T10:00:00Z node --import ./tools/fake-clock.mjs tools/verify_cabinet.mjs
 *
 * `new Date()` без аргументов и `Date.now()` отсчитываются от FAKE_NOW; время
 * идёт с обычной скоростью (сдвиг, а не заморозка). `new Date(x)`, `Date.parse`,
 * `Date.UTC`, `instanceof Date` и наследование от Date не меняются. Модуль
 * грузится через `--import` ДО кода приложения, поэтому `todayStr()` /
 * `weekdayOf(todayStr())` приложения видят закреплённую дату.
 *
 * Fail closed: без валидного FAKE_NOW модуль бросает ошибку — тихий прогон на
 * реальной дате выдал бы «матрицу дней недели» за проверку, которой не было.
 *
 * Только для проверок: приложение этот модуль не импортирует.
 * Потребитель: tests/cabinet-weekday-matrix.mjs.
 */
const RealDate = globalThis.Date;
const raw = process.env.FAKE_NOW || '';
const target = RealDate.parse(raw);
if (!raw || Number.isNaN(target)) {
  throw new Error(`fake-clock: FAKE_NOW не задан или некорректен (${JSON.stringify(raw)})`);
}
const offset = target - RealDate.now();
const now = () => RealDate.now() + offset;

globalThis.Date = new Proxy(RealDate, {
  construct(Target, args, newTarget) {
    return Reflect.construct(Target, args.length ? args : [now()], newTarget);
  },
  // Date() без new по спецификации возвращает строку текущего времени
  apply() {
    return new RealDate(now()).toString();
  },
  get(Target, prop, receiver) {
    if (prop === 'now') return now;
    return Reflect.get(Target, prop, receiver);
  }
});
