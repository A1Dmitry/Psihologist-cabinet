# Архив: перенос репозитория (COLLAB.md / TRANSFER.md)

> Статус на 2026-09-23: **ОТКРЫТЫЙ ВОПРОС к владельцу продукта.**
> Зафиксировано Агентом 1 (инфраструктура).

## Контекст

Изначально предполагалось перенести проект из рабочего репозитория
`A1Dmitry/Psihologist-cabinet` в `mikhailouskayanataliya-collab/Psihologist-cabinet`
(см. `COLLAB.md`, `TRANSFER.md` в этой папке).

## Проверка 2026-09-23

- Целевой репозиторий `mikhailouskayanataliya-collab/Psihologist-cabinet`
  **недоступен из API GitHub** (404): приглашение коллаборатору не принято,
  либо репозиторий приватный/не существует.
- Текущий репозиторий `A1Dmitry/Psihologist-cabinet` публичный, доступен,
  на нём развёрнут GitHub Pages (см. `.github/workflows/pages.yml`).

## Решение

**Текущий репозиторий `A1Dmitry/Psihologist-cabinet` зафиксирован как основной
и единственный источник истины.** Файлы COLLAB/TRANSFER перемещены из корня
в этот архив, чтобы не путать следующих агентов.

## Как возобновить перенос (если владелец решит)

1. Владелец аккаунта `mikhailouskayanataliya-collab` приглашает `A1Dmitry`
   коллаборатором (Write) в целевой репозиторий.
2. `A1Dmitry` принимает приглашение (https://github.com/notifications).
3. Mirror-push по инструкции из `TRANSFER.md`.
4. Перенести/перенастроить: GitHub Pages (workflow `pages.yml`), Secrets/Variables
   Actions (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_ACCESS_TOKEN`),
   бейдж/ссылки в README.
5. **Никакие GitHub Secrets и access-токены между аккаунтами не переносятся
   автоматически** — задаются заново в целевом репозитории.
