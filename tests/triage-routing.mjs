#!/usr/bin/env node
/** Exhaustive regression for the published 8-bit mask router (all 256 vectors). */
import assert from 'node:assert/strict';
import {
  TRIAGE_QUESTIONS,
  buildTriageAssessment,
  formatBookingSessionNote,
  routeTriageVector
} from '../js/domain/triage.js';

// Independent reference table copied from the product specification. Keep the
// expected routing here explicit so a change to production masks cannot silently
// redefine the test oracle.
const REFERENCE_RULES = [
  ['RULE_1', '11------', 'R1_Medical'],
  ['RULE_2', '1----1--', 'R1_Medical'],
  ['RULE_3', '-1---1--', 'R1_Medical'],
  ['RULE_4', '-0-0-0-1', 'R3_Crisis'],
  ['RULE_5', '0011-01-', 'R2_DeepTherapy'],
  ['RULE_6', '0011-00-', 'R2_DeepTherapy'],
  ['RULE_7', '0001-01-', 'R2_DeepTherapy'],
  ['RULE_8', '000010-0', 'R4_Counseling'],
  ['RULE_9', '0010-0-0', 'R4_Counseling'],
  ['RULE_10', '000000-0', 'R5_Norm']
];
const PRIORITY = ['R1_Medical', 'R3_Crisis', 'R5_Norm', 'R2_DeepTherapy', 'R4_Counseling'];
const matches = (mask, vector) => [...mask].every((bit, i) => bit === '-' || bit === vector[i]);
const expected = vector => {
  const found = REFERENCE_RULES.filter(([, mask]) => matches(mask, vector));
  for (const group of PRIORITY) {
    const winner = found.find(([, , target]) => target === group);
    if (winner) return winner[0];
  }
  return null;
};

let covered = 0;
let unmatched = 0;
for (let n = 0; n < 256; n++) {
  const vector = n.toString(2).padStart(8, '0');
  const routed = routeTriageVector(vector);
  const expectedRule = expected(vector);
  assert.equal(routed.matchedRule?.ruleId || null, expectedRule, `vector ${vector}`);
  assert.equal(routed.routingStatus, expectedRule ? 'matched' : 'manual_review', `status ${vector}`);
  if (expectedRule) covered++;
  else unmatched++;
}
assert.equal(covered, 164, 'published masks should match 164 of 256 possible vectors');
assert.equal(unmatched, 92, '92 vectors intentionally remain on manual review');
console.log(`PASS exhaustive route: ${covered} matched, ${unmatched} manual review`);

const examples = [
  ['11000100', 'RULE_1'], // RULE_1 wins the R1 overlap with RULE_2/RULE_3
  ['10000100', 'RULE_2'],
  ['01000100', 'RULE_3'],
  ['00000001', 'RULE_4'],
  ['00110010', 'RULE_5'],
  ['00110000', 'RULE_6'],
  ['00010010', 'RULE_7'],
  ['00001000', 'RULE_8'],
  ['00100000', 'RULE_9'],
  ['00000000', 'RULE_10']
];
for (const [vector, ruleId] of examples) {
  assert.equal(routeTriageVector(vector).matchedRule?.ruleId, ruleId, `${ruleId} example`);
}
console.log('PASS each declared mask has a representative vector');

const answersFrom = vector => Object.fromEntries(
  TRIAGE_QUESTIONS.map((question, index) => [question.id, vector[index]])
);
const codependency = buildTriageAssessment(answersFrom('00110010'), 'yes');
assert.equal(codependency.raw_vector, '0-0-1-1-0-0-1-0');
assert.equal(codependency.answers[2].response, 'Да, центр проблемы — в отношениях');
assert.equal(codependency.matched_rule, 'RULE_5 (0 0 1 1 - 0 1 -)');
assert.equal(codependency.category, 'R2_DeepTherapy_Codependency');
assert.deepEqual(codependency.red_flags, {
  medical_risk: false,
  crisis_shock: false,
  triangulation_risk: true
});
assert.match(codependency.natalia_action_item, /не использовать одну эту отметку как автоматический запрет/);
assert.equal(codependency.child_triangulation_status, 'yes');
assert.equal(codependency.manual_review_required, true);
console.log('PASS output card, red flags, and non-automatic child-context flag');

const normPattern = buildTriageAssessment(answersFrom('00000000'));
assert.equal(normPattern.matched_rule.startsWith('RULE_10'), true);
assert.match(normPattern.natalia_action_item, /не использовать отметку как отказ в консультации/i);
assert.equal(normPattern.manual_review_required, false);

const noMatch = buildTriageAssessment(answersFrom('00000100'));
assert.equal(noMatch.matched_rule, 'NO_MATCH (manual review)');
assert.equal(noMatch.category, 'UNMATCHED_MANUAL_REVIEW');
assert.equal(noMatch.routing_status, 'manual_review');
assert.match(noMatch.natalia_action_item, /не считать отсутствие совпадения признаком нормы/);
assert.equal(noMatch.red_flags.medical_risk, false);
assert.match(formatBookingSessionNote('', noMatch), /UNMATCHED_MANUAL_REVIEW/);
assert.match(formatBookingSessionNote('', codependency), /Да, центр проблемы — в отношениях/);
console.log('PASS unmatched vector is explicit manual review, never defaulted to normal');

assert.throws(() => routeTriageVector('0000000'), /8 значений/);
assert.throws(() => routeTriageVector('00000002'), /8 значений/);
assert.throws(() => buildTriageAssessment({ B1: '0' }), /Нужен ответ/);
assert.equal(formatBookingSessionNote('Хочу разобраться', null), 'Запрос клиента: Хочу разобраться');
assert.match(formatBookingSessionNote('Хочу разобраться', codependency), /Запрос клиента: Хочу разобраться/);
console.log('PASS invalid input is rejected and session note preserves optional free text');
process.exitCode = 0;
