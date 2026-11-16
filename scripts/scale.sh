#!/usr/bin/env bash
# 横向扩：一台机器上跑 N 个相互独立的 browser-pods 实例（各自端口段 + 数据目录）
#
#   ./scripts/scale.sh start 3     # 起 3 个实例（1..3）
#   ./scripts/scale.sh stop 3      # 停掉 1..3
#   ./scripts/scale.sh status      # 看状态
#
# 第 i 个实例：
#   HTTP/MCP  127.0.0.1:$((8786+i))
#   显示器    :$((100+i*20+1)) .. :$((100+i*20+6))
#   VNC       $((5900+i*20+1)) .. $((5900+i*20+6))
#   noVNC     $((6080+i*20+1)) .. $((6080+i*20+6))
#   CDP       $((9222+i*20+1)) .. $((9222+i*20+6))
#   数据      ./data/instance-i
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${IMAGE:-browser-pods:0.1.0}"
ACTION="${1:-status}"
N="${2:-2}"
USER_ID="${USER_ID:-$(id -u)}"
GROUP_ID="${GROUP_ID:-$(id -g)}"

calc() {
  local i="$1"
  HTTP_PORT=$((8786 + i))
  DISP=$((100 + i * 20))
  VNC=$((5900 + i * 20))
  VIEW=$((6080 + i * 20))
  CDP=$((9222 + i * 20))
}

start_one() {
  local i="$1"
  calc "$i"
  local name="browser-pods-i${i}"
  local data="$ROOT/data/instance-${i}"
  mkdir -p "$data"
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" \
    --network host --restart unless-stopped \
    --cpus 6 --memory 12g --shm-size 1g --pids-limit 1024 \
    --user "${USER_ID}:${GROUP_ID}" \
    -v "$data:/data" \
    -e INSTANCE_NAME="instance-${i}" \
    -e LISTEN_HOST=127.0.0.1 -e LISTEN_PORT="$HTTP_PORT" -e PUBLIC_HOST=127.0.0.1 \
    -e DISPLAY_BASE="$DISP" -e VNC_PORT_BASE="$VNC" -e VIEW_PORT_BASE="$VIEW" -e CDP_PORT_BASE="$CDP" \
    -e PODS_MAX="${PODS_MAX:-6}" -e POD_IDLE_TTL_MIN="${POD_IDLE_TTL_MIN:-30}" \
    -e TZ=Asia/Shanghai \
    "$IMAGE" >/dev/null
  printf '  instance-%s  控制面 http://127.0.0.1:%s/  · 显示器 :%s..  · noVNC %s..  · CDP %s..\n' \
    "$i" "$HTTP_PORT" "$((DISP + 1))" "$((VIEW + 1))" "$((CDP + 1))"
}

case "$ACTION" in
  start)
    if docker ps --filter 'name=^browser-pods$' --format '{{.Names}}' | grep -q browser-pods; then
      echo "⚠️  检测到 compose 单实例（browser-pods）正在占用 8787。" >&2
      echo "    多实例模式与它冲突，请先：docker compose down" >&2
      exit 1
    fi
    echo "启动 ${N} 个实例（镜像 ${IMAGE}）"
    for i in $(seq 1 "$N"); do start_one "$i"; done
    sleep 4
    echo
    for i in $(seq 1 "$N"); do
      calc "$i"
      printf '  %s 健康: %s\n' "instance-${i}" "$(curl -s -m 3 "http://127.0.0.1:${HTTP_PORT}/healthz" | tr -d '\n' || echo '未就绪')"
    done
    ;;
  stop)
    for i in $(seq 1 "$N"); do docker rm -f "browser-pods-i${i}" >/dev/null 2>&1 || true; done
    echo "已停止 ${N} 个实例"
    ;;
  status)
    docker ps --filter "name=browser-pods-i" --format '  {{.Names}}  {{.Status}}  {{.Ports}}'
    for i in $(seq 1 20); do
      calc "$i"
      if curl -s -m 2 "http://127.0.0.1:${HTTP_PORT}/healthz" >/dev/null 2>&1; then
        printf '  instance-%s  http://127.0.0.1:%s/  %s\n' "$i" "$HTTP_PORT" "$(curl -s "http://127.0.0.1:${HTTP_PORT}/healthz" | tr -d '\n')"
      fi
    done
    ;;
  *)
    echo "用法: $0 {start|stop|status} [实例数]" >&2
    exit 1
    ;;
esac
