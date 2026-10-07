// Окно расширения. Две вкладки: «Курсы» — витрина базы по списку из
// courses.json (файл ведётся руками, окно его только читает), «Набор» —
// снятые со страницы ответы и выгрузка их файлом.
//
// Набор окно читает из того же хранилища, куда пишет значок 📋 на странице
// курса, — общего кода у них нет, но правила сравнения текста общие:
// normalize.js подключён в popup.html ПЕРЕД этим файлом, ровно как в
// manifest.json перед content.js. Поэтому ключ записи здесь считается той же
// функцией, что и на странице, — а не её пересказом, который раньше и
// разошёлся с оригиналом.

const HARVEST_KEY = 'harvested';
const EXPORT_NAME = 'answers-new.json';

// Список курсов, ответы которых уже лежат в базе. Файл ведётся РУКАМИ: окно
// его только читает и показывает, ни один скрипт в него не пишет.
const COURSES_FILE = 'courses.json';

// Ключ записи набора — ТОЛЬКО текст вопроса, как в content.js и в
// qa_norm.record_key. Раньше в ключ входил ещё и ответ, поэтому один и тот же
// вопрос с разными ответами лежал в наборе дважды и уезжал дубликатом в базу.
// Здесь ключ нужен, чтобы показать такие записи ДО слияния: сам набор окно не
// чистит (записи могли быть сняты давно и вручную), но человек должен видеть,
// что именно из него потеряется.
function harvestKey(record) {
    return keyText(String(record.question || ''));
}

const TYPE_LABELS = {
    plain: 'обычное',
    crossword: 'кроссворд',
    matching: 'таблица'
};

const summaryEl = document.getElementById('summary');
const listEl = document.getElementById('list');
const statusEl = document.getElementById('status');
const exportBtn = document.getElementById('export');
const copyBtn = document.getElementById('copy');
const clearBtn = document.getElementById('clear');
const coursesEl = document.getElementById('courses');
const coursesNoteEl = document.getElementById('courses-summary');
const searchEl = document.getElementById('courses-search');

// Вкладки окна: имя вкладки, её кнопка и её панель. Кнопки и панели берутся
// по id, а не через querySelectorAll — так их находит и заглушка DOM в тестах,
// где настоящего дерева нет.
const TABS = ['courses', 'set'].map(name => ({
    name: name,
    button: document.getElementById('tab-' + name),
    pane: document.getElementById('pane-' + name)
}));

// Переключение вкладок задаётся ОДНОЙ функцией и для загрузки, и для клика:
// иначе подсветка вкладки и видимость панели могли бы разъехаться.
function showTab(name) {
    TABS.forEach(tab => {
        const active = tab.name === name;
        tab.button.classList.toggle('active', active);
        tab.pane.hidden = !active;
    });
}

// Вид записи — то же правило, что в content.js: у кроссворда ответ объект,
// таблица помечена полем type.
function recordType(record) {
    if (record && record.type) return record.type;
    if (record && record.answer && typeof record.answer === 'object'
        && !Array.isArray(record.answer)) {
        return 'crossword';
    }
    return 'plain';
}

// Служебные поля (_at, _source) в базу не идут: там им делать нечего.
function cleanRecord(record) {
    const out = {};
    Object.keys(record).forEach(key => {
        if (!key.startsWith('_')) out[key] = record[key];
    });
    return out;
}

function answerText(answer) {
    if (Array.isArray(answer)) return answer.map(answerText).join(' + ');
    if (answer && typeof answer === 'object') {
        return Object.keys(answer)
            .map(key => key + ': ' + answerText(answer[key])).join('; ');
    }
    return String(answer);
}

function cut(text, limit) {
    const oneLine = String(text).replace(/\s+/g, ' ').trim();
    return oneLine.length > limit ? oneLine.slice(0, limit - 1) + '…' : oneLine;
}

async function readHarvested() {
    const stored = await chrome.storage.local.get(HARVEST_KEY);
    const list = stored ? stored[HARVEST_KEY] : null;
    return Array.isArray(list) ? list : [];
}

// Сколько записей уже лежит в самой базе — чтобы было видно, к чему пойдёт
// слияние. Не получилось прочитать — не беда, это только справка.
async function baseSize() {
    try {
        const response = await fetch(chrome.runtime.getURL('answers.json'));
        const data = await response.json();
        return Array.isArray(data) ? data.length : null;
    } catch (error) {
        return null;
    }
}

// ── вкладка «Курсы» ────────────────────────────────────────────────────────
// Файл ведётся руками, поэтому разбор терпимый: пробелы по краям строк
// обрезаются, пустые строки пропускаются. Но непонятное содержимое молча
// пустым списком не показывается — иначе опечатка в json выглядела бы как
// «курсов нет», и было бы непонятно, что чинить.
async function readCourses() {
    let data;
    try {
        const response = await fetch(chrome.runtime.getURL(COURSES_FILE));
        if (!response.ok) {
            return { names: [], error: COURSES_FILE + ' не читается (' + response.status + ').' };
        }
        data = await response.json();
    } catch (error) {
        return { names: [], error: COURSES_FILE + ' не читается: ' + error.message };
    }
    if (!Array.isArray(data)) {
        return { names: [], error: COURSES_FILE + ': ожидался список названий вида '
            + '["Курс", "Курс"].' };
    }
    const names = [];
    let odd = 0;
    data.forEach(item => {
        if (typeof item !== 'string') { odd += 1; return; }
        const name = item.trim();
        if (name) names.push(name);
    });
    return { names: names, error: odd
        ? 'В ' + COURSES_FILE + ' пропущено непонятных строк: ' + odd
            + ' — названия должны быть строками.'
        : null };
}

// Названия из файла и текст последней ошибки — в памяти: поиск фильтрует
// список на каждый ввод, и перечитывать файл на каждую букву незачем.
let courseNames = [];
let coursesError = null;

// Поиск по названию. Сравниваются нормализованные тексты — тем же
// normalizeText из normalize.js, что и поиск ответов на странице: ни регистр,
// ни лишние пробелы, ни «ёлочки» с тире в названии не мешают. Своего правила
// тут быть не должно — иначе окно искало бы не так, как страница.
// (Буква «ё» остаётся «ё»: таково общее правило проекта, normalizeText её не
// сворачивает, и отдельное послабление здесь разошлось бы с ним.)
function filteredNames(names, query) {
    const needle = normalizeText(String(query || ''));
    if (!needle) return names;
    return names.filter(name => normalizeText(name).indexOf(needle) !== -1);
}

// Список рисуется и по загрузке, и на каждый ввод в поиске — из уже
// прочитанных названий.
function renderCourseList() {
    const query = searchEl.value.trim();
    const found = filteredNames(courseNames, query);

    coursesEl.textContent = '';
    if (!found.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = courseNames.length
            ? 'Ничего не нашлось по запросу «' + query + '».'
            : (coursesError || 'Список курсов пуст. Названия вписываются вручную в '
                + COURSES_FILE + ' — расширение читает его и ничего в него не пишет.');
        coursesEl.appendChild(empty);
        return;
    }
    found.forEach((name, index) => {
        // Тот же блок, что и у записи набора (.item > .head > .num +
        // .question): списки выглядят одинаково без новых правил css.
        const item = document.createElement('div');
        item.className = 'item';

        const head = document.createElement('div');
        head.className = 'head';

        const num = document.createElement('span');
        num.className = 'num';
        num.textContent = String(index + 1);

        const title = document.createElement('span');
        title.className = 'question';
        title.textContent = name;

        head.append(num, title);
        item.append(head);
        coursesEl.appendChild(item);
    });
}

// Нижняя строка вкладки. Разбивки «сколько записей у какого курса» тут быть
// не может: в базе нет поля с курсом, поэтому считаются названия из файла и
// записи базы целиком. Считается именно файл, а не показанное поиском: это
// справка о базе, а не о том, что сейчас на экране.
async function renderCourses() {
    const { names, error } = await readCourses();
    courseNames = names;
    coursesError = error;
    renderCourseList();

    const base = await baseSize();
    const line = 'В базе сейчас ' + names.length + ' '
        + plural(names.length, 'курс', 'курса', 'курсов')
        + (base === null ? '' : ' — ' + base + ' '
            + plural(base, 'запись', 'записи', 'записей'))
        + '.';
    // Ошибку внизу повторяем, только когда список всё-таки показан: если
    // показывать нечего, она уже стоит вместо списка.
    coursesNoteEl.textContent = (error && names.length ? error + ' ' : '') + line;
}

function say(text, bad) {
    statusEl.textContent = text || '';
    statusEl.classList.toggle('bad', !!bad);
}

// Разбор набора по ключу: key -> список номеров записей с таким вопросом.
// Записи без текста вопроса ключа не имеют и в группы не попадают: в наборе их
// быть не должно, но и молча прятать чужие данные окно права не имеет.
function groupRecords(records) {
    const groups = new Map();
    records.forEach((record, index) => {
        const key = harvestKey(record);
        if (!key) return;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(index);
    });
    return groups;
}

// Убрать одну запись из набора. Именно из набора: в базе запись появится
// только после слияния, а до него набор — единственное место, где можно
// передумать. Раньше передумать можно было только целиком («Очистить набор»),
// то есть вместе с теми записями, которые как раз нужны.
async function dropRecord(index) {
    const records = await readHarvested();
    if (index < 0 || index >= records.length) return;
    const [gone] = records.splice(index, 1);
    await chrome.storage.local.set({ [HARVEST_KEY]: records });
    say('Убрано из набора: ' + cut(gone.question || '(без текста)', 60));
    await render();
}

function renderList(records, groups) {
    listEl.textContent = '';
    if (!records.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'Набор пуст. Откройте задание на openedu.ru и нажмите 📋 '
            + 'у решённого задания, которого нет в базе.';
        listEl.appendChild(empty);
        return;
    }
    records.forEach((record, index) => {
        const key = harvestKey(record);
        const item = document.createElement('div');
        item.className = 'item';

        const head = document.createElement('div');
        head.className = 'head';

        const num = document.createElement('span');
        num.className = 'num';
        num.textContent = String(index + 1);

        const type = document.createElement('span');
        type.className = 'type';
        type.textContent = TYPE_LABELS[recordType(record)] || recordType(record);

        const question = document.createElement('span');
        question.className = 'question';
        question.textContent = cut(record.question || '(без текста)', 90);

        // Крестик идёт последним в шапке записи: так он стоит на одной строке
        // с номером и типом и не уезжает вниз при длинном вопросе.
        const drop = document.createElement('button');
        drop.type = 'button';
        drop.className = 'drop';
        drop.textContent = '✕';
        drop.title = 'Убрать эту запись из набора — в базу она не попадёт.';
        drop.addEventListener('click', () => dropRecord(index));

        head.append(num, type, question, drop);

        const answer = document.createElement('div');
        answer.className = 'answer';
        answer.textContent = cut(answerText(record.answer), 90);

        // Полные тексты — в подсказке: в узком окне они не помещаются.
        const full = [record.question || '', answerText(record.answer),
                      record._source ? 'откуда: ' + record._source : '',
                      record._at ? 'когда: ' + record._at : '']
            .filter(Boolean).join('\n');
        item.title = full;

        item.append(head);

        // Тот же вопрос записан дважды (остался от прежнего правила — ключом
        // была пара «вопрос + ответ»). Побеждает последняя запись: так решают
        // и слияние с базой, и dedupe-answers.py. Показываем это прямо здесь,
        // чтобы расхождение ответов не обнаружилось уже после слияния.
        const same = key ? groups.get(key) : null;
        if (same && same.length > 1) {
            const order = same.indexOf(index) + 1;
            const last = order === same.length;
            item.classList.add('dupe');
            const note = document.createElement('div');
            note.className = last ? 'dup keep' : 'dup drop';
            note.textContent = 'тот же вопрос ' + order + '/' + same.length
                + (last ? ' — при слиянии останется эта запись'
                        : ' — при слиянии вытеснится последней');
            item.append(note);
        }

        item.append(answer);
        listEl.appendChild(item);
    });
}

async function render() {
    const records = await readHarvested();

    const groups = groupRecords(records);
    // Сколько записей набора сгорит при слиянии: в каждой группе побеждает
    // последняя, остальные выбрасываются. Счётчик записей отсюда убран —
    // под заголовком осталась только эта строка, и только когда повторы есть.
    let dropped = 0;
    groups.forEach(list => { if (list.length > 1) dropped += list.length - 1; });

    renderList(records, groups);
    summaryEl.textContent = dropped
        ? 'Повторных вопросов: ' + dropped + ' — при слиянии по каждому '
            + 'останется последняя запись.'
        : '';

    exportBtn.disabled = !records.length;
    copyBtn.disabled = !records.length;
    clearBtn.disabled = !records.length;
    return records;
}

function plural(n, one, few, many) {
    const tail = n % 100;
    if (tail >= 11 && tail <= 14) return many;
    const last = n % 10;
    if (last === 1) return one;
    if (last >= 2 && last <= 4) return few;
    return many;
}

async function jsonText() {
    const records = await readHarvested();
    return JSON.stringify(records.map(cleanRecord), null, 4);
}

// Ссылка на данные. Обычная blob-ссылка живёт, пока живёт окно расширения, а
// оно закроется сразу, как только откроется системный диалог «Сохранить как».
// Поэтому содержимое вкладываем прямо в ссылку — она самодостаточна.
function dataUrl(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return 'data:application/json;charset=utf-8;base64,' + btoa(binary);
}

async function saveFile(text) {
    // data:-ссылка первая, blob — запасной путь: если браузер откажется
    // скачивать data:, попробуем обычную ссылку на объект.
    const attempts = [
        () => dataUrl(text),
        () => URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    ];
    let lastError = null;
    for (const makeUrl of attempts) {
        try {
            // saveAs: true — системный диалог «Сохранить как». Скачиванием
            // управляет сам браузер, так что закрытие окна расширения
            // загрузку не отменяет.
            await chrome.downloads.download({ url: makeUrl(), filename: EXPORT_NAME, saveAs: true });
            return true;
        } catch (error) {
            lastError = error;
        }
    }
    console.error('❌ Не удалось сохранить файл:', lastError);
    return false;
}

exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    say('Сохраняю файл…');
    const text = await jsonText();
    const saved = await saveFile(text);
    exportBtn.disabled = false;
    say(saved
        ? 'Файл ' + EXPORT_NAME + ' сохранён. Теперь двойной клик по openedu.cmd '
            + 'в папке проекта: пункт «Слить выгруженный набор в базу».'
        : 'Сохранить файл не удалось. Нажмите «Скопировать JSON» и вставьте '
            + 'содержимое в файл вручную.', !saved);
});

copyBtn.addEventListener('click', async () => {
    const text = await jsonText();
    try {
        await navigator.clipboard.writeText(text);
        say('JSON набора скопирован в буфер обмена.');
    } catch (error) {
        say('Скопировать не удалось: ' + error.message, true);
    }
});

clearBtn.addEventListener('click', async () => {
    const records = await readHarvested();
    if (!records.length) return;
    if (!confirm('Удалить из набора все записи (' + records.length + ')?\n'
        + 'Уже слитые с базой записи в самой базе останутся.')) return;
    await chrome.storage.local.remove(HARVEST_KEY);
    say('Набор очищен.');
    render();
});

TABS.forEach(tab => tab.button.addEventListener('click', () => showTab(tab.name)));

// Поиск фильтрует уже прочитанный список — файл на каждую букву не читается.
searchEl.addEventListener('input', renderCourseList);

// Открываем «Курсы»: это витрина базы, и по умолчанию видно именно её.
showTab('courses');
render();
renderCourses();
