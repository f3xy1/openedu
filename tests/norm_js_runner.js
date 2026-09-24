// Запуск normalize.js из-под node для теста паритета.
// Читает JSON-массив строк из файла (argv[2]), печатает JSON-массив
// {norm, key, solid} в stdout. Нужен только тестам — расширение его не грузит.
'use strict';
const fs = require('fs');
const path = require('path');

const normalize = require(path.join(__dirname, '..', 'opendu-helper', 'normalize.js'));

const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = input.map(text => ({
    norm: normalize.normalizeText(text),
    key: normalize.keyText(text),
    solid: normalize.solidText(text)
}));
process.stdout.write(JSON.stringify(out));
