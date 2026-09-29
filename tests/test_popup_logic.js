// Проверка окна расширения БЕЗ браузера: popup.html разбирается как обычный
// html, его <script src> выполняются в песочнице node с заглушкой DOM, а
// хранилище отдаёт заранее заготовленный набор.
//
//     node tests/test_popup_logic.js
//
// Проверяется две вещи, которые глазами видно только в браузере:
//   1) normalize.js действительно подключён ДО popup.js и keyText() из него
//      доступен окну — иначе окно молча падало бы на первой же записи;
//   2) ключ окна совпадает с ключом страницы (content.js) на спорных случаях,
//      а повторы вопросов в наборе показываются, а не теряются молча.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', 'openedu-helper');
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8');

// ── заглушка DOM ───────────────────────────────────────────────────────────
// Ровно то, что трогает popup.js: createElement/append/appendChild, текст,
// классы и обработчики. Всё остальное намеренно отсутствует.
//
// Обработчики запоминаются (handlers), а textContent в значении '' чистит
// детей — как в настоящем DOM: без этого список после перерисовки только
// дописывался бы, и удаление записи в тесте было бы не проверить.
function makeElement(tag) {
    let text = '';
    const node = {
        tagName: tag,
        children: [],
        className: '',
        title: '',
        disabled: false,
        handlers: {},
        classList: {
            add: name => { node.className += ' ' + name; },
            toggle: () => {}
        },
        append(...kids) { node.children.push(...kids); },
        appendChild(kid) { node.children.push(kid); },
        addEventListener(type, handler) { node.handlers[type] = handler; }
    };
    Object.defineProperty(node, 'textContent', {
        get: () => text,
        set: value => {
            text = value;
            if (value === '') node.children.length = 0;
        }
    });
    return node;
}

function makeDom() {
    const byId = new Map();
    return {
        byId,
        getElementById: id => {
            if (!byId.has(id)) byId.set(id, makeElement('div'));
            return byId.get(id);
        },
        createElement: makeElement,
        querySelector: () => null,
        querySelectorAll: () => []
    };
}

// ── запуск popup.html ──────────────────────────────────────────────────────
// Разбираем html на <script src="..."> и выполняем файлы по порядку — тот же
// порядок, что и в браузере. Если normalize.js из html пропадёт, keyText не
// определится и тест это покажет.
//
// render() асинхронный, поэтому после запуска даём стеку опустеть: все await'ы
// внутри popup.js разрешаются на микрозадачах, а setImmediate идёт после них.
async function runPopup(stored) {
    const html = read('popup.html');
    const sources = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);
    const dom = makeDom();
    // Хранилище настоящего окна: get отдаёт то, что лежит сейчас, set кладёт
    // новое. Иначе удаление записи в тесте выглядело бы как «ничего не
    // изменилось» — заглушка возвращала бы исходный набор после каждой записи.
    const state = { records: stored.slice(), writes: [] };
    const sandbox = {
        console,
        document: dom,
        navigator: { clipboard: { writeText: async () => {} } },
        confirm: () => false,
        fetch: async () => ({ ok: false }),
        TextEncoder,
        btoa: value => Buffer.from(value, 'binary').toString('base64'),
        URL: { createObjectURL: () => 'blob:x' },
        Blob: function () {},
        setTimeout,
        clearTimeout,
        chrome: {
            runtime: { getURL: name => name },
            storage: {
                local: {
                    get: async () => ({ harvested: state.records.slice() }),
                    set: async data => {
                        state.records = data.harvested.slice();
                        state.writes.push(data.harvested);
                    },
                    remove: async () => { state.records = []; }
                }
            },
            downloads: { download: async () => 1 }
        }
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    sources.forEach(name => vm.runInContext(read(name), sandbox, { filename: name }));
    await new Promise(resolve => setImmediate(resolve));
    return { sandbox, dom, sources, state };
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

function equal(name, actual, expected) {
    check(name, actual === expected, `получено ${JSON.stringify(actual)}, ждали ${JSON.stringify(expected)}`);
}

// Пометка о повторе у записи списка: 'dup drop' или 'dup keep'.
function dupeNote(item) {
    return item.children.find(child => /(^| )dup( |$)/.test(child.className)) || null;
}

// ── ключ окна против ключа страницы ────────────────────────────────────────
// Ядро всей проверки: окно и страница считают ключ ОДНОЙ функцией. Раньше
// окно переписывало правило своими словами, копия разошлась с оригиналом — и в
// базу поехали дубликаты.
async function testKeySharedWithPage() {
    const { sandbox, sources } = await runPopup([]);
    equal('порядок подключения скриптов', sources.join(' '), 'normalize.js popup.js');
    check('keyText из normalize.js виден окну',
        typeof vm.runInContext('keyText', sandbox) === 'function');

    // Тот же набор, что гоняет tests/test_content_logic.js для content.js.
    const page = {
        console,
        location: { href: 'https://openedu.ru/course/x/' },
        setTimeout,
        clearTimeout,
        fetch: async () => ({ ok: false }),
        MutationObserver: class { observe() {} },
        document: {
            body: {}, querySelector: () => null, querySelectorAll: () => [],
            createElement: () => ({ style: {}, addEventListener() {} })
        },
        chrome: {
            runtime: { getURL: name => name },
            storage: { local: { get: async () => ({}), set: async () => {} } }
        }
    };
    page.window = page;
    vm.createContext(page);
    vm.runInContext(read('normalize.js') + '\n' + read('content.js'),
        page, { filename: 'content.js' });
    const pageKey = vm.runInContext('harvestKey', page);

    const fixtures = [
        { question: 'Термин «дуалог» – это', answer: 'A' },
        { question: 'Термин "дуалог" - это', answer: 'B' },
        { question: 'Термин «дуалог» — это', answer: 'C' },
        { question: 'Численность населения России в 2019 году', answer: 'D' },
        { question: 'экономика,  рост', answer: 'E' },
        { question: '', answer: 'F' }
    ];
    const mismatched = fixtures.filter(record =>
        sandbox.harvestKey(record) !== pageKey(record));
    check('ключ окна совпадает с ключом страницы на всех случаях',
        mismatched.length === 0,
        mismatched.map(record => record.question).join(' | '));

    // И то, ради чего ключ вообще меняли: ответ в ключ не входит.
    equal('ответ на ключ не влияет',
        sandbox.harvestKey(fixtures[0]), sandbox.harvestKey(fixtures[1]));
}

// ── показ повторов ─────────────────────────────────────────────────────────
// В наборе лежат дважды один и тот же вопрос (с разными кавычками и разными
// ответами) плюс одна обычная запись. Окно обязано сказать, что при слиянии
// останется последняя, и не сделать вид, что всё в порядке.
async function testDuplicatesShown() {
    const stored = [
        { question: 'Термин «дуалог» – это', answer: 'старый', _at: '2020-01-01' },
        { question: 'Сколько будет дважды два?', answer: '4' },
        { question: 'Термин "дуалог" - это', answer: 'новый', _at: '2026-09-01' }
    ];
    const { dom } = await runPopup(stored);
    const summary = dom.getElementById('summary').textContent;
    check('сводка сообщает о повторах', /Повторных вопросов: 1/.test(summary), summary);
    check('сводка считает все записи набора', /В наборе 3 записи/.test(summary), summary);

    const items = dom.getElementById('list').children;
    equal('в списке все записи, включая повторную', items.length, 3);

    const old = dupeNote(items[0]);
    const fresh = dupeNote(items[2]);
    check('у вытесняемой записи есть пометка', !!old,
        items[0].children.map(child => child.className).join(' | '));
    check('у остающейся записи есть пометка', !!fresh,
        items[2].children.map(child => child.className).join(' | '));
    check('вытесняемая помечена как проигрышная',
        !!old && old.className.includes('drop'), old ? old.className : '');
    check('остающаяся помечена как победившая',
        !!fresh && fresh.className.includes('keep'), fresh ? fresh.className : '');
    check('у обычной записи пометки нет',
        !dupeNote(items[1]), dupeNote(items[1]) ? dupeNote(items[1]).className : '');
}

// Набор без повторов не должен ничего сообщать про дубликаты.
async function testCleanSet() {
    const { dom } = await runPopup([{ question: 'Вопрос раз', answer: '1' }]);
    const summary = dom.getElementById('summary').textContent;
    check('без повторов сводка молчит о дубликатах', !/Повторных/.test(summary), summary);
}

// ── удаление одной записи ──────────────────────────────────────────────────
// Раньше передумать можно было только целиком («Очистить набор») — вместе с
// теми записями, которые как раз нужны. Крестик у записи убирает ровно её.
async function testDropRecord() {
    const stored = [
        { question: 'Первый вопрос', answer: '1' },
        { question: 'Второй вопрос', answer: '2' },
        { question: 'Третий вопрос', answer: '3' }
    ];
    const { dom, state } = await runPopup(stored);
    const items = dom.getElementById('list').children;
    equal('крестик есть у каждой записи', items.length, 3);

    const drop = items[1].children
        .find(child => child.className === 'head')
        .children.find(child => child.className === 'drop');
    check('у записи есть кнопка удаления', !!drop);
    if (!drop) return;
    check('у кнопки есть подсказка', /Убрать эту запись/.test(drop.title), drop.title);
    // Проверяем и обработчик: кнопка без него выглядит рабочей, но не делает
    // ничего — так уже пропадала кнопка копирования в content.js.
    check('у кнопки есть обработчик', typeof drop.handlers.click === 'function');
    if (typeof drop.handlers.click !== 'function') return;

    await drop.handlers.click();
    await new Promise(resolve => setImmediate(resolve));

    equal('из набора убрана ровно одна запись', state.records.length, 2);
    equal('убрана именно выбранная', state.records.map(r => r.question).join(' | '),
        'Первый вопрос | Третий вопрос');
    equal('список перерисован без неё', dom.getElementById('list').children.length, 2);
    equal('другие записи не тронуты', state.records[0].answer + state.records[1].answer, '13');
    check('окно сказало, что именно убрано',
        /Убрано из набора: Второй вопрос/.test(dom.getElementById('status').textContent),
        dom.getElementById('status').textContent);
    check('сводка пересчитана', /В наборе 2 записи/.test(dom.getElementById('summary').textContent),
        dom.getElementById('summary').textContent);
}

(async () => {
    await testKeySharedWithPage();
    await testDuplicatesShown();
    await testCleanSet();
    await testDropRecord();
    console.log(failed
        ? `\n❌ Провалено: ${failed}, пройдено: ${passed}`
        : `\n✅ Всё сходится. Проверок пройдено: ${passed}`);
    process.exit(failed ? 1 : 0);
})();
