/** Общий маппер строки таблицы psychologists (snake_case) → сущность Psychologist. */
import { Psychologist } from '../models/entities.js';

export function mapPsy(row) {
  return new Psychologist({
    id: row.id,
    email: row.email || '',
    fullName: row.full_name,
    phone: row.phone || '',
    specialization: row.specialization || 'Психолог',
    city: row.city || '',
    about: row.about || '',
    website: row.website || '',
    sourceUrl: row.source_url || row.website || '',
    address: row.address || '',
    experience: row.experience || '',
    slug: row.slug || '',
    profession: row.profession || 'psychologist',
    greeting: row.greeting || '',
    approach: row.approach || '',
    photoUrl: row.photo_url || '',
    publicEmail: row.public_email || '',
    directions: row.directions || [],
    education: row.education || null,
    experienceItems: row.experience_items || [],
    socials: row.socials || [],
    paymentLinks: row.payment_links || [],
    paymentRequisites: row.payment_requisites || null,
    isActive: row.is_active !== false,
    keyVerifier: row.key_verifier || null,
    createdAt: row.created_at
  });
}
