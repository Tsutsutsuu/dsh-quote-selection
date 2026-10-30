# 测试清单（选区引用 v2：标签 + 折叠卡）

v2 改动：引用不再往输入框里灌一大段文字，而是插入**一个 chip**；发送后消息里显示**可展开的引用卡**。
模型/日志仍然是完整引用块（只是不铺在界面上）。

已确认（宿主端与客户端注册，来自活的检查接口）：

| 检查项 | 结果 |
| --- | --- |
| 安装状态 | `enabled: true`，宿主行 `include:quote-selection` active |
| `shell.overlay` | `quote-selection-menu` active |
| `conversation.composer.dock` | `quote-selection-bridge` active |
| `conversation.user.text.node` | key `quote`，priority 100，active（说明新模块已被页面加载） |
| 引用来源 codec | `inputTriggers` 来源 `quote-selection` 已注册（该注册在 menu / 渲染器之前，后两者 active 即证明 apply 全程无异常） |
| 系统提示段落 | `local:quote-selection`（order 700）在组装结果中 |
| 设置页 | `settings.section` → id `quote-selection`，order 26，active |
| 纯逻辑单测 | 20 项通过（位置测量 / 块序号 / wire 格式化 / 预览压平 / 标记解析 / 序列化 / 阅读视图定位 / 快捷键判定） |

界面上的视觉与交互由你手动确认。

## 1. 菜单

- [ ] 助手回复里框选半句话，在选区上右键 → 出现白色小菜单，两行：`复制`（右侧 `Ctrl+C`）、`引用`（右侧 `Ctrl+Q`）。
- [ ] 你自己的消息里框选 → 同样能出菜单。
- [ ] 代码块、列表项里框选 → 都能出菜单。
- [ ] 右键点在选区**外**、输入框、侧栏 → 不出菜单（走原生行为）。
- [ ] 靠近窗口右下角时菜单不溢出。
- [ ] 选中文字后按 `Ctrl+Q` → **不弹菜单**，引用直接进输入框；`Ctrl+Shift+Q` 同样有效。
- [ ] 在输入框里选中文字按 `Ctrl+Q` → 不触发（不应误引用消息）。
- [ ] 没有选区时按 `Ctrl+Q` → 无反应。

## 2. 输入框里是标签，不是一段文本

- [ ] 点「引用」→ 输入框出现**一个 chip**，形如
      `❝ <内容开头>…   42 字 · 助手消息`，而不是多行长文本，也不再显示轮次/段落。
- [ ] 鼠标悬停在 chip 上 → 提示里仍能看到完整出处（`助手消息 · 第12轮 · 第2/5段 · 字符x–y`）。
- [ ] 光标可以一步跨过 chip；在 chip 后面输入文字正常。
- [ ] 在 chip 前按 Backspace → 整个 chip 被选中，再按一次整块删除（不会逐字删）。
- [ ] 连续按 Ctrl+Z：一次撤销整块引用（一次 undo 一步）。
- [ ] 草稿里已有文字时引用 → chip 插在光标处，原文字不丢。
- [ ] 全选草稿复制（Ctrl+C）→ 剪贴板里是**完整引用块**（带 `【引用 · …】` 和原文），不是只有摘要。
- [ ] 引用后直接发送 → 发出的消息里能看到引用内容（不是空消息）。

## 3. 消息里是折叠卡

- [ ] 发送后，你那条消息里显示一个小卡片：`❝ <内容开头>…` + 小字 `124 字 · 助手消息` + 箭头。
- [ ] 点它 → 下方展开被引用的原文，再点收起。
- [ ] 展开状态下选中卡片里的文字 → 可以正常选择/复制。
- [ ] 消息预览/队列里（如果发送时 agent 正忙）也是折叠形态。

## 4. 「阅读」视图（dsh-better-display）

- [ ] 切到「阅读」视图，框选助手回答里的文字 → 右键出现同样的菜单。
- [ ] 引用后插入的 chip / 发送后的卡片内容正常；
      悬停 title 里能看到位置（期望是 `助手消息 · 第N轮 …`，最差是 `消息`）。
- [ ] 在阅读视图里框选**你自己**的消息 → 角色应显示「用户消息」（靠"本轮第一个锚点"推断）。
- [ ] 阅读视图里框选折叠过程区（工具调用）→ 能出菜单；角色可能是「工具调用」或泛称「消息」。
- [ ] 阅读视图里，**含引用块的消息**显示成折叠卡；「文字 + 引用」混排时文字照常显示（纯文本）、引用单独成卡。
- [ ] 不含引用的消息在阅读视图里保持原样（排版不受插件影响）。

## 5. 端到端：模型理解

- [ ] 发一条只含 chip + 「这段你解释一下」→ 模型针对被引用的内容回答。
- [ ] 引用后写「这里说错了」→ 模型把「这里」指到引用内容。
- [ ] 让模型「把刚才那条消息原样贴出来」→ 能看到完整 `【引用 · …】…【/引用】` 与位置信息（证明折叠只在显示层）。

## 6. 设置页

- [ ] 设置 → 左侧出现「选区引用」；点进去有两行可调（草稿标签预览字数、消息卡片预览字数）+ 一行快捷键说明。
- [ ] 把草稿标签预览字数改成 6 → 再引用一次，标签只显示 6 字 + `…`。
- [ ] 把消息卡片预览字数改成 8 → 已存在的消息里引用卡预览**即时**变成 8 字（不用刷新）。
- [ ] 刷新页面后设置仍保留（存在 localStorage）。

## 7. 出问题时怎么查

1. 发送时报 `slash: no serializer for reference source "quote-selection"` → 页面还在跑没有 codec 的旧模块：
   刷新页面（Ctrl+R），仍不行则重启 DSH。
2. 行为像 v1（一大段文本进输入框）而不是 chip → 同上，旧模块。
3. 输入框里是 chip 但发送后消息里没折叠 → `conversation.user.text.node` 的 `quote` 渲染器没生效，看 Console。
4. 如果输入框里留着**上一个版本**插入的引用标签：它的 `ref` 只存了 id、没存全文，发送时会被跳过
   （控制台 `stale quote chip without stored text`）。删掉它重新框选引用一次即可。
5. Console 关键词：
   - `slot entry crashed in 'shell.overlay'` / `'conversation.user.text.node'`：组件渲染抛错；
   - `slot entry crashed in 'conversation.composer.dock'`：bridge 崩了；
   - `[quote-selection] composer insert failed` / `no composer shell for this session`：chip 插入失败（会退化为纯文本插入）；
   - `[quote-selection] stale quote chip without stored text`：旧格式 chip；
   - `[ui-conversation] user-text transformation failed`：匹配规则抛错（原文会照常显示）。
6. 停用 / 删除：
   `plugin_manager set_bundle target=dsh-quote-selection enabled=false`，
   `plugin_manager remove_bundle target=dsh-quote-selection`。
7. 想确认引用确实是普通消息内容：查该条 `user/message` 事件的文本，没有新增事件类型。
