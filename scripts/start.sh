#!/usr/bin/env bash
# 小鸡免费模型 —— Linux / macOS 启停脚本（对应 Windows 上的 小鸡开关.bat）
#
# 用法:
#   ./scripts/start.sh start      后台启动（日志由服务端自己写 logs/xiaoji.log）
#   ./scripts/start.sh stop       停止
#   ./scripts/start.sh restart    重启
#   ./scripts/start.sh status     查看状态（读 /healthz，不是只看进程在不在）
#   ./scripts/start.sh logs       跟随日志
#   ./scripts/start.sh open       打开仪表盘（xdg-open / open）
#
# 开机自启（可选）—— systemd 用户服务示例，存为 ~/.config/systemd/user/xiaoji.service：
#
#   [Unit]
#   Description=XiaoJi Free Model Gateway
#   After=network.target
#
#   [Service]
#   Type=simple
#   WorkingDirectory=%h/xiaoji-free-model-gateway
#   ExecStart=/usr/bin/node server.mjs
#   Restart=on-failure
#   RestartSec=5
#
#   [Install]
#   WantedBy=default.target
#
#   systemctl --user daemon-reload && systemctl --user enable --now xiaoji
#
# ⚠ 服务**默认只绑 127.0.0.1**。要放到局域网/公网，请先用环境变量 HOST=0.0.0.0 启动，
#   并把 config.json 的 auth 改成 token 模式（见 README 第七节）—— 别裸奔。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT/gateway.pid"
LOG_FILE="$ROOT/logs/xiaoji.log"

# 端口从 config.json 读，读不到就用默认 8787
PORT="$(node -e "try{process.stdout.write(String(require('$ROOT/config.json').port||8787))}catch{process.stdout.write('8787')}" 2>/dev/null || echo 8787)"
BASE="http://127.0.0.1:$PORT"

running() { curl -fsS --max-time 2 "$BASE/healthz" >/dev/null 2>&1; }

case "${1:-}" in
  start)
    if running; then echo "已在运行：$BASE"; exit 0; fi
    cd "$ROOT"
    # ⚠ 输出重定向到 /dev/null 而不是日志文件：日志由服务端自己持有（分级 + 按 1MB 滚动保留 5 份）。
    #   把 stdout 指到同一个文件会变成两个写入者，滚动时就乱了。
    nohup node server.mjs >/dev/null 2>&1 &
    echo $! > "$PID_FILE"
    for _ in $(seq 1 40); do sleep 0.25; if running; then break; fi; done
    if running; then echo "已启动：$BASE（PID $(cat "$PID_FILE")）"; else
      echo "启动失败，看日志：$LOG_FILE"; tail -n 20 "$LOG_FILE" 2>/dev/null || true; exit 1
    fi
    ;;
  stop)
    if [ -f "$PID_FILE" ]; then
      PID="$(cat "$PID_FILE")"
      if kill -0 "$PID" 2>/dev/null; then kill "$PID" && echo "已停止（PID $PID）"; else echo "PID $PID 已不存在"; fi
      rm -f "$PID_FILE"
    else
      # pid 文件可能被硬杀后残留丢失，退化成按进程名找
      if pkill -f "node .*server\.mjs" 2>/dev/null; then echo "已停止（按进程名）"; else echo "没找到在跑的网关"; fi
    fi
    ;;
  restart)
    "$0" stop || true
    sleep 1
    "$0" start
    ;;
  status)
    if running; then
      echo "运行中：$BASE"
      curl -fsS "$BASE/healthz" && echo
    else
      echo "未运行（$BASE 无响应）"
      exit 1
    fi
    ;;
  logs)
    touch "$LOG_FILE"; tail -f "$LOG_FILE"
    ;;
  open)
    if command -v xdg-open >/dev/null 2>&1; then xdg-open "$BASE"
    elif command -v open >/dev/null 2>&1; then open "$BASE"
    else echo "打开这个地址：$BASE"; fi
    ;;
  *)
    echo "用法: $0 {start|stop|restart|status|logs|open}"; exit 1
    ;;
esac
