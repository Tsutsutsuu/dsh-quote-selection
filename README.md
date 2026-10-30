# dsh-quote-selection（选区引用）

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![test](https://github.com/Tsutsutsuu/dsh-quote-selection/actions/workflows/test.yml/badge.svg)](https://github.com/Tsutsutsuu/dsh-quote-selection/actions/workflows/test.yml)

> 一个 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai) 插件：在对话里框选文字，右键就能带着出处引用它。

在 DSH 对话界面里框选一段文字，右键「引用选中文字」，这段原文就会**以一个标签（chip）的形式**进入输入框；
发送后，消息里显示为一张可展开的引用卡。

界面上以**内容为主**：标签和卡片只写「作者 + 内容预览 + 字数」，完整出处（轮次、段落、字符区间）
留在悬停提示、发送文本和会话日志里 —— 模型始终拿到完整引用块。

## 用法

1. 在对话正文（聊天视图）里用鼠标框选一段文字 —— 助手回复、你自己的消息、代码块、列表都可以。
2. 在**选区上**点右键，弹出白色小菜单：`复制`（右标 `Ctrl+C`）、`引用`（右标 `Ctrl+Q`）。
   也可以直接按快捷键：选中文字后 `Ctrl+Q` 直接引用，不弹菜单（`Ctrl+Shift+Q` 同样有效；macOS 用 `⌘⇧Q`）。
3. 点「引用」，输入框里出现一个标签：

   ```text
   ❝ 它把 location 写进了 wire 文本里，…   42 字 · 助手消息
   ```

   标签是原子节点：光标跨过它是一步，**删除它是一整步**（Backspace 一次选中，再一次删掉），不用逐字删。
   字数与预览同字号（chip 的文字由宿主渲染成一个文本节点，无法在同一行里做不同字号）。
4. 在标签后继续写你的问题，一起发送。
5. 发送后，消息里显示折叠卡片（内容普通字号，字数与作者小字重，箭头可展开）：

   ```text
   ❝ 它把 location 写进了 wire 文本里，…        124 字 · 助手消息  ▸
   ```

   点它展开被引用的原文，再点收起。鼠标悬停在标签/卡片上可看到完整出处。

## 两种表面，同一份文本

| 表面 | 显示 | 说明 |
| --- | --- | --- |
| 输入框 | 一个 chip（作者 + 内容预览） | chip 的文本投影是完整引用块，所以复制草稿得到全文、提交也是全文 |
| 消息 | 折叠的引用卡（作者 + 内容预览 + 字数） | `conversation.user.text.node` 渲染器，点击展开原文 |
| 模型 / 会话日志 | 完整引用块（含完整出处） | 普通用户消息文本，没有任何私有事件或旁路存储 |

也就是说：**折叠只发生在显示层**。模型读到的、日志里存的、复制出来的都是同一份带出处的全文，
所以 fork / 恢复 / 重放 / 搜索都不会丢引用内容。

发送时的文本形态（提示词里约定的格式）：

```text
【引用 · 助手消息 · 第12轮 · 第2/5段 · 字符124–168】
被引用的原文（保留换行，去掉首尾空白）
【/引用】
```

## 出处是怎么算出来的

全部从聊天界面本身推导，不读会话存储、不订阅事件。下面这些字段只在**发送文本**和**悬停提示**里；
界面上的标签/卡片只显示第一列的「作者」与内容预览：

| 字段 | 来源 |
| --- | --- |
| 助手消息 / 用户消息 / 工具调用 … | 聊天行上的 `data-chat-flow-kind` |
| 第 N 轮 | 聊天行上的 `data-chat-turn` |
| 第 a/b 段 | 选区起点所在内容块在其兄弟块中的序号 / 块总数（段落、列表项、代码块、表格行…） |
| 字符 x–y | 在所在块内的字符区间；纯文本气泡退回为 `消息内字符 x–y` |

选区跨越多条消息时会额外标注 `选区跨多条消息`。单条引用超过 4000 字符会截断并注明。

## 实现要点

- `client.js` 注册三处：
  - `shell.overlay` → `quote-selection-menu`：右键菜单本身。只接管「选区非空 + 右键落在选区字形上 + 选区在消息行内」的情形，其余右键一律放行。
  - `conversation.composer.dock` → `quote-selection-bridge`：取 `inputActions.captureInsertion()` 的 span，再经
    `ctx.get('conversation').input.shell(sessionId).insertReference(...)` 插入引用 chip；拿不到 shell 时退回
    `inputActions.insertText(...)` 插纯文本，功能不中断。
  - `conversation.user.text.node`（key `quote`）→ `QuoteText`：把消息里的引用块渲染成折叠卡；
    配套的 `ctx.uiConversation.userText.register()` 规则只认 `【引用 · …】…【/引用】` 这一种标记。
- chip 的 `source` 是本插件自己的名字，`appearance` 借用 `session`（聊天气泡图标）；`label` 只放位置摘要，
  而 `ref` 和 `clipboardText` 都是完整引用块 —— `ref` 承担"提交时的模型文本"，所以草稿被持久化、重载、
  恢复之后仍然能正确发送。
- **提交序列化**：宿主提交时会对每个 chip 调用 `inputTriggers.serializeReference(source, ref)`，
  按 source 找注册在 `inputTriggers` 里的来源并用其 `codec.serialize(ref)` 替换该段文本；
  找不到 codec 会直接拒绝整条提交（`slash: no serializer for reference source "…"`）。
  因此插件注册了一个没有菜单的来源（`trigger` 用不可输入的 `\u0000`，`candidates` 返回空），
  其 `codec` 是恒等的：把 `ref` 原样当作模型文本返回。旧版遗留的 chip（`ref` 只是 `quote-xxxx`）
  没有可发送的正文，序列化时返回空串并在控制台告警，不会让整条消息发送失败。
- `index.js` 注册一条系统提示段落（`local:quote-selection`，order 950，紧跟 `FILE_REFERENCE`，
  `interpolate: false`）。它是一段刻意压到 400 字符左右的约定，只讲四件事：块是客户端写的（不是用户手打）、
  标记之间是用户逐字选中的上文、把它当作指代对象而不要当新指令、不要复述标记且引用优先于模型自己的记忆。
  宿主端没有工具、事件或存储。

## 设置

**设置 → 选区引用**（Settings → Quote selection）里可以调：

| 选项 | 默认 | 作用 |
| --- | --- | --- |
| 草稿标签预览字数 | 12 | 输入框标签里显示引用内容的前 N 个字符（4–80） |
| 消息卡片预览字数 | 40 | 消息里折叠引用卡的前 N 个字符（4–80） |

这些都是纯显示偏好：存在浏览器本地（`localStorage`，key `dsh-quote-selection/settings-v1`），改完立即生效、
不用重启；换机器或清浏览器缓存会回到默认值。它们不进入会话日志、不影响模型看到的内容。

## 已知限制

- 标准**聊天视图**用 `[data-chat-flow-key]` 定位消息行；`dsh-better-display` 的「阅读」视图走**机会性兼容**：
  识别它的 `[data-reader-anchor]` / `[data-reader-turn]`（以及官方节点上的 `data-chat-flow-kind`），
  可以正常引用，位置信息尽量给到角色与轮次；最差退化为「消息」+ 无轮次。
  连行标记都找不到时退回 transcript 滚动容器，**引用本身仍然可用**，只是位置信息变泛。
- 阅读视图的角色推断依赖它自己的 DOM 约定（`data-reader-answer` / `data-reader-reasoning-card` /
  `data-reader-tool-call`，以及"本轮第一个锚点是用户消息"）。该插件未来改标记时，
  这里最坏情况是角色退化成「消息」，不影响引用与发送。
- **阅读视图里的折叠显示**走它的 `dsh-better-display.block` 链：含引用块的用户消息会被本插件按块内切分
  重新渲染 —— 引用块变成折叠卡，同一段里你手打的文字按纯文本显示（这条消息因此失去阅读视图的 markdown
  排版）；不含引用的消息不受影响，仍由阅读视图自己渲染。
- 草稿 chip 的悬停提示只有位置摘要，不是全文（宿主 chip 的 title 就是 label）——发送前后都可展开消息查看原文。
- 输入框处于提交中/不可编辑状态时插入 chip 会失败，此时退化为「复制到剪贴板」并提示。
- 队列中的待发消息预览也走同一套折叠渲染，长引用在窄预览里可能被省略号截断。

## 目录结构

本目录就是插件包根目录，profile 以 `link:` 方式安装它：

| 路径 | 作用 |
| --- | --- |
| `index.js` | 宿主端：注册系统提示段落（`local:quote-selection`，order 950） |
| `client.js` | 浏览器端：右键菜单 / 输入框 chip / 消息折叠卡 / 设置页 / 提交序列化 |
| `cordis.patch.yml` | bundle patch，插入 `quote-selection` 行 |
| `locale/`、`icon.svg` | 插件管理页的标题、描述与图标 |
| `tests/quote-helpers.test.mjs` | 纯逻辑单测（位置测量、格式化、标记解析、快捷键判定） |
| `tools/` | 开发辅助：从 app.asar 抽包、静态引用审计 |

跑测试：`node --test tests/quote-helpers.test.mjs`
跑审计：`node tools/audit-references.mjs`（检查未使用的常量 / CSS 类 / 文案 key，以及中英文案对齐）

## 安装 / 卸载

要求：DSH 桌面版或 `dsh` CLI（带 `plugin_manager`），Node.js ≥ 20。

```text
git clone https://github.com/Tsutsutsuu/dsh-quote-selection.git
plugin_manager install_bundle  target = <上面 clone 下来的目录>
```

卸载：

```text
plugin_manager remove_bundle   target = dsh-quote-selection
```

> 本地目录安装是**链接**安装：目录被移动或删除后插件随之失效（需重新安装）。
> 改 `client.js` 后浏览器端需要刷新页面（必要时重启 DSH）才会用上新代码；
> 改 `index.js`（提示词）后需要把 bundle 禁用再启用一次，宿主端才会重新 apply。

## 开发

```text
npm test      # node --test tests/quote-helpers.test.mjs
npm run audit # 检查未使用的常量 / CSS 类 / 文案 key，以及中英文案对齐
```

CI：每次 push / PR 会在 Node 20 / 22 / 24 上跑单测与引用审计（`.github/workflows/test.yml`）。

## 许可证

[MIT](LICENSE) © Tsutsutsuu
