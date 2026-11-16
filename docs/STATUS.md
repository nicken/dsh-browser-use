# 现状快照（接手先读这个）

> 最后更新：2026-11-16 22:00（Asia/Shanghai）

## 一句话

browser-pods 已上线可用：一个 MCP 端点（16 个工具）负责开浏览器、驱动页面、关闭并归档录像；
容器在跑，历史会话 0 个，归档按 20 份滚动保留。

## 运行态

| 项 | 值 |
|---|---|
| 容器 | `browser-pods`（`docker compose up -d`，host 网络，healthy） |
| 控制面 / MCP | `http://127.0.0.1:8787/` · `http://127.0.0.1:8787/mcp` |
| 并发上限 | 6 个会话（`PODS_MAX`） |
| 空闲回收 | 60 分钟（`POD_IDLE_TTL_MIN`） |
| 归档保留 | 20 份（`ARTIFACTS_KEEP`），存在 `data/artifacts/` |
| DSH 接入 | `~/.dsh/profiles/web/cordis.patch.yml` 里的 `- id: mcp-browser` 条目（toolbox 可编辑） |

## 文件地图

| 想了解 / 想改 | 看这里 |
|---|---|
| 怎么用、怎么看、怎么接 | `README.md` |
| MCP 工具定义（16 个） | `src/mcp.mjs` |
| 会话生命周期、Xvfb/VNC/录制 | `src/pods.mjs` |
| HTTP / 看板 / 审计 / REST | `src/server.mjs` |
| 看板前端 | `src/dashboard.html` |
| 运维命令 | `scripts/browserctl.mjs`、`scripts/scale.sh` |
| 自检 | `scripts/smoke.mjs`、`scripts/interact-test.mjs` |
| 历史决策与取舍 | `README.md` 第十二节 + `git log` |
| 配置项全表 | `README.md` 第八节 |

## 恢复步骤（换机器 / 重启后）

```bash
cd browser-pods
docker compose up -d                 # 起服务（镜像本地已有则秒起）
curl -s http://127.0.0.1:8787/healthz
node scripts/smoke.mjs               # 自检：并发开 3 个浏览器并关闭
```

DSH 侧：确认 `cordis.patch.yml` 里 `mcp-browser` 指向 `http://127.0.0.1:8787/mcp`，
保存后工具以 `mcp__browser__*` 出现（16 个）。

## 已定型的决策（别再翻）

1. **一个 MCP**：供应 5 + 驱动 11 = 16 个工具；`MCP_DRIVER_TOOLS=0` 可退回纯供应。
2. **不做 chrome-devtools 常驻 MCP**：`--browserUrl` 固定，无法跟随槽位端口；需要性能分析时用 CLI 临时连 `cdp_url`。
3. **配置写在 profile 的 `cordis.patch.yml`**，不用 bundle——否则 toolbox 里只读、不能编辑。
4. **归档按数量保留**（20 份），没有时间维度过期。
5. **GPU 不做**：无可用 Vulkan ICD，ANGLE 一律回落 SwiftShader，对页面验证无收益。

## 待办（都没做，按需取）

- [ ] 归档按时间过期（`ARTIFACTS_MAX_AGE_DAYS`）
- [ ] 看板显示归档总量 / 最早一份时间
- [ ] 给仓库打 tag `v0.1.0`、加远端（GitLab/GitHub）
- [ ] 重截 `docs/` 里的三张截图（内容是早几轮界面，功能一致）
- [ ] 多实例看板聚合入口

## 已知限制

单机部署；无音频；无硬件 GPU；noVNC 无密码（默认仅本机可达）；trace 含页面 DOM 快照，注意敏感信息。
