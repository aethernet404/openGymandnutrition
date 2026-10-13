/* What counts as a relevant hit, how hits are ordered, and which serving sizes are believed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokens, stem, wordMatches, relevance, rankHits, servingGrams, chooseServingGrams, servingLabel, sensibleGrams } from '../nutrition/rank.js';

const hit = (source, kind, name, brand = '', extra = {}) => ({ source, kind, ext: name + brand, name, brand, bases: [{ label: '100 g', grams: 100, per: { calories: extra.kcal ?? 100, protein_g: 1, carbs_g: 1, fat_g: 1 } }], ...extra });

test('words: accents, punctuation, stop words and plurals', () => {
  assert.deepEqual(tokens('Crème Brûlée, with the Vanilla!'), ['creme', 'brulee', 'vanilla']);
  for (const [a, b] of [['cookies', 'cookie'], ['berries', 'berry'], ['eggs', 'egg'], ['boxes', 'box'], ['oats', 'oat'], ['pies', 'pie'], ['movies', 'movie']]) assert.equal(stem(a), stem(b), a + ' / ' + b);
  assert.notEqual(stem('glass'), stem('glas'));
  assert.equal(stem('glass'), 'glass');
  assert.ok(wordMatches('cookie', 'cookies'));
  assert.ok(wordMatches('oat', 'oatmeal'), 'a typed prefix finds the longer word');
  assert.ok(wordMatches('eggs', 'egg'));
  assert.ok(wordMatches('egg', 'eggplant'), 'a prefix match; ranking, not matching, is what puts plain egg first');
  assert.ok(!wordMatches('at', 'oat'), 'two letters is not a prefix');
  assert.ok(!wordMatches('rice', 'price'));
});

test('"whole egg" finds eggs and not foie gras or gluten-free bread', () => {
  assert.ok(relevance('whole egg', 'Egg, whole, raw, fresh').full);
  assert.ok(relevance('Whole egg', 'Eggs, Whole').full);
  assert.equal(relevance('whole egg', 'French Foie Gras with Egg Yolk').full, false, '"whole" is not in its name');
  assert.equal(relevance('whole egg', 'French foie gras', 'Delice').full, false);
  assert.equal(relevance('whole egg', 'Gluten free bread', 'Schar').full, false);
});

test('a brand can supply a typed word', () => {
  assert.ok(relevance('kind bar', 'Dark chocolate nuts & sea salt bar', 'Kind').full);
  assert.ok(relevance('chips ahoy', 'Chocolate chip cookies', 'Chips Ahoy!').full);
  assert.equal(relevance('chips ahoy', 'Chocolate chip cookies', 'Oreo').full, false);
});

test('the food that IS the query outranks a dish that merely contains it', () => {
  const plain = relevance('banana', 'Bananas, raw');
  const dish = relevance('banana', 'Banana bread with walnuts and chocolate chips');
  assert.ok(plain.full && dish.full);
  assert.ok(plain.score > dish.score + 40, `${plain.score} vs ${dish.score}`);
  const exact = relevance('oatmeal', 'Oatmeal');
  assert.ok(exact.score > relevance('oatmeal', 'Oatmeal raisin cookie').score);
  assert.ok(relevance('chocolate chip cookie', 'Cookies, chocolate chip, commercially prepared').full);
  assert.ok(relevance('chocolate chip cookie', 'Chocolate chip cookie').score > relevance('chocolate chip cookie', 'Chocolate chip cookie dough ice cream sandwich bar').score);
});

test('nothing typed, or nothing to match, is never relevant', () => {
  assert.equal(relevance('', 'Egg').full, false);
  assert.equal(relevance('the of', 'Egg').full, false);
  assert.equal(relevance('egg', '').full, false);
});

test('ranking: USDA reference foods first, then the rest by closeness; irrelevant and duplicate hits gone', () => {
  const hits = [
    hit('off', 'off', 'Whole egg', 'Bio Farm', { preferred: false }),
    hit('off', 'off', 'French foie gras', 'Delice'),
    hit('usda', 'branded', 'Egg, whole, hard-boiled', 'Eggland'),
    hit('off', 'off', 'Whole eggs', 'Great Value', { preferred: true }),
    hit('usda', 'sr', 'Egg, whole, cooked, fried'),
    hit('usda', 'foundation', 'Egg, whole, raw, fresh'),
    hit('off', 'off', 'Gluten free bread', 'Schar'),
    hit('usda', 'sr', 'Egg, whole, cooked, fried'),                              // duplicate
    hit('usda', 'sr', 'Egg noodles, enriched, dry'),                             // no "whole"
    hit('usda', 'sr', 'Egg, whole, raw, fresh', '', { kcal: 143 })               // same name, different numbers: kept
  ];
  const ranked = rankHits(hits, 'whole egg');
  const names = ranked.map(h => `${h.source}/${h.kind}: ${h.name}${h.brand ? ' (' + h.brand + ')' : ''}`);
  assert.ok(!names.some(n => /foie gras|Gluten|noodles/.test(n)), names.join('\n'));
  assert.equal(ranked.filter(h => h.name === 'Egg, whole, cooked, fried').length, 1, 'duplicates removed');
  const firstNonReference = ranked.findIndex(h => !(h.source === 'usda' && ['foundation', 'sr'].includes(h.kind)));
  assert.ok(ranked.slice(0, firstNonReference).every(h => h.source === 'usda' && ['foundation', 'sr'].includes(h.kind)), 'reference foods lead');
  assert.ok(firstNonReference >= 3);
  const idx = f => ranked.findIndex(f);
  assert.ok(idx(h => h.kind === 'foundation') < idx(h => h.kind === 'sr' && h.name.includes('fried')), 'Foundation edges SR Legacy of equal closeness');
  assert.ok(idx(h => h.brand === 'Great Value') < idx(h => h.brand === 'Bio Farm'), 'a US/English product edges an equal one');
  assert.ok(idx(h => h.name === 'Whole egg' && h.brand === 'Bio Farm') < idx(h => h.source === 'usda' && h.kind === 'branded'), 'closeness beats source: an exact name outranks a label that is merely about egg');
  const tie = rankHits([hit('off', 'off', 'Whole egg', 'Bio Farm'), hit('usda', 'branded', 'Whole egg', 'Eggland')], 'whole egg');
  assert.equal(tie[0].source, 'usda', 'at equal closeness a USDA branded label edges an unverified product');
  for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1].rank >= ranked[i].rank, 'sorted');
});

test('a reference food that is only a loose match does not beat a branded exact one', () => {
  const ranked = rankHits([
    hit('usda', 'sr', 'Cookies, chocolate chip, commercially prepared, regular, lower fat'),
    hit('usda', 'branded', 'Chocolate chip cookie', 'Famous Amos')
  ], 'chocolate chip cookie');
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].kind, 'sr', 'reference first, as asked: it matches every word');
});

test('serving text: the bracketed weight, ounces, millilitres, nonsense', () => {
  assert.equal(servingGrams('30 g'), 30);
  assert.equal(servingGrams('1 cookie (28 g)'), 28);
  assert.equal(servingGrams('2 tbsp (30g)'), 30);
  assert.equal(servingGrams('240 ml'), 240);
  assert.equal(servingGrams('1 oz'), 28.3);
  assert.equal(servingGrams('1.5 oz (42 g)'), 42);
  assert.equal(servingGrams('0,5 l'), 500);
  assert.equal(servingGrams('1 fl oz'), 29.6);
  assert.equal(servingGrams('a handful'), null);
  assert.equal(servingGrams(''), null);
  assert.equal(servingGrams(null), null);
});

test('serving weights: believable ones only, and the written text beats a contradicting number', () => {
  assert.ok(sensibleGrams(28) && sensibleGrams(1) && sensibleGrams(1000));
  assert.ok(!sensibleGrams(0) && !sensibleGrams(0.4) && !sensibleGrams(1001) && !sensibleGrams(NaN) && !sensibleGrams(null));
  assert.equal(chooseServingGrams(30, '30 g'), 30);
  assert.equal(chooseServingGrams(100, '1 cookie (28 g)'), 28, 'the number field is a copy of the pack size; the text is the serving');
  assert.equal(chooseServingGrams(29, '1 cookie (28 g)'), 29, 'a small disagreement is rounding, keep the number');
  assert.equal(chooseServingGrams(null, '40 g'), 40);
  assert.equal(chooseServingGrams(5000, ''), null);
  assert.equal(chooseServingGrams(0, ''), null);
  assert.equal(chooseServingGrams(null, null), null);
});

test('serving label: what the pack says if it says something, else the weight', () => {
  assert.equal(servingLabel('1 cookie (28 g)', 28), '1 cookie (28 g)');
  assert.equal(servingLabel('30', 30), '30 g');
  assert.equal(servingLabel('', 15), '15 g');
  assert.equal(servingLabel('serving', 15), '15 g');
  assert.equal(servingLabel('', null), '1 serving');
  assert.equal(servingLabel('x'.repeat(200) + ' 30 g', 30), '30 g');
});
