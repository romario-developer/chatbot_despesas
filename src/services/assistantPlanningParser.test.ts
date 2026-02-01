import assert from 'node:assert';
import { parsePlanningMessage } from './assistantPlanningParser';

{
  const result = parsePlanningMessage('salario 3500');
  assert.ok(result);
  assert.strictEqual(result?.planningAction, 'set_salary');
  assert.strictEqual(result?.amount, 350000);
  assert.match(result?.month ?? '', /^\d{4}-\d{2}$/);
}

{
  const result = parsePlanningMessage('entrada extra 300 freelance');
  assert.ok(result);
  assert.strictEqual(result?.planningAction, 'add_extra_income');
  assert.strictEqual(result?.amount, 30000);
  assert.strictEqual(result?.description, 'freelance');
}

{
  const result = parsePlanningMessage('conta fixa 120 internet');
  assert.ok(result);
  assert.strictEqual(result?.planningAction, 'add_fixed_bill');
  assert.strictEqual(result?.amount, 12000);
  assert.strictEqual(result?.label, 'internet');
}

{
  const result = parsePlanningMessage('salario fevereiro 2026 5000');
  assert.ok(result);
  assert.strictEqual(result?.planningAction, 'set_salary');
  assert.strictEqual(result?.amount, 500000);
  assert.strictEqual(result?.month, '2026-02');
}
