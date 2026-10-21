/* Small, dependency-free enhancements. Every page works without JavaScript:
   menus fall back to visible lists, forms post normally to /api/leads. */
(function () {
  "use strict";
  document.documentElement.classList.add("js");

  /* ---------- Mobile menu ---------- */
  var toggle = document.querySelector(".menu-toggle");
  var nav = document.getElementById("site-nav");
  if (toggle && nav) {
    toggle.addEventListener("click", function () {
      var open = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!open));
      nav.classList.toggle("open", !open);
    });
  }

  /* ---------- Dropdowns (click / keyboard, never hover-only) ---------- */
  var subToggles = Array.prototype.slice.call(document.querySelectorAll(".sub-toggle"));
  function closeAll(except) {
    subToggles.forEach(function (btn) {
      if (btn === except) return;
      btn.setAttribute("aria-expanded", "false");
      var panel = document.getElementById(btn.getAttribute("aria-controls"));
      if (panel) panel.classList.remove("open");
    });
  }
  subToggles.forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var open = btn.getAttribute("aria-expanded") === "true";
      closeAll(btn);
      btn.setAttribute("aria-expanded", String(!open));
      var panel = document.getElementById(btn.getAttribute("aria-controls"));
      if (panel) panel.classList.toggle("open", !open);
    });
  });
  document.addEventListener("click", function (e) {
    if (!e.target.closest || !e.target.closest(".has-sub")) closeAll();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    var openBtn = subToggles.filter(function (b) { return b.getAttribute("aria-expanded") === "true"; })[0];
    closeAll();
    if (openBtn) openBtn.focus();
    else if (toggle && toggle.getAttribute("aria-expanded") === "true") { toggle.click(); toggle.focus(); }
  });
  document.querySelectorAll(".has-sub").forEach(function (li) {
    li.addEventListener("focusout", function (e) {
      if (!li.contains(e.relatedTarget)) closeAll();
    });
  });

  /* ---------- Today's date in Georgia (America/New_York) ---------- */
  function georgiaToday() {
    try {
      var parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date());
      var get = function (t) { return Number(parts.filter(function (p) { return p.type === t; })[0].value); };
      return { y: get("year"), m: get("month"), d: get("day") };
    } catch (err) {
      var n = new Date();
      return { y: n.getFullYear(), m: n.getMonth() + 1, d: n.getDate() };
    }
  }
  var today = georgiaToday();
  function dayOfYear(y, m, d) { return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 864e5); }
  function daysInYear(y) { return dayOfYear(y, 12, 31) + 1; }

  /* ---------- Enrollment season banner ---------- */
  document.querySelectorAll("[data-season]").forEach(function (el) {
    var m = today.m, d = today.d, msg;
    var md = m * 100 + d;
    if (md >= 1015 && md <= 1207) {
      msg = "<strong>Annual Enrollment is open through December 7.</strong> You can join, switch, or drop a Medicare Advantage or Part D drug plan. Changes start January 1.";
    } else if (md >= 1208) {
        msg = "<strong>Annual Enrollment has closed for this year.</strong> If you're in a Medicare Advantage plan, you can make one change from January 1 to March 31.";
    } else if (md <= 331) {
      msg = "<strong>Medicare Advantage Open Enrollment is open through March 31.</strong> If you're in a Medicare Advantage plan, you can make one change. Missed signing up for Part B? General Enrollment also runs through March 31.";
    } else {
      msg = "<strong>Annual Enrollment opens October 15.</strong> Turning 65 sooner? Your own sign-up window starts 3 months before the month you turn 65.";
    }
    var p = el.querySelector("p");
    if (p) p.innerHTML = msg;
  });

  /* ---------- "You are here" on the enrollment calendar ---------- */
  document.querySelectorAll("[data-cal-today]").forEach(function (el) {
    var pct = (dayOfYear(today.y, today.m, today.d) + .5) / daysInYear(today.y) * 100;
    el.style.left = pct.toFixed(2) + "%";
    el.hidden = false;
    var label = el.querySelector("span");
    if (label) {
      var monthName = new Date(Date.UTC(today.y, today.m - 1, today.d)).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
      label.textContent = "Today, " + monthName;
      var cal = el.closest(".cal");
      if (cal && !cal.querySelector(".cal-sr")) {
        var sr = document.createElement("p");
        sr.className = "visually-hidden cal-sr";
        sr.textContent = "Today is " + monthName + ".";
        cal.insertBefore(sr, cal.firstChild);
      }
      /* keep the label inside the calendar: hang it left of the line late in the year, right of it early on */
      if (pct > 55) { label.style.transform = "translateX(calc(-100% + 2px))"; }
      else if (pct < 45) { label.style.transform = "translateX(-2px)"; }
    }
  });

  /* ---------- Error banner after a no-JavaScript form post fails (/contact/?error=1) ---------- */
  var banner = document.getElementById("form-error");
  if (banner && /[?&]error=1/.test(location.search)) banner.classList.add("show");

  /* ---------- Lead forms -> /api/leads (the CRM) ----------
     Without JavaScript, the form posts normally and the server redirects to /thank-you/.
     With JavaScript, we validate in place, post JSON, and show the result here. */
  var PHONE_FALLBACK = "Please call (404) 354-7597 or email Sjackson@empowerbrokerage.com, and Skip will be glad to help.";
  document.querySelectorAll("form[data-lead-form]").forEach(function (form) {
    var started = form.querySelector("input[name='form_started_at']");
    if (started) started.value = String(Date.now());

    /* A short-lived token from the server shows the request came from this page.
       Without it the request is still accepted, but any consent is held for review. */
    var tokenInput = form.querySelector("input[name='form_token']");
    if (!tokenInput) {
      tokenInput = document.createElement("input");
      tokenInput.type = "hidden"; tokenInput.name = "form_token";
      form.appendChild(tokenInput);
    }
    function refreshToken() {
      fetch("/api/form-token", { headers: { "Accept": "application/json" }, cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (b) { if (b && b.token) tokenInput.value = b.token; })
        .catch(function () { /* static hosting or offline: the form still works */ });
    }
    refreshToken();
    var status = form.querySelector(".form-status");

    /* Each error message gets an id and is tied to its field with aria-describedby,
       so screen readers read the reason along with "invalid". */
    var formKey = form.getAttribute("data-form-key") || ("f" + Math.random().toString(36).slice(2, 7));
    function fieldFor(name) {
      var input = form.elements[name];
      if (input && input.length && !input.tagName) input = input[0]; /* radio group: first option */
      return input && input.setAttribute ? input : null;
    }
    function labelFor(name) {
      var input = fieldFor(name), lab = input && input.id ? form.querySelector("label[for='" + input.id + "']") : null;
      if (!lab) return name.replace(/_/g, " ");
      var clone = lab.cloneNode(true);
      clone.querySelectorAll(".hint, .req, a").forEach(function (n) { n.remove(); });
      return clone.textContent.replace(/\s+/g, " ").trim().replace(/^Optional:.*$/, "Text message consent");
    }
    function setError(name, msg) {
      var input = fieldFor(name);
      var err = form.querySelector("[data-error-for='" + name + "']");
      if (err && !err.id) err.id = formKey + "-err-" + name;
      if (input) {
        var ids = (input.getAttribute("aria-describedby") || "").split(" ").filter(function (x) { return x && (!err || x !== err.id); });
        if (msg) { input.setAttribute("aria-invalid", "true"); if (err) ids.push(err.id); }
        else input.removeAttribute("aria-invalid");
        if (ids.length) input.setAttribute("aria-describedby", ids.join(" ")); else input.removeAttribute("aria-describedby");
      }
      if (err) err.textContent = msg || "";
    }
    function clearErrors() {
      form.querySelectorAll("[data-error-for]").forEach(function (e) { setError(e.getAttribute("data-error-for"), ""); });
      if (status) { status.className = "form-status"; status.textContent = ""; }
    }
    function say(kind, text) {
      if (!status) return;
      status.className = "form-status " + kind;
      status.textContent = text;
      status.focus();
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      clearErrors();
      var data = {};
      new FormData(form).forEach(function (v, k) { data[k] = typeof v === "string" ? v.trim() : v; });
      data.consent_texts = form.elements.consent_texts && form.elements.consent_texts.checked ? "yes" : "";
      data.source_page = location.pathname;

      var errors = {};
      if (!data.first_name) errors.first_name = "Please enter your first name.";
      if (!data.last_name) errors.last_name = "Please enter your last name.";
      var digits = (data.phone || "").replace(/\D/g, "");
      if (!digits && !data.email) errors.phone = "Please enter a phone number or an email address so Skip can reach you.";
      if (digits && !(digits.length === 10 || (digits.length === 11 && digits[0] === "1"))) errors.phone = "Please enter a 10-digit phone number, like (404) 555-0123.";
      if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) errors.email = "Please check the email address. It should look like name@example.com.";
      if (data.zip && !/^\d{5}(-?\d{4})?$/.test(data.zip)) errors.zip = "Please enter a 5-digit ZIP code, like 30303.";
      if (!digits && !data.email) errors.email = "Please enter an email address or a phone number.";
      if (data.consent_texts && !digits) errors.phone = "Please add a phone number if you'd like calls or texts.";
      if (data.preferred_contact === "text" && !data.consent_texts) errors.consent_texts = "Please check the consent box if you'd like text messages, or choose phone or email.";
      var keys = Object.keys(errors);
      if (keys.length) {
        keys.forEach(function (k) { setError(k, errors[k]); });
        say("err", "Please fix " + (keys.length === 1 ? "1 field" : keys.length + " fields") + ": " + keys.map(labelFor).join(", ") + ".");
        var first = fieldFor(keys[0]);
        if (first && first.focus) setTimeout(function () { first.focus(); }, 60);
        return;
      }

      var btn = form.querySelector("button[type='submit']");
      if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = "Sending…"; }
      fetch(form.getAttribute("action") || "/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(data)
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) { return { res: res, body: body }; });
      }).then(function (r) {
        if (r.res.ok && r.body.ok) {
          form.reset();
          if (started) started.value = String(Date.now());
          refreshToken();
          say("ok", "Thank you, your request was sent. Skip will contact you within one business day. If it's urgent, call (404) 354-7597.");
          return;
        }
        if (r.res.status === 400 && r.body.errors) {
          var bad = Object.keys(r.body.errors);
          bad.forEach(function (k) { setError(k, r.body.errors[k]); });
          say("err", "Please fix " + (bad.length === 1 ? "1 field" : bad.length + " fields") + ": " + bad.map(labelFor).join(", ") + ".");
          return;
        }
        if (r.res.status === 429) { say("err", "Too many requests from this device. Please wait a few minutes, or call (404) 354-7597."); return; }
        say("err", "Your request didn't go through. " + PHONE_FALLBACK);
      }).catch(function () {
        say("err", "Your request didn't go through. " + PHONE_FALLBACK);
      }).then(function () {
        if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || "Send my request"; }
      });
    });
  });
})();
