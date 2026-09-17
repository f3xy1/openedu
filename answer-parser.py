import os
from docx import Document
from docx.enum.text import WD_COLOR_INDEX

def parse_answers_from_docx(file_path):
    # Проверяем, существует ли файл
    if not os.path.exists(file_path):
        print(f"Ошибка: Файл не найден по пути '{file_path}'")
        return

    try:
        # Открываем документ
        document = Document(file_path)
        print(f"--- Начинаю обработку файла: {os.path.basename(file_path)} ---\n")

        # Проходим по каждому параграфу в документе
        for paragraph in document.paragraphs:
            # Пропускаем пустые параграфы
            if not paragraph.text.strip():
                continue

            question_text = ""
            answer_text = ""
            
            # Параграф состоит из "прогонов" (runs) - участков текста с одинаковым форматированием
            for run in paragraph.runs:
                # Собираем полный текст вопроса
                question_text += run.text
                
                # Проверяем, есть ли у текста желтый фон
                if run.font.highlight_color == WD_COLOR_INDEX.YELLOW:
                    answer_text += run.text

            # Если в параграфе был найден ответ (выделенный текст)
            if answer_text.strip():
                print(f"Вопрос: {question_text.strip()}")
                print(f"Ответ:  {answer_text.strip()}")
                print("-" * 30) # Разделитель для наглядности

        print("--- Обработка файла завершена ---")

    except Exception as e:
        print(f"Произошла ошибка при обработке файла: {e}")


# --- ОСНОВНАЯ ЧАСТЬ ---
if __name__ == "__main__":
    # -----------------------------------------------------------------
    # !!! ВАЖНО: Укажите здесь полный или относительный путь к вашему файлу
    file_path = 'C:\\Users\\Denis\\Downloads\\Baza_po_Soft_Skills_navyki_21_veka_1.docx'  # <--- ЗАМЕНИТЕ НА ИМЯ ВАШЕГО ФАЙЛА
    # -----------------------------------------------------------------
    
    parse_answers_from_docx(file_path)