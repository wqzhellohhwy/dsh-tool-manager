# dsh-tool-manager(预设工具管理)

DSH 插件:在 Web GUI 设置页提供「预设工具管理」页面,按来源分组枚举当前寄存器中的全部工具,支持单个启用/禁用、批量操作、上下文注入管理、新增锁定策略与命名配置。配置持久化到 `$DSH_HOME/tool-manager.json`,供 clean-agent 预设的 `clean-tool-filter.mjs` 读取,**新会话生效,无需重启**。

## 功能特性

- **工具按来源分组**
  - MCP 工具:按 MCP server 名分组(`mcp__<server>__<tool>`)
  - 第三方插件工具:按归属插件分组(如 dsh-memory-evolve、dsh-super-injector、dsh-file-mount 等)
  - 每个工具带「启用/禁用」开关与「选中」复选框,支持搜索与启用状态筛选
- **批量操作**:全选 / 启用选中 / 禁用选中;上下文、第三方、MCP 各有一键选中/启用/禁用
- **上下文注入管理**:枚举 `systemPrompt.assemble()` 的动态上下文(sandbox:policy、approval:policy、memory:snapshot 等),可单独启用/禁用(denyContexts 禁用制 + allowContexts 显式启用)
- **新增锁定策略**:上下文 / 第三方 / MCP 三层独立设置「新增启用 / 新增禁用」——新出现的上下文注入、第三方插件工具或 MCP 工具按锁定策略自动启用或禁用(默认新增启用)
- **命名配置**:把当前工具/上下文启用状态保存为命名配置,可启用 / 重命名 / 删除(新增锁定状态不随配置切换)
- 改动即时自动保存,对新建会话生效

## 依赖与原理

- 本插件是 **host + client 标准双端 Cordis 插件**,负责枚举与 GUI 交互;**过滤逻辑在预设侧**的 `clean-tool-filter.mjs` 生效(它读取同一份 `tool-manager.json`,按名单动态重建 `tools.restrict` 与提示词 section/context 过滤)。
- 按 DSH bundle 判定规则:标准双端插件**不能**放入 `dsh.profile.bundles`(会启动崩溃),需通过 **dsh-super-injector** 运行时注入。

## 安装

```bash
# 1. 构建(host 用 esbuild,client 用 tsdown)
DSH_CHECKOUT=<dsh 源码目录> bash scripts/build.sh

# 2. 在装有 dsh-super-injector 的环境注入
#    dev_inject_plugin <本插件目录>
```

注入后刷新 Web GUI,「设置 → 预设工具管理」出现入口。同时确保目标预设(如 clean-agent)的 `clean-tool-filter.mjs` 已装配。

## 配置结构(`$DSH_HOME/tool-manager.json`)

`DSH_HOME` 缺省为 `~/.dsh`,所有路径均通过环境变量/用户主目录解析,不依赖本机专属配置。

```json
{
  "denyPrefixes": [],
  "denyNames": [],
  "allowPrefixes": [],
  "allowNames": [],
  "denyContexts": [],
  "allowContexts": [],
  "newDefault": { "context": "enabled", "third": "enabled", "mcp": "enabled" },
  "configs": []
}
```

- `denyPrefixes` / `denyNames`:屏蔽的前缀 / 精确工具名
- `allowPrefixes` / `allowNames`:豁免的前缀 / 精确工具名(优先级高于 deny)
- `denyContexts` / `allowContexts`:禁用的上下文 / 显式启用的上下文
- `newDefault`:三层「新增锁定」,`enabled`(默认)= 新出现的内容默认可用,`disabled` = 默认屏蔽;不随命名配置切换
- `configs[]`:命名配置,`state` 保存上述六个名单(不含 `newDefault`)

## 开发

```bash
npm install
DSH_CHECKOUT=<checkout> bash scripts/build.sh   # host(esbuild)+ client(tsdown)
```

## License

BSD-3-Clause
