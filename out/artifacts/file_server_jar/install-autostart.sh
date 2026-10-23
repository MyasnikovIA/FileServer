cat > install-autostart.sh <<'SCRIPT_EOF'
#!/bin/bash
# =============================================================
# install-autostart.sh
# Устанавливает FileServer как systemd system service.
# Требует sudo.
# =============================================================
set -e

SERVICE_NAME="file-server"
APP_DIR="/home/myasnikovia/JavaProject/FileServer_git/out/artifacts/file_server_jar"
JAR_FILE="file-server.jar"
SERVICE_USER="myasnikovia"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# --- Проверки ---
if [ ! -f "${APP_DIR}/${JAR_FILE}" ]; then
    echo "ERROR: JAR not found: ${APP_DIR}/${JAR_FILE}"
    exit 1
fi
if [ ! -f "${APP_DIR}/config.json" ]; then
    echo "WARNING: config.json not found in ${APP_DIR} — сервис может не запуститься."
fi

JAVA_BIN="$(command -v java || true)"
if [ -z "$JAVA_BIN" ]; then
    echo "ERROR: java not found in PATH. Установите JDK/JRE."
    exit 1
fi
echo "Using java: $JAVA_BIN"
"$JAVA_BIN" -version 2>&1 | head -1

# --- Создание unit-файла ---
echo "Writing ${SERVICE_FILE} ..."
sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=File Server (Java, ${SERVICE_NAME})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${JAVA_BIN} --enable-native-access=ALL-UNNAMED -jar ${APP_DIR}/${JAR_FILE}
Restart=on-failure
RestartSec=5
# Хорошо для pty4j: даём процессу свою cgroup, без блокировки TTY
StandardInput=null
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# --- Активация ---
echo "Reloading systemd daemon ..."
sudo systemctl daemon-reload

echo "Enabling ${SERVICE_NAME} (autostart at boot) ..."
sudo systemctl enable "${SERVICE_NAME}"

echo "Starting ${SERVICE_NAME} now ..."
sudo systemctl restart "${SERVICE_NAME}"

sleep 1
echo ""
echo "=== Status ==="
sudo systemctl status "${SERVICE_NAME}" --no-pager -l || true
echo ""
echo "Готово."
echo "  Проверить логи : journalctl -u ${SERVICE_NAME} -f"
echo "  Перезапустить  : sudo systemctl restart ${SERVICE_NAME}"
echo "  Остановить     : sudo systemctl stop ${SERVICE_NAME}"
SCRIPT_EOF

chmod +x install-autostart.sh