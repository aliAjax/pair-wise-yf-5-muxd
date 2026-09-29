# 离线疾控冷链交接台

一套从零实现的离线优先交接原型，覆盖调度端、随车端、实验室收样、异常看板和断网重连合并。无第三方运行依赖，仅需 Node.js 20+。

## 业务目标

- 调度端维护转运单、车辆箱/样本容量、实验室预约窗口和容量。
- 随车端按 **箱号 + 设备序号** 登记装箱、补冰、开箱、温控异常；无网络时先写本地 outbox。
- 网络恢复后按 **转运单、箱号、字段版本** 合并。
- 箱号归属、设备序号、装箱数量或交接数量不一致：服务端版本和随车版本都保留，生成待核异常，绝不覆盖已收样记录。
- 车辆容量不足或预约已满：整组箱隔离，不占用正式容量；异常中保存最后一次确认结果，并给出最早阻塞转运单。
- 合并失败后本地记录继续保留；重试使用固定 `opId` / `handoverId`，不会重复装箱、重复占容量或增加正式交接次数。

## 快速开始

```bash
npm test

node src/cli.js init

# 调度端：车辆、预约、转运单、派车
node src/cli.js vehicle V1 --name 冷链车 --boxes 40 --samples 400
node src/cli.js appointment A1 --lab L1 --samples 200 --start 09:00 --end 10:00
node src/cli.js manifest M1 --origin 中心 --destination 山区 --boxes 10 --samples 100 --vehicle V1 --appointment A1
node src/cli.js plan M1 --vehicle V1 --appointment A1 --boxes 10 --samples 100
node src/cli.js sync --node dispatch-1

# 随车端：断网也可执行，先进入本地 outbox
node src/cli.js pack M1 --group G1 --node vehicle-1 --vehicle V1 --appointment A1 \
  --boxes '[{"boxId":"B1","deviceSerial":"D1","sampleCount":10}]'
node src/cli.js event M1 --box B1 --kind ICE_REPLENISHED --node vehicle-1
node src/cli.js event M1 --box B1 --kind BOX_OPENED --node vehicle-1
node src/cli.js event M1 --box B1 --kind TEMP_ABNORMAL --node vehicle-1 \
  --payload '{"minTemperature":7,"maxTemperature":12}'

# 回站联网
node src/cli.js sync --node vehicle-1

# 实验室收样
node src/cli.js receive M1 --box B1 --quantity 10 --receiver 李医生 --node lab-1
node src/cli.js sync --node lab-1
node src/cli.js status M1
```

数据默认写入 `.cold-chain/`；也可通过 `COLD_CHAIN_HOME=/path/to/data` 指定独立目录。

## 数据与合并模型

### 操作日志（Operation Log）

所有变化都表示为带幂等键的操作，而不是直接改最终记录：

- `UPSERT_VEHICLE` / `UPSERT_APPOINTMENT` / `UPSERT_MANIFEST`
- `PLAN_MANIFEST`
- `PACK_BOX_GROUP`
- `ADD_BOX_EVENTS`
- `CONFIRM_RECEIPT`
- `RESOLVE_EXCEPTION`

本地端保存：

- `outbox`：尚未完全成功的操作。
- `localRecords`：离线期间的原始本地记录，即使 blocked/rejected 也不删。
- `server`：最近一次同步的服务端快照，用于离线展示和字段版本递增。

### 字段版本合并

每个字段独立保存 `fieldVersions`：

- 高字段版本覆盖低版本。
- 低版本重放为 no-op。
- 同版本但值不同，生成 `field_version_conflict`，两版值都进入异常，不静默覆盖。

### 装箱冲突

正式箱记录以箱号为主键，并校验：

- 箱号是否已属于其他转运单；
- 设备序号是否一致；
- 装箱样本数是否一致；
- 随车字段版本是否低于服务端；
- 同一组内是否重复箱号。

冲突时候选箱组完整放入 `quarantined`，正式 `boxes` 不变。

### 容量与预约

- 车辆限制：箱数、样本数。
- 预约限制：实验室预约样本数。
- 规划和装箱都会做投影校验。
- 超额时返回 `blocked`，隔离整个候选箱组，并在异常中给出 `earliestBlockingManifest`（按已确认规划时间最早的占用转运单）。
- `lastConfirmedResult` 保存该转运单/箱组最近一次确认结果。
- 被隔离箱组不写入正式 `boxes/groups`，因此不会占容量。
- 调度扩容或改约后，可用同一个 `opId` 重试；原阻塞异常自动关闭，成功后只落一组正式数据。

### 实验室收样

- `handoverId` 是交接幂等键，未提供时使用操作 ID。
- 数量与装箱数量不同：候选交接标记 `QUARANTINED`，正式箱保持原状态，正式交接次数增加量为 0。
- 未知箱号：交接记录保留为 detached/quarantined，供人工核对。
- 已收样箱再次出现不同交接：新旧两版都保留，已收样记录不被覆盖。
- 完全相同 `handoverId` 的成功交接重放返回 `applied_duplicate`，交接次数增加量为 0。

## 代码结构

```text
src/
  server.js   服务端权威状态、容量投影、冲突检测、异常板
  station.js  调度/随车/实验室本地节点、outbox 和同步
  store.js    内存存储与 JSON 原子文件存储
  cli.js      命令行演示入口
  util.js     ID、时间、版本和数值校验
test/
  handover.test.js  端到端规则测试
```

## HTTP/多端部署时的映射

当前为便于从零验证，使用本地 JSON + CLI 表达同一协议。接入真实网络时无需改变核心规则：

1. 远端把 `SyncServer.applyBatch(ops)` 暴露为 `POST /sync`。
2. 本地端仍持久化 `outbox/localRecords`。
3. 请求超时不等于失败：联网后重发同一批操作，由 `opId/handoverId` 去重。
4. 若要防止多人共用同一自增 ID，可把当前随机 `opId` 换成 ULID/雪花 ID；冲突判断仍以业务主键和字段版本为准。

## 已验证场景

`npm test` 覆盖：

1. 离线装箱、补冰、开箱、温控异常和恢复同步。
2. 车辆容量不足时整组隔离、保留确认结果、指出最早阻塞转运单。
3. 箱号/设备序号/数量分叉时保留两版且不覆盖。
4. 交接数量不一致时保留两版，正式交接次数不增加。
5. 已收样记录不能被后续不同交接覆盖。
6. 扩容后原装箱操作重试成功，不重复占容量、不重复装箱。
7. 预约已满时规划失败。
8. 同字段版本分叉冲突和高版本推进。
9. 断网时本地记录不丢失。
