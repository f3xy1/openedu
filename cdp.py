# -*- coding: utf-8 -*-
"""Мост к вкладке браузера через Chrome DevTools Protocol.

Зачем: расширение OpenEdu Helper работает внутри страницы курса, и проверить
его на живой странице можно только изнутри той же вкладки. Скрипт подключается
к уже открытой вкладке — вход в курс и авторизация остаются вашими, скрипт их
не трогает.

Зависимости:  python -m pip install -r requirements.txt   (нужен websocket-client)

Браузер надо запустить с открытым портом отладки, иначе подключаться некуда.
Проще всего готовым скриптом из корня проекта — browser-debug.cmd (или .ps1):
он проверит, что браузер ещё не запущен, запустит его и дождётся порта.
Вручную то же самое выглядит так:

    start "" "%LOCALAPPDATA%\\Vivaldi\\Application\\vivaldi.exe" --remote-debugging-port=9222
    # Chrome/Edge — точно так же, своим путём к exe

Флаг читается только при СТАРТЕ браузера: если он уже запущен, команда просто
откроет окно в текущем процессе и порт не появится.

Порт слушается только на localhost. Открывать его на постоянной основе не
стоит: пока он открыт, любая программа на машине может управлять вкладками.

    python cdp.py tabs                 — список вкладок
    python cdp.py eval "<js>"          — выполнить JS в мире страницы
    python cdp.py ctx                  — список контекстов (ищем мир расширения)
    python cdp.py ext "<js>"           — выполнить JS в мире content-скрипта
    python cdp.py js file.js           — выполнить JS из файла

Вкладка выбирается через --tab N (номер из `tabs`) или --url подстрока.
Ключ --gesture имитирует действие пользователя: без него браузер отказывает
в том, что требует «жеста», — например, в записи в буфер обмена.
Переменные окружения: CDP_PORT (по умолчанию 9222), CDP_TIMEOUT (секунды).
"""
import sys, io, json, argparse, os, urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')
PORT = int(os.environ.get('CDP_PORT', '9222'))
TIMEOUT = float(os.environ.get('CDP_TIMEOUT', '30'))


def http(path):
    with urllib.request.urlopen(f'http://127.0.0.1:{PORT}{path}', timeout=5) as r:
        return json.loads(r.read().decode('utf-8'))


def pages():
    return [t for t in http('/json') if t.get('type') == 'page']


class Tab:
    """Одно подключение к вкладке. Всё общение — через send()."""

    def __init__(self, target):
        import websocket
        # suppress_origin: Chromium отклоняет WS-подключение с заголовком
        # Origin, если не передан --remote-allow-origins. Без Origin пускает.
        self.ws = websocket.create_connection(target['webSocketDebuggerUrl'],
                                              timeout=TIMEOUT,
                                              suppress_origin=True,
                                              max_size=64 * 1024 * 1024)
        self.n = 0
        self.events = []

    def send(self, method, **params):
        self.n += 1
        mid = self.n
        self.ws.send(json.dumps({'id': mid, 'method': method, 'params': params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get('id') == mid:
                if 'error' in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get('result', {})
            if 'method' in msg:
                self.events.append(msg)

    def evaluate(self, expr, context_id=None, gesture=False):
        params = {'expression': expr, 'returnByValue': True, 'awaitPromise': True}
        if context_id is not None:
            params['contextId'] = context_id
        # userGesture: имитация действия пользователя. Нужна там, где браузер
        # требует «жест» — например, для записи в буфер обмена.
        if gesture:
            params['userGesture'] = True
        res = self.send('Runtime.evaluate', **params)
        if 'exceptionDetails' in res:
            d = res['exceptionDetails']
            txt = (d.get('exception') or {}).get('description') or d.get('text')
            return {'__error__': txt}
        return res.get('result', {}).get('value')

    def contexts(self):
        """Контексты выполнения: мир страницы и изолированные миры расширений."""
        self.send('Runtime.enable')
        self.send('Page.enable')
        self.ws.settimeout(1.5)
        try:
            while True:
                self.ws.recv()
        except Exception:                                  # noqa: BLE001
            pass
        finally:
            self.ws.settimeout(TIMEOUT)
        # frameId -> url, чтобы понимать, в каком фрейме живёт контекст
        urls = {}
        try:
            def walk(node):
                fr = node.get('frame', {})
                urls[fr.get('id')] = fr.get('url', '')
                for ch in node.get('childFrames', []) or []:
                    walk(ch)
            walk(self.send('Page.getFrameTree').get('frameTree', {}))
        except Exception:                                  # noqa: BLE001
            pass
        out = []
        for e in self.events:
            if e.get('method') != 'Runtime.executionContextCreated':
                continue
            c = e['params']['context']
            aux = c.get('auxData', {})
            fid = aux.get('frameId', '')
            out.append({'id': c['id'], 'name': c.get('name', ''),
                        'origin': c.get('origin', ''),
                        'isDefault': aux.get('isDefault', False),
                        'type': aux.get('type', ''),
                        'frameId': fid,
                        'frame': urls.get(fid, '')[:70]})
        return out

    def close(self):
        try:
            self.ws.close()
        except Exception:                                  # noqa: BLE001
            pass


def pick(args):
    ps = pages()
    if not ps:
        sys.exit('Нет открытых вкладок. Vivaldi запущен с --remote-debugging-port=9222?')
    if args.url:
        m = [p for p in ps if args.url.lower() in (p.get('url', '') + p.get('title', '')).lower()]
        if not m:
            sys.exit(f'Вкладка с {args.url!r} не найдена. Есть:\n' + brief(ps))
        return m[0]
    if args.tab is not None:
        if not 0 <= args.tab < len(ps):
            sys.exit(f'Вкладки №{args.tab} нет. Есть:\n' + brief(ps))
        return ps[args.tab]
    return ps[0]


def brief(ps):
    return '\n'.join(f"  [{i}] {p.get('title','')[:60]}  {p.get('url','')[:80]}"
                     for i, p in enumerate(ps))


def show(v):
    if isinstance(v, (dict, list)):
        print(json.dumps(v, ensure_ascii=False, indent=1))
    else:
        print(v)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['tabs', 'eval', 'ctx', 'ext', 'js'])
    ap.add_argument('arg', nargs='?')
    ap.add_argument('--tab', type=int)
    ap.add_argument('--url')
    ap.add_argument('--ctx', type=int, help='id контекста для ext')
    ap.add_argument('--name', help='подстрока имени мира расширения для ext')
    ap.add_argument('--gesture', action='store_true',
                    help='с имитацией жеста пользователя (нужно для проверки буфера обмена)')
    a = ap.parse_args()

    if a.cmd == 'tabs':
        ps = pages()
        if not ps:
            sys.exit('Нет открытых вкладок. Vivaldi запущен с --remote-debugging-port=9222?')
        print(f'Вкладок: {len(ps)}')
        print(brief(ps))
        return

    t = Tab(pick(a))
    try:
        if a.cmd == 'ctx':
            show(t.contexts())
        elif a.cmd == 'eval':
            show(t.evaluate(a.arg, context_id=a.ctx, gesture=a.gesture))
        elif a.cmd == 'js':
            with open(a.arg, encoding='utf-8') as f:
                show(t.evaluate(f.read(), context_id=a.ctx, gesture=a.gesture))
        elif a.cmd == 'ext':
            if a.ctx is not None:
                show(t.evaluate(a.arg, context_id=a.ctx, gesture=a.gesture))
            else:
                cs = t.contexts()
                if a.name:
                    cs = [c for c in cs if a.name.lower() in c['name'].lower()]
                else:
                    # встроенные миры самого Vivaldi нам не нужны
                    cs = [c for c in cs
                          if not c['isDefault'] and not c['name'].startswith('Vivaldi')]
                if not cs:
                    sys.exit('Изолированных миров нет — расширение не внедрено '
                             'на эту вкладку? Запусти `ctx`, чтобы посмотреть.')
                if len(cs) > 1:
                    print('[i] миров несколько, беру последний. Выбери --ctx:')
                    for c in cs:
                        print(f"    ctx {c['id']}: {c['name']}")
                show(t.evaluate(a.arg, context_id=cs[-1]['id'], gesture=a.gesture))
    finally:
        t.close()


if __name__ == '__main__':
    main()
