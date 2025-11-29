#!/bin/bash

set -e  # 遇到错误立即退出

echo "========== 开始安装 xmrig-proxy =========="

# 更新源及安装必备工具
echo "[1/8] 更新系统并安装依赖..."
apt update -y
apt install -y curl socat wget screen sudo iptables ufw net-tools

# 创建目录并进入
echo "[2/8] 创建工作目录..."
mkdir -p ~/xmrig-proxy-deploy
cd ~/xmrig-proxy-deploy

# 下载并解压 xmrig-proxy
echo "[3/8] 下载 xmrig-proxy..."
wget -q --show-progress https://github.com/xmrig/xmrig-proxy/releases/download/v6.22.0/xmrig-proxy-6.22.0-linux-static-x64.tar.gz

echo "[4/8] 解压文件..."
tar -zxvf xmrig-proxy-6.22.0-linux-static-x64.tar.gz
cd xmrig-proxy-6.22.0

# 赋予执行权限
chmod +x xmrig-proxy

# 下载配置文件
echo "[5/8] 下载配置文件..."
rm -f config.json
wget -q https://raw.githubusercontent.com/zjaacmyx/xxx1/main/config.json

# 验证配置文件
echo "[6/8] 验证配置文件..."
if [ ! -f config.json ]; then
    echo "错误: 配置文件下载失败！"
    exit 1
fi

echo "配置文件内容:"
cat config.json

# 配置防火墙
echo "[7/8] 配置防火墙..."
sudo ufw --force reset
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp comment 'SSH'
sudo ufw allow 7777/tcp comment 'XMRig Proxy'
sudo ufw allow 8181/tcp comment 'XMRig Dashboard'
sudo ufw allow proto icmp comment 'Allow Ping'
sudo ufw --force enable

echo "防火墙状态:"
sudo ufw status verbose

# 提升文件句柄数限制
echo "[8/8] 启动 xmrig-proxy..."
ulimit -n 65535

# 先测试能否正常启动（前台运行3秒）
timeout 3s ./xmrig-proxy || true

# 后台启动
nohup ./xmrig-proxy > proxy.log 2>&1 &
PROXY_PID=$!

echo "xmrig-proxy 已启动，PID: $PROXY_PID"
echo "日志文件: $(pwd)/proxy.log"

# 等待2秒后检查进程
sleep 2

if ps -p $PROXY_PID > /dev/null; then
    echo "✓ xmrig-proxy 运行正常"
    echo "查看日志: tail -f $(pwd)/proxy.log"
    echo "查看进程: ps aux | grep xmrig-proxy"
else
    echo "✗ xmrig-proxy 启动失败，查看日志:"
    cat proxy.log
    exit 1
fi

echo "========== 安装完成 =========="
