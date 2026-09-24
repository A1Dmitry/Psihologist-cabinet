/**
 * Duration — каноническая доменная модель длительности сессии.
 *
 * До этого дефолт «60 минут» независимо задавался в supabaseSync, cabinetApi,
 * BookingViewModel, clientCabinetService и в schema.sql — то есть одно
 * бизнес-правило жило в пяти местах и могло разъехаться.
 *
 * Здесь — единственная клиентская реализация. Серверный аналог:
 * `v_default_dur constant int := 60` внутри `public.create_booking`
 * (supabase/schema.sql). Значения меняются только парой — это отмечено
 * в обоих файлах.
 *
 * Приоритет источников длительности (совпадает с серверным):
 *   снимок длительности в записи → длительность услуги → шаг сетки → дефолт.
 */

export const DEFAULT_DURATION_MIN = 60;

/**
 * Верхняя граница осмысленной длительности сессии (8 часов).
 * Зеркало серверного клампа `if v_new_dur <= 0 or v_new_dur > 480`
 * в public.create_booking — поведение до D1 (main, T-02/T-04), D1 его
 * сохранила. Менять только парой со schema.sql.
 */
export const MAX_DURATION_MIN = 480;

/** Число минут из произвольного входа: ''/null/0/NaN → null («не задано»). */
export function toDurationMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

/**
 * Единственный резолвер длительности записи.
 * @param {{durationMin?: *, service?: {duration?: *}|null, slotStepMin?: *}} src
 * @returns {number} минуты, всегда > 0
 */
export function resolveDurationMinutes({ durationMin = null, service = null, slotStepMin = null } = {}) {
  return toDurationMinutes(durationMin)
    ?? toDurationMinutes(service?.duration ?? service?.durationMin)
    ?? toDurationMinutes(slotStepMin)
    ?? DEFAULT_DURATION_MIN;
}

/**
 * Длительность КАНДИДАТА (новая запись / перенос / сетка под услугу).
 * Тот же приоритет источников, что resolveDurationMinutes, плюс серверный
 * кламп (0,480] → дефолт. Точное зеркало серверного v_new_dur в
 * public.create_booking (coalesce + clamp, поведение до D1); менять парой.
 *
 * Для чужих (уже созданных) записей сервер кламп НЕ применяет — там
 * resolveDurationMinutes без клампа (снимки duration_min уже прокламплены
 * сервером в момент их создания).
 */
export function resolveCandidateDurationMinutes({ durationMin = null, service = null, slotStepMin = null } = {}) {
  const r = resolveDurationMinutes({ durationMin, service, slotStepMin });
  if (r <= 0 || r > MAX_DURATION_MIN) return DEFAULT_DURATION_MIN;
  return r;
}

/** «90» → «1,5 ч», «60» → «1 ч», «45» → «45 мин» */
export function formatDuration(min) {
  const m = toDurationMinutes(min) ?? DEFAULT_DURATION_MIN;
  if (m < 60) return `${m} мин`;
  if (m % 60 === 0) return `${m / 60} ч`;
  return `${Math.floor(m / 60)},${Math.round((m % 60) / 6)} ч`;
}

export const duration = {
  DEFAULT_DURATION_MIN,
  MAX_DURATION_MIN,
  toDurationMinutes,
  resolveDurationMinutes,
  resolveCandidateDurationMinutes,
  formatDuration
};
