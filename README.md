# `README.md` — FileServer

**Облачный файловый сервер** — минималистичный HTTP-сервер на чистой Java (JDK-only), который предоставляет REST API, SSE-поток событий и раздачу статики для веб-клиента. Работает с реальной файловой системой хоста, прячет физические пути за «виртуальными» ресурсами (shares) и разграничивает доступ между пользователями.

Сервер не требует внешних зависимостей, кроме `org.json` для парсинга/сериализации JSON. Всё остальное — стандартная библиотека JDK 21 (`com.sun.net.httpserver`, `java.nio.file`, `WatchService`).

---

## Содержание

1. [Что умеет](#1-что-умеет)
2. [Быстрый старт](#2-быстрый-старт)
3. [Структура проекта](#3-структура-проекта)
4. [Документация](#4-документация)
5. [Архитектура](#5-архитектура)
6. [Основные понятия](#6-основные-понятия)
7. [Установка и запуск](#7-установка-и-запуск)
8. [Проверка работы](#8-проверка-работы)
9. [Клиентская часть](#9-клиентская-часть)
10. [Безопасность](#10-безопасность)
11. [Разработка](#11-разработка)

---

## 1. Что умеет

### Файловые операции

- 📁 **Навигация по файловой системе** — список файлов, метаданные, рекурсивный обход
- 📥 **Скачивание файлов** — через REST или прямую ссылку
- 📤 **Загрузка файлов** — с автоматическим созданием родительских папок
- 📁 **Создание папок**
- ✂️ **Перемещение и копирование** — включая между разными «share-ами» и даже разными дисками
- 🗑️ **Удаление** — рекурсивное для папок

### Разграничение доступа

- 🔐 **Basic Auth и Bearer-токены** — выбор способа на клиенте
- 🎫 **Токены доступа** — 24 часа или до перезапуска сервера
- 👥 **Пользователи** — логин, пароль, общая квота
- 🗂️ **Виртуальные ресурсы (shares)** — скрывают физические пути, задают права и лимиты
- 🌐 **Публичный доступ** — для `anonymous: true` shares без пароля
- 🚫 **Защита от path traversal** — нельзя выйти за пределы физической папки share
- 🔒 **Блокировка служебных файлов** — `.idea/`, `.git/`, `.gitignore`, `config.json` никогда не отдаются

### Квоты

- 📊 **Лимит записи на share** — в мегабайтах, `-1` = без лимита
- 📊 **Лимит записи на пользователя** — суммарно по всем его shares
- ⚠️ **HTTP 507 Insufficient Storage** при превышении

### Наблюдение за изменениями

- 📡 **SSE-поток событий** — `create`, `delete`, `modify` в реальном времени
- ⏱️ **Keep-alive** — каждые 15 секунд
- 🔄 **Автопереподключение** браузером

### Статика

- 📄 **Раздача `index.html`** — с любого URL, включая `/` и `/index.html`
- 🎨 **js/, css/, lib/, modals/** — с правильными MIME-типами
- 🚫 **Защита от обхода** — нельзя получить служебные файлы

---

## 2. Быстрый старт

### Минимальный запуск

```bash
# 1. Собрать
mvn clean package

# 2. Создать конфиг (или скопировать из примера)
cat > config.json << 'EOF'
{
  "http": { "port": 8080, "host": "127.0.0.1" },
  "web": "www",
  "users": [
    { "name": "admin", "password": "admin123", "quota": -1 }
  ],
  "shares": [
    {
      "name": "test",
      "physical": "D:/DATA",
      "type": "folder",
      "access": ["read", "write", "delete"],
      "anonymous": true
    }
  ]
}
EOF

# 3. Запустить
java -cp "target/classes;%USERPROFILE%/.m2/repository/org/json/json/20230227/json-20230227.jar" \
     ru.miacomsoft.server.FileServer --config config.json
```

Открыть `http://127.0.0.1:8080/` — браузер получит `index.html` из `www/`.

### Проверка API

```bash
# Логин и получение токена
TOKEN=$(curl -s -X POST http://127.0.0.1:8080/api/login \
        -H "Content-Type: application/json" \
        -d '{"user":"admin","pass":"admin123"}' | jq -r .token)

# Список shares
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/api/info

# Список файлов
curl -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:8080/api/list?path="
```

---

## 3. Структура проекта

```
FileServer/
├── README.md                ← этот файл
├── CONFIG.md                ← описание config.json
├── API.md                   ← справочник по REST API
├── AUTH.md                  ← механизм авторизации
├── config.json              ← конфигурация сервера
│
├── src/
│   └── main/
│       └── java/
│           └── ru/miacomsoft/server/
│               ├── FileServer.java         — точка входа
│               ├── Config.java             — парсер config.json
│               ├── AuthService.java        — аутентификация
│               ├── TokenService.java       — токены доступа
│               ├── QuotaService.java       — квоты
│               ├── VirtualResolver.java    — резолв виртуальных путей
│               ├── FileService.java        — операции с диском
│               ├── FileWatcher.java        — слежение за ФС
│               ├── ApiHandler.java         — /api/*
│               ├── StaticHandler.java      — раздача www/
│               ├── RootHandler.java        — диспетчер /
│               ├── SseHandler.java         — /api/events
│               └── SseConnection.java      — SSE-канал
│
├── pom.xml                  ← Maven-конфигурация
│
└── www/                     ← статика (отдаётся клиенту)
    ├── index.html
    ├── login.html           ← страница получения токена
    ├── css/
    ├── js/
    ├── modals/
    └── lib/
```

---

## 4. Документация

Проект имеет три подробных документа, описывающих ключевые части:

| Документ | Что описывает |
|---|---|
| **[CONFIG.md](CONFIG.md)** | Полное описание всех параметров `config.json`: секции `http`, `web`, `users`, `shares`. Правила именования, квоты, примеры комбинирования, типичные ошибки |
| **[API.md](API.md)** | Справочник по REST API: все endpoint-ы, параметры, форматы ответов, примеры на Bash/JS/Java/Python. Прямые URL, публичный доступ, SSE |
| **[AUTH.md](AUTH.md)** | Механизм аутентификации и авторизации: способы входа (Basic/Bearer/query/anonymous), токены, проверка прав, жизненный цикл, безопасность |

**Рекомендуемый порядок чтения:**

1. **README.md** (этот файл) — общее представление
2. **CONFIG.md** — как настроить сервер под себя
3. **API.md** — как обращаться к API
4. **AUTH.md** — как устроена авторизация (если нужно углубиться)

---

## 5. Архитектура

### 5.1. Слои

```
┌──────────────────────────────────────────────────────────────┐
│  HTTP-слой (com.sun.net.httpserver)                          │
│                                                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │ ApiHandler   │  │ RootHandler  │  │ SseHandler   │         │
│  │ /api/*       │  │ /            │  │ /api/events  │         │
│  └──────┬───────┘  └──────┬───────┘  └──────────────┘         │
│         │                 │                                    │
│         └────────┬────────┘                                    │
│                  │                                              │
│         ┌────────┴─────────┐                                   │
│         │  StaticHandler   │  ← www/*                          │
│         └──────────────────┘                                   │
└──────────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────┴────────────────────────────────────┐
│  Сервисный слой                                              │
│                                                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │ AuthService  │  │ QuotaService │  │ TokenService │         │
│  └──────────────┘  └──────────────┘  └──────────────┘         │
│                                                                │
│  ┌────────────────────┐  ┌──────────────┐                     │
│  │ VirtualResolver    │  │ FileService  │                     │
│  └────────────────────┘  └──────────────┘                     │
└──────────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────┴────────────────────────────────────┐
│  Данные                                                       │
│                                                                │
│  ┌─────────────────┐  ┌────────────────────────────────────┐  │
│  │  Config         │  │  Файловая система хоста            │  │
│  │  (config.json)  │  │  (java.nio.file)                   │  │
│  └─────────────────┘  └────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### 5.2. Принципы

- **Разделение ответственности.** Аутентификация (кто ты) отделена от авторизации (что тебе можно).
- **Виртуальные пути.** Клиент не знает физических путей, только имена shares.
- **Sandbox.** Все файловые операции ограничены корнем share (`Path.startsWith`).
- **Идемпотентность.** `mkdir`, `delete`, `put` можно вызывать повторно без ошибок.
- **Отказоустойчивость.** Ошибки Watcher не валят сервер. Отсутствие папки share не блокирует запуск.

---

## 6. Основные понятия

### 6.1. Share

**Виртуальный ресурс**, скрывающий реальную папку или файл на диске. Пользователь видит только имя share, но работает с файлами из `physical`-пути.

```json
{
  "name": "Documents",
  "physical": "C:/data/docs",
  "type": "folder",
  "access": ["read", "write", "delete"],
  "anonymous": false,
  "users": ["admin", "olga"],
  "quota": 200
}
```

Клиент видит `Documents`, а реальные файлы лежат в `C:/data/docs`. Пользователь может записать только 200 МБ.

### 6.2. Виртуальный путь

Первый сегмент пути — имя share, остальное — относительный путь внутри:

```
Documents/reports/2024.pdf
   ↑           ↑
  share      относительный путь
```

Физически: `C:/data/docs/reports/2024.pdf`.

### 6.3. Права

Три уровня прав на каждый share:

| Право | Что разрешает |
|---|---|
| `read` | Просмотр, чтение, скачивание |
| `write` | Создание файлов и папок |
| `delete` | Удаление и перемещение |

### 6.4. Анонимный доступ

`anonymous: true` открывает share для всех без авторизации. Используется для публичных ресурсов (медиа, документация, ROM-ы и т.д.).

### 6.5. Токены

Временные ключи доступа (24 часа). Выдаются через `POST /api/login`, используются в заголовке `Authorization: Bearer <token>` или в query-параметре `?token=<token>`.

---

## 7. Установка и запуск

### 7.1. Требования

- **JDK 21+** (`java -version` → должен показать 21)
- **Maven 3.8+**
- Порт для сервера (по умолчанию 8080)

### 7.2. Сборка

```bash
mvn clean package
```

Появится `target/file-server-1.0-SNAPSHOT.jar`. Все классы также в `target/classes`.

### 7.3. Конфигурация

Создать `config.json` рядом с местом запуска. Минимальный пример:

```json
{
  "http": { "port": 8080, "host": "0.0.0.0" },
  "web": "www",
  "users": [
    { "name": "admin", "password": "admin123", "quota": -1 }
  ],
  "shares": [
    {
      "name": "test",
      "physical": "D:/DATA",
      "type": "folder",
      "access": ["read", "write", "delete"],
      "anonymous": true
    }
  ]
}
```

Полное описание всех параметров — в [CONFIG.md](CONFIG.md).

### 7.4. Запуск

**Windows:**

```bat
java -cp "target\classes;%USERPROFILE%\.m2\repository\org\json\json\20230227\json-20230227.jar" ^
     ru.miacomsoft.server.FileServer --config config.json
```

**Linux/macOS:**

```bash
java -cp "target/classes:$HOME/.m2/repository/org/json/json/20230227/json-20230227.jar" \
     ru.miacomsoft.server.FileServer --config config.json
```

**Через exec-maven-plugin** (если настроен):

```bash
mvn exec:java \
    -Dexec.mainClass=ru.miacomsoft.server.FileServer \
    -Dexec.args="--config config.json"
```

### 7.5. Параметры CLI

Все параметры опциональны, перекрывают значения из `config.json`:

| Параметр | Описание |
|---|---|
| `--config <path>` | Путь к `config.json` (по умолчанию `./config.json`) |
| `--port <N>` | Порт |
| `--host <H>` | Интерфейс |
| `--web <W>` | Путь к каталогу статики |

Пример:

```bash
java ... FileServer --config prod.json --port 9090 --web /opt/filebd/www
```

### 7.6. Ожидаемый вывод при запуске

```
[FileServer] started
  listen   : http://0.0.0.0:8080
  web root : C:\JavaProject\FileServer\www
  users    : [admin, olga, guest]
  shares   : 6
```

### 7.7. Автозапуск

**Windows:** положить `.bat` в `shell:startup`.

**Linux (systemd):**

```ini
[Unit]
Description=FileServer
After=network.target

[Service]
Type=simple
User=filebd
WorkingDirectory=/opt/filebd
ExecStart=/usr/bin/java -cp "/opt/filebd/target/classes:/opt/filebd/lib/json.jar" ru.miacomsoft.server.FileServer --config /opt/filebd/config.json
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

---

## 8. Проверка работы

### 8.1. Сервер слушает

```bash
curl http://127.0.0.1:8080/api/info
# 200 (аноним) или 401 (нужна авторизация)
```

### 8.2. Логин

```bash
curl -X POST http://127.0.0.1:8080/api/login \
     -H "Content-Type: application/json" \
     -d '{"user":"admin","pass":"admin123"}'
```

Ожидаемый ответ:

```json
{
  "ok": true,
  "token": "3Kf7xQzLmNp...23ByQ",
  "expiresAt": 1737086400000,
  "ttlMs": 86400000
}
```

### 8.3. Доступ к файлу

```bash
# Публичный share (anonymous: true)
curl http://127.0.0.1:8080/test/file.sfc

# Приватный share с токеном
curl -H "Authorization: Bearer $TOKEN" \
     "http://127.0.0.1:8080/Documents/report.pdf"
```

### 8.4. Статика

```bash
# Должен вернуться HTML
curl http://127.0.0.1:8080/

# Должен вернуться JS
curl http://127.0.0.1:8080/js/23-main.js

# Должно вернуться 403 (заблокировано)
curl -I http://127.0.0.1:8080/config.json
```

### 8.5. SSE-поток

```bash
curl -N http://127.0.0.1:8080/api/events
# event: ready
# data: {"id":"sse-1"}
#
# event: ping
# data: {"t":1737000000000}
```

---

## 9. Клиентская часть

Всё, что лежит в `www/`, — это клиент. Сервер только отдаёт файлы, вся логика — в JS.

### 9.1. Что должно быть в `www/`

- `index.html` — основной UI (двухпанельный файловый менеджер)
- `login.html` — форма получения токена (опционально)
- `css/` — стили
- `js/` — логика
- `modals/` — HTML-фрагменты модалок
- `lib/` — сторонние библиотеки

Клиент из проекта **FileBD Manager** уже готов к работе: он умеет и `CouchDB`, и `FileServer` (тип источника выбирается в модалке подключения).

### 9.2. Подключение клиента

1. Открыть `http://127.0.0.1:8080/`.
2. В модалке подключения выбрать **💾 Локальный диск (FileServer.java)**.
3. Ввести:
   - **Адрес:** `http://127.0.0.1:8080`
   - **Логин:** `admin`
   - **Пароль:** `admin123`
4. Нажать **Подключиться**.

Клиент автоматически вызовет `/api/login`, получит токен и подставит его во все дальнейшие запросы как `Authorization: Bearer ...`.

### 9.3. Прямые URL

Для `<img>`, `<video>`, `<audio>` и обычных `<a href>` токен передаётся в query:

```
http://127.0.0.1:8080/Documents/photo.jpg?token=3Kf7xQzLmNp...
```

Метод `FAR.FsClient.prototype.directUrl(share, path)` строит такой URL автоматически.

---

## 10. Безопасность

### 10.1. Что защищено

- ✅ **Пароли** — Basic Auth и `?user=&pass=`
- ✅ **Токены** — криптостойкие (24 байта через `SecureRandom`)
- ✅ **Path traversal** — нормализация + `Path.startsWith(root)`
- ✅ **Escape из share** — проверка `physical.startsWith(shareRoot)`
- ✅ **Служебные файлы** — `.idea/`, `.git/`, `.gitignore`, `config.json` заблокированы

### 10.2. Что НЕ защищено

- ❌ **Пароли в config.json** — открытый текст. Для продакшена нужны хэши.
- ❌ **Токены в памяти** — перезапуск обнуляет все сессии.
- ❌ **HTTPS** — по умолчанию не настроен. Пароли и токены передаются в открытом виде.
- ❌ **Rate-limiting** — брутфорс не ограничен.
- ❌ **Аудит** — успешные логины не пишутся в лог.

### 10.3. Рекомендации

1. **HTTPS** через reverse-proxy (nginx, Apache) или встроенный `HttpsServer` с сертификатом.
2. **Хэширование паролей** — храните `passwordHash` вместо `password`.
3. **Persistent токены** — в файле или Redis, чтобы переживали перезапуск.
4. **Rate-limiting** — ограничьте попытки входа (например, 5 за 15 минут).
5. **Логирование** — пишите все операции записи и удаления с указанием пользователя.
6. **Reverse-proxy** — не выставляйте сервер напрямую в интернет.

Полный разбор безопасности — в [AUTH.md → раздел 14](AUTH.md#14-безопасность).

---

## 11. Разработка

### 11.1. Технологии

- **Java 21** — язык
- **Maven** — сборка
- **`com.sun.net.httpserver`** — HTTP-сервер (входит в JDK)
- **`java.nio.file`** — файловые операции
- **`WatchService`** — слежение за изменениями
- **`org.json`** — JSON-парсинг и сериализация

### 11.2. Как расширять

#### Добавить новый endpoint

1. Откройте `ApiHandler.java`.
2. В `switch (path)` добавьте `case "/api/myendpoint":`.
3. Реализуйте `handleMyEndpoint(HttpExchange ex, ...)`.
4. Используйте `FileServer.sendJson()` / `FileServer.sendError()` для ответов.

#### Добавить поле в конфиг

1. Откройте `Config.java`.
2. В нужном классе (`User` / `Share`) добавьте поле.
3. В `Config.load()` извлеките его через `root.optXXX(...)`.
4. Используйте в `AuthService` / `QuotaService` / `ApiHandler`.

#### Добавить способ аутентификации

1. Откройте `AuthService.java`.
2. В `authenticate()` добавьте ветку проверки в нужное место (порядок важен).
3. Верните `Session` через `sessionFromToken()` или создайте вручную.

#### Добавить публичный endpoint

Публичные endpoint-ы регистрируются до вызова `authenticate()` в `ApiHandler.handle()`. Пример — `handlePublic()`, `handleLogin()`.

### 11.3. Отладка

**Просмотр запросов в браузере:**

F12 → Network → фильтр `8080`. Видны все заголовки, включая `Authorization`.

**Проверка без браузера:**

```bash
curl -v http://127.0.0.1:8080/api/info
```

Флаг `-v` покажет все заголовки запроса и ответа.

**Логи сервера:**

При HTTP 500 в консоль печатается стектрейс. Остальные запросы логируются минимально.

**Проверка CORS:**

```bash
curl -i -X OPTIONS http://127.0.0.1:8080/api/info
```

Должен вернуть `204 No Content` с заголовками `Access-Control-Allow-*`.

### 11.4. Известные ограничения

- **`allDocs` в PouchDB-режиме:** работает только для префикса пути, не для произвольных ключей.
- **SSE-слежение:** активно только для **первого** folder-share из `config.json`.
- **Квоты:** только на запись, не на чтение.
- **Токены:** в памяти, обнуляются при перезапуске.
- **Hot-reload конфига:** нет. При изменении `config.json` нужен перезапуск.

### 11.5. Совместимость с PouchDB

Сервер реализует подмножество PouchDB API, чтобы работать с существующим клиентом FileBD Manager:

| PouchDB метод | FileServer endpoint |
|---|---|
| `db.info()` | `GET /api/info` |
| `db.allDocs({...})` | `GET /api/list` |
| `db.get(id)` | `GET /api/stat` |
| `db.put(doc)` | `POST /api/mkdir` / `PUT /api/write` |
| `db.remove(doc)` | `DELETE /api/delete` |
| `db.getAttachment(id, 'b')` | `GET /api/read` |
| `db.putAttachment(...)` | `PUT /api/write` |
| `db.changes()` (аналог) | `GET /api/events` |

ID-соглашение как в PouchDB-версии:

- `d:<encoded-path>` — папка
- `f:<encoded-path>` — файл

---

## Ссылки

- **[CONFIG.md](CONFIG.md)** — описание `config.json`
- **[API.md](API.md)** — справочник по REST API
- **[AUTH.md](AUTH.md)** — механизм авторизации

---

## Лицензия
Внутренний проект. Все права принадлежат правообладателю.

