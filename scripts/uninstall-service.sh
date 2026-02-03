#!/bin/bash
# Uninstall NanoClaw systemd service

set -e

SERVICE_FILE="/etc/systemd/system/nanoclaw.service"

echo "Uninstalling NanoClaw systemd service..."

# Stop the service if running
if systemctl is-active --quiet nanoclaw 2>/dev/null; then
    echo "Stopping service..."
    sudo systemctl stop nanoclaw
fi

# Disable the service
if systemctl is-enabled --quiet nanoclaw 2>/dev/null; then
    echo "Disabling service..."
    sudo systemctl disable nanoclaw
fi

# Remove the service file
if [ -f "$SERVICE_FILE" ]; then
    echo "Removing service file..."
    sudo rm "$SERVICE_FILE"
fi

# Reload systemd
sudo systemctl daemon-reload

echo ""
echo "NanoClaw service uninstalled successfully."
