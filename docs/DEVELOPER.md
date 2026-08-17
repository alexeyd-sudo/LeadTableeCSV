# Руководство разработчика

Технический разбор сервиса: архитектура, поток данных, API, точки расширения.
Пользовательская часть — в [SUPPORT.md](SUPPORT.md), разбор исходных данных и
принятых решений — в [DATA-ANALYSIS.md](DATA-ANALYSIS.md).

---

## 1. Стек и структура

Python 3.9+, Flask, openpyxl. Ни базы, ни очередей, ни фронтенд-сборки.

```
NEW/
├── app.py                    Flask: маршруты, сессии, файлы
├── converter.py              вся логика разбора/очистки/склейки (без Flask)
├── requirements.txt
├── templates/index.html      одностраничный UI
├── static/app.js             ~330 строк ванильного JS, без зависимостей
├── static/style.css
├── tests/test_converter.py   40 тестов, запускается без pytest
├── uploads/<session_id>/     исходник + 4 сгенерированных CSV
└── docs/
    ├── SUPPORT.md
    ├── DEVELOPER.md
    ├── DATA-ANALYSIS.md
    └── CHANGELOG.md
```

`converter.py` **не импортирует Flask** — это сознательно: его можно
использовать как библиотеку и тестировать отдельно.

---

## 2. Поток данных

```
      файл
        │  read_table()  → xlsx: openpyxl (+ гиперссылки), csv: sniffer + 4 кодировки
        ▼
  headers[], rows[][], hyperlinks[][]
        │  analyze_columns()   классифицирует каждую ячейку выборки
        ▼
  col_stats[]  {counts:{email,phone,url,text}, dominant, share, header_hint}
        │  detect_phone_columns()  заголовок ИЛИ ≥50% ячеек — телефон
        ▼
  phone_cols[]
        │  scan_phones()   на каждую ячейку: телефоны + «остатки» (e-mail/ссылки)
        ▼
  phone_data{col: {per_row, leftovers, max_count, stats}}
        │  build_source_columns()  плоский список для левой части UI
        ▼
  source_columns[]  ── suggest_mapping() ──► предзаполненные selectы
        │
        │  ▼ пользователь правит mapping + options
        │
        │  build_records()   атомизация + маршрутизация «не своих» значений
        ▼
  records[] (dict по OUTPUT_HEADERS + _row),  fixes[]
        │  dedupe_records()   union-find по названию/e-mail/телефону/сайту
        ▼
  merged[], groups[]
        │  records_to_rows() + write_csv()
        ▼
  4 файла: result_raw.csv, result_merged.csv,
           report_duplicates.csv, report_fixes.csv
```

---

## 3. Ключевые концепции

### 3.1 Атомы (`extract_atoms`)

Ячейка **не** считается тем, что обещает заголовок колонки. Она разбирается
на типизированные «атомы»:

```python
{'emails': [...],       # по регулярке, с починкой "gmail,com" → "gmail.com"
 'urls': [...],         # уверенные: со схемой, с www., или домен в KNOWN_TLDS
 'urls_loose': [...],   # запасной вариант get_url() — вся ячейка как один URL
 'phones': [...],       # нормализованные, с '+'
 'phone_status': [...], # ok | fixed | cc_added | invalid, по одному на телефон
 'overflow': 0,         # сколько номеров не поместилось в MAX_PHONES_PER_CELL
 'text': '...'}         # очищенная ячейка целиком
```

Порядок важен: сначала вырезаются e-mail (иначе `info2024@x.com` даст «телефон»
`2024`), потом `wa.me/...` уходит в телефоны, потом остальные URL, потом цифры.

**Правила определения типа** (`classify_value`):

| Тип | Признак |
|---|---|
| e-mail | есть `@` и подходит под `EMAIL_RE` |
| сайт | схема `http(s)://`, либо префикс `www.`, либо домен, чья зона есть в `KNOWN_TLDS` |
| телефон | ≥7 цифр и почти ничего кроме цифр, `+`, скобок, дефисов, пробелов |
| текст | всё остальное |

`KNOWN_TLDS` намеренно **не полный список IANA**: в этих данных инстаграм-хендлы
выглядят как домены (`alpha.cw`, `distribuidora.beta`), и полный список сделал
бы их «сайтами». Добавляя зону — проверьте, что не ломаете `test_classify_text_not_url`.

### 3.2 Маршрутизация перепутанных значений (`build_records`)

Сборка строки идёт в два прохода:

1. **Прямой проход.** Для каждой пары (колонка → целевое поле) атомы *своего*
   типа кладутся в «корзину» этого поля. Атомы *чужого* типа складываются в
   `pending`. Поля типа `text` берут ячейку целиком и ничего никуда не отдают —
   это защита от того, чтобы название компании вида `alpha.cw` уехало в Website.
2. **Проход размещения.** Для каждого «чужого» значения берётся цепочка
   `TYPE_CHAINS[kind]` и выбирается место:
   1. сопоставленное пользователем поле этого типа, которое **пусто** в этой строке;
   2. поле цепочки, которое пользователь вообще не сопоставлял;
   3. иначе — **последнее** поле цепочки (`Other Website` / `Other Phone Number`),
      значение дописывается через `, `.

   Если такое значение уже есть в любом поле этого типа — оно отбрасывается
   с пометкой `duplicate`. Каждое решение попадает в `fixes[]`.

Отключается опцией `autofix_types: false`.

### 3.3 Спасение данных из «телефонной» колонки

Разбитая на под-столбцы (`"2:0"`, `"2:1"`, …) колонка раньше делала исходный
текст ячейки недоступным. Теперь `scan_phones()` наряду с номерами сохраняет
`leftovers` — e-mail и ссылки из той же ячейки, — и `_atoms_for_key()` отдаёт
их вместе с под-столбцом `:0`. Поэтому:

* колонка e-mail, ошибочно определённая как телефонная, **не теряется** —
  её можно направить в `Work E-mail` (тест `test_mis_detected_phone_column_does_not_lose_data`);
* ссылка, лежащая рядом с номером, доезжает до Website.

### 3.4 Дубликаты (`dedupe_records`)

Union-find по ключам с префиксом типа (чтобы телефон не совпал с названием):

| Ключ | Как строится | Опция |
|---|---|---|
| `n:` | `alnum(название)`; при `Имя (хендл)` — **два** ключа, из имени и из хендла | `dedupe_by_name` |
| `e:` | каждый адрес из Work/Home/Other E-mail, в нижнем регистре | `dedupe_by_email` |
| `p:` | последние **9 цифр** каждого номера (с кодом страны и без — один ключ) | `dedupe_by_phone` |
| `w:` | домен; для соцсетей домен + аккаунт (`instagram.com/alpha`) | `dedupe_by_website` (выкл. по умолчанию) |

Корнем группы делается **минимальный индекс**, поэтому порядок строк в
результате — порядок первого вхождения.

Слияние группы (`_merge_group`): название — `pick_best_name()` (предпочитает
вариант с пробелом, потом длинный); телефоны — `dedupe_join_phones()`
(схлопывает «тот же номер без кода страны»); сайты — по `url_key`; остальное —
`dedupe_join` через `, `.

`dedupe_records()` **никогда не вызывается для «сырого» файла** — он всегда
пишется как есть. Это принципиально: пользователь сравнивает два файла и решает сам.

### 3.5 Кодировка вывода

`é` в UTF-8 — это 2 байта (`C3 A9`). Получатель, который не знает кодировку,
читает их как 2 символа своей ANSI-кодировки (`Ã©` / `Г©`), а последующее
приведение к ASCII превращает каждый в `?` — отсюда `México → M??xico`
(**два** знака вопроса на одну букву). Один `?` означает, что до ASCII урезали
сразу, без промежуточного шага.

Поэтому по умолчанию пишем **UTF-8 с BOM** (`CSV_ENCODING = 'utf-8-sig'`) —
BOM единственный внутриполосный сигнал кодировки, который понимают Excel и
большинство импортёров. Доступны также `utf-8`, `cp1252`, `cp1251`
(`CSV_ENCODINGS`, опция `csv_encoding`).

`write_csv()` **никогда не падает** на непредставимом символе. `fit_to_encoding()`
деградирует по ступеням: символ как есть → `strip_accents(символ)` → `?`,
и возвращает `{'encoding', 'replaced', 'affected_rows'}` — UI показывает,
сколько потеряно.

`strip_accents()` (опция `transliterate`) снимает диакритику **только с
латиницы**: NFKD-разложение применяется, если базовый символ ASCII. Кириллица
не трогается — иначе `й` превратилось бы в `и`, а это порча, а не
транслитерация. Символы без разложения (`ß`, `®`, `—`, `№`) берутся из
`MANUAL_TRANSLIT`. Результат — чистый ASCII, который перекодировкой испортить
уже нельзя.

Отчёты пишутся в `utf-8-sig` всегда, независимо от опции: их читают в Excel,
а не импортируют.

### 3.6 Отчёты

`_row` в записи — номер строки **как в Excel** (`row_idx + 2`, потому что
строка 1 — заголовки). Те же номера идут в оба отчёта.

---

## 4. HTTP API

### `POST /api/upload`

`multipart/form-data`, поле `file`.

```jsonc
{
  "session_id": "1572d983…",           // 32 hex
  "row_count": 436,
  "source_columns": [                   // левая часть UI
    {"key": "2:0", "label": "Phone … — Phone 1", "kind": "phone",
     "samples": ["+522281110011"], "stats": {...}, "analysis": {...}}
  ],
  "target_fields": [...],               // = converter.TARGET_FIELDS
  "phone_summary": [{"header": "...", "max_count": 5, "stats": {...}}],
  "suggested_mapping": {"0": "company_lead", "1": "work_email", ...},
  "warnings": ["В телефонной колонке … найдено 11 ссылок …"],
  "defaults": {...},                    // = converter.DEFAULT_OPTIONS
  "encodings": [{"id": "utf-8-sig", "label": "…", "hint": "…"}, ...]
}
```

`key` колонки: `"3"` — обычная колонка №3; `"2:1"` — второй телефон из колонки №2.

Ошибки: `400` (нет файла / формат / пусто / слишком большая таблица),
`413` (> 25 МБ, тоже JSON).

### `POST /api/convert`

```jsonc
{
  "session_id": "1572d983…",
  "mapping": {"0": "company_lead", "2:0": "mobile_phone"},
  "options": {
    "autofix_types": true,
    "default_country_code": "52",
    "skip_rows_without_name": false,
    "sanitize_formulas": false,
    "csv_encoding": "utf-8-sig",       // utf-8-sig | utf-8 | cp1252 | cp1251
    "transliterate": false,            // é -> e, ñ -> n
    "dedupe_by_name": true, "dedupe_by_email": true,
    "dedupe_by_phone": true, "dedupe_by_website": false
  }
}
```

Ответ:

```jsonc
{
  "headers": [...],
  "encoding": {"id": "utf-8-sig", "label": "UTF-8 с BOM (рекомендуется)",
               "transliterate": false, "replaced": 0, "affected_rows": 0},
  "raw":     {"row_count": 436, "filled": {...}, "preview": [[...]], "download_url": "/download/…/raw"},
  "merged":  {"row_count": 355, "filled": {...}, "preview": [[...]], "download_url": "/download/…/merged"},
  "duplicates": {"group_count": 57, "collapsed_rows": 81,
                 "groups": [{"name": "...", "size": 3, "rows": [3,186,353],
                             "names": [...], "matched_on": ["название","телефон"]}],
                 "download_url": "/download/…/duplicates"},
  "fixes": {"moved": 2, "dropped_duplicates": 10,
            "items": [{"row": 63, "column": "…", "kind": "url", "value": "…",
                       "from": "mobile_phone", "to": "other_website", "action": "moved"}],
            "download_url": "/download/…/fixes"},

  // legacy-поля, дублируют raw — чтобы не ломать старые скрипты
  "row_count": 436, "preview": [...], "filled": {...}, "download_url": "/download/…/raw"
}
```

`groups` и `items` в JSON обрезаны до 50 записей; полные списки — в CSV-отчётах.

Ошибки: `400` (кривой `session_id` / пустой mapping), `404` (сессия истекла).

### `GET /download/<session_id>/<kind>`

`kind` ∈ `raw | merged | duplicates | fixes`. `GET /download/<session_id>`
без `kind` = `raw` (обратная совместимость).

`session_id` проверяется по `^[0-9a-f]{32}$` — иначе `404`.

### `GET /healthz`

`{"status": "ok", "sessions": N}`.

---

## 5. Сессии и файлы

Хранилище — обычный `dict` в памяти процесса под `threading.Lock`.
В сессии лежат `headers`, `rows`, `hyperlinks`, `phone_data`, `col_stats`,
`labels`, `filename`, `created`.

`cleanup_sessions()` вызывается на каждом `/api/upload`:

* удаляет сессии старше `SESSION_TTL_SECONDS` (по умолчанию 6 ч) вместе с папкой;
* если сессий больше `MAX_SESSIONS` (50) — убирает самые старые;
* удаляет «осиротевшие» папки в `uploads/`, оставшиеся от прошлого процесса.

Обе переменные читаются из окружения.

> **Только 1 worker.** Состояние — в памяти процесса. При нескольких воркерах
> запрос `/api/convert` может попасть в процесс, который не видел `/api/upload`.
> Нужно масштабирование — выносите `SESSIONS` в Redis или сериализуйте сессию
> на диск в `uploads/<sid>/session.pickle`.

---

## 6. Настройка под другую CRM

| Что менять | Где |
|---|---|
| Набор полей CRM | `TARGET_FIELDS` + `OUTPUT_HEADERS` в `converter.py`. `type` (`text`/`phone`/`url`/`email`) управляет и разбором, и переносами |
| Куда «переливаются» лишние значения | `TYPE_CHAINS` (+ `PHONE_OUTPUTS` / `EMAIL_OUTPUTS` / `URL_OUTPUTS`) |
| Разделитель / переносы CSV | `CSV_DELIMITER`, `CSV_LINETERMINATOR` |
| Кодировка по умолчанию и список доступных | `CSV_ENCODING`, `CSV_ENCODINGS` |
| Таблица транслитерации | `MANUAL_TRANSLIT` (для символов без NFKD-разложения) |
| Значение колонки `Source` | `SOURCE_VALUE`, либо `options['source_value']` |
| Максимум телефонов в ячейке | `MAX_PHONES_PER_CELL` |
| Автоподстановка полей по заголовку | `HEADER_TARGET_HINTS` |
| Слова-признаки телефонной колонки | `PHONE_HEADER_KEYWORDS`, `NON_PHONE_HEADER_SUBSTRINGS`, `NON_PHONE_HEADER_WORDS` |
| Доменные зоны | `KNOWN_TLDS`, `SOCIAL_HOSTS`, `PHONE_LINK_HOSTS` |
| UTM-метки, которые режутся | `TRACKING_PARAMS` |
| Лимиты размера | `MAX_CONTENT_LENGTH` (app.py), `MAX_ROWS` / `MAX_COLS` (converter.py) |

Добавление нового целевого поля:

1. запись в `TARGET_FIELDS` (`id`, `label`, `type`, `outputs`);
2. имена из `outputs` — в `OUTPUT_HEADERS`;
3. если тип строгий — добавить `id` в нужную `TYPE_CHAINS` и в
   `PHONE_OUTPUTS`/`EMAIL_OUTPUTS`/`URL_OUTPUTS`;
4. при желании — правило в `HEADER_TARGET_HINTS` и ветка в `suggest_mapping()`.

Фронтенд менять не нужно: список полей приходит с сервера.

---

## 7. Тесты

```
cd NEW
py tests\test_converter.py     # без зависимостей, печатает PASS/FAIL
py -m pytest tests             # если pytest установлен
```

Тест `test_real_file_regression` работает с реальным `../leads.xlsx`
и молча пропускается, если файла нет.

Что покрыто: классификация значений, ложные срабатывания определения телефонных
колонок, восстановление перепутанных полей, нормализация телефонов и код страны
по умолчанию, все режимы объединения дублей, нумерация строк отчётов,
диалект CSV, защита от формул, автосопоставление.

**При правках `converter.py` тесты обязательны** — почти каждый из них
зафиксировал конкретный найденный баг.

---

## 8. Запуск

### Разработка

```
cd NEW
py -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
py app.py                       # http://localhost:5000, debug=True
```

### Прод

```
waitress-serve --host=0.0.0.0 --port=5000 --threads=4 app:app     # Windows и Linux
gunicorn -w 1 -b 0.0.0.0:5000 app:app                             # Linux
```

Ровно **один worker** (см. §5). `debug=True` в проде не использовать.

Переменные окружения: `PORT` (здесь 5000, у английской версии 5001),
`SESSION_TTL_SECONDS` (6 ч), `MAX_SESSIONS` (50).

---

## 9. Безопасность

Сделано:

* `session_id` — строгий `^[0-9a-f]{32}$`, обход путей закрыт;
* белый список расширений, лимит 25 МБ, лимиты строк/колонок;
* сессии и загруженные файлы удаляются по TTL — лид-данные не лежат вечно;
* опциональная защита от инъекции формул в CSV;
* HTML на фронтенде экранируется (`escapeHtml`) во всех местах вставки.

Не сделано (осознанно — сервис для внутреннего контура):

* **нет аутентификации** — любой, кто дотянется до порта, может загружать файлы
  и скачивать чужие результаты, зная `session_id`. Наружу выставлять только за
  reverse-proxy с basic-auth / SSO;
* нет CSRF-защиты (API без cookie-сессий, но форма не защищена);
* нет rate limiting;
* `openpyxl` читает произвольные `.xlsx` — доверяйте источнику файлов.
