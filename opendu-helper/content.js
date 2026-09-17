console.log("🚀 OpenEdu Helper v6.6 ЗАПУЩЕН! (кроссворды, задания с публикацией, таблицы на сопоставление)");

// Все дефисы и тире: ASCII-дефис, типографские, неразрывный, минус.
// Записаны кодами, а не символами, — чтобы в файле не завелось невидимых знаков.
const DASH_CHARS = '\u002D\u2010\u2011\u2012\u2013\u2014\u2015\u2212';
const SOFT_HYPHEN_RE = new RegExp(`(?<=\\p{L})[${DASH_CHARS}](?=\\p{L})`, 'gu');
const DASH_RE = new RegExp(`[${DASH_CHARS}]`, 'g');

// Платформа рвёт длинные слова по ширине окна и вставляет дефис: «сообще-ния»,
// «про-блемных», «Ин-тернет». Ширина окна у каждого своя, поэтому в базе и на
// странице одно и то же слово может оказаться с дефисом и без — и точное
// сравнение строк ломается. Дефис между двумя буквами считаем мягким переносом
// и убираем с ОБЕИХ сторон, тогда варианты совпадают.
// Дефисы в составных словах («масс-медиа») убираются заодно — это лечит и
// разнобой в написании одного слова (в базе встречается и «массмедиа»).
function stripSoftHyphens(text) {
    return text.replace(SOFT_HYPHEN_RE, '');
}

// Оставшиеся тире (те, что стоят между словами и переносом не являются) тоже
// надо уравнять. Один и тот же вопрос платформа рисует по-разному в разных
// виджетах: в радио «Термин «дуалог» – это» (тире U+2013), а в выпадающем
// списке «Термин «дуалог» - это» (обычный дефис). База пришла из docx, там
// типографское тире — без этой замены вопрос не находится.
function normalizeDashes(text) {
    return text.replace(DASH_RE, '-');
}

function normalizeText(text) {
    if (typeof text !== 'string' || !text) return '';
    const cleanedText = normalizeDashes(stripSoftHyphens(text))
        .replace(/[\s⬜⬛⚪⚫]+/g, ' ').trim().toLowerCase();
    return cleanedText;
}

// ── поиск вопроса в базе ───────────────────────────────────────────────────
// Возвращает {score, data}. Вопрос из базы может быть записан через '...' —
// тогда на странице должны найтись ВСЕ части (см. ситуационные задачи).
function bestByQuestion(pageText, answersData) {
    let best = { score: 0, data: null };
    if (!pageText) return best;
    answersData.forEach(item => {
        const question = normalizeText(item.question);
        if (!question) return;
        let score = 0;
        let isMatch = false;
        if (question.includes('...')) {
            const parts = question.split('...');
            if (parts.every(part => pageText.includes(part.trim()))) {
                isMatch = true;
                score = parts.reduce((sum, part) => sum + part.length, 0);
            }
        } else if (pageText.includes(question)) {
            isMatch = true;
            score = question.length;
        }
        if (isMatch && score > best.score) {
            best = { score, data: item };
        }
    });
    return best;
}

// У кроссворда ответ — объект «номер слова → слово». Такую запись нельзя
// путать с обычным вопросом: длинная подпись из подсказок иначе перебьёт
// короткий текстовый вопрос и в поля уедет мусор. Поэтому два отдельных
// поиска — по текстовым записям и по кроссвордным.
// ── виды записей ───────────────────────────────────────────────────────────
// Обычный вопрос — ответ строкой или списком. Но есть задания, где одним
// ответом не отделаешься: кроссворд (ответ — «номер слова → слово») и таблица
// на сопоставление (ответ — «в какую ячейку → какую карточку»). Вид записи
// пишется в поле type; у записей без type кроссворд узнаётся по форме ответа,
// чтобы уже собранная база не сломалась.
function recordType(item) {
    if (item && item.type) return item.type;
    if (item && item.answer && typeof item.answer === 'object' && !Array.isArray(item.answer)) {
        return 'crossword';
    }
    return 'plain';
}

function isCrosswordRecord(item) {
    return recordType(item) === 'crossword';
}

function isMatchingRecord(item) {
    return recordType(item) === 'matching';
}

function matchQuestion(pageText, answersData) {
    return bestByQuestion(pageText, answersData.filter(item => recordType(item) === 'plain'));
}

// ── разбор блока на контролы ───────────────────────────────────────────────
function bodyOf(block) {
    return block.querySelector('div.problem') || block;
}

function escapeId(id) {
    return (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(id) : id;
}

// Подпись контрола. У селектов и полей ввода платформа кладёт текст вопроса
// в <label for="id">, а варианты ответа — в сами опции.
function labelOf(body, el) {
    if (el.id) {
        const found = body.querySelector(`label[for="${escapeId(el.id)}"]`);
        if (found) return found.innerText;
    }
    const wrap = el.closest('label');
    return wrap ? wrap.innerText : '';
}

// Текст, стоящий непосредственно перед контролом — до предыдущего контрола.
// Нужен для радио и чекбоксов: у них подпись каждого варианта — сам вариант
// ответа, а вопрос лежит отдельным абзацем выше.
function stemBefore(body, el) {
    const parts = [];
    let node = el;
    while (node && node !== body) {
        let sibling = node.previousElementSibling;
        while (sibling) {
            // в чужие варианты ответа не заглядываем
            if (sibling.querySelector && sibling.querySelector('input, select, textarea')) break;
            const text = (sibling.innerText || '').trim();
            if (text) parts.unshift(text);
            sibling = sibling.previousElementSibling;
        }
        node = node.parentElement;
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
}

// Контролы блока, сгруппированные по смыслу. Каждый select — это отдельный
// вопрос со своей подписью. Радио и чекбоксы одного name — один вопрос.
// Поля ввода собираем в одну группу: в задачах-таблицах это одна задача с
// несколькими значениями, которые раскладываются по порядку.
function buildGroups(body) {
    const groups = [];
    const byKey = new Map();
    const controls = body.querySelectorAll(
        'select, input[type="text"], input[type="radio"], input[type="checkbox"]');
    controls.forEach(el => {
        let key;
        let kind;
        if (el.tagName === 'SELECT') {
            kind = 'select';
            key = 'select#' + (el.id || groups.length);
        } else if (el.type === 'text') {
            kind = 'text';
            key = 'text';
        } else {
            kind = el.type;
            key = el.type + '#' + (el.name || ('anon' + groups.length));
        }
        let group = byKey.get(key);
        if (!group) {
            group = { key, kind, elements: [] };
            byKey.set(key, group);
            groups.push(group);
        }
        group.elements.push(el);
    });
    return groups;
}

// Контролы, по которым ответ-список раскладывается по порядку.
function positionalTarget(body) {
    const texts = body.querySelectorAll('input[type="text"]');
    if (texts.length) return { kind: 'text', elements: Array.from(texts) };
    const selects = body.querySelectorAll('select');
    if (selects.length) return { kind: 'select', elements: Array.from(selects) };
    return null;
}

// ── кроссворд ──────────────────────────────────────────────────────────────
// Сетка кроссворда: div.cell[data-coords="X,Y"] (нумерация с единицы) с
// классом entry-N, где N — номер слова в списке подсказок, и вложенным
// input[maxlength=1]. Ответ в базе — объект «номер слова → слово»:
//   {"question": "первая подсказка ... последняя подсказка",
//    "problem_id": "block-v1:...@problem+block@226251fe...",
//    "answer": {"1": "социожурналистика", "2": "демографические"}}
// problem_id (атрибут data-problem-id блока) — самый надёжный ключ, он не
// зависит от того, как платформа отрисовала текст. Подпись из подсказок —
// запасной вариант: она выручит, если курс пересоберут и id поменяются.
function isCrossword(body) {
    return !!body.querySelector('div.cell[data-coords]');
}

// Клетки, разложенные по словам и упорядоченные в порядке чтения.
// Клетка на пересечении принадлежит сразу двум словам и несёт два класса
// (например «cell entry-1 position-0 input entry-8 position-8») — поэтому
// классы перебираем все, иначе у вертикального слова не хватит букв.
function crosswordEntries(body) {
    const byEntry = new Map();
    Array.from(body.querySelectorAll('div.cell[data-coords]')).forEach(cell => {
        const input = cell.querySelector('input');
        const numbers = String(cell.className).match(/entry-\d+/g);
        if (!input || !numbers) return;
        const coords = (cell.dataset.coords || '').split(',').map(Number);
        numbers.forEach(found => {
            const number = Number(found.slice('entry-'.length));
            if (!byEntry.has(number)) byEntry.set(number, []);
            byEntry.get(number).push({ input, x: coords[0], y: coords[1] });
        });
    });
    // Слово идёт либо по строке, либо по столбцу: та ось, что не меняется,
    // задаёт направление, по второй клетки и сортируются.
    byEntry.forEach(cells => {
        const horizontal = cells.every(cell => cell.y === cells[0].y);
        cells.sort(horizontal ? (a, b) => a.x - b.x : (a, b) => a.y - b.y);
    });
    return byEntry;
}

// Подпись кроссворда для базы: первая и последняя подсказки. Две подсказки
// из разных концов списка не дадут спутать один кроссворд с другим.
function crosswordSignature(body) {
    const clues = Array.from(body.querySelectorAll('div.clue')).map(clue => {
        const copy = clue.cloneNode(true);
        const number = copy.querySelector('.clue-number');
        if (number) number.remove();
        return copy.innerText.replace(/\s+/g, ' ').trim();
    }).filter(Boolean);
    if (!clues.length) return '';
    return clues.length > 1 ? `${clues[0]} ... ${clues[clues.length - 1]}` : clues[0];
}

// Слово для клеток: пробелы не нужны, регистр платформа приводит сама.
function crosswordWord(word) {
    return String(word === undefined || word === null ? '' : word)
        .replace(/\s+/g, '').toLowerCase();
}

function crosswordPlan(block, body, answersData) {
    const entries = crosswordEntries(body);
    const problemId = block.dataset.problemId || '';
    const crosswordData = answersData.filter(isCrosswordRecord);
    let record = problemId ? crosswordData.find(item => item.problem_id === problemId) : null;
    if (!record) {
        record = bestByQuestion(normalizeText(body.innerText), crosswordData).data;
    }
    const answers = record ? record.answer : null;

    const steps = [];
    // Буквы, уже разложенные по клеткам. Клетка на пересечении принадлежит
    // двум словам, и обе буквы обязаны совпасть: это единственная проверка,
    // которая ловит опечатку в базе, — платформа такую клетку просто не
    // примет.
    const letters = new Map();
    const conflicts = [];
    entries.forEach((cells, number) => {
        const word = answers ? crosswordWord(answers[number]) : '';
        // Длина слова — единственная проверка, которая ловит расхождение
        // базы с сеткой: короткое слово иначе затрёт половину строки, а
        // длинное молча оборвётся.
        if (word && word.length === cells.length) {
            steps.push({ kind: 'crossword', elements: cells.map(cell => cell.input), answer: word });
            cells.forEach((cell, index) => {
                const key = `${cell.x},${cell.y}`;
                if (!letters.has(key)) {
                    letters.set(key, word[index]);
                } else if (letters.get(key) !== word[index]) {
                    conflicts.push({ cell: key, было: letters.get(key), стало: word[index], слово: number });
                }
            });
        }
    });
    return { mode: 'crossword', steps, matched: steps.length, total: entries.size, conflicts };
}

// Готовое решение со страницы: если кроссворд уже заполнен руками, его можно
// забрать в базу, не перепечатывая клетки.
function harvestCrossword(body) {
    const entries = crosswordEntries(body);
    const words = {};
    let filled = 0;
    entries.forEach((cells, number) => {
        const letters = cells.map(cell => String(cell.input.value || '').trim());
        if (letters.every(letter => letter.length === 1)) {
            words[number] = letters.join('').toLowerCase();
            filled += 1;
        }
    });
    return { words, filled, total: entries.size };
}

// ── таблица на сопоставление (перетаскиванием) ─────────────────────────────
// Виджет matching_table: сверху ячейки-цели (a1, a2 — «до редактирования»,
// «после редактирования»), снизу пул карточек (b1, b2), которые надо
// перетащить мышкой. Перетаскивать руками не обязательно: своё состояние
// виджет собирает из расположения карточек в DOM и кладёт в скрытое поле
// в виде {"answer": {"a1": ["b1"], "a2": ["b2"]}} — именно это поле платформа
// и читает при проверке. Значит, достаточно разложить карточки по местам и
// записать в поле ровно тот же JSON.
function isMatching(body) {
    return !!body.querySelector('div.matching_table');
}

function matchingTable(body) {
    return body.querySelector('div.matching_table');
}

// id уникальны только внутри таблицы: на странице семь таких заданий, и в
// каждом свои a1/a2/b1/b2. Поэтому берём карту id самой таблицы, а не
// document.querySelector — иначе всегда находилась бы первая таблица.
function matchingNodes(table) {
    const byId = new Map();
    Array.from(table.querySelectorAll('[id]')).forEach(element => byId.set(element.id, element));
    return byId;
}

function matchingItems(table) {
    return Array.from(table.querySelectorAll('.conf-item.conf-draggable'));
}

// После перетаскивания карточки лежат в целях, и порядок в DOM уже не тот,
// что был при отрисовке. Для подписи сортируем по номеру в id: b1, b2, … b10.
function matchingItemNumber(item) {
    const found = String(item.id).match(/(\d+)$/);
    return found ? Number(found[1]) : 0;
}

function matchingSignature(table) {
    const items = matchingItems(table).sort((a, b) => matchingItemNumber(a) - matchingItemNumber(b));
    const texts = items.map(item => item.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (!texts.length) return '';
    return texts.length > 1 ? `${texts[0]} ... ${texts[texts.length - 1]}` : texts[0];
}

// Карточку ищем сначала по id, потом по тексту: id попадают в базу как есть
// и могут устареть, если задание переверстают.
function matchingItem(table, wanted) {
    const found = matchingNodes(table).get(String(wanted));
    if (found) return found;
    const needle = normalizeText(wanted);
    return matchingItems(table).find(item => normalizeText(item.innerText) === needle) || null;
}

function matchingPlan(block, body, answersData) {
    const table = matchingTable(body);
    const problemId = block.dataset.problemId || '';
    const records = answersData.filter(isMatchingRecord);
    let record = problemId ? records.find(item => item.problem_id === problemId) : null;
    // Подпись — запасной вариант на случай пересборки курса: тогда записи
    // придётся перепривязать, но хотя бы одна из них найдётся по тексту.
    if (!record) record = bestByQuestion(normalizeText(body.innerText), records).data;
    const groups = record && record.answer && typeof record.answer === 'object' ? record.answer : {};
    const places = Object.keys(groups);

    const steps = [];
    const missed = [];
    places.forEach(place => {
        const target = matchingNodes(table).get(String(place));
        const wanted = Array.isArray(groups[place]) ? groups[place] : [groups[place]];
        const items = wanted.map(item => matchingItem(table, item)).filter(Boolean);
        if (target && items.length && items.length === wanted.length) {
            steps.push({ kind: 'matching', target, items });
        } else {
            missed.push(place);
        }
    });
    return { mode: 'matching', steps, matched: steps.length, total: places.length || 1, missed };
}

// Готовое решение со страницы: виджет хранит его в том же скрытом поле, так
// что решённую таблицу можно забрать в базу, не перетаскивая карточки заново.
function harvestMatching(table) {
    const field = table.querySelector('#matching_table_input input[type="text"]');
    if (!field || !field.value) return null;
    try {
        const state = (JSON.parse(field.value) || {}).answer;
        if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
        const places = Object.keys(state).filter(place => (state[place] || []).length);
        if (!places.length) return null;
        return { answer: state, filled: places.length };
    } catch (error) {
        return null;
    }
}

// ── план заполнения ────────────────────────────────────────────────────────
// Возвращает {mode, steps, matched, total}. step — это контролы плюс ответ
// именно для них.
// Текст, который стоит на странице ПЕРЕД заданием. В заданиях «прочитайте
// публикацию и ответьте» сама публикация лежит отдельным блоком ВЫШЕ, вне
// задания: в самом задании остаётся один и тот же вопрос, и четыре таких
// задания на странице неразличимы. Берём ближайший предыдущий блок — обычно
// это и есть публикация, — и останавливаемся на границе предыдущего задания.
function precedingText(block, limit) {
    let node = block;
    while (node && node.parentElement) {
        const parts = [];
        let length = 0;
        let prev = node.previousElementSibling;
        while (prev) {
            // предыдущее задание — граница: его публикация к этому не относится
            if (prev.querySelector('div.problems-wrapper')) break;
            const text = normalizeText(prev.innerText);
            if (text) {
                parts.unshift(text);
                length += text.length;
            }
            prev = prev.previousElementSibling;
        }
        // Дальние блоки отбрасываем: ближний важнее, а длинный хвост
        // страницы только добавляет поводов найтись чужому вопросу.
        while (length > limit && parts.length > 1) {
            length -= parts.shift().length;
        }
        if (parts.length) return parts.join(' ');
        node = node.parentElement;
    }
    return '';
}

function planFor(block, answersData) {
    const body = bodyOf(block);

    // Кроссворд проверяем первым: в нём под сотню полей ввода, и общая
    // логика «ответ по числу полей» разложила бы один ответ по всем клеткам.
    if (isCrossword(body)) return crosswordPlan(block, body, answersData);

    // Таблица на сопоставление: ответ — не текст, а раскладка карточек по
    // ячейкам, общей логикой его не разложить.
    if (isMatching(body)) return matchingPlan(block, body, answersData);

    const blockText = normalizeText(body.innerText);
    let blockMatch = matchQuestion(blockText, answersData);
    let weak = false;

    // Если в самом задании ничего не нашлось, пробуем вместе с тем, что
    // написано выше: вопрос может быть один на несколько заданий, а
    // различает их только публикация перед каждым. Такое совпадение слабее
    // обычного, поэтому о нём сообщаем в подсказке к значку.
    if (!blockMatch.data) {
        const context = precedingText(block, 3000);
        if (context) {
            blockMatch = matchQuestion(`${context} ${blockText}`, answersData);
            weak = !!blockMatch.data;
        }
    }

    const groups = buildGroups(body);

    // 1. Ответ-список ровно по числу контролов — это задание на соответствие
    //    или таблица с полями: значения раскладываются по порядку, как раньше.
    const positional = positionalTarget(body);
    const answer = blockMatch.data ? blockMatch.data.answer : null;
    if (Array.isArray(answer) && positional
        && answer.length === positional.elements.length) {
        return {
            mode: 'positional',
            steps: [{ kind: positional.kind, elements: positional.elements, answer }],
            matched: 1, total: 1, weak
        };
    }

    // 2. В блоке один вопрос — ищем ответ по всему блоку, как раньше.
    if (groups.length <= 1) {
        if (!blockMatch.data) return { mode: 'single', steps: [], matched: 0, total: 1 };
        const group = groups[0] || { kind: positional ? positional.kind : null,
                                     elements: positional ? positional.elements : [] };
        if (!group.kind) return { mode: 'single', steps: [], matched: 0, total: 1 };
        return {
            mode: 'single',
            steps: [{ kind: group.kind, elements: group.elements, answer: blockMatch.data.answer }],
            matched: 1, total: 1, weak
        };
    }

    // 3. В одном блоке несколько разных вопросов (например, пять выпадающих
    //    списков с подписями). Одному ответу тут взяться неоткуда — ищем
    //    свой ответ для каждого вопроса отдельно.
    const steps = [];
    groups.forEach(group => {
        const found = matchGroup(body, group, answersData);
        if (found.data) {
            steps.push({ kind: group.kind, elements: group.elements, answer: found.data.answer });
        }
    });
    // weak тут ни при чём: в этом режиме каждый вопрос ищется по своей
    // подписи, а не по всему блоку.
    return { mode: 'groups', steps, matched: steps.length, total: groups.length };
}

function matchGroup(body, group, answersData) {
    const candidates = [];
    // У селектов и полей ввода подпись — это текст самого вопроса.
    if (group.kind === 'select' || group.kind === 'text') {
        const label = labelOf(body, group.elements[0]);
        if (label) candidates.push(label);
    }
    // У радио и чекбоксов вопрос стоит абзацем выше списка вариантов.
    const stem = stemBefore(body, group.elements[0]);
    if (stem) candidates.push(stem);

    let best = { score: 0, data: null };
    candidates.forEach(candidate => {
        const found = matchQuestion(normalizeText(candidate), answersData);
        if (found.score > best.score) best = found;
    });
    return best;
}

// ── заполнение ─────────────────────────────────────────────────────────────
function setInputValue(input, value) {
    const nativeInputValueSetter =
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeInputValueSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

function setSelectValue(select, wanted) {
    const needle = normalizeText(wanted);
    if (!needle) return;
    const options = Array.from(select.options);
    // Сначала точное совпадение и только потом вхождение: короткий ответ
    // вроде «3» иначе прилипает к чужому варианту («13», «30»).
    const target = options.find(o => normalizeText(o.text) === needle)
        || options.find(o => normalizeText(o.text).includes(needle));
    if (!target) return;
    select.value = target.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
}

function setTextInputs(inputs, answer) {
    if (Array.isArray(answer)) {
        inputs.forEach((input, index) => {
            if (answer[index] !== undefined && answer[index] !== null && answer[index] !== '') {
                setInputValue(input, answer[index]);
            }
        });
    } else if (typeof answer === 'string') {
        inputs.forEach(input => setInputValue(input, answer));
    }
}

// В кроссворде у каждой клетки своя буква, а не один ответ на все поля.
function setCrosswordLetters(inputs, word) {
    inputs.forEach((input, index) => {
        if (index < word.length) setInputValue(input, word[index]);
    });
}

function setChoiceInputs(body, inputs, answer) {
    const wanted = (Array.isArray(answer) ? answer : [answer]).map(normalizeText).filter(Boolean);
    if (!wanted.length) return;
    const labelled = inputs.map(input => ({ input, text: normalizeText(labelOf(body, input)) }));
    // Точные совпадения имеют приоритет над вхождением: иначе короткий
    // ответ («2», «отказ») подстроками цепляет лишние варианты.
    let chosen = labelled.filter(l => wanted.includes(l.text));
    if (chosen.length === 0) {
        chosen = labelled.filter(l => wanted.some(w => l.text.includes(w)));
    }
    const hit = new Set(chosen.map(l => l.input));
    inputs.forEach(input => {
        if (hit.has(input)) {
            if (!input.checked) input.click();
        } else if (input.checked && input.type === 'checkbox') {
            // в вопросе с несколькими верными вариантами лишнее надо снять
            input.click();
        }
    });
}

// Раскладываем карточки по ячейкам и повторяем то, что виджет делает сам при
// перетаскивании (его setAnswer): собираем состояние из DOM, пишем его в
// скрытое поле и снимаем блокировку с кнопки «Отправить».
function setMatchingTable(body, step) {
    step.items.forEach(item => step.target.appendChild(item));
    const table = step.target.closest('div.matching_table') || matchingTable(body);
    if (table) syncMatchingState(body, table);
}

function syncMatchingState(body, table) {
    const state = {};
    Array.from(table.querySelectorAll('.input-place.conf-answers-place')).forEach(place => {
        state[place.id] = Array.from(place.querySelectorAll('.conf-item.conf-draggable'))
            .map(item => item.id);
    });
    const field = table.querySelector('#matching_table_input input[type="text"]');
    if (field) {
        field.value = JSON.stringify({ answer: state });
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const wrapper = (table.closest('div.problems-wrapper') || body);
    const submit = wrapper ? wrapper.querySelector('button.submit') : null;
    if (submit) {
        submit.classList.remove('is-disabled');
        submit.disabled = false;
    }
}

function applyStep(body, step) {
    if (!step) return;
    if (step.kind === 'matching') { setMatchingTable(body, step); return; }
    if (!step.elements.length) return;
    if (step.kind === 'text') setTextInputs(step.elements, step.answer);
    else if (step.kind === 'crossword') setCrosswordLetters(step.elements, step.answer);
    else if (step.kind === 'select') step.elements.forEach(select => setSelectValue(select, step.answer));
    else setChoiceInputs(body, step.elements, step.answer);
}

function applyPlan(block, plan) {
    const body = bodyOf(block);
    plan.steps.forEach(step => applyStep(body, step));
}

// ── основной проход ────────────────────────────────────────────────────────
async function processQuestions() {
    try {
        const response = await fetch(chrome.runtime.getURL('answers.json'));
        if (!response.ok) { console.error("❌ Ошибка: не удалось загрузить файл answers.json."); return; }
        const answersData = await response.json();
        const problemBlocks = document.querySelectorAll('div.problems-wrapper');

        if (problemBlocks.length === 0) return;

        problemBlocks.forEach((block) => {
            if (block.dataset.helperProcessed) return;
            block.dataset.helperProcessed = 'true';
            const questionHeader = block.querySelector('h3.problem-header');
            const questionBody = block.querySelector('div.problem');
            if (!questionHeader || !questionBody) return;

            const plan = planFor(block, answersData);

            const icon = document.createElement('span');
            icon.style.cursor = 'pointer';
            icon.style.marginLeft = '10px';
            icon.style.fontSize = '20px';
            const conflicts = plan.conflicts || [];
            if (conflicts.length) {
                // В базе слова не сходятся на пересечении — платформа такую
                // клетку не примет, поэтому об этом надо сказать громко.
                icon.textContent = '⚠️';
                icon.title = 'Слова в базе не сходятся на пересечении: '
                    + conflicts.slice(0, 3).map(c => `клетка ${c.cell} — «${c.было}» и «${c.стало}»`)
                        .join('; ')
                    + '. Нажмите, чтобы всё равно вставить.';
                icon.addEventListener('click', () => applyPlan(block, plan));
            } else if (plan.matched > 0 && plan.matched === plan.total) {
                icon.textContent = '✅';
                icon.title = plan.weak
                    ? 'Ответ найден по тексту ВЫШЕ задания (например, по публикации перед ним) — '
                        + 'сверьте глазами. Нажмите, чтобы вставить.'
                    : 'Нажмите, чтобы вставить ответ';
                icon.addEventListener('click', () => applyPlan(block, plan));
            } else if (plan.matched > 0) {
                // В блоке несколько вопросов, и часть из них в базе не нашлась.
                // Молча делать вид, что всё в порядке, нельзя.
                icon.textContent = '🟡';
                icon.title = `В базе нашлось ${plan.matched} из ${plan.total} вопросов блока. `
                    + 'Нажмите, чтобы вставить найденные.';
                icon.addEventListener('click', () => applyPlan(block, plan));
            } else {
                icon.textContent = '❌';
                icon.title = 'Ответ не найден в базе';
            }
            questionHeader.appendChild(icon);

            // Задание, которого нет в базе, но которое уже решено на
            // странице: решение можно забрать готовым, не разбирая его
            // заново вручную.
            let record = null;
            if (plan.mode === 'crossword') {
                const harvest = harvestCrossword(questionBody);
                if (harvest.filled === harvest.total && harvest.total > 0) {
                    record = {
                        question: crosswordSignature(questionBody),
                        problem_id: block.dataset.problemId || '',
                        answer: harvest.words
                    };
                }
            } else if (plan.mode === 'matching') {
                const harvest = harvestMatching(matchingTable(questionBody));
                if (harvest) {
                    record = {
                        type: 'matching',
                        question: matchingSignature(matchingTable(questionBody)),
                        problem_id: block.dataset.problemId || '',
                        answer: harvest.answer
                    };
                }
            }
            if (record && plan.matched < plan.total) {
                const copy = document.createElement('span');
                copy.textContent = '📋';
                copy.style.cursor = 'pointer';
                copy.style.marginLeft = '6px';
                copy.style.fontSize = '20px';
                copy.title = 'Скопировать решение этого задания со страницы в формате базы '
                    + '(вставить в answers.json)';
                copy.addEventListener('click', () => {
                    const text = JSON.stringify([record], null, 2);
                    console.log('📋 Запись для answers.json:\n' + text);
                    if (navigator.clipboard) navigator.clipboard.writeText(text);
                    copy.textContent = '📋✅';
                });
                questionHeader.appendChild(copy);
            }
        });
    } catch (error) {
        console.error("❌ Критическая ошибка в processQuestions:", error);
    }
}

const callback = function(mutationsList, observer) {
    if (document.querySelector('div.problems-wrapper')) {
        processQuestions();
    }
};
const observer = new MutationObserver(callback);
observer.observe(document.body, { childList: true, subtree: true });
setTimeout(processQuestions, 1000);
