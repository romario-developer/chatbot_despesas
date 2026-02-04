import assert from 'node:assert';
import { parsePtBrMoneyToCents, toCentsBRL } from './money';

assert.strictEqual(parsePtBrMoneyToCents('120'), 12000, '"120" deve virar 12000 centavos');
assert.strictEqual(parsePtBrMoneyToCents('120,00'), 12000);
assert.strictEqual(parsePtBrMoneyToCents('0,11'), 11);
assert.strictEqual(parsePtBrMoneyToCents('1.234,56'), 123456);
assert.strictEqual(parsePtBrMoneyToCents(120), 12000);
assert.strictEqual(toCentsBRL('R$ 15,50'), 1550);
assert.strictEqual(toCentsBRL(49.99), 4999);
