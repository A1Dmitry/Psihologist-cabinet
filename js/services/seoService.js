/**
 * SEO-слой (известные наработки для малого бизнеса с онлайн-записью):
 *  - человеко-читаемый URL страницы специалиста: {base}/psy/{slug} (индексируемый);
 *  - canonical + Open Graph + Twitter Card;
 *  - структурированные данные schema.org: ProfessionalService (+ Person для специалиста)
 *    с каталогом услуг (OfferCatalog → makesOffer) — как у Calendly/Booksy-страниц;
 *  - дискриминатор профессии → schema.org-тип (расширение не только на психологов).
 */
import { Professions } from '../models/entities.js';

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

export function setMeta({ title, description, url, image, ogType = 'website' }) {
  if (title) document.title = title;
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
  set('meta[property="og:url"]', 'property', 'og:url', url, () => document.createElement('meta'));
  set('meta[property="og:type"]', 'property', 'og:type', ogType, () => document.createElement('meta'));
  set('meta[property="og:image"]', 'property', 'og:image', image, () => document.createElement('meta'));
  set('meta[name="twitter:card"]', 'name', 'twitter:card', image ? 'summary_large_image' : 'summary', () => document.createElement('meta'));
  if (url) setCanonical(url);
}

export function setJsonLd(data) {
  let el = document.head.querySelector('script#ld-json');
  if (!el) {
    el = document.createElement('script');
    el.type = 'application/ld+json';
    el.id = 'ld-json';
    document.head.appendChild(el);
  }
  el.textContent = JSON.stringify(data || {});
}

/**
 * JSON-LD страницы специалиста: @graph [Person + ProfessionalService/MedicalBusiness/…].
 * services — его услуги (Offer).
 */
export function buildProfileJsonLd(psy, services, pageUrl) {
  const profession = Professions[psy.profession] || Professions.psychologist;
  const personId = `${pageUrl}#person`;
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
    makesOffer: offerCatalog.length ? offerCatalog : undefined
  };

  return { '@context': 'https://schema.org', '@graph': [person, organization] };
}

/** SEO для страницы публичной записи специалиста */
export function applyProfileSeo(psy, services, pageUrl) {
  const title = `${psy.fullName} — ${psy.specialization || 'психолог'} · запись онлайн`;
  const description = [psy.greeting, psy.about].filter(Boolean).join(' ').slice(0, 300)
    || `Запись на консультацию: ${psy.fullName}. ${psy.city || ''}`.trim();
  setMeta({
    title,
    description,
    url: pageUrl,
    image: psy.photoUrl || '',
    ogType: 'profile'
  });
  setJsonLd(buildProfileJsonLd(psy, services, pageUrl));
}

/** SEO главной (каталог) */
export function applyPortalSeo(baseUrl) {
  setMeta({
    title: 'ПсихоПортал — кабинеты психологов · запись на консультацию',
    description: 'Каталог психологов: публичный профиль, услуги и цены, онлайн-запись на консультацию. Минск, Гродно и вся Беларусь.',
    url: baseUrl,
    ogType: 'website'
  });
  setJsonLd({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'ПсихоПортал',
    url: baseUrl,
    potentialAction: {
      '@type': 'SearchAction',
      target: `${baseUrl}?q={search_term_string}`,
      'query-input': 'required name=search_term_string'
    }
  });
}

/** SEO страницы записи /book/{slug} (лёгкое: JSON-LD остаётся на странице профиля) */
export function applyBookingSeo(psy, pageUrl) {
  setMeta({
    title: `Запись — ${psy.fullName} · ПсихоПортал`,
    description: `Онлайн-запись на консультацию к специалисту ${psy.fullName}${psy.city ? ` (${psy.city})` : ''}: выбор услуги, свободного времени и удобного способа оплаты.`,
    url: pageUrl,
    image: psy.photoUrl || '',
    ogType: 'website'
  });
}
