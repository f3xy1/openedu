// Проверка, что в файлах расширения нет функций, объявленных и нигде не
// вызванных.
//
//     node tests/test_no_dead_code.js
//
// Зачем: так из content.js пропала кнопка «забрать решение со страницы».
// Механизм снятия ответа был написан целиком — harvestMark, isFilled,
// statusOf, копилка в хранилище, выгрузка из окна расширения, слияние с
// базой, — но вызов harvestMark из buildMarks потерялся при переписывании
// значков, и кнопки на странице не стало. Ни один тест этого не заметил:
// проверялись чистые функции, а не то, что кто-то их вообще дёргает.
//
// Ловится именно это: имя, которое встречается в файле ровно один раз — в
// собственном объявлении. Функция, которой пользуется только тест, не
// считается потерянной: тесты тоже просматриваются.
//
// Проверяются только файлы расширения: у питоновских скриптов есть
// argparse и свои тесты, а в браузере ни линтера, ни статики нет.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Файлы, живущие в ОДНОЙ области видимости, проверяются вместе: normalize.js,
// content.js и nav.js перечислены в одном content_scripts, поэтому вызов из
// одного файла — настоящий вызов для другого (именно так nav.js пользуется
// planFor и harvestBlock). Окно расширения — отдельная страница со своей
// областью видимости, поэтому popup.js считается сам по себе: вызов из
// content.js для него ничего не значит.
const BUNDLES = [
    ['normalize.js', 'content.js', 'nav.js'],
    ['popup.js']
];

// Куда ещё можно сослаться на функцию, кроме её собственного файла.
const TESTS = fs.readdirSync(path.join(ROOT, 'tests'))
    .filter(name => name.endsWith('.js'))
    .map(name => stripComments(fs.readFileSync(path.join(ROOT, 'tests', name), 'utf8')))
    .join('\n');

// Комментарии выбрасываются ДО подсчёта, и это не придирка: стоит упомянуть
// потерянную функцию в пояснении («вызов harvestMark пропал») — и счётчик
// засчитает упоминание за вызов, то есть проверка промолчит ровно там, где
// должна была сработать. Проверено на себе: первая версия этой проверки
// пропускала собственную поломку, ради которой написана.
//
// Строчный комментарий — это // не после двоеточия: так «https://» и
// «chrome-extension://» внутри строк остаются на месте.
function stripComments(text) {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
}

let failed = 0;
let passed = 0;

function check(name, condition, detail) {
    if (condition) {
        passed += 1;
    } else {
        failed += 1;
        console.log(`❌ ${name}${detail === undefined ? '' : '  — ' + detail}`);
    }
}

function occurrences(text, word) {
    const found = text.match(new RegExp(`\\b${word}\\b`, 'g'));
    return found ? found.length : 0;
}

BUNDLES.forEach(bundle => {
    const source = bundle
        .map(name => stripComments(
            fs.readFileSync(path.join(ROOT, 'openedu-helper', name), 'utf8')))
        .join('\n');
    const declared = [...source.matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)]
        .map(match => match[1]);
    const orphans = declared.filter(name =>
        occurrences(source, name) + occurrences(TESTS, name) < 2);

    check(`${bundle.join(' + ')}: все функции кем-то вызываются`,
          orphans.length === 0,
          orphans.length
              ? `объявлены и нигде не использованы: ${orphans.join(', ')} — `
                + 'либо это мёртвый код, либо потерялся вызов (кнопка, значок, '
                + 'обработчик так уже пропадали)'
              : undefined);
});

console.log(failed
    ? `\n❌ Провалено: ${failed}, пройдено: ${passed}`
    : `\n✅ Всё сходится. Проверок пройдено: ${passed}`);
process.exit(failed ? 1 : 0);
