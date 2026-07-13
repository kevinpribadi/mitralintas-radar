(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.MitraLintasHumanFeedback = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var ALLOWED_DECISIONS = ["QUALIFIED", "NEEDS_RESEARCH", "WATCHLIST", "NOT_RELEVANT"];
  var READINESS_PRIORITY = {
    READY_FOR_HUMAN_QUALIFICATION: 0,
    NEEDS_DATA_REVIEW: 1,
    NEEDS_MORE_INFORMATION: 2,
    EXPIRED_OR_HISTORICAL: 3,
    LOW_PRODUCT_RELEVANCE: 4
  };
  var INITIAL_LIMIT = 20;

  function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function text(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function uniqueStrings(values) {
    var seen = {};
    return (Array.isArray(values) ? values : []).map(text).filter(function (value) {
      if (!value || seen[value]) return false;
      seen[value] = true;
      return true;
    });
  }

  function validIso(value) {
    return !!text(value) && !isNaN(new Date(value).getTime());
  }

  function validReviewDate(value) {
    if (!value) return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    var parts = value.split("-").map(Number);
    var date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    return date.getUTCFullYear() === parts[0] &&
      date.getUTCMonth() === parts[1] - 1 && date.getUTCDate() === parts[2];
  }

  function emptyRoot(schemaVersion) {
    return { schema_version: schemaVersion || "1.0.0", updated_at: null, records: {} };
  }

  function validateConfig(config) {
    var errors = [];
    if (!isObject(config)) return { valid: false, errors: ["Config harus berupa object."] };
    if (!text(config.schema_version)) errors.push("schema_version wajib diisi.");
    if (!text(config.storage_key)) errors.push("storage_key wajib diisi.");
    if (!text(config.reviewer_key)) errors.push("reviewer_key wajib diisi.");
    if (!isObject(config.decision_states)) errors.push("decision_states wajib berupa object.");
    if (!isObject(config.reason_codes)) errors.push("reason_codes wajib berupa object.");
    if (!isObject(config.allowed_next_actions)) errors.push("allowed_next_actions wajib berupa object.");
    if (!isObject(config.validation)) errors.push("validation wajib berupa object.");

    ALLOWED_DECISIONS.forEach(function (decision) {
      var rule = isObject(config.decision_states) ? config.decision_states[decision] : null;
      if (!isObject(rule)) {
        errors.push("Decision state tidak tersedia: " + decision);
        return;
      }
      if (!Array.isArray(rule.reason_codes) || !rule.reason_codes.length) {
        errors.push("Reason code tidak tersedia untuk " + decision + ".");
      } else {
        rule.reason_codes.forEach(function (code) {
          if (!Object.prototype.hasOwnProperty.call(config.reason_codes || {}, code)) {
            errors.push("Reason code tidak dikenal: " + code);
          }
        });
      }
    });

    Object.keys(config.decision_states || {}).forEach(function (decision) {
      if (ALLOWED_DECISIONS.indexOf(decision) < 0) errors.push("Decision state dilarang: " + decision);
    });

    ["SEND_WHATSAPP", "SEND_EMAIL", "CONTACT_PERSON", "SUBMIT_BID", "SEND_OFFER", "SET_PRICE"]
      .forEach(function (action) {
        if (Object.prototype.hasOwnProperty.call(config.allowed_next_actions || {}, action)) {
          errors.push("Next action dilarang: " + action);
        }
      });
    return { valid: errors.length === 0, errors: errors };
  }

  function validateDecisionInput(input, config) {
    input = isObject(input) ? input : {};
    var errors = [];
    var decision = text(input.human_decision);
    var rule = isObject(config.decision_states) ? config.decision_states[decision] : null;
    var reasons = uniqueStrings(input.reason_codes);
    var alias = text(input.reviewer_alias);
    var note = typeof input.note === "string" ? input.note.trim() : "";
    var nextAction = text(input.next_action);
    var reviewDate = text(input.review_date);
    var aliasMax = Number(config.validation.reviewer_alias_max_length) || 50;
    var noteMax = Number(config.validation.note_max_length) || 500;
    var minReasons = Number(config.validation.minimum_reason_codes) || 1;

    if (ALLOWED_DECISIONS.indexOf(decision) < 0 || !rule) errors.push("Keputusan reviewer tidak valid.");
    if (!alias) errors.push("Alias reviewer wajib diisi.");
    if (alias.length > aliasMax) errors.push("Alias reviewer maksimal " + aliasMax + " karakter.");
    if (note.length > noteMax) errors.push("Catatan maksimal " + noteMax + " karakter.");
    if (reasons.length < minReasons) errors.push("Pilih minimal satu alasan.");

    if (rule) {
      reasons.forEach(function (code) {
        if (rule.reason_codes.indexOf(code) < 0) errors.push("Alasan tidak sesuai keputusan: " + code);
      });
      if (rule.requires_next_action && !nextAction) errors.push("Tindakan berikutnya wajib dipilih.");
      if (rule.requires_review_date_or_next_action && !nextAction && !reviewDate) {
        errors.push("Watchlist memerlukan tindakan berikutnya atau tanggal review.");
      }
    }

    if (nextAction && !Object.prototype.hasOwnProperty.call(config.allowed_next_actions, nextAction)) {
      errors.push("Tindakan berikutnya tidak valid.");
    }
    if (!validReviewDate(reviewDate)) errors.push("Tanggal review harus valid dengan format YYYY-MM-DD.");

    return {
      valid: errors.length === 0,
      errors: errors,
      value: {
        human_decision: decision,
        reason_codes: reasons,
        reviewer_alias: alias,
        note: note,
        next_action: nextAction,
        review_date: reviewDate
      }
    };
  }

  function eventId(now, randomValue) {
    var suffix = randomValue;
    if (!suffix && typeof crypto !== "undefined" && crypto.randomUUID) suffix = crypto.randomUUID();
    if (!suffix) suffix = Math.random().toString(36).slice(2) + Date.now().toString(36);
    return "feedback-" + String(now).replace(/[^0-9]/g, "") + "-" + suffix;
  }

  function createOrUpdateRecord(existing, itemId, input, config, options) {
    options = options || {};
    var checked = validateDecisionInput(input, config);
    if (!text(itemId)) checked.errors.unshift("Item ID wajib diisi.");
    if (!checked.valid || !text(itemId)) return { valid: false, errors: checked.errors };

    var now = options.now || new Date().toISOString();
    var prior = isObject(existing) ? clone(existing) : null;
    var history = prior && Array.isArray(prior.history) ? prior.history.slice() : [];
    var id = options.event_id || eventId(now, options.random_value);
    if (history.some(function (entry) { return entry.event_id === id; })) {
      return { valid: false, errors: ["Event ID sudah digunakan."] };
    }
    var value = checked.value;
    history.push({
      event_id: id,
      event_type: prior ? "DECISION_UPDATED" : "DECISION_CREATED",
      previous_decision: prior ? prior.human_decision : "UNREVIEWED",
      new_decision: value.human_decision,
      reason_codes: value.reason_codes.slice(),
      next_action: value.next_action,
      reviewer_alias: value.reviewer_alias,
      note: value.note,
      timestamp: now
    });

    return {
      valid: true,
      errors: [],
      record: {
        item_id: text(itemId),
        human_decision: value.human_decision,
        reason_codes: value.reason_codes.slice(),
        reviewer_alias: value.reviewer_alias,
        note: value.note,
        next_action: value.next_action,
        review_date: value.review_date,
        created_at: prior && validIso(prior.created_at) ? prior.created_at : now,
        updated_at: now,
        history: history
      }
    };
  }

  function validateHistoryEvent(entry, config) {
    if (!isObject(entry)) return false;
    if (!text(entry.event_id) || ["DECISION_CREATED", "DECISION_UPDATED"].indexOf(entry.event_type) < 0) return false;
    if (["UNREVIEWED"].concat(ALLOWED_DECISIONS).indexOf(entry.previous_decision) < 0) return false;
    if (ALLOWED_DECISIONS.indexOf(entry.new_decision) < 0) return false;
    if (!validIso(entry.timestamp)) return false;
    var checked = validateDecisionInput({
      human_decision: entry.new_decision,
      reason_codes: entry.reason_codes,
      reviewer_alias: entry.reviewer_alias,
      note: entry.note,
      next_action: entry.next_action,
      review_date: entry.new_decision === "WATCHLIST" && !entry.next_action ? "2099-01-01" : ""
    }, config);
    return checked.valid;
  }

  function validateStoredRecord(record, config, expectedId) {
    if (!isObject(record) || !text(record.item_id)) return { valid: false, errors: ["Record feedback tidak valid."] };
    if (expectedId && record.item_id !== expectedId) return { valid: false, errors: ["Item ID record tidak konsisten."] };
    var checked = validateDecisionInput(record, config);
    var errors = checked.errors.slice();
    if (!validIso(record.created_at)) errors.push("created_at tidak valid.");
    if (!validIso(record.updated_at)) errors.push("updated_at tidak valid.");
    if (!Array.isArray(record.history) || !record.history.length) errors.push("History wajib tersedia.");
    var ids = {};
    (Array.isArray(record.history) ? record.history : []).forEach(function (entry) {
      if (!validateHistoryEvent(entry, config)) errors.push("History event tidak valid.");
      if (entry && ids[entry.event_id]) errors.push("Event ID duplikat dalam history.");
      if (entry) ids[entry.event_id] = true;
    });
    return { valid: errors.length === 0, errors: uniqueStrings(errors) };
  }

  function mergeHistory(left, right) {
    var byId = {};
    (left || []).concat(right || []).forEach(function (entry) {
      if (entry && text(entry.event_id) && !byId[entry.event_id]) byId[entry.event_id] = clone(entry);
    });
    return Object.keys(byId).map(function (id) { return byId[id]; }).sort(function (a, b) {
      var time = String(a.timestamp).localeCompare(String(b.timestamp));
      return time || String(a.event_id).localeCompare(String(b.event_id));
    });
  }

  function mergeRecord(localRecord, importedRecord) {
    if (!localRecord) return clone(importedRecord);
    if (!importedRecord) return clone(localRecord);
    var localTime = new Date(localRecord.updated_at).getTime();
    var importedTime = new Date(importedRecord.updated_at).getTime();
    var current = importedTime > localTime ? importedRecord : localRecord;
    var merged = clone(current);
    merged.created_at = new Date(localRecord.created_at).getTime() <= new Date(importedRecord.created_at).getTime()
      ? localRecord.created_at : importedRecord.created_at;
    merged.history = mergeHistory(localRecord.history, importedRecord.history);
    return merged;
  }

  function previewImport(payload, currentRoot, config, activeItemIds) {
    if (!isObject(payload) || payload.schema_version !== config.schema_version || !isObject(payload.records)) {
      return { valid: false, errors: ["Schema import tidak valid atau tidak didukung."] };
    }
    var current = isObject(currentRoot) && isObject(currentRoot.records) ? currentRoot : emptyRoot(config.schema_version);
    var active = {};
    (activeItemIds || []).forEach(function (id) { active[id] = true; });
    var validRecords = {};
    var invalid = [];
    var importedEventIds = {};
    var added = 0;
    var conflicts = 0;
    var orphaned = 0;

    Object.keys(payload.records).sort().forEach(function (key) {
      var record = payload.records[key];
      var checked = validateStoredRecord(record, config, key);
      if (["__proto__", "constructor", "prototype"].indexOf(key) >= 0) {
        checked = { valid: false, errors: ["Item ID import tidak aman."] };
      }
      if (checked.valid) {
        var duplicateEvent = record.history.find(function (entry) { return importedEventIds[entry.event_id]; });
        if (duplicateEvent) checked = { valid: false, errors: ["Event ID import digunakan oleh lebih dari satu record."] };
      }
      if (!checked.valid) {
        invalid.push({ item_id: key, errors: checked.errors });
        return;
      }
      record.history.forEach(function (entry) { importedEventIds[entry.event_id] = key; });
      validRecords[key] = clone(record);
      if (current.records[key]) conflicts += 1;
      else added += 1;
      if (!active[key]) orphaned += 1;
    });

    return {
      valid: true,
      errors: [],
      counts: {
        valid: Object.keys(validRecords).length,
        invalid: invalid.length,
        added: added,
        conflicts: conflicts,
        orphaned: orphaned
      },
      invalid_records: invalid,
      valid_records: validRecords
    };
  }

  function applyImport(preview, currentRoot, config, now) {
    if (!preview || !preview.valid) throw new Error("Preview import valid diperlukan.");
    var current = isObject(currentRoot) && isObject(currentRoot.records)
      ? clone(currentRoot) : emptyRoot(config.schema_version);
    Object.keys(preview.valid_records).forEach(function (id) {
      current.records[id] = mergeRecord(current.records[id], preview.valid_records[id]);
    });
    current.schema_version = config.schema_version;
    current.updated_at = now || new Date().toISOString();
    return current;
  }

  function buildExport(rootValue, config, now) {
    var records = isObject(rootValue) && isObject(rootValue.records) ? clone(rootValue.records) : {};
    return { schema_version: config.schema_version, exported_at: now || new Date().toISOString(), records: records };
  }

  function createStorage(storage, config) {
    var memory = emptyRoot(config.schema_version);
    var reviewerMemory = "";
    var persistent = false;
    var adapter;
    var fallbackWarning = "Penyimpanan browser tidak tersedia. Feedback hanya bertahan selama sesi ini.";
    try {
      var probe = config.storage_key + "_probe";
      storage.setItem(probe, "1");
      storage.removeItem(probe);
      persistent = true;
    } catch (error) {
      persistent = false;
    }

    function parseRoot(raw) {
      try {
        var value = JSON.parse(raw);
        if (isObject(value) && value.schema_version === config.schema_version && isObject(value.records)) return value;
      } catch (error) {
        return emptyRoot(config.schema_version);
      }
      return emptyRoot(config.schema_version);
    }

    function useFallback() {
      persistent = false;
      if (adapter) {
        adapter.persistent = false;
        adapter.warning = fallbackWarning;
      }
    }

    adapter = {
      persistent: persistent,
      warning: persistent ? "" : fallbackWarning,
      load: function () {
        if (!persistent) return clone(memory);
        try { return parseRoot(storage.getItem(config.storage_key)); } catch (error) { useFallback(); return clone(memory); }
      },
      save: function (value) {
        var next = clone(value);
        if (!persistent) { memory = next; return true; }
        try { storage.setItem(config.storage_key, JSON.stringify(next)); return true; } catch (error) { memory = next; useFallback(); return false; }
      },
      getReviewer: function () {
        if (!persistent) return reviewerMemory;
        try { return text(storage.getItem(config.reviewer_key)); } catch (error) { useFallback(); return reviewerMemory; }
      },
      setReviewer: function (alias) {
        reviewerMemory = text(alias);
        if (!persistent) return;
        try { storage.setItem(config.reviewer_key, reviewerMemory); } catch (error) { useFallback(); }
      }
    };
    return adapter;
  }

  function metrics(items, records) {
    var result = { total: items.length, reviewed: 0, unreviewed: 0, completion_rate: 0, decision_distribution: {}, decision_changes: 0 };
    ALLOWED_DECISIONS.forEach(function (decision) { result.decision_distribution[decision] = 0; });
    items.forEach(function (item) {
      var record = records[item.id];
      if (record && ALLOWED_DECISIONS.indexOf(record.human_decision) >= 0) {
        result.reviewed += 1;
        result.decision_distribution[record.human_decision] += 1;
        result.decision_changes += Math.max(0, (record.history || []).length - 1);
      } else result.unreviewed += 1;
    });
    result.completion_rate = result.total ? Math.round(result.reviewed * 1000 / result.total) / 10 : 0;
    return result;
  }

  function nextUnreviewed(items, records) {
    return items.map(function (item, index) { return { item: item, index: index }; })
      .filter(function (entry) { return !records[entry.item.id]; })
      .sort(function (a, b) {
        var ap = Object.prototype.hasOwnProperty.call(READINESS_PRIORITY, a.item.readiness_state)
          ? READINESS_PRIORITY[a.item.readiness_state] : 99;
        var bp = Object.prototype.hasOwnProperty.call(READINESS_PRIORITY, b.item.readiness_state)
          ? READINESS_PRIORITY[b.item.readiness_state] : 99;
        if (ap !== bp) return ap - bp;
        if (a.index !== b.index) return a.index - b.index;
        return String(a.item.id).localeCompare(String(b.item.id));
      })[0];
  }

  function setText(element, value) {
    element.textContent = String(value == null ? "" : value);
    return element;
  }

  function fetchFallback(paths) {
    if (!paths.length) return Promise.reject(new Error("Semua lokasi gagal dimuat."));
    return fetch(paths[0]).then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    }).catch(function () { return fetchFallback(paths.slice(1)); });
  }

  function startBrowserApp(doc, browserStorage) {
    if (!doc || !doc.getElementById("humanFeedbackPanel")) return Promise.resolve(null);
    var ui = {
      config: null,
      storage: null,
      feedback: null,
      qualification: { items: [] },
      filter: "",
      activeItem: null,
      returnFocus: null,
      importPreview: null,
      reviewOpenedAt: null
    };

    function node(tag, className, value) {
      var element = doc.createElement(tag);
      if (className) element.className = className;
      if (value !== undefined) setText(element, value);
      return element;
    }

    function decisionLabel(code) {
      if (!code) return "Belum direview";
      var rule = ui.config.decision_states[code];
      return rule ? rule.label_id : code;
    }

    function readinessLabel(code) {
      var labels = {
        READY_FOR_HUMAN_QUALIFICATION: "Siap Ditinjau untuk Kualifikasi",
        NEEDS_DATA_REVIEW: "Perlu Review Kualitas Data",
        NEEDS_MORE_INFORMATION: "Perlu Informasi Tambahan",
        EXPIRED_OR_HISTORICAL: "Referensi Historis",
        LOW_PRODUCT_RELEVANCE: "Relevansi Produk Rendah"
      };
      return labels[code] || code;
    }

    function renderWarning(message) {
      var warning = doc.getElementById("feedbackStorageWarning");
      warning.hidden = !message;
      setText(warning, message || "");
    }

    function renderMetrics() {
      var summary = metrics(ui.qualification.items, ui.feedback.records);
      var values = [
        ["Total item", summary.total], ["Belum direview", summary.unreviewed],
        ["Qualified", summary.decision_distribution.QUALIFIED],
        ["Perlu riset", summary.decision_distribution.NEEDS_RESEARCH],
        ["Watchlist", summary.decision_distribution.WATCHLIST],
        ["Tidak relevan", summary.decision_distribution.NOT_RELEVANT],
        ["Selesai", summary.completion_rate + "%"]
      ];
      var target = doc.getElementById("feedbackMetrics");
      target.replaceChildren();
      values.forEach(function (entry) {
        var metric = node("div", "review-metric");
        metric.appendChild(node("strong", "", entry[1]));
        metric.appendChild(node("span", "", entry[0]));
        target.appendChild(metric);
      });
      setText(doc.getElementById("feedbackChangeCount"), "Perubahan keputusan tercatat: " + summary.decision_changes);
    }

    function filteredItems() {
      return ui.qualification.items.filter(function (item) {
        var record = ui.feedback.records[item.id];
        var decision = record ? record.human_decision : "UNREVIEWED";
        return !ui.filter || decision === ui.filter;
      });
    }

    function badge(label, className) {
      return node("span", "badge " + (className || ""), label);
    }

    function openReview(item, origin) {
      ui.activeItem = item;
      ui.returnFocus = origin || doc.activeElement;
      ui.reviewOpenedAt = Date.now();
      ui.importPreview = null;
      doc.getElementById("feedbackImportView").hidden = true;
      doc.getElementById("feedbackReviewView").hidden = false;
      setText(doc.getElementById("feedbackModalTitle"), "Keputusan Reviewer");
      setText(doc.getElementById("feedbackItemTitle"), item.title || "(judul tidak tersedia)");
      setText(doc.getElementById("feedbackItemMeta"), (item.type || "-") + " | Organisasi: " + (item.organization || "belum jelas"));
      setText(doc.getElementById("feedbackMachineState"), readinessLabel(item.readiness_state));
      setText(doc.getElementById("feedbackMachineReasons"), (item.reason_codes || []).join(", ") || "-");
      setText(doc.getElementById("feedbackMachineAction"), item.suggested_next_action || "-");
      var source = doc.getElementById("feedbackSourceLink");
      source.hidden = !item.link;
      if (item.link) source.href = item.link;

      var record = ui.feedback.records[item.id];
      var decision = doc.getElementById("feedbackDecision");
      decision.value = record ? record.human_decision : "";
      doc.getElementById("feedbackAlias").value = record ? record.reviewer_alias : ui.storage.getReviewer();
      doc.getElementById("feedbackNote").value = record ? record.note : "";
      doc.getElementById("feedbackNextAction").value = record ? record.next_action : "";
      doc.getElementById("feedbackReviewDate").value = record ? record.review_date : "";
      renderReasons(record ? record.reason_codes : []);
      renderHistory(record ? record.history : []);
      setText(doc.getElementById("feedbackFormError"), "");
      openModal();
      decision.focus();
    }

    function renderReasons(selected) {
      var target = doc.getElementById("feedbackReasonOptions");
      var decision = doc.getElementById("feedbackDecision").value;
      target.replaceChildren();
      if (!decision || !ui.config.decision_states[decision]) {
        target.appendChild(node("span", "hint", "Pilih keputusan untuk melihat alasan yang tersedia."));
        return;
      }
      ui.config.decision_states[decision].reason_codes.forEach(function (code, index) {
        var label = node("label", "feedback-check");
        var input = doc.createElement("input");
        input.type = "checkbox";
        input.name = "feedback_reason";
        input.value = code;
        input.id = "feedbackReason" + index;
        input.checked = selected.indexOf(code) >= 0;
        label.appendChild(input);
        label.appendChild(node("span", "", ui.config.reason_codes[code] || code));
        target.appendChild(label);
      });
    }

    function renderHistory(history) {
      var target = doc.getElementById("feedbackHistory");
      target.replaceChildren();
      if (!history.length) {
        target.appendChild(node("div", "empty compact", "Belum ada riwayat keputusan."));
        return;
      }
      history.slice().reverse().forEach(function (entry) {
        var row = node("div", "feedback-history-item");
        row.appendChild(node("strong", "", entry.previous_decision + " -> " + entry.new_decision));
        row.appendChild(node("span", "", new Date(entry.timestamp).toLocaleString("id-ID") + " | " + entry.reviewer_alias));
        row.appendChild(node("span", "", "Alasan: " + entry.reason_codes.join(", ")));
        if (entry.next_action) row.appendChild(node("span", "", "Tindakan: " + entry.next_action));
        if (entry.note) row.appendChild(node("span", "", "Catatan: " + entry.note));
        target.appendChild(row);
      });
    }

    function renderList() {
      renderMetrics();
      var target = doc.getElementById("feedbackItems");
      var items = filteredItems();
      var visible = items.slice(0, INITIAL_LIMIT);
      target.replaceChildren();
      setText(doc.getElementById("feedbackStatus"), "Ditampilkan " + visible.length + " dari " + items.length + " item sesuai filter.");
      if (!items.length) {
        target.appendChild(node("div", "empty", "Tidak ada item untuk filter keputusan ini."));
        return;
      }
      var list = node("div", "review-list");
      visible.forEach(function (item) {
        var record = ui.feedback.records[item.id];
        var card = node("article", "review-item feedback-item");
        var badges = node("div", "feedback-badges");
        badges.appendChild(badge("Rekomendasi Sistem: " + readinessLabel(item.readiness_state), "state-info"));
        badges.appendChild(badge("Keputusan Reviewer: " + decisionLabel(record && record.human_decision), record ? "human-reviewed" : "human-unreviewed"));
        card.appendChild(badges);
        card.appendChild(node("h3", "", item.title || "(judul tidak tersedia)"));
        card.appendChild(node("div", "meta", "Tipe: " + item.type + " | Organisasi: " + (item.organization || "belum jelas")));
        var actions = node("div", "card-actions");
        var review = node("button", "primary", "Review");
        review.type = "button";
        review.addEventListener("click", function () { openReview(item, review); });
        actions.appendChild(review);
        if (item.link) {
          var link = node("a", "source-button", "Buka Sumber");
          link.href = item.link;
          link.target = "_blank";
          link.rel = "noopener";
          actions.appendChild(link);
        }
        card.appendChild(actions);
        list.appendChild(card);
      });
      target.appendChild(list);
    }

    function selectedReasons() {
      return Array.prototype.slice.call(doc.querySelectorAll('input[name="feedback_reason"]:checked'))
        .map(function (input) { return input.value; });
    }

    function saveDecision() {
      var input = {
        human_decision: doc.getElementById("feedbackDecision").value,
        reason_codes: selectedReasons(),
        reviewer_alias: doc.getElementById("feedbackAlias").value,
        note: doc.getElementById("feedbackNote").value,
        next_action: doc.getElementById("feedbackNextAction").value,
        review_date: doc.getElementById("feedbackReviewDate").value
      };
      var result = createOrUpdateRecord(ui.feedback.records[ui.activeItem.id], ui.activeItem.id, input, ui.config);
      if (!result.valid) {
        setText(doc.getElementById("feedbackFormError"), result.errors.join(" "));
        return;
      }
      ui.feedback.records[ui.activeItem.id] = result.record;
      ui.feedback.updated_at = result.record.updated_at;
      ui.storage.setReviewer(result.record.reviewer_alias);
      var persisted = ui.storage.save(ui.feedback);
      if (!persisted || !ui.storage.persistent) renderWarning(ui.storage.warning);
      closeModal();
      renderList();
    }

    function openModal() {
      var backdrop = doc.getElementById("feedbackModalBackdrop");
      backdrop.classList.add("open");
      backdrop.setAttribute("aria-hidden", "false");
      doc.body.classList.add("modal-open");
    }

    function closeModal() {
      var backdrop = doc.getElementById("feedbackModalBackdrop");
      backdrop.classList.remove("open");
      backdrop.setAttribute("aria-hidden", "true");
      doc.body.classList.remove("modal-open");
      if (ui.returnFocus && typeof ui.returnFocus.focus === "function") ui.returnFocus.focus();
      ui.activeItem = null;
      ui.importPreview = null;
    }

    function exportFeedback() {
      var payload = buildExport(ui.feedback, ui.config);
      var blob = new Blob([JSON.stringify(payload, null, 2) + "\n"], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var link = doc.createElement("a");
      link.href = url;
      link.download = "mitralintas-feedback-" + new Date().toISOString().slice(0, 10) + ".json";
      doc.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    }

    function showImportPreview(preview, origin) {
      ui.importPreview = preview;
      ui.returnFocus = origin || doc.activeElement;
      doc.getElementById("feedbackReviewView").hidden = true;
      doc.getElementById("feedbackImportView").hidden = false;
      setText(doc.getElementById("feedbackModalTitle"), "Preview Import Feedback");
      var counts = preview.counts;
      setText(doc.getElementById("feedbackImportSummary"),
        "Valid: " + counts.valid + " | Invalid: " + counts.invalid + " | Baru: " + counts.added +
        " | Konflik: " + counts.conflicts + " | Orphaned: " + counts.orphaned);
      var detail = doc.getElementById("feedbackImportErrors");
      detail.replaceChildren();
      preview.invalid_records.slice(0, 10).forEach(function (entry) {
        detail.appendChild(node("div", "feedback-import-error", entry.item_id + ": " + entry.errors.join(" ")));
      });
      openModal();
      doc.getElementById("feedbackApplyImportBtn").focus();
    }

    function handleImport(file, origin) {
      if (!file || !/\.json$/i.test(file.name)) {
        renderWarning("Import ditolak: pilih file JSON.");
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var payload = JSON.parse(String(reader.result));
          var preview = previewImport(payload, ui.feedback, ui.config,
            ui.qualification.items.map(function (item) { return item.id; }));
          if (!preview.valid) throw new Error(preview.errors.join(" "));
          showImportPreview(preview, origin);
        } catch (error) {
          renderWarning("Import ditolak: " + error.message);
        }
      };
      reader.onerror = function () { renderWarning("Import ditolak: file tidak dapat dibaca."); };
      reader.readAsText(file);
    }

    function applyPreview() {
      if (!ui.importPreview) return;
      ui.feedback = applyImport(ui.importPreview, ui.feedback, ui.config);
      ui.storage.save(ui.feedback);
      closeModal();
      renderList();
      renderWarning(ui.storage.warning);
    }

    function bind() {
      doc.getElementById("feedbackDecisionFilter").addEventListener("change", function (event) {
        ui.filter = event.target.value;
        renderList();
      });
      doc.getElementById("reviewNextBtn").addEventListener("click", function (event) {
        var entry = nextUnreviewed(ui.qualification.items, ui.feedback.records);
        if (entry) openReview(entry.item, event.currentTarget);
        else renderWarning("Semua item aktif sudah direview.");
      });
      doc.getElementById("exportFeedbackBtn").addEventListener("click", exportFeedback);
      doc.getElementById("importFeedbackBtn").addEventListener("click", function (event) {
        ui.returnFocus = event.currentTarget;
        doc.getElementById("feedbackImportFile").click();
      });
      doc.getElementById("feedbackImportFile").addEventListener("change", function (event) {
        handleImport(event.target.files[0], ui.returnFocus);
        event.target.value = "";
      });
      doc.getElementById("feedbackDecision").addEventListener("change", function () { renderReasons([]); });
      doc.getElementById("feedbackSaveBtn").addEventListener("click", saveDecision);
      doc.getElementById("feedbackCancelBtn").addEventListener("click", closeModal);
      doc.getElementById("feedbackImportCancelBtn").addEventListener("click", closeModal);
      doc.getElementById("feedbackApplyImportBtn").addEventListener("click", applyPreview);
      doc.getElementById("feedbackModalBackdrop").addEventListener("click", function (event) {
        if (event.target === event.currentTarget) closeModal();
      });
      doc.addEventListener("keydown", function (event) {
        var backdrop = doc.getElementById("feedbackModalBackdrop");
        if (!backdrop.classList.contains("open")) return;
        if (event.key === "Escape") { event.preventDefault(); closeModal(); return; }
        if (event.key !== "Tab") return;
        var focusable = Array.prototype.slice.call(backdrop.querySelectorAll(
          'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), a[href]'
        )).filter(function (element) { return !element.closest("[hidden]"); });
        if (!focusable.length) return;
        var first = focusable[0];
        var last = focusable[focusable.length - 1];
        if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
      });
    }

    return Promise.all([
      fetchFallback(["data/human_feedback_rules.json", "../config/human_feedback_rules.json"]),
      fetchFallback(["data/qualification_readiness.json", "../docs/data/qualification_readiness.json"])
        .catch(function () { return { items: [], unavailable: true }; })
    ]).then(function (values) {
      var configCheck = validateConfig(values[0]);
      if (!configCheck.valid) throw new Error(configCheck.errors.join(" "));
      ui.config = values[0];
      ui.qualification = isObject(values[1]) && Array.isArray(values[1].items) ? values[1] : { items: [] };
      ui.storage = createStorage(browserStorage, ui.config);
      ui.feedback = ui.storage.load();
      bind();
      renderWarning(ui.storage.warning || (values[1].unavailable ? "Data qualification readiness tidak tersedia. Fitur review tetap aman, tetapi daftar item kosong." : ""));
      renderList();
      return ui;
    }).catch(function (error) {
      renderWarning("Human Feedback Loop tidak dapat dimuat: " + error.message);
      doc.getElementById("reviewNextBtn").disabled = true;
      doc.getElementById("exportFeedbackBtn").disabled = true;
      doc.getElementById("importFeedbackBtn").disabled = true;
      return null;
    });
  }

  var api = {
    ALLOWED_DECISIONS: ALLOWED_DECISIONS.slice(),
    validateConfig: validateConfig,
    validateDecisionInput: validateDecisionInput,
    validateStoredRecord: validateStoredRecord,
    createOrUpdateRecord: createOrUpdateRecord,
    mergeHistory: mergeHistory,
    mergeRecord: mergeRecord,
    previewImport: previewImport,
    applyImport: applyImport,
    buildExport: buildExport,
    createStorage: createStorage,
    emptyRoot: emptyRoot,
    metrics: metrics,
    nextUnreviewed: nextUnreviewed,
    setText: setText,
    validReviewDate: validReviewDate,
    startBrowserApp: startBrowserApp
  };

  if (typeof document !== "undefined") {
    var availableStorage = null;
    try { availableStorage = window.localStorage; } catch (error) { availableStorage = null; }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () { startBrowserApp(document, availableStorage); });
    } else startBrowserApp(document, availableStorage);
  }
  return api;
}));
