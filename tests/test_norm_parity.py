# -*- coding: utf-8 -*-
"""Проверка, что normalize.js и qa_norm.py считают одинаково.

Зачем: правило нормализации живёт в двух местах (браузер и скрипты не могут
делить код). Разъехавшиеся копии — это не теория, а причина, по которой в базу
попадали дубликаты: один и тот же вопрос с «ёлочками» и с обычными кавычками
давал два разных ключа. Поэтому вместо «следить глазами» — тест.

    python tests/test_norm_parity.py
    python tests/test_norm_parity.py --base opendu-helper/answers.json

Возвращает 1, если нашлись расхождения.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import qa_norm  # noqa: E402

RUNNER = os.path.join(HERE, 'norm_js_runner.js')
FIXTURE = os.path.join(HERE, 'norm-parity.json')

failures = []


def fail(message):
    failures.append(message)
    print(f'  ✗ {message}')


def run_js(texts):
    """Прогнать строки через настоящий normalize.js, а не через его пересказ."""
    handle, path = tempfile.mkstemp(suffix='.json')
    try:
        with os.fdopen(handle, 'w', encoding='utf-8') as f:
            json.dump(texts, f, ensure_ascii=False)
        result = subprocess.run(['node', RUNNER, path], capture_output=True, cwd=ROOT)
    finally:
        os.unlink(path)
    if result.returncode != 0:
        sys.exit('node не смог запустить normalize.js:\n'
                 + result.stderr.decode('utf-8', 'replace'))
    return json.loads(result.stdout.decode('utf-8'))


def py_forms(text):
    return {'norm': qa_norm.norm(text),
            'key': qa_norm.key(text),
            'solid': qa_norm.solid(text)}


def check_parity(texts):
    """Главная проверка: обе реализации обязаны дать посимвольно одно и то же."""
    print(f'Сверка реализаций на {len(texts)} строках…')
    js = run_js(texts)
    for text, js_forms in zip(texts, js):
        py_forms_ = py_forms(text)
        for form in ('norm', 'key', 'solid'):
            if py_forms_[form] != js_forms[form]:
                fail(f'{form} разошёлся\n'
                     f'      строка: {text!r}\n'
                     f'      python: {py_forms_[form]!r}\n'
                     f'      node:   {js_forms[form]!r}')


def check_relations(fixture):
    """equal/different — смысловые проверки, которые паритет не ловит:
    обе копии могут одинаково ошибаться."""
    for a, b in fixture['equal']:
        if qa_norm.key(a) != qa_norm.key(b):
            fail(f'должны сойтись, но разошлись:\n'
                 f'      {a!r}\n      {b!r}\n'
                 f'      {qa_norm.key(a)!r}\n      {qa_norm.key(b)!r}')
    for a, b in fixture['different']:
        if qa_norm.key(a) == qa_norm.key(b):
            fail(f'разные вопросы склеились в один ключ:\n'
                 f'      {a!r}\n      {b!r}\n'
                 f'      ключ: {qa_norm.key(a)!r}')


def check_contains(fixture):
    for case in fixture['contains']:
        if case['has'] not in qa_norm.norm(case['text']):
            fail(f'пропала подстрока {case["has"]!r} в {case["text"]!r}\n'
                 f'      нормализовалось в: {qa_norm.norm(case["text"])!r}\n'
                 f'      ({case.get("_", "")})')


def check_base(path):
    """Ключи по всей живой базе: дубликатов быть не должно.

    Это проверка не правила, а данных. Если здесь что-то нашлось — два разных
    вопроса схлопнулись в один ключ, и dedupe-answers.py удалит один из них.
    """
    records = qa_norm.load_base(path)
    print(f'\nКлючи по базе {path} ({len(records)} записей)…')
    seen = {}
    for index, record in enumerate(records):
        k = qa_norm.record_key(record)
        if k in seen:
            fail(f'вопросы {seen[k]} и {index} дали один ключ:\n'
                 f'      {records[seen[k]].get("question", "")[:90]!r}\n'
                 f'      {record.get("question", "")[:90]!r}')
        seen[k] = index
    print(f'  уникальных ключей: {len(seen)} из {len(records)}')
    empty = [i for i, r in enumerate(records) if not qa_norm.record_key(r)]
    if empty:
        fail(f'записей с пустым ключом: {len(empty)} (первые: {empty[:5]})')


def main():
    qa_norm.setup_console()
    ap = argparse.ArgumentParser(description='Сверить normalize.js и qa_norm.py')
    ap.add_argument('--base', default=qa_norm.DEFAULT_BASE,
                    help='база для проверки ключей (по умолчанию %(default)s)')
    ap.add_argument('--no-base', action='store_true',
                    help='не трогать базу, проверить только таблицу случаев')
    args = ap.parse_args()

    with open(FIXTURE, encoding='utf-8') as f:
        fixture = json.load(f)

    texts = list(fixture['cases'])
    for pair in fixture['equal'] + fixture['different']:
        texts.extend(pair)
    texts = list(dict.fromkeys(texts))

    check_parity(texts)
    print('\nСмысловые проверки…')
    check_relations(fixture)
    check_contains(fixture)
    if not args.no_base:
        check_base(args.base)

    print()
    if failures:
        print(f'РАСХОЖДЕНИЙ: {len(failures)}')
        return 1
    print('Всё сходится.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
