#!/usr/bin/env python3
"""
Смоук-проверка сайта (локально или на GitHub Pages):

    BASE_URL=https://a1dmitry.github.io/Psihologist-cabinet python3 verify_pages.py
    BASE_URL=http://127.0.0.1:8765 python3 verify_pages.py

Проверяет:
  - главная отдаётся и %BASE% подставлен;
  - ассеты (/js/app.js) доступны;
  - SPA-fallback работает для индексируемых URL (/psy/<slug>, /cabinet, /auth);
  - отсутствующие ассеты НЕ маскируются (404 остаётся 404).
"""
import os
import sys
import urllib.error
import urllib.request

BASE_URL = (os.environ.get('BASE_URL') or 'http://127.0.0.1:8765').rstrip('/')
# любой слаг подходит: проверяем форму URL, а не конкретную запись
SLUG = os.environ.get('CHECK_SLUG') or 'nataliya-mikhajlovskaya-19'

CHECKS = [
    ('/', 200, 'Портал профессиональных услуг'),
    ('/index.html', 200, 'Портал профессиональных услуг'),
    ('/js/app.js', 200, 'import'),
    ('/js/core/dbContext.js', 200, 'export'),
    ('/css/tailwind.css', 200, '--tw-'),       # сборка Tailwind (не runtime CDN)
    (f'/psy/{SLUG}', 200, 'js/app.js'),          # страница специалиста (SPA-fallback)
    (f'/book/{SLUG}', 200, 'js/app.js'),         # страница записи (SPA-fallback)
    ('/cabinet', 200, 'Портал профессиональных услуг'),
    ('/auth', 200, 'Портал профессиональных услуг'),
    ('/onboarding', 200, 'Портал профессиональных услуг'),   # онбординг после первого входа через Google
    ('/booking-done', 200, 'Портал профессиональных услуг'),
    ('/reply?reply=smoke-token', 200, 'Портал профессиональных услуг'),
    ('/js/definitely-missing.js', 404, None),    # битые ассеты не маскируются
]

failed = 0
for path, expect_status, expect_text in CHECKS:
    url = BASE_URL + path
    try:
        with urllib.request.urlopen(url, timeout=15) as res:
            status, body = res.status, res.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        status, body = e.code, ''
    except Exception as e:  # noqa: BLE001
        print(f'FAIL {path}: {e}')
        failed += 1
        continue

    ok = status == expect_status and (expect_text is None or expect_text in body)
    if expect_text and '%BASE%' in body:
        ok = False  # плейсхолдер не подставлен
    print(f'{"PASS" if ok else "FAIL"} {path} [{status}]')
    if not ok:
        failed += 1

print(f'\n{"FAILED: " + str(failed) if failed else "ALL PASS"}')
sys.exit(1 if failed else 0)
