# -*- coding: utf-8 -*-
"""Общие правила сравнения текста для всех скриптов проекта.

Зачем отдельный модуль: раньше правило нормализации было скопировано в
merge-answers.py, docx_image_answers.py и content.js — и копии разъезжались.
Именно из-за этого в базу попадали дубликаты: один и тот же вопрос с «ёлочками»
и с обычными кавычками давал два разных ключа, и вторая запись считалась новой.

Здесь правило живёт в одном месте. В браузере его зеркало —
opendu-helper/normalize.js; совпадение двух реализаций проверяется тестом
tests/test_norm_parity.py, который гоняет обе по одной таблице случаев.

Три формы текста, и разница между ними принципиальна:

    fold(t)   — привести к одному виду, регистр и пробелы не трогать
    norm(t)   — fold + схлопнуть пробелы + обрезать + нижний регистр
    key(t)    — norm + снять всю пунктуацию (для сравнения вопросов)
    solid(t)  — key без пробелов (для поиска вопроса внутри текста страницы)

key() используется там, где данные УДАЛЯЮТ (дедупликация, слияние): границы
слов в ней сохранены, поэтому случайно слить два разных вопроса труднее.
solid() — там, где ничего не удаляют, только ищут: она нечувствительна к
переносам строк и вёрстке.
"""
import json
import os
import re
import shutil
import sys
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_BASE = os.path.join(HERE, 'opendu-helper', 'answers.json')


# ── тире и переносы ─────────────────────────────────────────────────────────
# Все дефисы и тире: ASCII-дефис, типографские, неразрывный, минус. Записаны
# кодами, а не символами, — чтобы в файле не завелось невидимых знаков.
DASH_CLASS = '\u002d\u2010\u2011\u2012\u2013\u2014\u2015\u2212'
# Буква (но не цифра и не подчёркивание) — то же, что \p{L} в JS.
LETTER = r'[^\W\d_]'

# Платформа рвёт длинные слова по ширине окна и вставляет дефис: «сообще-ния».
# Ширина окна у каждого своя, поэтому одно и то же слово может оказаться с
# дефисом и без — дефис между двумя буквами считаем мягким переносом.
SOFT_HYPHEN_RE = re.compile(rf'(?<={LETTER})[{DASH_CLASS}](?={LETTER})')
DASH_RE = re.compile(f'[{DASH_CLASS}]')


# ── кавычки ─────────────────────────────────────────────────────────────────
# Платформа рисует кавычки так, как решит виджет, а база пришла из docx со
# своими. Сводим оба класса к ASCII — это ОБРАТИМО, в отличие от удаления
# кавычек: удаление слишком сильное правило и на коротких вопросах начинает
# склеивать разное.
# ‹ › (одиночные угловые) отнесены к двойным намеренно: в русском тексте они
# заменяют «ёлочки», и сведение к одному символу помогает им совпасть.
QUOTE_DOUBLE_RE = re.compile('[\u0022\u00ab\u00bb\u201c\u201d\u201e\u201f\u2039\u203a\u2033]')
QUOTE_SINGLE_RE = re.compile('[\u0027\u2018\u2019\u201a\u201b\u2032\u0060\u00b4]')

# Пробелы и «пустые» значки, которыми платформа размечает поля ввода.
SPACE_RE = re.compile(r'[\s\u2b1c\u2b1b\u26aa\u26ab]+')
# Вся пунктуация — снимается в key().
PUNCT_RE = re.compile(r'[^\w\s]', re.UNICODE)


# ── формулы ─────────────────────────────────────────────────────────────────
# Вопрос может частично (или целиком) состоять из формул. На странице их
# рисует MathJax, в базе они записаны как LaTeX — и то же самое выражение
# выглядит по-разному: другие разделители, другие пробелы, \left/\right и
# прочий шум оформления. Ниже набор правил, который приводит оба вида к
# одной строке. Правила применяются СТРОГО по порядку: сначала то, что
# содержит аргумент в фигурных скобках, потом одиночные команды.

# \frac{a}{b} -> (a)/(b). Раньше остальных: без этого шага скобки снимутся
# и от «\frac{1}{2}» останется «12» — ложное совпадение с числом 12.
FRAC_RE = re.compile(r'\\[dtc]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}')

# \sqrt{x} -> √(x)
SQRT_RE = re.compile(r'\\sqrt\s*\{([^{}]*)\}')

# \text{...}, \mathrm{...} и родня: команда снимается, содержимое остаётся.
WRAP_RE = re.compile(r'\\(?:text|textrm|textnormal|mathrm|mathbf|mathit|mathsf'
                     r'|mathtt|mathbb|mathcal|operatorname|mbox)\*?\s*\{([^{}]*)\}')

# Команды с аргументом, который не несёт смысла: \hspace{1cm} и подобные.
DROP_ARG_RE = re.compile(r'\\(?:hspace|vspace|phantom|mathstrut|rule)\*?\s*\{[^{}]*\}')

# Именованные символы LaTeX -> юникод. Ключи отсортированы по длине, чтобы
# «\leq» не разобралось как «\le» + «q»; на всякий случай у каждой команды
# ещё и запрет на букву следом.
MATH_SYMBOLS = {
    'times': '×', 'cdot': '·', 'div': '÷', 'pm': '±', 'mp': '∓',
    'le': '≤', 'leq': '≤', 'ge': '≥', 'geq': '≥', 'ne': '≠', 'neq': '≠',
    'approx': '≈', 'equiv': '≡', 'sim': '∼', 'propto': '∝',
    'to': '→', 'rightarrow': '→', 'leftarrow': '←', 'Rightarrow': '⇒',
    'infty': '∞', 'sum': '∑', 'prod': '∏', 'int': '∫', 'partial': '∂',
    'alpha': 'α', 'beta': 'β', 'gamma': 'γ', 'delta': 'δ', 'Delta': 'Δ',
    'epsilon': 'ε', 'varepsilon': 'ε', 'theta': 'θ', 'lambda': 'λ',
    'mu': 'μ', 'nu': 'ν', 'pi': 'π', 'rho': 'ρ', 'sigma': 'σ', 'Sigma': 'Σ',
    'tau': 'τ', 'phi': 'φ', 'varphi': 'φ', 'chi': 'χ', 'psi': 'ψ',
    'omega': 'ω', 'Omega': 'Ω',
    'in': '∈', 'notin': '∉', 'subset': '⊂', 'supset': '⊃', 'cup': '∪',
    'cap': '∩', 'forall': '∀', 'exists': '∃', 'emptyset': '∅',
    'angle': '∠', 'degree': '°', 'circ': '°', 'prime': '′',
}
_SYMBOLS_RE = re.compile(
    '(' + '|'.join(re.escape(f'\\{k}') for k in
                   sorted(MATH_SYMBOLS, key=len, reverse=True)) + r')(?![A-Za-z])')


def _symbol_repl(match):
    return MATH_SYMBOLS[match.group(1)[1:]]


# Шум оформления — снимается совсем, смысла не несёт.
MATH_NOISE_RE = re.compile(
    r'\\(?:left|right|bigl|bigr|Bigl|Bigr|biggl|biggr|Biggl|Biggr'
    r'|big|Big|bigg|Bigg|quad|qquad|displaystyle|textstyle|scriptstyle'
    r'|limits|nolimits|rm|bf|it|sf|tt)(?![A-Za-z])')
# \, \; \: \! — тонкие пробелы и отрицательный пробел.
MATH_THIN_RE = re.compile(r'\\[,;:!]')

# Разделители формул: $$...$$ и $...$.
# Одиночный $ НЕ трогаем, и это важно: в базе есть настоящие цены
# («до $63 за баррель»), где $ ровно один. Пару считаем только если второй $
# близко и без перевода строки — тогда это действительно формула.
MATH_DOLLAR_RE = re.compile(r'\$\$([^$\n]{1,400})\$\$|\$([^$\n]{1,120})\$')

# Остатки команд: \что-угодно и одинокие бэкслеши.
MATH_CMD_RE = re.compile(r'\\[A-Za-z]+')

# { } — после разбора \frac и родни они уже не нужны.
BRACES_RE = re.compile(r'[{}]')

# Подстрочный/надстрочный знак: Fe_3O_4 -> Fe3O4, x^2 -> x2.
# Только между буквой/цифрой с обеих сторон! Безусловное удаление «_» сломало
# бы 51 вопрос базы, где подчёркивания — это ПРОПУСКИ в тексте:
# «из расчета ___ душевых сеток» превратилось бы в «из расчета душевых сеток»
# и перестало отличаться от соседнего вопроса с другим числом пропусков.
SUBSUP_RE = re.compile(r'(?<=[^\W_])\s*[_^]\s*(?=[^\W_])')


def fold(text):
    """Привести текст к одному виду: NFKC, кавычки, формулы.

    NFKC здесь — не украшение, а главное лекарство от формул. MathJax отдаёт
    в innerText математические курсивные глифы из блока U+1D400–U+1D7FF
    (𝐹, 𝑒, 𝑥 …), и обычный lower() их не трогает вообще: '𝐹𝑒'.lower() — это
    по-прежнему '𝐹𝑒'. NFKC переводит их в обычные ASCII-буквы. Заодно он
    приводит «…» к '...', «²» к «2», «№» к «No» и неразрывный пробел к
    обычному. Кириллицу NFKC не затрагивает.
    """
    t = unicodedata.normalize('NFKC', str(text if text is not None else ''))
    t = SOFT_HYPHEN_RE.sub('', t)
    t = DASH_RE.sub('-', t)
    t = QUOTE_DOUBLE_RE.sub('"', t)
    t = QUOTE_SINGLE_RE.sub("'", t)
    return _fold_math(t)


def _fold_math(t):
    # Разделители формул \( \) \[ \], затем парные доллары.
    t = t.replace('\\(', ' ').replace('\\)', ' ')
    t = t.replace('\\[', ' ').replace('\\]', ' ')
    t = MATH_DOLLAR_RE.sub(lambda m: ' ' + (m.group(1) or m.group(2)) + ' ', t)
    # Команды с аргументом — до одиночных команд.
    t = DROP_ARG_RE.sub(' ', t)
    t = FRAC_RE.sub(r'(\1)/(\2)', t)
    t = SQRT_RE.sub(r'√(\1)', t)
    t = WRAP_RE.sub(r'\1', t)
    t = _SYMBOLS_RE.sub(_symbol_repl, t)
    t = MATH_NOISE_RE.sub(' ', t)
    t = MATH_THIN_RE.sub(' ', t)
    t = BRACES_RE.sub('', t)
    t = SUBSUP_RE.sub('', t)
    # Что осталось от команд — в пробел, чтобы «\fooбар» не склеилось в слово.
    t = MATH_CMD_RE.sub(' ', t)
    t = t.replace('\\', ' ')
    return t


def norm(text):
    """fold + один вид пробелов + нижний регистр. Главная функция сравнения."""
    return SPACE_RE.sub(' ', fold(text)).strip().lower()


def key(text):
    """Ключ вопроса для дедупликации и слияния.

    От norm() отличается тем, что снята вся пунктуация. Это склеивает записи,
    которые отличаются только кавычками, тире или разметкой формулы, — то есть
    ровно те дубликаты, ради которых всё и затевалось. Пробелы СОХРАНЕНЫ:
    границы слов нужны, иначе «а б в» и «абв» стали бы одним ключом, а по этому
    ключу записи удаляют.
    """
    return SPACE_RE.sub(' ', PUNCT_RE.sub(' ', norm(text))).strip()


def solid(text):
    """То же, что key(), но без пробелов — для поиска вопроса внутри текста.

    Убирает чувствительность к тому, как вёрстка разбила вопрос на строки.
    Для коротких вопросов не годится (см. solid_usable): короткая строка без
    пробелов легко находится внутри чужого текста случайно.
    """
    return key(text).replace(' ', '')


# Короче этого solid() не применяем — слишком велик шанс случайного вхождения.
SOLID_MIN_LEN = 12


def solid_usable(text):
    """Можно ли искать этот вопрос слитной формой."""
    return len(solid(text)) >= SOLID_MIN_LEN


def record_key(record):
    """Ключ записи базы — ТОЛЬКО по вопросу.

    Раньше сюда входил и ответ, и это был источник дубликатов: тот же вопрос,
    пришедший с изменённым ответом, давал другой ключ и дописывался второй
    раз. Ответ в ключ не входит намеренно — решение о том, что делать с
    расхождением ответов, принимает тот, кто вызывает (см. merge-answers.py).
    """
    return key(record.get('question', ''))


def dedupe_records(records):
    """Схлопнуть повторы по ключу вопроса, оставив ПОСЛЕДНЮЮ запись.

    Общее правило всего проекта: если один и тот же вопрос встретился дважды,
    верной считается та запись, которая пришла позже. Оно одинаково в разборе
    docx, в слиянии с набором расширения и в dedupe-answers.py — потому и
    вынесено сюда: разъехавшиеся копии этого правила и породили дубликаты.

    Возвращает пару (записи, замены):
        записи  — те же словари, в порядке первого появления вопроса;
        замены  — пары (выброшенная запись, оставленная запись).

    Записи без текста вопроса и без ответа выбрасываются молча: это не
    дубликат, а мусор разбора. У списковых ответов пустые строки убираются
    прямо в записи — иначе «ответ есть» и «ответ пустой» не различить.
    """
    best, replaced = {}, []
    for record in records:
        answer = record.get('answer')
        if isinstance(answer, list):
            answer = [item for item in answer if item]
            record['answer'] = answer
        if not str(record.get('question', '')).strip() or not answer:
            continue
        record_k = record_key(record)
        if not record_k:
            continue
        if record_k in best:
            replaced.append((best[record_k], record))
        best[record_k] = record
    return list(best.values()), replaced


# ── чтение и запись базы ────────────────────────────────────────────────────
def load_base(path):
    """Прочитать базу. Выход с сообщением, если файл не найден или не JSON."""
    if not os.path.exists(path):
        sys.exit(f'[!] Файл не найден: {path}')
    with open(path, encoding='utf-8') as f:
        try:
            data = json.load(f)
        except ValueError as error:
            sys.exit(f'[!] {path} — это не разбирается как JSON: {error}')
    if not isinstance(data, list):
        sys.exit(f'[!] {path}: ожидался список записей, а там {type(data).__name__}.')
    return data


def render_base(records):
    """База в том виде, в каком она лежит в репозитории: UTF-8 без BOM,
    отступ 4, переводы строк CRLF, без перевода строки в конце.

    Проверено на текущем answers.json: файл побайтово равен этой функции.
    Поэтому перезапись целиком не даёт лишних изменений в git — в diff
    попадают только те записи, которые действительно изменились.
    """
    return json.dumps(records, ensure_ascii=False, indent=4).replace('\n', '\r\n')


def write_base(path, records):
    """Записать базу целиком, оставив копию прежней в path + '.bak'."""
    backup = path + '.bak'
    shutil.copy2(path, backup)
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(render_base(records))
    return backup


def verify_written(path, expected):
    """Перечитать записанное и убедиться, что это ровно то, что задумано.

    Файл базы — единственная копия накопленных ответов, поэтому проверка идёт
    в два слоя: содержимое разбирается обратно в тот же список и совпадает
    побайтово с канонической формой. Не сошлось — говорим, где взять копию.
    """
    with open(path, encoding='utf-8', newline='') as f:
        raw = f.read()
    if raw != render_base(expected):
        sys.exit(f'[!] После записи файл не совпал с задуманным — '
                 f'возьмите копию: {path}.bak')
    if load_base(path) != expected:
        sys.exit(f'[!] После записи база читается не тем же списком — '
                 f'возьмите копию: {path}.bak')


# ── мелочи для отчётов ──────────────────────────────────────────────────────
def brief(text, limit=80):
    """Текст в одну строку, обрезанный по ширине отчёта."""
    one = SPACE_RE.sub(' ', str(text or '')).strip()
    return one if len(one) <= limit else one[:limit - 1] + '…'


def full(text):
    """Текст в одну строку без обрезки.

    Нужен там, где запись показывают целиком ради сверки глазами —
    в отчёте об удалении дубликатов: обрезанный вопрос как раз и не даёт
    понять, чем два экземпляра отличаются.
    """
    return SPACE_RE.sub(' ', str(text or '')).strip()


def answer_brief(answer):
    if isinstance(answer, list):
        return ' + '.join(brief(a, 30) for a in answer)
    if isinstance(answer, dict):
        return f'{len(answer)} шт. по ячейкам'
    return brief(answer, 50)


def plural(n, one, few, many):
    """Русское согласование числительного с существительным: 1 запись,
    2 записи, 5 записей. То же правило, что в popup.js."""
    tail = n % 100
    if 11 <= tail <= 14:
        return many
    last = n % 10
    if last == 1:
        return one
    if 2 <= last <= 4:
        return few
    return many


def answer_json(answer):
    """Ответ в виде строки для сравнения: порядок ключей не важен, регистр и
    раскладка внутри ответа — тоже (тем же правилом, что и вопросы)."""
    if isinstance(answer, list):
        return json.dumps([norm(a) for a in answer], ensure_ascii=False)
    if isinstance(answer, dict):
        return json.dumps({k: (norm(v) if not isinstance(v, list)
                               else [norm(x) for x in v])
                           for k, v in sorted(answer.items())}, ensure_ascii=False)
    return norm(answer)


def answer_equal(a, b):
    """Один ли и тот же ответ, с точностью до нормализации текста."""
    return answer_json(a) == answer_json(b)


def setup_console():
    """Консоль Windows по умолчанию cp1251 и падает на кириллице."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError):
            pass
