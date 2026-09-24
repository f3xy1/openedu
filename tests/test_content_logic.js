// Проверка логики content.js БЕЗ браузера: файл целиком прогоняется в песочнице
// node с заглушками DOM, после чего дёргаются чистые функции — ключи, точный
// поиск, примерный поиск. Так проверяется то, что глазами на странице видно
// только косвенно (крестик или галочка), и проверяется быстро, без курса.
//
//     node tests/test_content_logic.js
//
// Заглушки намеренно тупые: всё, что требует настоящей страницы (селекторы,
// клики, хранилище), в тесте не участвует — для этого есть cdp.py и живая
// вкладка.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', 'opendu-helper');

const sandbox = {
    console,
    location: { href: 'https://openedu.ru/course/x/' },
    setTimeout,
    clearTimeout,
    fetch: async () => ({ ok: false }),
    MutationObserver: class { observe() {} },
    document: {
        body: {},
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => ({ style: {}, addEventListener() {} })
    },
    chrome: {
        runtime: { getURL: name => name },
        storage: { local: { get: async () => ({}), set: async () => {} } }
    }
};
sandbox.window = sandbox;
vm.createContext(sandbox);

const source = fs.readFileSync(path.join(ROOT, 'normalize.js'), 'utf8')
    + '\n' + fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
vm.runInContext(source, sandbox, { filename: 'content.js' });

const api = vm.runInContext(`({
    keyText, solidText, textForms, normalizeText, cleanText,
    recordType, makeEntry, baseIndex, questionScore, bestByQuestion,
    bestApproximate, findRecord, substringDistance, similarityOf,
    harvestKey, answerKey, answersEqual, closestChoice, answerFitsBlock,
    questionParts
})`, sandbox);

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

function equal(name, actual, expected) {
    check(name, actual === expected, `получено ${JSON.stringify(actual)}, ждали ${JSON.stringify(expected)}`);
}

// ── пустая часть составного вопроса ────────────────────────────────────────
// Регрессия: у записи, которая ЗАКАНЧИВАЕТСЯ на '...', split давал пустую
// строку, а пустая строка находится в любом тексте — запись совпадала с любым
// заданием на странице.
{
    const record = { question: 'Рекламный цикл Гартнера начинается с...', answer: 'x' };
    const entry = api.makeEntry(record);
    const foreign = api.textForms('Совершенно другое задание: сколько будет дважды два?');
    equal('хвостовой "..." не даёт пустой части',
        api.questionParts(record.question).length, 1);
    equal('запись с хвостовым "..." не совпадает с чужим блоком',
        api.questionScore(foreign, entry), 0);

    // А со своим текстом — совпадает, и это по-прежнему работает.
    const own = api.textForms('Рекламный цикл Гартнера начинается с чего-то там.');
    check('запись с хвостовым "..." находится на своём тексте',
        api.questionScore(own, entry) > 0);
}

// ── кавычки ────────────────────────────────────────────────────────────────
{
    const base = [{ question: 'Термин «дуалог» – это', answer: 'A' }];
    const page = api.textForms('Вопрос. Термин "дуалог" - это\nВарианты: ...');
    const index = api.baseIndex(base);
    check('вопрос с «ёлочками» находится на странице с обычными кавычками',
        !!api.bestByQuestion(page, base, index).data);
}

// ── формулы ────────────────────────────────────────────────────────────────
{
    const base = [{ question: '\\( \\rm Fe_3O_4 \\) — это', answer: 'магнетит' }];
    const page = api.textForms('Задание 4. Fe3O4 — это');
    const index = api.baseIndex(base);
    check('формула в LaTeX находится по глифам страницы',
        !!api.bestByQuestion(page, base, index).data);
}

// ── расстояние ─────────────────────────────────────────────────────────────
{
    equal('подстрока на месте', api.substringDistance('abc', 'xx abc xx', 0), 0);
    equal('одна замена', api.substringDistance('abc', 'xx axc xx', 1), 1);
    equal('начала и конца текста не считаются',
        api.substringDistance('привет', 'ааа привет ббб', 1), 0);
    equal('вопрос длиннее текста', api.substringDistance('привет', 'пр', 10), 4);
}

// Границей слова начало совпадения ограничено не для красоты: без этого
// «сомкнутый строй это» ложится на середину «разомкнутый строй это» почти без
// ошибок (внутри слова достаточно убрать одну «с»), и близнец вопроса выглядит
// точным совпадением. По границам слов та же пара честно расходится на три
// знака — «ра» в начале плюс «з»→«с».
{
    equal('внутри чужого слова вопрос не начинается',
        api.substringDistance('сомкнутый', 'разомкнутый', 12), 3);
    equal('на границе слова — начинается',
        api.substringDistance('сомкнутый', 'разомкнутый сомкнутый', 12), 0);
}

// ── примерный поиск ────────────────────────────────────────────────────────
{
    const base = [{ question: 'Численность населения России в 2019 году', answer: '146 млн' }];
    const index = api.baseIndex(base);
    const page = api.textForms('Численость населения России в 2019 году (опечатка в базе)');
    const found = api.bestApproximate(page, base, null, index);
    check('опечатка в вопросе ловится примерным поиском', !!found.data,
        JSON.stringify(found.near.map(n => n.question)));
}

// Опасная пара: разные вопросы, отличающиеся началом слова. Когда в базе есть
// ОБА, примерный поиск обязан выбрать ближайшего и не спутать соседа.
{
    const base = [
        { question: 'Сомкнутый строй — это', answer: 'плотный' },
        { question: 'Разомкнутый строй — это', answer: 'с промежутками' }
    ];
    const index = api.baseIndex(base);
    const page = api.textForms('Разомкнутый строй — это строй, в котором');
    const exact = api.bestByQuestion(page, base, index);
    equal('точное совпадение выбирает верную запись из пары',
        exact.data && exact.data.answer, 'с промежутками');

    // Тот же вопрос с опечаткой на странице: точного нет, работает примерный.
    const blurred = api.textForms('Разомкнутый строй — эта строй, в котором');
    const approx = api.bestApproximate(blurred, base, null, index);
    equal('из двух похожих выбирается ближайший',
        approx.data && approx.data.answer, 'с промежутками');
}

// Остаточный риск, ради которого и нужен отдельный значок 🟠: если самого
// вопроса в базе нет, а ЕГО БЛИЗНЕЦ есть, примерный поиск может подставить
// близнеца. Здесь спасает порог похожести: «сомкнутый» и «разомкнутый»
// расходятся на три знака при длине вопроса 19, это 0.84 — ниже порога 0.90, и
// кандидат отбраковывается. Но так везёт не всегда: чем длиннее вопрос, тем
// меньшую долю составляют те же три знака, и на длинном вопросе-близнеце порог
// уже не спасёт. Отсюда 🟠 и подстановка только по клику.
{
    const base = [{ question: 'Сомкнутый строй — это', answer: 'плотный' }];
    const index = api.baseIndex(base);
    const page = api.textForms('Разомкнутый строй — это строй, в котором');
    const approx = api.bestApproximate(page, base, null, index);
    check('короткий близнец не подставляется',
        approx.data === null, approx.data ? 'подставил ' + approx.data.question : '');
    check('но он виден в подсказке к ❌', approx.near.length > 0);
}

// ── вето по вариантам ответа ───────────────────────────────────────────────
{
    const body = {
        querySelectorAll: selector => (selector === 'option'
            ? [{ text: '2018' }, { text: '2019' }] : [{ innerText: 'Год?' }])
    };
    check('ответ, которого нет среди вариантов, отбраковывается',
        api.answerFitsBlock(body, '2020') === false);
    check('ответ из вариантов проходит',
        api.answerFitsBlock(body, '2019') === true);
    check('у задания без вариантов вето не работает',
        api.answerFitsBlock({ querySelectorAll: () => [] }, 'что угодно') === true);
}

// ── ключ набора ────────────────────────────────────────────────────────────
{
    const first = { question: 'Термин «дуалог» – это', answer: 'A' };
    const second = { question: 'Термин "дуалог" - это', answer: 'B' };
    equal('ключ набора не зависит от кавычек', api.harvestKey(first), api.harvestKey(second));
    equal('ключ набора не зависит от ответа',
        api.harvestKey(first), api.harvestKey({ question: first.question, answer: 'C' }));
    check('разные ответы не считаются равными', !api.answersEqual('A', 'B'));
    check('те же ответы считаются равными', api.answersEqual(['A ', 'b'], ['a', 'B']));
}

// ── выбор варианта ответа ──────────────────────────────────────────────────
{
    const options = [{ text: 'Первый вариант' }, { text: 'Второй вариант' }];
    equal('вариант с опечаткой находится примерным сравнением',
        api.closestChoice(options, api.normalizeText('Второй варинт')).text,
        'Второй вариант');
    equal('далёкий вариант не подставляется',
        api.closestChoice(options, api.normalizeText('совсем другое')), null);
}

console.log(failed
    ? `\n❌ Провалено: ${failed}, пройдено: ${passed}`
    : `\n✅ Всё сходится. Проверок пройдено: ${passed}`);
process.exit(failed ? 1 : 0);
