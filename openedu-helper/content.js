// Версия видна в консоли страницы и доступна отладчику: по ней легко
// убедиться, что на вкладке работает именно этот файл, а не старый.
const SCRIPT_VERSION = 'v7.4';
console.log(`🚀 Openedu Helper ${SCRIPT_VERSION} ЗАПУЩЕН!`);

// Правила сравнения текста (нормализация, кавычки, формулы, ключи) живут в
// normalize.js: он подключается в manifest.json ПЕРЕД content.js и делит с ним
// область видимости. Объявлять здесь те же имена нельзя — будет «Identifier
// has already been declared», — поэтому своих копий normalizeText и cleanText
// тут больше нет. Копии были, и именно их расхождение с питоновскими
// скриптами порождало дубликаты в базе.
//
// Отсюда доступны: normalizeText, cleanText, keyText, solidText, solidUsable,
// SOLID_MIN_LEN, foldText.

// ── формы текста ───────────────────────────────────────────────────────────
// Текст страницы прогоняется через нормализацию ОДИН раз на блок, а не по
// разу на каждую запись базы: normalizeText делает NFKC и десяток регулярок,
// и на 708 записях это стало бы заметно на каждой перерисовке.
//
// key — с пробелами (пунктуация снята, кавычки сведены, формулы свёрнуты);
// solid — то же без пробелов, чтобы не мешала вёрстка, разбившая вопрос по
// строкам. Сначала пробуем key: она консервативнее, случайных вхождений в ней
// меньше. solid — вторая попытка для тех же данных.
function textForms(raw) {
    return { key: keyText(raw), solid: solidText(raw) };
}

// ── поиск вопроса в базе ───────────────────────────────────────────────────
// Возвращает {score, data}. Сравниваются не строки как есть, а КЛЮЧИ вопроса
// (keyText/solidText из normalize.js): кавычки, тире и разметка формул на ключ
// не влияют. Поэтому вопрос с «ёлочками» находится в базе, где кавычки
// обычные, а вопрос с формулой — в базе, где она записана LaTeX-ом. Раньше
// сравнивались строки как есть, и на этом всё и рвалось: задание получало
// крестик.
//
// Сначала сравниваем по ключу с пробелами (он консервативнее), и только потом
// по слитному: тот не чувствителен к тому, как вёрстка разбила вопрос по
// строкам, но и лишнее находит легче — поэтому он второй.
function bestByQuestion(forms, records, index) {
    let best = { score: 0, data: null };
    if (!forms.key) return best;
    records.forEach(item => {
        const score = questionScore(forms, indexEntry(index, item));
        if (score > best.score) best = { score, data: item };
    });
    return best;
}

// Сколько знаков вопроса нашлось на странице. У составного вопроса ('...')
// обязаны найтись ВСЕ части: иначе под одним и тем же текстом может оказаться
// ситуация, к которой этот ответ не относится.
function questionScore(forms, entry) {
    if (entry.parts) {
        let score = 0;
        for (const part of entry.parts) {
            const hit = partHit(forms, part.key, part.solid);
            if (!hit) return 0;
            score += hit;
        }
        return score;
    }
    return partHit(forms, entry.key, entry.solid);
}

function partHit(forms, key, solid) {
    if (key && forms.key.includes(key)) return key.length;
    if (solid.length >= SOLID_MIN_LEN && forms.solid.includes(solid)) return solid.length;
    return 0;
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

// ── индекс базы ────────────────────────────────────────────────────────────
// Нормализованный вопрос и множество его слов считаются ОДИН раз на всю базу,
// а не на каждую перерисовку: normalizeText — это NFKC и десяток регулярок, и
// на 708 записях это стало бы заметно. Кэш сбрасывается по счётчику правок:
// снятые со страницы записи дописываются в тот же массив.
let baseVersion = 0;
let indexCache = null;

function baseIndex(answersData) {
    if (indexCache && indexCache.version === baseVersion
        && indexCache.data === answersData) {
        return indexCache;
    }
    const byName = new Map();
    // id задания — это id БЛОКА, а не вопроса: у задания из пяти выпадающих
    // списков все пять записей делят один id. Поэтому значение — список.
    const byId = new Map();
    answersData.forEach(item => {
        byName.set(item, makeEntry(item));
        const id = item.problem_id;
        if (!id) return;
        if (!byId.has(id)) byId.set(id, []);
        byId.get(id).push(item);
    });
    indexCache = { version: baseVersion, data: answersData, byName, byId };
    return indexCache;
}

// Запись индекса по записи базы. Записи, которой в индексе ещё нет (её сняли
// со страницы уже после сборки), считаем на месте и запоминаем.
function indexEntry(index, item) {
    let entry = index.byName.get(item);
    if (!entry) {
        entry = makeEntry(item);
        index.byName.set(item, entry);
    }
    return entry;
}

function makeEntry(item) {
    const question = item ? item.question : '';
    const key = keyText(question);
    return {
        item,
        key,
        solid: solidText(question),
        words: new Set(wordsOf(key)),
        parts: questionParts(question)
    };
}

// Составной вопрос: в базе он склеен из кусков через '...' (ситуационные
// задачи). Резать надо ДО снятия пунктуации — keyText превращает точки в
// пробелы и разделитель пропадает.
// Пустые куски выбрасываем: у записи, которая ЗАКАНЧИВАЕТСЯ на '...', split
// даёт пустую строку, а пустая строка находится в любом тексте — из-за этого
// такая запись совпадала с КАЖДЫМ заданием на странице.
function questionParts(question) {
    const folded = normalizeText(question);
    if (!folded.includes('...')) return null;
    const parts = folded.split('...').map(part => part.trim()).filter(Boolean);
    if (!parts.length) return null;
    return parts.map(part => ({ key: keyText(part), solid: solidText(part) }));
}

function wordsOf(text) {
    return String(text).split(' ').filter(Boolean);
}

// ── примерный поиск ────────────────────────────────────────────────────────
// Врезается ТОЛЬКО если точный проход не нашёл ничего, то есть ровно там, где
// раньше стоял крестик.
//
// Одного порога похожести мало, и это главное ограничение всей затеи: в базе
// есть пары РАЗНЫХ вопросов, отличающихся одним знаком («сомкнутый строй —
// это» и «разомкнутый строй — это» — это 0.75 похожести по словам). Поэтому
// у приёмки три условия: порог, обязательный ОТРЫВ от второго кандидата и
// вето по вариантам ответа. Плюс подстановка идёт только по клику и
// показывается отдельным значком — неточное совпадение не должно спрятаться
// за зелёной галочкой.
const APPROX_MIN_SIM = 0.90;
const APPROX_MIN_MARGIN = 0.03;
const APPROX_SHORTLIST = 5;
// Длиннее этого текст в примерное сравнение не берём: вопрос столько места
// всё равно не занимает, а расстояние стоит O(длина вопроса × длина текста).
const APPROX_MAX_TEXT = 20000;

function maxDistanceFor(needle) {
    return Math.max(4, Math.round(0.10 * needle.length));
}

// Мера Dice по множествам слов — ТОЛЬКО отбор кандидатов для дорогого
// расстояния, не приёмка. Слова вопроса считаются один раз (в индексе), слова
// блока — один раз на блок.
function diceCoefficient(questionWords, blockWords) {
    if (!questionWords.size || !blockWords.size) return 0;
    let shared = 0;
    questionWords.forEach(word => { if (blockWords.has(word)) shared += 1; });
    return 2 * shared / (questionWords.size + blockWords.size);
}

// Расстояние Левенштейна между вопросом (needle) и ЛУЧШИМ ЕГО ВХОЖДЕНИЕМ в
// текст (haystack). Обычное расстояние здесь бесполезно: между вопросом на
// 100 знаков и блоком на 2000 знаков оно будет огромным даже при полном
// совпадении. Поэтому начало и конец совпадения в тексте свободны: нулевая
// строка матрицы обнулена, ответ — минимум по последней строке.
//
// Свободны, но НЕ ГДЕ УГОДНО: и начало, и конец обязаны попадать на границу
// слова. Без этого ограничения вопрос ложится внутрь чужого слова — «сомкнутый
// строй это» почти идеально совпадает с серединой «разомкнутый строй это»
// (лишняя «с» в начале), и разные вопросы начинают выглядеть как один.
// Границы в тексте — это пробелы: keyText уже превратил в пробелы всю
// пунктуацию и схлопнул их, других разделителей в тексте не бывает.
//
// Обрыв по maxDist: минимум по строке не убывает с ростом i (из выравнивания
// для i знаков всегда получается выравнивание для i-1 не дороже), поэтому
// если строка стала дороже maxDist — считать дальше нечего.
function substringDistance(needle, haystack, maxDist) {
    const n = needle.length;
    const m = haystack.length;
    if (!n) return 0;
    if (!m) return n;
    if (m < n - maxDist) return n;
    const SPACE = 32;
    // Всё, что дороже maxDist, всё равно будет отброшено, поэтому «недостижимо»
    // можно пометить числом чуть больше maxDist — переполнения не будет.
    const unreachable = maxDist + 1;
    let prev = new Int32Array(m + 1);
    let cur = new Int32Array(m + 1);
    for (let j = 0; j <= m; j++) {
        prev[j] = (j === 0 || haystack.charCodeAt(j - 1) === SPACE) ? 0 : unreachable;
    }
    for (let i = 1; i <= n; i++) {
        cur[0] = i;
        const code = needle.charCodeAt(i - 1);
        let rowMin = cur[0];
        for (let j = 1; j <= m; j++) {
            const cost = haystack.charCodeAt(j - 1) === code ? 0 : 1;
            let best = prev[j - 1] + cost;
            const del = prev[j] + 1;
            if (del < best) best = del;
            const ins = cur[j - 1] + 1;
            if (ins < best) best = ins;
            cur[j] = best;
            if (best < rowMin) rowMin = best;
        }
        if (rowMin > maxDist) return rowMin;
        const rotation = prev;
        prev = cur;
        cur = rotation;
    }
    let best = unreachable;
    for (let j = 0; j <= m; j++) {
        if (j !== m && haystack.charCodeAt(j) !== SPACE) continue;
        if (prev[j] < best) best = prev[j];
    }
    return best;
}

function similarityOf(needle, haystack, maxDist) {
    const distance = substringDistance(needle, haystack, maxDist);
    return { distance, sim: 1 - distance / Math.max(needle.length, 1) };
}

// Лучший примерный кандидат по тексту блока.
//   data — запись, прошедшая приёмку, либо null;
//   near — похожие записи, приёмку не прошедшие: их показываем в подсказке,
//          чтобы было видно разницу между «в базе нет» и «в базе есть, но
//          совпадение неоднозначное».
function bestApproximate(forms, records, body, index) {
    if (!forms.key || forms.key.length > APPROX_MAX_TEXT) return { data: null, near: [] };
    const blockWords = new Set(wordsOf(forms.key));

    const shortlist = [];
    records.forEach(item => {
        if (isCrosswordRecord(item) || isMatchingRecord(item)) return;
        const entry = indexEntry(index, item);
        // Составные вопросы ('...') сравниваем только точно: в примерном
        // сравнении их куски склеились бы в текст, которого на странице нет.
        if (entry.parts || !entry.key) return;
        shortlist.push({ entry, dice: diceCoefficient(entry.words, blockWords) });
    });
    shortlist.sort((a, b) => b.dice - a.dice);

    const judged = [];
    shortlist.slice(0, APPROX_SHORTLIST).forEach(candidate => {
        const key = candidate.entry.key;
        const maxDist = maxDistanceFor(key);
        // Считаем с запасом: кандидат, не дотянувший до порога, всё равно
        // должен попасть в список «похожих» и повлиять на отрыв.
        const { distance, sim } = similarityOf(key, forms.key, maxDist * 2 + 4);
        if (distance > maxDist * 2 + 4) return;
        judged.push({ entry: candidate.entry, distance, sim });
    });
    judged.sort((a, b) => b.sim - a.sim);

    const near = judged.slice(0, 3).map(candidate => candidate.entry.item);
    const best = judged[0];
    if (!best) return { data: null, near };
    if (best.sim < APPROX_MIN_SIM || best.distance > maxDistanceFor(best.entry.key)) {
        return { data: null, near };
    }
    if (judged.length > 1 && best.sim - judged[1].sim < APPROX_MIN_MARGIN) {
        // Два кандидата неразличимы — подставлять одного из них нельзя.
        return { data: null, near };
    }
    if (body && !answerFitsBlock(body, best.entry.item.answer)) {
        return { data: null, near };
    }
    return { data: best.entry.item, sim: best.sim, near: [] };
}

// Вето по вариантам ответа: если в задании есть из чего выбирать (радио,
// флажки, выпадающие списки), ответ кандидата обязан среди этих вариантов
// найтись. Ответ, которого в задании нет, — заведомо чужой.
// Вето намеренно узкое: срабатывает, если не нашлось НИ ОДНОГО значения
// ответа, и только когда варианты в задании вообще есть. В задании с полями
// ввода вариантов нет, и там вето не работает.
function answerFitsBlock(body, answer) {
    const choices = choiceTexts(body);
    if (!choices.length) return true;
    const values = (Array.isArray(answer) ? answer : [answer])
        .filter(value => typeof value === 'string')
        .map(normalizeText).filter(Boolean);
    if (!values.length) return true;
    return values.some(value => choices.some(choice => choice === value
        || (value.length >= 3 && choice.includes(value))));
}

function choiceTexts(body) {
    const texts = [];
    body.querySelectorAll('option').forEach(option => {
        const text = normalizeText(option.text);
        if (text) texts.push(text);
    });
    body.querySelectorAll('label').forEach(label => {
        const text = normalizeText(label.innerText);
        if (text) texts.push(text);
    });
    return texts;
}

// Поиск ответа по тексту: сначала точное совпадение, потом примерное.
//   quality — 'exact' (нашлось точно) или 'approx' (нашлось похоже).
function findRecord(forms, records, body, index) {
    const exact = bestByQuestion(forms, records, index);
    if (exact.data) return { data: exact.data, quality: 'exact', near: [] };
    const approx = bestApproximate(forms, records, body, index);
    if (approx.data) {
        return { data: approx.data, quality: 'approx', sim: approx.sim, near: [] };
    }
    return { data: null, quality: null, near: approx.near };
}

// Ближайший вариант ответа по расстоянию. Порог здесь выше, чем при поиске
// вопроса, и отрыв обязателен: там неверное совпадение даёт ❌ или 🟠, а здесь
// — молча подставленный неверный вариант ответа.
const CHOICE_MIN_SIM = 0.92;
const CHOICE_MIN_MARGIN = 0.10;

function closestChoice(options, needle) {
    const scored = options.map(option => {
        const maxDist = Math.max(3, Math.round(0.10 * needle.length));
        const { sim } = similarityOf(needle, normalizeText(option.text), maxDist);
        return { option, sim };
    }).sort((a, b) => b.sim - a.sim);
    const best = scored[0];
    if (!best || best.sim < CHOICE_MIN_SIM) return null;
    if (scored.length > 1 && best.sim - scored[1].sim < CHOICE_MIN_MARGIN) return null;
    return best.option;
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
    const index = baseIndex(answersData);
    const entries = crosswordEntries(body);
    const problemId = block.dataset.problemId || '';
    const crosswordData = answersData.filter(isCrosswordRecord);
    // id задания — ключ, который не зависит от того, как платформа отрисовала
    // подсказки, поэтому он первый. Подпись из подсказок — запасной вариант:
    // она выручит, если курс пересоберут и id поменяются.
    let record = problemId
        ? crosswordData.find(item => item.problem_id === problemId) || null
        : null;
    let quality = record ? 'byId' : null;
    if (!record) {
        record = bestByQuestion(textForms(body.innerText), crosswordData, index).data;
        if (record) quality = 'exact';
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
            cells.forEach((cell, index_) => {
                const key = `${cell.x},${cell.y}`;
                if (!letters.has(key)) {
                    letters.set(key, word[index_]);
                } else if (letters.get(key) !== word[index_]) {
                    conflicts.push({ cell: key, было: letters.get(key), стало: word[index_], слово: number });
                }
            });
        }
    });
    // Приблизительного поиска у кроссворда и таблицы нет: их подпись — это
    // склейка подсказок, и «похожая» подпись означала бы совсем другой
    // кроссворд.
    return { mode: 'crossword', steps, matched: steps.length, total: entries.size,
             conflicts, approx: false, quality: quality ? [quality] : [] };
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
    const index = baseIndex(answersData);
    const table = matchingTable(body);
    const problemId = block.dataset.problemId || '';
    const records = answersData.filter(isMatchingRecord);
    let record = problemId
        ? records.find(item => item.problem_id === problemId) || null
        : null;
    let quality = record ? 'byId' : null;
    // Подпись — запасной вариант на случай пересборки курса: тогда записи
    // придётся перепривязать, но хотя бы одна из них найдётся по тексту.
    if (!record) {
        record = bestByQuestion(textForms(body.innerText), records, index).data;
        if (record) quality = 'exact';
    }
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
    return { mode: 'matching', steps, matched: steps.length, total: places.length || 1,
             missed, approx: false, quality: quality ? [quality] : [] };
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

// ── снятие готового ответа со страницы ─────────────────────────────────────
// Задание, которое пользователь уже решил, но которого нет в базе, можно
// забрать целиком: платформа ответ проверила, значит он верный. Подпись
// берём ТЕМИ ЖЕ кандидатами, которыми пользуется поиск ответа (labelOf и
// stemBefore), иначе запись в базе ни с чем не сойдётся.

// Как платформа оценила ответ. У «неверно» внутри есть «верн», поэтому
// проверка на ошибку идёт первой.
function statusOf(block) {
    const status = block.querySelector('.status');
    if (!status) return 'unknown';
    const classes = String(status.className);
    const text = normalizeText(status.innerText);
    if (classes.includes('incorrect') || /неверн|неправильн|ошибк/.test(text)) return 'wrong';
    if (/частично/.test(text)) return 'partial';
    if (classes.includes('correct') || /верн|правильн|зачт/.test(text)) return 'correct';
    return 'unknown';
}

// Общий текст задания: начало текста самой страницы, обрезанное перед
// первым вариантом ответа. Именно начало, а не «всё, кроме вариантов»:
// подпись обязана остаться куском текста страницы, иначе поиск ответа её
// не найдёт. Варианты платформа перемешивает при каждой отрисовке, поэтому
// в подпись они попадать не должны.
function stemText(body) {
    const text = normalizeText(body.innerText);
    let cut = text.length;
    body.querySelectorAll('label, select, .matching_table').forEach(element => {
        const option = normalizeText(element.innerText);
        const at = option ? text.indexOf(option) : -1;
        if (at > 0 && at < cut) cut = at;
    });
    return text.slice(0, cut).trim();
}

// Что стоит в контролах сейчас. У списков и полей ввода — по значению на
// контрол, у флажков значений может быть несколько.
function groupValues(body, group) {
    if (group.kind === 'select') {
        return group.elements
            .map(select => (select.selectedOptions[0] ? cleanText(select.selectedOptions[0].text) : ''))
            .filter(Boolean);
    }
    if (group.kind === 'text') {
        return group.elements.map(input => input.value.trim()).filter(Boolean);
    }
    return group.elements.filter(input => input.checked)
        .map(input => cleanText(labelOf(body, input))).filter(Boolean);
}

// Записи для базы по тому, что сейчас на странице. Пустой список — задание
// не заполнено (или заполнено так, что забирать нечего).
function harvestRecords(block, body) {
    const problemId = block.dataset.problemId || '';

    // У кроссворда и таблицы на сопоставление ключ — id задания, поэтому
    // запись одна на всё задание.
    const table = matchingTable(body);
    if (table) {
        const harvest = harvestMatching(table);
        if (!harvest) return [];
        return [{ type: 'matching', question: matchingSignature(table),
                  problem_id: problemId, answer: harvest.answer }];
    }
    if (isCrossword(body)) {
        const harvest = harvestCrossword(body);
        if (!harvest.total || harvest.filled !== harvest.total) return [];
        return [{ question: crosswordSignature(body), problem_id: problemId, answer: harvest.words }];
    }

    // Обычное задание: на каждый вопрос своя запись — ровно так их потом и
    // ищет planFor (по подписи контрола либо по абзацу над ним).
    const records = [];
    buildGroups(body).forEach(group => {
        const values = groupValues(body, group);
        if (!values.length) return;
        // Подпись вопроса. У селекта и поля ввода это <label for>, а если
        // платформа его не нарисовала — текст, стоящий прямо перед контролом
        // (в заданиях-таблицах это название строки: «Леонид Парфенов»).
        // Общий текст задания — только последняя запасная догадка: на нём все
        // строки таблицы получают ОДИН И ТОТ ЖЕ вопрос и перестают отличаться
        // друг от друга, а искать их потом надо по своему тексту строки.
        const label = (group.kind === 'select' || group.kind === 'text')
            ? (labelOf(body, group.elements[0]) || stemBefore(body, group.elements[0]))
            : stemBefore(body, group.elements[0]);
        const question = cleanText(label) || stemText(body);
        if (!question) return;
        const answer = values.length === 1 ? values[0] : values;
        // id задания добавляем, когда он есть: слияние по нему различает
        // записи надёжнее, чем по тексту вопроса, да и видно, откуда запись.
        records.push(problemId
            ? { question, problem_id: problemId, answer }
            : { question, answer });
    });
    return records;
}

// Задание заполнено целиком: в каждой группе контролов есть значение.
// Нужно, чтобы 📋 не появлялся у наполовину заполненного задания.
function isFilled(body) {
    const groups = buildGroups(body);
    if (!groups.length) return false;
    return groups.every(group => groupValues(body, group).length > 0);
}

// ── копилка снятых ответов ─────────────────────────────────────────────────
// Снятые со страницы решения копятся в хранилище расширения, а не уходят в
// буфер обмена: из буфера их пришлось бы вставлять в базу руками, а набор
// разом выгружается из окна расширения (клик по его значку на панели) и
// сливается с базой скриптом.
const HARVEST_KEY = 'harvested';

// Ключ записи набора — ТОЛЬКО текст вопроса, тем же правилом, что и ключ
// записи базы (qa_norm.record_key в питоновских скриптах). Раньше в ключ
// входил ещё и ответ, и это был источник дубликатов: тот же вопрос,
// пришедший с другим ответом, считался новой записью — и в наборе, и потом
// в базе оказывались две записи об одном вопросе.
// id задания в ключ НЕ входит: в базе полно записей из docx, где id нет, и то
// же задание, снятое со страницы, обязано считаться тем же самым.
function harvestKey(record) {
    return keyText(String(record.question || ''));
}

// Ответ одной строкой для сравнения: порядок ключей не важен, регистр и
// раскладка внутри ответа — тоже. Это зеркало qa_norm.answer_json.
function answerKey(answer) {
    if (Array.isArray(answer)) {
        return JSON.stringify(answer.map(keyText));
    }
    if (answer && typeof answer === 'object') {
        return JSON.stringify(Object.keys(answer).sort().map(key => [key,
            Array.isArray(answer[key]) ? answer[key].map(keyText) : keyText(answer[key])]));
    }
    return keyText(answer === undefined || answer === null ? '' : answer);
}

function answersEqual(a, b) {
    return answerKey(a) === answerKey(b);
}

// null — хранилище недоступно; пустой список — набор пока пуст.
async function readHarvested() {
    try {
        const stored = await chrome.storage.local.get(HARVEST_KEY);
        const list = stored ? stored[HARVEST_KEY] : null;
        return Array.isArray(list) ? list : [];
    } catch (error) {
        console.error('❌ Набор недоступен:', error);
        return null;
    }
}

// Кладёт записи в набор. Вопрос, который в наборе уже есть, второй раз не
// добавляется; если ответ у него ДРУГОЙ — запись заменяется, побеждает
// свежая. Это то же правило, по которому работает слияние с базой: набор и
// база не должны расходиться в том, какая запись считается верной.
// Возвращает {added, updated, total} либо null при отказе хранилища.
async function saveHarvested(records) {
    const current = await readHarvested();
    if (!current) return null;
    const kept = current.slice();
    const at = new Map();
    kept.forEach((record, index) => {
        const key = harvestKey(record);
        // Указываем на ПОСЛЕДНЮЮ запись с таким вопросом: если в наборе уже
        // завёлся дубликат от прежнего правила, обновлять надо свежий.
        if (key) at.set(key, index);
    });
    const added = [];
    const updated = [];
    records.forEach(record => {
        const key = harvestKey(record);
        if (!key) return;
        // _at и _source — служебные: в базе они не нужны (скрипт слияния их
        // вырезает), а в окне расширения по ним видно, когда и откуда запись.
        const stamped = Object.assign({}, record,
            { _at: new Date().toISOString(), _source: location.href });
        const index = at.get(key);
        if (index === undefined) {
            at.set(key, kept.length);
            kept.push(stamped);
            added.push(stamped);
        } else if (!answersEqual(kept[index].answer, record.answer)) {
            updated.push(kept[index]);
            kept[index] = stamped;
        }
    });
    if (added.length || updated.length) {
        try {
            await chrome.storage.local.set({ [HARVEST_KEY]: kept });
        } catch (error) {
            console.error('❌ Не удалось сохранить набор:', error);
            return null;
        }
    }
    return { added: added.length, updated: updated.length, total: kept.length };
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

    const index = baseIndex(answersData);
    const problemId = block.dataset.problemId || '';
    // «Свои» записи — те, что привязаны к этому заданию по id.
    const own = (problemId && index.byId.get(problemId)) || [];
    const groups = buildGroups(body);
    const forms = textForms(body.innerText);

    let match;
    if (own.length === 1 && groups.length <= 1) {
        // Единственная своя запись и один вопрос в задании: берём её, не
        // глядя на текст. Это единственный способ вытянуть задание,
        // состоящее ЦЕЛИКОМ из формул, — текстом оно не находится ни точно,
        // ни похоже. id от отрисовки не зависит, так что ошибиться негде.
        match = { data: own[0], quality: 'byId', near: [] };
    } else {
        // Свои записи ищутся первыми: id надёжнее текста. Если их нет —
        // сразу вся база: в ней полно записей из docx без id, и они
        // относятся к тем же заданиям.
        match = findRecord(forms, own.length ? own : answersData, body, index);
        if (!match.data && own.length) {
            match = findRecord(forms, answersData, body, index);
        }
    }

    let weak = false;
    let near = match.near || [];

    // Если в самом задании ничего не нашлось, пробуем вместе с тем, что
    // написано выше: вопрос может быть один на несколько заданий, а
    // различает их только публикация перед каждым. Такое совпадение слабее
    // обычного, поэтому о нём сообщаем в подсказке к значку.
    //
    // Здесь только точное сравнение: на тексте в несколько тысяч знаков
    // примерное даёт слишком много поводов найтись чужому вопросу.
    if (!match.data) {
        const context = precedingText(block, 3000);
        if (context) {
            const contextual = bestByQuestion(
                textForms(`${context} ${body.innerText}`), answersData, index);
            if (contextual.data) {
                match = { data: contextual.data, quality: 'exact', near: [] };
                weak = true;
            }
        }
    }

    const quality = match.quality ? [match.quality] : [];
    const approx = quality.includes('approx');
    // Похожесть оставляем в плане: в подсказке к 🟠 «совпадение 0.91» и «0.99» —
    // разные вещи, а по одному значку разницы не видно, и человек не знает,
    // проверять ему каждое слово или можно поверить.
    const sim = approx && typeof match.sim === 'number' ? match.sim : null;
    const empty = (mode, total) => ({ mode, steps: [], matched: 0, total,
                                      approx: false, quality: [], near, sim: null });

    // 1. Ответ-список ровно по числу контролов — это задание на соответствие
    //    или таблица с полями: значения раскладываются по порядку, как раньше.
    const positional = positionalTarget(body);
    const answer = match.data ? match.data.answer : null;
    if (Array.isArray(answer) && positional
        && answer.length === positional.elements.length) {
        return {
            mode: 'positional',
            steps: [{ kind: positional.kind, elements: positional.elements, answer }],
            matched: 1, total: 1, weak, approx, quality, near, sim
        };
    }

    // 2. В блоке один вопрос — ищем ответ по всему блоку, как раньше.
    if (groups.length <= 1) {
        if (!match.data) return empty('single', 1);
        const group = groups[0] || { kind: positional ? positional.kind : null,
                                     elements: positional ? positional.elements : [] };
        if (!group.kind) return empty('single', 1);
        return {
            mode: 'single',
            steps: [{ kind: group.kind, elements: group.elements, answer: match.data.answer }],
            matched: 1, total: 1, weak, approx, quality, near, sim
        };
    }

    // 3. В одном блоке несколько разных вопросов (например, пять выпадающих
    //    списков с подписями). Одному ответу тут взяться неоткуда — ищем
    //    свой ответ для каждого вопроса отдельно.
    const steps = [];
    const qualities = [];
    // Из примерных совпадений в подсказку идёт самое слабое: именно оно решает,
    // стоит ли верить остальным.
    let groupSim = null;
    groups.forEach(group => {
        const found = matchGroup(body, group, answersData, own, index);
        if (found.data) {
            steps.push({ kind: group.kind, elements: group.elements, answer: found.data.answer });
            if (found.quality) qualities.push(found.quality);
            if (found.quality === 'approx' && typeof found.sim === 'number'
                && (groupSim === null || found.sim < groupSim)) {
                groupSim = found.sim;
            }
        }
    });
    // weak тут ни при чём: в этом режиме каждый вопрос ищется по своей
    // подписи, а не по всему блоку.
    return { mode: 'groups', steps, matched: steps.length, total: groups.length,
             approx: qualities.includes('approx'), quality: qualities, near,
             sim: groupSim };
}

// Один вопрос блока. Подпись контрола (у селекта — <label for>, у радио —
// абзац над вариантами) и есть текст вопроса; ищем его среди «своих» записей,
// и лишь потом по всей базе.
function matchGroup(body, group, answersData, own, index) {
    const candidates = [];
    // У селектов и полей ввода подпись — это текст самого вопроса.
    if (group.kind === 'select' || group.kind === 'text') {
        const label = labelOf(body, group.elements[0]);
        if (label) candidates.push(label);
    }
    // У радио и чекбоксов вопрос стоит абзацем выше списка вариантов.
    const stem = stemBefore(body, group.elements[0]);
    if (stem) candidates.push(stem);

    const scopes = own.length ? [own, answersData] : [answersData];
    let best = { data: null, quality: null, near: [] };
    let bestRank = -1;
    let bestScore = 0;
    let near = [];

    candidates.forEach(candidate => {
        const forms = textForms(candidate);
        scopes.forEach((scope, position) => {
            const hit = bestByQuestion(forms, scope, index);
            if (!hit.data) return;
            const rank = position === 0 ? 2 : 1;
            if (rank > bestRank || (rank === bestRank && hit.score > bestScore)) {
                bestRank = rank;
                bestScore = hit.score;
                best = {
                    data: hit.data,
                    quality: position === 0 ? 'byId' : 'exact',
                    near: []
                };
            }
        });
        if (bestRank > 0) return;
        // Точного совпадения не нашлось ни в одном из кругов — пробуем
        // примерное. Только по всей базе: «свои» записи для этого задания
        // уже просмотрены выше.
        const approx = bestApproximate(forms, answersData, body, index);
        if (approx.data) {
            if (bestRank < 0 || approx.sim > bestScore) {
                bestRank = 0;
                bestScore = approx.sim;
                best = { data: approx.data, quality: 'approx', sim: approx.sim, near: [] };
            }
        } else if (approx.near.length) {
            near = approx.near;
        }
    });
    return best.data ? best : { data: null, quality: null, near };
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
    // Сначала точное совпадение, потом вхождение и только в конце примерное:
    // короткий ответ вроде «3» иначе прилипает к чужому варианту («13», «30»).
    const target = options.find(o => normalizeText(o.text) === needle)
        || options.find(o => normalizeText(o.text).includes(needle))
        || closestChoice(options, needle);
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
    if (chosen.length === 0) {
        // Не сошлось совсем ничего — пробуем примерное совпадение, по одному
        // варианту на каждый нужный ответ. Порог здесь выше, чем при поиске
        // вопроса: там ошибка даёт ❌ или 🟠, а здесь — молча подставленный
        // неверный вариант ответа.
        const taken = new Set();
        wanted.forEach(w => {
            const found = closestChoice(labelled.filter(l => !taken.has(l.input)), w);
            if (found) taken.add(found.input);
        });
        chosen = labelled.filter(l => taken.has(l.input));
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

// ── значки у заданий ───────────────────────────────────────────────────────
// Платформа перерисовывает задание после каждой проверки: шапка и тело
// заменяются новыми элементами, а наш значок остаётся висеть на оторванном
// узле — поэтому пометки «блок уже обработан» недостаточно, значки надо
// уметь ставить заново.
function makeMark(text, title, margin) {
    const mark = document.createElement('span');
    mark.className = 'helper-mark';
    mark.textContent = text;
    mark.title = title;
    mark.style.cursor = 'pointer';
    mark.style.marginLeft = margin;
    mark.style.fontSize = '20px';
    return mark;
}

// Записать решение задания в набор расширения и в память страницы.
// Возвращает {records, saved}: records — что снято (пусто — снимать нечего),
// saved — итог записи в набор (null, если хранилище не ответило).
// Вынесено из обработчика клика по 📋: тем же кодом собирает набор кнопка
// «забрать все решения» в шапке юнита (nav.js) — копия разошлась бы с
// оригиналом, а правило «побеждает последняя» должно остаться одним на всех.
async function harvestBlock(block, answersData) {
    // Задание могли перерисовать — берём записи заново, с текущего DOM.
    const records = harvestRecords(block, bodyOf(block));
    if (!records.length) return { records, saved: null };
    console.log('📋 Снято со страницы:\n' + JSON.stringify(records, null, 2));
    const saved = await saveHarvested(records);
    // Платформа ответ уже видела, поэтому держим его и в памяти страницы:
    // задание сразу станет «найденным» и значок не откатится к ❌ при
    // следующей перерисовке. В сам файл базы запись попадает только через
    // выгрузку набора — у content-скрипта доступа к файлам нет.
    //
    // Запись с тем же вопросом ЗАМЕНЯЕТСЯ, а не дописывается: правило
    // «побеждает последняя» одинаково в базе, в наборе и здесь.
    records.forEach(record => {
        const key = harvestKey(record);
        const at = answersData.findIndex(item => harvestKey(item) === key);
        if (at === -1) answersData.push(record);
        else answersData[at] = record;
    });
    // Индекс базы построен по прежнему содержимому — пересобираем.
    baseVersion += 1;
    return { records, saved };
}

// Текст подтверждения по итогу записи в набор: одинаковый у значка 📋 и у
// кнопки «забрать все решения» в шапке юнита.
function harvestNote(saved) {
    if (!saved) {
        return { text: '📋❌', title: 'Не удалось записать в набор расширения. Записи '
            + 'напечатаны в консоли (F12) — их можно перенести в базу руками.' };
    }
    if (!saved.added && !saved.updated) {
        return { text: '📋🔁', title: 'Эти записи уже есть в наборе — второй раз не '
            + 'добавлены. Всего в наборе: ' + saved.total + '.' };
    }
    if (!saved.added) {
        return { text: '📋♻️', title: 'Новых вопросов нет, но у ' + saved.updated
            + ' уже известных ответ другой — в наборе они заменены свежими. '
            + 'Всего в наборе: ' + saved.total + '.' };
    }
    return { text: '📋✅', title: 'В набор добавлено записей: ' + saved.added
        + (saved.updated ? ', заменено: ' + saved.updated : '')
        + '. Всего в наборе: ' + saved.total
        + '. Выгрузить его — клик по значку расширения на панели браузера.' };
}

// Можно ли по этому плану нажимать «Отправить». Отправка — единственное
// необратимое действие расширения: платформа запоминает оценку, и вернуть её
// потом нельзя. Поэтому жмём только когда ответ в базе есть ЦЕЛИКОМ и он не
// вызывает сомнений — ни примерного совпадения (🟠: похожий вопрос вполне
// может оказаться другим заданием), ни конфликтов кроссворда (такую клетку
// платформа всё равно не примет).
function submitAllowed(plan) {
    if (!plan || !plan.matched || plan.matched !== plan.total) return false;
    if (plan.approx) return false;
    return !(plan.conflicts || []).length;
}

function harvestMark(block, answersData) {
    const verdict = statusOf(block);
    const about = verdict === 'correct' ? ' Платформа отметила ответ как верный.'
        : verdict === 'wrong' ? ' ВНИМАНИЕ: платформа отметила ответ как НЕВЕРНЫЙ.'
        : verdict === 'partial' ? ' Платформа зачла ответ частично.'
        : ' Платформа ответ ещё не проверяла — сверьте его сами.';
    const mark = makeMark(verdict === 'wrong' ? '📋⚠️' : '📋',
        'Забрать решение этого задания в набор новых ответов. Набор потом '
        + 'выгружается из окна расширения (клик по его значку на панели браузера) '
        + 'и сливается с базой скриптом merge-answers.' + about, '6px');
    mark.addEventListener('click', async () => {
        const { records, saved } = await harvestBlock(block, answersData);
        if (!records.length) return;
        const note = harvestNote(saved);
        mark.textContent = note.text;
        mark.title = note.title;
        // даём увидеть подтверждение и перерисовываем значок: ответ теперь
        // считается найденным, значит на его месте будет ✅
        setTimeout(() => renderMarks(block, answersData), 900);
    });
    return mark;
}

// Короткая подпись записи для подсказки к значку.
function briefQuestion(question) {
    const text = cleanText(question);
    return text.length > 70 ? `${text.slice(0, 69)}…` : text;
}

// Значки, которые должны стоять у задания прямо сейчас. План сюда приходит
// готовым: он посчитан в renderMarks, и там же уходит дальше — в значок
// состояния базы в шапке юнита (nav.js). Считать его второй раз незачем.
function buildMarks(block, body, answersData, plan) {
    // План пересчитывается заново и по клику: пока задание стоит на странице,
    // его контролы могут быть заменены, и ссылки в старом плане протухнут.
    const apply = () => applyPlan(block, planFor(block, answersData));
    const marks = [];
    const conflicts = plan.conflicts || [];
    const near = (plan.near || []).map(item => briefQuestion(item.question));
    const nearby = near.length ? ' Похожие записи: ' + near.join(' | ') + '.' : '';
    const simText = typeof plan.sim === 'number'
        ? ` Похожесть ${plan.sim.toFixed(2)} — чем ближе к 1.00, тем вернее он.` : '';

    if (conflicts.length) {
        // В базе слова не сходятся на пересечении — платформа такую клетку
        // не примет, поэтому об этом надо сказать громко.
        const icon = makeMark('⚠️', 'Слова в базе не сходятся на пересечении: '
            + conflicts.slice(0, 3).map(c => `клетка ${c.cell} — «${c.было}» и «${c.стало}»`).join('; ')
            + '. Нажмите, чтобы всё равно вставить.', '10px');
        icon.addEventListener('click', apply);
        marks.push(icon);
    } else if (plan.matched > 0 && plan.approx) {
        // Совпадение примерное — отдельный значок, чтобы оно не спряталось за
        // зелёной галочкой. Вставляется, как и всё остальное, только по клику.
        const icon = makeMark('🟠', 'ТОЧНОГО совпадения в базе нет, но есть похожая '
            + 'запись — ответ подставлен по ней. Проверьте глазами: похожий вопрос '
            + 'может оказаться совсем другим заданием.' + simText + nearby
            + ' Нажмите, чтобы вставить.', '10px');
        icon.addEventListener('click', apply);
        marks.push(icon);
    } else if (plan.matched > 0 && plan.matched === plan.total) {
        const icon = makeMark('✅', plan.weak
            ? 'Ответ найден по тексту ВЫШЕ задания (например, по публикации перед ним) — '
                + 'сверьте глазами. Нажмите, чтобы вставить.'
            : 'Нажмите, чтобы вставить ответ', '10px');
        icon.addEventListener('click', apply);
        marks.push(icon);
    } else if (plan.matched > 0) {
        // В блоке несколько вопросов, и часть из них в базе не нашлась.
        // Молча делать вид, что всё в порядке, нельзя.
        const icon = makeMark('🟡', `В базе нашлось ${plan.matched} из ${plan.total} вопросов блока. `
            + 'Нажмите, чтобы вставить найденные.', '10px');
        icon.addEventListener('click', apply);
        marks.push(icon);
    } else {
        marks.push(makeMark('❌', 'Ответ не найден в базе'
            + (near.length ? ': ни одна запись не подошла достаточно точно.' : '.')
            + nearby, '10px'));
    }

    // 📋 — забрать решение в набор новых ответов. Ставится последним, справа
    // от значка вердикта: сначала видно, что база думает про это задание,
    // потом — кнопка забрать его себе.
    // Задание должно быть заполнено целиком: половину решения в набор тащить
    // незачем, а у кроссворда и таблицы недозаполненное задание вообще нечего
    // записывать (harvestRecords в этом случае вернёт пусто).
    if (isFilled(body)) marks.push(harvestMark(block, answersData));

    return marks;
}
// Возвращает план задания — он нужен вызывающему (processQuestions отдаёт
// планы в nav.js). У задания без шапки или тела плана нет, и это null.
function renderMarks(block, answersData) {
    const header = block.querySelector('h3.problem-header');
    const body = block.querySelector('div.problem');
    if (!header || !body) return null;

    const plan = planFor(block, answersData);
    const fresh = buildMarks(block, body, answersData, plan);
    const current = Array.from(header.querySelectorAll('span.helper-mark'));
    // Перерисовываем только когда набор значков изменился: страница шумит
    // мутациями постоянно, а наши же вставки — тоже мутации, и без этой
    // проверки мы гоняли бы себя по кругу.
    const same = current.length === fresh.length && current.every((mark, index) =>
        mark.textContent === fresh[index].textContent && mark.title === fresh[index].title);
    if (same) return plan;

    current.forEach(mark => mark.remove());
    fresh.forEach(mark => header.appendChild(mark));
    return plan;
}

// ── основной проход ────────────────────────────────────────────────────────
// База читается один раз и дальше живёт в памяти страницы: снятые со
// страницы решения добавляются прямо в неё.
let answersCache = null;

async function loadAnswers() {
    if (answersCache) return answersCache;
    try {
        const response = await fetch(chrome.runtime.getURL('answers.json'));
        if (!response.ok) {
            console.error('❌ Не удалось загрузить answers.json:', response.status);
            return null;
        }
        answersCache = await response.json();
    } catch (error) {
        console.error('❌ Не удалось загрузить answers.json:', error);
        return null;
    }
    return answersCache;
}

async function processQuestions() {
    try {
        const answersData = await loadAnswers();
        if (!answersData) return;
        const blocks = Array.from(document.querySelectorAll('div.problems-wrapper'));
        const plans = blocks.map(block => renderMarks(block, answersData));
        // Отчитаться перед кнопками в шапке юнита (nav.js). Второй проход по
        // заданиям ради них не нужен: планы уже посчитаны выше.
        notifyNavState(blocks, plans);
    } catch (error) {
        console.error("❌ Критическая ошибка в processQuestions:", error);
    }
}

// Перерисовок на странице много (в том числе наших собственных), поэтому
// отклик на мутации придерживаем: важен итог, а не каждый шаг.
let renderTimer = null;
function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
        renderTimer = null;
        processQuestions();
    }, 250);
}

const callback = function() {
    if (document.querySelector('div.problems-wrapper')) {
        scheduleRender();
    }
};
const observer = new MutationObserver(callback);
observer.observe(document.body, { childList: true, subtree: true });
setTimeout(processQuestions, 1000);
