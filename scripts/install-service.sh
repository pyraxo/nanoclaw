#!/bin/bash
# Install NanoClaw systemd service (requires sudo)

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_TEMPLATE="$PROJECT_ROOT/systemd/nanoclaw.service"
SERVICE_FILE="/etc/systemd/system/nanoclaw.service"
NODE_PATH="$(which node)"
NODE_BIN_DIR="$(dirname "$NODE_PATH")"
CURRENT_USER="$(whoami)"

if [ ! -f "$SERVICE_TEMPLATE" ]; then
    echo "Error: Service template not found at $SERVICE_TEMPLATE"
    exit 1
fi

echo "Installing NanoClaw systemd service..."
echo "  Project root: $PROJECT_ROOT"
echo "  Node path: $NODE_PATH"
echo "  User: $CURRENT_USER"

# Process template and install
sudo bash -c "cat '$SERVICE_TEMPLATE' | \
    sed 's|{{PROJECT_ROOT}}|$PROJECT_ROOT|g' | \
    sed 's|{{NODE_PATH}}|$NODE_PATH|g' | \
    sed 's|{{NODE_BIN_DIR}}|$NODE_BIN_DIR|g' | \
    sed 's|{{HOME}}|$HOME|g' | \
    sed 's|{{USER}}|$CURRENT_USER|g' \
    > '$SERVICE_FILE'"

# Reload systemd and enable service
sudo systemctl daemon-reload
sudo systemctl enable nanoclaw

echo ""
echo "Service installed successfully!"
echo ""
echo "Commands:"
echo "  sudo systemctl start nanoclaw    # Start the service"
echo "  sudo systemctl stop nanoclaw     # Stop the service"
echo "  sudo systemctl restart nanoclaw  # Restart"
echo "  sudo systemctl status nanoclaw   # Check status"
echo "  journalctl -u nanoclaw -f        # Follow logs"
