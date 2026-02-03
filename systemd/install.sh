#!/bin/bash
set -e

# Install NanoClaw systemd service

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_PATH="$(which node)"
HOME_DIR="$HOME"
SERVICE_FILE="$PROJECT_ROOT/systemd/nanoclaw.service"
DEST="/etc/systemd/system/nanoclaw.service"

echo "Installing NanoClaw systemd service..."
echo "  Project root: $PROJECT_ROOT"
echo "  Node path: $NODE_PATH"

# Create logs directory
mkdir -p "$PROJECT_ROOT/logs"

# Generate service file with substituted paths
sed -e "s|{{PROJECT_ROOT}}|$PROJECT_ROOT|g" \
    -e "s|{{NODE_PATH}}|$NODE_PATH|g" \
    -e "s|{{HOME}}|$HOME_DIR|g" \
    "$SERVICE_FILE" | sudo tee "$DEST" > /dev/null

# Reload systemd and enable service
sudo systemctl daemon-reload
sudo systemctl enable nanoclaw

echo ""
echo "Service installed. Commands:"
echo "  sudo systemctl start nanoclaw   # Start service"
echo "  sudo systemctl stop nanoclaw    # Stop service"
echo "  sudo systemctl status nanoclaw  # Check status"
echo "  journalctl -u nanoclaw -f       # View logs"
