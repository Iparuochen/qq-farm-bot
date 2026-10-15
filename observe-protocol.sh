#!/bin/bash
# 协议升级观察期监控
# 用法: ./observe-protocol.sh [小时数，默认24]

HOURS="${1:-24}"
SINCE="${HOURS}h"

echo "=============================================="
echo " 协议升级观察报告"
echo " 协议版本: 1.14.2.15_20260922 (升级前 1.14.0.4_20260911)"
echo " 统计范围: 最近 ${HOURS} 小时"
echo " 生成时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "=============================================="
echo

echo "【账号在线状态】"
docker logs --since "$SINCE" qq-farm-bot 2>&1 \
  | grep -oE "登录成功: [^ ]+ \(Lv[0-9]+\)" | sort -u | sed 's/^/  ✅ /'
echo

echo "【掉线统计 ws_400】"
printf "  %-8s %s\n" "账号" "ws_400 次数"
for name in "H\." "C\." "。"; do
  n=$(docker logs --since "$SINCE" qq-farm-bot 2>&1 | grep "ws_400" | grep -c "accountName\":\"$name")
  printf "  %-8s %s 次\n" "$name" "$n"
done
echo
echo "  参考: 升级前 24 小时基线 — H. 10 次 / C. 4 次 / 。 4 次"
echo

echo "【其它断线原因】"
docker logs --since "$SINCE" qq-farm-bot 2>&1 \
  | grep -oE "原因=[a-z_]+[:.][^\"]{0,40}" | sed 's/^/  /' | head -10
[ -z "$(docker logs --since "$SINCE" qq-farm-bot 2>&1 | grep -oE "原因=[a-z_]+[:.]" | head -1)" ] \
  && echo "  （无）"
echo

echo "【自动重连情况】"
ok=$(docker logs --since "$SINCE" qq-farm-bot 2>&1 | grep -c "登录成功")
echo "  成功重连: ${ok} 次"
echo

echo "【业务健康度】"
farm=$(docker logs --since "$SINCE" qq-farm-bot 2>&1 | grep -c "农场循环")
friend=$(docker logs --since "$SINCE" qq-farm-bot 2>&1 | grep -c "好友巡查循环")
toast=$(docker logs --since "$SINCE" qq-farm-bot 2>&1 | grep -c "心跳硬超时")
echo "  农场循环: ${farm} 次 | 好友巡查: ${friend} 次 | 心跳超时: ${toast} 次"
echo

echo "=============================================="
echo " 升级前基线（2026-10-13 之前的 24 小时）:"
echo "   H. 10 次 / C. 4 次 / 。 4 次 ws_400"
echo " 若当前数据明显低于基线，说明协议升级有效"
echo "=============================================="