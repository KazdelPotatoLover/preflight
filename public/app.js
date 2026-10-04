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
  waiting_for_decision: "等待决策",
  reported_completed: "已报告完成",
  waiting: "等待决策",
};
const eventLabels = {
  "goal.created": "登记了目标",
  "change.created": "开始了工作",
  "change.joined": "加入了工作",
  "change.updated": "更新了进展",
  "findings.published": "分享了发现",
  "decision.created": "提出了决策",
  "decision.attached": "关联了共同决策",
  "decision.resolved": "作出了裁决",
};
let project,
  filter = "all",
  loading = false;
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
  return `<article class="work"><div class="work-title"><span>${escape(c.title)}</span>${badge(c.waiting_for_decision ? "waiting" : c.status)}</div><div class="work-meta"><span>${escape(c.created_by)}</span><span>${escape(c.branch ?? "尚未关联分支")}</span><span>${escape(c.id.slice(0, 8))}</span><span>v${c.version}</span></div>${c.likely_scope.length ? `<div class="scope">${c.likely_scope.map(escape).join(" · ")}</div>` : ""}<details><summary>查看进展与验收</summary><p>${escape(c.summary)}</p>${v ? `<div class="verification"><strong>${v.result === "passed" ? "✓ 已报告验证通过" : "验证失败"}</strong><div class="scope">${escape(v.command)} · ${escape(v.head_sha.slice(0, 10))}</div><ul>${v.criteria.map((r) => `<li>${r.passed ? "✓" : "×"} 条件 ${r.index + 1}：${escape(r.evidence)}</li>`).join("")}</ul></div>` : '<p class="muted">尚未报告验证结果。</p>'}${c.pr_url ? `<a href="${escape(c.pr_url)}" target="_blank" rel="noopener noreferrer">查看 Pull Request ↗</a>` : ""}</details></article>`;
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
              ? c.waiting_for_decision
              : filter === "completed"
                ? c.status === "completed"
                : !["completed", "abandoned"].includes(c.status) &&
                  !c.waiting_for_decision),
        );
        if (filter !== "all" && !work.length) return "";
        return `<article class="goal-card"><div class="goal-head"><div class="section-heading"><h3>${escape(goal.title)}</h3>${badge(goal.progress)}</div><p>${escape(goal.objective)}</p><ul class="criteria">${goal.acceptance.map((a) => `<li>${escape(a)}</li>`).join("")}</ul><span class="small muted">${escape(goal.id.slice(0, 8))} · ${all.length} 项工作</span></div>${work.length ? work.map(workCard).join("") : '<div class="work muted small">等待 Agent 开始工作。通过 MCP 查询项目可获取目标 ID。</div>'}</article>`;
      })
      .join("") ||
    '<div class="empty">这里还没有符合条件的工作。登记一个目标，或让 Agent 通过 MCP 开始协作。</div>';
}
function render() {
  $("repo").textContent = `${project.repo} / ${project.actor.member}`;
  $("metrics").innerHTML = [
    ["团队目标", project.summary.goals],
    ["正在开展", project.summary.active_changes],
    ["等待裁决", project.summary.pending_decisions],
    ["已报告完成", project.summary.completed_changes],
  ]
    .map(
      ([label, value], i) =>
        `<div class="metric ${i === 2 ? "attention" : ""}"><span>${label}</span><strong>${value}</strong></div>`,
    )
    .join("");
  renderGoals();
  const pending = project.decisions.filter((d) => d.status === "pending");
  $("decision-count").textContent = pending.length;
  $("decisions").innerHTML =
    pending
      .map(
        (d) =>
          `<article class="decision"><h3>${escape(d.question)}</h3><p class="context">${escape(d.context)}</p><div class="impact">${d.urgency === "blocking" ? "正在等待此决策" : "涉及"} · ${d.affected_change_ids.length} 项工作</div><form data-decision="${d.id}" data-version="${d.version}">${d.options.map((o) => `<label class="option"><input type="radio" name="option" value="${o.id}" required><strong>${escape(o.label)} ${o.label === d.recommendation ? "· Agent 建议" : ""}</strong><small>${escape(o.description)}</small>${o.pros.length ? `<small>收益：${o.pros.map(escape).join("；")}</small>` : ""}${o.cons.length ? `<small>取舍：${o.cons.map(escape).join("；")}</small>` : ""}</label>`).join("")}<label>裁决说明<textarea name="resolution" required maxlength="2000" placeholder="说明这次选择的依据"></textarea></label><button class="primary">确认裁决</button></form></article>`,
      )
      .join("") ||
    '<div class="empty">暂时没有待处理的决策。<br>Agent 可以继续开展工作。</div>';
  const resolved = project.decisions
    .filter((d) => d.status === "human_resolved")
    .slice(0, 3);
  $("decisions").innerHTML += resolved
    .map(
      (d) =>
        `<article class="decision"><h3>${escape(d.question)}</h3><div class="resolved-note">✓ ${escape(d.resolved_by)} 已裁决<p>${escape(d.resolution)}</p></div></article>`,
    )
    .join("");
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
$("decisions").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target,
    button = form.querySelector("button"),
    fields = new FormData(form);
  button.disabled = true;
  const input = {
    expected_version: Number(form.dataset.version),
    option_id: fields.get("option"),
    resolution: fields.get("resolution"),
  };
  const fingerprint = JSON.stringify(input);
  if (form.dataset.fingerprint !== fingerprint) {
    form.dataset.requestId = crypto.randomUUID();
    form.dataset.fingerprint = fingerprint;
  }
  try {
    await api(`/api/v1/decisions/${form.dataset.decision}/resolve`, {
      ...input,
      request_id: form.dataset.requestId,
    });
    await refresh();
    message("裁决已保存。相关 Agent 下次读取上下文时将收到结果。");
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
