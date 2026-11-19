#!/bin/bash
# =============================================================
# restart-autostart.sh
# Перезапускает systemd-сервис FileServer.
# Требует sudo.
#
# Использование:
#   ./restart-autostart.sh        — перезапустить и показать статус
#   ./restart-autostart.sh -f     — перезапустить и следить за логами
#   ./restart-autostart.sh -q     — только перезапуск, без статуса
# =============================================================

SERVICE_NAME="file-server"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

FOLLOW=0
QUIET=0
for arg in "$@"; do
    case "$arg" in
        -f|--follow) FOLLOW=1 ;;
        -q|--quiet)  QUIET=1 ;;
        -h|--help)
            echo "Usage: $0 [-f|--follow] [-q|--quiet]"
            exit 0
            ;;
        *)
            echo "Unknown option: $arg"
            echo "Usage: $0 [-f|--follow] [-q|--quiet]"
            exit 1
            ;;
    esac
done

# --- Проверка: сервис установлен? ---
if [ ! -f "$SERVICE_FILE" ]; then
    echo "ERROR: service not installed: ${SERVICE_FILE}"
    echo "Сначала запустите install-autostart.sh"
    exit 1
fi

# --- Проверка: jar на месте? ---
APP_DIR="/var/JavaProject/FileServer_git"
JAR_FILE="file-server.jar"
if [ ! -f "${APP_DIR}/${JAR_FILE}" ]; then
    echo "WARNING: JAR not found: ${APP_DIR}/${JAR_FILE}"
    echo "Сервис будет перезапущен, но может не подняться."
fi

# --- Перезапуск ---
echo "Restarting ${SERVICE_NAME} ..."
sudo systemctl restart "${SERVICE_NAME}"

# Небольшая пауза, чтобы сервис успел инициализироваться
sleep 1

# --- Статус ---
if [ "$QUIET" -eq 0 ]; then
    echo ""
    echo "=== Status ==="
    sudo systemctl status "${SERVICE_NAME}" --no-pager -l || true
fi

# --- Логи ---
if [ "$FOLLOW" -eq 1 ]; then
    echo ""
    echo "=== Logs (Ctrl+C для выхода) ==="
    journalctl -u "${SERVICE_NAME}" -f -n 50
else
    echo ""
    echo "Готово."
    echo "  Логи (живьём)  : journalctl -u ${SERVICE_NAME} -f"
    echo "  Последние 50   : journalctl -u ${SERVICE_NAME} -n 50 --no-pager"
    echo "  Статус         : sudo systemctl status ${SERVICE_NAME}"
fi