# -*- coding: utf-8 -*-
"""Показать вопросы и ответы, размеченные в docx жёлтой заливкой.

Скрипт ничего не пишет — только печатает, что нашлось, чтобы глазами проверить
разбор перед тем, как отдавать его в базу. Поэтому здесь нет записи файлов, но
есть та же дедупликация, что и везде: один вопрос, встретившийся в документе
дважды, печатается один раз (побеждает последняя запись), а расхождение
ответов показывается отдельно — это как раз то, что стоит увидеть до сборки
базы, а не после.

    python answer-parser.py путь\\к\\файлу.docx
"""
import os
import sys

from docx import Document
from docx.enum.text import WD_COLOR_INDEX

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import qa_norm


def collect_answers(file_path):
    """Пары «вопрос — ответ» из параграфов с жёлтой заливкой.

    Параграф состоит из «прогонов» (runs) — участков текста с одинаковым
    оформлением. Ответ — те прогоны, что залиты жёлтым; вопрос — весь
    параграф целиком.
    """
    document = Document(file_path)
    pairs = []
    for paragraph in document.paragraphs:
        if not paragraph.text.strip():
            continue

        question_text = ""
        answer_text = ""
        for run in paragraph.runs:
            question_text += run.text
            if run.font.highlight_color == WD_COLOR_INDEX.YELLOW:
                answer_text += run.text

        if answer_text.strip():
            pairs.append({'question': question_text.strip(),
                          'answer': answer_text.strip()})
    return pairs


def parse_answers_from_docx(file_path):
    if not os.path.exists(file_path):
        print(f"Ошибка: Файл не найден по пути '{file_path}'")
        return

    print(f"--- Начинаю обработку файла: {os.path.basename(file_path)} ---\n")

    try:
        pairs = collect_answers(file_path)
    except Exception as e:
        print(f"Произошла ошибка при обработке файла: {e}")
        return

    records, replaced = qa_norm.dedupe_records(pairs)

    for record in records:
        print(f"Вопрос: {qa_norm.full(record['question'])}")
        print(f"Ответ:  {qa_norm.answer_brief(record['answer'])}")
        print("-" * 30)

    if replaced:
        clashes = [(old, new) for old, new in replaced
                   if not qa_norm.answer_equal(old['answer'], new['answer'])]
        print(f"Повторов вопроса: {len(replaced)} — показана последняя запись.")
        if clashes:
            print(f"  из них с другим ответом: {len(clashes)} — проверьте:")
            for old, new in clashes:
                print(f"    {qa_norm.full(old['question'])}")
                print(f"        было:  {qa_norm.answer_brief(old['answer'])}")
                print(f"        стало: {qa_norm.answer_brief(new['answer'])}")

    print(f"--- Обработка файла завершена: {len(records)} "
          f"{qa_norm.plural(len(records), 'запись', 'записи', 'записей')} ---")


# --- ОСНОВНАЯ ЧАСТЬ ---
if __name__ == "__main__":
    qa_norm.setup_console()
    if len(sys.argv) > 1:
        file_path = sys.argv[1]
    else:
        # Путь, оставшийся от первых запусков скрипта.
        file_path = ('C:\\Users\\Denis\\Downloads\\'
                     'Baza_po_Soft_Skills_navyki_21_veka_1.docx')
    parse_answers_from_docx(file_path)
