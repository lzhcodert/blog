---
title: 把 CRM 从 SQL Server 迁到 GoldenDB：一次迁移真正要过的六道关
date: 2026-11-27
time: 16:20
category: 数据库
summary: 以银行 CRM 的客户表、跟进记录、机构字典和商机表为例，讲清 SQL Server 到 GoldenDB 迁移的四件事：建表结构怎么改、分片键怎么选、T-SQL 怎么转、数据怎么用 Sloth 搬且不出错，附权威出处与回退方案。
tags: [GoldenDB, SQLServer, 数据库迁移, CRM, 信创, 分片]
embed: embed/sqlserver-to-goldendb.html
embed-title: SQL Server 迁 GoldenDB 图解（六张图）
embed-label: 图 1 四道关总览 / 图 2 CRM 表改造 / 图 3 分片键选择 / 图 4 语法转换 / 图 5 Sloth 能力边界 / 图 6 割接回退（可缩放 / 可拖拽）
embed-height: 1150
---

数据库迁移最容易产生的误会，是把它当成"导出再导入"。

真到项目里你会发现，**搬数据往往是工作量最小的一环**。真正费劲的是前面那些问题：

- 这张表在 SQL Server 里好好的，到 GoldenDB 该怎么写 `CREATE TABLE`？
- 单机库不需要分片键，分布式库却必须选——选错了，客户维度查询就变成全分片扫描。
- 应用里几百条 SQL 全是 `TOP`、`ISNULL`、`GETDATE()`，难道要一条条改？
- 数据搬过去了，怎么证明一模一样？割接当天出问题怎么退回来？

这篇文章用一套银行 CRM 的表当例子，把这几件事串成一条线。目标是让你看完能判断：**自己这个项目到底要改什么、工具能帮多少、哪些坑必须提前躲。**

> 说明：GoldenDB 是金篆信科（中兴）的分布式数据库，在 **MySQL 模式**下兼容 MySQL 8.0.25 及以前版本的语法、数据类型、内置函数、视图和存储过程。它不兼容 SQL Server 的 T-SQL，所以"改 SQL"这一关躲不掉。

## 先把全局看清：四道关

按顺序是这四步：

| 关口 | 做什么 | 谁来做 |
|---|---|---|
| ① 结构 | 字段类型映射、主键索引重设、加分片规则 | 人，手工改 DDL |
| ② 分片 | 每张表选分片键和分片策略 | 人，按业务查询模式定 |
| ③ 语法 | T-SQL 改成 MySQL 写法 | 人，改应用 SQL |
| ④ 数据 | 全量搬迁 + 一致性校验 + 差异修复 | Sloth 工具 |

前三关都在停机窗口**之前**完成，窗口里只做第四关和切换。

一个必须先接受的现实：**Sloth 只负责搬数据，不负责把 T-SQL 翻译成 MySQL SQL，也不负责帮你建表。**

## 第一关：建表结构怎么改

拿 CRM 最常用的客户主表 `crm_customer` 举例。

**SQL Server 原版：**

```sql
CREATE TABLE [dbo].[crm_customer] (
  cust_id BIGINT IDENTITY(1,1) PRIMARY KEY,
  cust_name NVARCHAR(100) NOT NULL,
  id_no VARCHAR(30),
  mobile VARCHAR(20),
  level MONEY DEFAULT 0,
  created_at DATETIME2 NOT NULL,
  guid UNIQUEIDENTIFIER
);
```

**GoldenDB（MySQL 模式）改造后：**

```sql
CREATE TABLE crm_customer (
  cust_id BIGINT NOT NULL AUTO_INCREMENT,
  cust_name VARCHAR(100) NOT NULL,
  id_no VARCHAR(30) DEFAULT '',
  mobile VARCHAR(20) DEFAULT '',
  level DECIMAL(19,4) DEFAULT 0,
  created_at DATETIME(6) NOT NULL,
  guid CHAR(36),
  PRIMARY KEY (cust_id)
) DISTRIBUTED BY HASH(cust_id) (g1,g2,g3);
```

差异集中在三处：

1. **标识符**：去掉 `[dbo].` 和方括号。GoldenDB 的对象名不超过 30 个字符，只用字母、数字、下划线，避开 `date`、`rank`、`order` 这类关键字。
2. **字段类型**：`IDENTITY` → `AUTO_INCREMENT`，`MONEY` → `DECIMAL(19,4)`，`DATETIME2` → `DATETIME(6)`，`UNIQUEIDENTIFIER` → `CHAR(36)`。
3. **分片规则**：末尾多了 `DISTRIBUTED BY HASH(cust_id)`——这是单机库没有的，官方建表语法里就带这个选项。

### 字段类型对照

GoldenDB 官方文档给出了 MySQL → GoldenDB 的同类型映射（INTEGER、BIGINT、DECIMAL、VARCHAR、DATE、DATETIME 等都是同名对应）。SQL Server 特有类型要先折到 MySQL 类型，再落到这里：

| SQL Server | GoldenDB（MySQL 模式） | 说明 |
|---|---|---|
| `INT` / `BIGINT` | `INT` / `BIGINT` | 直接对应 |
| `DECIMAL(p,s)` | `DECIMAL(p,s)` | 直接对应 |
| `MONEY` / `SMALLMONEY` | `DECIMAL(19,4)` / `DECIMAL(10,4)` | 金额别用浮点 |
| `NVARCHAR(n)` | `VARCHAR(n)` + 库字符集 `utf8mb4` | 中文按字符计，注意行长 |
| `VARCHAR(n)` | `VARCHAR(n)` | 直接对应 |
| `TEXT` / `NTEXT` | `TEXT` / `LONGTEXT` | 长文本 |
| `DATETIME` | `DATETIME` | 直接对应 |
| `DATETIME2` | `DATETIME(6)` | 保留小数秒 |
| `BIT` | `TINYINT(1)` | 布尔值 |
| `UNIQUEIDENTIFIER` | `CHAR(36)` | 存字符串形式的 GUID |
| `TIMESTAMP`（rowversion） | 不能用 | 改用显式版本号字段或时间戳 |

> **注意**：“列类型对照”里 SQL Server 特有类型到 MySQL 类型的折算，属于异构迁移的通用做法；GoldenDB 官方明确的是 MySQL 类型到 GoldenDB 类型的同名映射。实际项目请以目标版本的兼容性清单和实测为准。

另外两条官方设计规范值得照做：

- **字段类型避免 `DEFAULT NULL`**，尽量用特殊的默认值（上面 `id_no`、`mobile` 写成 `DEFAULT ''` 就是这个道理）。
- **每个业务表都要有主键索引**，否则 GoldenDB 会额外生成内部 `_gdb_rowid` 字段，既占空间又增加回表开销。

## 第二关：分片键怎么选

这是迁移里最容易翻车的一步。分片键一旦定义，**后期修改需要重建表**，所以必须先想清楚。

官方给出的分片键原则：

- 优先用表的**查询字段或关联查询字段**；
- 优先用**主键**、其次是**唯一索引字段**；
- 选**很少修改**的字段；
- 插入和修改时，分片键必须是**确定值**。

放到 CRM 里，四张表的答案不一样：

| 表 | 角色 | 分片策略 | 理由 |
|---|---|---|---|
| `crm_customer` 客户主表 | 百万级主数据 | `HASH(cust_id)` | 客户号高离散、稳定，点查命中单分片 |
| `crm_follow_up` 跟进记录 | 千万级明细 | `HASH(cust_id)` | 与客户表同键，关联在本分片完成 |
| `crm_org` 机构字典 | 几百行小表 | `DUPLICATE` 复制表 | 官方建议：小表且不常修改用复制表 |
| `crm_opportunity` 商机表 | 按机构管业绩 | `LIST(org_id)` | 官方建议：LIST 适合机构码、地区码这类限定值 |

**最关键的是前两张表用同一个 `cust_id` 分片。** 客户经理打开全景画像时要查"客户资料 + 跟进记录"，同分片规则意味着这次关联不用跨节点搬数据。如果客户表按 `cust_id`、跟进表按 `follow_id`，每次查询都要散到多个分片再汇总，性能会差一个量级。

分片策略官方有三类：

- **HASH**：不关心字段值含义、要均匀打散时用，适合客户表、账号表这类高并发 OLTP 主档。
- **RANGE**：按范围（自然月、天）分布，适合流水、历史表。
- **LIST**：按预定义列表分布，适合机构代码、国家代码。

> **术语小抄 · 分片键 vs 分区键**
> 分片（DISTRIBUTED BY）决定数据落到哪个数据节点，是分布式层的事；分区（PARTITION BY）是分片内部再按时间等规则细分，便于归档和清理。两者可以叠加：先按客户号 HASH 分片，再在每个分片内按月份分区。

## 第三关：T-SQL 怎么转成 MySQL 写法

不用全背，把应用里实际用到的 SQL 捞出来逐条改。CRM 里最高频的八条：

| SQL Server | GoldenDB（MySQL 模式） |
|---|---|
| `SELECT TOP 10 * FROM t` | `SELECT * FROM t LIMIT 10` |
| `ISNULL(mobile, 'N/A')` | `IFNULL(mobile, 'N/A')` |
| `GETDATE()` | `NOW()` |
| `NEWID()` | `UUID()` |
| `[dbo].[crm_customer]` | `crm_customer`（去方括号） |
| `N'中文客户'` | `'中文客户'`（库用 `utf8mb4`） |
| `OFFSET 20 ROWS FETCH NEXT 10` | `LIMIT 20, 10` |
| `MERGE INTO ...` | `INSERT ... ON DUPLICATE KEY UPDATE` |

**别用正则全局替换。** 这些是常见对应关系，不是等价转换规则。尤其是：

- 存储过程、触发器、自定义函数要**逐条重写并测试**。GoldenDB 在 MySQL 模式下支持这些对象，但语法按 MySQL 写，不是 T-SQL。
- 应用连接串里的驱动要换成 GoldenDB 的 JDBC 驱动，字符集参数（GBK 链路）按官方文档在 URL 里配 `characterEncoding=gbk`。
- 参数化查询保持原样，顺便检查有没有拼接 SQL 的老代码。

## 第四关：数据怎么搬——Sloth 能做什么、不能做什么

Sloth 是金篆信科的数据迁移工具，官方定位是"集管控、运维、编排于一体"，支持 Oracle、DB2、SQLServer、MySQL、PostgreSQL 等异构数据源与 GoldenDB 之间的数据迁移同步。

但**具体到 SQLServer → GoldenDB（官方代号 X2G）这条路，功能矩阵里是有限制的**：

| 能力 | X2G 支持情况 |
|---|---|
| 全量迁移 | ✓ |
| 数据校验（快照比对 / 同步比对） | ✓ |
| 数据修复 | ✓ |
| 断点续传 | ✓ |
| 对象迁移（表、存储过程等） | ✕ |
| 增量 DDL | ✕ |
| 增量 DML | ✕ |
| 不停服"迁移+同步" | ✕（矩阵里没有 X2G 这一项） |

对照一下：MySQL → GoldenDB（M2G）和 Oracle → GoldenDB（O2G）是支持"迁移+同步"的，能做到不停服。SQLServer 这条路不行。

**这直接决定排期方式：**

- 停机窗口**之前**：完成建表、分片、SQL 改造、回归测试，把能提前做的全做完。
- 停机窗口**之内**：停写 → 全量搬迁 → 校验 → 修复 → 切换。
- 不要按"全+增无缝切换"的宣传口径排计划，那是别的源库路线才有的能力。

Sloth 的基本动作是：注册数据源 → 配置最小权限 → 新建任务（选全量）→ 配映射规则和白名单 → 开比对 → 可行性检查 → 保存启动。迁移过程中源端别做 DDL，目标端的外键和触发器要关掉。

> 说明：Sloth 的具体功能矩阵会随版本调整。本文按 2026 年初公开的官方功能文档写，立项时请核对你要用的版本。

## 割接当天：七步走，并留好回退路

迁移成功不等于切换成功。割接窗口里最重要的是**可回退**。

1. **停写公告**：冻结 CRM 写入，确认无在途事务。
2. **最终增量**：把停写前最后一批数据补搬完。
3. **全量校验**：行数、主键、金额汇总都要比。
4. **差异修复**：对不上的记录修完再比一次。
5. **应用切库**：改连接串，先灰度放几个客户经理试。
6. **业务冒烟**：建档、查全景画像、写跟进、拉营销名单，核心动作过一遍。
7. **全面放开**：观察 QPS、慢 SQL、报错率。

**验收口径**：数据零差异 + 核心交易跑通 + 性能指标达标，三者缺一不放量。

**回退路线**要提前备好并演练过：

- 源库保持只读、**不要立刻下线**，直到观察期结束；
- 连接串做成配置中心的开关，切回不改代码；
- 切回后的新数据要有反向同步通道（Sloth 支持 G2X 反向同步到 SQLServer）；
- 没演练过的回退方案等于没有。

一句话：**迁移看数据一致性，割接看可回退性。前者靠比对，后者靠演练。**

## 术语小抄

| 术语 | 大白话 |
|---|---|
| GoldenDB | 金篆信科（中兴）的分布式数据库，MySQL 模式下兼容 MySQL 语法 |
| Sloth | GoldenDB 的数据迁移工具，管全量、同步、比对、修复 |
| X2G / M2G / O2G | 源库缩写→GoldenDB：SQLServer / MySQL / Oracle 到 GoldenDB |
| T-SQL | SQL Server 的 SQL 方言，和 MySQL 语法不同 |
| 分片键 | 决定一行数据落到哪个分片节点的字段 |
| DISTRIBUTED BY | GoldenDB 建表时指定分片规则的语法 |
| HASH / RANGE / LIST | 三种分片策略：打散 / 按范围 / 按枚举值 |
| 复制表 | 小表在每个分片存一份，避免跨分片关联 |
| 快照比对 | 在某个时间点对源端和目标端做全量数据比对 |
| 增量 DML | 迁移期间的增删改，X2G 这条路径不支持 |

## 参考出处

1. 中兴通讯《GoldenDB 数据库 V6 技术白皮书》：高 SQL 兼容性（SQL92/99/2003、兼容 MySQL 语法与常用 Oracle/DB2 语法）、分片与在线扩容、备份恢复。<https://www.zte.com.cn/content/dam/zte-site/res-www-zte-com-cn/goldendb/250828内容更新素材/中兴通讯GoldenDB数据库V6技术白皮书.pdf>
2. 金篆信科 GoldenDB 官方（转载于墨天轮）《GoldenDB 分布式数据库：迁移工具 Sloth 功能概览》：X2G 停服迁移支持全量/校验/修复，不支持对象迁移、增量 DDL/DML；不停服迁移项目类型列表；数据源类型；断点续传与对象迁移说明。<https://cs.enmotech.com/db/2008423782366126080>
3. 金篆信科官方公众号《全链路数据迁移平台——GoldenDB Sloth 工具解析》（《中兴通讯技术》金篆数据库 GoldenDB 专题，作者沈文宽）：对象迁移先行、全量+增量衔接、双重校验机制；Sloth 已在电信行业支撑 BOSS、CRM 等系统割接。<http://mp.weixin.qq.com/s?__biz=Mzg4Njc2NDAwNg==&mid=2247492965&idx=1&sn=8eb7efccba660316e5eac9abcdd8df66>
4. 《GoldenDB 分布式数据库：与 MySQL 兼容性》：兼容 MySQL 8.0.25 及以前版本的类型、语法、函数、视图、存储过程；完整数据类型清单；建表带 `DISTRIBUTED BY`；字符集与字符序。<http://www.modb.pro/db/2034913305219915776>
5. 《GoldenDB 分布式数据库：应用开发设计规范》：对象命名不超过 30 字符、单行不超过 1M、避免 `DEFAULT NULL`、必须有主键索引；分片键与分片规则设计原则（HASH/RANGE/LIST/复制表）。<https://cs.enmotech.com/db/2026936329574621184>
6. 《GoldenDB 分布式数据库：如何迁移 MySQL 数据库数据到 GoldenDB》：使用限制（迁移中不做 DDL、关闭目标端外键与触发器）、类型映射、Sloth 任务参数。<http://www.modb.pro/db/1942047348876652544>

> 说明：文中 CRM 表名、字段和割接流程是**教学用示例**，用来串起迁移方法，不代表任何真实生产系统的结构。功能矩阵按文中所列公开文档版本整理，项目立项时请以目标版本的官方材料为准。
