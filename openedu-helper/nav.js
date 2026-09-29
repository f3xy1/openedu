// Кнопки в шапке юнита: «заполнить и отправить» и «забрать решения в набор».
//
// Задания и шапка юнита живут в РАЗНЫХ фреймах: страница курса
// (apps.openedu.ru) рисует оглавление секвенции, а сами задания лежат в
// кросс-доменном iframe (courses.openedu.ru/xblock/...). Поэтому в одном
// фрейме стоит панель со значками, в другом — исполнитель, и разговаривают
// они через window.postMessage.
//
// Почему не chrome.runtime.sendMessage: в манифесте нет service worker, а
// между двумя content-скриптами он не ходит — в ответ приходит «Receiving end
// does not exist». postMessage же доходит до мира расширения в обе стороны
// (проверено на живой вкладке), им же пользуется и сама платформа.
//
// Роль определяется по разметке, а не по адресу: в фрейме с заданиями есть
// div.problems-wrapper, в верхнем — .sequence-navigation-tabs-container. Если
// оба признака в одном фрейме (курс без iframe), панель командует собой
// напрямую, без postMessage.
//
// Файл подключается третьим, после content.js: все три живут в одной области
// видимости, поэтому planFor, applyPlan, harvestBlock, isFilled, bodyOf и
// stemText берутся отсюда как есть — без экспорта и без копий.

const NAV_MARK = 'helper-nav';                  // метка «это наше сообщение»
const NAV_ICON_CLASS = 'helper-nav-icon';
const NAV_PANEL_SELECTOR = '.sequence-navigation-tabs-container';
const NAV_BLOCK_SELECTOR = 'div.problems-wrapper';

// Пауза между отправками: платформа перерисовывает задание после каждой
// проверки, и следующий клик должен идти уже по новому DOM.
const NAV_SUBMIT_PAUSE = 400;
const NAV_TOAST_MS = 9000;
const NAV_PING_MS = 3000;
const NAV_REPORT_TIMEOUT = 20000;

// ── общее ──────────────────────────────────────────────────────────────────
function navHasBlocks() {
    return !!document.querySelector(NAV_BLOCK_SELECTOR);
}

function navPanel() {
    return document.querySelector(NAV_PANEL_SELECTOR);
}

function navBlocks() {
    return Array.from(document.querySelectorAll(NAV_BLOCK_SELECTOR));
}

// Короткая подпись задания для уведомления. В шапке у всех заданий написано
// просто «Задание», различить их можно только по тексту самого вопроса —
// тем же, чем подписывается и запись в базе (stemText).
function navLabel(block, index) {
    const text = block ? cleanText(stemText(bodyOf(block))) : '';
    if (text) return text.length > 44 ? text.slice(0, 43) + '…' : text;
    return `Задание №${index + 1}`;
}

function navPause(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ── исполнитель: фрейм с заданиями ─────────────────────────────────────────
// Что уже отправлено панели. Перерисовка панели — тоже мутация, и без
// сравнения две стороны гоняли бы друг друга по кругу.
let navExecutorSent = '';
let navLastBlocks = null;
let navLastPlans = null;

// Состояние заданий в том виде, в каком оно уходит панели. Поля — ровно те,
// которыми пользуется submitAllowed: панель по ним выбирает значок и
// решает, будет ли нажата «Отправить».
function navStateOf(blocks, plans) {
    return plans.map((plan, index) => {
        if (!plan) return null;
        return {
            matched: plan.matched,
            total: plan.total,
            approx: !!plan.approx,
            conflicts: plan.conflicts || [],
            label: navLabel(blocks[index], index)
        };
    }).filter(Boolean);
}

// Вызывается из processQuestions: планы уже посчитаны там, и второй проход по
// заданиям ради кнопок в шапке не нужен.
function notifyNavState(blocks, plans) {
    if (!blocks.length) return;
    navLastBlocks = blocks;
    navLastPlans = plans;
    navPushState(false);
}

// force — ответ на запрос панели: она могла начать слушать позже, чем мы
// отправили состояние в первый раз, и без этого значки не появились бы вовсе.
// Пустое состояние тоже состояние: юнит без заданий (видеолекция) обязан
// снять значки, иначе панель показывала бы значки прошлого юнита.
function navPushState(force) {
    const state = navLastBlocks ? navStateOf(navLastBlocks, navLastPlans) : [];
    const packed = JSON.stringify(state);
    if (!force && packed === navExecutorSent) return;
    navExecutorSent = packed;
    if (window.parent !== window) {
        window.parent.postMessage({ helper: NAV_MARK, kind: 'state', state: state }, '*');
    } else {
        // Задания и шапка в одном фрейме — панель тут же.
        navRemember(window, state);
    }
}

// Уведомление наверх с итогом работы. Из верхнего фрейма его принимать
// некому — там панель, и она обрабатывает отчёт сама.
function navReport(id, report) {
    if (window.parent !== window) {
        window.parent.postMessage({ helper: NAV_MARK, kind: 'report', id: id, report: report }, '*');
    } else {
        navCollect(id, report);
    }
}

async function navRunCommand(cmd, id) {
    try {
        const answersData = await loadAnswers();
        if (!answersData) {
            navReport(id, { error: 'база ответов не загрузилась' });
            return;
        }
        const report = cmd === 'harvest'
            ? await navHarvestAll(answersData)
            : await navFillAll(answersData);
        navReport(id, report);
    } catch (error) {
        console.error('❌ Кнопка в шапке юнита:', error);
        navReport(id, { error: String((error && error.message) || error) });
    }
}

// Кнопка «Отправить». Тот же селектор, что у syncMatchingState: рядом стоят
// button.show («Show answer») и разбор решения, они ничего не отправляют.
// Заблокированную кнопку не жмём — платформа гасит её, пока не увидит ответ;
// блок ищем заново по индексу, потому что за время ожидания платформа могла
// заменить его целиком.
async function navSubmitButton(index) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const block = navBlocks()[index];
        const button = block ? block.querySelector('button.submit') : null;
        if (button && !button.disabled && !button.classList.contains('is-disabled')) {
            return button;
        }
        await navPause(150);
    }
    return null;
}

// Заполнить все задания страницы и отправить те, где ответ есть целиком.
async function navFillAll(answersData) {
    const report = { kind: 'fill', blocks: [] };
    const total = navBlocks().length;
    for (let index = 0; index < total; index += 1) {
        // Задание берём заново по индексу: после отправки платформа
        // перерисовывает страницу, и ссылки на прежние элементы протухают.
        const block = navBlocks()[index];
        if (!block) continue;
        const label = navLabel(block, index);
        const plan = planFor(block, answersData);
        const add = verdict => report.blocks.push({ label: label, verdict: verdict });
        if (!plan.matched) { add('missing'); continue; }

        // Заполняем всё, что нашли, — даже если отправлять нельзя.
        applyPlan(block, plan);
        if (plan.matched < plan.total) { add('partial'); continue; }
        if (plan.approx) { add('approx'); continue; }
        if ((plan.conflicts || []).length) { add('conflict'); continue; }

        const submit = await navSubmitButton(index);
        if (!submit) { add('blocked'); continue; }
        submit.click();
        add('sent');
        await navPause(NAV_SUBMIT_PAUSE);
    }
    return report;
}

// Забрать решения всех заданий страницы в набор расширения. Запись идёт через
// harvestBlock — тот же код, что и у значка 📋 в шапке задания.
//
// Платформа сказала «неверно» или «частично» — в набор такое не идёт: эта
// кнопка собирает набор пачкой, не глядя, а один неверный ответ потом молча
// перекроет верный в базе («побеждает последняя»). Забрать такое задание
// можно только вручную — значком 📋 у самого задания, то есть осознанно.
async function navHarvestAll(answersData) {
    const report = { kind: 'harvest', blocks: [] };
    let added = 0;
    let updated = 0;
    let kept = 0;
    for (let index = 0; index < navBlocks().length; index += 1) {
        const block = navBlocks()[index];
        if (!block) continue;
        const label = navLabel(block, index);
        const verdict = statusOf(block);
        // Разные исходы называем по-разному: у кнопки заполнения «partial» —
        // это неполный ответ В БАЗЕ, а здесь — вердикт платформы.
        if (verdict === 'wrong') {
            report.blocks.push({ label: label, verdict: 'wrong' });
            continue;
        }
        if (verdict === 'partial') {
            report.blocks.push({ label: label, verdict: 'partly' });
            continue;
        }
        if (!isFilled(bodyOf(block))) {
            report.blocks.push({ label: label, verdict: 'empty' });
            continue;
        }
        const { records, saved } = await harvestBlock(block, answersData);
        if (!records.length || !saved) {
            report.blocks.push({ label: label, verdict: 'empty' });
            continue;
        }
        added += saved.added;
        updated += saved.updated;
        kept = saved.total;
        report.blocks.push({ label: label, verdict: 'taken' });
    }
    if (report.blocks.some(item => item.verdict === 'taken')) {
        report.saved = { added: added, updated: updated, total: kept };
    }
    return report;
}

// ── панель: фрейм с шапкой юнита ───────────────────────────────────────────
// Состояния по источникам. На странице юнита источник один; если заданий-
// фреймов окажется несколько, значки покажут общую картину по ним всем.
const navSources = new Map();

function navRemember(source, state) {
    navSources.set(source, state);
    navRenderIcons();
}

// Живые источники. Окно фрейма исчезает вместе с прежним юнитом, а запись о
// нём в navSources остаётся — на смене юнита платформа пересоздаёт iframe
// целиком. Через это и вылезло «не ответило за 20 с» при полностью собранном
// наборе: команда уходила и в мёртвые окна тоже, отчёта от них не бывает
// никогда, и счётчик ожидания не доходил до нуля. Мёртвые записи заодно
// выкидываем, чтобы не копились.
function navLiveSources() {
    const alive = navChildWindows();
    const live = [];
    Array.from(navSources.keys()).forEach(source => {
        if (source === window) { live.push(source); return; }
        if (alive.indexOf(source) === -1) { navSources.delete(source); return; }
        live.push(source);
    });
    return live;
}

function navStates() {
    const all = [];
    navLiveSources().forEach(source =>
        navSources.get(source).forEach(item => all.push(item)));
    return all;
}

// Значок состояния базы по заданиям страницы: ✅ — ответ есть у каждого,
// ❌ — ни у одного, 🟡 — середина (часть не нашлась, ответ неполный,
// совпадение примерное или слова кроссворда не сходятся). Пустой список —
// заданий на странице нет, значок не нужен.
function navIcon(items) {
    if (!items.length) return '';
    if (items.every(item => submitAllowed(item))) return '✅';
    if (items.every(item => !item.matched)) return '❌';
    return '🟡';
}

const NAV_STATE_NOTE = {
    '✅': 'В базе есть ответы на все задания этой страницы.',
    '🟡': 'В базе есть ответы не на все задания этой страницы — часть останется незаполненной.',
    '❌': 'Ни одного задания этой страницы в базе нет.'
};

function navIconElement(text, title, onPick) {
    const icon = document.createElement('span');
    icon.className = NAV_ICON_CLASS;
    icon.textContent = text;
    icon.title = title;
    icon.style.cursor = 'pointer';
    icon.style.marginLeft = '8px';
    icon.style.fontSize = '18px';
    icon.addEventListener('click', event => {
        // Кнопка юнита по клику переключает юнит — всплытие надо погасить,
        // иначе нажатие на значок заодно уведёт со страницы.
        event.preventDefault();
        event.stopPropagation();
        onPick();
    });
    return icon;
}

function navIcons() {
    const states = navStates();
    if (!states.length) return [];
    const glyph = navIcon(states);
    const fill = navIconElement(glyph,
        NAV_STATE_NOTE[glyph] + ' Нажму «Отправить» там, где ответ есть целиком;'
        + ' где ответ неполный или совпадение примерное — заполню, но отправлять не стану.',
        () => navSendCommand('fill'));
    const harvest = navIconElement('📋',
        'Забрать решения всех заданий страницы в набор новых ответов. Набор потом '
        + 'выгружается из окна расширения (клик по его значку на панели браузера) '
        + 'и сливается с базой скриптом merge-answers.',
        () => navSendCommand('harvest'));
    return [fill, harvest];
}

// Значки живут в активной кнопке юнита: содержимое грузится только с
// активной вкладки, у остальных юнитов заданий на странице просто нет.
// Перерисовываем только при изменении — наши же вставки тоже мутации.
function navRenderIcons() {
    const container = navPanel();
    if (!container) return;
    const button = container.querySelector('button.active');
    // Со сменившегося юнита значки снимаем руками: платформа контейнер
    // перерисовывает, но прежнюю кнопку может и оставить — тогда на ней
    // остались бы значки задания, которого на странице уже нет.
    Array.from(container.querySelectorAll('button')).forEach(item => {
        if (item === button) return;
        Array.from(item.querySelectorAll('span.' + NAV_ICON_CLASS)).forEach(icon => icon.remove());
    });
    if (!button) return;
    const fresh = navIcons();
    const current = Array.from(button.querySelectorAll('span.' + NAV_ICON_CLASS));
    const same = current.length === fresh.length && current.every((icon, index) =>
        icon.textContent === fresh[index].textContent && icon.title === fresh[index].title);
    if (same) return;
    current.forEach(icon => icon.remove());
    fresh.forEach(icon => button.appendChild(icon));
}

let navIconsTimer = null;
function navScheduleIcons() {
    if (navIconsTimer) return;
    navIconsTimer = setTimeout(() => {
        navIconsTimer = null;
        navRenderIcons();
        // Заданий на странице нет, а панели мы о них рассказывали: юнит мог
        // смениться на видеолекцию. Секунду даём платформе — она могла просто
        // перерисовать задание, — и, если оно не вернулось, снимаем значки.
        if (!navHasBlocks() && navLastBlocks) navScheduleClear();
        // Значка нет и потому, что исполнитель ещё не отчитался, — спросим его
        // сами: первое его сообщение могло уйти раньше, чем панель начала
        // слушать, а ждать следующей перерисовки задания можно долго.
        if (navPanel() && !navStates().length) navPing();
    }, 250);
}

let navClearTimer = null;
function navScheduleClear() {
    if (navClearTimer) return;
    navClearTimer = setTimeout(() => {
        navClearTimer = null;
        if (navHasBlocks() || !navLastBlocks) return;
        navLastBlocks = null;
        navLastPlans = null;
        navPushState(false);
    }, 1500);
}

let navPingedAt = 0;
function navPing() {
    const now = Date.now();
    if (now - navPingedAt < NAV_PING_MS) return;
    navPingedAt = now;
    navChildWindows().forEach(win =>
        win.postMessage({ helper: NAV_MARK, kind: 'ping' }, '*'));
}

// Окна фреймов страницы: сообщение во фрейм иначе не доставить.
function navChildWindows() {
    return Array.from(document.querySelectorAll('iframe'))
        .map(frame => {
            try { return frame.contentWindow; } catch (error) { return null; }
        })
        .filter(Boolean);
}

let navCommandId = 0;
let navBusy = false;
const navPending = new Map();

function navSendCommand(cmd) {
    if (navBusy) {
        navShowToast('Подождите', ['Предыдущая кнопка ещё работает.']);
        return;
    }
    const sources = navLiveSources();
    if (!sources.length) return;
    const id = 'nav' + (++navCommandId);
    navBusy = true;
    navPending.set(id, { parts: [], left: sources.length });
    sources.forEach(source => {
        if (source === window) navRunCommand(cmd, id);
        else source.postMessage({ helper: NAV_MARK, kind: 'cmd', id: id, cmd: cmd }, '*');
    });
    // Страховка: если фрейм с заданиями умрёт посреди работы, отчёта не будет,
    // и кнопки остались бы занятыми навсегда.
    setTimeout(() => {
        const pending = navPending.get(id);
        if (!pending) return;
        pending.parts.push({ error: `фрейм с заданиями не ответил за ${NAV_REPORT_TIMEOUT / 1000} с` });
        pending.left = 0;
        navFinish(id);
    }, NAV_REPORT_TIMEOUT);
}

function navFinish(id) {
    const pending = navPending.get(id);
    if (!pending) return;
    navPending.delete(id);
    navBusy = false;
    navShowReport(pending.parts);
}

function navCollect(id, report) {
    const pending = navPending.get(id);
    if (!pending) return;
    pending.parts.push(report);
    pending.left -= 1;
    if (pending.left <= 0) navFinish(id);
}

// ── уведомление ────────────────────────────────────────────────────────────
const NAV_VERDICT = {
    sent: ['✅', 'заполнено и отправлено'],
    partial: ['🟡', 'заполнено не до конца — «Отправить» не нажимал'],
    approx: ['🟠', 'совпадение примерное — «Отправить» не нажимал'],
    conflict: ['⚠️', 'слова не сходятся — «Отправить» не нажимал'],
    blocked: ['⛔', 'кнопка «Отправить» недоступна'],
    missing: ['❌', 'нет в базе'],
    taken: ['📋', 'забрано в набор'],
    empty: ['➖', 'брать нечего — задание не заполнено'],
    wrong: ['⛔', 'платформа отметила НЕВЕРНО — в набор не брал'],
    partly: ['⚠️', 'платформа зачла частично — в набор не брал']
};

function navJoin(labels) {
    const shown = labels.slice(0, 3);
    const rest = labels.length - shown.length;
    return shown.join('; ') + (rest > 0 ? `; и ещё ${rest}` : '');
}

function navLines(blocks) {
    const lines = [];
    Object.keys(NAV_VERDICT).forEach(verdict => {
        const items = blocks.filter(item => item.verdict === verdict);
        if (!items.length) return;
        const [icon, what] = NAV_VERDICT[verdict];
        lines.push(`${icon} ${what}: ${items.length}`);
        // У хороших исходов перечислять задания незачем, у остальных — надо:
        // именно их и пойдёт смотреть пользователь.
        if (verdict !== 'sent' && verdict !== 'taken') {
            lines.push('   ' + navJoin(items.map(item => item.label)));
        }
    });
    return lines;
}

function navShowReport(parts) {
    const blocks = parts.reduce((all, part) => all.concat(part.blocks || []), []);
    const lines = navLines(blocks);
    if (blocks.some(item => item.verdict === 'taken')) {
        const saved = parts.reduce((sum, part) => ({
            added: sum.added + (part.saved ? part.saved.added : 0),
            updated: sum.updated + (part.saved ? part.saved.updated : 0),
            total: part.saved ? part.saved.total : sum.total
        }), { added: 0, updated: 0, total: 0 });
        lines.push(`Итог набора: добавлено ${saved.added}, заменено ${saved.updated}, `
            + `всего ${saved.total}. Выгрузить — клик по значку расширения на панели браузера.`);
    }
    // Отдельно объясняем, что делать с неверными: их можно забрать, но только
    // своими руками и по одному.
    if (blocks.some(item => item.verdict === 'wrong' || item.verdict === 'partly')) {
        lines.push('Эти задания в набор не попали — забрать их можно только вручную, '
            + 'значком 📋 у самого задания.');
    }
    // Ошибку показываем ВМЕСТЕ с итогом, а не вместо него: фрейм мог не
    // ответить уже после того, как всё сделал, и «не получилось» без списка
    // сделанного врёт про результат.
    parts.filter(part => part.error).forEach(part =>
        lines.unshift('⚠️ ' + part.error));
    if (!lines.length) lines.push('Ничего не сделано.');
    // Заголовок — по самой команде, а не по догадке из вердиктов: в отчёте о
    // сборе теперь бывает и «неверно», и по списку вердиктов не угадать, что
    // именно нажимали.
    const kind = (parts.find(part => part.kind) || {}).kind;
    navShowToast(kind === 'harvest' ? 'Решения в набор' : 'Заполнение заданий', lines);
}

let navToastBox = null;
let navToastTimer = null;

function navShowToast(title, lines) {
    if (!navToastBox) {
        navToastBox = document.createElement('div');
        navToastBox.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;'
            + 'max-width:400px;padding:10px 12px;border-radius:8px;cursor:pointer;'
            + 'background:rgba(22,22,28,.95);color:#fff;white-space:pre-wrap;'
            + 'font:13px/1.5 system-ui,Segoe UI,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.4);';
        navToastBox.title = 'Нажмите, чтобы закрыть';
        navToastBox.addEventListener('click', navHideToast);
        document.body.appendChild(navToastBox);
    }
    navToastBox.textContent = [title].concat(lines).join('\n');
    navToastBox.style.display = 'block';
    if (navToastTimer) clearTimeout(navToastTimer);
    navToastTimer = setTimeout(navHideToast, NAV_TOAST_MS);
}

function navHideToast() {
    if (navToastTimer) clearTimeout(navToastTimer);
    navToastTimer = null;
    if (navToastBox) navToastBox.style.display = 'none';
}

// ── приём сообщений ────────────────────────────────────────────────────────
// Приказ принимаем только «сверху»: страница курса — родитель фрейма с
// заданиями, и командовать заданиями со стороны не должен никто другой.
function navExecutorMessage(event, data) {
    if (event.source !== window.parent || !navHasBlocks()) return;
    if (data.kind === 'ping') { navPushState(true); return; }
    navRunCommand(data.cmd, data.id);
}

// Отчёты принимаем только от фреймов этой же страницы.
function navPanelMessage(event, data) {
    if (!navPanel() || navChildWindows().indexOf(event.source) === -1) return;
    if (data.kind === 'state') navRemember(event.source, data.state);
    else navCollect(data.id, data.report);
}

window.addEventListener('message', event => {
    const data = event.data;
    if (!data || data.helper !== NAV_MARK) return;
    if (data.kind === 'cmd' || data.kind === 'ping') navExecutorMessage(event, data);
    else navPanelMessage(event, data);
});

const navObserver = new MutationObserver(navScheduleIcons);
navObserver.observe(document.body, { childList: true, subtree: true });
navScheduleIcons();
