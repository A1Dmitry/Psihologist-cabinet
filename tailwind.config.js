/** Tailwind CSS — конфиг сборки (замена runtime CDN cdn.tailwindcss.com).
 *
 * Сборка (результат коммитится в css/tailwind.css, чтобы локальный devserver
 * и GitHub Pages работали без Node; CI пересобирает при деплое):
 *   npx --yes tailwindcss@3.4.17 -c tailwind.config.js -i css/tailwind.src.css -o css/tailwind.css --minify
 *
 * Content-сканирование: только index.html и js/ — классы собираются в эти файлы.
 * Динамические классы в JS допустимы ТОЛЬКО полными литералами (тернарники
 * вида ${ok ? 'bg-emerald-50' : 'bg-rose-50'} сканер видит как токены).
 * Конкатенация половинок класса ('bg-' + color) НЕ поддерживается — за этим
 * следит tools/verify_tailwind.mjs (каждый использованный класс обязан
 * присутствовать в собранном CSS).
 */
module.exports = {
  content: ['./index.html', './js/**/*.js'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
      colors: {
        // те же оттенки, что были в inline-конфиге CDN (совпадают с дефолтом v3)
        indigo: { 50: '#eef2ff', 100: '#e0e7ff', 600: '#4f46e5', 700: '#4338ca' }
      }
    }
  },
  corePlugins: { preflight: true }
};
