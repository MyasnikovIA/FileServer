cat > uninstall-autostart.sh <<'SCRIPT_EOF'
#!/bin/bash
# =============================================================
# uninstall-autostart.sh
# Останавливает, отключает и удаляет systemd-сервис FileServer.
# Требует sudo.
# =============================================================
set -e

SERVICE_NAME="file-server"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

echo "Stopping ${SERVICE_NAME} ..."
sudo systemctl stop "${SERVICE_NAME}" 2>/dev/null || true

echo "Disabling ${SERVICE_NAME} ..."
sudo systemctl disable "${SERVICE_NAME}" 2>/dev/null || true

echo "Removing ${SERVICE_FILE} ..."
sudo rm -f "$SERVICE_FILE"

echo "Reloading systemd daemon ..."
sudo systemctl daemon-reload
sudo systemctl reset-failed "${SERVICE_NAME}" 2>/dev/null || true

echo ""
echo "Готово. Сервис удалён из автозапуска."
echo "Логи остаются в journalctl (journalctl --vacuum-time=1d — очистить)."
SCRIPT_EOF

chmod +x uninstall-autostart.sh