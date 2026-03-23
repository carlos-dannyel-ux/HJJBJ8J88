#!/bin/bash

# Configuration
VPS_IP="163.245.218.28"
VPS_USER="root"
REMOTE_DIR="/var/www/html/30win" # Targeted directory on VPS
SOURCE_DIR="$(pwd)"

echo "🚀 Iniciando deploy para $VPS_IP..."

# Verify if rsync is available
if ! command -v rsync &> /dev/null; then
    echo "❌ Erro: rsync não está instalado localmente."
    exit 1
fi

# Dry run first? (uncomment if you want to test)
# rsync -avzn --exclude 'node_modules' --exclude '.git' "$SOURCE_DIR/" "$VPS_USER@$VPS_IP:$REMOTE_DIR"

# Actual Sync (Excluding node_modules for speed, will install on VPS)
echo "📦 Enviando arquivos (excluindo node_modules)..."
sshpass -p 'Mayana19998' rsync -avz --exclude 'node_modules' --exclude '.git' --exclude 'vps_deploy.sh' \
    "$SOURCE_DIR/" "$VPS_USER@$VPS_IP:$REMOTE_DIR"

if [ $? -eq 0 ]; then
    echo "✅ Arquivos enviados com sucesso!"
    echo "⚙️  Configurando ambiente na VPS..."
    
    sshpass -p 'Mayana19998' ssh "$VPS_USER@$VPS_IP" "
        cd $REMOTE_DIR
        npm install
        # Garante que o banco de dados está configurado
        mysql -f < setup_db.sql || true
        # Garante que a porta 3000 está livre
        fuser -k 3000/tcp || true
        # Reinicia o servidor usando PM2
        pm2 restart server || pm2 start server.js --name server
        echo '🚀 Servidor reiniciado com PM2 na VPS!'
    "
else
    echo "❌ Erro ao enviar arquivos via rsync."
    exit 1
fi
