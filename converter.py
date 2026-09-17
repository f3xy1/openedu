import os
import json
import re
from docx import Document

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
    return qa_pairs

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

        with open(output_filename, 'w', encoding='utf-8') as f:
            json.dump(qa_pairs, f, ensure_ascii=False, indent=4)
        
        print(f"Успешно создано {len(qa_pairs)} записей в файле '{output_filename}'")

    except Exception as e:
        print(f"Произошла непредвиденная ошибка: {e}")

if __name__ == "__main__":
    input_file = 'C:\\Users\\Denis\\Downloads\\asd.pdf'
    
    create_json_from_file(input_file)