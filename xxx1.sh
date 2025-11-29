#!/bin/bash

set -e  # 遇到错误立即退出

echo "========== 开始在 Debian 11 上安装 xmrig-proxy =========="

# 更新源及安装必备工具
echo "[1/8] 更新系统并安装依赖..."
apt update -y
apt install -y curl wget screen sudo iptables ufw net-tools

# 创建目录并进入
echo "[2/8] 创建工作目录..."
mkdir -p ~/xmrig-proxy-deploy
cd ~/xmrig-proxy-deploy

# 下载并解压 xmrig-proxy
echo "[3/8] 下载 xmrig-proxy v6.22.0..."
if [ -f xmrig-proxy-6.22.0-linux-static-x64.tar.gz ]; then
    echo "文件已存在，跳过下载"
else
    wget https://github.com/xmrig/xmrig-proxy/releases/download/v6.22.0/xmrig-proxy-6.22.0-linux-static-x64.tar.gz
fi

echo "[4/8] 解压文件..."
tar -zxvf xmrig-proxy-6.22.0-linux-static-x64.tar.gz
cd xmrig-proxy-6.22.0

# 赋予执行权限
chmod +x xmrig-proxy

# 检查二进制文件
echo "检查 xmrig-proxy 二进制文件..."
ls -lh xmrig-proxy
file xmrig-proxy

# 下载配置文件
echo "[5/8] 下载配置文件..."
rm -f config.json
if wget https://raw.githubusercontent.com/zjaacmyx/xxx1/main/config.json; then
    echo "✓ 配置文件下载成功"
else
    echo "✗ 配置文件下载失败，使用默认配置"
    cat > config.json << 'EOF'
{
    "listen": "0.0.0.0:7777",
    "pools": [
        {
            "url": "pool.supportxmr.com:3333",
            "user": "YOUR_WALLET_ADDRESS",
            "pass": "x",
            "keepalive": true
        }
    ],
    "api": {
        "port": 8181,
        "access-token": null,
        "worker-id": null
    },
    "verbose": true,
    "log-file": "proxy.log"
}
EOF
fi

# 验证配置文件
echo "[6/8] 验证配置文件..."
if [ ! -f config.json ]; then
    echo "错误: 配置文件不存在！"
    exit 1
fi

echo "配置文件内容:"
cat config.json
echo ""

# 配置防火墙
echo "[7/8] 配置防火墙..."
# 先检查 UFW 是否已安装
if command -v ufw &> /dev/null; then
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
else
    echo "UFW 未安装，跳过防火墙配置"
fi

# 提升文件句柄数限制
echo "[8/8] 配置系统参数并启动..."
ulimit -n 65535

# 测试程序是否能正常运行
echo "测试 xmrig-proxy 是否能正常启动..."
timeout 3s ./xmrig-proxy -c config.json || echo "初始测试完成"

sleep 1

# 后台启动
echo "后台启动 xmrig-proxy..."
nohup ./xmrig-proxy -c config.json > proxy.log 2>&1 &
PROXY_PID=$!

echo "xmrig-proxy 已启动，PID: $PROXY_PID"
echo "工作目录: $(pwd)"
echo "日志文件: $(pwd)/proxy.log"

# 等待3秒后检查进程
sleep 3

if ps -p $PROXY_PID > /dev/null 2>&1; then
    echo ""
    echo "========== ✓ 安装成功 =========="
    echo "进程状态: 运行中 (PID: $PROXY_PID)"
    echo ""
    echo "查看日志: tail -f $(pwd)/proxy.log"
    echo "查看进程: ps aux | grep xmrig-proxy | grep -v grep"
    echo "监听端口: netstat -tuln | grep -E ':(7777|8181)'"
    echo ""
    
    # 显示前几行日志
    echo "最新日志:"
    head -n 20 proxy.log
else
    echo ""
    echo "========== ✗ 启动失败 =========="
    echo "查看完整日志:"
    cat proxy.log
    exit 1
fi
