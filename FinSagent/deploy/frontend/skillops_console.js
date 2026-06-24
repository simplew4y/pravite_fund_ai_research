let skillopsData = null;
let selectedCandidate = null;

const stateLabels = {
    ready_for_review: "Ready for review",
    needs_more_tests: "Needs more tests",
    approved: "Approved",
    rejected: "Rejected"
};

function escapeHtml(value) {
    return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function statusClass(value) {
    const text = String(value || "").toLowerCase();
    if (text === "pass" || text === "approve" || text === "approved" || text.includes("ready")) return "pass";
    if (text === "pending" || text.includes("review") || text.includes("more")) return "pending";
    if (text === "not_applicable") return "not-applicable";
    if (text === "high") return "high";
    return "";
}

function renderSummary() {
    const summary = skillopsData.summary;
    const metrics = [
        ["Protected QA", summary.protected_result],
        ["Pending reviews", summary.pending_reviews],
        ["Approved skills", summary.approved_skills],
        ["False triggers", summary.false_triggers]
    ];
    document.getElementById("metric-strip").innerHTML = metrics.map(([label, value]) => `
        <div class="metric">
            <div class="metric-value">${escapeHtml(value)}</div>
            <div class="metric-label">${escapeHtml(label)}</div>
        </div>
    `).join("");

    document.getElementById("company-grid").innerHTML = summary.companies.map(company => `
        <article class="company-card">
            <h3>${escapeHtml(company.name)}</h3>
            <div class="company-score">${escapeHtml(company.score)}</div>
            <div class="company-meta">${escapeHtml(company.gate)}</div>
            <div class="company-meta">avg ${escapeHtml(company.avg_seconds)}s / question</div>
        </article>
    `).join("");
}

function renderQueue() {
    const queue = skillopsData.review_queue;
    document.getElementById("queue-count").textContent = queue.length;
    document.getElementById("review-list").innerHTML = queue.map(item => `
        <button class="review-item ${selectedCandidate && selectedCandidate.id === item.id ? "active" : ""}" data-id="${escapeHtml(item.id)}">
            <div class="review-title-row">
                <span class="review-title">${escapeHtml(item.title)}</span>
                <span class="tag ${statusClass(item.risk)}">${escapeHtml(item.risk)}</span>
            </div>
            <div class="review-meta-row">
                <span class="review-meta">${escapeHtml(item.company)} · ${escapeHtml(item.failure_type)}</span>
                <span class="tag ${statusClass(item.status)}">${escapeHtml(stateLabels[item.status] || item.status)}</span>
            </div>
        </button>
    `).join("");

    document.querySelectorAll(".review-item").forEach(button => {
        button.addEventListener("click", () => {
            selectedCandidate = queue.find(item => item.id === button.dataset.id);
            renderQueue();
            renderDetail();
        });
    });
}

function renderDetail() {
    const item = selectedCandidate || skillopsData.review_queue[0];
    selectedCandidate = item;
    document.getElementById("detail-company").textContent = `${item.company} · ${item.failure_type}`;
    document.getElementById("detail-title").textContent = item.title;
    const statusEl = document.getElementById("detail-status");
    statusEl.textContent = stateLabels[item.status] || item.status;
    statusEl.className = `status-pill ${statusClass(item.status)}`;
    document.getElementById("detail-question").textContent = item.question;
    document.getElementById("decision-title").textContent = item.title;
    document.getElementById("decision-note").textContent = `Recommended action: ${item.recommendation.split("_").join(" ")}`;

    renderEvidence(item);
    renderSkillCard(item);
    renderGate(item);
    renderBaselines();
}

function renderEvidence(item) {
    const evidenceHtml = item.evidence.map(evidence => `
        <article class="evidence-card">
            <div class="review-meta-row">
                <div class="evidence-source">${escapeHtml(evidence.source)}</div>
                <span class="tag">${escapeHtml(evidence.type)}</span>
            </div>
            <p class="snippet">${escapeHtml(evidence.snippet)}</p>
            <div class="anchor-list">
                ${evidence.anchors.map(anchor => `<span class="anchor">${escapeHtml(anchor)}</span>`).join("")}
            </div>
        </article>
    `).join("");

    document.getElementById("tab-evidence").innerHTML = `
        <section class="diagnosis-box">
            <div class="section-title">Failure diagnosis</div>
            <p>${escapeHtml(item.diagnosis)}</p>
        </section>
        <section class="evidence-card">
            <div class="section-title">Current answer</div>
            <p class="snippet">${escapeHtml(item.current_answer)}</p>
        </section>
        ${evidenceHtml}
    `;
}

function renderSkillCard(item) {
    const card = item.skill_card;
    const list = values => values.map(value => `<span class="anchor">${escapeHtml(value)}</span>`).join("");
    document.getElementById("tab-skill").innerHTML = `
        <div class="skill-grid">
            <section class="skill-section">
                <div class="section-title">Skill name</div>
                <p>${escapeHtml(card.name)}</p>
            </section>
            <section class="skill-section">
                <div class="section-title">Trigger</div>
                <p>${escapeHtml(card.trigger)}</p>
            </section>
            <section class="skill-section">
                <div class="section-title">Scope</div>
                <p>${escapeHtml(card.scope)}</p>
            </section>
            <section class="skill-section">
                <div class="section-title">Action</div>
                <p>${escapeHtml(card.action)}</p>
            </section>
            <section class="skill-section">
                <div class="section-title">Evidence requirements</div>
                <div class="tag-row">${list(card.evidence_requirements)}</div>
            </section>
            <section class="skill-section">
                <div class="section-title">Known risks</div>
                <div class="tag-row">${list(card.known_risks)}</div>
            </section>
        </div>
    `;
}

function renderGate(item) {
    document.getElementById("tab-gate").innerHTML = Object.entries(item.gate).map(([name, value]) => `
        <div class="gate-row">
            <div>
                <div class="section-title">${escapeHtml(name.split("_").join(" "))}</div>
                <p>${gateDescription(name)}</p>
            </div>
            <span class="tag gate-status ${statusClass(value)}">${escapeHtml(value)}</span>
        </div>
    `).join("");
}

function gateDescription(name) {
    const descriptions = {
        targeted_short: "Skill-specific regression cases confirm the intended repair.",
        core_protected: "Protected 40-question cross-company QA behavior remains intact.",
        cross_company_guard: "Checks that company-specific logic does not spill into other companies.",
        failure_bank: "Known failures do not recur after the candidate is applied.",
        profile_precedence: "Accounting-scope and direct-customer precedence boundaries pass.",
        manual_review: "A reviewer approves the evidence packet and promotion boundary."
    };
    return descriptions[name] || "Gate dimension";
}

function renderBaselines() {
    document.getElementById("tab-baseline").innerHTML = skillopsData.baseline_results.map(row => `
        <div class="baseline-row">
            <div>
                <div class="section-title">${escapeHtml(row.name)}</div>
                <p>${escapeHtml(row.description)}</p>
            </div>
            <span class="tag gate-status ${row.false_triggers === 0 ? "pass" : "pending"}">
                ${escapeHtml(row.false_triggers)} false triggers
            </span>
        </div>
    `).join("");
}

function wireTabs() {
    document.querySelectorAll(".tab").forEach(tab => {
        tab.addEventListener("click", () => {
            document.querySelectorAll(".tab").forEach(el => el.classList.remove("active"));
            document.querySelectorAll(".tab-panel").forEach(el => el.classList.remove("active"));
            tab.classList.add("active");
            document.getElementById(`tab-${tab.dataset.tab}`).classList.add("active");
        });
    });
}

function wireDecisionButtons() {
    document.querySelectorAll("[data-action]").forEach(button => {
        button.addEventListener("click", () => {
            if (!selectedCandidate) return;
            const action = button.dataset.action;
            if (action === "approve") {
                selectedCandidate.status = "approved";
                selectedCandidate.gate.manual_review = "pass";
            } else if (action === "reject") {
                selectedCandidate.status = "rejected";
                selectedCandidate.gate.manual_review = "rejected";
            } else {
                selectedCandidate.status = "needs_more_tests";
                selectedCandidate.gate.manual_review = "pending";
                selectedCandidate.gate.cross_company_guard = selectedCandidate.gate.cross_company_guard === "pass"
                    ? "pass"
                    : "pending";
            }
            renderQueue();
            renderDetail();
        });
    });
}

async function loadData() {
    const response = await fetch("skillops_console_data.json", { cache: "no-store" });
    if (!response.ok) {
        throw new Error(`Failed to load SkillOps data: ${response.status}`);
    }
    skillopsData = await response.json();
    selectedCandidate = skillopsData.review_queue[0];
    renderSummary();
    renderQueue();
    renderDetail();
}

window.addEventListener("DOMContentLoaded", async () => {
    wireTabs();
    wireDecisionButtons();
    document.getElementById("refresh-button").addEventListener("click", loadData);
    try {
        await loadData();
    } catch (error) {
        document.body.innerHTML = `<main class="layout"><section class="detail-panel"><h1>Failed to load SkillOps console</h1><p>${escapeHtml(error.message)}</p></section></main>`;
    }
});
