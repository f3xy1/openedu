// Общие правила сравнения текста. Это зеркало qa_norm.py — то же самое правило
// записано дважды, потому что браузер и скрипты не могут делить код. Чтобы
// копии не разъехались (именно это когда-то породило дубликаты в базе),
// совпадение реализаций проверяет tests/test_norm_parity.py: он гоняет обе
// версии по одной таблице случаев и требует одинакового ответа.
//
// Файл подключается в manifest.json ПЕРЕД content.js и делит с ним область
// видимости — объявлять те же константы в content.js нельзя. В popup.html он
// подключён так же — перед popup.js, поэтому окно расширения считает ключ
// записи ровно той же функцией keyText(), что и страница курса.
//
// Три формы текста, и разница между ними принципиальна:
//
//     normalizeText(t) — привести к одному виду (регистр, пробелы, формулы)
//     keyText(t)       — normalizeText + снять всю пунктуацию
//     solidText(t)     — keyText без пробелов
//
// keyText() используется там, где данные УДАЛЯЮТ: границы слов в ней
// сохранены, поэтому случайно слить два разных вопроса труднее. solidText() —
// там, где ничего не удаляют, только ищут внутри текста страницы.

// Все дефисы и тире: ASCII-дефис, типографские, неразрывный, минус.
// Записаны кодами, а не символами, — чтобы в файле не завелось невидимых знаков.
const DASH_CHARS = '-‐‑‒–—―−';

// ВАЖНО ПРО \p{L}: в JavaScript \w и \W — только ASCII. Запись (?<=\w) на
// кириллице не сработает вообще, а [^\W\d_] срежет все русские буквы как
// «не-буквы». Там, где в qa_norm.py стоит \w или [^\W\d_], здесь обязаны
// стоять \p{L}/\p{N} с флагом u.
const SOFT_HYPHEN_RE = new RegExp(`(?<=\\p{L})[${DASH_CHARS}](?=\\p{L})`, 'gu');
const DASH_RE = new RegExp(`[${DASH_CHARS}]`, 'g');

// Кавычки. Платформа рисует их так, как решит виджет, а база пришла из docx
// со своими. Сводим оба класса к ASCII — это ОБРАТИМО, в отличие от удаления
// кавычек: удаление слишком сильное правило и на коротких вопросах начинает
// склеивать разное.
// ‹ › (одиночные угловые) отнесены к двойным намеренно: в русском тексте они
// заменяют «ёлочки», и сведение к одному символу помогает им совпасть.
const QUOTE_DOUBLE_RE = /["«»“”„‟‹›″]/g;
const QUOTE_SINGLE_RE = /['‘’‚‛′`´]/g;

// Пробелы и «пустые» значки, которыми платформа размечает поля ввода.
const SPACE_RE = /[\s⬜⬛⚪⚫]+/g;
// Вся пунктуация — снимается в keyText. Эквивалент [^\w\s] из Python, но по
// юникодным правилам: \p{L}\p{N}_ вместо ASCII-шного \w.
const PUNCT_RE = /[^\p{L}\p{N}_\s]/gu;

// ── формулы ────────────────────────────────────────────────────────────────
// Вопрос может частично (или целиком) состоять из формул. На странице их
// рисует MathJax, в базе они записаны как LaTeX — и то же выражение выглядит
// по-разному: другие разделители, другой шум оформления. Правила применяются
// СТРОГО по порядку: сначала то, что содержит аргумент в фигурных скобках,
// потом одиночные команды.

// \frac{a}{b} -> (a)/(b). Раньше остальных: без этого шага фигурные скобки
// снимутся и от «\frac{1}{2}» останется «12» — ложное совпадение с числом 12.
const MATH_FRAC_RE = /\\[dtc]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g;
// \sqrt{x} -> √(x)
const MATH_SQRT_RE = /\\sqrt\s*\{([^{}]*)\}/g;
// \text{...}, \mathrm{...} и родня: команда снимается, содержимое остаётся.
const MATH_WRAP_RE = /\\(?:text|textrm|textnormal|mathrm|mathbf|mathit|mathsf|mathtt|mathbb|mathcal|operatorname|mbox)\*?\s*\{([^{}]*)\}/g;
// Команды с аргументом, который не несёт смысла: \hspace{1cm} и подобные.
const MATH_DROP_ARG_RE = /\\(?:hspace|vspace|phantom|mathstrut|rule)\*?\s*\{[^{}]*\}/g;
// Шум оформления — снимается совсем.
const MATH_NOISE_RE = /\\(?:left|right|bigl|bigr|Bigl|Bigr|biggl|biggr|Biggl|Biggr|big|Big|bigg|Bigg|quad|qquad|displaystyle|textstyle|scriptstyle|limits|nolimits|rm|bf|it|sf|tt)(?![A-Za-z])/g;
// \, \; \: \! — тонкие пробелы и отрицательный пробел.
const MATH_THIN_RE = /\\[,;:!]/g;
// Разделители формул: $$...$$ и $...$.
// Одиночный $ НЕ трогаем, и это важно: в базе есть настоящие цены
// («до $63 за баррель»), где $ ровно один. Пару считаем только если второй $
// близко и без перевода строки — тогда это действительно формула.
const MATH_DOLLAR_RE = /\$\$([^$\n]{1,400})\$\$|\$([^$\n]{1,120})\$/g;
// Остатки команд и одинокие бэкслеши.
const MATH_CMD_RE = /\\[A-Za-z]+/g;
const MATH_SLASH_RE = /\\/g;
// { } — после разбора \frac и родни они уже не нужны.
const MATH_BRACES_RE = /[{}]/g;
// Подстрочный/надстрочный знак: Fe_3O_4 -> Fe3O4, x^2 -> x2.
// Только между буквой/цифрой с обеих сторон! Безусловное удаление «_» сломало
// бы 51 вопрос базы, где подчёркивания — это ПРОПУСКИ в тексте:
// «из расчета ___ душевых сеток» превратилось бы в «из расчета душевых сеток»
// и перестало отличаться от соседнего вопроса с другим числом пропусков.
const MATH_SUBSUP_RE = /(?<=[\p{L}\p{N}])\s*[_^]\s*(?=[\p{L}\p{N}])/gu;

// Именованные символы LaTeX -> юникод. Ключи отсортированы по длине, чтобы
// «\leq» не разобралось как «\le» + «q»; на всякий случай у каждой команды
// ещё и запрет на букву следом.
const MATH_SYMBOLS = {
    times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓',
    le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠',
    approx: '≈', equiv: '≡', sim: '∼', propto: '∝',
    to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒',
    infty: '∞', sum: '∑', prod: '∏', int: '∫', partial: '∂',
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', Delta: 'Δ',
    epsilon: 'ε', varepsilon: 'ε', theta: 'θ', lambda: 'λ',
    mu: 'μ', nu: 'ν', pi: 'π', rho: 'ρ', sigma: 'σ', Sigma: 'Σ',
    tau: 'τ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ',
    omega: 'ω', Omega: 'Ω',
    in: '∈', notin: '∉', subset: '⊂', supset: '⊃', cup: '∪',
    cap: '∩', forall: '∀', exists: '∃', emptyset: '∅',
    angle: '∠', degree: '°', circ: '°', prime: '′'
};
const MATH_SYMBOL_RE = new RegExp(
    '(' + Object.keys(MATH_SYMBOLS).sort((a, b) => b.length - a.length)
        .map(name => '\\\\' + name).join('|') + ')(?![A-Za-z])', 'g');

// MathJax отдаёт в innerText математические курсивные глифы из блока
// U+1D400–U+1D7FF (𝐹, 𝑒, 𝑥 …), и обычный toLowerCase() их не трогает вообще:
// '𝐹𝑒'.toLowerCase() — это по-прежнему '𝐹𝑒'. NFKC переводит их в ASCII.
// Заодно он приводит «…» к '...', «²» к «2», «№» к «No» и неразрывный пробел
// к обычному. Кириллицу NFKC не затрагивает.
function nfkc(text) {
    return text.normalize('NFKC');
}

function foldMath(t) {
    // Разделители формул \( \) \[ \], затем парные доллары.
    t = t.replace(/\\\(/g, ' ').replace(/\\\)/g, ' ')
         .replace(/\\\[/g, ' ').replace(/\\\]/g, ' ');
    t = t.replace(MATH_DOLLAR_RE, (_m, double, single) => ` ${double || single} `);
    // Команды с аргументом — до одиночных команд.
    t = t.replace(MATH_DROP_ARG_RE, ' ')
         .replace(MATH_FRAC_RE, '($1)/($2)')
         .replace(MATH_SQRT_RE, '√($1)')
         .replace(MATH_WRAP_RE, '$1');
    t = t.replace(MATH_SYMBOL_RE, (_m, name) => MATH_SYMBOLS[name.slice(1)]);
    t = t.replace(MATH_NOISE_RE, ' ')
         .replace(MATH_THIN_RE, ' ')
         .replace(MATH_BRACES_RE, '')
         .replace(MATH_SUBSUP_RE, '');
    // Что осталось от команд — в пробел, чтобы «\fooбар» не склеилось в слово.
    return t.replace(MATH_CMD_RE, ' ').replace(MATH_SLASH_RE, ' ');
}

// Платформа рвёт длинные слова по ширине окна и вставляет дефис: «сообще-ния».
// Ширина окна у каждого своя, поэтому одно и то же слово может оказаться с
// дефисом и без — дефис между двумя буквами считаем мягким переносом.
function foldText(text) {
    if (text === undefined || text === null) return '';
    let t = nfkc(String(text));
    t = t.replace(SOFT_HYPHEN_RE, '');
    t = t.replace(DASH_RE, '-');
    t = t.replace(QUOTE_DOUBLE_RE, '"').replace(QUOTE_SINGLE_RE, "'");
    return foldMath(t);
}

// Главная функция сравнения: fold + один вид пробелов + нижний регистр.
function normalizeText(text) {
    if (typeof text !== 'string' || !text) return '';
    return foldText(text).replace(SPACE_RE, ' ').trim().toLowerCase();
}

// То же, но без приведения к нижнему регистру: так текст остаётся читаемым,
// когда уходит в базу.
function cleanText(text) {
    if (text === undefined || text === null) return '';
    return String(text).replace(/\s+/g, ' ').trim();
}

// Ключ вопроса: normalizeText без пунктуации. Склеивает записи, которые
// отличаются только кавычками, тире или разметкой формулы. Пробелы СОХРАНЕНЫ:
// границы слов нужны, иначе «а б в» и «абв» стали бы одним ключом.
function keyText(text) {
    return normalizeText(text).replace(PUNCT_RE, ' ').replace(SPACE_RE, ' ').trim();
}

// То же, что keyText, но без пробелов — для поиска вопроса внутри текста
// страницы. Убирает чувствительность к тому, как вёрстка разбила вопрос на
// строки.
function solidText(text) {
    return keyText(text).replace(/ /g, '');
}

// Короче этого solidText() не применяем — слишком велик шанс случайного
// вхождения в чужой текст.
const SOLID_MIN_LEN = 12;

function solidUsable(text) {
    return solidText(text).length >= SOLID_MIN_LEN;
}

// Экспорт для теста паритета (tests/test_norm_parity.py запускает этот файл
// через node). В браузере module нет, и эта ветка просто не выполняется.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { foldText, normalizeText, cleanText, keyText, solidText,
                       solidUsable, SOLID_MIN_LEN };
}
