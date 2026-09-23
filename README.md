# Psihologist-cabinet

Портал кабинетов психологов (SPA): каталог, запись, оплата/аванс, напоминания, перенос с согласием, шифрование PII.

**Рабочий репозиторий:** https://github.com/A1Dmitry/Psihologist-cabinet  
**Целевой (позже):** https://github.com/mikhailouskayanataliya-collab/Psihologist-cabinet

## Запуск

```bash
python3 -m http.server 8765
# или
chmod +x serve.sh && ./serve.sh
```

Открыть: http://127.0.0.1:8765/

## Структура

- `index.html` — UI
- `js/models` — Code First
- `js/core/dbContext.js` — хранилище
- `js/viewmodels` — MVVM
- `js/services` — auth, crypto, vault, payment, reminders, fraud
- `supabase/schema.sql` — DDL БД (Supabase/PostgreSQL, идемпотентный)
- `supabase/seed.sql` — референс-данные профиля с сайта nataliamikhailouskaya.by
- `docs/DATA-MODEL.md` — модель данных сайта, сверка и маппинг в БД

## Демо

Вход психолога: email + код + пароль (ключ AES).

Полный исходник также в артефактах проекта (`portal/`).
