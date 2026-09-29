# 冷链离线交接台

疾控冷链车往返偏远采样点时经常断网：随车端在无网络下继续登记装箱、补冰、开箱交接、温控异常，记录只存本机（IndexedDB）；网络恢复后按 **转运单 + 箱号 + 字段版本** 与调度端合并。箱号/交接数量不一致时**保留两版并生成待核异常**，不盖掉已收样记录；容量或预约已满时**隔离受影响箱组**，保留最后一次确认结果并标出**最早阻塞的转运单**；合并失败本地记录不丢，重试幂等——不重复占用容量、不增加交接次数。

## 运行

```bash
npm install
npm start          # http://localhost:3000
npm test           # 合并引擎测试（node:test）
```

打开浏览器访问 `http://localhost:3000`，三个标签页：

- **调度端**：维护车辆（容量）、实验室与预约（容量）、转运单；查看箱组状态、占用率、隔离箱组；处理待核异常。
- **随车端**：填写设备序号，登记 装箱 / 补冰 / 开箱交接 / 温控异常。断网时记录进本机 outbox，恢复联网自动同步，也可点「立即同步」。
- **异常核处**：对照调度版本与随车版本，采纳任一方、标记核实，或对隔离箱组「解除隔离」（会重新校验容量）。

点「载入演示数据」可快速看到 3 辆车、2 个预约、3 张转运单的样例。

## 合并规则（服务端 `server/src/merge.js`）

| 场景 | 处理 |
| --- | --- |
| 字段版本 | 同箱同字段按版本号合并：高版本生效；**同版本不同值** => 字段冲突，两版均保留 |
| 箱号不一致 | 箱号已属于另一张转运单 => 冲突，保留两版待核，**不覆盖**归属 |
| 交接数量不一致 | 已收样数量（`handover_qty`）已有确认值时，任何不同值**不自动覆盖**；装箱数/交接数与转运单计划不符 => 两版保留 + 待核异常 |
| 容量不足 / 预约已满 | 装箱事件占用箱位前校验；超限 => 该箱组标记 **隔离**（不计入占用），已存在的箱组保留最后一次确认结果，异常中给出**最早阻塞转运单** |
| 温控超范围（2~8℃） | 生成温控异常（critical/warning），不阻断业务 |
| 转运单不存在 | 事件标记 `rejected`，**本地记录保留**；调度补单后用同一事件重试即可重跑 |

## 幂等与重试

- 每条事件有客户端生成的 `event_id`。服务端对已应用（`applied`/`conflict`/`isolated`）的事件重试**直接返回原结果**，不重复占用容量、不增加交接次数。
- 只有 `rejected`（未产生任何副作用）的事件允许重跑。
- 随车端 outbox 中的记录**只有收到服务端确认后才改变状态**；网络失败一律保留 `pending`，可反复重试；`failed` 可重试或丢弃（有确认提示）。

## 数据存储

- 服务端：SQLite（`server/data/coldchain.db`），表：`vehicles / labs / appointments / orders / boxes / box_fields / events / anomalies`。
  - `box_fields` 保存每箱每字段的版本值，是字段级合并的依据；`events` 是事件流水与幂等依据；`anomalies` 保存两版对照与核处结果。
- 随车端：IndexedDB（`coldchain` 库）的 `outbox`（事件）与 `cache`（调度状态缓存）；`localStorage` 存设备序号与字段版本号。
- Service Worker 缓存应用外壳，API 请求不走缓存（保证合并以服务端为准）。

## 目录

```
server/src/db.js      SQLite 表结构
server/src/merge.js   合并引擎：字段版本、冲突保留、容量隔离、幂等、异常核处
server/src/api.js     HTTP API + 演示数据
client/index.html     单页外壳（调度/随车/异常三页签）
client/js/idb.js      IndexedDB 封装（outbox + cache）
client/js/sync.js     同步引擎（上报、回滚状态、字段版本）
client/js/dispatch.js 调度端界面
client/js/vehicle.js  随车端界面
client/js/anomalies.js 异常核处界面
test/merge.test.js    10 项合并规则测试
```
