# ISSUE-46 — Challenger kit (TASK 7)

Набор воспроизводимых атак для **независимого** Challenger'а. Исполнитель
(PR #47) этот набор **не сертифицировал**: по `docs/RULES.md` §3 самосертификация
запрещена, поэтому здесь — только команды и критерии, а вывод делает тот, кто
исполнителя не писал.

Правила прогона:

1. **Свежий SHA.** Проверять `main` после merge, не ветку исполнителя: тест
   старого SHA не сертифицирует новый (`docs/RULES.md` §6.15). SHA указать в отчёте.
2. **Каждый пункт — попытка ОПРОВЕРГНУТЬ**, а не подтвердить. Если атака не
   удалась — это результат; если удалась — дефект с Root Cause и новой Issue.
3. **Никаких секретов в отчёте**: OTP, access/refresh-токены, service-role key,
   PII — не публиковать.
4. Классификация вывода: `FACT` / `LIVE EVIDENCE` / `INFERENCE` / `UNKNOWN`.

---

## A. Ссылка из письма ведёт на localhost

**Что опровергаем:** «production email-link никогда не ведёт на localhost».

```bash
# 1. Клиентский канон: в опубликованной сборке не должно быть loopback
curl -s https://a1dmitry.github.io/Psihologist-cabinet/js/services/supabaseConfig.js \
  | grep -n "APPLICATION_URL"
# 2. Автопроверка того же инварианта тестом
node tests/registration-flow.mjs | grep -iE "APPLICATION_URL|loopback|redirect"
# 3. Реальная ссылка из письма (нужен ящик): origin, а не localhost
node tools/prod-e2e.mjs --email <тестовый@email> --link "<ссылка из письма>"
# 4. Секрет функции (владелец, Dashboard → Edge Functions → Secrets):
#    APP_URL обязан быть https://a1dmitry.github.io/Psihologist-cabinet/
#    (значение localhost функция отбрасывает — poka-yoke в supabase/functions/auth-code)
# 5. Supabase Auth → URL Configuration: Site URL и Redirect URLs — тот же origin
```

**FAIL выглядит так:** в письме `http://localhost:…/#error=…`, или `Site URL`
в Dashboard = localhost, или `APP_URL` в секретах = localhost.

## B. Manual OTP и ссылка создают разные identities

**Что опровергаем:** «оба входа → одна canonical Supabase session → один психолог».

```bash
node tests/registration-flow.mjs | grep "два входа"
# Ожидание (все PASS): вход по ссылке → ТОТ ЖЕ psychologist.id, тот же owner_id,
# дубль профиля НЕ создан, sub тот же.
# На реальном проде — то же через --link (см. A.3): сравнивает id с кодовым входом.
```

Дополнительная атака: войти кодом под `user@example.by`, затем кликнуть ссылку,
выданную для `USER@Example.by ` (регистр/пробелы) — профиль должен остаться один
(`claim_psychologist_profile` нормализует email: `lower(trim(...))`).

**FAIL:** два разных `psychologist.id` у одного `auth.uid()`, либо второй профиль
в `psychologists` с тем же email.

## C. Отключённый аккаунт можно реактивировать входом

**Что опровергаем:** «inactive account не реактивируется login-операцией».

```bash
node tests/db-contract.mjs | grep -E "inactive|reactivated"
```

Атака на живом проде (нужен service_role для деактивации — SQL Editor):

```sql
update psychologists set is_active = false where email = '<тестовый@email>';
```
Затем войти кодом тем же email и проверить:

```sql
select id, is_active, owner_id, updated_at from psychologists where email = '<тестовый@email>';
-- Ожидание: is_active = false (вход не изменил), updated_at не изменился
select count(*) from sessions where psychologist_id = '<id>';  -- доступ RLS закрыт
```

И попытаться писать своей живой сессией (до выхода из кабинета):
`PATCH /rest/v1/psychologists?id=eq.<id>` → 0 строк; `GET /rest/v1/sessions` → пусто.

**FAIL:** `is_active` стал `true` после входа, либо данные кабинета читаются/пишутся
сессией, выданной до деактивации.

## D. Можно получить чужой кабинет

**Что опровергаем:** изоляцию владельцев (`owner_id = auth.uid()` + RLS).

```bash
node tests/db-contract.mjs | grep -E "RLS|чужой"
node tests/security-regression.mjs | grep -E "T03"
node tools/prod-e2e.mjs --email <тестовый@email>   # сценарий 3b: tenant isolation
```

Ручная атака с токеном своего психолога (DevTools → Network → заголовок
`Authorization`, токен не публиковать):

```text
GET /rest/v1/psychologists?select=id,email,phone            → только своя строка
GET /rest/v1/psychologists?owner_id=eq.<чужой uuid>&select=id → пусто
GET /rest/v1/sessions?select=id&limit=5                      → только свои
GET /rest/v1/client_risks?select=phone_key                   → 42501/пусто
```

**FAIL:** любая чужая строка, либо `client_risks` читается.

## E. Можно создать дубль психолога

```bash
node tests/db-contract.mjs | grep -E "дубл"
node tests/registration-flow.mjs | grep -E "дубль|повторный вход"
```

Атака на проде: войти дважды тем же email (с интервалом ≥ 31 с из-за кулдауна
отправки) и один раз email'ом с другим регистром и пробелами.

```sql
select lower(trim(email)) e, count(*) from psychologists group by e having count(*) > 1;
-- Ожидание: 0 строк
```

**FAIL:** любая строка в результате запроса выше.

## F. create_booking принимает client-controlled money/status/duration

```bash
node tests/security-regression.mjs | grep -E "T02"
node tests/db-contract.mjs | grep -E "duration|анти-спам"
```

Прямая атака на настоящем PostgreSQL (payload с `p_status='paid'`,
`p_payment_status='paid'`, `p_amount_paid=1000`, `p_currency='USD'`,
`p_duration_min=9999`): сервер обязан вывести значения сам из услуги/настроек
кабинета. На проде — только read-only зонд (запись создаёт реальные данные):

```bash
node tools/prod-probe/probe.mjs | grep -A2 "D rpc"
```

**FAIL:** в `sessions` оказались `status='paid'`, `payment_status='paid'`,
`amount_paid=1000`, `currency='USD'` или `duration_min=9999`.

## G. Production endpoint всё ещё отсутствует

```bash
node tools/prod-probe/probe.mjs          # локально, если есть сеть до supabase.co
# либо прогон workflow "Production read-only probe" (отчёт — комментарием в PR)
```

Критерий «endpoint поднят»: `GET /functions/v1/auth-code` отвечает **не**
gateway-404 (`405/400/200` от самой функции), а `create_booking` резолвится для
anon (иначе публичная запись не работает).

**FAIL:** `{"code":"NOT_FOUND"}` от gateway, либо `PGRST202` на `create_booking`.

## H. Зелёный CI маскирует провал

**Что опровергаем:** «зелёный CI = задача выполнена».

```bash
# 1. Негативные контроли харнеса обязаны быть КРАСНЫМИ по построению:
node tests/harness-guard.mjs | grep -E "негативн|negative|≠0"
# 2. Фальсификация гейта: сломать один доменный инвариант и убедиться, что CI краснеет
sed -i "s/const DEFAULT_DURATION_MIN = 60/const DEFAULT_DURATION_MIN = 45/" js/domain/duration.js
node tools/verify_all.mjs ; echo "exit=$?"   # ожидание: ≠ 0
git checkout -- js/domain/duration.js
# 3. Гейт действительно обязателен для деплоя:
grep -n "needs: quality-gate" .github/workflows/pages.yml
grep -n "workflow_call" .github/workflows/verify.yml
# 4. Каждый tests/*.mjs зарегистрирован в гейте (иначе тест есть, а не гоняется):
node tests/harness-guard.mjs | grep -i "зарегистрирован"
```

**FAIL:** `verify_all` выходит 0 при сломанном инварианте; или деплой Pages
выполняется без `quality-gate`; или набор из `tests/` отсутствует в `SUITES`.

---

## Форма отчёта Challenger'а

```text
SHA main:            <sha>
Дата/UTC:            <iso>
Каналы:              repo (локально) / LIVE (prod probe, run <id>)

A localhost-link:            PASS/FAIL/UNKNOWN  <evidence>
B одна identity на 2 входа:  PASS/FAIL/UNKNOWN  <evidence>
C inactive не реактивируется:PASS/FAIL/UNKNOWN  <evidence>
D чужой кабинет:             PASS/FAIL/UNKNOWN  <evidence>
E дубль профиля:             PASS/FAIL/UNKNOWN  <evidence>
F client-controlled money:   PASS/FAIL/UNKNOWN  <evidence>
G endpoint в проде:          PASS/FAIL/UNKNOWN  <evidence>
H CI не маскирует:           PASS/FAIL/UNKNOWN  <evidence>

Новые дефекты (Issue + Root Cause):
Остаточный риск:
ВЕРДИКТ: PASS / FAIL
```

После PASS Challenger'а — **Main Re-Audit** на том же SHA, затем закрытие #46
и синхронизация `docs/CURRENT-STATE.md`.
