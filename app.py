import os
import uuid
import threading

from flask import Flask, request, jsonify, render_template, send_file, abort

import converter

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, 'uploads')
os.makedirs(UPLOAD_DIR, exist_ok=True)

ALLOWED_EXT = {'.xlsx', '.xlsm', '.csv', '.txt'}
MAX_CONTENT_LENGTH = 25 * 1024 * 1024  # 25 MB

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = MAX_CONTENT_LENGTH

# In-memory session store: one process, fine for single-worker deployment.
# {session_id: {...}}
SESSIONS = {}
SESSIONS_LOCK = threading.Lock()


@app.route('/')
def index():
    return render_template('index.html', target_fields=converter.TARGET_FIELDS)


@app.route('/api/upload', methods=['POST'])
def upload():
    file = request.files.get('file')
    if not file or not file.filename:
        return jsonify({'error': 'Файл не выбран'}), 400

    filename = file.filename
    ext = os.path.splitext(filename)[1].lower()
    if ext not in ALLOWED_EXT:
        return jsonify({'error': f'Неподдерживаемый формат файла: {ext or "неизвестен"}. Поддерживаются .xlsx, .xlsm, .csv'}), 400

    session_id = uuid.uuid4().hex
    session_dir = os.path.join(UPLOAD_DIR, session_id)
    os.makedirs(session_dir, exist_ok=True)
    src_path = os.path.join(session_dir, 'source' + ext)
    file.save(src_path)

    try:
        headers, rows, hyperlinks = converter.read_table(src_path, filename)
    except Exception as e:
        return jsonify({'error': f'Не удалось прочитать файл: {e}'}), 400

    if not headers or not rows:
        return jsonify({'error': 'В файле не найдено данных (проверьте, что первая строка — заголовки колонок).'}), 400

    phone_cols = converter.detect_phone_columns(headers, rows)
    phone_data = converter.scan_phones(headers, rows, phone_cols)
    source_columns = converter.build_source_columns(headers, rows, phone_data)

    with SESSIONS_LOCK:
        SESSIONS[session_id] = {
            'headers': headers,
            'rows': rows,
            'hyperlinks': hyperlinks,
            'phone_data': phone_data,
            'filename': filename,
        }

    phone_summary = []
    for c in phone_cols:
        info = phone_data[c]
        phone_summary.append({
            'header': headers[c],
            'max_count': info['max_count'],
            'stats': info['stats'],
        })

    return jsonify({
        'session_id': session_id,
        'row_count': len(rows),
        'source_columns': source_columns,
        'target_fields': converter.TARGET_FIELDS,
        'phone_summary': phone_summary,
    })


@app.route('/api/convert', methods=['POST'])
def convert():
    data = request.get_json(force=True, silent=True) or {}
    session_id = data.get('session_id')
    mapping = data.get('mapping') or {}

    with SESSIONS_LOCK:
        session = SESSIONS.get(session_id)
    if not session:
        return jsonify({'error': 'Сессия не найдена или истекла. Загрузите файл заново.'}), 404

    if not any(mapping.values()):
        return jsonify({'error': 'Не выбрано ни одного поля для сопоставления.'}), 400

    output_rows = converter.build_output_rows(
        session['headers'], session['rows'], session['hyperlinks'],
        session['phone_data'], mapping,
    )

    out_path = os.path.join(UPLOAD_DIR, session_id, 'result.csv')
    converter.write_csv(out_path, output_rows)

    filled = {h: 0 for h in converter.OUTPUT_HEADERS}
    for row in output_rows:
        for h, v in zip(converter.OUTPUT_HEADERS, row):
            if v:
                filled[h] += 1

    return jsonify({
        'download_url': f'/download/{session_id}',
        'row_count': len(output_rows),
        'preview': output_rows[:5],
        'headers': converter.OUTPUT_HEADERS,
        'filled': filled,
    })


@app.route('/download/<session_id>')
def download(session_id):
    session_id = session_id.replace('/', '').replace('\\', '')
    path = os.path.join(UPLOAD_DIR, session_id, 'result.csv')
    if not os.path.isfile(path):
        abort(404)
    return send_file(path, as_attachment=True, download_name='crm_import.csv', mimetype='text/csv')


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
