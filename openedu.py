# -*- coding: utf-8 -*-
"""Единая точка входа в скрипты проекта.

Зачем: в корне лежит десяток скриптов, и держать в голове, какой из них что
делает и какие ключи принимает, — отдельная работа. Здесь они собраны в одно
меню: консоль спрашивает, что сделать и с каким файлом, и запускает нужный
скрипт.

    python openedu.py                 меню
    python openedu.py файл.docx       файл подставится в запросы о файле
    python openedu.py --help          то же, что этот текст

Скрипты остаются самостоятельными: меню только передаёт им аргументы и перед
запуском печатает получившуюся команду. Поэтому любую строку «> ...» можно
повторить руками, а пункт меню ничего не умеет сверх своего скрипта — он и не
должен: правила сравнения вопросов и запись базы живут в одном месте
(qa_norm.py), а не здесь.

Запуск отдельным процессом, а не импортом: у каждого скрипта свой разбор
аргументов и своя настройка консоли, и падение одного не должно ронять меню.

Меню возвращается после каждого пункта — за один запуск можно сделать сколько
угодно дел. Двойной клик по openedu.cmd делает то же самое.
"""
import difflib
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import qa_norm                                           # noqa: E402

# Тем же питоном, которым запущено меню: если проект запускают из venv, то и
# скрипты должны пойти из него, а не из первого python в PATH.
PY = sys.executable

# Файл, переданный в командной строке (он же — перетащенный на openedu.cmd).
FILE_ARG = ''


# ── ввод ────────────────────────────────────────────────────────────────────
def _decode(raw):
    """Разобрать строку из консоли.

    Windows отдаёт ввод в своей кодировке. openedu.cmd переключает консоль на
    UTF-8 (chcp 65001), но при запуске `python openedu.py` из обычной консоли
    путь с кириллицей придёт в cp866 — и файл, который на самом деле есть,
    «не найдётся». Тем же болеет resolve_docx в docx_image_answers.py.
    """
    raw = raw.rstrip(b'\r\n')
    for encoding in ('utf-8', 'cp866', 'cp1251'):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode('utf-8', 'replace')


def _read_raw():
    """Строка из консоли байтами: кодировку разберём после (см. _decode)."""
    stream = getattr(sys.stdin, 'buffer', None)
    if stream is None:                       # stdin подменён (IDE, конвейер)
        return (input() or '').encode('utf-8') + b'\n'
    return stream.readline()


def ask(prompt, default='', hint=''):
    """Спросить строку. Пустой ответ — это default; он же виден в подсказке."""
    tail = f' [{default}]' if default else ''
    if hint:
        tail += f' {hint}'
    sys.stdout.write(f'{prompt}{tail}: ')
    sys.stdout.flush()
    raw = _read_raw()
    if not raw:
        # Ввод кончился: конвейер дочитан или нажат Ctrl+Z. Выходим тихо —
        # меню гоняют и из скрипта, ронять его трейсбеком незачем.
        print()
        raise SystemExit(0)
    return _decode(raw).strip() or default


def ask_yes_no(prompt, default=False):
    """Да/нет. Пустой ответ — default; он же показан заглавной буквой."""
    while True:
        line = ask(f'{prompt} ({"Y/n" if default else "y/N"})').lower()
        if not line:
            return default
        if line in ('y', 'yes', 'д', 'да'):
            return True
        if line in ('n', 'no', 'н', 'нет'):
            return False
        print('    Ответьте y (да) или n (нет).')


def unquote(text):
    """Снять кавычки: перетащенный в консоль файл приходит как "C:\\путь\\файл"."""
    text = text.strip()
    if len(text) > 1 and text[0] == text[-1] and text[0] in '"\'':
        return text[1:-1].strip()
    return text


def close_names(path):
    """Похожие имена в том же каталоге.

    «Файла нет» часто означает не отсутствие файла, а поехавший путь — кавычки
    или кодировка при копировании. Показать соседей полезнее, чем просто
    повторить вопрос.
    """
    folder = os.path.dirname(os.path.abspath(path)) or '.'
    if not os.path.isdir(folder):
        return []
    ext = os.path.splitext(path)[1].lower()
    names = [n for n in os.listdir(folder)
             if n.lower().endswith(ext) and not n.startswith('~$')]
    close = difflib.get_close_matches(os.path.basename(path).lower(),
                                      [n.lower() for n in names],
                                      n=3, cutoff=0.4)
    return [n for n in names if n.lower() in close]


def ask_path(prompt, default='', exts=(), must_exist=True, allow_empty=False,
             hint=''):
    """Спросить путь к файлу и проверить его здесь же.

    Проверка до запуска скрипта — чтобы вместо чужой ошибки «файл не найден»
    после начала работы получить понятный вопрос ещё до неё.
    """
    while True:
        line = unquote(ask(prompt, default, hint))
        if not line:
            if allow_empty:
                return ''
            print('    Нужен путь к файлу.')
            continue
        if exts and not line.lower().endswith(exts):
            print(f'    Нужен {" или ".join(exts)}, а не «{line}».')
            continue
        if must_exist and not os.path.exists(line):
            print(f'    Не нахожу: {line}')
            near = close_names(line)
            if near:
                print('    В том же каталоге есть:')
                for name in near:
                    print(f'      {name}')
            continue
        return line


# ── запуск ──────────────────────────────────────────────────────────────────
def show_cmd(cmd):
    """Напечатать команду так, как её набрал бы человек.

    Это не украшение: увидев строку, ту же работу можно повторить без меню —
    или, наоборот, убедиться, что меню собрало ровно то, что задумано.
    """
    parts = [f'"{part}"' if ' ' in part else part for part in cmd]
    print('> ' + ' '.join(parts))


def run(cmd, ok=(0,)):
    """Выполнить команду, унаследовав консоль: вывод идёт прямо в неё.

    ok — коды, которые неудачей не считаются. Единственный такой в проекте —
    1 у dedupe-answers.py --check: это ответ «дубликаты есть», а не ошибка
    (ошибки выходят кодом 2, см. qa_norm.die).
    """
    show_cmd(cmd)
    print()
    # Сбросить буфер до запуска: у дочернего процесса свой вывод, и без этого
    # строка «> ...» при перенаправлении вывода оказалась бы ПОСЛЕ него.
    sys.stdout.flush()
    try:
        code = subprocess.call(cmd, cwd=HERE)
    except FileNotFoundError as error:
        print(f'\n[!] Не запустилось: {error}')
        return 127
    except KeyboardInterrupt:
        print('\n[!] Прервано.')
        return 130
    if code not in ok:
        print(f'\n[!] Вернулся код {code} — смотрите вывод выше.')
    return code


def run_py(script, *args, ok=(0,)):
    """Скрипт проекта — как отдельный процесс."""
    return run([PY, os.path.join(HERE, script)] + [str(a) for a in args], ok=ok)


def run_cmd(batch, *args):
    """Пакетный файл проекта — сейчас такой один, browser-debug.cmd.

    Через cmd /c и списком аргументов: строку с кавычками Git Bash калечит,
    а список доходит как есть.
    """
    if os.name != 'nt':
        print(f'[!] {batch} — это Windows-командный файл, здесь он не пойдёт. '
              f'Наберите его команды вручную.')
        return 1
    return run(['cmd', '/c', os.path.join(HERE, batch)] + [str(a) for a in args])


def file_arg(*exts):
    """Файл из командной строки, если он годится этому действию.

    Так работает перетаскивание на openedu.cmd: файл подставляется в вопрос,
    и остаётся только нажать Enter.
    """
    if FILE_ARG and (not exts or FILE_ARG.lower().endswith(exts)):
        return FILE_ARG
    return ''


def confirm_overwrite(path):
    """Не затирать существующий файл молча.

    База ответов — единственная копия накопленного: скрипты слияния и чистки
    копию делают сами, а converter.py и сборка пишут файл как есть.
    """
    if not os.path.exists(path):
        return True
    return ask_yes_no(f'{os.path.abspath(path)} уже есть — перезаписать?',
                      default=False)


# ── действия ────────────────────────────────────────────────────────────────
def act_merge():
    """Дописать в базу набор, выгруженный из окна расширения."""
    print('    Пройдите тест, отметьте незнакомые задания значком 📋, затем в')
    print('    окне расширения нажмите «Экспорт». Свежий answers-new.json')
    print('    скрипт найдёт сам — в корне проекта и в «Загрузках».')
    export = ask_path('Файл набора (answers-new.json)', default=file_arg('.json'),
                      exts=('.json',), allow_empty=True,
                      hint='Enter — найти самому')
    args = [export] if export else []
    if ask_yes_no('Только показать, не записывать (--dry-run)?', default=False):
        args.append('--dry-run')
    run_py('merge-answers.py', *args)


def act_dedupe():
    """Убрать из базы повторы вопросов, оставив последнюю запись."""
    base = ask_path('База для проверки', default=qa_norm.DEFAULT_BASE,
                    exts=('.json',))
    if not ask_yes_no('Сначала только показать, файл не трогать (--check)?',
                      default=True):
        run_py('dedupe-answers.py', '--base', base)
        return
    code = run_py('dedupe-answers.py', '--base', base, '--check', ok=(0, 1))
    # Код 1 — «дубликаты есть», 0 — база чистая (см. шапку dedupe-answers.py).
    # На чистой базе про удаление не спрашиваем: удалять нечего.
    if code != 1:
        return
    # Дубликат с ДРУГИМ ответом стоит прочитать глазами — ради этого --check и
    # делается отдельным шагом.
    if ask_yes_no('Удалить найденные дубликаты?', default=False):
        run_py('dedupe-answers.py', '--base', base)


def act_converter():
    """Разобрать docx/pdf, размеченный «•» (вопрос) и «+» (верный ответ)."""
    src = ask_path('Файл с маркерами • и +', default=file_arg('.docx', '.pdf'),
                   exts=('.docx', '.pdf'))
    if src.lower().endswith('.pdf'):
        print('    Для PDF нужен pdfplumber: python -m pip install pdfplumber')
    out = ask('Куда записать JSON', default='answers.json')
    if not confirm_overwrite(out):
        print('    Отменено — файл не тронут.')
        return
    run_py('converter.py', src, out)
    print()
    print(f'    Дальше: {out} — отдельный файл, в базу он сам не попадает.')
    print('    Сверить его с базой можно пунктом «Слить выгруженный набор».')


def act_answer_parser():
    """Показать, что нашлось в docx с жёлтой заливкой. Ничего не пишет."""
    src = ask_path('Docx с жёлтой заливкой', default=file_arg('.docx'),
                   exts=('.docx',))
    print('    Смотрю, что размечено жёлтым. Файлы не трогаются — это сверка')
    print('    разбора глазами перед сборкой базы.')
    run_py('answer-parser.py', src)


def act_extract():
    """Найти в docx зелёные рамки и нарезать ответы на картинки."""
    src = ask_path('Docx со скриншотами (ДОПОЛНЕН_....docx)',
                   default=file_arg('.docx'), exts=('.docx',))
    work = ask('Рабочая папка для нарезки и расшифровки', default='docx_out')
    run_py('docx_image_answers.py', 'extract', src, '--work', work)
    print()
    print(f'    Дальше: посмотрите {os.path.join(work, "sheets")}, впишите')
    print(f'    ответы в {os.path.join(work, "transcribe.json")} и вернитесь')
    print('    в меню к пункту сборки базы.')


def act_build():
    """Собрать JSON из расшифровки, сделанной на шаге разбора."""
    work = ask('Рабочая папка (из шага разбора)', default='docx_out')
    if not os.path.exists(os.path.join(work, 'transcribe.json')):
        print(f'    Не вижу {os.path.join(work, "transcribe.json")} —')
        print('    похоже, разбор ещё не сделан.')
        if not ask_yes_no('Всё равно продолжить?', default=False):
            return
    src = ask_path('Docx (по нему однотипные подвопросы привязываются '
                   'к описанию ситуации)', default=file_arg('.docx'),
                   exts=('.docx',), allow_empty=True, hint='Enter — пропустить')
    out = ask('Куда записать JSON', default='answers.json')
    if not confirm_overwrite(out):
        print('    Отменено — файл не тронут.')
        return
    args = ['build', '--work', work, '--out', out]
    merge = ask_path('Дописать к существующему JSON', exts=('.json',),
                     allow_empty=True, hint='Enter — не дописывать')
    if merge:
        args += ['--merge', merge]
        if ask_yes_no('Ответы из docx перекрывают старые (--refresh)?',
                      default=False):
            args.append('--refresh')
    if src:
        args.append(src)
    run_py('docx_image_answers.py', *args)


def act_browser_debug():
    """Запустить браузер с портом отладки — без него cdp.py не подключится."""
    print('    Порт читается только при СТАРТЕ браузера: если он уже запущен,')
    print('    окно откроется в текущем процессе и порта не будет.')
    print('    Путь к браузеру — в переменной BROWSER в файле browser-debug.cmd.')
    if ask_yes_no('Запускаем?', default=True):
        run_cmd('browser-debug.cmd')


CDP_CHOICES = [
    ('tabs', 'Список вкладок'),
    ('ctx', 'Список контекстов (ищем мир расширения)'),
    ('eval', 'Выполнить JS в мире страницы'),
    ('ext', 'Выполнить JS в мире content-скрипта'),
    ('js', 'Выполнить JS из файла'),
]


def tab_args():
    """Какую вкладку взять: номер из списка `tabs` или подстрока адреса."""
    line = ask('Вкладка: номер или подстрока адреса', hint='Enter — первая')
    if not line:
        return []
    return ['--tab', line] if line.isdigit() else ['--url', line]


def act_cdp():
    """Подключиться к уже открытой вкладке (Chrome DevTools Protocol)."""
    print('    Вход в курс и авторизация остаются вашими — скрипт только')
    print('    подключается к вкладке, которая уже открыта в браузере.')
    print()
    for number, (name, title) in enumerate(CDP_CHOICES, 1):
        print(f'      {number}. {title}  ({name})')
    choice = ask('Что делаем', default='1')
    if not choice.isdigit() or not 1 <= int(choice) <= len(CDP_CHOICES):
        print('    Не понял выбор.')
        return
    cmd = CDP_CHOICES[int(choice) - 1][0]
    args = [cmd]
    if cmd == 'js':
        args.append(ask_path('Файл с JS', default=file_arg('.js'),
                             exts=('.js',)))
    elif cmd in ('eval', 'ext'):
        code = ask('JS одной строкой', hint='например: document.title')
        if not code:
            print('    Пустой JS — нечего выполнять.')
            return
        args.append(code)
    if cmd in ('eval', 'ext', 'js', 'ctx'):
        args += tab_args()
    if cmd in ('eval', 'ext', 'js'):
        print('    Жест нужен там, где браузер требует действия пользователя,')
        print('    например для записи в буфер обмена.')
        if ask_yes_no('С имитацией жеста (--gesture)?', default=False):
            args.append('--gesture')
    run_py('cdp.py', *args)


# Единственное место, где перечислены проверки проекта: отдельного
# tests/run-all.cmd больше нет — это был тот же список, только без общего
# итога в конце, и списки могли разъехаться.
CHECKS = [
    ('python', 'tests/test_norm_parity.py',
     'Правила сравнения текста: браузер и скрипты'),
    ('node', 'tests/test_content_logic.js', 'Поиск ответа на странице'),
    ('node', 'tests/test_popup_logic.js', 'Окно расширения'),
    ('python', 'tests/test_scripts_fixture.py', 'Слияние и чистка базы (на копии)'),
    ('node', 'tests/test_no_dead_code.js', 'Потерянные вызовы в коде расширения'),
]


def act_tests():
    """Прогнать все проверки проекта."""
    print('    Ничего не меняется и никуда не пишется — проверки на то и')
    print('    проверки. Нужны python и node.')
    if not ask_yes_no('Запускаем?', default=True):
        return
    node = shutil.which('node')
    failed = []
    for kind, script, title in CHECKS:
        print(f'\n=== {title} ' + '=' * max(0, 58 - len(title)))
        if kind == 'node' and not node:
            print('[!] node не найден — проверка пропущена.')
            failed.append(title)
            continue
        if run([PY if kind == 'python' else node, os.path.join(HERE, script)]):
            failed.append(title)
    print()
    if failed:
        print(f'[!] Не сошлось: {len(failed)} из {len(CHECKS)} — '
              + '; '.join(failed))
    else:
        print(f'Всё сошлось: проверок пройдено {len(CHECKS)}.')


# ── меню ────────────────────────────────────────────────────────────────────
# Порядок — по ходу работы: сначала база, потом разбор документов, потом
# живая страница, и в конце проверки.
SECTIONS = [
    ('База ответов', [
        ('Слить выгруженный набор в базу', 'merge-answers.py', act_merge),
        ('Проверить базу на дубликаты', 'dedupe-answers.py', act_dedupe),
    ]),
    ('Разбор документов с ответами', [
        ('Docx/pdf с маркерами • и +', 'converter.py', act_converter),
        ('Docx с жёлтой заливкой — показать', 'answer-parser.py',
         act_answer_parser),
        ('Docx со скриншотами — разбор', 'docx_image_answers.py extract',
         act_extract),
        ('Docx со скриншотами — сборка', 'docx_image_answers.py build',
         act_build),
    ]),
    ('Живая страница курса', [
        ('Запустить браузер с портом отладки', 'browser-debug.cmd',
         act_browser_debug),
        ('Выполнить JS во вкладке', 'cdp.py', act_cdp),
    ]),
    ('Проверки', [
        ('Все проверки проекта', 'tests/test_*.py, *.js', act_tests),
    ]),
]

MENU_WIDTH = 82


def show_menu():
    """Напечатать меню и вернуть {номер: (название, что запускать)}."""
    by_number = {}
    print()
    print('=' * MENU_WIDTH)
    print('  Openedu Helper — что делаем?')
    print('=' * MENU_WIDTH)
    for section, actions in SECTIONS:
        print(f'\n  {section}')
        for title, script, func in actions:
            number = len(by_number) + 1
            by_number[number] = (title, func)
            print(f'    {number}. {title:<42}  {script}')
    print('\n    0. Выход')
    return by_number


EXIT_WORDS = ('0', 'q', 'й', 'exit', 'выход')


def main():
    qa_norm.setup_console()
    global FILE_ARG
    for arg in sys.argv[1:]:
        if arg in ('-h', '--help'):
            print(__doc__)
            return 0
        if not arg.startswith('-'):
            FILE_ARG = unquote(arg)
    if FILE_ARG:
        print(f'Файл из командной строки: {FILE_ARG}')

    while True:
        by_number = show_menu()
        if FILE_ARG:
            print(f'\n  Файл {os.path.basename(FILE_ARG)} подставится в те')
            print('  вопросы, где он подходит по расширению.')
        try:
            line = ask('\nПункт')
        except KeyboardInterrupt:
            print('\nВыход.')
            return 0
        if not line:
            continue
        if line.lower() in EXIT_WORDS:
            print('Выход.')
            return 0
        if not line.isdigit() or int(line) not in by_number:
            print(f'    Нет пункта «{line}» — введите номер из списка.')
            continue

        title, func = by_number[int(line)]
        print()
        print('─' * MENU_WIDTH)
        print(f'{title}')
        print('─' * MENU_WIDTH)
        try:
            func()
        except KeyboardInterrupt:
            print('\n[!] Прервано — возвращаюсь в меню.')
        # Пауза перед меню: вывод длинного отчёта надо успеть прочитать.
        try:
            answer = ask('\nEnter — вернуться в меню (q — выход)')
        except KeyboardInterrupt:
            print('\nВыход.')
            return 0
        if answer.lower() in EXIT_WORDS:
            print('Выход.')
            return 0


if __name__ == '__main__':
    sys.exit(main())
