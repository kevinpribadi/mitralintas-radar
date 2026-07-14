"use strict";

(function () {
  var model = parseModel();
  var filters = { changeType: "", trigger: "", timing: "", validation: "" };
  var renderedCards = [];

  function parseModel() {
    var node = document.getElementById("report-data");
    try { return JSON.parse(node.textContent || "{}"); }
    catch (_error) { return { status: "REJECT_PROPOSAL", warnings: [], errors: ["REPORT_DATA_INVALID"] }; }
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function appendDefinition(list, label, value) {
    list.appendChild(element("dt", "", label));
    list.appendChild(element("dd", "breakable",
      value === undefined || value === null || value === "" ? "—" : value));
  }

  function safeOfficialUrl(value) {
    try {
      var parsed = new URL(value);
      return parsed.protocol === "https:" && parsed.hostname === "www.bkpm.go.id" &&
        parsed.pathname.indexOf("/id/info/siaran-pers/") === 0 ? parsed.href : "";
    } catch (_error) { return ""; }
  }

  function addSourceLink(actions, value) {
    var url = safeOfficialUrl(value);
    if (!url) return;
    var link = element("a", "source-link", "Buka sumber resmi");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    actions.appendChild(link);
  }

  function validationLabel(code) {
    var value = String(code || "");
    if (value.indexOf("ORGANIZATION_MISSING") === 0) return "Warning — Organisasi belum tersedia";
    if (value.indexOf("PUBLISHED_DATE_MISSING") === 0) return "Warning — Tanggal belum tersedia";
    if (value.indexOf("HUMAN_REVIEW_REQUIRED") === 0) return "Warning — Perlu verifikasi manusia";
    if (value.indexOf("CLASSIFICATION_HINT_UNKNOWN") === 0) return "Warning — Classification hint belum diketahui";
    if (value.indexOf("ORGANIZATION_INVALID") === 0) return "Critical error — Organisasi invalid";
    if (value.indexOf("ORGANIZATION_FABRICATION_DETECTED") === 0) return "Critical error — Organisasi fabricated";
    if (value.indexOf("PUBLISHED_DATE_INVALID") === 0) return "Critical error — Tanggal invalid";
    if (value.indexOf("PUBLISHED_DATE_FABRICATION_DETECTED") === 0) return "Critical error — Tanggal fabricated";
    if (value.indexOf("DATE_COMPLETENESS_BELOW_THRESHOLD") === 0) return "Critical error — Kelengkapan tanggal di bawah threshold";
    if (/LINK|PROVENANCE/.test(value)) return "Critical error — Link atau provenance invalid";
    return value;
  }

  function itemCard(item, changeType) {
    var card = element("article", "audit-card");
    card.dataset.changeType = changeType || "";
    card.dataset.trigger = item.detected_trigger || item.primary_trigger || "";
    card.dataset.timing = item.timing_status || "";
    card.dataset.validation = item.validation_status || "VALID";
    card.appendChild(element("span", "card-status status-" +
      (changeType === "REMOVED" ? "warning" : "valid"), changeType || "ITEM"));
    card.appendChild(element("h3", "", item.title || "Judul tidak tersedia"));
    var list = element("dl");
    appendDefinition(list, "Published date", item.published_at);
    appendDefinition(list, "Source", item.source_name || item.source_code);
    appendDefinition(list, "Organization hint", item.organization_hint || "(kosong)");
    appendDefinition(list, "Classification hint", item.classification_hint || "—");
    appendDefinition(list, "Detected trigger", item.detected_trigger || "—");
    appendDefinition(list, "Timing", item.timing_status || "—");
    if (item.timing_verification_required) {
      appendDefinition(list, "Timing verification", "Wajib — published date belum tersedia");
    }
    appendDefinition(list, "Evidence", item.evidence || "—");
    appendDefinition(list, "Human review", item.human_review_required === false ? "Tidak" : "Wajib");
    card.appendChild(list);
    var metadataMessages = element("div", "metadata-messages");
    (item.validation_messages || []).forEach(function (message) {
      var isError = /INVALID|FABRICATION|BELOW_THRESHOLD|LINK|PROVENANCE/.test(message);
      metadataMessages.appendChild(element("span", "validation-label " + (isError ? "error" : "warning"),
        validationLabel(message)));
    });
    if (metadataMessages.childNodes.length) card.appendChild(metadataMessages);
    var tags = element("div", "tag-list");
    (item.change_reasons || []).forEach(function (reason) { tags.appendChild(element("span", "tag", reason)); });
    if (tags.childNodes.length) card.appendChild(tags);
    var detail = element("div", "detail-panel");
    detail.hidden = true;
    detail.appendChild(element("pre", "", item.detail || "Tidak ada detail tambahan."));
    card.appendChild(detail);
    var actions = element("div", "card-actions");
    var toggle = element("button", "detail-toggle", "Tampilkan detail");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    toggle.addEventListener("click", function () {
      detail.hidden = !detail.hidden;
      toggle.textContent = detail.hidden ? "Tampilkan detail" : "Sembunyikan detail";
      toggle.setAttribute("aria-expanded", detail.hidden ? "false" : "true");
    });
    actions.appendChild(toggle);
    addSourceLink(actions, item.link);
    card.appendChild(actions);
    renderedCards.push(card);
    return card;
  }

  function changeCard(change, kind) {
    var item = {
      title: change.title || "Perubahan trigger",
      published_at: change.published_at || "",
      source_code: model.source_code,
      organization_hint: "",
      classification_hint: kind === "CLASSIFICATION" ? "Berubah" : "—",
      detected_trigger: change.primary_trigger || change.new && change.new.primary_trigger ||
        change.old && change.old.primary_trigger || "",
      timing_status: change.new_timing_status || "",
      evidence: kind === "EVIDENCE" ? "Evidence lama dan baru tersedia pada detail" : "—",
      human_review_required: true,
      validation_status: "VALID",
      detail: JSON.stringify(change, null, 2),
      change_reasons: [kind],
    };
    return itemCard(item, "TRIGGER");
  }

  function validationCard(message, status) {
    var card = element("article", "validation-card status-" + status.toLowerCase());
    card.dataset.changeType = "VALIDATION";
    card.dataset.trigger = "";
    card.dataset.timing = "";
    card.dataset.validation = status;
    card.appendChild(element("strong", "", status));
    card.appendChild(element("p", "breakable", validationLabel(message)));
    renderedCards.push(card);
    return card;
  }

  function renderList(containerId, values, factory) {
    var container = document.getElementById(containerId);
    if (!values || !values.length) {
      container.appendChild(element("p", "empty-state", "Tidak ada item."));
      return;
    }
    values.forEach(function (value) { container.appendChild(factory(value)); });
  }

  function renderSummary() {
    var values = [
      ["Baseline", model.summary.baseline_total], ["Proposal live", model.summary.proposed_total],
      ["Added", model.summary.added_count], ["Removed", model.summary.removed_count],
      ["Changed", model.summary.changed_count], ["New triggers", model.summary.new_trigger_count],
      ["Missing date", model.summary.missing_date_count],
      ["Missing organization", model.summary.missing_organization_count],
      ["Date completeness", String(model.summary.date_completeness_percent || 0) + "%"],
      ["Production changes", model.summary.production_change_count],
      ["Production unchanged", model.summary.production_unchanged ? "Ya" : "Tidak"],
    ];
    var container = document.getElementById("summaryCards");
    values.forEach(function (value) {
      var card = element("div", "summary-card");
      card.appendChild(element("strong", "", value[1] || 0));
      card.appendChild(element("span", "", value[0]));
      container.appendChild(card);
    });
  }

  function renderFetchFailure() {
    if (!model.source_fetch_failed) return;
    var section = document.getElementById("fetchFailure");
    var health = model.source_health || {};
    var list = document.getElementById("fetchFailureDetails");
    appendDefinition(list, "Source", health.source_code || model.source_code);
    appendDefinition(list, "Failure stage", health.failure_stage);
    appendDefinition(list, "Safe error code", health.error_code || model.fetch_error_code);
    appendDefinition(list, "HTTP status", health.http_status);
    appendDefinition(list, "Baseline item count", model.summary.baseline_total);
    section.hidden = false;
  }

  function renderHealth() {
    var health = model.source_health || {};
    var card = element("article", "health-card");
    card.appendChild(element("h3", "", health.source_code || model.source_code || "Source"));
    var list = element("dl");
    appendDefinition(list, "Status", health.status);
    appendDefinition(list, "Live fetch status", model.fetch_status);
    appendDefinition(list, "TLS trust mode", health.tls_trust_mode);
    appendDefinition(list, "Source fetched", (model.fetched_sources || []).join(", "));
    appendDefinition(list, "Rejected source tidak di-fetch",
      (model.rejected_sources_excluded || []).join(", "));
    appendDefinition(list, "HTTP", health.http_status);
    appendDefinition(list, "Content type", health.content_type);
    appendDefinition(list, "Valid items", health.valid_items);
    appendDefinition(list, "Invalid items", health.invalid_items);
    card.appendChild(list);
    document.getElementById("sourceHealth").appendChild(card);
  }

  function optionsFromCards(field, selectId) {
    var values = {};
    renderedCards.forEach(function (card) { if (card.dataset[field]) values[card.dataset[field]] = true; });
    var select = document.getElementById(selectId);
    Object.keys(values).sort().forEach(function (value) {
      var option = element("option", "", value); option.value = value; select.appendChild(option);
    });
  }

  function applyFilters() {
    var visible = 0;
    renderedCards.forEach(function (card) {
      var show = (!filters.changeType || card.dataset.changeType === filters.changeType) &&
        (!filters.trigger || card.dataset.trigger === filters.trigger) &&
        (!filters.timing || card.dataset.timing === filters.timing) &&
        (!filters.validation || card.dataset.validation === filters.validation);
      card.hidden = !show;
      if (show) visible += 1;
    });
    document.getElementById("filterResult").textContent = visible + " kartu sesuai filter.";
  }

  function bindFilter(id, key) {
    document.getElementById(id).addEventListener("change", function (event) {
      filters[key] = event.target.value; applyFilters();
    });
  }

  function setAllDetails(show) {
    renderedCards.forEach(function (card) {
      var detail = card.querySelector(".detail-panel");
      var toggle = card.querySelector(".detail-toggle");
      if (!detail || !toggle) return;
      detail.hidden = !show;
      toggle.textContent = show ? "Sembunyikan detail" : "Tampilkan detail";
      toggle.setAttribute("aria-expanded", show ? "true" : "false");
    });
  }

  document.getElementById("sourceCode").textContent = model.source_code || "Source tidak tersedia";
  document.getElementById("referenceDate").textContent = model.reference_date
    ? "Reference date: " + model.reference_date : "Reference date belum tersedia";
  document.getElementById("proposalStatus").textContent = "Status proposal: " + (model.status || "REJECT_PROPOSAL");
  var systemCaActive = model.source_health && model.source_health.tls_trust_mode === "SYSTEM_CA";
  document.getElementById("tlsSystemCaNote").hidden = !systemCaActive;
  document.getElementById("tlsVerificationNote").hidden = !systemCaActive;
  renderFetchFailure();
  renderSummary();
  renderHealth();
  renderList("addedItems", model.added_items, function (item) { return itemCard(item, "ADDED"); });
  renderList("removedItems", model.removed_items, function (item) { return itemCard(item, "REMOVED"); });
  renderList("changedItems", model.changed_items, function (item) { return itemCard(item, "CHANGED"); });
  renderList("newTriggers", model.new_triggers, function (item) { return itemCard(item, "TRIGGER"); });
  renderList("classificationChanges", model.classification_changes, function (item) { return changeCard(item, "CLASSIFICATION"); });
  renderList("timingChanges", model.timing_changes, function (item) { return changeCard(item, "TIMING"); });
  renderList("evidenceChanges", model.evidence_changes, function (item) { return changeCard(item, "EVIDENCE"); });
  renderList("validationWarnings", model.warnings, function (item) { return validationCard(item, "WARNING"); });
  renderList("validationErrors", model.errors, function (item) { return validationCard(item, "ERROR"); });
  optionsFromCards("trigger", "triggerFilter");
  optionsFromCards("timing", "timingFilter");
  bindFilter("changeTypeFilter", "changeType");
  bindFilter("triggerFilter", "trigger");
  bindFilter("timingFilter", "timing");
  bindFilter("validationFilter", "validation");
  document.getElementById("showAllDetails").addEventListener("click", function () { setAllDetails(true); });
  document.getElementById("hideAllDetails").addEventListener("click", function () { setAllDetails(false); });
  applyFilters();
})();
