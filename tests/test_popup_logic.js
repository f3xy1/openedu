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
//
// classList ведётся поверх className (а не отдельным набором) — по className
// записи ищутся ниже, и разъехаться этим двум нельзя. force у toggle тоже
// настоящий: showTab передаёт вторым аргументом «быть вкладке активной или
// нет», и без поддержки force активная вкладка переключалась бы вслепую.
function makeClassList(node) {
    const names = () => node.className.split(/\s+/).filter(Boolean);
    const has = name => names().indexOf(name) !== -1;
    const keep = list => { node.className = list.join(' '); };
    return {
        add: name => { if (!has(name)) keep(names().concat(name)); },
        remove: name => keep(names().filter(item => item !== name)),
        contains: has,
        toggle: (name, force) => {
            const want = force === undefined ? !has(name) : !!force;
            if (want) node.classList.add(name);
            else node.classList.remove(name);
        }
    };
}

function makeElement(tag) {
    let text = '';
    const node = {
        tagName: tag,
        children: [],
        className: '',
        title: '',
        disabled: false,
        // Панели вкладок прячутся этим свойством; по умолчанию видимы — как
        // у элемента без атрибута hidden.
        hidden: false,
        // Поле поиска читается как value — у остальных элементов оно просто
        // остаётся пустым и никому не мешает.
        value: '',
        handlers: {},
        append(...kids) { node.children.push(...kids); },
        appendChild(kid) { node.children.push(kid); },
        addEventListener(type, handler) { node.handlers[type] = handler; }
    };
    node.classList = makeClassList(node);
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
// render() и renderCourses() асинхронные, поэтому после запуска даём стеку
// опустеть: все await'ы внутри popup.js разрешаются на микрозадачах, а
// setImmediate идёт после них.
//
// files — то, что «лежит в расширении»: имя файла -> его разобранное
// содержимое. Ответ отдаётся по хвосту адреса, потому что getURL в заглушке
// возвращает имя файла как есть. Незапрошенный файл отвечает 404 — так же,
// как окно увидело бы опечатку в имени файла или непроложенный json.
async function runPopup(stored, files) {
    files = files || {};
    const html = read('popup.html');
    const sources = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);
    const dom = makeDom();
    // Хранилище настоящего окна: get отдаёт то, что лежит сейчас, set кладёт
    // новое. Иначе удаление записи в тесте выглядело бы как «ничего не
    // изменилось» — заглушка возвращала бы исходный набор после каждой записи.
    const state = { records: stored.slice(), writes: [], fetches: [] };
    const sandbox = {
        console,
        document: dom,
        navigator: { clipboard: { writeText: async () => {} } },
        confirm: () => false,
        fetch: async url => {
            state.fetches.push(String(url));
            const name = String(url).split('/').pop();
            if (!(name in files)) {
                return { ok: false, status: 404, json: async () => { throw new Error('HTTP 404'); } };
            }
            return { ok: true, status: 200, json: async () => files[name] };
        },
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
    const { dom } = await runPopup(stored, {});
    const summary = dom.getElementById('summary').textContent;
    check('сводка сообщает о повторах', /Повторных вопросов: 1/.test(summary), summary);
    // Счётчик записей из этой строки убран: под заголовком остаётся только то,
    // что требует внимания.
    check('счётчика записей под заголовком нет', !/В наборе/.test(summary), summary);

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

// Набор без повторов не должен ничего сообщать про дубликаты — и вообще
// ничего не должен писать под заголовком (пустую строку прячет css).
async function testCleanSet() {
    const { dom } = await runPopup([{ question: 'Вопрос раз', answer: '1' }], {});
    equal('под заголовком пусто', dom.getElementById('summary').textContent, '');
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
    const { dom, state } = await runPopup(stored, {});
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
    check('под заголовком по-прежнему ничего нет — счётчика записей не вернули',
        dom.getElementById('summary').textContent === '',
        dom.getElementById('summary').textContent);
}

// ── вкладки окна ───────────────────────────────────────────────────────────
// «Курсы» открываются первыми, «Набор» — по клику. Проверяем и состояние по
// загрузке, и переключение: обработчик вкладки обязан реально прятать панели,
// иначе окно выглядело бы рабочим, а вторая вкладка не открывалась.
async function testTabs() {
    const { dom } = await runPopup([], {});
    const courses = dom.getElementById('pane-courses');
    const set = dom.getElementById('pane-set');
    equal('первой открыта вкладка «Курсы»', courses.hidden, false);
    equal('вкладка «Набор» при этом спрятана', set.hidden, true);
    check('у «Курсов» есть пометка активной',
        dom.getElementById('tab-courses').classList.contains('active'));
    check('у «Набора» пометки нет',
        !dom.getElementById('tab-set').classList.contains('active'));

    const tab = dom.getElementById('tab-set');
    check('у вкладки есть обработчик', typeof tab.handlers.click === 'function');
    if (typeof tab.handlers.click !== 'function') return;
    tab.handlers.click();
    equal('клик открывает «Набор»', set.hidden, false);
    equal('«Курсы» при этом прячутся', courses.hidden, true);
    check('пометка активной переехала на «Набор»',
        tab.classList.contains('active')
        && !dom.getElementById('tab-courses').classList.contains('active'));
}

// Название строки списка курсов: .item > .head > (.num, .question).
function courseName(row) {
    return row.children[0].children[1].textContent;
}

// ── вкладка «Курсы» ────────────────────────────────────────────────────────
// Список берётся из courses.json как есть, в порядке файла, а под ним — две
// цифры: сколько названий в файле и сколько записей в базе.
async function testCoursesTab() {
    const { dom, state } = await runPopup([], {
        'courses.json': ['Основы экономики', '  История России  ', ''],
        'answers.json': [{ question: 'a' }, { question: 'b' }, { question: 'c' }]
    });
    const rows = dom.getElementById('courses').children;
    equal('строк столько же, сколько названий', rows.length, 2);
    equal('порядок как в файле, пробелы обрезаны',
        rows.map(courseName).join(' | '), 'Основы экономики | История России');
    equal('подпись считает курсы и записи',
        dom.getElementById('courses-summary').textContent,
        'В базе сейчас 2 курса — 3 записи.');

    // Главное правило этого файла: его ведёт человек. Окно не должно ни писать
    // в хранилище, ни трогать набор, а файл — запрашивать ровно один раз.
    equal('в хранилище ничего не записано', state.writes.length, 0);
    equal('набор не тронут', state.records.length, 0);
    equal('courses.json запрошен один раз',
        state.fetches.filter(url => /courses\.json$/.test(url)).length, 1);
}

// Пустой список — не ошибка, но и молчать о нём нельзя: человеку надо
// сказать, КУДА вписывать названия.
async function testCoursesEmpty() {
    const { dom } = await runPopup([], { 'courses.json': [], 'answers.json': [{ question: 'a' }] });
    const box = dom.getElementById('courses').children[0];
    check('пустой файл объясняет, что список ведётся руками',
        /вписываются вручную в courses\.json/.test(box.textContent), box.textContent);
    equal('подпись про пустой список',
        dom.getElementById('courses-summary').textContent,
        'В базе сейчас 0 курсов — 1 запись.');
}

// Битый файл не должен выглядеть как «курсов нет»: человек, поправивший json
// руками, обязан видеть, что именно не прочиталось.
async function testCoursesBroken() {
    const asObject = await runPopup([], { 'courses.json': { 'Курс': 1 } });
    const shown = asObject.dom.getElementById('courses').children[0].textContent;
    check('вместо списка объект — окно говорит, чего ждало',
        /ожидался список названий/.test(shown), shown);

    const missing = await runPopup([], {});
    const text = missing.dom.getElementById('courses').children[0].textContent;
    check('отсутствующий файл не выдаётся за пустой список',
        /не читается/.test(text), text);

    // Строка не той формы: список показывается, но о пропущенном говорится —
    // иначе название молча пропало бы из витрины.
    const mixed = await runPopup([], { 'courses.json': ['Курс', 42] });
    equal('непонятная строка в список не попала',
        mixed.dom.getElementById('courses').children.length, 1);
    check('и об этом сказано в подписи',
        /пропущено непонятных строк: 1/
            .test(mixed.dom.getElementById('courses-summary').textContent),
        mixed.dom.getElementById('courses-summary').textContent);
}

// ── склонения ──────────────────────────────────────────────────────────────
// Нижняя строка читается человеком, поэтому «1 курсов» и «3 запись» не годятся.
async function testPlural() {
    const { sandbox } = await runPopup([], {});
    const plural = vm.runInContext('plural', sandbox);
    const table = [[0, 'курсов'], [1, 'курс'], [2, 'курса'], [4, 'курса'],
                   [5, 'курсов'], [11, 'курсов'], [21, 'курс'], [22, 'курса'],
                   [25, 'курсов'], [101, 'курс']];
    const wrong = table.filter(([count, want]) =>
        plural(count, 'курс', 'курса', 'курсов') !== want);
    check('склонение по числу', wrong.length === 0, JSON.stringify(wrong));
    equal('11 — исключение', plural(11, 'запись', 'записи', 'записей'), 'записей');
    equal('21 — снова единственное', plural(21, 'запись', 'записи', 'записей'), 'запись');
}

// ── поиск по курсам ────────────────────────────────────────────────────────
// Поле фильтрует УЖЕ прочитанный список: файл на каждую букву не читается —
// иначе поиск был бы и медленным, и шумным (запрос на каждое нажатие клавиши).
async function testCoursesSearch() {
    const { dom, state } = await runPopup([], {
        'courses.json': ['Психология медиакоммуникаций цифровой эпохи',
                         'Основы военной подготовки и безопасность жизнедеятельности',
                         'Философия и её проблемы'],
        'answers.json': []
    });
    const box = dom.getElementById('courses-search');
    const list = dom.getElementById('courses');
    equal('до поиска показаны все курсы', list.children.length, 3);

    check('у поля поиска есть обработчик', typeof box.handlers.input === 'function');
    if (typeof box.handlers.input !== 'function') return;

    box.value = 'воен';
    box.handlers.input();
    equal('поиск оставил один курс', list.children.length, 1);
    equal('и это тот самый курс', courseName(list.children[0]),
        'Основы военной подготовки и безопасность жизнедеятельности');

    box.value = 'ВОЕННАЯ';
    box.handlers.input();
    equal('регистр запроса не важен', list.children.length, 1);

    box.value = '  психология   медиа  ';
    box.handlers.input();
    equal('лишние пробелы в запросе не мешают', list.children.length, 1);

    box.value = 'такого курса нет';
    box.handlers.input();
    equal('ничего не найдено — вместо списка объяснение',
        list.children[0].className, 'empty');
    check('и сказано, по какому запросу',
        /Ничего не нашлось по запросу «такого курса нет»/.test(list.children[0].textContent),
        list.children[0].textContent);

    box.value = '';
    box.handlers.input();
    equal('пустой запрос возвращает весь список', list.children.length, 3);
    equal('за всё это файл прочитан один раз',
        state.fetches.filter(url => /courses\.json$/.test(url)).length, 1);
    equal('подпись считает файл, а не показанное поиском',
        dom.getElementById('courses-summary').textContent,
        'В базе сейчас 3 курса — 0 записей.');
}

// ── разметка и скрипт не разъехались ──────────────────────────────────────
// Окно берёт элементы по id. Если id в разметке переименуют или потеряют,
// getElementById молча вернёт null и часть окна перестанет работать — так в
// проекте уже пропадала кнопка копирования. Заглушка DOM этого не поймает: она
// создаёт элемент по первому обращению. Поэтому сверяем скрипт с самим html.
function testMarkupWiring() {
    const html = read('popup.html');
    const source = read('popup.js');
    const ids = [...source.matchAll(/getElementById\('([^']+)'\)/g)].map(match => match[1]);
    check('скрипт вообще ищет элементы по id', ids.length > 0, String(ids.length));
    const missing = ids.filter(id => html.indexOf('id="' + id + '"') === -1);
    check('все id, которые ищет скрипт, есть в разметке',
        missing.length === 0, missing.join(', '));

    // Вкладки и панели собираются из имени ('tab-' + name, 'pane-' + name),
    // поэтому под регулярку выше они не попадают — проверяем их по именам.
    const built = ['tab-courses', 'tab-set', 'pane-courses', 'pane-set'];
    const lost = built.filter(id => html.indexOf('id="' + id + '"') === -1);
    check('вкладки и панели есть в разметке', lost.length === 0, lost.join(', '));
    check('поле поиска есть в разметке', html.indexOf('id="courses-search"') !== -1);
}

(async () => {
    await testKeySharedWithPage();
    await testDuplicatesShown();
    await testCleanSet();
    await testDropRecord();
    await testTabs();
    await testCoursesTab();
    await testCoursesEmpty();
    await testCoursesBroken();
    await testCoursesSearch();
    testMarkupWiring();
    await testPlural();
    console.log(failed
        ? `\n❌ Провалено: ${failed}, пройдено: ${passed}`
        : `\n✅ Всё сходится. Проверок пройдено: ${passed}`);
    process.exit(failed ? 1 : 0);
})();
