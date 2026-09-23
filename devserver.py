#!/usr/bin/env python3
"""
Dev-сервер статики с SPA-fallback для локального запуска и превью:
  - неизвестные пути без расширения (например /psy/natalia-...-19) отдают index.html;
  - %BASE% в index.html заменяется на корневой префикс ('/').
GitHub Pages использует ту же схему: .github/workflows/pages.yml собирает _site
(подстановка %BASE% → /<repo>/, копия index.html → 404.html).

Запуск:  python3 devserver.py [port]   (по умолчанию 8765)
"""
import http.server
import os
import sys
import urllib.parse

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
BASE = sys.argv[2] if len(sys.argv) > 2 else '/'

# расширения «настоящих» файлов — по ним НЕ делаем SPA-fallback (битые ассеты должны быть видны)
ASSET_EXTS = {
    '.html', '.js', '.css', '.json', '.map', '.png', '.jpg', '.jpeg', '.svg',
    '.ico', '.webp', '.gif', '.txt', '.xml', '.md', '.sql', '.py', '.yml', '.woff2'
}


class SpaHandler(http.server.SimpleHTTPRequestHandler):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def send_head(self):
        parsed = urllib.parse.urlparse(self.path)
        fs_path = self.translate_path(self.path)
        _, ext = os.path.splitext(parsed.path)
        is_index = parsed.path in ('/', '/index.html') or parsed.path.endswith('/')

        # SPA-fallback: путь не существует и не похож на ассет → index.html
        if not os.path.exists(fs_path) and ext not in ASSET_EXTS:
            self.path = '/index.html'
            is_index = True

        if is_index:
            index_path = os.path.join(ROOT, 'index.html')
            try:
                with open(index_path, 'rb') as f:
                    body = f.read().replace(b'%BASE%', BASE.encode())
            except OSError:
                self.send_error(404, 'index.html not found')
                return None
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()
            # файл отдаётся вне стандартного потока — возвращаем bytes-обёртку
            from io import BytesIO
            return BytesIO(body)

        return super().send_head()

    def copyfile(self, source, outputfile):
        # send_head вернул BytesIO для index — стандартный copyfile совместим
        super().copyfile(source, outputfile)

    def log_message(self, fmt, *args):
        sys.stderr.write('[devserver] %s - %s\n' % (self.address_string(), fmt % args))


if __name__ == '__main__':
    server = http.server.ThreadingHTTPServer(('0.0.0.0', PORT), SpaHandler)
    print(f'PsyhoPortal devserver -> http://0.0.0.0:{PORT}{BASE}')
    server.serve_forever()
