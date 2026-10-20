# Настройка HTTPS и SSL-сертификата для FileServer

Данная инструкция описывает процесс получения бесплатного SSL-сертификата от **Let's Encrypt** (которому доверяют все браузеры) и настройку FileServer для работы по защищенному протоколу HTTPS, а также запуск видеотрансляций через WSS (WebSocket Secure).

---

## 1. Установка необходимых программ

Для генерации и конвертации сертификатов потребуются `certbot` и `openssl`.

```bash
sudo apt update
sudo apt install certbot openssl
```

---

## 2. Получение сертификата Let's Encrypt (DNS Challenge)

Так как сервер работает на нестандартных портах (8080, 8081) и 80-й порт закрыт, мы используем **DNS Challenge** (проверку через DNS-записи).

1. Запустите Certbot в интерактивном режиме:
   ```bash
   sudo certbot certonly --manual --preferred-challenges dns -d smwrap.ru -d www.smwrap.ru
   ```

2. Certbot выдаст вам **два набора кодов** (по одному для каждого домена). Они выглядят как длинные строки из букв и цифр.
   **НЕ ЗАКРЫВАЙТЕ ТЕРМИНАЛ И НЕ НАЖИМАЙТЕ ENTER!**

3. Зайдите в панель управления вашим доменом (например, на сайте **Рег.ру** в разделе "DNS-серверы и управление зоной").
4. Создайте **две** новые записи типа **TXT**:
    *   **Запись 1:**
        *   **Subdomain (Имя):** `_acme-challenge`
        *   **Text (Значение):** вставьте первый код от Certbot (начинается с `R1dkw...`).
    *   **Запись 2:**
        *   **Subdomain (Имя):** `_acme-challenge.www`
        *   **Text (Значение):** вставьте второй код от Certbot (начинается с `-tx4O...`).
5. Нажмите «Готово» / «Сохранить» в панели Рег.ру.
6. **Подождите 2–5 минут** (DNS-серверам нужно время на обновление).
7. Вернитесь в терминал и нажмите **Enter**.
8. Если проверка пройдена успешно, Certbot создаст файлы сертификатов в папке `/etc/letsencrypt/live/smwrap.ru/`.

---

## 3. Упаковка сертификатов для Java

Java не умеет читать текстовые файлы `.pem` напрямую для SSL. Мы должны упаковать сертификат и приватный ключ в бинарный формат **PKCS12** (`.p12`).

1. Выполните команду (пути к `fullchain.pem` и `privkey.pem` берите из папки Let's Encrypt):
   ```bash
   sudo openssl pkcs12 -export \
     -in /etc/letsencrypt/live/smwrap.ru/fullchain.pem \
     -inkey /etc/letsencrypt/live/smwrap.ru/privkey.pem \
     -out /home/myasnikovia/JavaProject/FileServer_git/certs/keystore.p12 \
     -name server \
     -passout pass:changeit
   ```
   *(Здесь `changeit` — это пароль для файла. Вы можете придумать свой).*

2. Дайте права на чтение нового файла (если сервер запускается не от root):
   ```bash
   sudo chown myasnikovia:myasnikovia /home/myasnikovia/JavaProject/FileServer_git/certs/keystore.p12
   chmod 600 /home/myasnikovia/JavaProject/FileServer_git/certs/keystore.p12
   ```

---

## 4. Настройка `config.json`

Откройте ваш `config.json` и добавьте (или измените) блок `"https"`. Теперь сервер будет использовать упакованный файл `keystore.p12`:

```json
{
  "http": {
    "port": 8080,
    "host": "0.0.0.0"
  },

  "https": {
    "enabled": true,
    "keystore": "/home/myasnikovia/JavaProject/FileServer_git/certs/keystore.p12",
    "password": "changeit"
  },

  "videochat": {
    "enabled": true,
    "port": 8081,
    "wsGuid": "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
  }
  
  // ... остальные настройки ...
}
```

*(Параметр `password` должен совпадать с тем, который вы указали в команде `openssl` при создании `.p12`).*

---

## 5. Запуск сервера

1. Пересоберите проект, чтобы применились любые изменения в Java-коде:
   ```bash
   mvn clean package
   ```
2. Запустите сервер из папки с конфигом:
   ```bash
   sudo java -jar file-server.jar
   ```

**Успешный запуск выглядит так:**
```text
[FileServer] HTTPS mode enabled
[VideoChat] WSS mode enabled on port 8081
[FileServer] started
  listen   : https://0.0.0.0:8080
```
Теперь любой пользователь сможет зайти на `https://www.smwrap.ru:8080/` без ошибок безопасности.

---

## 6. Изменение порта сервера

Если вам понадобится изменить порт (например, на `9090` вместо `8080`), учтите три правила:

1. **Изменение в конфиге:**
   Откройте `config.json` и измените `"port": 8080` на новый (например, `"port": 9090`).
2. **Освобождение порта в ОС:**
   Убедитесь, что новый порт свободен. Проверить можно командой: `sudo lsof -i :9090`.
3. **Открытие порта в фаерволе:**
   Если сервер работает в облаке (или на VPS), не забудьте открыть новый порт в настройках брандмауэра (Security Groups / UFW / iptables).

*Сертификат SSL привязан к домену (`www.smwrap.ru`), а не к порту, поэтому после смены порта настройки HTTPS в `config.json` менять не нужно.*

---

## ⚠️ Важное примечание об обновлении сертификата

Сертификаты Let's Encrypt выдаются на **3 месяца**. Так как мы использовали ручной метод с DNS-записями, Certbot **не сможет обновить его автоматически**.

**За 1–2 недели до истечения срока:**
1. Снова запустите Certbot: `sudo certbot certonly --manual --preferred-challenges dns -d smwrap.ru -d www.smwrap.ru`
2. Certbot выдаст **новые** коды.
3. Замените значения в TXT-записях в Рег.ру на новые.
4. Подождите 5 минут и нажмите Enter в терминале.
5. Повторите **Шаг 3** (пересоберите `keystore.p12` с новыми файлами).
6. Перезапустите сервер.