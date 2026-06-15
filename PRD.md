# PRD — OCR Images Obsidian Plugin

**文档版本**：1.0  
**日期**：2026-06-15  
**作者**：wangrunyu  
**状态**：已实现（v1.0.0）

---

## 1. 背景与问题

Obsidian 用户在整理笔记时，大量使用截图、扫描件、照片等图片来记录信息（会议白板、纸质文件、技术截图等）。这些图片中的文字内容无法被 Obsidian 的全文搜索索引，也无法直接复制和引用，造成信息孤岛。

**核心痛点**：

1. 图片中的文字不可搜索 — 查找笔记时无法通过关键词命中图片内容
2. 文字提取成本高 — 需要手动打开外部 OCR 工具、逐张处理、再粘贴回笔记
3. 已有 OCR 基础设施未被利用 — 用户已部署了 PaddleX OCR 服务（PP-OCRv5），但缺少与 Obsidian 集成的入口

---

## 2. 目标

**主要目标**：为 Obsidian 用户提供一键 OCR 能力，将笔记中所有图片的文字识别结果自动插入到图片下方，使图片内容可搜索、可引用。

**成功指标**：

- 用户从触发命令到看到识别结果的时间 < 单张图片 API 响应时间 + 1s
- 识别结果正确插入到对应图片下方，不破坏原有 Markdown 结构
- 一批图片处理完成后，整个操作可以通过一次 `Cmd+Z` 撤销

---

## 3. 用户故事

| ID | 角色 | 需求 | 价值 |
|----|------|------|------|
| US-1 | 知识工作者 | 打开含有会议白板截图的笔记，一键提取所有文字 | 白板内容进入搜索索引，可被后续笔记引用 |
| US-2 | 研究员 | 笔记中有论文扫描图，希望提取表格和段落文字 | 无需切换工具，在 Obsidian 内完成全流程 |
| US-3 | 开发者 | 笔记嵌入了报错截图（URL 图片），希望提取错误信息 | 错误文字可被搜索和复制 |
| US-4 | 任意用户 | 对同一篇笔记多次运行 OCR，不希望重复插入 | 结果幂等，不产生冗余内容 |
| US-5 | 任意用户 | 识别效果不好时，希望能调整检测参数 | 通过设置面板微调，不需要修改代码 |

---

## 4. 功能范围

### 4.1 In Scope（v1.0）

**F-1 命令触发**  
注册 Obsidian 命令 `OCR Images in Current Note`，在命令面板（`Cmd+P`）中可调用，作用于当前活跃的 Markdown 文件。

**F-2 图片识别**  
支持以下两种 Obsidian 图片语法：

- Obsidian wikilink：`![[image.png]]`、`![[image.png|alt]]`
- 标准 Markdown：`![alt](path/to/image.png)`、`![alt](https://example.com/img.jpg)`

支持图片格式：`png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`, `svg`, `tiff`, `avif`

**F-3 本地图片处理**  
通过 Obsidian Vault API 读取图片二进制内容，转为 Base64，发送到 OCR 后端。文件路径解析优先级：
1. 精确 vault 路径匹配
2. Obsidian `metadataCache` wikilink 解析
3. 全 vault basename 搜索

**F-4 URL 图片处理**  
HTTP/HTTPS 图片 URL 直接传给 OCR 后端，不在客户端下载。

**F-5 OCR API 调用**  
向配置的 `POST /ocr` 端点发送请求，提取响应中 `result.ocrResults[0].prunedResult.texts` 数组。使用 Obsidian 内置 `requestUrl` 绕过 CORS 限制。请求超时：60 秒。

**F-6 文本插入**  
将识别文本插入到图片 token 正后方。两种格式可选：

- **Callout**（默认）：`> [!note]+ OCR: filename\n> text...`，可折叠
- **Code block**：` ```ocr\ntext\n``` `

**F-7 幂等处理**  
插入前检查图片后方 200 字符内是否已存在 OCR 块，存在则跳过（可在设置中关闭）。

**F-8 批量处理与进度反馈**  
按文档顺序（从后往前处理保证偏移量稳定）处理所有图片，通过 `Notice` 实时显示进度。所有修改通过一次 `editor.setValue()` 完成，保证单步撤销。

**F-9 设置面板**  
提供完整的设置 UI：

- API URL 配置
- 输出格式选择
- 幂等开关
- OCR 增强选项（文档方向、畸变矫正、文本行方向）
- 检测阈值（6 个数值参数，留空则使用服务端默认值）
- 连通性测试按钮

### 4.2 Out of Scope（v1.0）

- PDF 文件 OCR（API 支持，但 Obsidian 不将 PDF 嵌入为图片语法）
- 选区 OCR（只处理光标选中的图片）
- 后台自动 OCR（新图片插入时自动触发）
- 结果编辑 UI（识别后的文字修正）
- 离线 OCR（不依赖外部服务）
- 多语言 UI（当前为英文界面）

---

## 5. 技术设计

### 5.1 架构

```
Obsidian Plugin (Electron Renderer)
        │
        ├── Command: "OCR Images in Current Note"
        │       │
        │       ├── extractImages(content)     正则解析图片引用
        │       ├── fileToBase64(vault, path)  读取本地图片
        │       ├── callOcrApi(settings, ...)  HTTP 请求 OCR 服务
        │       └── editor.setValue(result)    写回编辑器
        │
        └── SettingTab                         设置面板
                │
                └── loadData() / saveData()    持久化配置
```

### 5.2 关键技术决策

| 决策 | 选择 | 理由 |
|------|------|------|
| HTTP 客户端 | `requestUrl`（Obsidian 内置） | 绕过 Electron renderer 的 CORS 和混合内容限制 |
| 图片读取 | `vault.readBinary()` | 访问 vault 文件的标准 API |
| Base64 转换 | 手动分块 `btoa`（8192B/chunk） | 避免大文件时 V8 调用栈溢出 |
| 插入顺序 | 从后往前 | 保证前面图片的字符偏移量在后续插入后仍然有效 |
| 写回方式 | 单次 `editor.setValue()` | 一个撤销记录，比多次 `replaceRange` 用户体验更好 |
| 编译 | esbuild（CJS 输出） | Obsidian 官方推荐的构建方式 |

### 5.3 OCR API 交互

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
          "texts": ["识别到的文本行1", "文本行2"],
          "scores": [0.98, 0.95]
        }
      }
    ]
  }
}
```

**错误处理**：`errorCode != 0` 时抛出错误，记录到控制台，计入失败计数，继续处理其余图片。

---

## 6. 非功能性需求

| 类别 | 要求 |
|------|------|
| 性能 | 单张图片处理耗时 = OCR API 响应时间（网络 I/O 主导），本地开销可忽略 |
| 可靠性 | 单张图片失败不中断整批，最终汇报成功/失败数量 |
| 安全性 | 图片内容仅发送到用户配置的自有 OCR 服务，不经过任何第三方 |
| 兼容性 | Obsidian ≥ 1.7.2，仅桌面端（需要文件系统访问） |
| 可维护性 | 全部逻辑集中在 `src/main.ts` 单文件，依赖项最少 |

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
            ├─ Notice "OCR: 1/N — filename.png"（实时更新）
            │
            ├─ [逐张处理]
            │       ├─ 已处理且开启跳过 → 跳过
            │       ├─ 读取/获取图片 → 调用 API → 插入文本
            │       └─ 失败 → 记录错误，继续下一张
            │
            └─ Notice "OCR complete: N image(s) processed."
                 或 "N succeeded, M failed."（4秒后消失）
```

### 设置面板布局

```
OCR Images
──────────────────────────────────────
API URL                    [____________]
Output format              [Callout ▾  ]
Skip already-processed     [●]

Enhancement Options
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
Test connection            [Test]
```

---

## 8. 发布计划

| 版本 | 内容 |
|------|------|
| **v1.0.0**（当前） | 核心 OCR 功能、设置面板、双语法支持、双输出格式 |
| v1.1（计划） | 右键菜单「OCR This Image」单张触发 |
| v1.2（计划） | 自动 OCR：新图片粘贴入笔记时自动触发 |
| v2.0（探索） | 脱离外部服务，集成轻量本地 OCR 模型 |

---

## 9. 风险与缓解

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|---------|
| OCR 服务不可用 | 中 | 高 | 连通性测试按钮；单张失败不中断批处理；错误提示含详情 |
| 大图片 Base64 内存占用 | 低 | 中 | 8192 字节分块转换；超时保护 |
| 图片路径解析失败 | 中 | 低 | 三级回退策略（精确路径 → metadataCache → basename 搜索） |
| 偏移量计算错误导致文本插入位置错误 | 低 | 高 | 从后往前处理；单次 setValue 写回；充分测试 |
| 重复插入 OCR 内容 | 中 | 中 | 默认开启幂等检测，检查图片后 200 字符 |
