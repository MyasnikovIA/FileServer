# `API.md` — Справочник по API сервера FileServer

Полное описание REST API, SSE-потока и прямых URL, предоставляемых Java-сервером `FileServer` (пакет `ru.miacomsoft.server`).

---

## Содержание

1. [Общие сведения](#1-общие-сведения)
2. [Аутентификация](#2-аутентификация)
3. [Формат ошибок](#3-формат-ошибок)
4. [Модель данных](#4-модель-данных)
5. [Служебные endpoint-ы](#5-служебные-endpoint-ы)
6. [Работа с файлами и папками](#6-работа-с-файлами-и-папками)
7. [Прямые URL к файлам](#7-прямые-url-к-файлам)
8. [Публичный доступ](#8-публичный-доступ)
9. [SSE-поток событий](#9-sse-поток-событий)
10. [Квоты](#10-квоты)
11. [Полный список endpoint-ов](#11-полный-список-endpoint-ов)
12. [Примеры на разных языках](#12-примеры-на-разных-языках)

---

## 1. Общие сведения

### 1.1. Базовый URL

```
http://<host>:<port>
```

По умолчанию:
- `host = 0.0.0.0` (слушает все интерфейсы)
- `port = 8080`

Настраивается в `config.json`:

```json
{ "http": { "port": 8080, "host": "0.0.0.0" } }
```

Или параметрами CLI:
```
java ... FileServer --port 8080 --host 0.0.0.0
```

### 1.2. Кодирование

- Все тексты — **UTF-8**.
- Параметры URL — URL-encoded (`encodeURIComponent` в JS).
- JSON-ответы — `Content-Type: application/json; charset=utf-8`.
- Пути в параметре `path` передаются **без ведущего слэша** и кодируются целиком:

```
path=Documents%2Fsub%2Ffile.txt
```

### 1.3. CORS

Все ответы содержат:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS, HEAD
Access-Control-Allow-Headers: Content-Type, Authorization, X-Auth-Token, X-Requested-With
Access-Control-Max-Age: 86400
```

**Preflight (OPTIONS)** обрабатывается автоматически → 204 No Content.

### 1.4. Виртуальные пути

Клиент работает с **виртуальными путями**, а не с физическими. Соответствие задаётся в `config.json` → `shares[].physical`.

```
Виртуальный путь:  Documents/reports/2024.pdf
Физический путь:   C:/data/docs/reports/2024.pdf
```

Первый сегмент виртуального пути — **имя share**. Оно видно пользователю. Далее — относительный путь внутри share.

---

## 2. Аутентификация

### 2.1. Способы

| Способ | Заголовок / параметр | Применение |
|---|---|---|
| Basic | `Authorization: Basic <base64(user:pass)>` | curl, Postman, простые клиенты |
| Bearer | `Authorization: Bearer <token>` | SPA, основной способ |
| X-Auth-Token | `X-Auth-Token: <token>` | альтернатива для прокси |
| Query token | `?token=<token>` | прямые ссылки, `<img>`, `<video>`, EventSource |
| Query user/pass | `?user=<u>&pass=<p>` | отладка в браузере |
| Аноним | — | доступ только к `anonymous: true` |

**Порядок проверки на сервере:**

```
1. Authorization: Bearer <token>
2. X-Auth-Token: <token>
3. Authorization: Basic <base64>
4. ?token=<token>
5. ?user=<u>&pass=<p>
6. анонимная сессия
```

### 2.2. Получение токена

```
POST /api/login
```

**Body (JSON):**

```json
{ "user": "admin", "pass": "admin123" }
```

**Body (form-urlencoded):**

```
user=admin&pass=admin123
```

**Query (для отладки):**

```
GET /api/login?user=admin&pass=admin123
```

**Ответ 200:**

```json
{
  "ok": true,
  "token": "3Kf7xQzLmNpZm9vYmFyYmF6cXV4...23ByQ",
  "user": "admin",
  "issuedAt": 1737000000000,
  "expiresAt": 1737086400000,
  "ttlMs": 86400000
}
```

**Ответ 401:**

```json
{ "error": "Invalid credentials", "status": 401 }
```

**Срок жизни:** 24 часа или до перезапуска сервера.

### 2.3. Проверка сессии

```
GET /api/whoami
```

**Ответ 200:**

```json
{
  "anonymous": false,
  "username": "admin",
  "quotaMb": -1
}
```

Для анонима:

```json
{ "anonymous": true, "username": null }
```

### 2.4. Отзыв токена

```
POST /api/logout
```

**Body:**

```json
{ "token": "3Kf7x..." }
```

Или токен можно взять из заголовка `Authorization: Bearer ...`.

**Ответ 200:**

```json
{ "ok": true }
```

После отзыва все запросы с этим токеном → 401.

---

## 3. Формат ошибок

Все ошибки — JSON с полями `error` и `status`:

```json
{
  "error": "Forbidden: Access denied to share: Documents (read)",
  "status": 403
}
```

Для **превышения квоты** — расширенный формат (HTTP 507):

```json
{
  "error": "Quota exceeded",
  "scope": "Documents",
  "quotaMb": 200,
  "usedBytes": 209715200,
  "freeBytes": 0,
  "deltaBytes": 1048576,
  "status": 507
}
```

| Код | Значение |
|---|---|
| 200 | OK |
| 204 | No Content (OPTIONS) |
| 400 | Bad Request — отсутствует параметр |
| 401 | Unauthorized — не аутентифицирован |
| 403 | Forbidden — нет прав |
| 404 | Not Found — ресурс отсутствует |
| 405 | Method Not Allowed |
| 500 | Internal Server Error |
| 507 | Insufficient Storage — квота |

---

## 4. Модель данных

### 4.1. Виртуальный путь

Строка, где:
- первый сегмент — **имя share** (виртуальное);
- остальное — относительный путь внутри share.

```
Documents                       → корень share Documents
Documents/report.pdf            → файл внутри share
test/games/doom.sfc             → вложенный путь
```

Корень всей файловой системы — пустая строка:

```
path=""    → список всех shares, доступных пользователю
```

### 4.2. Объект Entry (элемент файловой системы)

Возвращается в списках и `stat`.

```json
{
  "name": "report.pdf",
  "path": "Documents/report.pdf",
  "isFolder": false,
  "size": 1234567,
  "mtime": 1737000000000,
  "contentType": "application/pdf",
  "binary": true
}
```

**Поля:**

| Поле | Тип | Описание |
|---|---|---|
| `name` | string | Имя файла/папки |
| `path` | string | **Виртуальный** путь от корня |
| `isFolder` | boolean | `true` — папка, `false` — файл |
| `size` | number | Размер в байтах (0 для папок) |
| `mtime` | number | Unix-время последнего изменения (мс) |
| `contentType` | string | MIME-тип (для файлов) |
| `binary` | boolean | `true`, если содержимое бинарное |

### 4.3. Объект Share (виртуальный share)

Возвращается в `/api/info` и при листинге корня.

```json
{
  "name": "Documents",
  "type": "folder",
  "access": ["read", "write", "delete"],
  "quotaMb": 200,
  "usedBytes": 47872450
}
```

**Дополнительно в листинге корня:**

```json
{
  "name": "Documents",
  "path": "Documents",
  "isFolder": true,
  "virtual": true,
  "size": 0,
  "mtime": 0,
  "quotaMb": 200,
  "usedBytes": 47872450,
  "access": ["read", "write", "delete"]
}
```

---

## 5. Служебные endpoint-ы

### 5.1. `GET /api/info`

Информация о сервере и список доступных пользователю shares.

**Требует:** любой способ аутентификации.

**Запрос:**

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/api/info
```

**Ответ 200:**

```json
{
  "type": "filesystem",
  "version": "1.3",
  "anonymous": false,
  "username": "admin",
  "userQuotaMb": -1,
  "userUsedBytes": 125829120,
  "shares": [
    {
      "name": "Documents",
      "type": "folder",
      "access": ["read", "write", "delete"],
      "quotaMb": 200,
      "usedBytes": 47872450
    },
    {
      "name": "Photos",
      "type": "folder",
      "access": ["read", "write"],
      "quotaMb": -1,
      "usedBytes": 0
    }
  ]
}
```

**Поля:**

| Поле | Описание |
|---|---|
| `type` | `"filesystem"` — маркер типа БД |
| `version` | версия протокола |
| `anonymous` | `true`, если запрос был без авторизации |
| `username` | логин или `null` для анонима |
| `userQuotaMb` | общая квота пользователя (МБ), `-1` — без лимита |
| `userUsedBytes` | использовано пользователем (байт) |
| `shares[]` | список доступных shares |

---

## 6. Работа с файлами и папками

### 6.1. `GET /api/list` — список содержимого

**Требует:** права `read` на указанный share.

**Параметры:**

| Параметр | Обязательно | Описание |
|---|---|---|
| `path` | нет | Виртуальный путь. Пусто → список shares |
| `recursive` | нет | `1` или `true` — рекурсивный обход |

**Запрос:**

```bash
# Корень — список shares
curl -H "Authorization: Bearer $TOKEN" \
     "http://127.0.0.1:8080/api/list?path="

# Содержимое папки
curl -H "Authorization: Bearer $TOKEN" \
     "http://127.0.0.1:8080/api/list?path=Documents"

# Рекурсивный обход
curl -H "Authorization: Bearer $TOKEN" \
     "http://127.0.0.1:8080/api/list?path=Documents&recursive=1"
```

**Ответ 200:**

```json
{
  "path": "Documents",
  "recursive": false,
  "entries": [
    {
      "name": "reports",
      "path": "Documents/reports",
      "isFolder": true,
      "size": 0,
      "mtime": 1737000000000,
      "contentType": "",
      "binary": false
    },
    {
      "name": "readme.md",
      "path": "Documents/readme.md",
      "isFolder": false,
      "size": 2048,
      "mtime": 1737000000000,
      "contentType": "text/markdown",
      "binary": false
    }
  ]
}
```

**При листинге корня (`path=""`)** элементы — объекты Share с дополнительными полями:

```json
{
  "path": "",
  "recursive": false,
  "entries": [
    {
      "name": "Documents",
      "path": "Documents",
      "isFolder": true,
      "virtual": true,
      "size": 0,
      "mtime": 0,
      "quotaMb": 200,
      "usedBytes": 47872450,
      "access": ["read", "write", "delete"]
    }
  ]
}
```

### 6.2. `GET /api/stat` — метаданные объекта

**Требует:** права `read`.

**Параметры:**

| Параметр | Обязательно | Описание |
|---|---|---|
| `path` | да | Виртуальный путь |

**Запрос:**

```bash
curl -H "Authorization: Bearer $TOKEN" \
     "http://127.0.0.1:8080/api/stat?path=Documents/readme.md"
```

**Ответ 200 (файл):**

```json
{
  "name": "readme.md",
  "path": "Documents/readme.md",
  "isFolder": false,
  "size": 2048,
  "mtime": 1737000000000,
  "contentType": "text/markdown",
  "binary": false
}
```

**Ответ 200 (корень share):**

```json
{
  "name": "Documents",
  "path": "Documents",
  "isFolder": true,
  "virtual": true,
  "size": 0,
  "mtime": 0,
  "quotaMb": 200,
  "usedBytes": 47872450,
  "access": ["read", "write", "delete"]
}
```

### 6.3. `GET /api/read` — скачать файл

**Требует:** права `read`.

**Параметры:**

| Параметр | Обязательно | Описание |
|---|---|---|
| `path` | да | Виртуальный путь файла |

**Запрос:**

```bash
curl -H "Authorization: Bearer $TOKEN" \
     -o report.pdf \
     "http://127.0.0.1:8080/api/read?path=Documents/reports/2024.pdf"
```

**Ответ 200:** тело — байты файла, `Content-Type` определяется по расширению.

**Пример с URL-encoding:**

```bash
# Файл "Blackthorne (U) [T Rus].sfc" в share "test"
curl -H "Authorization: Bearer $TOKEN" \
     "http://127.0.0.1:8080/api/read?path=test%2FBlackthorne%20(U)%20%5BT%20Rus%5D.sfc"
```

### 6.4. `PUT /api/write` (или `POST`) — записать файл

**Требует:** права `write`.

**Параметры:**

| Параметр | Обязательно | Описание |
|---|---|---|
| `path` | да | Виртуальный путь файла |

**Body:** произвольные байты.

**Заголовок:** `Content-Type` — MIME-тип файла.

**Запрос:**

```bash
curl -X PUT \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: text/plain" \
     --data-binary @local.txt \
     "http://127.0.0.1:8080/api/write?path=Documents/note.txt"
```

**Ответ 200:**

```json
{
  "ok": true,
  "path": "Documents/note.txt",
  "size": 1234
}
```

**Автоматическое создание родительских папок:** да. Если `Documents/notes` не существует — она будет создана.

**Проверка квоты:** если размер превышает лимит — 507.

### 6.5. `POST /api/mkdir` — создать папку

**Требует:** права `write`.

**Параметры:**

| Параметр | Обязательно | Описание |
|---|---|---|
| `path` | да | Виртуальный путь папки |

**Запрос:**

```bash
curl -X POST \
     -H "Authorization: Bearer $TOKEN" \
     "http://127.0.0.1:8080/api/mkdir?path=Documents/2024/Q1"
```

**Ответ 200:**

```json
{ "ok": true, "path": "Documents/2024/Q1" }
```

**Если папка уже существует** — тихо возвращает 200 (идемпотентно).

### 6.6. `DELETE /api/delete` (или `POST`) — удалить

**Требует:** права `delete`.

**Параметры:**

| Параметр | Обязательно | Описание |
|---|---|---|
| `path` | да | Виртуальный путь |

**Запрос:**

```bash
curl -X DELETE \
     -H "Authorization: Bearer $TOKEN" \
     "http://127.0.0.1:8080/api/delete?path=Documents/old.txt"
```

**Ответ 200:**

```json
{ "ok": true, "path": "Documents/old.txt" }
```

**Удаление папки** — рекурсивное. Все файлы и вложенные папки удаляются.

**Запрет:** удаление корня share (первого сегмента) → 400.

### 6.7. `POST /api/move` — переместить / переименовать

**Требует:** `delete` на источник, `write` на цель.

**Параметры:**

| Параметр | Обязательно | Описание |
|---|---|---|
| `from` | да | Виртуальный путь источника |
| `to` | да | Виртуальный путь назначения |

**Запрос:**

```bash
curl -X POST \
     -H "Authorization: Bearer $TOKEN" \
     "http://127.0.0.1:8080/api/move?from=Documents/old.txt&to=Documents/new.txt"
```

**Ответ 200:**

```json
{
  "ok": true,
  "from": "Documents/old.txt",
  "to": "Documents/new.txt"
}
```

**Между разными shares:** если источник и цель — разные shares, копирование происходит через read/write-цикл. Это работает даже если shares на разных дисках.

### 6.8. `POST /api/copy` — скопировать

**Требует:** `read` на источник, `write` на цель.

**Параметры:**

| Параметр | Обязательно | Описание |
|---|---|---|
| `from` | да | Источник |
| `to` | да | Назначение |

**Запрос:**

```bash
curl -X POST \
     -H "Authorization: Bearer $TOKEN" \
     "http://127.0.0.1:8080/api/copy?from=Documents/a.txt&to=Documents/backup/a.txt"
```

**Ответ 200:**

```json
{
  "ok": true,
  "from": "Documents/a.txt",
  "to": "Documents/backup/a.txt"
}
```

**Папки копируются рекурсивно.**

---

## 7. Прямые URL к файлам

### 7.1. Схема

```
GET /<shareName>/<relative-path>
HEAD /<shareName>/<relative-path>
```

**Логика обработки (`RootHandler`):**

1. Сначала проверяется статика из `www/` (index.html, js, css, lib).
2. Если файла там нет — первый сегмент трактуется как **имя share**.
3. Проверяется право `read` и видимость.
4. Отдаётся файл.

### 7.2. Приватный share

Требует авторизации (Bearer, Basic, token, user/pass).

**Пример с Bearer:**

```bash
curl -H "Authorization: Bearer $TOKEN" \
     "http://127.0.0.1:8080/Documents/report.pdf"
```

**С токеном в URL** (для браузера, `<img>`, `<video>`):

```
http://127.0.0.1:8080/Documents/report.pdf?token=3Kf7xQzLmNp...
```

**С Basic Auth:**

```bash
curl -u admin:admin123 \
     "http://127.0.0.1:8080/Documents/report.pdf"
```

### 7.3. Публичный share

Если `anonymous: true` — **без авторизации**:

```
http://127.0.0.1:8080/test/Blackthorne%20(U)%20%5BT%20Rus%5D.sfc
```

Спецсимволы кодируются браузером автоматически. Вручную:

| Символ | Код |
|---|---|
| пробел | `%20` |
| `(` | `%28` |
| `)` | `%29` |
| `[` | `%5B` |
| `]` | `%5D` |

### 7.4. Кодирование `/`

Символ `/` в пути можно оставить как есть или закодировать как `%2F`:

```
http://127.0.0.1:8080/test/file.sfc
http://127.0.0.1:8080/test%2Ffile.sfc
```

**Оба варианта работают одинаково.**

### 7.5. HEAD-запрос

```bash
curl -I -H "Authorization: Bearer $TOKEN" \
     "http://127.0.0.1:8080/Documents/report.pdf"
```

Возвращает заголовки (`Content-Type`, `Content-Length`) без тела.

### 7.6. MIME-типы

Сервер использует `Files.probeContentType()` и fallback-маппер для типичных расширений:

| Расширение | Content-Type |
|---|---|
| `.html`, `.htm` | `text/html; charset=utf-8` |
| `.js`, `.mjs` | `application/javascript; charset=utf-8` |
| `.css` | `text/css; charset=utf-8` |
| `.json` | `application/json; charset=utf-8` |
| `.png` | `image/png` |
| `.jpg`, `.jpeg` | `image/jpeg` |
| `.svg` | `image/svg+xml` |
| `.pdf` | `application/pdf` |
| `.mp4` | `video/mp4` |
| `.mp3` | `audio/mpeg` |
| `.zip` | `application/zip` |
| `.sfc` (SNES ROM) | `application/octet-stream` |

---

## 8. Публичный доступ

### 8.1. Endpoint `/api/public/*`

```
GET /api/public/<shareName>/<relative-path>
HEAD /api/public/<shareName>/<relative-path>
```

**Не требует авторизации.**

**Работает только для shares с `anonymous: true` и `access: ["read"]`.**

**Пример:**

```bash
curl http://127.0.0.1:8080/api/public/PublicReports/2024-Q1.pdf
```

**Если share не публичный** → 403:

```json
{ "error": "Not public: Documents", "status": 403 }
```

### 8.2. Разница между `/api/public/*` и прямым URL

| | `/api/public/<share>/<path>` | `/<share>/<path>` |
|---|---|---|
| Только анонимные shares | Да | Нет |
| Работает для приватных с токеном | Нет | Да |
| Требует авторизации | Нет | Зависит от share |

### 8.3. Прямой URL без `/api/public`

Публичный share доступен и по короткому URL:

```
http://127.0.0.1:8080/test/Blackthorne.sfc       ← анонимный share
http://127.0.0.1:8080/api/public/test/Blackthorne.sfc  ← то же самое
```

Оба варианта работают без авторизации, если share `anonymous: true`.

---

## 9. SSE-поток событий

### 9.1. Подключение

```
GET /api/events
```

**Требует:** токен (Bearer, X-Auth-Token или `?token=`).

`EventSource` в браузере не поддерживает заголовки, поэтому используйте query:

```js
const es = new EventSource('http://127.0.0.1:8080/api/events?token=' + token);
```

**В curl:**

```bash
curl -N -H "Authorization: Bearer $TOKEN" \
     http://127.0.0.1:8080/api/events
```

### 9.2. Формат

Server-Sent Events:

```
event: ready
data: {"id":"sse-1"}

event: change
data: {"type":"create","path":"Documents/note.txt","isFolder":false}

event: change
data: {"type":"modify","path":"Documents/note.txt","isFolder":false}

event: ping
data: {"t":1737000000000}
```

### 9.3. Типы событий

| Event | Когда |
|---|---|
| `ready` | При подключении, с уникальным `id` соединения |
| `change` | При изменении файлов в одном из наблюдаемых shares |
| `ping` | Каждые 15 секунд (keep-alive) |

### 9.4. Полезная нагрузка `change`

```json
{
  "type": "create" | "delete" | "modify",
  "path": "Documents/note.txt",
  "isFolder": false
}
```

**Замечание:** путь в событии — **относительный внутри share**, без префикса с именем share. Сервер следит только за первым folder-share из `config.json`.

### 9.5. Переподключение

Браузер автоматически переподключается при разрыве. Таймаут — по умолчанию 3 секунды, задаётся сервером через `retry:`.

### 9.6. Отключение

```js
es.close();
```

Сервер удаляет соединение из своей карты при первой же неудачной отправке.

---

## 10. Квоты

### 10.1. Модель

Каждый share и каждый user имеют **лимит записи** в мегабайтах:

- `-1` — без лимита
- `0` — писать нельзя
- `> 0` — лимит в МБ

**Проверка при записи:**

```
used + delta > quota * 1024 * 1024  →  507 Insufficient Storage
```

Где:
- `used` — суммарный размер всех файлов в share (или по всем shares пользователя);
- `delta` — разница между новым и старым размером файла.

### 10.2. Ответ при превышении

**HTTP 507:**

```json
{
  "error": "Quota exceeded",
  "scope": "Documents",
  "quotaMb": 200,
  "usedBytes": 209715200,
  "freeBytes": 0,
  "deltaBytes": 1048576,
  "status": 507
}
```

**Поля:**

| Поле | Описание |
|---|---|
| `scope` | Имя share или пользователя |
| `quotaMb` | Лимит в МБ |
| `usedBytes` | Занято (байт) |
| `freeBytes` | Осталось (байт) |
| `deltaBytes` | Сколько пытались записать (байт) |

### 10.3. Кэш

`QuotaService` кэширует занятое место с TTL **5 секунд**. Это означает:
- Сразу после записи кэш **инвалидируется** (для того же share).
- При чтении кэш обновляется не чаще, чем раз в 5 секунд.

### 10.4. Просмотр текущих квот

Через `GET /api/info`:

```json
{
  "userQuotaMb": -1,
  "userUsedBytes": 125829120,
  "shares": [
    { "name": "Documents", "quotaMb": 200, "usedBytes": 47872450 }
  ]
}
```

---

## 11. Полный список endpoint-ов

| Метод | Endpoint | Auth | Назначение |
|---|---|---|---|
| `POST` | `/api/login` | — | Получить токен |
| `GET` | `/api/login` | — | То же, через query |
| `POST` | `/api/logout` | Токен | Отозвать токен |
| `GET` | `/api/logout` | Токен | То же, через query |
| `GET` | `/api/whoami` | Любая | Информация о сессии |
| `GET` | `/api/info` | Любая | Метаданные сервера + shares |
| `GET` | `/api/list` | `read` | Список содержимого |
| `GET` | `/api/stat` | `read` | Метаданные объекта |
| `GET` | `/api/read` | `read` | Скачать файл |
| `PUT`, `POST` | `/api/write` | `write` | Записать файл |
| `POST` | `/api/mkdir` | `write` | Создать папку |
| `DELETE`, `POST` | `/api/delete` | `delete` | Удалить |
| `POST` | `/api/move` | `delete` + `write` | Переместить |
| `POST` | `/api/copy` | `read` + `write` | Скопировать |
| `GET`, `HEAD` | `/api/public/<share>/<path>` | — | Публичный доступ |
| `GET` | `/api/events` | Токен | SSE-поток |
| `GET`, `HEAD` | `/<share>/<path>` | По share | Прямая ссылка |
| `GET`, `HEAD` | `/<file>` | — | Статика из `www/` |

---

## 12. Примеры на разных языках

### 12.1. Bash + curl

```bash
# Получить токен
TOKEN=$(curl -s -X POST http://127.0.0.1:8080/api/login \
        -H "Content-Type: application/json" \
        -d '{"user":"admin","pass":"admin123"}' \
        | jq -r .token)

# Список shares
curl -s -H "Authorization: Bearer $TOKEN" \
     http://127.0.0.1:8080/api/info | jq

# Скачать файл
curl -H "Authorization: Bearer $TOKEN" \
     -o report.pdf \
     "http://127.0.0.1:8080/api/read?path=Documents/report.pdf"

# Загрузить файл
curl -X PUT \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: text/plain" \
     --data-binary @local.txt \
     "http://127.0.0.1:8080/api/write?path=Documents/note.txt"

# Удалить
curl -X DELETE \
     -H "Authorization: Bearer $TOKEN" \
     "http://127.0.0.1:8080/api/delete?path=Documents/old.txt"
```

### 12.2. JavaScript (fetch)

```js
// --- Login ---
async function login(baseUrl, user, pass) {
    const res = await fetch(baseUrl + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, pass })
    });
    if (!res.ok) throw new Error((await res.json()).error);
    return (await res.json()).token;
}

// --- Info ---
async function getInfo(baseUrl, token) {
    const res = await fetch(baseUrl + '/api/info', {
        headers: { 'Authorization': 'Bearer ' + token }
    });
    return await res.json();
}

// --- List ---
async function listDir(baseUrl, token, path) {
    const url = baseUrl + '/api/list?path=' + encodeURIComponent(path);
    const res = await fetch(url, {
        headers: { 'Authorization': 'Bearer ' + token }
    });
    return await res.json();
}

// --- Read file (Blob) ---
async function readFile(baseUrl, token, path) {
    const url = baseUrl + '/api/read?path=' + encodeURIComponent(path);
    const res = await fetch(url, {
        headers: { 'Authorization': 'Bearer ' + token }
    });
    return await res.blob();
}

// --- Write file ---
async function writeFile(baseUrl, token, path, blob) {
    const url = baseUrl + '/api/write?path=' + encodeURIComponent(path);
    const res = await fetch(url, {
        method: 'PUT',
        headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': blob.type || 'application/octet-stream'
        },
        body: blob
    });
    return await res.json();
}

// --- SSE ---
function watch(baseUrl, token, onChange) {
    const es = new EventSource(baseUrl + '/api/events?token=' + encodeURIComponent(token));
    es.addEventListener('change', function (e) {
        onChange(JSON.parse(e.data));
    });
    return es;
}
```

### 12.3. Java

```java
import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;

public class Example {
    public static void main(String[] args) throws Exception {
        HttpClient client = HttpClient.newHttpClient();
        String baseUrl = "http://127.0.0.1:8080";

        // Login
        String loginBody = "{\"user\":\"admin\",\"pass\":\"admin123\"}";
        HttpResponse<String> loginRes = client.send(
            HttpRequest.newBuilder(URI.create(baseUrl + "/api/login"))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(loginBody))
                .build(),
            HttpResponse.BodyHandlers.ofString());

        // Простой парсинг токена (без JSON-библиотеки)
        String body = loginRes.body();
        int tIdx = body.indexOf("\"token\":\"") + 9;
        int tEnd = body.indexOf('"', tIdx);
        String token = body.substring(tIdx, tEnd);

        // Info
        HttpResponse<String> infoRes = client.send(
            HttpRequest.newBuilder(URI.create(baseUrl + "/api/info"))
                .header("Authorization", "Bearer " + token)
                .GET().build(),
            HttpResponse.BodyHandlers.ofString());

        System.out.println(infoRes.body());
    }
}
```

### 12.4. Python

```python
import requests

base = "http://127.0.0.1:8080"

# Login
r = requests.post(base + "/api/login",
                  json={"user": "admin", "pass": "admin123"})
r.raise_for_status()
token = r.json()["token"]

headers = {"Authorization": "Bearer " + token}

# Info
print(requests.get(base + "/api/info", headers=headers).json())

# List
print(requests.get(base + "/api/list",
                   params={"path": "Documents"},
                   headers=headers).json())

# Read
r = requests.get(base + "/api/read",
                 params={"path": "Documents/report.pdf"},
                 headers=headers)
open("report.pdf", "wb").write(r.content)

# Write
files = {"file": ("note.txt", b"Hello, world!", "text/plain")}
r = requests.put(base + "/api/write",
                 params={"path": "Documents/note.txt"},
                 data=b"Hello, world!",
                 headers={**headers, "Content-Type": "text/plain"})
print(r.json())

# Delete
r = requests.delete(base + "/api/delete",
                    params={"path": "Documents/old.txt"},
                    headers=headers)
print(r.json())
```

---

## Приложение A. Отладка

### Проверка доступности сервера

```bash
curl http://127.0.0.1:8080/api/info
# 401 (если нужна авторизация) или 200 (для анонима)
```

### Проверка CORS

```bash
curl -i -X OPTIONS http://127.0.0.1:8080/api/info
# HTTP/1.1 204
# Access-Control-Allow-Origin: *
# Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS, HEAD
```

### Просмотр лога сервера

Сервер логирует:
- Запуск и параметры
- Ошибки Watcher
- Стектрейсы для HTTP 500

```
[FileServer] started
  listen   : http://0.0.0.0:8080
  web root : C:\JavaProject\FileServer\www
  users    : [admin, olga, guest]
  shares   : 6
```

### DevTools → Network

Для каждого запроса к FileServer видно:
- **Request URL** — например, `http://127.0.0.1:8080/api/list?path=test`
- **Request Headers** — `Authorization: Bearer ...` или `Authorization: Basic ...`
- **Response Headers** — `Content-Type`, `Access-Control-Allow-Origin`
- **Status** — 200 / 401 / 403 / 404 / 507

**Признаки правильной настройки:**
- В каждом запросе к `/api/*` — `Authorization: Bearer ...`
- Ни в одном запросе нет `Authorization: Basic ...` (если только вы не выбрали Basic явно)
- В SSE-подключении токен идёт как `?token=...`

---

## Приложение B. Таблица совместимости

FileServer реализует **подмножество PouchDB API**, чтобы работать с существующим клиентом FileBD Manager:

| PouchDB метод | FileServer endpoint |
|---|---|
| `db.info()` | `GET /api/info` |
| `db.allDocs({startkey, endkey, include_docs, recursive})` | `GET /api/list` |
| `db.get(id)` | `GET /api/stat` |
| `db.put(doc)` | `POST /api/mkdir` (folder) / `PUT /api/write` (file) |
| `db.remove(doc)` | `DELETE /api/delete` |
| `db.getAttachment(id, 'b', {binary})` | `GET /api/read` |
| `db.putAttachment(id, 'b', rev, blob, ct)` | `PUT /api/write` |
| (SSE — аналог `db.changes()`) | `GET /api/events` |

**ID-соглашение** (как в PouchDB-версии):

| Префикс | Что означает |
|---|---|
| `d:` + `encodeURIComponent(path)` | Папка |
| `f:` + `encodeURIComponent(path)` | Файл |

Пример: `d:Documents%2F2024` — папка `Documents/2024`; `f:Documents%2Freadme.md` — файл `Documents/readme.md`.

---

## Приложение C. Ограничения

- **`allDocs` в FileServer-режиме** обрабатывает `startkey`/`endkey` через `path` — не через реальные ключи. Это значит, что **диапазонные запросы работают только для префикса пути** (то, что нужно клиенту), но не для произвольных ключей.
- **`allDocs({keys: [...]})`** реализуется через серию `GET /api/stat` — это медленнее, чем в PouchDB, но работает.
- **SSE-слежение** активно только для **первого** folder-share из `config.json`. Остальные shares не генерируют `change`-событий.
- **Квоты** — только на запись. Чтение без лимитов.
- **Токены** — в памяти. Перезапуск = выход всех пользователей.