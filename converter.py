import os
import json
import re
import sys

from docx import Document

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import qa_norm

try:
    import pdfplumber
except ImportError:
    pdfplumber = None

def _process_paragraphs(paragraphs):
    """
    Основная логика обработки списка текстовых строк.
    Ищет вопросы (•) и ответы (+).
    """
    qa_pairs = []
    current_question = ""
    correct_answers = []

    def save_previous_qa():
        if current_question and correct_answers:
            final_answer = correct_answers[0] if len(correct_answers) == 1 else correct_answers
            qa_pairs.append({
                "question": current_question,
                "answer": final_answer
            })

    for p_text in paragraphs:
        p_text = p_text.strip()
        if not p_text:
            continue

        if p_text.startswith('•'):
            save_previous_qa()
            current_question = p_text.lstrip('•').strip()
            correct_answers = []
        elif p_text.startswith('+'):
            answer_text = p_text.lstrip('+').strip()
            correct_answers.append(answer_text)

    save_previous_qa()
    return _dedupe(qa_pairs)


def _dedupe(qa_pairs):
    """Оставить по одной записи на вопрос — последнюю.

    Правило общее для всего проекта (qa_norm.dedupe_records). Здесь оно важно
    вдвойне: разбор docx идёт по всему файлу, и один и тот же вопрос вполне
    может встретиться дважды — например, в разных разделах. Раньше обе записи
    уезжали в JSON, и в базе заводился дубликат, возможно с другим ответом.
    Такие случаи печатаем: расхождение ответов надо смотреть глазами.
    """
    records, replaced = qa_norm.dedupe_records(qa_pairs)
    if replaced:
        clashes = [(old, new) for old, new in replaced
                   if not qa_norm.answer_equal(old.get('answer'),
                                               new.get('answer'))]
        print(f"Повторов вопроса: {len(replaced)} — оставлена последняя запись.")
        if clashes:
            print(f"  из них с другим ответом: {len(clashes)} — проверьте:")
            for old, new in clashes[:10]:
                print(f"    {qa_norm.full(old.get('question', ''))}")
                print(f"        было:  {qa_norm.answer_brief(old.get('answer'))}")
                print(f"        стало: {qa_norm.answer_brief(new.get('answer'))}")
            if len(clashes) > 10:
                print(f"    … и ещё {len(clashes) - 10}")
    return records

def create_json_from_file(file_path, output_filename='answers.json'):
    """
    Извлекает вопросы и ответы из файла .docx или .pdf и сохраняет их в JSON.
    """
    if not os.path.exists(file_path):
        print(f"Ошибка: Файл не найден по пути '{file_path}'")
        return

    print(f"Начинаю обработку файла: {os.path.basename(file_path)}")
    
    _, file_extension = os.path.splitext(file_path)
    paragraphs = []

    try:
        if file_extension.lower() == '.pdf':
            if not pdfplumber:
                print("Ошибка: для работы с PDF необходимо установить библиотеку 'pdfplumber'.")
                print("Выполните в терминале: pip install pdfplumber")
                return
            
            with pdfplumber.open(file_path) as pdf:
                full_text = ""
                for page in pdf.pages:
                    full_text += page.extract_text() + "\n"
                paragraphs = full_text.split('\n')
        
        elif file_extension.lower() == '.docx':
            document = Document(file_path)
            paragraphs = [p.text for p in document.paragraphs]
        
        else:
            print(f"Ошибка: неподдерживаемый формат файла '{file_extension}'. Поддерживаются только .docx и .pdf.")
            return

        qa_pairs = _process_paragraphs(paragraphs)

        # Пишем в том же виде, в каком лежит база расширения (qa_norm.render_base):
        # отступ 4, UTF-8 без BOM, переводы строк CRLF. Тогда результат можно
        # сравнивать с базой и сливать с ней, а не читать сплошной diff.
        with open(output_filename, 'w', encoding='utf-8', newline='') as f:
            f.write(qa_norm.render_base(qa_pairs))
        
        print(f"Успешно создано {len(qa_pairs)} записей в файле '{output_filename}'")

    except Exception as e:
        print(f"Произошла непредвиденная ошибка: {e}")

if __name__ == "__main__":
    qa_norm.setup_console()
    input_file = 'C:\\Users\\Denis\\Downloads\\asd.pdf'
    
    create_json_from_file(input_file)