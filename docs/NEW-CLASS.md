# 新建班级上线向导

面向**超级管理员**：在页面里新建一个班级，并把它变成正式班级（可选让班委自助发布）。

> 普通管理员/班委**不能**新建班级；只有 `scope` 含 `*` 的授权（`grant-super-all.json`）可以。

---

## 一、页面内新建（A）

1. 页脚「解锁编辑」→ 选 `review/grants/grant-super-all.json`；
2. 顶部班级栏点 **＋**；
3. 输入新班 id（如 `Z6`，只能字母/数字/下划线/短横线，最多 32 位）；
4. 确定后自动切到新班，可正常添加实验；
5. 刷新页面后班级仍在（存在本机 localStorage）。

> 此时只是**本机班级**，线上还没有；要继续做 B 才会进仓库。

---

## 二、零命令行上线（推荐给不想用命令的人）

前置（一次性，管理员）：

1. Issues → Labels 新建标签 **`new-class`**（模板引用它，没有标签会提交失败）；
2. 确认已配置 Actions secret `RELEASE_SIGNING_KEY`；
3. Settings → Actions 勾选 *Allow GitHub Actions to create and approve pull requests*。

操作：

1. 页面里新建并加好数据；
2. 操作 → 导出 → **xlsx**；
3. 打开 [新建班级 Issue 模板](https://github.com/XiaoYu-Oxyz/XiaoYu-Oxyz.github.io/issues/new?template=new-class.yml)：
   - 「班级 id」填 `test`；
   - 把 xlsx 拖进「班级数据（xlsx）」框，等出现附件链接；
   - 勾选确认 → **Submit new issue**；
4. 等 1–3 分钟，CI 会：
   - 检查提交者是仓库所有者/成员（否则直接拒绝并评论）；
   - 下载并校验 xlsx（≤2MB、有效、表头、≤5000 条）；
   - 写入 `data/<id>.xlsx`、构建、用 CI 密钥签名；
   - 自动开 PR（**不自动合并**）；
5. 检查 PR 的 `Files changed` 只有本班文件，点 **Squash and merge**。

> 安全边界：只有 OWNER/MEMBER/COLLABORATOR 能触发；陌生人提交会被拒绝。已存在的班级请用「班级数据发布」模板，不要用这个。

---

## 三、命令行上线（B）

1. 在新班页面：操作 → 导出 → **xlsx**；
2. 把导出的文件放进仓库：
   ```powershell
   cd D:\MyProgram\HTML\CrseCue\XiaoYu-Oxyz.github.io
   node tools/new-class.mjs add --class Z6 --from "C:\Users\Lenovo\Downloads\Z6-数据-2026-12-01.xlsx"
   ```
3. 构建并签名：
   ```powershell
   python tools/build.py
   node tools/release.mjs manifest
   node tools/release.mjs sign --key C:\Users\Lenovo\.crsecue\root-ed25519.pem
   node tools/release.mjs verify
   python tools/build.py --check
   ```
4. 提交 `data/Z6.xlsx`、`index.html`、`calendars/Z6.ics`、`release/*`，开 PR；
5. 合并后线上出现 Z6，页脚签名信息不变。

> `add` **不会**自动改 release，也不会自动生成班委密钥；两步都要管理员确认。

---

## 四、可选：让 Z6 班委自助发布

1. 生成班级密钥：
   ```powershell
   node tools/new-class.mjs keygen --class Z6
   ```
   - 私钥：`..\review\publishers\Z6.pem`（仓库外）
   - 公钥：`keys\publishers\Z6.pub`

2. 在 `keys/publishers.json` 的 `publishers` 数组里追加：
   ```json
   {"class":"Z6","id":"Z6-publisher","keyId":"Z6-pub","pubkey":"keys/publishers/Z6.pub","exp":"2027-06-30"}
   ```

3. 用根钥重签名册并重签发布：
   ```powershell
   node tools/sign-publishers.mjs sign --key C:\Users\Lenovo\.crsecue\root-ed25519.pem
   python tools/build.py
   node tools/release.mjs manifest
   node tools/release.mjs sign --key C:\Users\Lenovo\.crsecue\root-ed25519.pem
   node tools/release.mjs verify
   ```

4. 给 Z6 班委私聊发：
   - `review\publishers\Z6.pem`
   - 对应编辑授权（scope 只含 Z6）
   - [CLASS-COMMITTEE.md](CLASS-COMMITTEE.md)

5. 班委按一页纸：解锁 → 改 → 导出 → `sign.html` 签名 → Issue 上传。

> 私钥只发本班班委，**不要发群、不要放共享盘**。

---

## 五、回滚

- 删除 `data/Z6.xlsx`；
- 从 `keys/publishers.json` 移除 Z6，重签名册；
- `python tools/build.py` 后重签 release；
- 开 PR 合并，线上 Z6 消失。

已分发的 `Z6.pem` 同时作废；如泄露，立即按上面的流程换钥。

---

## 六、限制

- 班级 id 不能含中文、空格、斜杠；
- 新建班级只是空班，没有实验；
- 只有 `grant-super-all.json`（scope `*`）能建新班；普通 grant 会提示「该班不在编辑授权范围」；
- 发布签名仍在管理员手里，新班不会自动上线。
