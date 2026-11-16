# 事故响应（INCIDENT RESPONSE）

> 原则：**先止损、再定位、后复盘**。任何"内容可能被篡改"的怀疑，默认按最坏情况处理。

## 0. 触发条件

- 线上页面出现你没批准的内容 / 同学反馈安排不对；
- GitHub 提示异常登录、陌生设备、陌生 SSH key、陌生 token；
- CI 出现"签名校验失败"而你并未改数据；
- 私钥可能泄露（电脑丢失、备份外泄、误发文件）。

## 1. 五分钟内（止损）

1. **停止发布**：Settings → Branches，把 `main` 设为 **Lock branch**（或临时取消所有合并）；
2. **保留证据**：不要删除 Actions 日志、PR、Issue；截图线上页面与时间；
3. **确认官方内容**：本地跑 `node tools/release.mjs verify`，对比 `release/log.jsonl` 最后一条与线上 `index.html` 的哈希；
4. **改密码**：GitHub 密码 + 2FA 恢复码检查；撤销所有陌生 Session / SSH key / PAT。

## 2. 一小时内（隔离）

- **私钥疑似泄露**：
  1. `node tools/release.mjs roster-revoke --id admin --key <备份根钥>`（或换新钥重做 roster）；
  2. 用新钥重签最新数据（release +1）；
  3. 公告新指纹；旧指纹作废。
- **GitHub 账号被控**：联系 GitHub Support 冻结；检查 force-push/分支保护是否被改；从备份恢复仓库设置。
- **线上被改但仓库干净**：说明是 DNS/托管/缓存层问题 → 检查 Pages 自定义域名 TXT、CNAME、证书；必要时先下线自定义域名。

## 3. 一天内（恢复与验证）

1. 从 `release/log.jsonl` 找到最后一个可信 release，检出对应 commit；
2. 用**离线根钥**重新签名并发布（release 号继续递增，不回退）；
3. 跑全套测试 + `verify`；
4. 通知班级：新指纹、异常时间段、如何核对（官方短链/指纹）。

## 4. 一周内（复盘）

- 写清：时间线、根因、影响面（是否有人看到错误内容）、为什么防线没拦住、补了什么；
- 更新 `docs/SECURITY-PLAN.md` 的残余风险表；
- 若因"嫌麻烦绕过流程"导致，优先改流程（减少摩擦），而不是加更多密码学。

## 5. 日常巡检清单（每月）

- [ ] `main` 分支保护仍开启，无 bypass；
- [ ] 没有陌生 collaborator / deploy key / PAT；
- [ ] `keys/roster.json` 只有预期 signer，过期项已清；
- [ ] `release/log.jsonl` 序号连续、最后一条与线上一致；
- [ ] Actions 没有陌生 workflow；
- [ ] Pages 域名 TXT 仍在、证书正常。
