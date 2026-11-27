---
title: 把 CRM 从 SQL Server 迁到 GoldenDB：Sloth 直连还是 Loader 文件摆渡
date: 2026-11-27
time: 16:45
category: 数据库
summary: 以银行 CRM 为例，讲清 SQL Server 到 GoldenDB 迁移的四件事：建表结构怎么改、分片键怎么选、T-SQL 怎么转、数据怎么搬——重点对比 Sloth 直连与 Loader 文件摆渡，完整拆解 bcp 分批导出到 Loader 读文件写入的每一步，附权威出处与回退方案。
tags: [GoldenDB, SQLServer, 数据库迁移, CRM, 信创, 分片, Loader]
embed: embed/sqlserver-to-goldendb.html
embed-title: SQL Server 迁 GoldenDB 图解（七张图）
embed-label: 图 1 四道关总览 / 图 2 CRM 表改造 / 图 3 分片键选择 / 图 4 语法转换 / 图 5 Sloth 与 Loader 对比 / 图 6 文件搬运全流程 / 图 7 割接回退（可缩放 / 可拖拽）
embed-height: 1350
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
| ④ 数据 | 全量搬迁 + 一致性校验 + 差异修复 | Sloth 直连 或 Loader 文件摆渡 |

前三关都在停机窗口**之前**完成，窗口里只做第四关和切换。

一个必须先接受的现实：**不管选 Sloth 还是 Loader，工具都只负责搬数据，不负责把 T-SQL 翻译成 MySQL SQL，也不负责帮你建表。**

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

## 第四关：数据怎么搬——Sloth 直连，还是 Loader 摆渡

搬数据有两条路。一条是让工具**同时连着两端数据库，边读边写**；另一条是**先把源库导成文件，再让 GoldenDB 自己的工具把文件读进去**。

打个比方：Sloth 像一根接在两边之间的管道，Loader 像摆渡——货得先卸到码头（文件），再装船。管道省事，摆渡可控。

先把两条路的差别摆清楚，后面重点讲摆渡怎么走：

| 对比项 | Sloth 直连搬运 | Loader 文件摆渡 |
|---|---|---|
| 数据怎么走 | 工具连源库 + 目标库，边读边写 | SQL Server 先导出 CSV，Loader 再读文件写入 |
| 中间产物 | 没有，数据在内存里流转 | 有，一批一个文件，落在磁盘上 |
| 断点续传 | 工具自己记进度 | 按文件记：哪个文件失败就重导哪个 |
| 校验 / 修复 | 工具自带快照比对和数据修复 | 工具只报成功/失败行数，一致性自己写脚本比 |
| 对源库压力 | 持续连库读取 | 导出完就断开，也可在业务低峰慢慢导 |
| 能做的准备 | 边搬边写 | 文件落地后能先脱敏、清洗、补列再导 |
| SQLServer→GoldenDB 增量 | 不支持 | 也不支持，两者都要停写窗口 |

一句话：**Sloth 是"管到底"的搬运工，Loader 是"只管往库里写文件"的工具**。SQLServer 这条路两者都不支持增量同步——别指望哪条路能少停机。

> 说明：Sloth 的 SQLServer→GoldenDB（官方代号 X2G）只支持停服全量迁移 + 校验 + 修复，不支持对象迁移、增量 DDL/DML；MySQL、Oracle 到 GoldenDB 才支持"迁移+同步"。功能矩阵按公开文档整理，立项时核对你的版本。

### 为什么项目里常常选文件摆渡

不是因为 Sloth 不好，而是有些现场条件决定了只能这么走：

- **表太大**：一张客户表几百 GB，一次性直连搬，中途断一次就得从头来；拆成 50 批，断一批只重导一批。
- **网络隔离**：生产网和信创网之间不通数据库端口，只能过文件交换平台传文件。
- **要清洗数据**：源端有敏感字段要脱敏、`guid` 要转 `CHAR(36)`、类型要先在导出查询里转好，文件是天然的"加工台"。
- **节奏可控**：先导小表试水，再一批批放大表，出问题随时暂停。

代价也明确：**多出来的文件要自己管，校验脚本要自己写**。

### 第一步：SQL Server 端按主键范围拆批

拆批的关键是**按主键范围切，不要按时间、不要按页号**。

- 按时间切：同一秒几十条记录，边界容易重复或漏；
- 按页号切（`OFFSET/FETCH`）：越往后翻越慢，而且导出期间有新写入就会错位；
- 按主键范围切：边界是数字，连续、不重叠，漏了哪段一眼看得出来。

先算出主键边界：

```sql
SELECT MIN(cust_id) AS min_id, MAX(cust_id) AS max_id
FROM crm.dbo.crm_customer;
-- 假设得到 1 ~ 50000000，按每批 100 万切成 50 批：
-- 第 1 批 [1, 1000000)，第 2 批 [1000000, 2000000)……第 50 批 [49000000, 50000001)
```

然后用 SQL Server 官方的 `bcp` 工具，带 `queryout` 把每一批导成 CSV：

```bat
bcp "SELECT cust_id, cust_name, id_no, mobile, CAST(level AS DECIMAL(19,4)) AS level, CONVERT(varchar(19), created_at, 120) AS created_at, CAST(guid AS CHAR(36)) AS guid FROM crm.dbo.crm_customer WHERE cust_id >= 1 AND cust_id < 1000000 ORDER BY cust_id" queryout "D:\crm_export\crm_customer_001.csv" -c -C 65001 -t "," -r "\n" -S sqlsrv01 -d crm -U ldsuser -P "******" -b 10000 -e "D:\crm_export\err_001.log"
```

**注意看查询里那几处 `CAST` / `CONVERT`**：类型转换和日期格式化在导出的时候就做完，导出的文件已经是 GoldenDB 想要的样子。别把 `MONEY`、`DATETIME2`、`UNIQUEIDENTIFIER` 原样导出去再指望导入工具猜——这是最常见的事故来源。

`bcp` 的参数按官方说明：

| 参数 | 作用 | 这里为什么这么写 |
|---|---|---|
| `queryout` | 导出一条 SQL 查询的结果 | 要带 `WHERE` 按主键范围切批，不能用整表 `out` |
| `-c` | 字符格式 | 跨库迁移用字符格式，别用 `-n`（本机格式只有 SQL Server 自己认） |
| `-C 65001` | 字符集（UTF-8 代码页） | 中文客户名不乱码；旧系统用 GBK 就写 936，但要全链路一致 |
| `-t ","` | 字段分隔符 | 和后面 Loader 的 `fields terminated by` 对应 |
| `-r "\n"` | 行分隔符 | Windows 上要写引号，命令行里 `\` 要转义 |
| `-b 10000` | 每批提交行数 | 控制单次写入量，失败时回滚范围小 |
| `-e` | 错误记录文件 | 导出阶段的行级错误单独落盘，别混进数据文件 |
| `-F / -L` | 首行 / 末行 | 另一种按行号切批的方式，不如主键范围稳 |

每导完一批，记一笔台账：批次号、主键范围、文件行数、文件 MD5。后面重导、校验全靠这张表。

### 第二步：文件落地，先清点再往下走

- **一批一文件**，文件名带批次号（`crm_customer_001.csv` … `050.csv`），别把所有批次塞进同一个大文件。
- **先对账**：每个文件的行数，应该等于源库该主键范围的 `COUNT(*)`。对不上就别导，多半是 `WHERE` 边界写重了或者漏了。
- **留 MD5**：文件过交换平台可能损坏，导入前校验一次 MD5 比排查乱码快得多。
- **别手改文件**：要改数据就改导出查询重新导，手改 CSV 容易破坏分隔符和对齐。

### 第三步：Loader 读文件写入 GoldenDB

这里的工具官方叫 **LoadServer**，是 GoldenDB 自研的导入导出工具，命令行通过 `dbtool -loadserver` 下发任务。一个典型的导入命令：

```bash
dbtool -loadserver -type="in" -clusterid=1 \
  -sql="load data infile '/data/crm/crm_customer_001.csv' into table crm.crm_customer fields terminated by ',' optionally enclosed by '\"' lines terminated by '\n' (cust_id,cust_name,id_no,mobile,level,created_at,guid);" \
  -user='ldsuser' -password='******' -db-conn-info=10.229.31.202:8881
```

**最容易出错的一行是括号里的列清单**：列数、顺序必须和 CSV 文件完全一致。Loader 是按位置对号入座的，名字对不上它也不会帮你纠正。

`dbtool` 的主要参数：

| 参数 | 作用 |
|---|---|
| `-type=in / out` | 导入 / 导出 |
| `-clusterid` | 目标集群编号 |
| `-sql` | 具体的 `LOAD DATA INFILE` 或 `SELECT ... INTO OUTFILE` 语句 |
| `-db-conn-info` | 计算节点 IP:端口 |
| `-errorignore=N` | 最多容忍 N 条错误数据，超过整批失败 |
| `-loadin-support-null=1` | 把 `,,` 这样的空字段当成 NULL |
| `-backup` | 导入前备份数据文件 |
| `-enable-ftp` | 走文件传输协议通道（见下） |

**两条通道怎么选**：

- **计算节点通道（默认）**：Loader 读文件 → 解析校验 → 执行线程连计算节点批量写。配置简单，计算节点负责路由到正确的分片——你建表时按 `cust_id` 做了 HASH 分片，Loader 不用自己算数据该去哪个 DN。
- **文件传输协议通道（`-enable-ftp`）**：Loader 先向元数据节点拿表结构，**按分片规则把一个大文件拆成各个分片的小文件**，再通知各数据节点的代理直接下载导入。少一跳计算节点，大批量更快，但要多配 `MetaDataServer` / `ClusterManager` 的地址。

一句话：**小批量、图省事用默认通道；几百 GB、追求速度用 `-enable-ftp`。**

### 第四步：失败数据落盘，修完再导

Loader 内部是一条流水线：**读线程**按行列分隔符读 CSV，每若干行成一批进解析队列；**解析线程**做合法性校验和字段处理；**执行线程**连计算节点批量写；写失败的行由**落盘线程**单独写到文件里。

所以正确的动作不是"整批重来"，而是：

1. 看落盘的失败文件，定位是格式问题、超长、还是主键冲突；
2. 修数据（改导出查询重新导，或改失败文件）；
3. 只重导那批，用 `replace` 或 `ignore` 处理主键冲突：

```bash
# replace：文件里的记录覆盖库中同主键的旧记录（放在 into 前面）
load data infile 'crm_customer_001.csv' replace into table crm.crm_customer ...
# ignore：库里已有的记录保留，跳过文件里的重复行
load data infile 'crm_customer_001.csv' ignore into table crm.crm_customer ...
```

`-errorignore=N` 是容忍上限，别设成很大去"掩盖"错误——失败行落盘了却没人管，比整批失败更危险。

### 第五步：校验——Loader 不替你比数据

这是文件方式和 Sloth 最大的差别：**Sloth 自带快照比对和数据修复，Loader 只告诉你写进去多少行、失败多少行。写得对不对，得自己比。**

三样必比：

| 比什么 | 怎么比 |
|---|---|
| 行数 | 每个批次文件行数 vs GoldenDB 里该主键范围的 `COUNT(*)` |
| 主键 | 源端和目标端的 `cust_id` 集合做差集，看有没有多或漏 |
| 金额 | CRM 商机表的金额做 `SUM`，源端目标端对总数 |

再抽几十条记录逐字段看：中文客户名有没有乱码、`id_no` 有没有被截断、`guid` 是不是标准 36 位。**这类问题行数是对的，只有逐字段看才能发现。**

### 文件格式的六个坑

1. **分隔符撞车**：客户名里有逗号，`fields terminated by ','` 就会把一行切碎。用 `optionally enclosed by '"'` 给字段加引号，或者把分隔符换成一个不会出现的字符。
2. **NULL 的表达**：源端 NULL 导成空字段后，加 `-loadin-support-null=1` 才把 `,,` 当 NULL，否则可能变成空字符串。
3. **日期格式**：`DATETIME2` 带小数秒，导出时用 `CONVERT(varchar(19), created_at, 120)` 统一成 `YYYY-MM-DD HH:MI:SS`。
4. **字符集全链路一致**：导出 `-C 65001`、文件 UTF-8、GoldenDB 表字符集 UTF-8。中间任何一环是 GBK 都可能乱码。
5. **行尾干净**：每行字段数一样，最后一行也要有换行符，别多写分隔符。
6. **列清单写全**：`LOAD DATA` 里显式写 `(col1,col2,...)`，别省略靠默认顺序。

> 说明：`LoadServer` 的配置项（如 `dumper_query_thread_nums`、`load_enable_ftp`）和命令参数以你使用的 GoldenDB 版本手册为准；不同版本可能有差异。

## 割接当天：七步走，并留好回退路

迁移成功不等于切换成功。割接窗口里最重要的是**可回退**。

1. **停写公告**：冻结 CRM 写入，确认无在途事务。
2. **最后批次补导**：Sloth 用户把停写前最后一段补搬完；Loader 用户把最后一批文件重新导出（此时已停写，数据定格）再导入。两条路都没有增量同步，别指望工具自动追平。
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
| Sloth | GoldenDB 的数据迁移工具，管全量、同步、比对、修复（SQLServer 这条路只支持全量） |
| Loader / LoadServer | GoldenDB 自研的导入导出工具，读 CSV 文件写入数据库，用 `dbtool -loadserver` 下发 |
| bcp | SQL Server 官方的批量导出工具，`queryout` 可以把查询结果导成文件 |
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
7. 金篆信科 GoldenDB 官方（转载于墨天轮）《GoldenDB 分布式数据库：LoadServer 导入导出》：LoadServer 使用场景、计算节点通道与文件传输协议通道、导入导出的线程模型、`dbtool -loadserver` 命令与 `LOAD DATA INFILE` / `SELECT INTO OUTFILE` 语法、参数与容错。<https://www.modb.pro/db/2004480348072779776>
8. Microsoft Learn《bcp 实用工具》：SQL Server 批量导出语法、`queryout`、`-c` / `-C` / `-t` / `-r` / `-b` / `-F` / `-L` / `-e` 参数说明与示例。<https://learn.microsoft.com/zh-cn/sql/tools/bcp-utility?view=sql-server-ver17>
9. 中兴通讯《GoldenDB 分布式事务型数据库金融应用指南》：迁移工具集（评估工具 CACtool、平台化迁移工具 Sloth）与反向同步能力。<https://www.zte.com.cn/content/dam/zte-site/res-www-zte-com-cn/mediares/golden_db/pdf/report2024010303.pdf>

> 说明：文中 CRM 表名、字段和割接流程是**教学用示例**，用来串起迁移方法，不代表任何真实生产系统的结构。功能矩阵按文中所列公开文档版本整理，项目立项时请以目标版本的官方材料为准。
