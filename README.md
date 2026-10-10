# dsh-tool-manager

**纯净预设的工具治理面板 —— 在 DeepSeek Harness (dsh) 的 Web 设置页里，按来源枚举全部工具与动态上下文，逐项决定「纯净预设（clean-agent）里该不该有它」。**

[![License: BSD-3-Clause](https://img.shields.io/badge/License-BSD--3--Clause-blue.svg)](LICENSE)

---

## 项目背景

DeepSeek Harness 是高度插件化的宿主：宿主层（HOST 组合）会注册大量**全局工具**与**运行时上下文**，而"纯净预设"（如 `clean-agent`，其过滤器 `clean-tool-filter.mjs` 由本插件配套维护）的目标是把它们挡在某个会话之外——只留系统提示词、技能、MCP 与 dsh 原生工具。

预设侧的 `clean-tool-filter.mjs` 用 `tools.restrict({ deny })` 做屏蔽，但它只是一个**静态名单 + 命名规律**：

- 想调整"到底屏蔽哪些工具"，得改源码、改前缀列表，再重启；
- 新装的 MCP server、新注入的第三方插件会自动出现在纯净会话里，没人拦；
- 动态上下文（`sandbox:policy`、`approval:policy`、`memory:snapshot`……）更是只能靠代码里的白名单。

**本插件把这件事搬到 GUI**：设置页里一个「预设工具管理」页面，把当前寄存器里的全部工具（含来源分类）与全部动态上下文列出来，逐项开关，改动**即时保存、对新会话生效**。预设侧的过滤器改成读同一份配置，于是"想屏蔽什么"不再需要改代码。

## 核心功能

- **按来源分组的工具清单**：`mcp`（按 MCP server 名分组）/ `third`（按归属插件分组）/ `native`（**经源码核实的 DSH 官方宿主工具白名单**，见下文）/ `unknown`，带搜索与"仅看已启用/已禁用"筛选。
- **两个独立控件**：每个工具一个「☑ 选中」（供批量操作）+ 一个「启用/禁用」开关（单个即时生效）。
- **批量操作**：全选（作用于当前筛选结果）/ 启用选中 / 禁用选中；另有「选中并禁用所有 MCP」「选中并禁用所有第三方」两个一键动作。**禁用只写净化名单，不会真的关掉 MCP 或卸载插件。**
- **动态上下文治理**：枚举 `systemPrompt.assemble()` 暴露的动态上下文，用 `allowContexts`（显式启用）/ `denyContexts`（显式禁用）双向开关，未列名者由「新增锁定」`newDefault.context` 决定默认启用还是默认屏蔽。
  ⚠️ **前提**：目标预设的 persona **不能**配置 `includeRuntimeContext: false`——那会调用 `suppressRuntimeContext()` 把该作用域的全部上下文整体抹除，本页的开关将完全无效（详见「开发须知」第 8 条）。
- **新增锁定策略**：上下文 / 第三方 / MCP 三层各自设置「新增启用 / 新增禁用」——之后新出现的上下文注入、第三方工具、MCP 工具自动按策略处理（默认"新增启用"，与前行为一致）。
- **命名配置**：把当前六个名单存成命名配置，可启用 / 重命名 / 删除；`newDefault`（新增锁定）**不随配置切换**，避免切配置时把"新增策略"也换掉。
- **非破坏**：插件只负责"枚举 + 写配置 + 画界面"；过滤发生在预设侧，插件本身不碰任何工具的实际注册。

## 技术栈

| 层 | 用到的东西 |
|---|---|
| 宿主 | dsh 0.2.x · Cordis 插件体系 · `webServer.register({ kind: 'prefix' })` 挂同源 HTTP 路由 |
| 工具面读取 | `tools.view(undefined).knownNames` / `.visible`（**全局注册面**，与会话无关） |
| 上下文读取 | `systemPrompt.assemble()` 的 `contexts` / `sections` |
| 客户端 | React 组件注册到 `slots.register('settings.section', …)` |
| 配置持久化 | `$DSH_HOME/tool-manager.json`（UTF-8 JSON） |
| 构建 | 宿主半 `esbuild`（`scripts/build-host.mjs`）· 客户端半 `tsdown`（`tsdown.config.ts`） |
| 文案 | `locale/{zh,en}.json` 词条 |

## 架构：三方协作

```text
┌──────────────────────────┐        HTTP(同源)          ┌────────────────────────────┐
│ client 半                │  /tool-manager/api/tools   │ host 半                    │
│ 设置页「预设工具管理」   │ ◀────────────────────────▶ │ 枚举工具/上下文 + 读写配置 │
│ (React + settings.section)│  /tool-manager/api/config  │ (webServer prefix 路由)    │
└──────────────────────────┘                            └─────────────┬──────────────┘
                                                                      │ 写
                                                                      ▼
                                                       $DSH_HOME/tool-manager.json
                                                                      │ 读
                                                                      ▼
                                              ┌───────────────────────────────────────┐
                                              │ clean-agent 预设装配时                 │
                                              │ clean-tool-filter.mjs                 │
                                              │ → tools.restrict({ deny })            │
                                              │ → system-prompt/assemble 拦截 section │
                                              │ → context 名单过滤                    │
                                              └───────────────────────────────────────┘
```

**职责边界（改代码前先看这张表）**：

| 关注点 | 归属 |
|---|---|
| 工具/上下文的**枚举与展示**、批量交互、配置读写 | 本插件 |
| "哪些工具真的被挡" | 预设侧 `clean-tool-filter.mjs`（本插件不参与） |
| 生效时机 | **新会话**（预设装配期读配置；已开会话不变） |

## 目录结构

```
dsh-tool-manager/
├── cordis.patch.yml        # 组合包层：插入本插件的 loader 行（id 必须全 profile 唯一）
├── package.json            # name / exports / dsh{ bundle.patch, client } / scripts
├── tsconfig.json
├── tsdown.config.ts        # 客户端半打包配置（jsx → react/jsx-runtime）
├── src/
│   ├── index.ts            # host 半：HTTP API + 配置读写 + 枚举 + 来源分类
│   └── client/index.tsx    # client 半：设置页 React 组件（唯一的 UI 入口）
├── locale/
│   ├── zh.json             # 文案词条（中文）
│   └── en.json
├── scripts/
│   ├── build.sh            # 一键构建：host(esbuild) + client(tsdown)
│   └── build-host.mjs      # host 半 esbuild 驱动（从 DSH checkout 里解析 esbuild）
└── lib/                    # 构建产物（.gitignore 忽略，需自行构建）
    ├── index.js            # host 半产物
    ├── client.js           # client 半产物（__ModuleLoader__ 格式）
    └── types/*.d.ts
```

## 快速开始

### 前置要求

- 已安装可用的 **DeepSeek Harness（0.2.x）**，Web GUI 能正常打开设置页；
- 想发挥作用，还需要一个使用 `clean-tool-filter.mjs` 的**纯净预设**（如 clean-agent）—— 本插件与它通过同一份配置文件协作；
- 构建需要一份 **dsh 源码 checkout**（`DSH_CHECKOUT`），用于解析 `esbuild`。

### 安装（标准插件方式，推荐）

1. 把仓库放到你喜欢的位置，例如 `C:\Users\<你>\dsh-plugins\dsh-tool-manager`；
2. 在 profile 目录（`$DSH_HOME/profiles/<名字>/`，桌面版是 `desktop`）里做两件事：

   ```jsonc
   // package.json
   {
     "dependencies": {
       "@dsh-external/dsh-tool-manager": "link:C:/Users/<你>/dsh-plugins/dsh-tool-manager"
     },
     "dsh": { "profile": { "bundles": ["…", "@dsh-external/dsh-tool-manager"] } }
   }
   ```

   ```powershell
   # node_modules 里建立链接（pnpm/npm 亦可，手工 junction 等价）
   New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@dsh-external\dsh-tool-manager" `
            -Target "C:\Users\<你>\dsh-plugins\dsh-tool-manager"
   ```

3. **构建产物**（`lib/` 不入库）：见下节；
4. 重启 DSH → 设置 → **预设工具管理**。

> **为什么必须声明 `dsh.bundle.patch`**：profile 的 `bundles` 只负责"加载这个包"，真正让它以**标准插件**身份装配（出现在插件列表、有标题/描述、可启停）的是包自己的组合包层 `cordis.patch.yml`。缺了它，插件会以「幽灵 entry」形态存在 —— 设置页插件卡片会**显示异常且没有描述**，即便功能还能用。

### 备选：运行时注入

如果环境里装了 [dsh-super-injector](https://github.com/yjh051108/dsh-routing-suite)，也可以 `dev_inject_plugin <本插件目录>` 注入（适合开发调试，无需改 profile）。两种方式别同时用 —— 同 id 的 loader 行重复会让 loader 报错。

### 构建

```bash
# 需要一份 dsh 源码 checkout（含 node_modules/.pnpm/esbuild）
export DSH_CHECKOUT=/path/to/dsh-checkout

npm install
bash scripts/build.sh          # = node scripts/build-host.mjs + npm run build:client
```

- 只改 host 半：`node scripts/build-host.mjs`（需 `ESBUILD_PKG` 或 `DSH_CHECKOUT`）；
- 只改 client 半：`npm run build:client`（tsdown）。

> Windows 上 `scripts/build.sh` 需要 Git Bash / WSL；两半也可以各自单独跑，不依赖 bash。

### 验证生效

1. 设置 → **预设工具管理** → 能看到工具按 MCP / 第三方 / 原生分组列出；
2. 关掉某个第三方工具 → 打开一个**干净的新会话**（clean-agent 预设）→ 该工具不再出现；
3. `$DSH_HOME/tool-manager.json` 里出现对应的 `denyNames` / `denyPrefixes` 条目。

## 配置结构（`$DSH_HOME/tool-manager.json`）

`DSH_HOME` 缺省为 `~/.dsh`（`process.env.DSH_HOME || join(homedir(), '.dsh')`）。

```jsonc
{
  "denyPrefixes": [],      // 屏蔽：按前缀
  "denyNames": [],         // 屏蔽：精确工具名
  "allowPrefixes": [],     // 豁免：按前缀（优先级高于 deny）
  "allowNames": [],        // 豁免：精确工具名
  "denyContexts": [],      // 禁用的动态上下文
  "allowContexts": [],     // 显式启用的动态上下文
  "newDefault": {          // 三层「新增锁定」：新出现的内容默认启用/禁用
    "context": "enabled",
    "third": "enabled",
    "mcp": "enabled"
  },
  "configs": []            // 命名配置：{ name, state: { 上面六个名单 } }
}
```

优先级：`allow*` > `deny*`；`newDefault` 只影响"新出现"的条目，且不随命名配置切换。

## HTTP API（同源，挂在 dsh webserver 上）

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/tool-manager/api/tools` | 枚举当前寄存器中的全部工具（含 `category` 与 `group`） |
| `GET` | `/tool-manager/api/config` | 读当前配置 |
| `POST` | `/tool-manager/api/config` | 保存配置（六个名单 + `newDefault` + `configs`） |

工具来源分类（`category`）：`mcp`（`mcp__*`）· `native`（**官方宿主工具白名单**，当前为 `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource` / `load_workspace_dependencies`）· `third`（宿主层第三方插件注册，**未命中白名单者一律归此类**）· `unknown`（预留）。

> `native` 采用**白名单 + 兜底归 third**（2026-10-11 修正）。旧实现是"硬编码第三方前缀 + 兜底归 native"，任何没被列举的新插件工具都会显示成「原生 / 默认启用」，而纯净预设本该屏蔽它——分类错误的方向恰好是漏屏蔽。
> 另注：DSH 的原生工具（read/write/pwsh/glob…）由 agent preset 在**会话作用域**注册，不进入全局寄存器，因此本页整体看不到它们。

## 开发须知（踩过的坑）

1. **`settings.section` 的组件必须是 React 组件**。注册 `{ render() }` 形状的纯 DOM 组件会让该 section `active: false`、页面空白。本插件用 `.tsx` + JSX，由 tsdown 编译成 `react/jsx-runtime`；**不要**改成 `React.createElement` 全局名（运行时是 undefined）。
2. **插件身份三件套要一致**：`package.json` 的 `name`、`cordis.patch.yml` 的 `id`/`name`、`lib/index.js` 的 `export const name`。`id` 在整个 profile 组合里必须唯一。
3. **重命名插件**时，若宿主别处按名字引用它（例如工具归属映射表），要一并改：本仓库的 `src/index.ts` 里有一张"工具前缀 → 归属插件名"的映射表（`memory`、`dtodo`、`skill_manage`、`de_` → `dsh-memory-evolve-mod`），改插件名时记得同步。
4. **改动只对新会话生效**：过滤发生在预设装配期。
5. `lib/` 是产物目录且被 git 忽略 —— 克隆后先构建，否则 profile 装配会报"找不到入口"。
6. **判定逻辑只有一个真值来源**：工具/上下文的启停判定（`isEffectivelyDenied` / `needsAllowExemption` / `applyDeny` / `applyContextDeny` / `contextEnabled`）都在 `src/client/decide.ts`，且前缀表必须与 `clean-tool-filter.mjs` 的常量逐字一致——`tests/decide.test.mjs` 里有一条一致性断言守着。改名单时三处（filter / host / decide）要同时改。
7. **「启用」必须真的能启用**：`needsAllowExemption()` 的判定范围必须覆盖判定链里所有"兜底分支"（`mcp__`、`THIRD_PREFIXES`、自定义 `denyPrefixes`），否则点「启用」只从 `denyNames` 移除、不写 `allowNames`，工具会被兜底继续屏蔽——表现为"单独启用某个工具却用不了"（2026-10-11 已修，见 `tests/decide.test.mjs` 的回归与对照组）。
8. **上下文开关会被 persona 架空**：若目标预设的 persona 配了 `includeRuntimeContext: false`，persona 会调用 `ctx.systemPrompt.suppressRuntimeContext()`，官方语义是"**该作用域内的 context provider 一律不求值、装配监听器加进来的上下文被丢弃**"。此时本插件写多少 `allowContexts` 都没用（2c 拿到的永远是空数组）。要按名字治理上下文，必须把预设的 persona 设为 `includeRuntimeContext: true`，让 `clean-tool-filter` 的 2c 成为唯一的上下文屏障。
9. **`tools.restrict()` 要求 agent 作用域**：在 DSH 0.2.1-alpha.1 上于非 agent 作用域调用会抛 `tools.restrict() requires a scoped context (agent.ctx)`。预设 standing scope 内可用，顶层装配不可用。

## 常见问题

| 症状 | 原因 / 处理 |
|---|---|
| 设置页插件卡片显示**异常**且没有描述 | 缺 `dsh.bundle.patch`（幽灵 entry）→ 补 `cordis.patch.yml` 并在 `package.json` 里声明 |
| 设置里**找不到**「预设工具管理」 | 插件没装配（`bundles` 里没列 / 没建链接 / `lib/` 未构建）；重启 DSH 后看插件列表 |
| 页面**空白** | section 组件不是 React 组件（见"开发须知"第 1 条） |
| 关了工具但纯净会话里**还在** | 改动只对新会话生效；另外确认预设侧 `clean-tool-filter.mjs` 已装配并读同一份 `tool-manager.json` |
| 新装的 MCP 工具自动出现在纯净会话 | 把「新增锁定 → MCP」设为"新增禁用"，或手动勾选禁用 |
| 上下文明明**勾了启用**，纯净会话里却没有 | 预设 persona 配了 `includeRuntimeContext: false`（见"开发须知"第 8 条）——persona 的整体抹除优先于按名开关 |
| 单独点「启用」某个工具，纯净会话里**还是用不了** | `needsAllowExemption` 的覆盖范围与判定链不同步（见"开发须知"第 7 条） |
| 某个第三方工具被显示成「DSH 官方宿主工具」 | 该名字不在 `NATIVE_HOST_TOOLS` 白名单里才可能发生；新插件的工具默认归 `third`，若显示成 native 说明 host 侧 `classify()` 未更新（`npm test` 里的 `classify.test.mjs` 会拦住） |

## License

BSD-3-Clause
