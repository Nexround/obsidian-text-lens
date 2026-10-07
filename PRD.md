# PRD — TextLens Obsidian Plugin

**文档版本**：1.8

**日期**：2026-10-07

**作者**：wangrunyu  
**状态**：v1.4.0；PaddleOCR 默认，系统原生 OCR 为实验性功能，完整平台验收待完成

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

解析图片格式：`png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`, `svg`, `tif`, `tiff`, `avif`, `heic`, `heif`。实际识别取决于引擎解码能力；原生模式先尝试系统解码器，失败后在 Obsidian 渲染进程转换为 PNG，动画仅取第一帧。两者均失败时报告格式不支持或图片损坏。

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
- **延迟初始化**：仅当选中 PaddleOCR 且运行时已安装时后台预热；安装完成后设置面板立即刷新

新增“识别来源”，默认 `paddle`；原生语言默认 `auto`。旧设置通过默认值合并兼容，无需迁移脚本。失败不自动切换来源。

**F-4a Windows 系统原生 OCR**

使用 Windows PowerShell 5.1 调用 `Windows.Media.Ocr`，不下载额外运行时。脚本由 esbuild 作为文本嵌入 `main.js`，首次使用原子写入插件目录，带 UTF-8 BOM。通过反射 `AsTask<T>()` 等待 WinRT 操作，调用 `BitmapDecoder → SoftwareBitmap → RecognizeAsync()`；统一 BGRA8 和 alpha 格式、尊重 EXIF 方向，并释放位图和文件流。

初始化查询实际可用语言及 `MaxImageDimension`。“系统默认”采用用户配置语言，不检测图片语言。超尺寸图片等比缩小，批次提示受影响的图片。Windows adapter 删除两个汉字之间的普通空格，保留英文单词空格、汉英边界和制表符；开发模式保留归一化前的结果。

**F-4b macOS Apple Vision**

独立 Swift helper 使用 `VNImageRequestHandler` 和 `VNRecognizeTextRequest`，设为 `.accurate` 并启用语言纠正，每个观察结果取第一候选。ImageIO 解码第一帧，EXIF 方向参与识别。单栏结果按从上到下、同行从左到右排序；复杂多栏和表格还原不在首版范围内。

运行时查询支持语言。macOS 13+ 的默认模式启用语言检测；旧系统使用偏好中的第一个受支持语言，否则使用英文。设置显示实际行为。发布 arm64（最低 macOS 11）和 x64（最低 10.15）二进制；避免使用需要较新 Swift 运行时的能力。

首次在设置中“安装／重新安装原生 helper”，从当前插件版本对应的 GitHub Release 下载二进制和 SHA-256 文件。校验哈希、版本和可执行性后原子安装到插件目录并赋予执行权限。构建时使用 ad-hoc 签名，不依赖开发者证书。安装后离线运行；版本不匹配要求重新安装。失败显示具体错误，不安装工具链，也不修改系统安全设置。Linux 明确提示原生模式不支持，继续使用 PaddleOCR。

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
- **Phase 2（引擎批次）**：通过公共 `OcrEngine.batchRecognize()` 调用所选来源，输出插件自己的成功／失败类型，保留输入索引、文本行及进度回调。PaddleOCR 使用模型层 batch，最大并发默认 3，可调 1–20；原生模式固定并发 1，每个笔记批次启动一个进程，逐张识别并实时更新进度。
- **Phase 3（串行写回）**：将批量结果按文档倒序依次插入 `workingContent`，保证字符偏移量稳定。

所有修改通过一次 `editor.transaction()` 完成。失败或无文字的图片保留旧 OCR 结果。识别期间阻止重复命令，禁用设置以防途中销毁引擎。插件卸载取消写回并终止原生进程；笔记被编辑或关闭时取消写回，提示重新执行。真实 Obsidian 单步撤销效果仍需平台验收。

原生桥接通过 `spawn` 和参数数组启动，Windows 隐藏窗口。stdin/stdout 为 UTF-8 JSON Lines；请求含索引、路径和语言，响应含对应索引、文本行或错误、是否缩小。stderr 仅用于诊断。每张图片限时 30 秒（包括可选格式转换）；普通单图失败不影响其余图片。进程退出、超时或协议损坏时保留完成结果，剩余项标为失败，不重试。每批使用独立临时目录，结束或失败后等待进程终止并清理文件。

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
- Linux 系统原生 OCR、复杂多栏和表格布局还原

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
        │       ├── Phase 2: OcrEngine.batchRecognize(ArrayBuffer[], N)
        │       │       ├── LocalOcrEngine → PaddleOCR/ONNX 模型层 batch
        │       │       └── NativeOcrEngine → JSONL 进程（串行）
        │       │               ├── Windows PowerShell → Windows.Media.Ocr
        │       │               └── macOS helper → Apple Vision
        │       │
        │       ├── Phase 3: 映射结果 → 倒序插入 workingContent
        │       │
        │       └── editor.transaction(result)            一次事务写回（需验收撤销）
        │
        ├── SettingTab                                    设置面板
        │       ├── installRuntime()                      PaddleOCR 运行时安装
        │       └── installMacHelper()                    Vision 校验后安装
        │
        └── OcrEngine                                    公共接口
                ├── ready                                初始化完成状态
                ├── initialize()                         懒加载；仅 Paddle 后台预热
                ├── batchRecognize(ArrayBuffer[], ...)    输入索引对齐的结果
                └── destroy()                            释放会话／终止原生进程
```

### 5.2 关键技术决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 图片读取 | `window.fetch(app.vault.getResourcePath())` | 走 Electron 主进程 `app://` 协议处理器，绕过 macOS `com.apple.provenance` 导致的 `fs.readFile` EPERM 问题；显式写 `window.fetch` 而非裸 `fetch` 以绕过 ESLint `no-restricted-globals` 规则，同时语义与行为完全等价 |
| 运行时下载 | `requestUrl`（Obsidian 内置） | 绕过 Electron renderer 的 CORS 和混合内容限制；用于从 npm registry / GitHub Release 下载原生二进制 |
| 并发控制 | PaddleOCR batch；原生串行 | PaddleOCR 使用 `maxConcurrency` 和 `settle: true`；原生固定 1，不加载 PaddleOCR 运行时 |
| 插入顺序 | Phase 3 倒序插入 | 保证前面图片的字符偏移量在后续插入后仍然有效 |
| 写回方式 | 单次 `editor.transaction()` | 一个编辑事务；写回前检查卸载状态、编辑器内容及活跃笔记 |
| 本地模块加载 | `require()` via `createRequire` | Obsidian 页面从 `app://` 加载，Chromium 将 `import("file://...")` 视为跨协议请求并阻断；`require()` 走 Node.js CJS 加载器，无此限制 |
| ppu-paddle-ocr 打包 | esbuild → `ppu-bundle.cjs` | ppu-paddle-ocr 为 ESM-only，不可直接 `require()`；CI 构建时预打包为单文件 CJS（含 ppu-ocv、opencv-js），仅将 onnxruntime-node 和 @napi-rs/canvas 保留为 external |
| 本地运行时安装 | `installRuntime()`（按需下载） | 原生二进制不能打包进 main.js；按平台从 npm registry 流式解压，只提取当前平台文件（~40 MB，而非全平台 ~260 MB） |
| 引擎初始化 | 懒加载；仅 PaddleOCR 后台预热 | 首次命令调用时显示 Notice，原生能力查询由设置或首次命令触发 |
| 原生传输 | 参数数组和 UTF-8 JSONL | 索引验证、30 秒单图期限、失败保留完成结果、无自动重试或来源切换 |
| macOS 分发 | 当前版本 Release + SHA-256 + ad-hoc 签名 | 校验版本和执行能力后原子安装，用户不需要 Swift 工具链 |
| 编译 | esbuild（CJS 输出） | Obsidian 官方推荐的构建方式；`ppu-bundle.cjs` 保留为 external |

### 5.3 模块说明

| 文件 | 职责 |
|------|------|
| `src/main.ts` | 插件入口、命令注册、三阶段 OCR 调度、文本格式化、换行合并及写回保护 |
| `src/settings.ts` | 来源设置、状态和语言展示、安装与缓存管理、运行期间禁用控件 |
| `src/ocr-engine.ts` | 公共引擎、成功／失败批量结果和进度类型 |
| `src/local-ocr.ts` | `LocalOcrEngine`：懒加载、单图推理（`recognize`）、批量推理（`batchRecognize`）、销毁；通过 `ppu-bundle.cjs` 调用 PaddleOCR |
| `src/native-manager.ts` | 运行时安装（onnxruntime-node、@napi-rs/canvas、ppu-bundle.cjs）、运行时检测、模块路径注入 |
| `src/native-ocr.ts` | 原生批次、临时文件、格式回退、取消及汉字空格归一化 |
| `src/native-process.ts` | JSONL 传输、期限、协议验证、进程终止 |
| `src/native-helper.ts` | Windows 脚本落盘、macOS helper 下载校验和原子安装 |
| `src/native/windows-ocr.ps1` | Windows.Media.Ocr 正式桥接 |
| `native/macos/main.swift` | Apple Vision 正式桥接 |
| `src/image-conversion.ts` | Obsidian 渲染进程 PNG 解码回退 |
| `scripts/build-bundle.mjs` | 将 ppu-paddle-ocr + ppu-ocv + opencv-js 打包为 `ppu-bundle.cjs` |
| `scripts/build-macos-helper.mjs` | 架构对应的最低系统目标、ad-hoc 签名、SHA-256 文件 |
| `scripts/test-native-ocr.mjs` / `scripts/test-plugin.mjs` | 协议异常、期限、取消、顺序、临时清理及命令写回回归检查 |
| `scripts/probe-windows-ocr.mjs` / `scripts/probe-macos-ocr.mjs` | 正式桥接的真实系统识别和安装验证 |
| `scripts/deploy.mjs` | 构建后部署：生成 `ppu-bundle.cjs`、复制所有产物到本地 vault 用于开发调试 |

---

## 6. 非功能性需求

| 类别 | 要求 |
|------|------|
| 性能 | I/O 阶段全并行；PaddleOCR 使用可配置 batch 并发，原生固定 1；每张原生识别限时 30 秒 |
| 可靠性 | 普通单图错误不中断整批；原生进程或协议失败保留完成结果，其余标为失败；卸载取消写回和进程 |
| 安全性 | 图片数据只在本地处理；macOS helper 从对应版本 Release 下载并验证 SHA-256；不安装工具链或修改系统安全设置 |
| 兼容性 | Obsidian ≥ 1.7.2，仅桌面端（需要文件系统访问及 Node.js 集成） |
| 可维护性 | 公共接口隔离引擎；正式桥接被实际识别 probe 复用；遵循项目 MIT 许可，不复制 GPL 实现 |
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
            ├─ 当前来源依赖未安装／平台不支持 → Notice 提示具体原因，退出
            │
            ├─ 引擎未初始化 → Notice "loading selected engine…"
            │       └─ 初始化失败 → Notice 显示错误，退出
            │
            ├─ Phase 1（I/O 全并行）
            │       ├─ Promise.allSettled(fileToArrayBuffer × N)
            │       └─ 过滤 skipped / I/O 失败 → 构建 toProcess[] + globalToLocal Map
            │
            ├─ Phase 2（所选引擎的批次调用）
            │       ├─ OcrEngine.batchRecognize(buffers[], maxConcurrency)
            │       │       ├─ PaddleOCR 模型 batch（≤ maxConcurrency）
            │       │       └─ 原生 JSONL 进程（并发 1）
            │       └─ Notice "OCR: K/N done…"（onProgress 回调更新）
            │
            ├─ Phase 3（结果映射 + 倒序串行插入）
            │       └─ 通过 globalToLocal Map 将 OcrItemResult 映射回图片，写入 workingContent
            │
            ├─ 确认未卸载、内容未变化、笔记仍活跃
            ├─ editor.transaction(workingContent) ← 一次编辑事务
            │
            └─ Notice "OCR complete: N image(s) processed."
                 或 "N succeeded, M failed. Check console for details."
```

### 设置面板布局

```
TextLens
──────────────────────────────────────
OCR Engine
──────────────────────────────────────
Recognition source         [PaddleOCR ▾] ← 默认 paddle
  原生模式：平台、状态、系统默认语言说明
  Native language          [System default ▾]
  Install/reinstall helper [Install]     ← 仅 macOS
  Max image dimension                   ← Windows 查询实际限制
  以下运行时／模型／缓存项仅 PaddleOCR 显示
✅ Runtime installed — engine idle (loads automatically on first OCR run).
  - 或 -
⚠️ Runtime not installed. Click "Setup" to download (~40 MB).
  Setup local runtime        [Setup]

Model tier                 [Small (balanced) ▾]
Load local engine          [Load]    ← 已安装但引擎未加载时显示
Unload local engine        [Unload]  ← 引擎已加载时显示
Delete runtime files       [Delete]  ← 已安装时显示
Clear model cache          [Clear]
Max concurrency            [  3  ]   ← 仅 PaddleOCR，范围 1–20

Output
──────────────────────────────────────
Output format              [Callout ▾]
Skip already-processed     [●]
Merge wrapped lines        [●]

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
| v1.3.8 | 改造为真正 Batch Inference：新增 `LocalOcrEngine.batchRecognize()`，调用 ppu-paddle-ocr 原生 `batchRecognize()` 实现模型层批量推理；`processNote()` 重构为三阶段流水线（I/O 全并行 → 模型层 batch → 结果映射写回）；删除手写并发池 `withConcurrency()` 和 `runOcr()` |
| **v1.4.0**（当前） | 实验性 Windows.Media.Ocr 和 Apple Vision、公共接口、来源／语言设置、helper 安装校验、期限／取消和临时清理；完成对应平台验收后再标记为正式可用 |
| 后续版本（计划） | 右键菜单「OCR This Image」单张触发 |
| 后续版本（计划） | 自动 OCR：新图片粘贴入笔记时自动触发 |

---

## 9. 风险与缓解

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|---------|
| 运行时安装失败（网络问题） | 中 | 中 | 安装失败显示完整错误信息；可重试 |
| 本地引擎内存占用（~200 MB ONNX session） | 中 | 中 | 提供"Unload"按钮手动释放；插件卸载时自动 destroy |
| Electron 版本更新导致模块加载行为变化 | 低 | 高 | `ppu-bundle.cjs` 方案依赖 Node.js CJS require，与 Electron 版本无关 |
| 图片路径解析失败 | 中 | 低 | 三级回退策略（精确路径 → metadataCache → basename 搜索） |
| 偏移量计算错误导致文本插入位置错误 | 低 | 高 | 从后往前处理；单次事务写回；用户编辑／关闭笔记时取消写回 |
| 重复插入 OCR 内容 | 中 | 中 | 默认开启幂等检测，检查图片后 200 字符 |
| 模型文件下载失败 | 低 | 中 | ppu-paddle-ocr 内置缓存；失败时抛出明确错误 |
| URL 图片无法被本地引擎处理 | 确定 | 低 | 明确告知用户不支持（throw Error），属于 Out of Scope |
| helper 不匹配、校验／执行失败 | 中 | 中 | 错误展示原因；重新安装；失败保留已安装的有效二进制 |
| 原生调用挂起或协议损坏 | 低 | 中 | 单图 30 秒期限；终止进程；保留已完成结果并清理临时目录 |

## 10. 验证与发布验收

| 检查 | 当前结果 |
|------|----------|
| TypeScript `npm run typecheck`、生产构建 | 本地通过；第三方声明文件使用 `skipLibCheck`，插件源代码仍检查 |
| `npm test` | 正式传输层的顺序、单图错误、崩溃、期限、损坏协议／索引、格式回退、取消和清理通过；命令测试覆盖默认值合并、无 Paddle 运行时调用、设置锁定、重复执行、重跑保留失败图旧结果、一次事务、编辑保护和卸载取消 |
| `npm run probe:windows` | 正式桥接实际识别通过：英文、中文、中英混排、中文路径、默认语言、空白图、损坏图、超尺寸缩小、缺失语言；缺失语言根据实际已安装能力选择 |
| macOS arm64/x64 | [发布前 CI](https://github.com/Nexround/obsidian-text-lens/actions/runs/37587264266) 在 macOS 15 上完成两个架构的编译、ad-hoc 签名、真实 Vision 识别、安装校验和离线复用；最低目标系统的实机测试仍待完成 |
| 无开发工具 Mac | 待进行：`npm run probe:macos -- --release` 检查对应版本 Release 下载、安装、执行和离线复用，probe 使用预置图片，无需 Swift |
| 两端 Obsidian 验收 | 待进行：首次初始化、批量进度、来源／语言锁定及切换、重新识别、失败图旧结果保留、单步撤销、卸载取消、原生模式无 PaddleOCR 运行时 |

Release 流程先检查 tag 与插件版本一致，再构建主插件和 `ppu-bundle.cjs`；macOS 构建分别指定最低 11／10.15，使用 ad-hoc 签名，签名后生成独立 `.sha256` 文件。真实 Vision／安装 probe 成功后，统一发布主文件、两个 helper 和校验文件。源码版本在对应 Release 生成前无法通过设置下载安装 macOS helper，应显示明确下载错误。

桥接按项目 MIT 许可独立实现。Windows 解码及方向行为参照 [Microsoft BitmapDecoder 文档](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.imaging.bitmapdecoder)，Vision 语言行为参照 [Apple 文档](https://developer.apple.com/documentation/vision/vnrecognizetextrequest/automaticallydetectslanguage)，不复制外部 GPL 源码。
