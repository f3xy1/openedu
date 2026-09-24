# -*- coding: utf-8 -*-
"""Проверка скриптов базы на КОПИИ живой базы, а не на ней самой.

    python tests/test_scripts_fixture.py

Скрипты слияния и чистки — единственные в проекте, которые ПЕРЕЗАПИСЫВАЮТ
answers.json, и проверять их на настоящей базе нельзя. Поэтому здесь копия
базы во временной папке, к ней искусственные записи, а живую базу скрипт в
конце сверяет по хешу: если она изменилась, значит кто-то из проверяемых
скриптов промахнулся мимо --base.

Что проверяется:
  1) вопрос, уже известный базе, не добавляется второй раз, даже если пришёл с
     другими кавычками (раньше «ёлочки» и обычные кавычки давали разные ключи);
  2) тот же вопрос с ДРУГИМ ответом — обновляет запись, а не дописывает её;
  3) служебные поля расширения (_at, _source) в базу не попадают;
  4) запись файла каноническая (повторная запись даёт байт в байт тот же файл);
  5) dedupe оставляет ПОСЛЕДНЮЮ запись и печатает полные тексты и оба ответа.
"""
import hashlib
import io
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import qa_norm

PY = sys.executable

failed = 0
passed = 0


def check(name, condition, detail=None):
    global failed, passed
    if condition:
        passed += 1
    else:
        failed += 1
        print(f'❌ {name}' + (f'  — {detail}' if detail else ''))


def run(script, *args):
    """Запуск скрипта проекта как отдельного процесса: проверяем его целиком,
    вместе с разбором аргументов и печатью."""
    result = subprocess.run([PY, os.path.join(ROOT, script)] + list(args),
                            capture_output=True, cwd=ROOT)
    out = result.stdout.decode('utf-8', 'replace')
    err = result.stderr.decode('utf-8', 'replace')
    if result.returncode != 0:
        print(f'--- {script} упал ---\n{out}\n{err}')
    return result.returncode, out


def digest(path):
    with open(path, 'rb') as handle:
        return hashlib.md5(handle.read()).hexdigest()


def quote_swap(text):
    """Обычные кавычки -> «ёлочки» и обратно: текст тот же, написание другое."""
    if '"' in text:
        out = []
        opening = True
        for char in text:
            if char == '"':
                out.append('«' if opening else '»')
                opening = not opening
            else:
                out.append(char)
        return ''.join(out)
    return text.replace('«', '"').replace('»', '"')


def pick_quoted(records):
    """Запись базы, в тексте которой есть кавычки: на ней видно, что кавычки
    перестали влиять на ключ."""
    for index, record in enumerate(records):
        if '"' in record.get('question', ''):
            return index, record
    raise SystemExit('[!] В базе не нашлось вопроса с кавычками — фикстур не собрать')


def main():
    qa_norm.setup_console()
    live = qa_norm.DEFAULT_BASE
    live_before = digest(live)
    base = qa_norm.load_base(live)

    quoted_at, quoted = pick_quoted(base)
    fresh_answer = 'ОТВЕТ ИЗ ФИКСТУРА'

    room = tempfile.mkdtemp(prefix='opendu-fixture-')
    try:
        copy = os.path.join(room, 'answers.json')
        shutil.copyfile(live, copy)

        # Набор, как его выгрузило бы расширение.
        export = os.path.join(room, 'answers-new.json')
        incoming = [
            # 1. Известный вопрос, переписанный «ёлочками»: та же запись.
            {'question': quote_swap(quoted['question']),
             'answer': quoted['answer'], '_at': '2026-09-01', '_source': 'test'},
            # 2. Тот же вопрос с другим ответом: обновление, не добавление.
            {'question': quoted['question'], 'answer': fresh_answer,
             '_at': '2026-09-01', '_source': 'test'},
            # 3. Совсем новый вопрос.
            {'question': 'Фикстурный вопрос, которого в базе нет?',
             'answer': 'да', '_at': '2026-09-01', '_source': 'test'}
        ]
        with io.open(export, 'w', encoding='utf-8', newline='') as handle:
            handle.write(qa_norm.render_base(incoming))

        code, out = run('merge-answers.py', export, '--base', copy)
        check('слияние завершилось без ошибки', code == 0, out.strip()[-400:])
        check('о новом вопросе отчиталось как о добавлении', 'Добавить (1)' in out, out)
        check('о повторе отчиталось как об обновлении', 'Обновить (1)' in out, out)
        check('«ёлочки» опознаны как уже известный вопрос',
              'Пропущено повторов: 1' in out, out)

        merged = qa_norm.load_base(copy)
        check('прибавилась ровно одна запись', len(merged) == len(base) + 1,
              f'было {len(base)}, стало {len(merged)}')

        key = qa_norm.record_key(quoted)
        same_key = [r for r in merged if qa_norm.record_key(r) == key]
        check('у вопроса с кавычками по-прежнему одна запись',
              len(same_key) == 1, f'записей: {len(same_key)}')
        check('победил ответ из набора',
              same_key and qa_norm.answer_equal(same_key[0]['answer'], fresh_answer),
              str(same_key[0]['answer']) if same_key else '')
        check('служебные поля расширения в базу не просочились',
              not any(field in r for r in merged
                      for field in ('_at', '_source')))

        # Запись каноническая: прочитать и записать обратно — тот же файл.
        before = digest(copy)
        qa_norm.write_base(copy, merged)
        check('файл базы канонический (перезапись байт в байт)', digest(copy) == before)

        # ── dedupe ────────────────────────────────────────────────────────
        # Живая база дубликатов не содержит, поэтому подкладываем свой: тот же
        # вопрос ещё раз, с новым ответом, В КОНЦЕ файла — он и должен победить.
        doubled = merged + [{'question': quoted['question'],
                             'answer': 'ПОСЛЕДНЯЯ ЗАПИСЬ'}]
        qa_norm.write_base(copy, doubled)

        code, out = run('dedupe-answers.py', '--base', copy, '--check')
        check('--check без ошибки', code == 0, out.strip()[-400:])
        check('--check нашёл дубликат', 'дубликат' in out.lower(), out)
        check('--check печатает полный текст вопроса',
              quote_swap(quoted['question'])[:40] in out
              or quoted['question'][:40] in out, out[:600])
        check('--check печатает оба ответа',
              fresh_answer in out and 'ПОСЛЕДНЯЯ ЗАПИСЬ' in out, out[:600])
        check('--check файл не тронул', len(qa_norm.load_base(copy)) == len(doubled))

        code, out = run('dedupe-answers.py', '--base', copy)
        check('чистка без ошибки', code == 0, out.strip()[-400:])
        cleaned = qa_norm.load_base(copy)
        check('лишняя запись удалена', len(cleaned) == len(merged),
              f'осталось {len(cleaned)}')
        winners = [r for r in cleaned if qa_norm.record_key(r) == key]
        check('оставлена ПОСЛЕДНЯЯ запись',
              winners and qa_norm.answer_equal(winners[0]['answer'], 'ПОСЛЕДНЯЯ ЗАПИСЬ'),
              str(winners[0]['answer']) if winners else 'записи нет')
        check('резервная копия рядом с базой',
              os.path.exists(copy + '.bak'))
    finally:
        shutil.rmtree(room, ignore_errors=True)

    check('живая база не тронута', digest(live) == live_before)

    print(f'\n{"❌ Провалено: " + str(failed) + ", пройдено: " + str(passed) if failed else "✅ Всё сходится. Проверок пройдено: " + str(passed)}')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
