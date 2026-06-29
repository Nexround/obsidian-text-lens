# PRD — OCR Images Obsidian Plugin

**文档版本**：1.3  
**日期**：2026-06-26  
**作者**：wangrunyu  
**状态**：已实现（v1.3.0）

---

## 1. 背景与问题

Obsidian 用户在整理笔记时，大量使用截图、扫描件、照片等图片来记录信息（会议白板、纸质文件、技术截图等）。这些图片中的文字内容无法被 Obsidian 的全文搜索索引，也无法直接复制和引用，造成信息孤岛。

**核心痛点**：

1. 图片中的文字不可搜索 — 查找笔记时无法通过关键词命中图片内容
2. 文字提取成本高 — 需要手动打开外部 OCR 工具、逐张处理、再粘贴回笔记
3. 依赖外部服务 — 远程 OCR 方案要求服务端始终在线，离线或网络不稳定时无法使用
4. 已有 OCR 基础设施未被利用 — 用户已部署了 PaddleX OCR 服务（PP-OCRv5），但缺少与 Obsidian 集成的入口

---

## 2. 目标

**主要目标**：为 Obsidian 用户提供一键 OCR 能力，支持远程服务和本地引擎两种模式，将笔记中所有图片的文字识别结果自动插入到图片下方，使图片内容可搜索、可引用。

**成功指标**：

- 用户从触发命令到看到识别结果的时间 < 单张图片 OCR 响应时间 + 1s
- 识别结果正确插入到对应图片下方，不破坏原有 Markdown 结构
- 一批图片处理完成后，整个操作可以通过一次 `Cmd+Z` 撤销
- 本地模式下无需网络连接即可完成识别

---

## 3. 用户故事

| ID | 角色 | 需求 | 价值 |
|----|------|------|------|
| US-1 | 知识工作者 | 打开含有会议白板截图的笔记，一键提取所有文字 | 白板内容进入搜索索引，可被后续笔记引用 |
| US-2 | 研究员 | 笔记中有论文扫描图，希望提取表格和段落文字 | 无需切换工具，在 Obsidian 内完成全流程 |
| US-3 | 开发者 | 笔记嵌入了报错截图（URL 图片），希望提取错误信息 | 错误文字可被搜索和复制 |
| US-4 | 任意用户 | 对同一篇笔记多次运行 OCR，不希望重复插入 | 结果幂等，不产生冗余内容 |
| US-5 | 任意用户 | 识别效果不好时，希望能调整检测参数 | 通过设置面板微调，不需要修改代码 |
| US-6 | 任意用户 | 对已 OCR 过的笔记重新执行 OCR 时，希望强制重跑所有图片 | 更新识别结果，不受幂等检测干扰 |
| US-7 | 隐私敏感用户 | 图片内容不希望发送到任何外部服务器 | 本地模式完全在设备上完成识别，零数据外传 |
| US-8 | 移动办公用户 | 在无网络环境下仍希望能 OCR 笔记 | 本地模式无需网络，随时可用 |

---

## 4. 功能范围

### 4.1 In Scope

**F-1 命令触发**  
注册 Obsidian 命令 `OCR Images in Current Note`，在命令面板（`Cmd+P`）中可调用，作用于当前活跃的 Markdown 文件。

**F-2 图片识别**  
支持以下两种 Obsidian 图片语法：

- Obsidian wikilink：`![[image.png]]`、`![[image.png|alt]]`
- 标准 Markdown：`![alt](path/to/image.png)`、`![alt](https://example.com/img.jpg)`

支持图片格式：`png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`, `svg`, `tiff`, `avif`

**F-3 本地图片处理**  
通过 Obsidian Vault API 读取图片二进制内容，转为 Base64（远程模式）或 ArrayBuffer（本地模式）。文件路径解析优先级：
1. 精确 vault 路径匹配
2. Obsidian `metadataCache` wikilink 解析
3. 全 vault basename 搜索

**F-4 URL 图片处理**  
HTTP/HTTPS 图片 URL 直接传给远程 OCR 后端，不在客户端下载。本地模式不支持 URL 图片（自动降级到远程）。

**F-5 远程 OCR API 调用**  
向配置的 `POST /ocr` 端点发送请求，提取响应中 `result.ocrResults[0].prunedResult.rec_texts`（识别文字）和 `rec_boxes`（边界框坐标）数组。使用 Obsidian 内置 `requestUrl` 绕过 CORS 限制。请求超时：60 秒。空识别结果视为失败，计入错误计数。

**F-6 本地 OCR 引擎**  
使用 PaddleOCR v6 通过 ONNX Runtime 在设备上完成推理，无需外部服务器：

- **运行时安装**：首次使用前在设置面板点击"Setup"，一次性下载 ~40 MB 原生二进制（onnxruntime-node + @napi-rs/canvas），安装后持久存储在插件目录
- **模型分级**：Tiny（~5 MB，最快）/ Small（~25 MB，均衡，默认）/ Medium（~60 MB，最准）；模型从 GitHub LFS 按需下载，缓存在 `~/.cache/ppu-paddle-ocr/`
- **输入格式**：直接接受 ArrayBuffer，无需 Base64 转换，避免中间内存峰值
- **延迟初始化**：插件加载后在后台异步预热引擎；若加载失败不影响远程模式

**F-7 OCR 模式选择**  
提供三种模式，在设置面板切换：

| 模式 | 行为 |
|------|------|
| `remote` | 始终调用远程 API |
| `local` | 始终使用本地引擎；本地引擎失败则报错，不降级 |
| `auto` | 优先本地（运行时已安装且引擎 ready 时）；本地返回空结果或抛错时自动降级到远程；URL 图片直接走远程 |

**F-8 文本插入**  
将识别文本插入到图片 token 正后方。两种格式可选：

- **Callout**（默认）：`> [!note]+ OCR: filename\n> text...`，可折叠
- **Code block**：` ```ocr\ntext\n``` `

**F-9 幂等处理**  
插入前检查图片后方 200 字符内是否已存在 OCR 块，存在则跳过（可在设置中关闭）。

**F-10 重新识别（Re-OCR）**  
若笔记中至少一张图片已有 OCR 块，视为重跑：所有图片均强制识别，完成后旧 OCR 块被新结果替换。命令标签显示"Re-OCR"以示区分。

**F-11 批量处理与进度反馈**  
分两阶段处理笔记中的所有图片：

- **Phase 1（并发）**：所有图片的文件读取和 OCR 调用并发执行，最大并发数由用户设置控制（默认 3，可调 1–10）。Notice 实时显示已完成数量。
- **Phase 2（串行）**：将 Phase 1 收集到的结果按文档倒序依次插入 `workingContent`，保证字符偏移量稳定。

所有修改通过一次 `editor.setValue()` 完成，保证单步撤销。

**F-12 空间布局保持**  
利用 `rec_boxes` 坐标将识别结果还原为接近原图阅读顺序的文本行：

1. 按 y 中心坐标升序排列所有词块
2. 贪心分行：y 中心差值 < `max(本格高, 行高) × 0.6` 的词块归为同一行
3. 行内按 x 中心左→右排序，词块间用两个空格连接
4. 行间用换行符分隔

**F-13 设置面板**  
提供完整的设置 UI（详见第 7 节）。

### 4.2 Out of Scope

- PDF 文件 OCR（API 支持，但 Obsidian 不将 PDF 嵌入为图片语法）
- 选区 OCR（只处理光标选中的图片）
- 后台自动 OCR（新图片插入时自动触发）
- 结果编辑 UI（识别后的文字修正）
- 多语言 UI（当前为英文界面）
- URL 图片的本地 OCR（无法直接访问 file:// 以外的资源）

---

## 5. 技术设计

### 5.1 架构

```
Obsidian Plugin (Electron Renderer — app:// context)
        │
        ├── Command: "OCR Images in Current Note"
        │       │
        │       ├── extractImages(content)          正则解析图片引用
        │       │
        │       ├── Phase 1: withConcurrency(...)   并发（≤ maxConcurrency）
        │       │       │
        │       │       └── runOcr(plugin, img, ...)
        │       │               ├─ [local/auto + 非URL]
        │       │               │       └── LocalOcrEngine.recognize(ArrayBuffer)
        │       │               │               └── ppu-bundle.cjs (CJS)
        │       │               │                       └── onnxruntime-node (native)
        │       │               │
        │       │               └─ [remote/auto fallback/URL]
        │       │                       ├── fileToBase64(vault, path)   fetch(app://)
        │       │                       ├── callOcrApi(settings, ...)   requestUrl POST
        │       │                       └── groupTextByRows(texts, boxes)
        │       │
        │       ├── Phase 2: 倒序插入 workingContent
        │       │
        │       └── editor.setValue(result)         写回编辑器（单步撤销）
        │
        ├── SettingTab                              设置面板
        │       └── NativeBinaryManager.installRuntime()  运行时安装
        │
        └── LocalOcrEngine                         本地 OCR 引擎
                ├── initialize()                   懒加载 + 后台预热
                ├── recognize(ArrayBuffer)          推理
                └── destroy()                      释放 ONNX session
```

### 5.2 关键技术决策

| 决策 | 选择 | 理由 |
|------|------|------|
| HTTP 客户端 | `requestUrl`（Obsidian 内置） | 绕过 Electron renderer 的 CORS 和混合内容限制 |
| 图片读取 | `fetch(app.vault.getResourcePath())` | 走 Electron 主进程协议处理器，绕过 macOS `com.apple.provenance` 导致的 `fs.readFile` EPERM 问题 |
| Base64 转换 | 手动分块 `btoa`（8192B/chunk） | 避免大文件时 V8 调用栈溢出 |
| 并发控制 | 工人池模式（`withConcurrency`） | 无需外部依赖；JS 单线程保证 `next++` 原子性；结果按原始顺序返回 |
| 插入顺序 | Phase 2 倒序插入 | 保证前面图片的字符偏移量在后续插入后仍然有效 |
| 写回方式 | 单次 `editor.setValue()` | 一个撤销记录，比多次 `replaceRange` 用户体验更好 |
| 空间行分组 | 基于 `rec_boxes` 贪心分行 | 还原原图二维布局，避免并排文字被拆成多行 |
| OCR 文字字段 | `prunedResult.rec_texts` | 实测服务端响应中 `texts` 字段始终为空，实际数据在 `rec_texts` |
| 本地模块加载 | `require()` via `createRequire` | Obsidian 页面从 `app://` 加载，Chromium 将 `import("file://...")` 视为跨协议请求并阻断；`require()` 走 Node.js CJS 加载器，无此限制 |
| ppu-paddle-ocr 打包 | esbuild → `ppu-bundle.cjs` | ppu-paddle-ocr 为 ESM-only，不可直接 `require()`；deploy 时预打包为单文件 CJS（含 ppu-ocv、opencv-js），仅将 onnxruntime-node 和 @napi-rs/canvas 保留为 external |
| 本地运行时安装 | `installRuntime()`（按需下载） | 原生二进制不能打包进 main.js；按平台从 npm registry 流式解压，只提取当前平台文件（~40 MB，而非全平台 ~260 MB） |
| 引擎初始化 | 懒加载 + 后台预热 | 插件加载不阻塞；首次命令调用时若未就绪显示 Notice；后台预热使实际调用时延最小化 |
| 编译 | esbuild（CJS 输出） | Obsidian 官方推荐的构建方式；`ppu-bundle.cjs` 保留为 external |

### 5.3 模块说明

| 文件 | 职责 |
|------|------|
| `src/main.ts` | 插件入口、命令注册、设置 UI、OCR 调度（`runOcr`）、文本格式化与插入 |
| `src/local-ocr.ts` | `LocalOcrEngine`：懒加载、推理、销毁；通过 `ppu-bundle.cjs` 调用 PaddleOCR |
| `src/native-manager.ts` | 运行时安装（onnxruntime-node、@napi-rs/canvas）、运行时检测、模块路径注入 |
| `scripts/deploy.mjs` | 构建后部署：生成 `ppu-bundle.cjs`、复制所有产物到 vault |

### 5.4 OCR API 交互（远程模式）

**请求**

```json
POST /ocr
Content-Type: application/json

{
  "file": "<base64 string 或 https://... URL>",
  "fileType": 1,
  "useDocOrientationClassify": false,
  "useDocUnwarping": false
}
```

**响应（成功）**

```json
{
  "errorCode": 0,
  "result": {
    "ocrResults": [
      {
        "prunedResult": {
          "rec_texts": ["识别到的文本行1", "文本行2"],
          "rec_scores": [0.98, 0.95],
          "rec_boxes": [[x1, y1, x2, y2], "..."],
          "texts": []
        }
      }
    ]
  }
}
```

> ⚠️ 注意：服务端实际响应中 `prunedResult.texts` 始终为空数组，识别结果在 `rec_texts`，坐标在 `rec_boxes`。官方文档有误，已在 `ocr.md` 中更正。

**错误处理**：以下情况均计入失败计数，记录到控制台，继续处理其余图片：
- `errorCode != 0`（服务端返回错误）
- `rec_texts` 为空数组（图片中未识别到任何文字）
- 网络超时或文件读取失败

---

## 6. 非功能性需求

| 类别 | 要求 |
|------|------|
| 性能 | N 张图片总耗时 ≈ max(单张响应时间) × ⌈N / maxConcurrency⌉，较串行提速最高 maxConcurrency 倍 |
| 可靠性 | 单张图片失败不中断整批，最终汇报成功/失败数量；所有异步路径均有 try/catch，错误必输出到控制台 |
| 安全性 | 远程模式：图片仅发送到用户配置的自有 OCR 服务；本地模式：零数据外传 |
| 兼容性 | Obsidian ≥ 1.7.2，仅桌面端（需要文件系统访问及 Node.js 集成） |
| 可维护性 | 三个源文件职责明确；deploy 脚本自动处理所有平台差异 |
| 可观测性 | 开发者模式输出每张图片的原始 OCR 结果；所有错误均以 `[ocr-image]` 前缀输出到控制台 |

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
            ├─ [本地/自动模式] 运行时未安装 → Notice 提示前往设置安装，退出
            │
            ├─ [本地/自动模式] 引擎未初始化 → Notice "loading local engine…"
            │       └─ 初始化失败 → Notice 显示错误，退出
            │
            ├─ Phase 1（并发，≤ maxConcurrency）
            │       ├─ 已处理且开启跳过 → 标记 skipped
            │       ├─ runOcr()
            │       │     ├─ 本地：LocalOcrEngine.recognize(ArrayBuffer)
            │       │     └─ 远程：fileToBase64 → callOcrApi → groupTextByRows
            │       ├─ 失败 → console.error，标记 error
            │       └─ Notice "OCR: K/N done…"（每张完成后更新）
            │
            ├─ Phase 2（倒序串行插入）
            │       └─ 将成功结果写入 workingContent
            │
            ├─ editor.setValue(workingContent)   ← 单步撤销
            │
            └─ Notice "OCR complete: N image(s) processed."
                 或 "N succeeded, M failed. Check console for details."
```

### 设置面板布局

```
OCR Images
──────────────────────────────────────
OCR Engine
──────────────────────────────────────
OCR mode                   [Auto (local → remote) ▾]

Local OCR Engine
──────────────────────────────────────
✅ Runtime installed (onnxruntime-node ready)
  - 或 -
⚠️ Runtime not installed.
  Setup local runtime        [Setup]

Model tier                 [Small (balanced) ▾]
Unload local engine        [Unload]   ← 仅引擎 ready 时显示

Remote OCR Server
──────────────────────────────────────
API URL                    [____________]
Test connection            [Test]

Output
──────────────────────────────────────
Output format              [Callout ▾  ]
Skip already-processed     [●]
Max concurrency            [──●────] 3

Remote Enhancement Options
──────────────────────────────────────
Document orientation classify  [○]
Document unwarping             [○]
Text line orientation          [○]

Detection Thresholds
──────────────────────────────────────
Pixel detection threshold  [______] (e.g. 0.3)
Box detection threshold    [______] (e.g. 0.6)
Unclip ratio               [______] (e.g. 1.6)
Recognition score thresh   [______] (e.g. 0.5)
Detection side length      [______] (e.g. 960)
Side length limit type     [Server default ▾]

Diagnostics
──────────────────────────────────────
Developer mode             [○]
```

---

## 8. 发布计划

| 版本 | 内容 |
|------|------|
| v1.0.0 | 核心 OCR 功能、设置面板、双语法支持、双输出格式 |
| v1.1.0 | 并发处理（可配置最大并发数）、空间行分组保持原图布局、空结果报错、开发者模式、修正 API 响应字段（`rec_texts`）、修复图片读取改用 `app://` 协议 |
| v1.2.0 | 重新对已 OCR 的笔记执行时，自动检测并强制重跑所有图片，替换旧 OCR 块 |
| **v1.3.0**（当前） | 本地 OCR 引擎（PaddleOCR v6 via ONNX Runtime）、三模式切换（remote/local/auto）、运行时一键安装、模型分级、全面错误处理（所有异步路径 try/catch，错误必达控制台）、修复 Electron 跨协议模块加载问题（ppu-bundle.cjs） |
| v1.4（计划） | 右键菜单「OCR This Image」单张触发 |
| v1.5（计划） | 自动 OCR：新图片粘贴入笔记时自动触发 |

---

## 9. 风险与缓解

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|---------|
| 远程 OCR 服务不可用 | 中 | 高 | 连通性测试按钮；单张失败不中断批处理；auto 模式自动降级到本地 |
| 运行时安装失败（网络问题） | 中 | 中 | 安装失败显示完整错误信息；可重试；本地失败时 auto 模式仍可走远程 |
| 本地引擎内存占用（~200 MB ONNX session） | 中 | 中 | 提供"Unload"按钮手动释放；插件卸载时自动 destroy |
| Electron 版本更新导致模块加载行为变化 | 低 | 高 | `ppu-bundle.cjs` 方案依赖 Node.js CJS require，与 Electron 版本无关 |
| 大图片 Base64 内存占用 | 低 | 中 | 8192 字节分块转换；本地模式直接传 ArrayBuffer，无此问题 |
| 图片路径解析失败 | 中 | 低 | 三级回退策略（精确路径 → metadataCache → basename 搜索） |
| 偏移量计算错误导致文本插入位置错误 | 低 | 高 | 从后往前处理；单次 setValue 写回 |
| 重复插入 OCR 内容 | 中 | 中 | 默认开启幂等检测，检查图片后 200 字符 |
| 并发请求压垮远程 OCR 服务 | 低 | 中 | `maxConcurrency` 默认 3，用户可调低 |
| 模型文件下载失败（GitHub LFS） | 低 | 中 | ppu-paddle-ocr 内置缓存；失败时抛出明确错误，auto 模式降级到远程 |
