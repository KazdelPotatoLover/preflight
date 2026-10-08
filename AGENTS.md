# 仓库协作约定

## 快速迭代工作流

当前快速迭代阶段默认在 `main` 开发和提交，不为每次变更新建分支或要求 PR。已在功能分支完成并验证的变更，优先通过 fast-forward 合入 `main`，保留原有提交历史。

用户明确要求隔离开发、分支或 PR 时遵循其要求。推送按用户当前授权执行；推送前同步远端并检查分歧，运行相关验证，不跳过仓库保护规则，不使用 force push。

## Git 提交格式

使用 Conventional Commits，标题格式为：

```text
<type>(<scope>): <英文简短描述>
```

`scope` 可选，省略时写作 `<type>: <英文简短描述>`。标题使用英文，简洁描述这次提交的实际变更；必要时在正文补充原因和验证结果。

常用 `type`：

- `feat`：新增功能。
- `fix`：修复缺陷。
- `docs`：文档变更。
- `refactor`：不改变功能行为的代码重构。
- `test`：测试变更。
- `chore`：工程配置、依赖或维护工作。

`scope` 使用受影响的模块名称，例如 `mcp`、`board`、`auth`。

示例：

```text
feat: add shared MCP collaboration MVP
fix(auth): reject expired credentials
docs: document commit message conventions
```

提交前检查变更范围，运行与变更相关的验证，并确认没有包含凭据或本地运行文件。已有提交不因采用此格式而自动改写；推送使用正常 push，不使用 force push。
