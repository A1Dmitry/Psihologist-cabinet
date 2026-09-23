/**
 * Общий маппер строки таблицы psychologists (snake_case) → сущность Psychologist.
 * Публичный профиль приходит и из PostgREST, и из localStorage, поэтому здесь
 * принимаем оба соглашения об именах и аккуратно разбираем JSON-поля.
 */
import { Psychologist } from '../models/entities.js';

function value(row, snake, camel, fallback = '') {
  return row?.[snake] ?? row?.[camel] ?? fallback;
}

function jsonValue(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch (_) { return fallback; }
}

function listValue(raw) {
  const value = jsonValue(raw, []);
  return Array.isArray(value) ? value : [];
}

/** Официальная страница Наталии публикует эти ссылки в блоке «Контакты». */
function officialSocials(row, socials) {
  const source = String(value(row, 'source_url', 'sourceUrl', value(row, 'website', 'website', ''))).toLowerCase();
  const name = String(value(row, 'full_name', 'fullName', '')).toLowerCase().replaceAll('ё', 'е');
  // The legacy public_profiles view may omit source_url; the full name is
  // sufficient here because this fallback is only for the known official profile.
  const isNatalia = name.includes('наталия михайловская')
    && (!source || source.includes('nataliamikhailouskaya.by'));
  if (!isNatalia) return socials;
  const result = [...socials];
  if (!result.some(item => item?.kind === 'telegram' && item?.url)) {
    result.push({ kind: 'telegram', url: 'https://t.me/psyholog_natali', title: 'telegram' });
  }
  if (!result.some(item => item?.kind === 'instagram' && item?.url)) {
    result.push({ kind: 'instagram', url: 'https://www.instagram.com/psyholog__natali', title: 'instagram' });
  }
  return result;
}

export function mapPsy(row = {}) {
  const socials = officialSocials(row, listValue(value(row, 'socials', 'socials', [])));
  return new Psychologist({
    id: value(row, 'id', 'id', null),
    email: value(row, 'email', 'email', ''),
    fullName: value(row, 'full_name', 'fullName', ''),
    phone: value(row, 'phone', 'phone', ''),
    specialization: value(row, 'specialization', 'specialization', 'Психолог'),
    city: value(row, 'city', 'city', ''),
    about: value(row, 'about', 'about', ''),
    website: value(row, 'website', 'website', ''),
    sourceUrl: value(row, 'source_url', 'sourceUrl', value(row, 'website', 'website', '')),
    address: value(row, 'address', 'address', ''),
    experience: value(row, 'experience', 'experience', ''),
    slug: value(row, 'slug', 'slug', ''),
    profession: value(row, 'profession', 'profession', 'psychologist'),
    greeting: value(row, 'greeting', 'greeting', ''),
    approach: value(row, 'approach', 'approach', ''),
    photoUrl: value(row, 'photo_url', 'photoUrl', ''),
    publicEmail: value(row, 'public_email', 'publicEmail', ''),
    directions: listValue(value(row, 'directions', 'directions', [])),
    education: jsonValue(value(row, 'education', 'education', null), null),
    experienceItems: listValue(value(row, 'experience_items', 'experienceItems', [])),
    socials,
    paymentLinks: listValue(value(row, 'payment_links', 'paymentLinks', [])),
    paymentRequisites: jsonValue(value(row, 'payment_requisites', 'paymentRequisites', null), null),
    isActive: value(row, 'is_active', 'isActive', true) !== false,
    keyVerifier: value(row, 'key_verifier', 'keyVerifier', null),
    createdAt: value(row, 'created_at', 'createdAt', null)
  });
}
