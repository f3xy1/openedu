# -*- coding: utf-8 -*-
"""Проверка базы ответов на дубликаты и удаление лишних.

Зачем: в базу могли попасть два экземпляра одного вопроса — с разными
ответами. Так вышло из-за того, что ключом записи считалась пара «вопрос +
ответ»: тот же вопрос с изменённым ответом выглядел как новая запись и
дописывался в конец (правило с тех пор исправлено, см. merge-answers.py).

    python dedupe-answers.py                найти и удалить дубликаты
    python dedupe-answers.py --check        только показать, файл не трогать
    python dedupe-answers.py --base файл.json

Оставляем ПОСЛЕДНЮЮ запись группы — то же правило, по которому теперь
работает слияние. Вопросы сравниваются не посимвольно, а по ключу из
qa_norm: кавычки, тире, разметка формул и регистр на ключ не влияют, поэтому
«Термин «дуалог» – это» и «Термин "дуалог" - это» — это один и тот же вопрос.

Перед записью база копируется в answers.json.bak. Если дубликатов нет, файл
не трогается вообще.
"""
import argparse
import os
import sys
from collections import OrderedDict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import qa_norm


def group_by_key(records):
    """Вопросы по ключу, в порядке первого появления.

    Ключ — только вопрос. Ответ в ключ не входит намеренно: если в группе
    оказались разные ответы, это и есть та самая проблема, ради которой скрипт
    написан, и её надо показать, а не развести записи по разным ключам.
    """
    groups = OrderedDict()
    for index, record in enumerate(records):
        groups.setdefault(qa_norm.record_key(record), []).append(index)
    return groups


def keep_metadata(kept, dropped):
    """Перенести в оставленную запись структурные поля из выброшенных.

    Ответ и вопрос берём из последней записи как есть — это правило. А вот
    problem_id (и type) — не содержимое, а привязка к заданию на платформе:
    если в оставшейся записи её нет, а в выброшенной была, терять её незачем.
    """
    moved = []
    for other in dropped:
        for field in ('problem_id', 'type'):
            if other.get(field) and not kept.get(field):
                kept[field] = other[field]
                moved.append(field)
    return moved


def main():
    qa_norm.setup_console()
    ap = argparse.ArgumentParser(
        description='Найти в базе дубликаты вопросов и оставить только последнюю запись')
    ap.add_argument('--base', default=qa_norm.DEFAULT_BASE,
                    help='база для проверки (по умолчанию %(default)s)')
    ap.add_argument('--check', '--dry-run', dest='check', action='store_true',
                    help='только показать, файл не трогать')
    args = ap.parse_args()

    records = qa_norm.load_base(args.base)
    groups = group_by_key(records)
    dupes = [(k, idx) for k, idx in groups.items() if len(idx) > 1]

    print(f'База: {args.base}  ({len(records)} записей)')
    print()

    if not dupes:
        print('Дубликатов не найдено — все вопросы уникальны.')
        print('Файл не тронут.')
        return

    removed = 0
    drop = set()
    print(f'Дубликатов: {len(dupes)} '
          f'{qa_norm.plural(len(dupes), "группа", "группы", "групп")}.\n')
    for key, indexes in dupes:
        kept_index = indexes[-1]
        dropped_indexes = indexes[:-1]
        drop.update(dropped_indexes)
        kept = records[kept_index]
        dropped = [records[i] for i in dropped_indexes]

        print('─' * 78)
        print(f'Вопрос — {len(indexes)} '
              f'{qa_norm.plural(len(indexes), "запись", "записи", "записей")}, '
              f'оставляю №{kept_index + 1}:')
        # Полный текст, а не обрезка: ради этой сверки скрипт и запускают.
        print(f'    {qa_norm.full(kept.get("question", ""))}')
        for i in dropped_indexes:
            other = records[i]
            tag = ('тот же ответ' if qa_norm.answer_equal(other.get('answer'),
                                                          kept.get('answer'))
                   else 'ОТВЕТ ДРУГОЙ')
            print(f'  выброшена №{i + 1} ({tag}):')
            print(f'    {qa_norm.full(other.get("question", ""))}')
            print(f'    ответ: {qa_norm.answer_brief(other.get("answer"))}')
        print(f'  оставлена №{kept_index + 1}:')
        print(f'    ответ: {qa_norm.answer_brief(kept.get("answer"))}')
        moved = keep_metadata(kept, dropped)
        if moved:
            print(f'  перенесено из выброшенных: {", ".join(moved)}')
        removed += len(dropped_indexes)

    # Порядок базы сохраняем: выпадают только ранние дубликаты, оставленная
    # запись остаётся на своём месте. Так в git видно ровно удалённые строки.
    result = [r for i, r in enumerate(records) if i not in drop]

    print()
    print(f'Было: {len(records)}.  Удалить: {removed}.  Станет: {len(result)}.')

    if args.check:
        print('\n--check: файл базы не тронут.')
        return

    backup = qa_norm.write_base(args.base, result)
    qa_norm.verify_written(args.base, result)
    print(f'\nЗаписано: {args.base}')
    print(f'Копия прежней базы: {backup}')


if __name__ == '__main__':
    main()
