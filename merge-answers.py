# -*- coding: utf-8 -*-
"""Слияние базы ответов с набором, выгруженным из расширения.

Зачем: на странице курса значок 📋 у решённого задания складывает запись в
набор внутри расширения. В окне расширения (клик по его значку на панели
браузера) набор выгружается файлом answers-new.json. Этот скрипт дописывает
такие записи в opendu-helper/answers.json.

    python merge-answers.py                  найти свежий answers-new*.json
    python merge-answers.py файл.json        взять конкретный файл
    python merge-answers.py --dry-run        показать, что было бы сделано

Ключ записи — ТОЛЬКО текст вопроса (см. qa_norm.record_key), а не пара
«вопрос + ответ», как было раньше. Из-за прежнего правила один и тот же
вопрос, пришедший с изменённым ответом, считался новой записью и дописывался
в базу второй раз — отсюда и брались дубликаты. Теперь на уже известный
вопрос запись не добавляется: если ответ тот же, она пропускается, если
другой — ответ ОБНОВЛЯЕТСЯ (побеждает свежая запись из набора).

Вопросы сравниваются не посимвольно, а по нормализованному ключу: кавычки,
тире, регистр и разметка формул на него не влияют, поэтому «Термин «дуалог» –
это» и «Термин "дуалог" - это» — один и тот же вопрос.

Перед записью база копируется в answers.json.bak.
Зависимостей нет — только стандартная библиотека.
"""
import argparse
import glob
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import qa_norm

HERE = os.path.dirname(os.path.abspath(__file__))
# Где искать выгруженный набор, если файл не указан руками.
SEARCH_DIRS = [HERE, os.path.join(os.path.expanduser('~'), 'Downloads')]
EXPORT_MASK = 'answers-new*.json'

# Поля-привязки: не содержимое вопроса, а признак того, откуда запись. Их
# переносим при обновлении, чтобы не потерять привязку к заданию на платформе.
LINK_FIELDS = ('problem_id', 'type')


def strip_service(record):
    """_at и _source — служебные поля расширения (когда и с какой страницы
    запись снята). В базе им делать нечего."""
    return {k: v for k, v in record.items() if not k.startswith('_')}


def merge_into(records, by_key, incoming):
    """Разложить входящие записи по базе. Возвращает отчёт о сделанном.

    by_key — ключ вопроса -> номер записи в базе. Указывает на ПОСЛЕДНЮЮ
    запись с таким ключом: если в базе уже завёлся дубликат (до того, как
    правило исправили), обновится именно свежий экземпляр.
    """
    added, updated, same, empty = [], [], [], []

    for raw in incoming:
        record = strip_service(raw)
        if not str(record.get('question', '')).strip():
            empty.append(record)
            continue

        key = qa_norm.record_key(record)
        index = by_key.get(key)

        if index is None:
            records.append(record)
            by_key[key] = len(records) - 1
            added.append(record)
            continue

        existing = records[index]
        if qa_norm.answer_equal(existing.get('answer'), record.get('answer')):
            # Ответ тот же. Текст вопроса не перезаписываем: в базе он уже
            # есть, а гонять его туда-сюда ради кавычек — лишние правки.
            # А вот привязку к заданию дописать стоит: она не содержимое.
            carried = [f for f in LINK_FIELDS
                       if record.get(f) and not existing.get(f)]
            if carried:
                for field in carried:
                    existing[field] = record[field]
                updated.append((existing, carried, None))
            else:
                same.append(record)
            continue

        # Ответ другой — побеждает свежая запись. Привязку из старой переносим,
        # если в новой её нет: терять её незачем.
        fresh = dict(record)
        for field in LINK_FIELDS:
            if not fresh.get(field) and existing.get(field):
                fresh[field] = existing[field]
        old_answer = existing.get('answer')
        records[index] = fresh
        updated.append((fresh, [], old_answer))

    return {'added': added, 'updated': updated, 'same': same, 'empty': empty}


# ── поиск выгруженного набора ───────────────────────────────────────────────
def find_export(explicit):
    if explicit:
        if not os.path.exists(explicit):
            sys.exit(f'[!] Файл не найден: {explicit}')
        return explicit
    found = []
    for folder in SEARCH_DIRS:
        found += glob.glob(os.path.join(folder, EXPORT_MASK))
    # выбор браузера тоже попадает под маску — «answers-new (1).json»
    found = [p for p in found if os.path.isfile(p)]
    if not found:
        sys.exit('[!] Не нашёл выгруженный набор. Искал ' + EXPORT_MASK + ' в:\n'
                 + '\n'.join('      ' + d for d in SEARCH_DIRS)
                 + '\n    Выгрузите набор в окне расширения или укажите файл:\n'
                 '      python merge-answers.py путь\\к\\answers-new.json')
    found.sort(key=os.path.getmtime, reverse=True)
    if len(found) > 1:
        print('Нашёл несколько файлов, беру самый свежий:')
        for path in found:
            mark = '->' if path == found[0] else '  '
            print(f"   {mark} {path}  ({time.strftime('%d.%m.%Y %H:%M', time.localtime(os.path.getmtime(path)))})")
    return found[0]


def find_double_keys(records):
    """Номера записей, у которых ключ вопроса повторяется.

    Такие могли остаться от прежнего правила. Само слияние их не разведёт —
    для этого есть отдельный скрипт dedupe-answers.py.
    """
    seen, double = {}, set()
    for index, record in enumerate(records):
        key = qa_norm.record_key(record)
        if not key:
            continue
        if key in seen:
            double.add(seen[key])
            double.add(index)
        seen[key] = index
    return sorted(double)


# ── основной ход ────────────────────────────────────────────────────────────
def main():
    qa_norm.setup_console()
    ap = argparse.ArgumentParser(
        description='Дописать выгруженный из расширения набор в базу ответов')
    ap.add_argument('file', nargs='?',
                    help='файл набора (answers-new.json); без него ищется сам')
    ap.add_argument('--base', default=qa_norm.DEFAULT_BASE,
                    help='база, которую дополняем (по умолчанию %(default)s)')
    ap.add_argument('--dry-run', action='store_true',
                    help='только показать, что было бы сделано')
    args = ap.parse_args()

    export_path = find_export(args.file)
    records = qa_norm.load_base(args.base)
    incoming = qa_norm.load_base(export_path)

    by_key = {}
    for index, record in enumerate(records):
        key = qa_norm.record_key(record)
        if key:
            by_key[key] = index          # последняя запись с таким ключом

    stamp = time.strftime('%d.%m.%Y %H:%M', time.localtime(os.path.getmtime(export_path)))
    print(f'База:  {args.base}  ({len(records)} записей)')
    print(f'Набор: {export_path}  ({len(incoming)} записей, {stamp})')
    print()

    double = find_double_keys(records)
    if double:
        print(f'[!] В самой базе {len(double)} записей с повторяющимися вопросами '
              f'(№ {", ".join(str(i + 1) for i in double[:10])}'
              + ('…' if len(double) > 10 else '') + ').')
        print('    Слияние их не разведёт — прогоните dedupe-answers.py.')
        print()

    report = merge_into(records, by_key, incoming)

    if report['added']:
        print(f"Добавить ({len(report['added'])}):")
        for record in report['added'][:20]:
            print(f"   + {qa_norm.brief(record.get('question'))}")
            print(f"     -> {qa_norm.answer_brief(record.get('answer'))}")
        if len(report['added']) > 20:
            print(f"   … и ещё {len(report['added']) - 20}")

    if report['updated']:
        print(f"\nОбновить ({len(report['updated'])}):")
        for record, carried, old_answer in report['updated'][:20]:
            print(f"   ~ {qa_norm.brief(record.get('question'))}")
            if old_answer is not None:
                print(f"     было:  {qa_norm.answer_brief(old_answer)}")
                print(f"     стало: {qa_norm.answer_brief(record.get('answer'))}")
            if carried:
                print(f"     дописано из старой записи: {', '.join(carried)}")
        if len(report['updated']) > 20:
            print(f"   … и ещё {len(report['updated']) - 20}")

    if report['same']:
        print(f"\nУже есть в базе, пропускаю ({len(report['same'])}):")
        for record in report['same'][:10]:
            print(f"   = {qa_norm.brief(record.get('question'))}")
        if len(report['same']) > 10:
            print(f"   … и ещё {len(report['same']) - 10}")

    if report['empty']:
        print(f"\nБез текста вопроса, пропускаю ({len(report['empty'])}).")

    print(f"\nБыло: {len(records) - len(report['added'])}.  "
          f"Добавить: {len(report['added'])}.  "
          f"Обновить: {len(report['updated'])}.  "
          f"Пропущено повторов: {len(report['same'])}.  "
          f"Станет: {len(records)}.")

    if not report['added'] and not report['updated']:
        print('\nМенять нечего — файл базы не тронут.')
        return
    if args.dry_run:
        print('\n--dry-run: файл базы не тронут.')
        return

    backup = qa_norm.write_base(args.base, records)
    qa_norm.verify_written(args.base, records)
    print(f'\nЗаписано: {args.base}')
    print(f'Копия прежней базы: {backup}')
    print('\nТеперь нажмите «Очистить набор» в окне расширения — иначе те же '
          'записи поедут в следующий экспорт.')


if __name__ == '__main__':
    main()
