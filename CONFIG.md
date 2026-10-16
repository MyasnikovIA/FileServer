# `CONFIG.md` — Конфигурация FileServer (`config.json`)

Полное описание структуры файла `config.json`, всех его параметров и их влияния на работу сервера.

---

## Содержание

1. [Общая структура](#1-общая-структура)
2. [Секция `http` — параметры сервера](#2-секция-http--параметры-сервера)
3. [Секция `web` — каталог статики](#3-секция-web--каталог-статики)
4. [Секция `users` — пользователи](#4-секция-users--пользователи)
5. [Секция `shares` — общие ресурсы](#5-секция-shares--общие-ресурсы)
6. [Полные примеры](#6-полные-примеры)
7. [Комбинирование параметров](#7-комбинирование-параметров)
8. [Порядок загрузки и приоритеты](#8-порядок-загрузки-и-приоритеты)
9. [Типичные ошибки](#9-типичные-ошибки)
10. [Быстрые шаблоны](#10-быстрые-шаблоны)

---

## 1. Общая структура

`config.json` — JSON-документ с четырьмя возможными секциями верхнего уровня:

```json
{
  "http":   { ... },
  "web":    "www",
  "users":  [ ... ],
  "shares": [ ... ]
}
```

| Секция | Тип | Обязательна | Назначение |
|---|---|---|---|
| `http` | object | Нет | Порт, хост |
| `web` | string | Нет | Путь к каталогу статики |
| `users` | array | Да | Учётные записи |
| `shares` | array | Да | Виртуальные ресурсы |

Если `users` или `shares` пусты — сервер запустится, но работать будет не с чем.

**Расположение файла:** рядом с местом запуска сервера. Можно указать другой путь:

```
java ... FileServer --config C:/path/to/config.json
```

---

## 2. Секция `http` — параметры сервера

Определяет, где и как сервер слушает подключения.

```json
{
  "http": {
    "port": 8080,
    "host": "0.0.0.0"
  }
}
```

### Поля

| Поле | Тип | По умолчанию | Описание |
|---|---|---|---|
| `port` | number | `8080` | TCP-порт |
| `host` | string | `"0.0.0.0"` | Интерфейс прослушивания |

### Значения `host`

| Значение | Что означает |
|---|---|
| `"0.0.0.0"` | Слушать **все** сетевые интерфейсы (доступ из локальной сети) |
| `"127.0.0.1"` | Только localhost (только с той же машины) |
| `"192.168.1.10"` | Только указанный IP |
| `"localhost"` | Разрешается в loopback |

### Переопределение через CLI

Если параметр указан в CLI, он **перекрывает** значение из config:

```bash
java ... FileServer --port 9090 --host 127.0.0.1
```

### Проверка занятости порта

**Windows:**
```bat
netstat -ano | findstr :8080
```

**Linux/macOS:**
```bash
lsof -i :8080
ss -tlnp | grep 8080
```

Если порт занят — выберите другой (например, `8081`).

### Если секции `http` нет

Используются дефолты: `0.0.0.0:8080`. Это означает, что сервер доступен по локальной сети.

**Для локальной разработки** желательно ограничить:

```json
{ "http": { "port": 8080, "host": "127.0.0.1" } }
```

---

## 3. Секция `web` — каталог статики

Определяет каталог, из которого отдаётся статика (`index.html`, `js/`, `css/`, `modals/`, `lib/`).

```json
{
  "web": "www"
}
```

### Поля

| Поле | Тип | По умолчанию | Описание |
|---|---|---|---|
| `web` | string | `"www"` | Путь к каталогу статики |

### Относительный или абсолютный путь

| Значение | Что означает |
|---|---|
| `"www"` | Относительно рабочего каталога запуска (`user.dir`) |
| `"./web"` | То же |
| `"C:/JavaProject/FileServer/www"` | Абсолютный путь |
| `"/var/www/filebd"` | Абсолютный путь (Linux) |

### Что попадает в статику

Сервер отдаёт любой файл из этого каталога, **кроме**:

- `.idea/`
- `.git/`
- `.gitignore`
- `config.json`

**Даже если** эти файлы лежат внутри `www/`, они не будут отданы клиенту.

### Переопределение через CLI

```bash
java ... FileServer --web D:/sites/filebd
```

### Что должно быть в `www/`

Минимально:

```
www/
├── index.html
├── css/
│   ├── base.css
│   ├── panels.css
│   ├── ...
├── js/
│   ├── 01-config.js
│   ├── 02-state.js
│   ├── ...
├── modals/
│   ├── connection.html
│   ├── viewer.html
│   ├── ...
└── lib/
    ├── Pannellum2_5_6/
    ├── js-dos/
    ├── js-nes/
    ├── js-emulator/
    └── PDFObject/
```

### Если каталог не найден

Сервер **всё равно запустится**, но:

```
[FileServer] WARNING: web directory not found: C:\JavaProject\FileServer\www
[FileServer] Static files will return 404. Create the directory or fix 'web' in config.json.
```

Все запросы к `/`, `/index.html`, `/js/*` → 404. При этом `/api/*` и `/<share>/<path>` работают.

### Проверка

```bash
# Должен вернуться index.html
curl http://127.0.0.1:8080/

# Проверка блокировки config.json
curl -I http://127.0.0.1:8080/config.json
# HTTP/1.1 403 Forbidden

# Проверка блокировки .idea
curl -I http://127.0.0.1:8080/.idea/workspace.xml
# HTTP/1.1 403 Forbidden
```

---

## 4. Секция `users` — пользователи

Массив объектов-пользователей.

```json
{
  "users": [
    { "name": "admin", "password": "admin123", "quota": -1 },
    { "name": "olga",  "password": "olga2024", "quota": 500 },
    { "name": "guest", "password": "",         "quota": 100 }
  ]
}
```

### Поля пользователя

| Поле | Тип | По умолчанию | Описание |
|---|---|---|---|
| `name` | string | — | Логин. **Обязателен**, уникален |
| `password` | string | `""` | Пароль в открытом виде |
| `quota` | number | `-1` | Общая квота пользователя (МБ). `-1` — без лимита |

### Правила

1. **Уникальность:** логин должен быть уникальным. Если два пользователя имеют одно имя — второй перезапишет первого в `Map<String, User>`.
2. **Пустое имя:** пользователи с `name = ""` **игнорируются**.
3. **Пустой пароль:** пользователь входит только по логину, без пароля.
4. **Пробелы:** `name` тримится. `password` сохраняется как есть (регистрозависимо).

### Квоты

| Значение | Что означает |
|---|---|
| `-1` | Без лимита |
| `0` | Запись запрещена полностью |
| `> 0` | Лимит в мегабайтах |

Квота пользователя — **сумма по всем shares**, к которым у него есть доступ.

### Примеры

**Полный набор:**

```json
{ "users": [
    { "name": "admin", "password": "S3cr3t!", "quota": -1 },
    { "name": "olga",  "password": "olga2024", "quota": 500 },
    { "name": "guest", "password": "",         "quota": 100 }
] }
```

**Только один пользователь:**

```json
{ "users": [
    { "name": "admin", "password": "admin", "quota": -1 }
] }
```

**Пользователь без пароля (для теста):**

```json
{ "users": [
    { "name": "public", "password": "", "quota": 50 }
] }
```

**Пустой список:** работать никто не сможет. Анонимный доступ к `anonymous: true` shares — по-прежнему возможен.

### Что НЕ делать

❌ **Пробелы в имени:**
```json
{ "name": " admin " }   // станет "admin", но лучше сразу писать чисто
```

❌ **Хэширование пароля вручную:**
```json
{ "password": "5f4dcc3b5aa765d61d8327deb882cf99" }  // это md5("password")
// Сервер не умеет их проверять — пароль будет считаться именно этой строкой
```

❌ **Дубликаты:**
```json
{ "users": [
    { "name": "admin", "password": "a" },
    { "name": "admin", "password": "b" }   // ← второй ИГНОРИРУЕТСЯ
] }
```

---

## 5. Секция `shares` — общие ресурсы

Каждый share — виртуальный «ресурс», который видят пользователи. Физический путь задаётся отдельно, пользователь его не видит.

```json
{
  "shares": [
    {
      "name": "Documents",
      "physical": "C:/data/docs",
      "type": "folder",
      "access": ["read", "write", "delete"],
      "anonymous": false,
      "users": ["admin", "olga"],
      "quota": 200
    }
  ]
}
```

### Поля share

| Поле | Тип | По умолчанию | Описание |
|---|---|---|---|
| `name` | string | — | Виртуальное имя (видно клиенту) |
| `physical` | string | — | Физический путь на диске |
| `type` | string | `"folder"` | `folder` или `file` |
| `access` | array | `["read"]` | `read`, `write`, `delete` |
| `anonymous` | boolean | `false` | Доступ без пароля |
| `users` | array | `[]` | Список логинов, которым виден share |
| `quota` | number | `-1` | Лимит записи в этот share (МБ) |

### 5.1. `name` — виртуальное имя

Это то, что видит пользователь. Правила:

- **Не может содержать `/`** — иначе сломает парсинг виртуального пути.
- Должно быть **уникальным** среди shares.
- Регистрозависимо.

**Примеры:**

| `name` | Что увидит клиент |
|---|---|
| `Documents` | Папка `Documents` в корне |
| `Фото` | Папка «Фото» в корне (кириллица разрешена) |
| `logo.png` | Файл `logo.png` в корне |
| `root` | Папка `root` в корне |

**Плохие имена:**

| `name` | Проблема |
|---|---|
| `Docs/2024` | Слэш — сломает парсинг |
| `` (пусто) | Share игнорируется |
| `..` | Может конфликтовать с нормализацией |

### 5.2. `physical` — физический путь

Путь на диске, где реально лежат файлы.

**Windows:**

```json
{ "physical": "C:/data/docs" }         // прямые слэши
{ "physical": "C:\\data\\docs" }       // экранированные обратные
{ "physical": "D:/Projects/2024" }
```

**Linux/macOS:**

```json
{ "physical": "/home/user/data" }
{ "physical": "/mnt/storage/photos" }
```

**Особенности:**

- Путь **нормализуется** (`toAbsolutePath().normalize()`). Относительные пути разрешаются от `user.dir` (рабочий каталог Java-процесса).
- Если папки не существует — сервер не упадёт, но операции над этим share вернут 404.
- Проверка `startsWith(shareRoot)` защищает от выхода за пределы share через `../`.

**Рекомендуется использовать абсолютные пути.** Иначе при смене рабочего каталога поведение изменится.

### 5.3. `type` — тип ресурса

| Значение | Что означает |
|---|---|
| `folder` | Папка. Есть содержимое, поддерживает `list`, вложенные файлы и папки |
| `file` | Один файл. Прямой URL отдаёт именно его |

**Пример `folder`:**

```json
{
  "name": "Documents",
  "physical": "C:/data/docs",
  "type": "folder"
}
```

Клиент увидит папку `Documents`, внутри — файлы `C:/data/docs/*`.

**Пример `file`:**

```json
{
  "name": "logo.png",
  "physical": "D:/Public/logo.png",
  "type": "file"
}
```

Клиент увидит файл `logo.png` в корне. Его URL:

```
http://host:8080/logo.png
```

**Попытка обратиться к `logo.png/sub`** → 404 (у файлового share нет детей).

### 5.4. `access` — права

Массив из строк. Возможные значения:

| Значение | Что разрешает |
|---|---|
| `"read"` | Просмотр списка, чтение, скачивание |
| `"write"` | Создание файлов, папок, запись |
| `"delete"` | Удаление, перемещение из share |

**Порядок неважен.** Дубликаты игнорируются.

**Примеры:**

```json
{ "access": ["read"] }
{ "access": ["read", "write"] }
{ "access": ["read", "write", "delete"] }
{ "access": ["write"] }                    // странно: можно писать, но нельзя читать
```

**Если `access` пуст или отсутствует** → по умолчанию `["read"]`.

**Матрица комбинаций:**

| access | Что можно |
|---|---|
| `[]` | Только чтение (дефолт) |
| `["read"]` | Чтение, скачивание |
| `["read", "write"]` | + создание, загрузка |
| `["read", "write", "delete"]` | Полный доступ |
| `["write"]` | Можно писать, но нельзя прочитать. **Бессмысленно**, но технически допустимо |
| `["delete"]` | Только удаление. **Бессмысленно** |

### 5.5. `anonymous` — доступ без пароля

| Значение | Что означает |
|---|---|
| `false` | Доступ только для явно указанных пользователей |
| `true` | Доступ **всем** (включая анонимов) с правами `access` |

**Если `anonymous: true`:**

- `users` **игнорируется**.
- Любой может обратиться к share без логина/пароля.
- Работает через `/api/public/<share>/<path>` и через прямой `/<share>/<path>`.

**Пример публичного share:**

```json
{
  "name": "Public",
  "physical": "D:/Public",
  "type": "folder",
  "access": ["read"],
  "anonymous": true
}
```

**Проверка:**

```bash
# Без авторизации:
curl http://127.0.0.1:8080/Public/logo.png
# 200 OK
```

**Безопасность:** если `anonymous: true` и `access` включает `write`/`delete` — **любой** может писать и удалять. Не делайте так, если это не осознанное решение.

### 5.6. `users` — кому виден share

Используется, когда `anonymous: false`.

```json
{
  "anonymous": false,
  "users": ["admin", "olga"]
}
```

**Правила:**

- Пустой список + `anonymous: false` → **никто не видит**.
- Если указан `"admin"`, а такого пользователя нет в `users[]` (верхнеуровневом) → share «повиснет», никто не увидит.
- Пользователь видит share, только если его логин **точно** совпадает с одним из элементов.

**Матрица видимости:**

| anonymous | users | Кто видит |
|---|---|---|
| `true` | `[]` | Все (анонимы + авторизованные) |
| `true` | `["admin"]` | Все (поле users игнорируется) |
| `false` | `[]` | Никто |
| `false` | `["admin"]` | Только admin |
| `false` | `["admin", "olga"]` | admin и olga |

### 5.7. `quota` — лимит записи

| Значение | Что означает |
|---|---|
| `-1` | Без лимита |
| `0` | Запись запрещена (даже если в `access` есть `write`) |
| `> 0` | Лимит в МБ |

**Как считается:**

```
size(все файлы внутри share) + delta <= quota * 1024 * 1024
```

Где `delta` — разница между новым и старым размером файла. Обновление без изменения размера (`delta <= 0`) не блокируется.

**Пример:**

```json
{ "quota": 200 }
```

- Share может содержать до 200 МБ.
- Попытка записать ещё 1 МБ при занятых 200 МБ → HTTP 507.

**Кэш:** занятое место кэшируется на 5 секунд. Сразу после записи кэш инвалидируется.

**Квота share и квота пользователя работают независимо.** Обе проверяются перед каждой записью:

```json
{
  "users": [
    { "name": "olga", "quota": 500 }     // общая на все shares
  ],
  "shares": [
    { "name": "Documents", "quota": 200 }  // на конкретный share
  ]
}
```

- olga может писать в `Documents` до **200 МБ** (лимит share).
- olga может писать **в сумме по всем shares** до **500 МБ** (лимит пользователя).

Что сработает раньше — то и заблокирует.

---

## 6. Полные примеры

### 6.1. Минимум для запуска

```json
{
  "users": [
    { "name": "admin", "password": "admin" }
  ],
  "shares": [
    { "name": "root", "physical": "C:/FileBD" }
  ]
}
```

**Что получится:**

- Сервер на `0.0.0.0:8080`.
- Статика ищется в `./www`.
- Один пользователь `admin` / `admin`, без лимитов.
- Один share `root` → `C:/FileBD`, доступен только admin, с правами `["read"]` (дефолт).

### 6.2. Несколько пользователей с разными правами

```json
{
  "http": { "port": 8080, "host": "0.0.0.0" },
  "web": "www",

  "users": [
    { "name": "admin", "password": "admin123", "quota": -1 },
    { "name": "olga",  "password": "olga2024", "quota": 500 },
    { "name": "guest", "password": "",         "quota": 100 }
  ],

  "shares": [
    {
      "name": "Documents",
      "physical": "C:/data/docs",
      "type": "folder",
      "access": ["read", "write", "delete"],
      "anonymous": false,
      "users": ["admin", "olga"],
      "quota": 200
    },
    {
      "name": "Public",
      "physical": "D:/Public",
      "type": "folder",
      "access": ["read"],
      "anonymous": true,
      "users": []
    },
    {
      "name": "Incoming",
      "physical": "D:/Uploads",
      "type": "folder",
      "access": ["read", "write"],
      "anonymous": false,
      "users": ["guest", "olga"],
      "quota": 50
    }
  ]
}
```

**Что происходит:**

- `admin` — видит все три shares, может всё.
- `olga` — видит все три shares, но в `Incoming` только читает и пишет, без удаления.
- `guest` — видит только `Public` (read) и `Incoming` (read+write, до 50 МБ).
- Анонимный — видит только `Public`.

### 6.3. Только анонимный доступ

```json
{
  "users": [],
  "shares": [
    {
      "name": "Media",
      "physical": "E:/Media",
      "type": "folder",
      "access": ["read"],
      "anonymous": true
    }
  ]
}
```

Кто угодно может читать `E:/Media` через:

```
http://host:8080/Media/...
http://host:8080/api/public/Media/...
```

Писать никто не может (нет `write`).

### 6.4. Файл-синглтон

```json
{
  "users": [{ "name": "admin", "password": "admin" }],
  "shares": [
    {
      "name": "readme.txt",
      "physical": "C:/Docs/readme.txt",
      "type": "file",
      "access": ["read"],
      "anonymous": true
    }
  ]
}
```

Прямой URL: `http://host:8080/readme.txt` — отдаётся файл.

---

## 7. Комбинирование параметров

### 7.1. `anonymous: true` + `access: ["read","write"]`

**Технически возможно, но опасно:** любой аноним может писать в share.

```json
{
  "name": "Upload",
  "physical": "D:/Uploads",
  "access": ["read", "write"],
  "anonymous": true
}
```

Применение: публичная «приёмная» для файлов. Обычно так делают с `quota`, чтобы ограничить объём:

```json
{
  "name": "Upload",
  "physical": "D:/Uploads",
  "access": ["read", "write"],
  "anonymous": true,
  "quota": 50
}
```

### 7.2. Квота пользователя меньше квоты share

```json
{
  "users": [{ "name": "olga", "quota": 100 }],
  "shares": [
    { "name": "Big", "quota": 5000, "users": ["olga"] }
  ]
}
```

olga может записать в `Big` максимум 100 МБ, хотя сам share позволяет 5 ГБ.

### 7.3. Квота share меньше квоты пользователя

```json
{
  "users": [{ "name": "olga", "quota": 1000 }],
  "shares": [
    { "name": "Small", "quota": 10, "users": ["olga"] }
  ]
}
```

olga может записать в `Small` максимум 10 МБ. При этом у неё «остаётся» 990 МБ свободной квоты — она может писать в другие shares (если есть).

### 7.4. Пользователь видит share, но не имеет прав

```json
{
  "shares": [
    {
      "name": "Secret",
      "access": ["read"],
      "anonymous": false,
      "users": ["olga"]
    }
  ]
}
```

Если olga попробует писать в `Secret` — 403, потому что `write` нет в `access`.

---

## 8. Порядок загрузки и приоритеты

### 8.1. Последовательность

```
1. Ищем config.json (или --config <path>).
2. Парсим JSON через org.json.
3. Применяем http.port, http.host.
4. Применяем web (если указан).
5. Загружаем users (только с непустым name).
6. Загружаем shares (только с name и physical).
7. Переопределяем port/host/web из CLI, если заданы.
8. Запускаем HttpServer.
```

### 8.2. Приоритеты

| Источник | Приоритет |
|---|---|
| CLI (`--port`, `--host`, `--web`, `--config`) | Высший |
| `config.json` (`http.port`, `http.host`, `web`) | Средний |
| Дефолты в коде (`8080`, `0.0.0.0`, `www`, `config.json`) | Низший |

**Пример:**

`config.json`:
```json
{ "http": { "port": 8080 }, "web": "www" }
```

CLI:
```bash
java ... FileServer --port 9090
```

**Результат:** сервер на `9090`, статика из `www`.

### 8.3. Что игнорируется

- Пользователи с пустым `name`.
- Shares с пустым `name` или `physical`.
- Незнакомые поля (например, `"comment": "..."`) — не вызывают ошибок.
- Значения `access`, кроме `read`, `write`, `delete` — игнорируются.

### 8.4. Что вызывает ошибку

**Файл не найден:**

```
java.io.IOException: Config file not found: config.json
```

**Битый JSON:**

```
org.json.JSONException: Expected a ',' or '}' at ...
```

**Сервер не запускается.**

---

## 9. Типичные ошибки

### 9.1. Пользователь не видит share

**Причина:** логин не совпадает с элементом `users` (регистрозависимо).

**Решение:** проверьте, что в `users` share точно тот же логин, что в `users[]` верхнего уровня.

### 9.2. Загрузка не проходит из-за квоты

**Причина:** превышен лимит `quota` share или пользователя.

**Решение:** увеличьте `quota` или удалите старые файлы.

Проверить текущее использование:

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/api/info
```

### 9.3. Файлы в share не видны

**Причина:** неверный `physical` путь.

**Решение:**

```bash
# Windows
dir C:\data\docs

# Linux
ls /home/user/data
```

Если папки нет — сервер не упадёт, но операции над этим share вернут 404.

### 9.4. Anonymous share не работает

**Причина:** `access` не содержит `read`.

**Решение:** добавьте `"read"` в `access`:

```json
{ "access": ["read"], "anonymous": true }
```

### 9.5. Кириллица в путях

**Windows:** используйте прямые слэши и/или кодируйте:

```json
{ "physical": "C:/Документы/2024" }
```

**Linux:** UTF-8 должен быть локалью:

```bash
export LANG=en_US.UTF-8
```

При запуске Java добавьте `-Dfile.encoding=UTF-8`.

### 9.6. Порт занят

**Симптом:**

```
java.net.BindException: Address already in use
```

**Решение:** смените порт.

```bash
java ... FileServer --port 8081
```

### 9.7. Слишком длинный список shares

**Нет ограничения** на количество users/shares, но:

- Загрузка конфига линейна по размеру.
- С `N` shares каждая операция `list` корня обходит все `N` — при `N > 10000` может стать медленно.

Для большого числа shares разумно группировать их в подпапки внутри одного share.

---

## 10. Быстрые шаблоны

### 10.1. Локальная разработка

```json
{
  "http": { "port": 8080, "host": "127.0.0.1" },
  "web": "www",
  "users": [
    { "name": "admin", "password": "admin", "quota": -1 }
  ],
  "shares": [
    {
      "name": "test",
      "physical": "./DATA",
      "type": "folder",
      "access": ["read", "write", "delete"],
      "anonymous": true
    }
  ]
}
```

### 10.2. Продакшн с одним сервисным пользователем

```json
{
  "http": { "port": 8080, "host": "0.0.0.0" },
  "web": "/opt/filebd/www",
  "users": [
    { "name": "service", "password": "StrongPass!2024", "quota": 5000 }
  ],
  "shares": [
    {
      "name": "data",
      "physical": "/var/filebd/data",
      "type": "folder",
      "access": ["read", "write", "delete"],
      "users": ["service"]
    }
  ]
}
```

### 10.3. Публичный медиа-сервер

```json
{
  "http": { "port": 80, "host": "0.0.0.0" },
  "web": "www",
  "users": [
    { "name": "admin", "password": "admin123", "quota": -1 }
  ],
  "shares": [
    {
      "name": "media",
      "physical": "/mnt/media",
      "type": "folder",
      "access": ["read"],
      "anonymous": true
    },
    {
      "name": "private",
      "physical": "/mnt/private",
      "type": "folder",
      "access": ["read", "write"],
      "users": ["admin"]
    }
  ]
}
```

### 10.4. Несколько дисков, разные права

```json
{
  "users": [
    { "name": "admin", "password": "a", "quota": -1 },
    { "name": "user1", "password": "u1", "quota": 500 },
    { "name": "user2", "password": "u2", "quota": 1000 }
  ],
  "shares": [
    { "name": "Docs",     "physical": "C:/Docs",     "access": ["read","write","delete"], "users": ["admin","user1"] },
    { "name": "Photos",   "physical": "D:/Photos",   "access": ["read","write"],          "users": ["admin","user1","user2"] },
    { "name": "Archive",  "physical": "E:/Archive",  "access": ["read"],                  "users": ["admin"] },
    { "name": "Public",   "physical": "F:/Public",   "access": ["read"],     "anonymous": true }
  ]
}
```

---

## Приложение A. Справочник всех полей

### `http` (object)

| Поле | Тип | Дефолт | Прим. |
|---|---|---|---|
| `port` | number | `8080` | 1–65535 |
| `host` | string | `"0.0.0.0"` | IP или hostname |

### `web` (string)

| Тип | Дефолт |
|---|---|
| string | `"www"` |

### `users[]` (array of object)

| Поле | Тип | Обязательно | Дефолт | Прим. |
|---|---|---|---|---|
| `name` | string | да | — | уникально, непусто |
| `password` | string | нет | `""` | открытый текст |
| `quota` | number | нет | `-1` | МБ, `-1` = ∞ |

### `shares[]` (array of object)

| Поле | Тип | Обязательно | Дефолт | Прим. |
|---|---|---|---|---|
| `name` | string | да | — | уникально, без `/` |
| `physical` | string | да | — | абсолютный путь |
| `type` | string | нет | `"folder"` | `folder` / `file` |
| `access` | array | нет | `["read"]` | из `read`/`write`/`delete` |
| `anonymous` | boolean | нет | `false` | |
| `users` | array | нет | `[]` | логины |
| `quota` | number | нет | `-1` | МБ, `-1` = ∞ |

---

## Приложение B. Шпаргалка по `access` и `anonymous`

| Настройка | Кто видит | Что можно |
|---|---|---|
| `access:["read"]`, `anonymous:true` | Все | Только читать |
| `access:["read","write"]`, `anonymous:true` | Все | Читать и писать |
| `access:["read","write","delete"]`, `anonymous:true` | Все | Всё (опасно!) |
| `access:["read"]`, `anonymous:false`, `users:["a"]` | Только `a` | Только читать |
| `access:["read","write"]`, `anonymous:false`, `users:["a","b"]` | `a` и `b` | Читать и писать |
| `access:["read"]`, `anonymous:false`, `users:[]` | **Никто** | — |

---

## Приложение C. Валидация конфига вручную

Проверьте:

1. **JSON валиден:**
   ```bash
   # Linux/macOS
   python3 -m json.tool config.json

   # Windows PowerShell
   Get-Content config.json | ConvertFrom-Json
   ```

2. **Все физические пути существуют:**
   ```bash
   # Windows
   for /f %p in ('type config.json ^| findstr physical') do @echo %p
   ```

3. **Имена shares уникальны:** открыть глазами.

4. **Логины в `shares[].users` совпадают с `users[].name`:** открыть глазами.

5. **Права `access` не содержат опечаток:** только `read`, `write`, `delete`.

6. **Порт не занят:**
   ```bash
   netstat -ano | findstr :8080   # Windows
   lsof -i :8080                  # Linux
   ```

---

## Приложение D. Связанные файлы

| Файл | Ответственность |
|---|---|
| `config.json` | Сам конфиг |
| `Config.java` | Парсер и модель |
| `AuthService.java` | Использование `users` и `shares` |
| `QuotaService.java` | Использование `quota` |
| `StaticHandler.java` | Использование `web` |
| `RootHandler.java` | Диспетчер по `shares` |
| `FileServer.java` | Применение `http.port`, `http.host` |

---

## Заключение

`config.json` — единственный источник конфигурации FileServer. Все параметры можно переопределить через CLI (`--port`, `--host`, `--web`, `--config`). Структура минималистична: одна секция параметров сервера, одна секция статики, два массива (пользователи и shares).

Ключевые принципы:

- **Пользователь** идентифицируется логином.
- **Share** — виртуальный ресурс, скрывающий физический путь.
- **Права** — плоские, применяются ко всему поддереву share.
- **Квоты** — на запись, раздельные для share и пользователя.
- **Anonymous** — открывает share для всех без авторизации.

При изменении конфига **нужен перезапуск сервера** — горячей перезагрузки нет.