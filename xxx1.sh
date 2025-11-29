#!/bin/bash

echo "========== 清理旧文件并重新安装 =========="

# 清理旧文件
cd ~
rm -rf xmrig-proxy-deploy

# 创建目录
mkdir -p xmrig-proxy-deploy
cd xmrig-proxy-deploy

echo "[1/6] 下载 xmrig-proxy..."
wget https://github.com/xmrig/xmrig-proxy/releases/download/v6.22.0/xmrig-proxy-6.22.0-linux-static-x64.tar.gz

echo "[2/6] 验证下载文件..."
ls -lh xmrig-proxy-6.22.0-linux-static-x64.tar.gz

echo "[3/6] 解压文件..."
tar -zxvf xmrig-proxy-6.22.0-linux-static-x64.tar.gz

echo "[4/6] 查看解压后的内容..."
ls -lha

# 查找实际的目录名
PROXY_DIR=$(find . -maxdepth 1 -type d -name "xmrig*" | head -n 1)
echo "找到目录: $PROXY_DIR"

if [ -z "$PROXY_DIR" ]; then
    echo "错误: 未找到 xmrig-proxy 目录"
    exit 1
fi

cd "$PROXY_DIR"
echo "当前目录: $(pwd)"
ls -lha

echo "[5/6] 设置执行权限..."
chmod +x xmrig-proxy

echo "[6/6] 创建配置文件..."
cat > config.json << 'EOF'
{
    "bind": [
        "0.0.0.0:7777"
    ],
    "pools": [
        {
            "url": "pool.supportxmr.com:3333",
            "user": "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A",
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

echo "配置文件内容:"
cat config.json

echo ""
echo "========== 准备启动 =========="
echo "当前工作目录: $(pwd)"

# 先测试能否运行
echo "测试运行 (3秒)..."
timeout 3s ./xmrig-proxy || true

sleep 1

# 后台启动
echo "后台启动..."
nohup ./xmrig-proxy > proxy.log 2>&1 &
PROXY_PID=$!

echo "PID: $PROXY_PID"
sleep 3

# 检查进程
if ps -p $PROXY_PID > /dev/null 2>&1; then
    echo ""
    echo "✓ xmrig-proxy 运行成功！"
    echo ""
    echo "工作目录: $(pwd)"
    echo "查看日志: tail -f $(pwd)/proxy.log"
    echo "查看进程: ps aux | grep $PROXY_PID"
    echo ""
    echo "前20行日志:"
    head -n 20 proxy.log 2>/dev/null || echo "日志文件尚未生成"
else
    echo ""
    echo "✗ 启动失败"
    if [ -f proxy.log ]; then
        echo "日志内容:"
        cat proxy.log
    else
        echo "无日志文件生成"
    fi
    exit 1
fi
