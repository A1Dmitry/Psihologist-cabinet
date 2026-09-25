/**
 * Первичная самооценка при онлайн-записи.
 *
 * Это буквальное сопоставление с масками из спецификации, НЕ поиск ближайшего
 * вектора по расстоянию Хэмминга и НЕ клиническая диагностика. Несовпавшие
 * состояния остаются на ручной оценке: незаданное правило нельзя подменять
 * категорией нормы.
 */
export const TRIAGE_PRIORITY_ORDER = Object.freeze([
  'R1_Medical',
  'R3_Crisis',
  'R5_Norm',
  'R2_DeepTherapy',
  'R4_Counseling'
]);

export const TRIAGE_QUESTIONS = Object.freeze([
  {
    id: 'B1',
    name: 'Телесные сигналы',
    question: 'Бывает ли, что ваше тело дает резкие физические сигналы сбоя или паники: внезапно колотится сердце, перехватывает дыхание, ком в горле, дрожь, приступы дурноты или проблемы с ЖКТ без понятных медицинских причин?',
    options: Object.freeze([
      Object.freeze({ value: '0', label: 'Нет, физически тело спокойно' }),
      Object.freeze({ value: '1', label: 'Да, тело регулярно так реагирует' })
    ])
  },
  {
    id: 'B2',
    name: 'Силы и интерес к жизни',
    question: 'Чувствуете ли вы глубокое падение сил последние 2 недели и дольше: когда сон не восстанавливает, любимые вещи и еда больше не радуют, и тяжело заставить себя сделать даже элементарные бытовые действия?',
    options: Object.freeze([
      Object.freeze({ value: '0', label: 'Нет, силы и интерес к жизни есть' }),
      Object.freeze({ value: '1', label: 'Да, полная апатия и истощение' })
    ])
  },
  {
    id: 'B3',
    name: 'Связь с отношениями',
    question: 'Связана ли ваша ситуация в первую очередь с конкретным человеком или отношениями (партнер, родитель, начальник, ребенок, тяжелый разрыв, измена, невозможность сказать «нет»)?',
    options: Object.freeze([
      Object.freeze({ value: '0', label: 'Нет, дело скорее во мне самом, целях или жизни в целом' }),
      Object.freeze({ value: '1', label: 'Да, центр проблемы — в отношениях' })
    ])
  },
  {
    id: 'B4',
    name: 'Повторяющаяся ситуация',
    question: 'Замечаете ли вы, что эта сложность повторяется в вашей жизни годами по одному кругу (с разными людьми, на разных работах или в повторяющихся ситуациях)?',
    options: Object.freeze([
      Object.freeze({ value: '0', label: 'Нет, это новая для меня ситуация' }),
      Object.freeze({ value: '1', label: 'Да, это давний повторяющийся сценарий' })
    ])
  },
  {
    id: 'B5',
    name: 'Повторяющиеся мысли',
    question: 'Бывает ли, что голова застревает в непрерывном прокручивании одних и тех же мыслей: бесконечный разбор прошлых разговоров, страх ошибки, паралич выбора, когда вы никак не можете «выключить радио» внутри?',
    options: Object.freeze([
      Object.freeze({ value: '0', label: 'Нет, мысли ясные или переключаюсь легко' }),
      Object.freeze({ value: '1', label: 'Да, постоянно кручу мысли по кругу' })
    ])
  },
  {
    id: 'B6',
    name: 'Влияние на повседневную жизнь',
    question: 'Привело ли это состояние к реальным сбоям в делах: тяжело выходить на работу, срываются важные обязательства, запустился быт или хочется полностью изолироваться от людей?',
    options: Object.freeze([
      Object.freeze({ value: '0', label: 'Нет, социально я держусь и справляюсь' }),
      Object.freeze({ value: '1', label: 'Да, дела и привычная жизнь уже сыплются' })
    ])
  },
  {
    id: 'B7',
    name: 'Реакция на сильное напряжение',
    question: 'Когда эмоциональное напряжение доходит до предела, как вы чаще реагируете?',
    options: Object.freeze([
      Object.freeze({ value: '0', label: 'Выплескиваю наружу: злюсь, кричу, вступаю в конфликты, срываюсь на импульсивные действия' }),
      Object.freeze({ value: '1', label: 'Направляю внутрь: замыкаюсь, молчу, виню себя, терплю и плачу в одиночестве' })
    ])
  },
  {
    id: 'B8',
    name: 'Недавнее резкое событие',
    question: 'Случилось ли совсем недавно конкретное резкое событие-потрясение (развод, смерть близкого человека, внезапное увольнение, авария, переезд или физическая угроза)?',
    options: Object.freeze([
      Object.freeze({ value: '0', label: 'Нет, явной катастрофы не было, всё накапливалось' }),
      Object.freeze({ value: '1', label: 'Да, произошел резкий внешний удар' })
    ])
  }
]);

export const TRIAGE_CHILD_QUESTION = Object.freeze({
  id: 'child_triangulation',
  question: 'Если ситуация касается развода или конфликта в семье: втянуты ли в конфликт общие дети (приходится ли ребенку выбирать чью-то сторону, защищать кого-то из родителей)?',
  options: Object.freeze([
    Object.freeze({ value: 'yes', label: 'Да, дети оказываются втянуты в конфликт' }),
    Object.freeze({ value: 'no', label: 'Нет' }),
    Object.freeze({ value: 'not_applicable', label: 'Не относится к моей ситуации / не уверен(а)' })
  ])
});

// Порядок правил внутри одной группы намеренно совпадает с их порядком
// в исходной спецификации. Между группами применяется TRIAGE_PRIORITY_ORDER.
export const TRIAGE_RULES = Object.freeze([
  Object.freeze({
    ruleId: 'RULE_1', mask: '11------', priorityGroup: 'R1_Medical', target: 'R1_Medical',
    syndrome: 'Сомато-витальный коллапс',
    directive: 'Срочный скрининг врача-психиатра / психотерапевта (подозрение на тяжелый депрессивный эпизод). Психотерапия строго вторична.'
  }),
  Object.freeze({
    ruleId: 'RULE_2', mask: '1----1--', priorityGroup: 'R1_Medical', target: 'R1_Medical',
    syndrome: 'Паническое/соматоформное расстройство со срывом адаптации',
    directive: 'Консультация невролога/психиатра + КПТ тревожных расстройств.'
  }),
  Object.freeze({
    ruleId: 'RULE_3', mask: '-1---1--', priorityGroup: 'R1_Medical', target: 'R1_Medical',
    syndrome: 'Витальная астено-депрессивная декомпенсация',
    directive: 'Медицинская оценка соматического и психического статуса.'
  }),
  Object.freeze({
    ruleId: 'RULE_4', mask: '-0-0-0-1', priorityGroup: 'R3_Crisis', target: 'R3_Crisis',
    syndrome: 'Острая травма / Шок / Переживание утраты',
    directive: 'Кризисный психолог. Протокол работы с острым горем и шоком. Долговременную терапию характера не начинать.'
  }),
  Object.freeze({
    ruleId: 'RULE_5', mask: '0011-01-', priorityGroup: 'R2_DeepTherapy', target: 'R2_DeepTherapy_Codependency',
    syndrome: 'Хронический сценарий созависимости / Нарушение границ (Вектор: Внутрь)',
    directive: 'Длительная психотерапия: работа с виной, сепарацией, отстаиванием границ. Подходит поддерживающий эмпатичный терапевт.'
  }),
  Object.freeze({
    ruleId: 'RULE_6', mask: '0011-00-', priorityGroup: 'R2_DeepTherapy', target: 'R2_DeepTherapy_Conflict',
    syndrome: 'Хронический деструктивный конфликтный сценарий (Вектор: Наружу)',
    directive: 'Психотерапия: управление гневом, импульс-контроль, поведенческие контракты. Требуется структурированный терапевт с жесткими рамками.'
  }),
  Object.freeze({
    ruleId: 'RULE_7', mask: '0001-01-', priorityGroup: 'R2_DeepTherapy', target: 'R2_DeepTherapy_SelfWorth',
    syndrome: 'Глубинный невроз самооценки / Перфекционизм / Синдром самозванца',
    directive: 'Индивидуальная глубинная терапия (психодинамическая, схема-терапия): работа с глубинным стыдом.'
  }),
  Object.freeze({
    ruleId: 'RULE_8', mask: '000010-0', priorityGroup: 'R4_Counseling', target: 'R4_Counseling_Choice',
    syndrome: 'Ситуативный когнитивный тупик / Паралич выбора',
    directive: 'Краткосрочное психологическое консультирование / коучинг (3-5 сессий): техники принятия решений, разбор тупика.'
  }),
  Object.freeze({
    ruleId: 'RULE_9', mask: '0010-0-0', priorityGroup: 'R4_Counseling', target: 'R4_Counseling_Conflict',
    syndrome: 'Локальный свежий конфликт в паре/семье без предыстории',
    directive: 'Парная медиация или ситуативная консультация по коммуникации.'
  }),
  Object.freeze({
    ruleId: 'RULE_10', mask: '000000-0', priorityGroup: 'R5_Norm', target: 'R5_Norm_Rest',
    syndrome: 'Функциональная норма / Ситуативная усталость',
    directive: 'Психолог в данный момент не требуется. Рекомендовать нормализацию режима труда/отдыха, сон, отпуск.'
  })
]);

function normalizeVector(vector) {
  const raw = Array.isArray(vector) ? vector.join('') : String(vector ?? '');
  const compact = raw.replace(/[\s-]/g, '');
  if (!/^[01]{8}$/.test(compact)) {
    throw new TypeError('Ожидается вектор из 8 значений 0/1 (B1…B8)');
  }
  return compact;
}

function maskMatches(mask, vector) {
  return mask.split('').every((bit, index) => bit === '-' || bit === vector[index]);
}

/** Строгое совпадение с масками; возвращает null при отсутствии правила. */
export function routeTriageVector(vector) {
  const normalized = normalizeVector(vector);
  const matches = TRIAGE_RULES.filter(rule => maskMatches(rule.mask, normalized));
  const priorityIndex = group => {
    const index = TRIAGE_PRIORITY_ORDER.indexOf(group);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  const winner = matches.slice().sort((a, b) =>
    priorityIndex(a.priorityGroup) - priorityIndex(b.priorityGroup) ||
    TRIAGE_RULES.indexOf(a) - TRIAGE_RULES.indexOf(b)
  )[0] || null;

  return {
    vector: normalized,
    matchedRules: matches.map(rule => rule.ruleId),
    matchedRule: winner,
    routingStatus: winner ? 'matched' : 'manual_review'
  };
}

function normalizeChildStatus(value, relationshipBit) {
  if (relationshipBit !== '1') return 'not_applicable';
  if (value === true || value === 'yes') return 'yes';
  if (value === false || value === 'no') return 'no';
  if (value === 'not_applicable') return 'not_applicable';
  return 'not_reported';
}

/**
 * Build the clinician-facing card from exact questionnaire answers.
 * All analysis stays attached to the booking note; the client UI only gets a
 * neutral thank-you. This output is a screening hint, not a diagnosis.
 */
export function buildTriageAssessment(answers, childStatus = 'not_reported') {
  const answerBits = TRIAGE_QUESTIONS.map(question => {
    const value = answers?.[question.id];
    if (value !== 0 && value !== 1 && value !== '0' && value !== '1') {
      throw new TypeError(`Нужен ответ 0 или 1 на ${question.id}`);
    }
    return String(value);
  });
  const vector = answerBits.join('');
  const answersSummary = TRIAGE_QUESTIONS.map((question, index) => ({
    id: question.id,
    name: question.name,
    value: answerBits[index],
    response: question.options.find(option => option.value === answerBits[index])?.label || ''
  }));
  const route = routeTriageVector(vector);
  const rule = route.matchedRule;
  const childTriangulationStatus = normalizeChildStatus(childStatus, answerBits[2]);
  const triangulationRisk = childTriangulationStatus === 'yes';
  const redFlags = {
    medical_risk: rule?.priorityGroup === 'R1_Medical',
    crisis_shock: rule?.priorityGroup === 'R3_Crisis',
    triangulation_risk: triangulationRisk
  };

  let actionItem = rule
    ? `${rule.directive} Уточнить вывод в беседе; не использовать как диагноз или единственное основание для выбора помощи.`
    : 'Ни одно правило из списка не совпало с этим сочетанием ответов. Просмотреть запрос вручную; не считать отсутствие совпадения признаком нормы.';
  if (rule?.target === 'R5_Norm_Rest') {
    actionItem += ' Не использовать отметку как отказ в консультации: опрос не спрашивает о риске причинить себе вред или о непосредственной опасности.';
  }
  if (triangulationRisk) {
    actionItem += ' Дети отмечены как вовлечённые в конфликт: уточнить ситуацию напрямую и оценить контекст; не использовать одну эту отметку как автоматический запрет индивидуальной помощи или автоматическое назначение семейной терапии.';
  }

  const card = {
    raw_vector: answerBits.join('-'),
    answers: answersSummary,
    matched_rule: rule ? `${rule.ruleId} (${rule.mask.split('').join(' ')})` : 'NO_MATCH (manual review)',
    category: rule?.target || 'UNMATCHED_MANUAL_REVIEW',
    red_flags: redFlags,
    clinical_summary: rule
      ? `Автоматически совпал шаблон «${rule.syndrome}». Это предварительная подсказка по самоотчёту, не диагноз; требуется уточнение специалистом.`
      : 'Правила не покрывают это сочетание ответов; автоматическая гипотеза не сформирована, требуется ручной просмотр.',
    natalia_action_item: actionItem,
    routing_status: route.routingStatus,
    manual_review_required: route.routingStatus === 'manual_review' || triangulationRisk,
    child_triangulation_status: childTriangulationStatus,
    matched_rule_ids: route.matchedRules
  };
  return card;
}

/**
 * Human-readable storage value for sessions.note. The note is kept out of the
 * client record and notification payload; the booking session remains the one
 * canonical copy of the questionnaire result.
 */
export function formatTriageRecord(assessment) {
  if (!assessment || typeof assessment !== 'object') return '';
  const fields = {
    raw_vector: assessment.raw_vector,
    answers: assessment.answers,
    matched_rule: assessment.matched_rule,
    category: assessment.category,
    red_flags: assessment.red_flags,
    clinical_summary: assessment.clinical_summary,
    natalia_action_item: assessment.natalia_action_item,
    routing_status: assessment.routing_status,
    manual_review_required: assessment.manual_review_required,
    child_triangulation_status: assessment.child_triangulation_status,
    matched_rule_ids: assessment.matched_rule_ids
  };
  return `Результат самоопроса — служебная подсказка по самоотчёту, не диагноз:\n${JSON.stringify(fields, null, 2)}`;
}

/** Compose the existing session note without duplicating the clinical summary in clients.note. */
export function formatBookingSessionNote(clientText, assessment) {
  const userNote = String(clientText ?? '').trim();
  const triageRecord = formatTriageRecord(assessment);
  return [
    userNote ? `Запрос клиента: ${userNote}` : '',
    triageRecord
  ].filter(Boolean).join('\n\n');
}
