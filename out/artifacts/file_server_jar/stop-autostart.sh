#!/bin/bash
# =============================================================
# stop-autostart.sh
# Останавливает systemd-сервис FileServer (без удаления из автозапуска).
# Требует sudo.
#
# Использование:
#   ./stop-autostart.sh        — остановить и показать статус
#   ./stop-autostart.sh -q     — только остановка, без статуса
# =============================================================

SERVICE_NAME="file-server"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

QUIET=0
for arg in "$@"; do
    case "$arg" in
        -q|--quiet) QUIET=1 ;;
        -h|--help)
            echo "Usage: $0 [-q|--quiet]"
            exit 0
            ;;
        *)
            echo "Unknown option: $arg"
            echo "Usage: $0 [-q|--quiet]"
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

# --- Проверка: сервис вообще запущен? ---
if ! systemctl is-active --quiet "${SERVICE_NAME}"; then
    echo "INFO: ${SERVICE_NAME} уже остановлен."
    if [ "$QUIET" -eq 0 ]; then
        echo ""
        echo "=== Status ==="
        sudo systemctl status "${SERVICE_NAME}" --no-pager -l || true
    fi
    exit 0
fi

# --- Остановка ---
echo "Stopping ${SERVICE_NAME} ..."
sudo systemctl stop "${SERVICE_NAME}"

# Небольшая пауза, чтобы systemd успел зафиксировать состояние
sleep 1

# --- Проверка результата ---
if systemctl is-active --quiet "${SERVICE_NAME}"; then
    echo "ERROR: ${SERVICE_NAME} всё ещё активен. Смотрите логи:"
    echo "  journalctl -u ${SERVICE_NAME} -n 50 --no-pager"
    exit 1
fi

echo "OK: ${SERVICE_NAME} остановлен."

# --- Статус ---
if [ "$QUIET" -eq 0 ]; then
    echo ""
    echo "=== Status ==="
    sudo systemctl status "${SERVICE_NAME}" --no-pager -l || true
    echo ""
    echo "Готово."
    echo "  Запустить снова : sudo systemctl start ${SERVICE_NAME}"
    echo "  Перезапустить   : sudo systemctl restart ${SERVICE_NAME}"
    echo "  Логи            : journalctl -u ${SERVICE_NAME} -n 50 --no-pager"
    echo ""
    echo "Примечание: сервис остаётся в автозапуске (enable)."
    echo "После перезагрузки он снова стартует."
    echo "Чтобы убрать из автозапуска — используйте uninstall-autostart.sh."
fi
