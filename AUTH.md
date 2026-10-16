# `AUTH.md` — Механизм авторизации на FileServer

Документ описывает полную схему аутентификации, авторизации и разграничения доступа в Java-сервере `FileServer` (пакет `ru.miacomsoft.server`).

---

## Содержание

1. [Общая схема](#1-общая-схема)
2. [Учётные записи и конфигурация](#2-учётные-записи-и-конфигурация)
3. [Три способа аутентификации](#3-три-способа-аутентификации)
4. [Токены доступа](#4-токены-доступа)
5. [Модель прав (shares)](#5-модель-прав-shares)
6. [Проверка прав при запросе](#6-проверка-прав-при-запросе)
7. [Публичный доступ без пароля](#7-публичный-доступ-без-пароля)
8. [Прямые URL к файлам](#8-прямые-url-к-файлам)
9. [HTTP-коды ответов](#9-http-коды-ответов)
10. [Примеры запросов](#10-примеры-запросов)
11. [Жизненный цикл токена](#11-жизненный-цикл-токена)
12. [Порядок проверок в коде](#12-порядок-проверок-в-коде)
13. [Клиентская сторона](#13-клиентская-сторона)
14. [Безопасность](#14-безопасность)

---

## 1. Общая схема

```
┌─────────────────────────────────────────────────────────────────┐
│  Клиент                                                          │
│  (браузер, curl, PowerShell, другое приложение)                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │  HTTP-запрос
                              │  + один из:
                              │    • Authorization: Basic <base64>
                              │    • Authorization: Bearer <token>
                              │    • X-Auth-Token: <token>
                              │    • ?token=<token>
                              │    • ?user=<u>&pass=<p>
                              │    • без заголовков (аноним)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  FileServer.java                                                 │
│                                                                  │
│  ┌──────────────────────────┐                                    │
│  │  AuthService             │  ← определяет Session              │
│  │  .authenticate(ex)       │                                    │
│  └──────────────────────────┘                                    │
│              │                                                   │
│              ▼                                                   │
│  Session { username?, anonymous, user? }                         │
│              │                                                   │
│              ▼                                                   │
│  ┌──────────────────────────┐                                    │
│  │  Проверка прав           │  ← canRead / canWrite / canDelete  │
│  │  на конкретный share     │    + visibleTo(user)               │
│  └──────────────────────────┘                                    │
│              │                                                   │
│              ▼                                                   │
│   Разрешить / 401 / 403                                          │
└─────────────────────────────────────────────────────────────────┘
```

**Ключевая идея:** аутентификация (кто ты) полностью отделена от авторизации (что тебе можно). За аутентификацию отвечает `AuthService.authenticate()`, за авторизацию — методы `canRead/canWrite/canDelete` и `visibleTo()` в конфигурации.

---

## 2. Учётные записи и конфигурация

Все пользователи и их права описаны в `config.json`.

### 2.1. Пользователи

```json
{
  "users": [
    { "name": "admin", "password": "admin123", "quota": -1 },
    { "name": "olga",  "password": "olga2024", "quota": 500 },
    { "name": "guest", "password": "",         "quota": 100 }
  ]
}
```

| Поле | Описание |
|---|---|
| `name` | Логин. Уникальный в пределах конфига. |
| `password` | Пароль в открытом виде. Пустая строка — вход без пароля (только по логину). |
| `quota` | Лимит на запись в мегабайтах. `-1` — без лимита. |

### 2.2. Расшаренные ресурсы (shares)

Каждый share описывает виртуальную «папку» или «файл», доступный пользователям:

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

| Поле | Описание |
|---|---|
| `name` | Виртуальное имя. Оно видно пользователю в UI. |
| `physical` | Физический путь на диске. Скрыт от клиента. |
| `type` | `folder` или `file`. |
| `access` | Набор из `read`, `write`, `delete`. |
| `anonymous` | `true` — доступ без пароля. |
| `users` | Список логинов, которым виден этот share (если `anonymous: false`). |
| `quota` | Лимит записи именно в этот share (МБ). `-1` — без лимита. |

---

## 3. Три способа аутентификации

`AuthService.authenticate(HttpExchange ex)` перебирает источники **в строгом порядке** и возвращает первую валидную сессию.

### 3.1. `Authorization: Basic <base64>`

Стандартный HTTP Basic Auth.

```
Authorization: Basic YWRtaW46YWRtaW4xMjM=
                     ↑ base64("admin:admin123")
```

**Плюсы:** простой, работает в любом клиенте, встроен в браузер.
**Минусы:** пароль передаётся при каждом запросе (base64 — не шифрование, только кодирование; безопасно только поверх HTTPS).

### 3.2. `Authorization: Bearer <token>`

Токен, выданный `/api/login`. Это **основной способ** для клиентской части.

```
Authorization: Bearer 3Kf7xQzLmNp...23ByQ
```

**Плюсы:** пароль передаётся один раз (при логине), токен отзывается, токен истекает.
**Минусы:** нужен дополнительный шаг логина.

### 3.3. `X-Auth-Token: <token>`

Альтернативный заголовок для сред, где нельзя переопределить `Authorization` (некоторые прокси, WebDAV-клиенты).

```
X-Auth-Token: 3Kf7xQzLmNp...23ByQ
```

### 3.4. `?token=<token>` в query

Используется, когда заголовки недоступны (EventSource в браузере, `<img src>`, `<video src>`, прямые ссылки).

```
GET /test/file.sfc?token=3Kf7xQzLmNp...23ByQ
```

### 3.5. `?user=<u>&pass=<p>` в query

Удобно для отладки в браузере.

```
GET /test/file.sfc?user=admin&pass=admin123
```

### 3.6. Анонимная сессия

Если ничего не передано — создаётся анонимная сессия. Она видит только те shares, у которых `anonymous: true` и `access` содержит `read`. Всё остальное → 403.

### 3.7. Порядок проверки

```java
authenticate(ex):
  1. Authorization: Bearer ...
  2. X-Auth-Token: ...
  3. Authorization: Basic ...
  4. ?token=...
  5. ?user=...&pass=...
  6. аноним
```

Первый успешно распознанный способ выигрывает. Если `Bearer` указан, но токен невалиден — сессия не создаётся, и это `401`.

---

## 4. Токены доступа

### 4.1. Формат

Токен — это 24 случайных байта (`SecureRandom`), закодированных в URL-safe Base64 без padding:

```
3Kf7xQzLmNpZm9vYmFyYmF6cXV4...23ByQ
```

Длина — 32 символа. Такие токены безопасно передавать в URL, куках и заголовках.

### 4.2. Хранение

Токены хранятся **в памяти** (`TokenService`), в `ConcurrentHashMap<String, Token>`:

```java
class Token {
    String value;      // сам токен
    String username;   // кому выдан
    long issuedAt;     // unix ms
    long expiresAt;    // issuedAt + 24h
}
```

**Не сохраняются на диск.** Это значит:
- **Перезапуск сервера обнуляет все токены.**
- Клиент должен повторить `/api/login`.

### 4.3. Срок жизни

`TTL_MS = 24 * 60 * 60 * 1000` — ровно 24 часа.

При каждом `validate()` проверяется `expiresAt`. Просроченные удаляются и не возвращаются.

Периодической очистки нет — она делается «лениво» при выдаче нового токена (`cleanupExpired()` вызывается из `issue()`).

### 4.4. Выдача

**Endpoint:** `POST /api/login`

**Body (JSON):**
```json
{ "user": "admin", "pass": "admin123" }
```

**Body (form-urlencoded):**
```
user=admin&pass=admin123
```

**Query:** `GET /api/login?user=admin&pass=admin123` (для отладки)

**Ответ 200:**
```json
{
  "ok": true,
  "token": "3Kf7xQzLmNp...23ByQ",
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

### 4.5. Отзыв

**Endpoint:** `POST /api/logout`

**Body:** `{ "token": "3Kf7x..." }` или `token=...`

Также можно указать токен в `Authorization: Bearer ...`:

```bash
curl -X POST http://localhost:8080/api/logout \
     -H "Authorization: Bearer 3Kf7x..."
```

Ответ:
```json
{ "ok": true }
```

После отзыва все последующие запросы с этим токеном получат 401.

### 4.6. Проверка

**Endpoint:** `GET /api/whoami`

Возвращает данные текущей сессии:

```json
{
  "anonymous": false,
  "username": "admin",
  "quotaMb": -1
}
```

---

## 5. Модель прав (shares)

### 5.1. Что такое share

Share — это **виртуальная папка или файл**, доступный пользователю через API. Пользователь **не знает** о физическом пути на диске:

```
Виртуальный путь:  Documents/report.pdf
Физический путь:   C:/data/docs/report.pdf
```

Соответствие задаётся в `config.json` полем `physical` для share `Documents`.

### 5.2. Три уровня прав

| Право | Что разрешает |
|---|---|
| `read` | Просмотр списка файлов, чтение содержимого, скачивание |
| `write` | Создание папок, запись файлов, копирование в этот share |
| `delete` | Удаление файлов и папок, перемещение из этого share |

Права применяются ко **всему** поддереву share. Отдельных прав на отдельные файлы нет.

### 5.3. Кто видит share

Функция `Config.Share.visibleTo(username, anonymousSession)`:

```java
if (anonymous) return true;                    // share публичный
if (anonymousSession) return false;            // анонимам — только публичные
return username != null && users.contains(username);
```

Итого:

| anonymous | users | Кто видит |
|---|---|---|
| `true` | — | Все, включая анонимов |
| `false` | `["admin"]` | Только admin |
| `false` | `[]` | Никто (только явно перечисленные) |

### 5.4. Комбинация прав и видимости

**Пример:** share `Documents`:

```json
{
  "access": ["read", "write"],
  "anonymous": false,
  "users": ["admin", "olga"]
}
```

- `admin` и `olga` — видят, могут читать и писать.
- `guest` — не видит (его нет в `users`), все запросы → 403.
- Аноним — не видит, все запросы → 403.

**Пример:** share `PublicReports`:

```json
{
  "access": ["read"],
  "anonymous": true,
  "users": []
}
```

- **Все** видят и читают.
- Никто не может писать или удалять (даже admin).

---

## 6. Проверка прав при запросе

### 6.1. Жизненный цикл

```
HTTP-запрос
    │
    ▼
ApiHandler.handle() / RootHandler.handle()
    │
    ├─ 1. OPTIONS?  → CORS preflight, 204
    │
    ├─ 2. /api/login  или /api/logout?  → обработать без auth
    │
    ├─ 3. /api/public/*?  → публичный endpoint
    │
    ├─ 4. AuthService.authenticate(ex) → Session
    │
    ▼
ApiHandler.handleXxx() / RootHandler.serveFromShare()
    │
    ├─ 5. VirtualResolver.resolve(auth, session, path, action)
    │     • находит share по имени
    │     • проверяет canRead/canWrite/canDelete
    │     • проверяет видимость
    │     • резолвит физический путь и защищает от ../ escapes
    │
    ▼
Файловая операция → 200 / 401 / 403 / 404 / 507
```

### 6.2. Класс `VirtualResolver`

Центральная точка авторизации. Метод `resolve()`:

```java
public static Resolved resolve(
    AuthService auth,
    AuthService.Session session,
    String virtualPath,   // "Documents/report.pdf"
    String action         // "read" | "write" | "delete"
) throws NoSuchFileException
{
    String norm = FileService.normalize(virtualPath);
    if (norm.isEmpty()) return root;

    // Разбор "shareName/rest"
    String shareName = ...;
    String rest = ...;

    Config.Share share = auth.config().findShare(shareName);
    if (share == null) throw new NoSuchElementException(...);

    // Проверка прав
    boolean ok = switch (action) {
        case "read"   -> auth.canRead(session, share);
        case "write"  -> auth.canWrite(session, share);
        case "delete" -> auth.canDelete(session, share);
        default       -> false;
    };
    if (!ok) throw new SecurityException(...);

    // Файловый share не имеет детей
    if (share.isFile() && !rest.isEmpty())
        throw new NoSuchFileException(...);

    // Резолв физического пути + защита от escapes
    Path physical = share.physicalPath();
    if (!rest.isEmpty()) {
        physical = physical.resolve(rest).normalize();
        if (!physical.startsWith(share.physicalPath()))
            throw new SecurityException("Path escapes share");
    }

    return new Resolved(share, rest, physical);
}
```

### 6.3. Соответствие action и права

| HTTP-операция | Endpoint | action |
|---|---|---|
| Просмотр списка | `GET /api/list` | `read` |
| Чтение метаданных | `GET /api/stat` | `read` |
| Скачивание | `GET /api/read` | `read` |
| Прямой URL | `GET /<share>/<path>` | `read` |
| Запись файла | `PUT /api/write` | `write` |
| Создание папки | `POST /api/mkdir` | `write` |
| Удаление | `DELETE /api/delete` | `delete` |
| Перемещение | `POST /api/move` | `delete` (источник) + `write` (цель) |
| Копирование | `POST /api/copy` | `read` (источник) + `write` (цель) |

Для `move` и `copy` проверки выполняются дважды — на источник и на цель. При работе **между разными shares** это гарантирует, что пользователь имеет право и на исходный, и на целевой ресурс.

---

## 7. Публичный доступ без пароля

### 7.1. Endpoint `/api/public/*`

**Публичный** — только для shares с `anonymous: true`.

```
GET /api/public/<shareName>/<relPath>
```

Пример:

```
GET /api/public/PublicReports/2024-Q1.pdf
```

Здесь **не требуется ни пароль, ни токен**. Проверка:

```java
Config.Share sh = auth.findPublicShare(shareName);
// findPublicShare возвращает share ТОЛЬКО если:
//   • share существует
//   • anonymous == true
//   • access содержит "read"
```

Всё остальное → 403.

### 7.2. Разница с прямым URL

| | `/api/public/<share>/<path>` | `/<share>/<path>` |
|---|---|---|
| Только анонимные shares | ✅ | ❌ |
| Работает для приватных shares с токеном | ❌ | ✅ |
| Требует авторизации | Нет | Если share не анонимный |

### 7.3. Особенность анонимных shares

Если в конфиге share `anonymous: true`, он доступен **всеми способами** без пароля:

```
GET /test/file.sfc                             → 200
GET /test/file.sfc?token=xxx                   → 200 (токен не нужен, но и не мешает)
GET /api/public/test/file.sfc                  → 200
GET /api/read?path=test/file.sfc               → 200 (аноним)
GET /api/read?path=test/file.sfc               → 200 (с токеном)
```

Все они упираются в одну и ту же проверку `visibleTo()` — для `anonymous: true` всегда возвращает `true`.

---

## 8. Прямые URL к файлам

### 8.1. Схема

```
GET /<shareName>/<relative-path>
```

`RootHandler` разбирает URI:

1. **Сначала пробует статику** из `www/` (index.html, js, css, lib).
2. **Если файла нет** — первый сегмент трактуется как имя share.
3. **Резолвит физический путь** и отдаёт файл.

### 8.2. Примеры

**Публичный share (`test`, `anonymous: true`):**

```
http://127.0.0.1:8080/test/Blackthorne%20(U)%20%5BT%20Rus%20Shedevr%20(12.07.2003)%5D.sfc
```

Ответ — файл, 200 OK. **Без токена, без пароля.**

**Приватный share (`Documents`, `anonymous: false`, `users: ["admin","olga"]`):**

```
http://127.0.0.1:8080/Documents/report.pdf
```

Без авторизации — 403.

С токеном в заголовке:

```bash
curl -H "Authorization: Bearer 3Kf7x..." \
     http://127.0.0.1:8080/Documents/report.pdf
```

Или с токеном в URL (для браузера, `<img>`, `<video>`):

```
http://127.0.0.1:8080/Documents/report.pdf?token=3Kf7x...
```

Или с Basic-авторизацией (если браузер сам отправит):

```bash
curl -u admin:admin123 http://127.0.0.1:8080/Documents/report.pdf
```

### 8.3. Кодирование `/` в URL

Символ `/` в пути можно кодировать как `%2F`:

```
http://127.0.0.1:8080/test%2FBlackthorne.sfc
```

`RootHandler` декодирует `%2F` → `/`, потом разбирает путь. **Работает идентично прямому варианту.**

### 8.4. HEAD-запрос

```
HEAD /test/file.sfc
```

Возвращает только заголовки (`Content-Type`, `Content-Length`), без тела. Полезно для проверки существования файла без скачивания.

---

## 9. HTTP-коды ответов

| Код | Когда |
|---|---|
| **200 OK** | Успешный ответ |
| **204 No Content** | Успешный OPTIONS (CORS preflight) |
| **400 Bad Request** | Отсутствует обязательный параметр (`path`, `from`, `to`) |
| **401 Unauthorized** | Аутентификация не пройдена: неверный логин/пароль, невалидный токен, истёкший токен |
| **403 Forbidden** | Аутентификация пройдена, но нет прав: share невидим, нет права `read`/`write`/`delete`, попытка выйти за share через `../` |
| **404 Not Found** | Файл/share не существует |
| **405 Method Not Allowed** | Метод не поддерживается endpoint-ом |
| **500 Internal Server Error** | Непредвиденная ошибка сервера |
| **507 Insufficient Storage** | Превышена квота (share или user) |

### 9.1. Формат ошибок

Все ошибки возвращаются как JSON:

```json
{
  "error": "Forbidden: Access denied to share: Documents (read)",
  "status": 403
}
```

Для квоты — расширенный формат:

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

---

## 10. Примеры запросов

### 10.1. Логин и получение токена

**curl:**
```bash
curl -X POST http://127.0.0.1:8080/api/login \
     -H "Content-Type: application/json" \
     -d '{"user":"admin","pass":"admin123"}'
```

**PowerShell:**
```powershell
$body = '{"user":"admin","pass":"admin123"}'
$res = Invoke-RestMethod -Uri http://127.0.0.1:8080/api/login `
                         -Method Post -Body $body `
                         -ContentType "application/json"
$token = $res.token
```

**JavaScript (fetch):**
```js
const res = await fetch("http://127.0.0.1:8080/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: "admin", pass: "admin123" })
});
const { token } = await res.json();
```

### 10.2. Список shares

```bash
curl -H "Authorization: Bearer $TOKEN" \
     "http://127.0.0.1:8080/api/info"
```

Ответ:

```json
{
  "type": "filesystem",
  "username": "admin",
  "anonymous": false,
  "userQuotaMb": -1,
  "userUsedBytes": 125829120,
  "shares": [
    { "name": "Documents", "type": "folder",
      "access": ["read","write","delete"],
      "quotaMb": 200, "usedBytes": 47872450 },
    { "name": "Photos", "type": "folder",
      "access": ["read","write"],
      "quotaMb": -1, "usedBytes": 0 }
  ]
}
```

### 10.3. Содержимое папки

```bash
curl -H "Authorization: Bearer $TOKEN" \
     "http://127.0.0.1:8080/api/list?path=Documents"
```

### 10.4. Скачивание файла

```bash
curl -H "Authorization: Bearer $TOKEN" \
     -o report.pdf \
     "http://127.0.0.1:8080/api/read?path=Documents/report.pdf"
```

### 10.5. Прямой URL с токеном в query

```
http://127.0.0.1:8080/Documents/report.pdf?token=3Kf7xQzLmNp...23ByQ
```

### 10.6. Публичный ресурс

```bash
# Никакой авторизации не нужно:
curl http://127.0.0.1:8080/api/public/PublicReports/2024-Q1.pdf
curl http://127.0.0.1:8080/test/Blackthorne.sfc
```

### 10.7. Отзыв токена

```bash
curl -X POST http://127.0.0.1:8080/api/logout \
     -H "Content-Type: application/json" \
     -d "{\"token\":\"$TOKEN\"}"
```

---

## 11. Жизненный цикл токена

```
┌──────────────────────────────────────────────────────────────┐
│  1. ПОЛЬЗОВАТЕЛЬ                                             │
│     Вводит login/password в UI или в POST /api/login         │
└──────────────────────────────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────────┐
│  2. СЕРВЕР                                                   │
│     Проверяет user/pass по config.json                       │
│     Создаёт Token { value, username, issuedAt, expiresAt }   │
│     Кладёт в ConcurrentHashMap                               │
│     Возвращает { token, expiresAt, ttlMs }                   │
└──────────────────────────────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────────┐
│  3. КЛИЕНТ                                                   │
│     Сохраняет токен (localStorage / память / cookie)         │
│     Использует в Authorization: Bearer ...                   │
│     Пока expiresAt не наступил — работает                    │
└──────────────────────────────────────────────────────────────┘
                     │
        ┌────────────┼────────────────────┐
        │            │                    │
        ▼            ▼                    ▼
  ┌──────────┐  ┌──────────┐    ┌──────────────────┐
  │ 24 часа  │  │ logout   │    │ перезапуск       │
  │ истекли  │  │ вызван   │    │ сервера          │
  └──────────┘  └──────────┘    └──────────────────┘
        │            │                    │
        └────────────┴────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────────┐
│  4. ТОКЕН УДАЛЯЕТСЯ                                          │
│     Все запросы → 401                                        │
│     Клиент должен заново вызвать POST /api/login             │
└──────────────────────────────────────────────────────────────┘
```

**Важно:** токены живут в памяти сервера. Перезапуск (`Ctrl+C`, `kill`, перезагрузка) обнуляет **все** активные сессии. Это осознанное решение: для долгоживущих сессий нужно персистентное хранилище (файл/БД), которое добавляется отдельно.

---

## 12. Порядок проверок в коде

Полный путь одного запроса `GET /test/photo.jpg?token=abc`:

```
1. FileServer.handleOptions(ex)
   ↓ не OPTIONS, продолжаем

2. RootHandler.handle(ex)
   ↓
   2a. Пробуем статику из www/:
       tryResolve("test/photo.jpg") → null (файла нет)
   ↓
   2b. Ищем share "test" в config.json → найден
   ↓
   2c. serveFromShare(ex, share, "photo.jpg")

3. serveFromShare():
   ↓
   3a. Проверка метода: GET или HEAD ✓
   ↓
   3b. Нормализация rel-пути: "photo.jpg"
   ↓
   3c. share.hasRead() == true ✓
   ↓
   3d. AuthService.authenticate(ex):
       ↓
       - Authorization: Bearer? — нет
       - X-Auth-Token? — нет
       - Authorization: Basic? — нет
       - ?token=abc? — да
         ↓
         tokens.validate("abc")
         ↓
         нашли Token { username: "admin", expiresAt: ... }
         ↓
         возвращаем Session { username: "admin", anonymous: false }
   ↓
   3e. share.visibleTo("admin", false)
       ↓
       share.anonymous == true → return true
   ↓
   3f. Путь физически: C:/JavaProject/FileServer/DATA/photo.jpg
   ↓
   3g. Files.isRegularFile → да
   ↓
   3h. staticHandler.serveFile(ex, file)
       ↓
       sendResponseHeaders(200, size)
       stream bytes

4. Ответ: 200 OK, тело — байты файла
```

### 12.1. Когда какой код

| Проверка | Не прошла → код |
|---|---|
| Не GET/HEAD | 405 |
| Есть `../` в пути | 403 |
| `hasRead() == false` | 403 |
| Не передан токен/пароль для приватного share | 401 |
| Токен невалиден | 401 |
| Токен истёк | 401 |
| Пользователь не в `users` share | 403 |
| Файл не найден | 404 |
| Превышена квота при записи | 507 |

---

## 13. Клиентская сторона

### 13.1. При подключении к FileServer

В `FAR.connectToDb` (`js/05-connection.js`):

```js
if (cfg.type === 'filesystem') {
    const baseUrl = ...;

    // 1. Логинимся
    let token = '';
    if (cfg.user) {
        const loginRes = await FAR.FsClient.login(baseUrl, cfg.user, cfg.pass);
        token = loginRes.token;
    }

    // 2. Создаём клиент с токеном
    const client = new FAR.FsClient(baseUrl, { token });
    const info = await client.info();
    return { db: client, info, fullUrl, type: 'filesystem', token };
}
```

### 13.2. Использование токена в FsClient

```js
FAR.FsClient.prototype._authHeader = function() {
    if (this.token) return 'Bearer ' + this.token;
    if (!this.user) return null;
    return 'Basic ' + btoa(this.user + ':' + (this.pass || ''));
};
```

Приоритет: **токен → Basic → ничего**.

### 13.3. EventSource и токен

`EventSource` в браузере **не поддерживает заголовки**. Поэтому токен для SSE передаётся через query:

```js
FAR.FsClient.prototype.startWatching = function() {
    let url = this.baseUrl + '/api/events';
    if (this.token) url += '?token=' + encodeURIComponent(this.token);
    const es = new EventSource(url);
    ...
};
```

### 13.4. Прямые URL из UI

Для открытия файла в новой вкладке / `<img>` / `<video>`:

```js
const url = client.directUrl('Documents', 'report.pdf');
// → http://host:8080/Documents/report.pdf?token=3Kf7x...
window.open(url);
```

Метод `directUrl` определён в `js/04a-fs-client.js`.

---

## 14. Безопасность

### 14.1. Что защищено

- **Пароли:** Basic Auth и `?user=&pass=` передают их в открытом виде (base64 — не шифрование). **Безопасно только поверх HTTPS.**
- **Токены:** случайные 24 байта (`SecureRandom`), устойчивы к подбору. Утечка токена = утечка доступа на 24 часа.
- **Path traversal:** все пути нормализуются через `FileService.normalize()` и проверяются `Path.startsWith(root)`. `../` внутри виртуального пути игнорируется.
- **Escape из share:** `VirtualResolver.resolve()` проверяет `physical.startsWith(share.physicalPath())`. Нельзя выйти за пределы физической папки share через относительный путь.
- **Заблокированные файлы:** статический сервер не отдаёт `.idea`, `.git`, `.gitignore`, `config.json` (даже если они лежат в `www/`).

### 14.2. Что НЕ защищено

- **Пароли в config.json хранятся в открытом виде.** Для продакшена нужно хранить хэши (PBKDF2, bcrypt) и сравнивать с хэшем.
- **Токены в памяти, без персистентности.** Перезапуск = выход всех пользователей.
- **Нет HTTPS по умолчанию.** `com.sun.net.httpserver` поддерживает HTTPS (`HttpsServer`), но его нужно явно настроить с сертификатом.
- **Нет rate-limiting.** Брутфорс пароля не ограничен. Нужно добавить счётчик неудачных попыток.
- **Нет CSRF-защиты.** Для SPA за reverse-proxy это обычно не проблема, но стоит иметь в виду.
- **Нет аудита.** Логируются только ошибки 500. Успешные входы и операции не пишутся в лог.

### 14.3. Рекомендации для продакшена

1. **HTTPS** через reverse-proxy (nginx + Let's Encrypt) или `HttpsServer`.
2. **Хэширование паролей** в config.json:
   ```json
   { "name": "admin", "passwordHash": "pbkdf2:..." }
   ```
3. **Persistent токены** в файл или БД, чтобы переживали перезапуск.
4. **Rate-limiting** на `/api/login` (например, 5 попыток / 15 мин).
5. **Логи** всех операций записи/удаления с указанием пользователя.
6. **Отдельная БД для токенов** вместо `ConcurrentHashMap` (например, Redis).

---

## Приложение A. Список endpoint-ов

| Endpoint | Метод | Auth | Назначение |
|---|---|---|---|
| `/api/login` | POST / GET | — | Получить токен |
| `/api/logout` | POST / GET | Токен | Отозвать токен |
| `/api/whoami` | GET | Любая | Кто я |
| `/api/info` | GET | Любая | Список shares |
| `/api/list` | GET | Нужна | Список файлов |
| `/api/stat` | GET | Нужна | Метаданные |
| `/api/read` | GET | Нужна | Скачать файл |
| `/api/write` | PUT / POST | `write` | Записать файл |
| `/api/mkdir` | POST | `write` | Создать папку |
| `/api/delete` | DELETE / POST | `delete` | Удалить |
| `/api/move` | POST | `delete` + `write` | Переместить |
| `/api/copy` | POST | `read` + `write` | Скопировать |
| `/api/public/<share>/<path>` | GET / HEAD | — | Публичный доступ |
| `/api/events` | GET | Токен | SSE-поток |
| `/<share>/<path>` | GET / HEAD | По share | Прямая ссылка на файл |
| `/index.html`, `/js/*`, … | GET / HEAD | — | Статика |

## Приложение B. Ключевые классы

| Класс | Ответственность |
|---|---|
| `FileServer` | Точка входа, регистрация контекстов, утилиты HTTP |
| `Config` | Разбор config.json, модель User/Share |
| `AuthService` | `authenticate()`, `canRead/canWrite/canDelete` |
| `TokenService` | Выдача/валидация токенов, TTL 24ч |
| `VirtualResolver` | Резолв пути + авторизация |
| `ApiHandler` | Обработка `/api/*` |
| `StaticHandler` | Отдача `www/*` |
| `RootHandler` | Диспетчер `/` (статика → share) |
| `SseHandler` | SSE-поток изменений ФС |
| `QuotaService` | Проверка лимитов записи |
| `FileService` | Операции с диском (sandbox по share) |
| `FileWatcher` | WatchService → SSE-события |