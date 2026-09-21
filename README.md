# Psihologist-cabinet

Портал кабинетов психологов (клиентское SPA): каталог, запись, оплата/аванс, напоминания с подтверждением, перенос с согласием клиента, шифрование PII ключом из пароля психолога.

## Запуск

```bash
python3 -m http.server 8765
# или
./serve.sh
```

Откройте http://127.0.0.1:8765/

## Архитектура

- **MVVM** + Code First (`js/models`, `js/viewmodels`, `js/core/dbContext.js`)
- **Изоляция кабинетов** по `psychologistId`
- **Шифрование клиентов**: PBKDF2 + AES-GCM

## Целевой репозиторий

https://github.com/mikhailouskayanataliya-collab/Psihologist-cabinet

Рабочая копия через подключённый GitHub-аккаунт (A1Dmitry).

## Демо

Вход психолога: email + код + **пароль** (ключ сейфа).
