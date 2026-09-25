# ISSUE-21 п.4 — Producer-отчёт: демо-оплата без ложного production success

> **АУДИТОР: САМ** (тот же конвейер, что внёс правки; 2026-09-25 UTC).
> Независимый Challenger и Main Re-Audit — **OPEN**.
> Канон: GitHub issue #21, оставшийся repo-пункт 4 («demo pay is local-only»).
> Продуктовый эквайринг **не** внедрялся (явный запрет канона).

## 1. ПЕРВОНАЧАЛЬНАЯ ЦЕЛЬ

Закрыть ложный успех демо-оплаты на публичной странице записи:

- `BookingViewModel.completePayment` → `paymentService.paySession` менял только
  `localStorage`, UI писал «оплата прошла», Telegram — «Оплата прошла (сайт)»,
  серверная сессия оставалась `held`/`unpaid`.
- Канон: либо реальный server-ack, либо честный local-only UX.
- Не внедрять эквайринг. Не трогать server-owned `create_booking` (уже в main).
- Не закрывать #21 целиком: production-гейт (`create_booking` для anon) и
  независимый Challenger остаются OPEN.

## 2. РЕЗУЛЬТАТ

Сделано в ветке `arena/01a0d747-psihologist-cabinet`:

1. `completePayment` при `supabaseSync.enabled()` **отказывает**: сессия не
   переводится в paid, payments не пишутся, `done` не взводится, ошибка честно
   говорит «демо-оплата не записывается на сервер».
2. Telegram «Оплата прошла (сайт)» с публичной демо-кнопки **снят** (и в
   local-only контуре тоже: демо не является оплатой).
3. Панель оплаты рисуется из `paymentCheckout` (один источник): при живом
   сервере демо-кнопок нет; без сервера — демо с пометкой «только этот браузер».
4. Poka-Yoke: даже если в разметке останется `data-pay-demo`, VM не подтвердит
   серверную запись.
5. Negative + positive controls: `tests/demo-pay-honesty.mjs` (зарегистрирован
   в `SUITES`).
6. `verify_telegram.mjs`: статическая проверка перевернута — BVM **не** шлёт
   payment-webhook с демо-кнопки (старый ассерт фиксировал ложный успех).
   CVM «оплата → Telegram» (отметка владельцем) сохранена.

## 3. ПРОВЕРКА

- `node tests/demo-pay-honesty.mjs` → ALL PASS, exit 0 (24 проверки).
- `node tools/verify_all.mjs` → **26/26 наборов, 1211 проверок, exit 0**.
- `BASE_URL=http://127.0.0.1:8765 python3 verify_pages.py` против живого
  `devserver.py` → **ALL PASS** (12 проверок).

Окружение: песочница Arena, node из гейта. Production RPC не вызывался
(egress/`create_booking` для anon — LIVE-блокер #46/#21).

## 4. ПОЛОЖИТЕЛЬНЫЕ РЕЗУЛЬТАТЫ

- При живом Supabase (anon key в репозитории задан → `enabled()===true`)
  `completePayment('card_demo'|'transfer')` → `false`, статус `held`/`unpaid`.
- UI-гетер `allowDemoPay === false` на production-пути.
- Локальный контур (`enabled()===false`) по-прежнему подтверждает запись
  в браузере и **признаёт** это в `successText`.
- Старая сноска «После оплаты запись считается подтверждённой» убрана из `app.js`.

## 5. ОТРИЦАТЕЛЬНЫЕ РЕЗУЛЬТАТЫ

- Независимый Challenger #21 не выполнялся.
- Main Re-Audit на `origin/main` после merge не выполнялся.
- Production: `create_booking` для anon по-прежнему недоступен (LIVE, #46) —
  публичная запись в проде не работает; этот фикс не разблокирует её.
- Кабинетный `markPaidByPsychologist` / `paySession` не менялись (другой
  контур: владелец отмечает оплату вручную). Не проверялось, синкает ли
  кабинет отметку на сервер — **вне п.4**.
- Issue #21 **не закрывается** этим PR.

## 6. ТУФТА НАЙДЕНА

- В исходном коде: семантическая подмена «демо-кнопка = оплата прошла» при
  живом сервере (форма 2 Goal Drift внутри UX). Исправлено.
- Не выдаём DONE по зелёному гейту: RULES §6.1 — merge/CI ≠ завершение issue.
- Не подгоняли тест под кнопку: negative control идёт через **реальный**
  `completePayment` + живой `enabled()`, не через захардкоженный флаг.

## 7. КОРЕННЫЕ ПРИЧИНЫ

5 Why (п.4):

1. Почему UI писал «оплата прошла»? → `completePayment` всегда вызывал
   `paySession` и ставил `done=true`.
2. Почему `paySession` считался успехом? → это единственный «эквайринг» в
   приложении, и он писался как демо в localStorage.
3. Почему localStorage выдавался за сервер? → не было ветки «сервер настроен /
   не настроен», хотя `_persistBooking` уже различает `localOnly`.
4. Почему контроль пропустил? → не было теста «completePayment + sync enabled».
5. Почему Telegram врал? → success-path слал webhook до проверки server-ack.

Системно: demo acquiring жил в том же методе, что и «запись оплачена».

## 8. РЕМОНТ

- Канон из #21 п.4: demo может остаться, но без false production success.
- Owner инварианта — `BookingViewModel.completePayment` + `paymentCheckout`.
- UI не принимает самостоятельного решения о демо-кнопках.
- Negative control в гейте (`tests/demo-pay-honesty.mjs`).

## 9. ОСТАВШИЕСЯ РИСКИ

- Психолог в кабинете по-прежнему может отметить оплату локально без
  server-ack (`markPaidByPsychologist` → `paySession`) — **не п.4**, отдельный
  residual, если sync включён.
- Клиент на проде видит «ожидайте подтверждения психологом» вместо кнопки;
  если реквизиты не показаны рядом, UX может быть неясен. Реквизиты уже есть
  на профиле; в панель оплаты их не дублировали (не расширяли scope).
- Production booking всё ещё мёртв (`create_booking` anon PGRST202).

## 10. ДОКАЗАТЕЛЬСТВО

- Код: `js/viewmodels/BookingViewModel.js` (`demoPayIsLocalOnly`,
  `paymentCheckout`, `completePayment`), `js/app.js` (панель из гетера).
- Тест: `tests/demo-pay-honesty.mjs` — 24 PASS, exit 0.
- Регистрация: `tools/verify_all.mjs` SUITES.
- Канон: GitHub #21, reproduction C.

## 11. ОКОНЧАТЕЛЬНЫЙ СТАТУС

**ЧАСТИЧНО ЗАВЕРШЕНО.** Repo-пункт 4 закрыт кодом и тестом. Issue #21 целиком
не закрывается: нет независимого Challenger, нет Main Re-Audit, production
`create_booking` для anon недоступен.

## 12. УВЕРЕННОСТЬ

Высокая для repo-фактов (прямой прогон `completePayment` при реальном
`supabaseSync.enabled()===true` и при stub `false`). Нулевая для production
E2E оплаты — контур записи в проде не работает, не вызывался.
Маркер: АУДИТОР: САМ.
