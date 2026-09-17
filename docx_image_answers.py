#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
docx_image_answers.py — извлечение ответов из .docx, где ответы приложены КАРТИНКАМИ.

Зачем: converter.py и answer-parser.py умеют читать только текстовые маркеры
('•' / '+' / жёлтая заливка). В базе «ДОПОЛНЕН_...docx» вопрос написан текстом,
а варианты ответа — скриншотом с платформы openedu, где правильный вариант
обведён ЗЕЛЁНОЙ рамкой. Этот скрипт находит такие рамки, вырезает строку ответа
и собирает contact sheet, чтобы ответы можно было прочитать глазами, после чего
собирает answers.json.

Как работает определение (по образцу платформы openedu):
  * правильный ответ  -> зелёная рамка вокруг строки + зелёная галочка снизу
                         (два оттенка зелёного: (73,128,30) и (0,128,0))
  * неправильный      -> КРАСНАЯ рамка (152,8,20) + красный крестик
  * выпадающий список -> зелёная галочка справа от <select>, рамки нет
  * кроссворд         -> много зелёных рамок, пропускается

Использование
-------------
1) Разбор документа (создаст crops/, sheets/ и transcribe.json):

     python docx_image_answers.py extract "ДОПОЛНЕН_....docx" --work out

   Посмотрите sheets/*.png и впишите тексты ответов в out/transcribe.json
   (ключ — номер из подписи #N на contact sheet).

2) Сборка базы:

     python docx_image_answers.py build "ДОПОЛНЕН_....docx" --work out \
         --out answers.json [--merge существующий.json]

Зависимости: pip install python-docx pillow numpy
"""

import argparse
import difflib
import glob
import io
import json
import os
import re
import sys
import zipfile
from collections import Counter, defaultdict

try:
    import numpy as np
except ImportError:
    sys.exit("Нужен numpy:  pip install numpy")

from PIL import Image, ImageDraw
from docx import Document
from docx.oxml.ns import qn
from docx.table import Table
from docx.text.paragraph import Paragraph

# --- цвета, которые использует платформа openedu -----------------------------
GREEN_BOXES = [(73, 128, 30), (0, 128, 0)]   # правильный ответ
RED_MARKS = [(152, 8, 20)]                   # неправильный ответ
TOL = 10
MIN_BOX_W_FRAC = 0.70   # рамка считаеся рамкой, если шире 70% картинки

# Переносы слов, вставленные платформой при отрисовке текста на конкретной
# ширине окна. При другой ширине слово переносится иначе, поэтому такие дефисы
# надо склеивать — иначе ответ не совпадёт с текстом на странице.
# Ключи сюда добавляются по мере надобности; безопаснее всего — если та же
# фраза встречается в базе ещё раз без дефиса (см. `build --suggest-hyphens`,
# он находит именно такие пары и печатает готовые строки для этого словаря).
HYPHEN_JOINS = {
    'профес-сиональной': 'профессиональной',
    'следую-щие': 'следующие',
    'сообще-ния': 'сообщения',
    'вырази-тельных': 'выразительных',
    'Ин-тернет': 'Интернет',
    'распростране-нию': 'распространению',
    'представле-ниями': 'представлениями',
    'профессио-нальное': 'профессиональное',
    'про-блемных': 'проблемных',
}


# ----------------------------------------------------------------------------
# чтение docx
# ----------------------------------------------------------------------------
def iter_block_items(doc):
    for child in doc.element.body.iterchildren():
        if child.tag == qn('w:p'):
            yield Paragraph(child, doc)
        elif child.tag == qn('w:tbl'):
            yield Table(child, doc)


def scenario_texts(docx_path, min_len=60, skip=()):
    """Для каждой картинки — текст ближайшего описания ситуации перед ней.

    В базах встречаются ситуационные задачи: длинный абзац с описанием ситуации,
    а за ним несколько коротких однотипных подвопросов («Какое кровотечение у
    пострадавшего?»). В разных задачах подвопросы совпадают дословно, а ответы
    разные — поэтому такой вопрос нельзя искать на странице сам по себе, его
    надо привязать к описанию ситуации.

    `skip` — тексты самих подвопросов: длинный подвопрос не должен быть принят
    за описание ситуации.
    """
    rows = collect_image_paragraphs(docx_path)
    blocks = [b.text.strip()
              for b in iter_block_items(Document(docx_path))
              if isinstance(b, Paragraph)]
    skip_norm = {norm(s) for s in skip}
    out = {}
    for i, row in enumerate(rows):
        j = row['idx'] - 1
        while j >= 0:
            t = blocks[j]
            if len(t) >= min_len and norm(t) not in skip_norm:
                out[i] = t
                break
            j -= 1
    return out


def scenario_fragment(text, limit=60):
    """Начало описания ситуации — по границе слова, без многоточий."""
    t = re.sub(r'\s+', ' ', text.replace('...', ' ')).strip()
    t = t[:limit]
    if ' ' in t:
        t = t[:t.rfind(' ')]
    return t.strip(' .,;:—-–').strip()


def disambiguate(recs, docx_path):
    """Привязывает спорные подвопросы к описанию ситуации через '...'.

    Берём только вопросы, у которых в базе РАЗНЫЕ ответы: значит, сам по себе
    такой вопрос неоднозначен, и молча подставлять первый попавшийся ответ
    нельзя. Если описания рядом нет — вопрос остаётся как есть, и это видно в
    отчёте.
    """
    byq = defaultdict(list)
    for r in recs:
        byq[norm(r['question'])].append(r)
    ambiguous = {q: rs for q, rs in byq.items()
                 if len({norm(answer_text(r['answer'])) for r in rs}) > 1}
    if not ambiguous:
        return 0, 0
    scen = scenario_texts(docx_path, skip=[r['question'] for r in recs])
    fixed = lost = 0
    for q, rs in ambiguous.items():
        for r in rs:
            m = re.match(r'i(\d+)$', r.get('src', '') or '')
            frag = scenario_fragment(scen.get(int(m.group(1)), '')) if m else ''
            if frag and norm(frag) not in norm(r['question']):
                r['question'] = f'{frag}...{r["question"]}'
                fixed += 1
            else:
                lost += 1
    return fixed, lost


def resolve_docx(path):
    """Терпимость к кириллическим путям: некоторые оболочки (Git Bash) портят
    кодировку аргумента, и файл «не находится». Если по указанному пути ничего
    нет — ищем в том же каталоге самый похожий по имени .docx."""
    if os.path.exists(path):
        return path
    d = os.path.dirname(os.path.abspath(path)) or '.'
    cands = [p for p in glob.glob(os.path.join(d, '*.docx'))
             if not os.path.basename(p).startswith('~$')]
    if not cands:
        sys.exit(f'Файл не найден: {path!r}  (.docx в каталоге нет)')

    def key(s):
        return re.sub(r'[^0-9a-zа-яё]+', '', os.path.basename(s).lower())

    want = key(path)
    exact = [p for p in cands if key(p) == want]
    if exact:
        best = exact[0]
    elif len(cands) == 1:
        best = cands[0]
    else:
        close = difflib.get_close_matches(want, [key(p) for p in cands], n=1, cutoff=0.5)
        if not close:
            sys.exit(f'Файл не найден: {path!r}\nВ каталоге есть:\n  ' +
                     '\n  '.join(os.path.basename(p) for p in cands))
        best = next(p for p in cands if key(p) == close[0])
    print(f'[i] {os.path.basename(path)!r} не найден — использую '
          f'{os.path.basename(best)!r}')
    return best


def collect_image_paragraphs(docx_path):
    """Возвращает список {idx, text, media} — абзацы, в которых есть картинки."""
    doc = Document(docx_path)
    rels = {rid: rel.target_ref for rid, rel in doc.part.rels.items()}
    rows = []
    for idx, blk in enumerate(iter_block_items(doc)):
        if not isinstance(blk, Paragraph):
            continue
        blips = re.findall(r'r:embed="([^"]+)"', blk._p.xml)
        if blips:
            rows.append({
                'idx': idx,
                'text': blk.text.strip(),
                'media': [rels.get(b, '?') for b in blips],
            })
    return rows


# ----------------------------------------------------------------------------
# поиск зелёных рамок
# ----------------------------------------------------------------------------
def colour_mask(arr, colours, tol=TOL):
    m = np.zeros(arr.shape[:2], dtype=bool)
    for c in colours:
        m |= (np.abs(arr - np.array(c)) <= tol).all(axis=2)
    return m


def row_clusters(rows, gap=6):
    out = []
    if not len(rows):
        return out
    start = prev = rows[0]
    for r in rows[1:]:
        if r - prev > gap:
            out.append((start, prev))
            start = r
        prev = r
    out.append((start, prev))
    return out


def find_boxes(mask, width):
    """Возвращает (большие рамки, число мелких отметок)."""
    rows = np.nonzero(mask.sum(axis=1))[0]
    big, small = [], 0
    for y0, y1 in row_clusters(rows.tolist()):
        sub = mask[y0:y1 + 1]
        cols = np.nonzero(sub.sum(axis=0))[0]
        x0, x1 = int(cols.min()), int(cols.max())
        w, h = x1 - x0, y1 - y0
        if w > MIN_BOX_W_FRAC * width and h >= 18:
            big.append({'y0': int(y0), 'y1': int(y1), 'x0': x0, 'x1': x1, 'w': w, 'h': h})
        else:
            small += 1
    return big, small


def border_frac(mask, box, ring=6):
    """Доля зелёных пикселей рамки, лежащих у её границы.

    Отличает чекбокс от кроссворда: у чекбокса зелёное — это КОНТУР
    прямоугольника вокруг варианта (почти всё у границы, ~0.98-1.00),
    у кроссворда зелёные залитые клетки разбросаны внутри габарита
    (0.05-0.52). Порог 0.85 разделяет их с большим запасом."""
    sub = mask[box['y0']:box['y1'] + 1, box['x0']:box['x1'] + 1]
    total = int(sub.sum())
    if not total:
        return 0.0
    edge = np.zeros_like(sub)
    edge[:ring, :] = True
    edge[-ring:, :] = True
    edge[:, :ring] = True
    edge[:, -ring:] = True
    return float((sub & edge).sum()) / total


def classify(im):
    """Определяет тип картинки и координаты зелёных рамок.

    GREEN_*      — одна рамка, ответ один (строка)
    MULTI_ANSWER — несколько рамок-контуров: вопрос с несколькими правильными
                   вариантами (чекбоксы), ответ — список
    CROSSWORD    — несколько зелёных областей без контура: кроссворд, пропуск
    """
    arr = np.asarray(im.convert('RGB')).astype(np.int16)
    w, h = im.size
    g = colour_mask(arr, GREEN_BOXES)
    r = colour_mask(arr, RED_MARKS)
    g_boxes, _ = find_boxes(g, w)
    r_boxes, _ = find_boxes(r, w)

    # зелёные отметки вне найденных рамок = галочки (в т.ч. у <select>)
    inside = np.zeros_like(g)
    for b in g_boxes:
        inside[b['y0']:b['y1'] + 1, b['x0']:b['x1'] + 1] = True
    g_outside = int((g & ~inside).sum())
    tail = int(g[int(h * 0.75):].sum())

    if r_boxes:
        return 'RED_WRONG', g_boxes
    if len(g_boxes) == 1:
        return ('GREEN_VERIFIED' if tail > 100 else 'GREEN_NOCHECK'), g_boxes
    if len(g_boxes) > 1:
        if all(border_frac(g, b) >= 0.85 for b in g_boxes):
            return 'MULTI_ANSWER', g_boxes
        return 'CROSSWORD', g_boxes
    if g_outside > 100:
        return 'GREEN_TICK_ONLY', g_boxes
    return 'NO_MARK', g_boxes


# ----------------------------------------------------------------------------
# очистка текста
# ----------------------------------------------------------------------------
def clean_text(t):
    for bad, good in HYPHEN_JOINS.items():
        t = t.replace(bad, good)
    return re.sub(r'[\s ]+', ' ', t).strip()


def norm(t):
    return re.sub(r'[\s ]+', ' ', t).strip().lower()


def answer_text(a):
    """Ответ бывает строкой (один вариант) или списком (несколько правильных).
    Для сравнений и поиска переносов нужен один текст."""
    return ' '.join(a) if isinstance(a, list) else (a or '')


def suggest_hyphens(texts):
    """Ищет переносы, вставленные платформой при отрисовке на конкретной ширине.

    Признак переноса: слово с дефисом, у которого склейка без дефиса встречается
    в корпусе ещё где-то как обычное слово.

    ВНИМАНИЕ, это только подсказка. Ловится и законный случай: если в базе
    встречаются оба написания одного слова (в этом корпусе — «масс-медиа»
    6 раз и «массмедиа» 2 раза, оба настоящие). Поэтому каждый кандидат надо
    глазами сверить со скриншотом, прежде чем добавлять в HYPHEN_JOINS.

    Обратная слепота: перенос, который в корпусе встречается ровно один раз,
    так не находится — склейку не с чем сравнить.

    Возвращает список (слово_с_дефисом, склейка, сколько_раз_без_дефиса).
    """
    corpus = ' \n '.join(texts).lower()
    found = {}
    for m in re.finditer(r'[А-Яа-яЁёA-Za-z]{2,}-[А-Яа-яЁёA-Za-z]{2,}', corpus):
        tok = m.group(0)
        joined = tok.replace('-', '')
        if joined in found:
            continue
        # склейка именно как самостоятельное слово, а не внутри другого дефисного
        plain = len(re.findall(r'(?<![\w-])' + re.escape(joined) + r'(?![\w-])', corpus))
        if plain:
            hyp = len(re.findall(re.escape(tok) + r'(?![\w-])', corpus))
            found[joined] = (tok, joined, plain, hyp)
    return sorted(found.values(), key=lambda x: -x[2])


# ----------------------------------------------------------------------------
# шаг 1: extract
# ----------------------------------------------------------------------------
def cmd_extract(args):
    docx_path = resolve_docx(args.docx)
    work = args.work
    crops_dir = os.path.join(work, 'crops')
    sheets_dir = os.path.join(work, 'sheets')
    os.makedirs(crops_dir, exist_ok=True)
    os.makedirs(sheets_dir, exist_ok=True)

    rows = collect_image_paragraphs(docx_path)
    z = zipfile.ZipFile(docx_path)
    print(f'Абзацев с картинками: {len(rows)}')

    stats = Counter()
    pending, crops = [], []
    for i, row in enumerate(rows):
        media = row['media'][0]
        im = Image.open(io.BytesIO(z.read('word/' + media))).convert('RGB')
        cls, boxes = classify(im)
        stats[cls] += 1

        if cls in ('GREEN_VERIFIED', 'GREEN_NOCHECK', 'MULTI_ANSWER',
                   'GREEN_TICK_ONLY'):
            for k, b in enumerate(boxes):
                c = im.crop((b['x0'] + 5, b['y0'] + 5, b['x1'] - 4, b['y1'] - 4))
                path = os.path.join(crops_dir, f'a{i:03d}_{k}.png')
                c.save(path)
                crops.append({'i': i, 'k': k, 'cls': cls, 'crop': path,
                              'question': clean_text(row['text'])})
            if cls == 'GREEN_TICK_ONLY':
                # галочки у <select>: рамки нет, вырезаем всю картинку целиком
                path = os.path.join(crops_dir, f'full{i:03d}.png')
                im.save(path)
                crops.append({'i': i, 'k': 'full', 'cls': cls, 'crop': path,
                              'question': clean_text(row['text'])})
            pending.append({'i': i, 'cls': cls, 'media': media,
                            'size': list(im.size), 'question': clean_text(row['text'])})

    print('\nКлассификация:')
    for k, v in stats.most_common():
        print(f'   {k:16s} {v}')
    print(f'\nВсего к расшифровке: {len(crops)}')

    json.dump(crops, open(os.path.join(work, 'crops.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    json.dump(pending, open(os.path.join(work, 'pending.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)

    # contact sheets
    SHEET_W, PER, LAB, GAP = 1500, 14, 22, 6
    items = []
    for c in crops:
        im = Image.open(c['crop'])
        sc = SHEET_W / im.size[0]
        items.append((c['i'], c['k'], im.resize((SHEET_W, max(1, int(im.size[1] * sc))), Image.LANCZOS)))

    n = 0
    for s in range(0, len(items), PER):
        chunk = items[s:s + PER]
        H = sum(t[2].size[1] + LAB + GAP for t in chunk)
        sh = Image.new('RGB', (SHEET_W + 100, H), (20, 20, 20))
        d = ImageDraw.Draw(sh)
        y = 0
        for i, k, im in chunk:
            d.text((6, y + 4), f'#{i}_{k}', fill=(255, 210, 0))
            y += LAB
            sh.paste(im, (100, y))
            d.line([(0, y - 2), (SHEET_W + 100, y - 2)], fill=(70, 70, 70))
            y += im.size[1] + GAP
        sh.save(os.path.join(sheets_dir, f'sheet{n:02d}.png'))
        n += 1
    print(f'Contact sheets: {n} шт. в {sheets_dir}')

    # шаблон для расшифровки. Ключ — "<i>_<k>" (номер картинки и номер рамки
    # внутри неё), потому что у вопроса с несколькими правильными вариантами
    # рамок несколько и каждую надо расшифровать отдельно.
    # Для GREEN_TICK_ONLY ключ "<i>_full" — там список пар «вопрос → ответ».
    tpl = {}
    for c in crops:
        key = f"{c['i']}_{c['k']}"
        tpl[key] = [] if c['k'] == 'full' else ''
    json.dump(tpl, open(os.path.join(work, 'transcribe.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=2)
    print(f'Заполните {os.path.join(work, "transcribe.json")} и запустите build.')


# ----------------------------------------------------------------------------
# шаг 2: build
# ----------------------------------------------------------------------------
def cmd_build(args):
    work = args.work
    crops = json.load(open(os.path.join(work, 'crops.json'), encoding='utf-8'))
    tr = json.load(open(args.transcribe or os.path.join(work, 'transcribe.json'), encoding='utf-8'))

    # Картинки, которые разобраны вручную (manual_entries.json): их авторасшифровка
    # не нужна, а иногда и вредна — например, когда текст вопроса в docx пустой и
    # все такие картинки схлопнулись бы в одну запись с пустым вопросом.
    skip_i = {int(x) for x in re.findall(r'\d+', args.skip_i or '')}
    if skip_i:
        print(f'Из расшифровки исключены картинки: {sorted(skip_i)}')

    recs, skipped = [], []
    # группируем рамки по номеру картинки: у вопроса с несколькими правильными
    # вариантами (чекбоксы) рамок несколько, и ответом должен стать СПИСОК —
    # content.js для checkbox умеет принимать массив.
    by_image = defaultdict(list)
    for c in crops:
        if c['i'] in skip_i:
            continue
        key = f"{c['i']}_{c['k']}"
        val = tr.get(key)
        if val is None and c['k'] == 0:
            val = tr.get(str(c['i']))      # старый формат: ключ без номера рамки
        # <select>-картинка: несколько пар «вопрос → ответ»
        if c['k'] == 'full':
            if isinstance(val, list):
                for pair in val:
                    q = clean_text(pair.get('question', '')) or c['question']
                    recs.append({'question': q, 'answer': clean_text(pair.get('answer', '')),
                                 'src': f"i{c['i']}"})
            continue
        if not val:
            skipped.append((c['i'], c['k'], c['question'][:60]))
            continue
        by_image[c['i']].append((c['k'], clean_text(val), c['question']))

    for i in sorted(by_image):
        parts = sorted(by_image[i], key=lambda t: t[0])
        answers = [a for _k, a, _q in parts if a]
        if not answers:
            continue
        question = parts[0][2]
        answer = answers[0] if len(answers) == 1 else answers
        recs.append({'question': question, 'answer': answer, 'src': f"i{i}"})

    # ручные дописки (вопросы из выпадающих списков, задачи с полями ввода)
    manual = args.manual or os.path.join(work, 'manual_entries.json')
    if os.path.exists(manual):
        extra = json.load(open(manual, encoding='utf-8'))
        for e in extra:
            a = e['answer']
            # ответ бывает списком (соответствие, несколько пропусков)
            a = [clean_text(x) for x in a] if isinstance(a, list) else clean_text(a)
            recs.append({'question': clean_text(e['question']), 'answer': a,
                         'src': e.get('src', 'manual')})
        print(f'Ручных записей добавлено: {len(extra)}')

    # обрезка «…» в конце (в content.js такой вопрос не сматчится)
    for r in recs:
        q = r['question']
        if q.endswith('…'):
            r['question'] = q[:-1].strip().rstrip(',').strip()

    if args.disambiguate and args.docx:
        try:
            fixed, lost = disambiguate(recs, resolve_docx(args.docx))
        except Exception as e:                       # noqa: BLE001
            print(f'[!] Не удалось привязать подвопросы к ситуациям: {e}')
        else:
            if fixed or lost:
                print(f'Привязано к описанию ситуации: {fixed}'
                      + (f', без описания осталось: {lost}' if lost else ''))

    if args.suggest_hyphens:
        print('\nВозможные переносы — кандидаты в HYPHEN_JOINS:')
        cands = suggest_hyphens([r['question'] for r in recs] +
                               [answer_text(r['answer']) for r in recs])
        if not cands:
            print('    (нет)')
        for tok, joined, plain, _hyp in cands[:40]:
            print(f"    {tok!r}: {joined!r},   # без дефиса встречается {plain}x")

    # дедуп + проверка конфликтов
    byq = defaultdict(set)
    for r in recs:
        byq[norm(r['question'])].add(norm(answer_text(r['answer'])))
    conflicts = {q: a for q, a in byq.items() if len(a) > 1}
    if conflicts:
        print(f'! Вопросов с разными ответами: {len(conflicts)}')
        for q, a in list(conflicts.items())[:5]:
            print(f'    {q[:70]!r} -> {sorted(a)}')

    seen, out = set(), []
    for r in recs:
        k = norm(r['question'])
        ans = r['answer']
        if isinstance(ans, list):
            ans = [a for a in ans if a]
            if not ans:
                continue
        elif not ans:
            continue
        if k in seen:
            continue
        seen.add(k)
        out.append({'question': r['question'], 'answer': ans})

    print(f'Записей: {len(recs)} -> уникальных: {len(out)}')
    if skipped:
        print(f'Не расшифровано (пропущено): {len(skipped)}')
        for i, k, q in skipped[:10]:
            print(f'    #{i} {k}  {q!r}')

    merged = out
    if args.merge and os.path.exists(args.merge):
        # Порядок существующего файла СОХРАНЯЕМ, новые вопросы дописываем в
        # конец: answers.json растёт как набор баз под разные тесты, и повторный
        # разбор того же docx не должен перемешивать уже собранное.
        old = json.load(open(args.merge, encoding='utf-8'))
        old_by_q = {norm(x.get('question', '')): x for x in old}
        fresh = [x for x in out if norm(x['question']) not in old_by_q]
        if args.refresh:
            # --refresh: ответы из текущего docx перекрывают старые
            new_by_q = {norm(x['question']): x for x in out}
            updated = sum(1 for x in old if norm(x.get('question', '')) in new_by_q)
            merged = [new_by_q.get(norm(x.get('question', '')), x) for x in old] + fresh
            print(f'Слияние с {args.merge}: обновлено {updated}, '
                  f'добавлено {len(fresh)} (итого {len(merged)})')
        else:
            merged = old + fresh
            print(f'Слияние с {args.merge}: было {len(old)}, '
                  f'добавлено новых {len(fresh)} (итого {len(merged)})')

    json.dump(merged, open(args.out, 'w', encoding='utf-8'),
              ensure_ascii=False, indent=4)
    print(f'Записано: {args.out}  ({len(merged)} записей)')


# ----------------------------------------------------------------------------
def main():
    # Консоль Windows по умолчанию cp1251 и падает на кириллице в путях/текстах.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError):
            pass

    ap = argparse.ArgumentParser(description='Извлечение ответов из docx со скриншотами')
    sub = ap.add_subparsers(dest='cmd', required=True)

    e = sub.add_parser('extract', help='найти зелёные рамки, нарезать ответы, собрать contact sheets')
    e.add_argument('docx')
    e.add_argument('--work', default='docx_out')
    e.set_defaults(func=cmd_extract)

    b = sub.add_parser('build', help='собрать answers.json из расшифровки')
    b.add_argument('docx', nargs='?')
    b.add_argument('--work', default='docx_out')
    b.add_argument('--transcribe')
    b.add_argument('--manual')
    b.add_argument('--out', default='answers.json')
    b.add_argument('--merge', help='существующий answers.json, который надо сохранить')
    b.add_argument('--refresh', action='store_true',
                   help='с --merge: ответы из текущего docx перекрывают старые')
    b.add_argument('--no-disambiguate', dest='disambiguate', action='store_false',
                   help='не привязывать однотипные подвопросы к описанию ситуации')
    b.add_argument('--suggest-hyphens', action='store_true',
                   help='показать кандидатов в HYPHEN_JOINS (дефисы-переносы)')
    b.add_argument('--skip-i', default='',
                   help='номера картинок через запятую, которые берём не из '
                        'расшифровки, а из manual_entries.json (например 469,470)')
    b.set_defaults(func=cmd_build)

    args = ap.parse_args()
    args.func(args)


if __name__ == '__main__':
    main()
