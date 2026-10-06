const $ = (id) => document.getElementById(id);
const escape = (value) => {
  const el = document.createElement("span");
  el.textContent = String(value ?? "");
  return el.innerHTML;
};
const labels = {
  probable: "准备开展",
  implementing: "进行中",
  verifying: "验证中",
  completed: "已报告完成",
  abandoned: "已放弃",
  planned: "待开始",
  active: "进行中",
  waiting_for_decision: "协商中",
  coordinating: "协商中",
  negotiating: "协商中",
  agent_resolved: "已达成一致",
  deferred: "待隔离处理",
  needs_input: "目标信息缺口",
  human_resolved: "历史人工结果",
  reported_completed: "已报告完成",
  waiting: "协商中",
};
const eventLabels = {
  "goal.created": "登记了目标",
  "change.created": "开始了工作",
  "change.joined": "加入了工作",
  "change.updated": "更新了进展",
  "findings.published": "分享了发现",
  "decision.created": "提出了决策",
  "decision.attached": "关联了共同决策",
  "decision.resolved": "达成了协作结果",
  "decision.reviewed": "提交了协商答复",
  "decision.deferred": "记录了隔离建议",
};
const findingLabels = {
  observation: "观察",
  hypothesis: "假设",
  root_cause: "根因",
  constraint: "约束",
  test_result: "验证结果",
};
function findingCard(finding) {
  const card = document.createElement("article");
  card.className = "finding";
  const head = document.createElement("div");
  head.className = "finding-head";
  const kind = document.createElement("span");
  kind.className = "badge";
  kind.textContent = findingLabels[finding.kind] ?? finding.kind;
  const confidence = document.createElement("span");
  confidence.textContent = `置信度 ${Math.round(finding.confidence * 100)}% · Agent 上报`;
  const time = document.createElement("time");
  time.dateTime = new Date(finding.created_at).toISOString();
  time.textContent = new Date(finding.created_at).toLocaleString("zh-CN");
  head.append(kind, confidence, time);
  const content = document.createElement("p");
  content.className = "finding-content";
  content.textContent = finding.content;
  const source = document.createElement("div");
  source.className = "finding-source";
  const title = document.createElement("strong");
  title.textContent = finding.change_title;
  const member = document.createElement("span");
  member.textContent = `${finding.member} · ${finding.agent_type}`;
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "来源标识";
  const ids = document.createElement("dl");
  for (const [label, value] of [
    ["Finding", finding.id],
    ["Change", finding.change_id],
    ["Session", finding.session_id],
  ]) {
    const term = document.createElement("dt");
    term.textContent = label;
    const definition = document.createElement("dd");
    definition.textContent = value;
    ids.append(term, definition);
  }
  details.append(summary, ids);
  source.append(title, member, details);
  if (finding.content.length > 320) {
    const expanded = document.createElement("details");
    expanded.className = "finding-long";
    const preview = document.createElement("summary");
    preview.textContent = `${finding.content.slice(0, 160)}… 展开发现`;
    expanded.append(preview, content);
    card.append(head, expanded, source);
  } else card.append(head, content, source);
  return card;
}
let project,
  filter = "all",
  findingChange = "all",
  findingData,
  findingError = "",
  findingsLoading = false,
  findingRequest = 0,
  loading = false;
function renderFindings() {
  const findings = findingData?.findings;
  const previousTitle = $("findings-change").selectedOptions[0]?.textContent;
  const select = $("findings-change");
  const choices = new Map(project.changes.map((c) => [c.id, c.title]));
  for (const finding of findings ?? [])
    choices.set(finding.change_id, finding.change_title);
  if (findingChange && findingChange !== "all" && !choices.has(findingChange))
    choices.set(findingChange, previousTitle ?? findingChange);
  select.replaceChildren();
  for (const [value, label] of [
    ["", "请选择查看范围"],
    ["all", "全仓库 · 最近发现"],
    ...[...choices].map(([id, title]) => [id, `${title} · ${id.slice(0, 8)}`]),
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  select.value = findingChange;
  const visible = findings ?? [];
  $("finding-count").textContent = visible.length;
  $("findings-note").textContent = findingData
    ? `按时间从新到旧显示${findingData.truncated ? `最近 ${findingData.limit} 条，更多历史发现未显示` : "当前范围的发现"}。置信度来自 Agent 上报。`
    : "发现内容与置信度由 Agent 上报，请结合来源核实。";
  $("findings").dataset.state = findingsLoading ? "loading" : findingError ? "error" : findingData ? "ready" : "idle";
  $("findings").replaceChildren(...visible.map(findingCard));
  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = findingsLoading
      ? "正在读取发现…"
      : findingError
        ? `发现读取失败：${findingError}。可点击刷新重试。`
        : !findingChange
          ? "选择一项工作或全仓库，查看团队共享的发现。"
          : findingChange === "all"
            ? "本仓库暂时没有共享发现。"
            : "这项工作尚未共享发现。";
    $("findings").append(empty);
  }
}
async function refreshFindings() {
  const request = ++findingRequest;
  findingData = undefined;
  findingError = "";
  findingsLoading = Boolean(findingChange);
  renderFindings();
  if (!findingChange) return;
  const query = new URLSearchParams(findingChange === "all"
    ? { scope: "repo" }
    : { scope: "change", change_id: findingChange });
  try {
    const data = await api(`/api/v1/findings?${query}`);
    if (request !== findingRequest) return;
    if (!Array.isArray(data?.findings)) throw new Error("服务返回的发现数据无效");
    findingData = data;
  } catch (error) {
    if (request !== findingRequest) return;
    findingError = error.message;
  } finally {
    if (request === findingRequest && project) {
      findingsLoading = false;
      renderFindings();
    }
  }
}

function message(text, error = false) {
  $("message").textContent = text;
  $("message").className = error ? "error" : "";
  $("message").hidden = false;
}
async function api(path, body) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : {},
    method: body ? "POST" : "GET",
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  if (response.status === 401) {
    project = undefined;
    findingChange = "all";
    findingData = undefined;
    findingRequest++;
    $("board").hidden = true;
    $("login-panel").hidden = false;
    $("logout").hidden = true;
  }
  if (!response.ok)
    throw new Error(payload.error?.message ?? "暂时无法连接，请稍后重试");
  return payload.data;
}
function badge(state) {
  return `<span class="badge ${escape(state)}">${escape(labels[state] ?? state)}</span>`;
}
function workCard(c) {
  const v = c.verification;
  return `<article class="work"><div class="work-title"><span>${escape(c.title)}</span>${badge((c.waiting_for_coordination ?? (c.waiting_for_coordination ?? c.waiting_for_decision)) ? "waiting" : c.status)}</div><div class="work-meta"><span>${escape(c.created_by)}</span><span>${escape(c.branch ?? "尚未关联分支")}</span><span>${escape(c.id.slice(0, 8))}</span><span>v${c.version}</span></div>${c.likely_scope.length ? `<div class="scope">${c.likely_scope.map(escape).join(" · ")}</div>` : ""}<details><summary>查看进展与验收</summary><p>${escape(c.summary)}</p>${v ? `<div class="verification"><strong>${v.result === "passed" ? "✓ 已报告验证通过" : "验证失败"}</strong><div class="scope">${escape(v.command)} · ${escape(v.head_sha.slice(0, 10))}</div><ul>${v.criteria.map((r) => `<li>${r.passed ? "✓" : "×"} 条件 ${r.index + 1}：${escape(r.evidence)}</li>`).join("")}</ul>${v.isolated_decisions?.length ? `<details><summary>已报告的隔离证据 · ${v.isolated_decisions.length} 项</summary>${v.isolated_decisions.map((record) => `<div class="scope">${escape(record.decision_id)}</div><p>措施：${escape(record.mitigation)}</p><p>证据：${escape(record.evidence)}</p>`).join("")}</details>` : ""}</div>` : '<p class="muted">尚未报告验证结果。</p>'}${c.pr_url ? `<a href="${escape(c.pr_url)}" target="_blank" rel="noopener noreferrer">查看 Pull Request ↗</a>` : ""}</details></article>`;
}
function renderGoals() {
  $("goals").innerHTML =
    project.goals
      .map((goal) => {
        const all = project.changes.filter((c) => c.goal_id === goal.id);
        const work = all.filter(
          (c) =>
            filter === "all" ||
            (filter === "waiting"
              ? (c.waiting_for_coordination ?? c.waiting_for_decision)
              : filter === "completed"
                ? c.status === "completed"
                : !["completed", "abandoned"].includes(c.status) &&
                  !(c.waiting_for_coordination ?? c.waiting_for_decision)),
        );
        if (filter !== "all" && !work.length) return "";
        return `<article class="goal-card"><div class="goal-head"><div class="section-heading"><h3>${escape(goal.title)}</h3>${badge(goal.progress)}</div><p>${escape(goal.objective)}</p><ul class="criteria">${goal.acceptance.map((a) => `<li>${escape(a)}</li>`).join("")}</ul><span class="small muted">${escape(goal.id.slice(0, 8))} · ${all.length} 项工作</span></div>${work.length ? work.map(workCard).join("") : '<div class="work muted small">等待 Agent 开始工作。通过 MCP 查询项目可获取目标 ID。</div>'}</article>`;
      })
      .join("") ||
    '<div class="empty">这里还没有符合条件的工作。登记一个目标，或让 Agent 通过 MCP 开始协作。</div>';
}
function textNode(parent, tag, text, className = "") {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = typeof text === "string" ? text : JSON.stringify(text ?? "", null, 2);
  parent.append(node);
  return node;
}
function workLabel(id) {
  const change = project.changes.find((c) => c.id === id);
  return change ? `${change.title} · ${id.slice(0, 8)}` : id;
}
function coordinationCard(decision) {
  const card = document.createElement("article");
  card.className = "decision coordination-card";
  card.dataset.decision = decision.id;
  card.dataset.status = decision.status;
  const head = textNode(card, "div", "", "section-heading");
  textNode(head, "h3", decision.question);
  textNode(head, "span", labels[decision.status] ?? "历史待协商", "badge");
  const reviews = decision.current_reviews ?? [];
  const missing = decision.missing_change_ids ?? [];
  const required = decision.required_change_ids ?? decision.affected_change_ids ?? [];
  textNode(card, "p", `第 ${decision.review_round ?? 1}/${decision.round_limit ?? 3} 轮 · ${reviews.length}/${required.length} 项工作已答复`, "coordination-progress");
  if (reviews.length) textNode(card, "p", `已答复：${reviews.map((r) => `${r.member}（${r.stance === "accept" ? "同意" : "异议"}）`).join("；")}`, "coordination-answered");
  if (missing.length) textNode(card, "p", `待答复：${missing.map(workLabel).join("；")}`, "coordination-missing");
  if (decision.status === "deferred")
    textNode(card, "p", "已达到协商轮次上限。建议隔离受影响工作、保留分歧与证据，按各自边界继续推进。", "isolation-note");
  if (decision.status === "needs_input")
    textNode(card, "p", "目标或变更边界存在信息缺口，请补充目标信息；普通技术分歧由 Agent 自行协商。", "input-note");
  if (["agent_resolved", "human_resolved"].includes(decision.status)) {
    const chosen = decision.options.find((o) => o.id === decision.option_id);
    textNode(card, "div", `${decision.status === "agent_resolved" ? "✓ Agent 已达成一致" : "历史人工结果"}${chosen ? `：${chosen.label}` : ""}`, "resolved-note");
  }
  if (decision.resolution) textNode(card, "p", decision.resolution, "coordination-resolution");
  const details = document.createElement("details");
  details.className = "coordination-evidence";
  textNode(details, "summary", "查看选项与本轮报告证据");
  textNode(details, "p", decision.context, "context");
  for (const option of decision.options) {
    const item = textNode(details, "div", "", "coordination-option");
    textNode(item, "strong", `${option.label}${option.label === decision.recommendation ? " · 提案建议" : ""}`);
    textNode(item, "p", option.description);
    if (option.pros?.length) textNode(item, "p", `收益：${option.pros.join("；")}`);
    if (option.cons?.length) textNode(item, "p", `取舍：${option.cons.join("；")}`);
  }
  function appendReview(parent, review) {
    const report = textNode(parent, "section", "", "coordination-review");
    const round = review.review_round ?? review.round;
    if (round) textNode(report, "p", `第 ${round} 轮`, "small muted");
    const option = decision.options.find((o) => o.id === review.option_id);
    textNode(report, "h4", `${review.member} · ${review.stance === "accept" ? "同意" : "提出异议"}${option ? ` · ${option.label}` : ""}`);
    textNode(report, "p", workLabel(review.change_id), "small muted");
    textNode(report, "p", review.rationale);
    for (const [key, label] of [["goal_alignment", "目标一致性"], ["constraints_check", "约束核查"], ["verification", "验证证据"]]) {
      textNode(report, "strong", label);
      textNode(report, "p", review.evidence?.[key], "review-evidence-text");
    }
  }
  for (const review of reviews) appendReview(details, review);
  if (!reviews.length) textNode(details, "p", "本轮尚无 Agent 答复。", "muted");
  if (decision.review_history?.length) {
    const history = document.createElement("details");
    history.className = "coordination-history";
    textNode(history, "summary", "查看历史轮次答复");
    for (const review of decision.review_history) appendReview(history, review);
    details.append(history);
  }
  card.append(details);
  return card;
}
function renderCoordination() {
  const gaps = project.decisions.filter((d) => d.status === "needs_input");
  const items = project.decisions.filter((d) => d.status !== "needs_input");
  $("decision-count").textContent = items.filter((d) => d.status === "negotiating").length;
  $("coordination-summary").textContent = `已达成 ${project.summary.resolved_decisions ?? items.filter((d) => d.status === "agent_resolved").length} · 隔离建议 ${project.summary.deferred_decisions ?? items.filter((d) => d.status === "deferred").length}`;
  $("decisions").replaceChildren(...items.map(coordinationCard));
  if (!items.length) textNode($("decisions"), "div", "当前没有待协商事项。Agent 可继续开展工作。", "empty");
  $("input-gaps-panel").hidden = gaps.length === 0;
  $("input-gaps").replaceChildren(...gaps.map(coordinationCard));
}
function render() {
  $("repo").textContent = `${project.repo} / ${project.actor.member}`;
  $("metrics").innerHTML = [
    ["团队目标", project.summary.goals],
    ["正在开展", project.summary.active_changes],
    ["协商中", project.summary.negotiating_decisions ?? 0],
    ["已报告完成", project.summary.completed_changes],
  ]
    .map(
      ([label, value], i) =>
        `<div class="metric ${i === 2 ? "attention" : ""}"><span>${label}</span><strong>${value}</strong></div>`,
    )
    .join("");
  renderGoals();
  renderFindings();
  renderCoordination();
  $("events").innerHTML =
    project.events
      .map(
        (e) =>
          `<div class="event">${escape(e.actor)} ${escape(eventLabels[e.action] ?? e.action)}<time>${new Date(e.created_at).toLocaleString("zh-CN")}</time></div>`,
      )
      .join("") || '<p class="muted">团队动态会在这里出现。</p>';
  $("updated").textContent = `更新于 ${new Date().toLocaleTimeString("zh-CN")}`;
}
async function refresh(silent = false) {
  if (
    loading ||
    (silent &&
      (document.activeElement?.closest("form") || $("goal-dialog").open))
  )
    return;
  loading = true;
  try {
    project = await api("/api/v1/atlas");
    $("board").hidden = false;
    $("login-panel").hidden = true;
    $("logout").hidden = false;
    $("connection").textContent = "团队已连接";
    $("connection-dot").className = "dot online";
    render();
    await refreshFindings();
  } catch (error) {
    $("connection").textContent = "未连接或数据已过期";
    $("connection-dot").className = "dot offline";
    if (!silent) message(error.message, true);
  } finally {
    loading = false;
  }
}
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  try {
    await api("/auth/login", { token: $("token").value });
    $("token").value = "";
    $("message").hidden = true;
    await refresh();
  } catch (error) {
    message(error.message, true);
  } finally {
    button.disabled = false;
  }
});
$("logout").addEventListener("click", async () => {
  try {
    await api("/auth/logout", {});
    project = undefined;
    findingChange = "all";
    findingRequest++;
    findingData = undefined;
    findingError = "";
    $("board").hidden = true;
    $("login-panel").hidden = false;
    $("logout").hidden = true;
    $("connection").textContent = "已退出";
    $("connection-dot").className = "dot";
  } catch (error) {
    message(error.message, true);
  }
});
$("refresh").addEventListener("click", () => refresh());
$("findings-change").addEventListener("change", (event) => {
  findingChange = event.target.value;
  void refreshFindings();
});
$("new-goal").addEventListener("click", () => $("goal-dialog").showModal());
$("close-goal").addEventListener("click", () => $("goal-dialog").close());
$("goal-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget,
    button = form.querySelector(".primary");
  button.disabled = true;
  const fields = new FormData(form);
  const input = {
    title: fields.get("title"),
    objective: fields.get("objective"),
    acceptance: String(fields.get("acceptance"))
      .split("\n")
      .map((v) => v.trim())
      .filter(Boolean),
  };
  const fingerprint = JSON.stringify(input);
  if (form.dataset.fingerprint !== fingerprint) {
    form.dataset.requestId = crypto.randomUUID();
    form.dataset.fingerprint = fingerprint;
  }
  try {
    await api("/api/v1/tools/preflight_register_goal", {
      ...input,
      request_id: form.dataset.requestId,
    });
    form.reset();
    delete form.dataset.requestId;
    delete form.dataset.fingerprint;
    $("goal-dialog").close();
    await refresh();
    message("目标已登记，团队 Agent 现在可以查询并开始工作。");
  } catch (error) {
    message(error.message, true);
  } finally {
    button.disabled = false;
  }
});
document.querySelectorAll("[data-filter]").forEach((button) =>
  button.addEventListener("click", () => {
    filter = button.dataset.filter;
    document
      .querySelectorAll("[data-filter]")
      .forEach((b) => b.classList.toggle("active", b === button));
    renderGoals();
  }),
);
void refresh(true);
setInterval(() => {
  if (project && !document.hidden) void refresh(true);
}, 10000);
