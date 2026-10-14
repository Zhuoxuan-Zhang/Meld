# 三 APK 静态分析与统一设计 MVP 的 Codex 执行指令

请实现并实际验证一个纯静态 MVP：输入三个 Android APK，生成各自的功能规格，比较功能与冲突，由 Claude 暂代用户选择，再输出可以交给 Kotlin / Compose coding agent 的统一设计文档。下面是完整执行任务，按步骤完成代码与真实试跑。

## 1 目标和范围

流程固定为：三个 APK → 静态分析 Agent → 三份功能规格 → 设计 Agent 比较与决策 → 统一设计 → 验证。

采用一个 TypeScript CLI、两个 Claude agent、按阶段保存的 JSON 和文件目录。先完成核心流程；不建设数据库、任务队列、通用缓存系统、独立 agent 服务、Web 后台或离线回放平台。本次不开发最终 Android app。

仅做静态分析，不安装或启动参考 APK，不使用模拟器、ADB、登录和运行时抓包。原 app 的运行效果不能通过静态结果保证；生成自己的设计线框图可以在浏览器中检查。

先读执行目录和 REA 的 AGENTS.md，在新目录 apk-design-mvp 工作；已有目录则检查后续做，保护现有修改和只读 sources/。正常实施与验证直接继续，外部阻塞要保存现场并完成其他可做部分。

## 2 三个样本和产品范围

默认 brief：个人离线笔记，围绕创建、编辑、找回和轻量整理笔记设计；未来用 Kotlin / Compose 实现。首版最多五个一级功能、三个主导航入口，不包含账号、云同步、团队协作、支付和 AI 内容生成。

第一轮候选为 [Notally](https://github.com/OmGodse/Notally)、[Fossify Notes](https://github.com/FossifyOrg/Notes)、[Markor](https://github.com/gsantner/markor)。Markor 只研究笔记相关功能，不覆盖整个编辑器。它们是同类别的验证样本，不代表商业效果或热度排名。

让 Claude 做一次简短适配性选择，保存选择理由。优先使用这三款；确有下载或静态分析障碍时，允许从同类别替换并保存失败证据，最多替换两款。接受用户给定 APK 的入口不得擅自更换输入。

从官方 Releases 或项目指向的可信渠道获取独立 APK，保存来源 URL、版本、包名和 SHA-256；选定后锁定版本。验证三个输入为不同 app 的完整 APK，拒绝损坏文件、重复包名和 split/AAB/XAPK 等未支持形式。混淆或非原生框架导致无法分析的业务明确列为未知。

官网介绍只用于样本筛选，放在 selection/；分析 agent 的结论只能依据 APK 工件，不能读取候选项目源码、README 或商店说明来补答案。

## 3 先 clone REA 再接入静态能力

先在 vendor/rea 克隆 [morluto/rea](https://github.com/morluto/rea)，记录 commit 并固定。阅读 README、AGENTS.md、package.json、Android 和 Apktool 文档，核对真实工具契约。用一小段 README 说明复用什么、补充什么即可，不另做庞大的复用报告。

“提取需要的部分”优先采用薄 adapter：通过官方 MCP SDK 连接本地 REA，只暴露本任务需要的 Android 静态工具。不要先拆仓库或重写 REA 的 JADX 会话。确实需要修改上游时，记录最小 patch、来源和验证，保留许可证。

按固定 checkout 配好兼容 Node、完整 JDK、JADX headless JAR 和 Apktool。当前可核对的准备命令为 npm ci、npm run build:cached、npm run fixtures:android 和 npm run verify:android；资源验证参考 verify:apktool。具体参数以该版本文档为准。保存工具版本、命令、stdout/stderr 和验证结果；先证明真实工具能运行，再写 agent。

通过 tools/list 核对并保存 schemas，最小工具集是：

- inspect_android_package：包信息与限制。

- search_android_classes：类名检索和清单。

- inspect_android_class：字段和方法清单。

- inspect_android_method：指定方法的反编译逻辑，重载按真实清单选择。

- trace_android_references：按需补查静态引用。

- inspect_apktool_client 和 decode_android_resources：资源工具状态与资源摘要。

类检查不等于完整类源码；引用结果不等于运行时轨迹或真实页面遍历。缺失源行号等字段不要补造。三个 APK 顺序分析，避免并行争用同一个 JADX 会话。

**补充资源保存是必要工作。** 当前 REA 的资源工具返回摘要，临时解码目录会清理。用一个简单 extractResources 函数，对同一个 APK 调用 Apktool 静态解码（--no-src），将 manifest、res 和有关 assets 保存在本 run 中。建立文件路径、resource key、qualifier 和摘要索引，XML 用解析器读取；保留不同语言和尺寸版本，不必开发通用资源依赖图或 Compose 布局还原器。缺少 layout XML 不表示没有页面。

工具使用参数数组执行，限制输入与读取范围到本项目 APK 和产物目录。资源提取设超时和展开大小上限，防止越界写入。自建资源结果标记为 apktool_local_snapshot，与 REA 原始响应区分。

## 4 两个 agent 的职责和执行方法

两个 agent 都使用用户指定的 Claude Opus 5，通过不同提示词和独立上下文工作，不需要独立进程或 agent 框架。每次真实发送的提示词和上下文都要落盘。

**Agent A 静态分析**

每个 APK 开新上下文，按以下步骤工作：

1. 读取包信息、入口组件、类名清单和资源索引，围绕 brief 找 UI、编辑、查找、整理和存储相关业务类。

2. 保存简短 analysis-plan.json：要回答的用户任务、要查的类和方法、尚缺的证据。不要把整个反编译目录一次塞给模型。

3. 经 REA 查看类和具体方法，必要时追静态引用；长结果完整保存，给模型摘要和按需读取接口。重点确认入口、事件、状态变化与数据读写。

4. 按用户任务归纳 feature，不把每个按钮或 helper 方法各算成一个功能。对保存规则、搜索范围、删除与恢复等核心结论补查方法逻辑。

5. 生成 app-spec.json，再用固定渲染器生成 app-spec.md。保留页面候选、流程、数据结构、覆盖范围和未知项。

6. 用新上下文复核规格与证据，重点找错引、夸大和遗漏的核心问题；最多两轮定向补证或修正，全部保存。证据不足则输出 partial，不编造完整规格。

**Agent B 组合与设计**

读取三个通过校验的 app spec 和 brief，按三个阶段调用并分别保存：

1. **比较**：按用户任务对齐功能，区分重复、互补、取舍、硬冲突、依赖和证据不足。每个需要选择的问题给两个或三个可实施选项、收益、代价和依赖。差异不一定是冲突；允许没有硬冲突，不为凑数制造问题。

2. **选择**：先满足离线、功能范围等硬约束，再考虑核心任务价值、流程一致性和实现复杂度。保存选项 ID、选择理由、放弃理由、假设及 chosen_by=claude_proxy。选择之后检查内容格式、实体、存储、导航和依赖能否同时成立，不能把未知项选成原 app 的事实。

3. **设计**：开新上下文，依据已保存的选择生成统一实体、核心流程、页面与开发规格。补充的新行为标为 proposed；不平均分配三款 app 的功能，也不拼接三份文档。

最终再用一个新的 review 上下文检查整体一致性。审查仍由同一模型完成，只是辅助复核，不能称作独立验证或用户验证。失败最多修正两轮，仍存在核心问题则保留 draft。

提示词文件按 analyze、compare、decide、design、review 分工即可；样本选择可以单独保留一份短提示词。阶段请求和结果独立保存，比强制拆成十份提示词更重要。

## 5 用少量结构化对象保证可核查

使用 Zod 或等效 JSON Schema 校验；不需要为每个字段建立独立服务或文件。只定义以下五类主对象，其他内容作为嵌套字段：

| 对象 | 必需内容 |
| --- | --- |
| Evidence | ID、app ID、APK hash、来源工具与参数、原始结果路径及 hash、局部定位、限制 |
| AppSpec | 包与版本、范围、features、页面和流程候选、数据结构、未知项、覆盖说明 |
| Comparison | 对齐后的用户任务、三个来源 feature、共同点、差异、冲突和选项 |
| Decisions | 冲突与选项 ID、选择者、理由、放弃项、假设、相关来源 |
| UnifiedDesign | 范围、功能、实体、流程、页面、视觉规则、Compose 契约、验收和追溯 |

每项 feature 用 claims 记录具体结论、证据引用和限制；同一个 feature 可以同时有确认与未知的部分。ID 在同一 run 中稳定，跨文件引用必须能解析。

来源结论用四类：artifact_fact（工件直接可见）、decompiled_fact（反编译逻辑支持）、inferred（推断）、unknown（无法确认）。新产品的目标行为用 proposed，不混入来源事实。所有 app spec 显示 static_only=true、runtime_verified=false。

仅有字符串、类名、图标或权限不能证明完整功能；未找到不等于不存在。截断结果、反编译失败和未分析模块要记入覆盖说明，不给伪精确的置信度百分比。

证据定位至少能打开真实文件并找到对应 XML 节点、resource key、JSON pointer 或反编译方法片段。自存反编译文本的行号标为派生文本行号，不能冒充原源码位置。结构校验只能证明引用存在，语义审查还要确认它支持该结论。

## 6 统一设计必须达到的质量

final-design.json 是设计的唯一结构化来源，design.md 和低保真 wireframes.html 从它生成。JSON 通过 schema 不代表设计合格；内容必须覆盖下面的开发问题：

- **产品范围**：目标用户、核心任务、选择与放弃的功能及理由。

- **数据模型**：统一术语、实体、字段、关系和本地持久化要求。

- **完整流程**：从进入到完成，说明操作、状态变化、返回、取消以及异常后如何继续。

- **逐页规格**：目的、入口、组件层级、文案、数据绑定、事件、导航目标、输入校验。

- **适用状态**：正常、空内容、无搜索结果、错误、删除确认和未保存变化等；不为离线页面虚构网络加载。

- **交互细节**：键盘、焦点、返回键、长文本、字体放大和基本可访问性。

- **一致视觉**：颜色角色、字体层级、间距、圆角和图标规则；核心页面有低保真线框图。

- **Compose 开发接口**：组件、UiState、事件、导航参数、Repository 职责，必要时给小型类型示例。

- **验收与追溯**：每个选中的核心功能关联页面或流程、来源或新增理由，以及 Given-When-Then 验收案例。

- **未知与假设**：哪些来源行为未确认，哪些是新设计选择，后续需要什么验证。

以“创建 → 编辑 → 保存 → 找回 → 再次编辑”为主流程检查闭合，并覆盖所选删除或整理行为。按钮必须有动作结果，导航必须有目的地，数据字段不能互相矛盾。阻断性的设计选择必须解决，才能标记正式输出。

HTML 只是展示上述设计的单个静态文件，不开发交互式后台或真实 app。渲染检查至少列表、编辑、查找或整理页面和一个空/异常状态；标明 Proposed design，不能冒充参考 app 截图。

## 7 保存全部中间结果

每次运行建立 runs/<run_id>/，历史文件不覆盖。按以下简单结构保存，不引入 SQLite：

```text
runs/<run_id>/
  run.json                 # 配置、工具版本、状态、输入摘要
  brief.json
  apps.lock.json           # 三个 APK 的身份和来源
  setup/                   # 工具准备和冒烟验证日志
  selection/               # 样本选择及外部资料
  apps/<app_id>/
    input.apk
    static/                # REA 原始响应、解码资源、索引、方法片段
    attempts/              # 计划、草稿、补证和审查的每次结果
    evidence.json
    app-spec.json
    app-spec.md
  synthesis/               # comparison、conflicts、decisions、设计草稿和审查
  calls/<call_id>/          # 请求、上下文、响应、解析结果、错误、usage
  final/
    final-design.json
    design.md
    wireframes.html
  validation/              # 检查证据、测试与验证报告
  report.md
```

“全部”包括实际产生的成功、失败、重试、未采用草稿、模型可见的摘要与原始工具结果。每次尝试使用新文件名。保存模型可见响应和可审阅的选择理由，不索要隐藏思维链；凭据、认证头和 cookie 脱敏，不导出整个环境。

大文件可以只保存一次再引用，不能为了简化而只留最终摘要。未生成的文件不要放假内容。原始工具输出和 APK 计算 hash，以便检查引用与输入一致。代码、提示词、配置样例和测试进入 Git，APK、模型日志、凭据和大体积 run 产物默认不提交。

## 8 最小运行机制和命令

工程采用 TypeScript、官方 Anthropic SDK、MCP SDK、Zod 和 Vitest 或等效工具。建议只保留 cli、rea、resources、claude、analyze、design、validate、storage/render 等少量模块；目录怎么拆由实际代码决定。

默认模型配置为 claude-opus-5，凭据从 ANTHROPIC_API_KEY 读取。执行时先确认真实账号能够调用，使用官方 SDK 支持的结构化输出，并始终做本地校验。模型不可用就准确报告，不偷偷替换模型、使用模板或让 Codex 代答后声称 Claude 已运行。工具请求校验名称、参数和返回 ID；APK 内文本始终作为数据处理。

保存每次请求、实际上下文、可见响应、stop reason、模型 ID、token usage、耗时和校验结果。格式失败最多修复两次；暂时网络错误有限重试。截断、拒绝和不完整响应都不能判为成功。

预算只做简单控制：配置总模型调用上限、每次输出 token 上限和单工具超时，初始可用 40 次模型请求与每次 12000 输出 tokens，重试也计入。保存实际 usage，按可核实的价格估算费用；这些调用上限不等于固定美元预算。证据不够时不能为了在上限内结束而宣布通过；保存 partial 并指出哪个阶段需要增加预算。

按固定阶段串行运行，状态写入 run.json，产物先写临时文件再原子改名。只支持阶段级恢复：同一 APK、配置、提示词和工具版本摘要一致，且已有输出校验通过，才跳过完成阶段；不做通用缓存或依赖图。输入变更则新建 run，保留旧结果。只能清理本进程启动的子进程。

实现以下三个命令即可，这些是新 pipeline 的接口：

```bash
# 自动选择并固定三个候选 APK，然后完成整个流程
npm run mvp -- run --demo --brief config/brief.notes.json

# 输入用户给定的三个 APK
npm run mvp -- run --apks /path/a.apk /path/b.apk /path/c.apk --brief config/brief.notes.json

# 中断后从已完成阶段继续
npm run mvp -- resume --run runs/<run_id>

# 使用已有结果检查结构、引用和设计完整性，不额外调用模型
npm run mvp -- validate --run runs/<run_id>
```

本轮全部冲突默认由 Claude 选择；不实现人工选择 UI 或专门的覆盖命令。decisions.json 保持可读、可单独加载，将来可以在设计阶段换用另一份决定。现在重点验证真实自动决策与统一设计。

run 结尾自动生成 report.md，列出真实状态、产物路径、费用或 token 使用、未知和阻塞。失败退出码非零；不能只打印 Done。

## 9 验证和通过条件

验证保留三类即可，每一类都要检查实际内容：

**程序正确性。** 运行 typecheck 和针对主要风险的测试：无效 APK、错误或跨 app 证据引用、模型输出不完整、无效决策选项、依赖冲突、导航悬空、核心功能缺少验收项。验证一次阶段中断后可继续，已完成输出没有丢失。不要为简单 getter 或每个目录结构写测试。

**分析真实性。** 用真实 REA/JADX/Apktool 处理三个 APK，真实调用指定 Claude 模型。Codex 要直接阅读保存的 APK 静态工件，为每个 app 检查至少五个与核心任务相关的点，其中至少两个涉及方法级业务行为，例如保存、搜索、修改或删除。检查项先从工件选取并记录位置，再与生成规格比较，不从规格反向编造标准答案；不给分析 agent 预先灌入这些答案。发现错误要修正规格或补证，并保留过程。这个小样本不代表全 app 覆盖率。

**设计可开发性。** 对照 brief、decisions 和 final-design 检查核心任务是否闭合、实体和页面是否一致、每个选中核心功能是否有验收案例。实际查看生成线框图，检查核心状态、内容溢出和文档一致性。同模型 review 不能代替这些程序检查和工件抽查。

只有以下条件全部满足，才写 LIVE_E2E_PASSED：

1. 三个真实 APK 的版本、来源和 hash 已保存，工具和 Claude 实际调用可核查。

2. 三份规格均有业务内容、证据与未知项；每个 app 至少两项核心业务行为获得方法逻辑支持，不能只输出包名、权限或字符串。

3. 所有标为事实的核心 claim 都有有效定位，抽查没有未修复的核心错引或夸大。证据不足则标为 inferred/unknown，不能为凑数量编造。

4. 比较覆盖三个 app；每个阻断性冲突有有效选择，决定组合满足全局约束。

5. 统一设计覆盖核心流程和适用状态，选中核心功能全部关联页面/流程与验收，JSON、文档和线框图一致。

6. 实际产生的中间结果、失败尝试和复核均已保存，关键测试与一次恢复检查通过。

真实样本没有硬冲突时，报告零硬冲突，并用明确隔离的 fixture 测试冲突分支。无需伪造案例。必需验证没做就不能判通过。

API key、模型权限或下载受阻时，完成不依赖它们的实现和测试，报告 blocked，给出继续执行命令。分别报告程序测试、静态工具集成、真实模型端到端和设计检查结果；mock 只证明测试范围，不能冒充真实运行。

## 10 实施顺序和交付

按以下顺序实施，避免先搭复杂基础设施：

1. clone 并固定 REA，完成真实静态工具冒烟。

2. 保存一个 APK 的包信息、资源和方法证据，接通 Claude。

3. 让分析 agent 对一个 APK 生成并验证有效规格，再扩展到三个。

4. 实现比较 → 决策 → 设计三个顺序阶段，每阶段立即保存。

5. 生成文档和线框图，补齐关键校验、有限重试和阶段恢复。

6. 用三个真实 APK 跑完整流程，检查证据和设计，修复实际发现的问题。

交付源码、README、配置样例、固定的三个 APK 身份、可重跑命令、三份规格、比较与决策、统一设计、全部中间结果目录及真实验证报告。不要只交架构、空接口或一组手工示例 JSON。

README 说明如何配置工具与 API key，怎样运行和恢复，以及当前静态分析限制。若没修改 REA，只跑与接入相关的检查；修改上游则补做其要求的相关验证。

## 11 接口依据

执行时以固定 REA checkout 和当前官方 SDK 文档为准，以下是核对入口：

- [REA Android 分析](https://github.com/morluto/rea/blob/main/docs/android-analysis.md)

- [REA Apktool 资源边界](https://github.com/morluto/rea/blob/main/docs/apktool-resource-analysis.md)

- [REA CLI](https://github.com/morluto/rea/blob/main/docs/cli.md)

- [Claude Opus 5](https://platform.claude.com/docs/en/models/opus-5/overview)

- [Claude 结构化输出](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

- [Claude 工具调用](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)

本任务要求的是实现并验证上述 MVP。规格准确性和设计质量必须依据真实产物检查；完成静态分析不等于验证了参考 app 的运行体验或新产品的市场需求。
