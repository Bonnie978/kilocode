# Vibe-coding 协作方案

> 用 kilo-web 替代 PRD：让每个人（产品 / 设计 / 工程）打开浏览器，直接让 AI agent 改插件本身，把"想要的功能"做成一个**能跑的原型**而不是 Word 文档。

---

## 分支策略

三层模型，职责清晰：

```
stable           ← 永远稳定的基线。任何时候改坏了都能从这里找回。
   │              只有 lead 在"确认这版上线"时才往这里合。
   │
main             ← 当前 demo 集成版（团队 clone 默认拿这个）。
   │              feat 分支验证可行后 PR 合进来，给研发 / 老板看。
   │
feat/<你>-<X>   ← 个人实验分支。自由切、自由改、自由删。
                  跑通了开 PR 回 main。
```

### 各层职责

| 分支 | 谁能直接 push | 什么时候动 |
|---|---|---|
| `stable` | lead 一人 | demo 确认上线、拍板"就这版"之后，把 main → stable 合一次 |
| `main` | 禁止直接 push | 只接受来自 `feat/*` 的 PR merge |
| `feat/<你>-<X>` | 各自 | 每个人随时在自己分支干 |

### 四阶段工作流

```
① 起步   git checkout -b feat/<你>-<想法> main
          → vibe coding → push 自己分支

② demo   开 PR: feat/<你>-<X> → main
          → merge → 给研发看 demo

③ 反馈   评审后"X 要改" → 继续在 feat 上改 → 重新 PR → merge main

④ 上线   功能确认上线 → lead 执行:
          git checkout stable
          git merge main
          git push origin stable
```

### 紧急回滚

任何时候 main 改坏、找不到之前状态：

```bash
# 查看 stable 当前状态
git log stable --oneline -10

# 把本地 main 重置到 stable（本地操作，不影响远端）
git checkout main
git reset --hard stable

# 或者直接从 stable 切一个新的 feat 分支重新来过
git checkout -b feat/<你>-fix stable
```

---

## 为什么这样工作可行

`packages/kilo-web` 是 kilocode 浏览器版，连本地 `opencode serve`。它本质上是一个**会改自己的产品**：

- 你在 kilo-web 里输入"把发送按钮颜色改成绿色"
- AI agent 真的去改 `packages/kilo-vscode/webview-ui/src/...` 的代码
- Vite HMR 几秒后刷新，你浏览器里立即看到效果
- 满意 → commit + push + 开 PR

这就是"vibe coding"——**用产品改产品，所见即所得**。

---

## 一次性环境准备

每个参与者都要做一次：

```bash
# 1. fork https://github.com/Kilo-Org/kilocode 到自己 GitHub
# 2. clone 自己的 fork
git clone git@github.com:<你>/kilocode.git
cd kilocode
git remote add upstream https://github.com/Kilo-Org/kilocode.git
git remote add bonnie https://github.com/Bonnie978/kilocode.git  # 我们这边的 fork

# 3. 拿 feat/kilo-web 分支
git fetch bonnie
git checkout -b feat/kilo-web bonnie/feat/kilo-web

# 4. 装 bun
brew install oven-sh/bun/bun

# 5. 装依赖
bun install

# 6. 写 AI 模型配置（任选一个 provider，下面是 newapi 示例）
# 文件：~/.config/kilo/kilo.json
cat > ~/.config/kilo/kilo.json <<'EOF'
{
  "model": "newapi/glm-5.1",
  "small_model": "newapi/glm-5.1",
  "provider": {
    "newapi": {
      "name": "NewAPI",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://<你的 newapi host>/v1",
        "apiKey": "sk-..."
      },
      "models": {
        "glm-5.1": {
          "id": "glm-5.1",
          "name": "GLM 5.1",
          "tool_call": true,
          "limit": { "context": 128000, "output": 16384 }
        }
      }
    }
  },
  "permission": { "bash": "ask" }
}
EOF

# 7. 起两个进程（两个终端窗口）
bun run serve   # → http://127.0.0.1:8787 (后端 agent server)
bun run web     # → http://127.0.0.1:5173 (浏览器 UI)
```

打开 http://127.0.0.1:5173 就是你的 vibe-coding 工作台。

详细 troubleshooting 见 `docs/kilo-web/runbook.md`。

---

## 日常 vibe-coding 工作流

```
┌────────────────────────────────────────────────────────────────┐
│ 1. 你在 kilo-web 里输入想法（自然语言）                          │
│    例："把侧边栏的最近会话列表加上图标"                          │
│                                                                │
│ 2. Agent 调 read/grep 找代码 → 改文件 → 让你审批 → 写入           │
│    你随时看 diff，不满意点"拒绝"                                │
│                                                                │
│ 3. Vite HMR 自动刷新浏览器，几秒后看效果                          │
│                                                                │
│ 4. 满意 → 在终端跑 git diff 看改动                              │
│                                                                │
│ 5. git checkout -b feat/<你>-<想法名>                          │
│    git commit + push + 开 PR                                  │
└────────────────────────────────────────────────────────────────┘
```

## 角色分工

| 角色 | 主要做什么 | 不需要做什么 |
|---|---|---|
| **产品 / 设计** | 在 kilo-web 里描述想法，让 agent 出原型；PR 标题说明意图 | 不需要懂代码细节 |
| **工程师** | review PR 看 agent 改对没；本地拉 PR 跑一遍；merge 后 release | 不需要重复 PM 已经做的 vibe 阶段 |

## 分支命名

```
feat/<你>-<想法>              # 新功能原型
fix/<你>-<bug>                # 修 bug
exp/<你>-<实验>               # 探索性，可能不 merge
```

例：`feat/bonnie-side-history-icons`、`fix/wenhao-empty-dropdown`。

## 避免互相覆盖的几条铁律

1. **永远在自己分支干**，永远不在 `feat/kilo-web` / `main` 直接提交
2. **开干前 pull**：`git pull bonnie feat/kilo-web --rebase`
3. **小步 PR**：一个想法一个 PR，越小越快 review
4. **改 webview-ui/src/ 的代码大家都看得见** → 改之前 Slack 喊一声
5. **改 packages/kilo-web/ 是浏览器版自己的代码** → 影响小，随意改
6. **本地 settings 用 localStorage 隔离** → 你的偏好不会污染别人

---

## 想法 → 原型 → 落地 三阶段

### 阶段 A：想法捕获（5 分钟）

不写 PRD。**写一个 docs/user-stories/m{N}-<topic>.json**：

```json
[
  {
    "description": "侧边栏会话列表每条带项目颜色 chip",
    "steps": [
      "每个 SessionListItem 左侧多一个 8px 圆形色块",
      "颜色按 projectID hash 稳定生成（同项目永远同色）",
      "hover 显示 projectID tooltip"
    ],
    "passes": false
  }
]
```

跑 `bun run user-stories:verify` 检查格式。

### 阶段 B：vibe coding（10-60 分钟）

打开浏览器版，把 user story 整段贴进对话框：

> "看 `docs/user-stories/m5-session-chips.json`，第一条 'description'，按 steps 实现。改完用 bash 跑一遍我重新刷新浏览器看。"

Agent 会：
1. 读 user story
2. 找相关组件（`grep ConversationList` etc）
3. 改 CSS + 组件代码
4. 让你审批每个文件改动
5. Vite HMR 让你立刻看效果

满意了 → 把 user story 里 `"passes": true`。

### 阶段 C：PR & review（10 分钟）

```bash
git checkout -b feat/<你>-session-chips
git add -p          # 一行一行审改动
git commit -m "feat: session list color chips"
git push -u origin feat/<你>-session-chips
gh pr create --base feat/kilo-web --title "..." --body "..."
```

工程师 review 时**也用 vibe coding** — 拉 PR 到本地，浏览器里点几下，让 agent 解释或微调。

---

## 工具支持

| 工具 | 用途 |
|---|---|
| `bun run web` / `bun run serve` | 启动本地工作台 |
| `bun run user-stories:verify` | 检查 user story 格式 |
| `bun run ralph` | （进阶）让 Claude Code 自动循环跑 user stories |
| `bun run typecheck` | 全 monorepo typecheck（kilo-web 已跳过，因为上游有先存错） |

---

## 常见问题

**Q：整个 main 都被改坏了，找不到之前状态怎么办？**
A：`stable` 就是保险网。`git checkout -b feat/<你>-fix stable` 从稳定版重新开始，或者让 lead 把 main reset 回 stable。

**Q：Agent 改坏了怎么办？**
A：`git stash` 或 `git checkout -- <file>` 撤销。Agent 的工具有 permission 流程，每个写入都你点过运行才生效。

**Q：浏览器没刷新？**
A：F5 强刷。Vite HMR 有时丢 update。

**Q：我改了 kilo-web，影响别人的 vibe coding 吗？**
A：你的改动只在你 fork 的分支。别人不主动 pull 你的 branch 不会受影响。

**Q：原型 demo 给老板看怎么办？**
A：录屏。或者把分支 push 到 fork，把 GitHub 分支 URL 发给老板，让他自己 clone 跑（前提他装了 bun + 配了 API key）。

**Q：能直接 deploy 上线让所有人在线用吗？**
A：不能。kilo-web 当前是 Vite dev 模式，依赖本地 server。Production deploy 需要：
- `vite build` 出静态 dist
- 把 server 部署成 SaaS（每个用户分配容器）
- 这是另一个阶段的工程

---

## 下一步演化

这套协作如果跑通，可以加：

- **自动截图 PR 评论**：CI 跑 playwright，把 kilo-web 关键页截图贴回 PR
- **多人同时 vibe**：每人独立 fork + branch，每周一次"design jam"互看
- **AI review bot**：用 claude code action 让 AI 先 review PR，工程师二审
- **从 vibe 到 spec**：把跑通的 user story 翻译成正式 spec/test，进 CI

但**第一步**就是把这份协作方案跑通——一个人完成 user story → PR → merge 全流程。
