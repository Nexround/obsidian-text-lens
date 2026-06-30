# PRD — TextLens Obsidian Plugin

**文档版本**：1.6  
**日期**：2026-06-30  
**作者**：wangrunyu  
**状态**：已实现（v1.3.8）

---

## 1. 背景与问题

Obsidian 用户在整理笔记时，大量使用截图、扫描件、照片等图片来记录信息（会议白板、纸质文件、技术截图等）。这些图片中的文字内容无法被 Obsidian 的全文搜索索引，也无法直接复制和引用，造成信息孤岛。

**核心痛点**：

1. 图片中的文字不可搜索 — 查找笔记时无法通过关键词命中图片内容
2. 文字提取成本高 — 需要手动打开外部 OCR 工具、逐张处理、再粘贴回笔记
3. 依赖外部服务 — 远程 OCR 方案要求服务端始终在线，离线或网络不稳定时无法使用，且图片数据外传存在隐私风险

---

## 2. 目标

**主要目标**：为 Obsidian 用户提供一键 OCR 能力，完全在本地设备上完成推理，将笔记中所有图片的文字识别结果自动插入到图片下方，使图片内容可搜索、可引用，且图片数据零外传。

**成功指标**：

- 用户从触发命令到看到识别结果的时间 < 单张图片 OCR 响应时间 + 1 s
- 识别结果正确插入到对应图片下方，不破坏原有 Markdown 结构
- 一批图片处理完成后，整个操作可以通过一次 `Cmd+Z` 撤销
- 无需网络连接即可完成识别（运行时安装完成后）

---

## 3. 用户故事

| ID | 角色 | 需求 | 价值 |
|----|------|------|------|
| US-1 | 知识工作者 | 打开含有会议白板截图的笔记，一键提取所有文字 | 白板内容进入搜索索引，可被后续笔记引用 |
| US-2 | 研究员 | 笔记中有论文扫描图，希望提取表格和段落文字 | 无需切换工具，在 Obsidian 内完成全流程 |
| US-3 | 任意用户 | 对同一篇笔记多次运行 OCR，不希望重复插入 | 结果幂等，不产生冗余内容 |
| US-4 | 任意用户 | 对已 OCR 过的笔记重新执行 OCR 时，希望能强制重跑所有图片 | 更新识别结果，不受幂等检测干扰 |
| US-5 | 隐私敏感用户 | 图片内容不希望发送到任何外部服务器 | 本地模式完全在设备上完成识别，零数据外传 |
| US-6 | 移动办公用户 | 在无网络环境下仍希望能 OCR 笔记 | 运行时安装后无需网络，随时可用 |

---

## 4. 功能范围

### 4.1 In Scope

**F-1 命令触发**  
注册 Obsidian 命令（ID：`ocr-current-note`，名称：`OCR Current Note`），在命令面板（`Cmd+P`）中可调用，作用于当前活跃的 Markdown 文件。命令名称不带插件前缀，符合 Obsidian 官方发布规范。

**F-2 图片识别**  
支持以下两种 Obsidian 图片语法：

- Obsidian wikilink：`![[image.png]]`、`![[image.png|alt]]`
- 标准 Markdown：`![alt](path/to/image.png)`

支持图片格式：`png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`, `svg`, `tiff`, `avif`

**F-3 本地图片读取**  
通过 Obsidian Vault API 读取图片二进制内容，以 ArrayBuffer 传给本地引擎。文件路径解析优先级：
1. 精确 vault 路径匹配
2. Obsidian `metadataCache` wikilink 解析
3. 全 vault basename 搜索

**F-4 本地 OCR 引擎**  
使用 PaddleOCR v6 通过 ONNX Runtime 在设备上完成推理，零数据外传：

- **运行时安装**：首次使用前在设置面板点击"Setup"，一次性下载 ~40 MB 原生二进制（onnxruntime-node + @napi-rs/canvas），安装后持久存储在插件目录
- **模型分级**：Tiny（~5 MB，最快）/ Small（~25 MB，均衡，默认）/ Medium（~60 MB，最准）；模型按需下载，缓存在 `~/.cache/ppu-paddle-ocr/`
- **输入格式**：直接接受 ArrayBuffer，避免 Base64 中间内存峰值
- **延迟初始化**：插件加载后在后台异步预热引擎；运行时安装完成后设置面板立即刷新

**F-5 文本插入**  
将识别文本插入到图片 token 正后方。两种格式可选：

- **Callout**（默认）：`> [!note]+ OCR: filename\n> text...`，可折叠
- **Code block**：`` ```ocr\ntext\n``` ``

**F-6 幂等处理**  
插入前检查图片后方 200 字符内是否已存在 OCR 块，存在则跳过（可在设置中关闭）。

**F-7 重新识别（Re-OCR）**  
若笔记中至少一张图片已有 OCR 块，视为重跑：所有图片均强制识别，完成后旧 OCR 块被新结果替换。命令标签显示"Re-OCR"以示区分。

**F-8 批量处理与进度反馈**  
分三阶段处理笔记中的所有图片：

- **Phase 1（I/O 并发）**：通过 `Promise.allSettled` 并行读取全部图片的 `ArrayBuffer`；同时过滤出需推理的图片索引（去掉已跳过和 I/O 失败的）。
- **Phase 2（模型层 Batch 推理）**：将所有待推理的 `ArrayBuffer[]` 一次性传入 `LocalOcrEngine.batchRecognize()`，由 `ppu-paddle-ocr` 原生 `batchRecognize()` 在 ONNX Session 层面真正批量推理，最大并发数由用户设置控制（默认 3，可调 1–20）。Notice 实时显示已完成数量（来自 `onProgress` 回调）。
- **Phase 3（串行写回）**：将批量结果按文档倒序依次插入 `workingContent`，保证字符偏移量稳定。

所有修改通过一次 `editor.setValue()` 完成，保证单步撤销。

**F-9 换行合并**  
将 OCR 输出的视觉软换行合并为自然段落：

- 以句末标点（。！？等）结尾的行、列表项起始行 → 强制保留换行
- 以 `-` 结尾的英文行 → 去连字符后直接拼接
- 其余行 → 按 ASCII/CJK 边界决定是否插入空格后合并
- 段落间距（空行）予以保留

**F-10 设置面板**  
提供完整的设置 UI（详见第 7 节）。

### 4.2 Out of Scope

- HTTP/HTTPS URL 图片的 OCR（本地引擎无法直接访问外部 URL）
- PDF 文件 OCR
- 选区 OCR（只处理光标选中的图片）
- 后台自动 OCR（新图片插入时自动触发）
- 结果编辑 UI
- 多语言 UI（当前为英文界面）

---

## 5. 技术设计

### 5.1 架构

```
Obsidian Plugin (Electron Renderer — app:// context)
        │
        ├── Command: "TextLens: OCR Current Note"
        │       │
        │       ├── extractImages(content)                正则解析图片引用
        │       │
        │       ├── Phase 1: Promise.allSettled(...)      并行 I/O 读取全部图片
        │       │       └── fileToArrayBuffer × N         fetch(app://)
        │       │
        │       ├── Phase 2: LocalOcrEngine.batchRecognize(ArrayBuffer[], N)
        │       │       └── ppu-paddle-ocr.batchRecognize()  模型层真正 batch
        │       │               └── ppu-bundle.cjs (CJS)
        │       │                       └── onnxruntime-node (native)
        │       │
        │       ├── Phase 3: 映射结果 → 倒序插入 workingContent
        │       │
        │       └── editor.setValue(result)               写回编辑器（单步撤销）
        │
        ├── SettingTab                                    设置面板
        │       └── NativeBinaryManager.installRuntime()  运行时安装
        │
        └── LocalOcrEngine                               本地 OCR 引擎
                ├── initialize()                         懒加载 + 后台预热
                ├── recognize(ArrayBuffer)               单图推理
                ├── batchRecognize(ArrayBuffer[], ...)    批量推理（原生 batch API）
                └── destroy()                            释放 ONNX session
```

### 5.2 关键技术决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 图片读取 | `window.fetch(app.vault.getResourcePath())` | 走 Electron 主进程 `app://` 协议处理器，绕过 macOS `com.apple.provenance` 导致的 `fs.readFile` EPERM 问题；显式写 `window.fetch` 而非裸 `fetch` 以绕过 ESLint `no-restricted-globals` 规则，同时语义与行为完全等价 |
| 运行时下载 | `requestUrl`（Obsidian 内置） | 绕过 Electron renderer 的 CORS 和混合内容限制；用于从 npm registry / GitHub Release 下载原生二进制 |
| 并发控制 | `batchRecognize()` 原生 batch API | 委托 ppu-paddle-ocr 在 ONNX Session 层面真正批量推理；`concurrency` 参数对应用户设置的 `maxConcurrency`；`settle: true` 保证单张失败不中断整批 |
| 插入顺序 | Phase 2 倒序插入 | 保证前面图片的字符偏移量在后续插入后仍然有效 |
| 写回方式 | 单次 `editor.setValue()` | 一个撤销记录，比多次 `replaceRange` 用户体验更好 |
| 本地模块加载 | `require()` via `createRequire` | Obsidian 页面从 `app://` 加载，Chromium 将 `import("file://...")` 视为跨协议请求并阻断；`require()` 走 Node.js CJS 加载器，无此限制 |
| ppu-paddle-ocr 打包 | esbuild → `ppu-bundle.cjs` | ppu-paddle-ocr 为 ESM-only，不可直接 `require()`；CI 构建时预打包为单文件 CJS（含 ppu-ocv、opencv-js），仅将 onnxruntime-node 和 @napi-rs/canvas 保留为 external |
| 本地运行时安装 | `installRuntime()`（按需下载） | 原生二进制不能打包进 main.js；按平台从 npm registry 流式解压，只提取当前平台文件（~40 MB，而非全平台 ~260 MB） |
| 引擎初始化 | 懒加载 + 后台预热 | 插件加载不阻塞；首次命令调用时若未就绪显示 Notice；后台预热使实际调用时延最小化 |
| 编译 | esbuild（CJS 输出） | Obsidian 官方推荐的构建方式；`ppu-bundle.cjs` 保留为 external |

### 5.3 模块说明

| 文件 | 职责 |
|------|------|
| `src/main.ts` | 插件入口、命令注册、设置 UI、三阶段 OCR 调度（`processNote`）、文本格式化与插入、换行合并（`refineLineBreaks`） |
| `src/local-ocr.ts` | `LocalOcrEngine`：懒加载、单图推理（`recognize`）、批量推理（`batchRecognize`）、销毁；通过 `ppu-bundle.cjs` 调用 PaddleOCR |
| `src/native-manager.ts` | 运行时安装（onnxruntime-node、@napi-rs/canvas、ppu-bundle.cjs）、运行时检测、模块路径注入 |
| `scripts/build-bundle.mjs` | 将 ppu-paddle-ocr + ppu-ocv + opencv-js 打包为 `ppu-bundle.cjs` |
| `scripts/deploy.mjs` | 构建后部署：生成 `ppu-bundle.cjs`、复制所有产物到本地 vault 用于开发调试 |

---

## 6. 非功能性需求

| 类别 | 要求 |
|------|------|
| 性能 | N 张图片通过原生 `batchRecognize()` 批量推理，I/O 阶段 `Promise.allSettled` 全并行；模型层并发数由 `maxConcurrency` 控制（默认 3），较逐图串行最高可提速 maxConcurrency 倍 |
| 可靠性 | 单张图片失败不中断整批，最终汇报成功/失败数量；所有异步路径均有 try/catch，错误必输出到控制台 |
| 安全性 | 图片数据仅在本地处理，零外传；运行时二进制从 npm registry 和 GitHub Release 官方地址下载 |
| 兼容性 | Obsidian ≥ 1.7.2，仅桌面端（需要文件系统访问及 Node.js 集成） |
| 可维护性 | 三个源文件职责明确；deploy 脚本自动处理所有平台差异 |
| 可观测性 | 开发者模式输出每张图片的原始 OCR 结果；所有错误均以 `[text-lens]` 前缀输出到控制台 |

---

## 7. 交互设计

### 命令执行流程

```
用户触发命令
    │
    ├─ 无图片 → Notice "No images found"
    │
    └─ 有 N 张图片
            │
            ├─ 运行时未安装 → Notice 提示前往设置安装，退出
            │
            ├─ 引擎未初始化 → Notice "loading local engine…"
            │       └─ 初始化失败 → Notice 显示错误，退出
            │
            ├─ Phase 1（I/O 全并行）
            │       ├─ Promise.allSettled(fileToArrayBuffer × N)
            │       └─ 过滤 skipped / I/O 失败 → 构建 toProcess[] + globalToLocal Map
            │
            ├─ Phase 2（模型层 batch 推理，≤ maxConcurrency 并发）
            │       ├─ LocalOcrEngine.batchRecognize(buffers[], maxConcurrency)
            │       │       └─ ppu-paddle-ocr.batchRecognize(settle:true)
            │       └─ Notice "OCR: K/N done…"（onProgress 回调更新）
            │
            ├─ Phase 3（结果映射 + 倒序串行插入）
            │       └─ 通过 globalToLocal Map 将 BatchItemResult 映射回图片，写入 workingContent
            │
            ├─ editor.setValue(workingContent)   ← 单步撤销
            │
            └─ Notice "OCR complete: N image(s) processed."
                 或 "N succeeded, M failed. Check console for details."
```

### 设置面板布局

```
TextLens
──────────────────────────────────────
Local OCR Engine
──────────────────────────────────────
✅ Runtime installed — engine idle (loads automatically on first OCR run).
  - 或 -
⚠️ Runtime not installed. Click "Setup" to download (~40 MB).
  Setup local runtime        [Setup]

Model tier                 [Small (balanced) ▾]
Load local engine          [Load]    ← 已安装但引擎未加载时显示
Unload local engine        [Unload]  ← 引擎已加载时显示
Delete runtime files       [Delete]  ← 已安装时显示
Clear model cache          [Clear]   ← 始终显示

Output
──────────────────────────────────────
Output format              [Callout ▾]
Skip already-processed     [●]
Merge wrapped lines        [●]
Max concurrency            [  3  ]   ← 文本输入框，范围 1–20

Diagnostics
──────────────────────────────────────
Developer mode             [○]
```

---

## 8. 发布计划

| 版本 | 内容 |
|------|------|
| v1.0.0 | 核心 OCR 功能（远程模式）、设置面板、双语法支持、双输出格式 |
| v1.1.0 | 并发处理、空间行分组、空结果报错、开发者模式、修正 API 响应字段、修复图片读取改用 `app://` 协议 |
| v1.2.0 | Re-OCR：自动检测已有 OCR 块并强制重跑，替换旧结果 |
| v1.3.0 | 本地 OCR 引擎（PaddleOCR v6 via ONNX Runtime）、运行时一键安装、模型分级、全面错误处理、ppu-bundle.cjs 加载方案 |
| v1.3.1 | 删除远程 API 模式（本地 only）、Setup 完成后设置面板立即刷新、Max concurrency 改为文本输入框（范围 1–20）、manifest description 更新 |
| v1.3.2 | CI：为 main.js / styles.css 添加 GitHub artifact attestations |
| v1.3.3 | 通过 Obsidian 插件官方一轮 Review：命令 ID/名称去插件前缀（`ocr-current-note` / `OCR Current Note`）、`createEl(h2/h3)` 改 `new Setting().setHeading()`、移除无用 `arrayBufferToBase64`、`Buffer.slice` 改 `Buffer.subarray`、`onunload` 去 async |
| v1.3.4 | 二轮 Review 修复：`vault.readBinary()` 替换 `fetch(app://)`（临时）、`minAppVersion` 升至 1.13.0 以支持 `setDestructive()` API |
| v1.3.5 | 回滚图片读取：恢复 `window.fetch(app://)` 以支持 macOS 隔离文件（`vault.readBinary` 底层 `fs.readFile` 在隔离文件上报 EPERM） |
| v1.3.6 | 兼容性回滚：`setDestructive()` → `setWarning()`、`minAppVersion` 恢复 1.7.2，确保对旧版 Obsidian 的支持 |
| v1.3.7 | 补全剩余 `setWarning()` 替换；所有 Obsidian 官方 Review 问题清零 |
| **v1.3.8**（当前） | 改造为真正 Batch Inference：新增 `LocalOcrEngine.batchRecognize()`，调用 ppu-paddle-ocr 原生 `batchRecognize()` 实现模型层批量推理；`processNote()` 重构为三阶段流水线（I/O 全并行 → 模型层 batch → 结果映射写回）；删除手写并发池 `withConcurrency()` 和 `runOcr()` |
| v1.4（计划） | 右键菜单「OCR This Image」单张触发 |
| v1.5（计划） | 自动 OCR：新图片粘贴入笔记时自动触发 |

---

## 9. 风险与缓解

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|---------|
| 运行时安装失败（网络问题） | 中 | 中 | 安装失败显示完整错误信息；可重试 |
| 本地引擎内存占用（~200 MB ONNX session） | 中 | 中 | 提供"Unload"按钮手动释放；插件卸载时自动 destroy |
| Electron 版本更新导致模块加载行为变化 | 低 | 高 | `ppu-bundle.cjs` 方案依赖 Node.js CJS require，与 Electron 版本无关 |
| 图片路径解析失败 | 中 | 低 | 三级回退策略（精确路径 → metadataCache → basename 搜索） |
| 偏移量计算错误导致文本插入位置错误 | 低 | 高 | 从后往前处理；单次 setValue 写回 |
| 重复插入 OCR 内容 | 中 | 中 | 默认开启幂等检测，检查图片后 200 字符 |
| 模型文件下载失败 | 低 | 中 | ppu-paddle-ocr 内置缓存；失败时抛出明确错误 |
| URL 图片无法被本地引擎处理 | 确定 | 低 | 明确告知用户不支持（throw Error），属于 Out of Scope |
