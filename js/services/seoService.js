/**
 * SEO-слой (известные наработки для малого бизнеса с онлайн-записью):
 *  - человеко-читаемый URL страницы специалиста: {base}/psy/{slug} (индексируемый);
 *  - canonical + Open Graph + Twitter Card;
 *  - структурированные данные schema.org: ProfessionalService (+ Person для специалиста)
 *    с каталогом услуг (OfferCatalog → makesOffer) — как у Calendly/Booksy-страниц;
 *  - дискриминатор профессии → schema.org-тип (расширение не только на психологов).
 */
import { Professions } from '../models/entities.js';

/**
 * Optional single-point override for a future custom domain. Keep empty in the
 * repository: production then uses the current GitHub Pages origin (or the
 * origin serving the app), without baking a domain into profile data.
 */
export const SEO_BASE_URL = '';

export function seoUrl(path) {
  const value = String(path || '');
  if (/^https?:\/\//i.test(value)) return value;
  const origin = SEO_BASE_URL || (typeof location !== 'undefined' ? location.origin : '');
  if (!origin) return value;
  try { return new URL(value || '/', origin).href; } catch (_) { return value; }
}

function upsertMeta(selector, create) {
  let el = document.head.querySelector(selector);
  if (!el) {
    el = create();
    document.head.appendChild(el);
  }
  return el;
}

export function setCanonical(href) {
  const el = upsertMeta('link[rel="canonical"]', () => {
    const l = document.createElement('link');
    l.rel = 'canonical';
    return l;
  });
  el.href = href;
}

/**
 * robots: по умолчанию страницы открыты для индексации. Явно снимаем noindex,
 * чтобы он «не прилипал» при переходах между маршрутами (SPA без перезагрузки).
 */
export function setRobots(content = 'index,follow') {
  const el = upsertMeta('meta[name="robots"]', () => {
    const m = document.createElement('meta');
    m.name = 'robots';
    return m;
  });
  el.setAttribute('content', content);
}

export function setMeta({ title, description, url, image, ogType = 'website', robots }) {
  if (title) document.title = title;
  setRobots(robots || 'index,follow');
  // Абсолютные адреса для og:url/og:image и canonical (относительные пути
  // разворачиваются в текущий origin); без них ссылки в разметке не работают.
  const resolvedUrl = url ? seoUrl(url) : '';
  const resolvedImage = image ? seoUrl(image) : '';
  const set = (selector, attr, key, value, create) => {
    if (!value) return;
    const el = upsertMeta(selector, create);
    el.setAttribute(attr, key);
    el.setAttribute('content', value);
  };
  set('meta[name="description"]', 'name', 'description', description, () => {
    const m = document.createElement('meta'); m.name = 'description'; return m;
  });
  set('meta[property="og:title"]', 'property', 'og:title', title, () => document.createElement('meta'));
  set('meta[property="og:description"]', 'property', 'og:description', description, () => document.createElement('meta'));
  set('meta[property="og:url"]', 'property', 'og:url', resolvedUrl, () => document.createElement('meta'));
  set('meta[property="og:type"]', 'property', 'og:type', ogType, () => document.createElement('meta'));
  set('meta[property="og:image"]', 'property', 'og:image', resolvedImage, () => document.createElement('meta'));
  set('meta[name="twitter:card"]', 'name', 'twitter:card', resolvedImage ? 'summary_large_image' : 'summary', () => document.createElement('meta'));
  if (resolvedUrl) setCanonical(resolvedUrl);
}

export function setJsonLd(data) {
  if (!data) { clearJsonLd(); return; }
  let el = document.head.querySelector('script#ld-json');
  if (!el) {
    el = document.createElement('script');
    el.type = 'application/ld+json';
    el.id = 'ld-json';
    document.head.appendChild(el);
  }
  el.textContent = JSON.stringify(data);
}

/** Убрать структурированные данные (например, когда страницы-сущности нет). */
export function clearJsonLd() {
  document.head.querySelector('script#ld-json')?.remove();
}

/** Корень сайта по URL страницы специалиста (/{repo}/psy/{slug} → /{repo}/). */
function baseOf(pageUrl) {
  try {
    const u = new URL(pageUrl, typeof location !== 'undefined' ? location.origin : 'https://localhost');
    return u.origin + u.pathname.replace(/\/(psy|book)\/[^/]+\/?$/, '/');
  } catch (_) {
    return null;
  }
}

/** Хлебные крошки schema.org: Портал профессиональных услуг → Специалист → (Запись). */
export function buildBreadcrumbs(baseUrl, items) {
  const list = (items || []).filter(Boolean).map((it, i) => ({
    '@type': 'ListItem',
    position: i + 1,
    name: it.name,
    ...(it.url ? { item: it.url } : {})
  }));
  return list.length
    ? { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: list }
    : null;
}

/** Действие «Записаться» — чтобы карточка специалиста отвечала на запрос «запись онлайн». */
function reserveAction(bookUrl, psyName) {
  return {
    '@type': 'ReserveAction',
    name: `Запись на консультацию — ${psyName}`,
    target: {
      '@type': 'EntryPoint',
      urlTemplate: bookUrl,
      inLanguage: 'ru',
      actionPlatform: [
        'http://schema.org/DesktopWebPlatform',
        'http://schema.org/MobileWebPlatform'
      ]
    },
    result: { '@type': 'Reservation', name: 'Запись на консультацию' }
  };
}

/**
 * Пустая/несуществующая страница: честный noindex.
 * GitHub Pages теперь отдаёт реальные маршруты со статусом 200, поэтому без
 * этой метки в индекс попадали бы пустые карточки («Психолог не найден»).
 */
export function applyNoIndex(reason = '') {
  document.title = 'Страница не найдена — Портал профессиональных услуг';
  setRobots('noindex,nofollow');
  clearJsonLd();
  if (reason) console.info('[SEO] noindex:', reason);
}

/**
 * JSON-LD страницы специалиста:
 * @graph [Person + ProfessionalService/MedicalBusiness/… + BreadcrumbList].
 * services — его услуги (Offer). Действие «Записаться» (ReserveAction) ссылается
 * на /book/{slug} — индексируемая страница записи.
 */
export function buildProfileJsonLd(psy, services, pageUrl, { bookUrl } = {}) {
  const profession = Professions[psy.profession] || Professions.psychologist;
  // pageUrl может содержать hash (#/psy/slug) — @id строим от чистой части
  const baseUrl = String(pageUrl || '').split('#')[0];
  const personId = `${baseUrl}#person`;
  const offerCatalog = (services || []).filter(s => s.isActive !== false).map(s => ({
    '@type': 'Offer',
    name: s.name,
    description: s.description || undefined,
    price: s.price,
    priceCurrency: s.currency === 'BYN' ? 'BYN' : 'RUB',
    eligibleQuantity: { '@type': 'QuantitativeValue', unitCode: 'MIN', value: s.duration }
  }));

  const person = {
    '@type': 'Person',
    '@id': personId,
    name: psy.fullName,
    description: [psy.greeting, psy.about, psy.approach].filter(Boolean).join(' ').slice(0, 500) || undefined,
    image: psy.photoUrl || undefined,
    email: psy.publicEmail || undefined,
    telephone: psy.phone || undefined,
    sameAs: (psy.socials || []).map(s => s.url).filter(Boolean),
    alumniOf: (psy.education?.basic || []).map(e => ({ '@type': 'EducationalOrganization', name: e.institution || e.title })),
    knowsAbout: (psy.directions || []).map(d => d.title).filter(Boolean)
  };

  const organization = {
    '@type': profession.schemaType,
    '@id': pageUrl,
    name: `${psy.fullName} — ${psy.specialization || profession.label}`,
    description: psy.about || undefined,
    url: pageUrl,
    image: psy.photoUrl || undefined,
    telephone: psy.phone || undefined,
    email: psy.publicEmail || undefined,
    priceRange: offerCatalog.length ? `${Math.min(...offerCatalog.map(o => Number(o.price) || 0))}+` : undefined,
    address: psy.address ? {
      '@type': 'PostalAddress',
      addressLocality: psy.city || undefined,
      streetAddress: psy.address,
      addressCountry: 'BY'
    } : undefined,
    sameAs: (psy.socials || []).map(s => s.url).filter(Boolean),
    employee: { '@id': personId },
    hasOfferCatalog: offerCatalog.length ? {
      '@type': 'OfferCatalog',
      name: 'Услуги',
      itemListElement: offerCatalog
    } : undefined,
    makesOffer: offerCatalog.length ? offerCatalog : undefined,
    ...(bookUrl ? { potentialAction: reserveAction(bookUrl, psy.fullName) } : {})
  };

  const base = baseOf(pageUrl);
  const breadcrumbs = buildBreadcrumbs(base, [
    { name: 'Портал профессиональных услуг', url: base },
    { name: psy.fullName, url: pageUrl }
  ]);

  return {
    '@context': 'https://schema.org',
    '@graph': [person, organization, breadcrumbs].filter(Boolean)
  };
}

/** SEO для страницы публичной записи специалиста */
export function applyProfileSeo(psy, services, pageUrl, { bookUrl } = {}) {
  const profession = Professions[psy.profession] || Professions.psychologist;
  const title = `${psy.fullName} — ${psy.specialization || profession.label.toLowerCase()} · запись онлайн`;
  const description = [psy.greeting, psy.about].filter(Boolean).join(' ').slice(0, 300)
    || `Запись на консультацию: ${psy.fullName}. ${psy.city || ''}`.trim();
  const canonicalUrl = seoUrl(pageUrl);
  setMeta({
    title,
    description,
    url: canonicalUrl,
    image: psy.photoUrl || '',
    ogType: 'profile'
  });
  setJsonLd(buildProfileJsonLd(psy, services, pageUrl, { bookUrl }));
}

/** SEO главной (каталог) */
export function applyPortalSeo(baseUrl) {
  const canonicalUrl = seoUrl(baseUrl);
  setMeta({
    title: 'Портал профессиональных услуг — кабинеты специалистов · запись на консультацию',
    description: 'Каталог специалистов: публичный профиль, услуги и цены, онлайн-запись на консультацию. Минск, Гродно и вся Беларусь.',
    url: canonicalUrl,
    ogType: 'website'
  });
  setJsonLd({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'Портал профессиональных услуг',
    url: canonicalUrl,
    potentialAction: {
      '@type': 'SearchAction',
      target: `${canonicalUrl}?q={search_term_string}`,
      'query-input': 'required name=search_term_string'
    }
  });
}

/**
 * SEO страницы записи /book/{slug}: заголовок и описание — под выбранную услугу
 * (пришли по ссылке «услуга → окна»), плюс хлебные крошки.
 * Основной JSON-LD (Person + ProfessionalService) остаётся на странице профиля —
 * так карточка специалиста не дублируется между URL.
 */
export function applyBookingSeo(psy, pageUrl, { service } = {}) {
  const profession = Professions[psy.profession] || Professions.psychologist;
  const svcText = service
    ? `«${service.name}»${service.duration ? `, ${service.duration} мин` : ''}${service.price ? `, ${service.price} ${service.currency === 'RUB' ? 'рос. руб.' : 'бел. руб.'}` : ''}`
    : '';
  const title = svcText
    ? `Запись на ${svcText} — ${psy.fullName} · Портал профессиональных услуг`
    : `Запись — ${psy.fullName} · Портал профессиональных услуг`;
  const description = `Онлайн-запись к специалисту ${psy.fullName}${psy.city ? ` (${psy.city})` : ''}`
    + `${svcText ? ` на ${svcText}` : ''}: выбор свободного времени в вашем часовом поясе`
    + ' и удобного способа оплаты. Без регистрации.';
  setMeta({
    title,
    description,
    url: pageUrl,
    image: psy.photoUrl || '',
    ogType: 'website'
  });
  const base = baseOf(pageUrl);
  setJsonLd(buildBreadcrumbs(base, [
    { name: 'Портал профессиональных услуг', url: base },
    { name: psy.fullName, url: psy.slug ? `${base}psy/${encodeURIComponent(psy.slug)}` : null },
    { name: 'Запись' }
  ]));
}

/** Профессия специалиста в человеческой формулировке (для подписей/заголовков). */
export function professionLabel(key) {
  return (Professions[key] || Professions.psychologist).label.toLowerCase();
}
